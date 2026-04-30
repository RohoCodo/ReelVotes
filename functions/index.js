/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const crypto = require("crypto");
const admin = require("firebase-admin");
const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

admin.initializeApp();
const db = admin.firestore();

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

// Eventbrite API configuration
const EVENTBRITE_API_KEY = "WNONNWI2KR5LLTQVMH7Y";
const EVENTBRITE_EVENT_ID = "1985653305489";
const RATE_LIMIT_WINDOW_MS = 15000;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || "";
const ELIMINATION_SCHEDULE = "0 2 * * *";
const ELIMINATION_TIMEZONE = "America/Los_Angeles";
const ELIMINATION_ENABLED_EVENT_IDS = new Set([
  "np-2026-06-01-1830",
]);
const DEFAULT_ELIMINATIONS_PER_NIGHT = 3;
const LEGACY_ANON_EMAIL_SUFFIX = "@reelvotes.local";
const EMAIL_OPTIONAL_EVENT_IDS = new Set([
  "np-2026-06-01-1830",
]);
const ADMIN_EMAILS = new Set([
  "rt332@cornell.edu",
  "moses@thenewparkway.com",
  "programming@thenewparkway.com",
  "nikki@thenewparkwaytheater.com",
]);

function requiresEmailForEvent(eventId) {
  return !EMAIL_OPTIONAL_EVENT_IDS.has(eventId);
}

function isEliminationEnabledForEvent(eventId, eventData = {}) {
  return eventData.eliminationEnabled === true || ELIMINATION_ENABLED_EVENT_IDS.has(eventId);
}

function getEliminationsPerNight(eventData = {}) {
  const configured = Number(eventData.eliminationsPerNight);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_ELIMINATIONS_PER_NIGHT;
}

function isLikelyRealEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return !normalized.endsWith(LEGACY_ANON_EMAIL_SUFFIX);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function assertAdminEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!ADMIN_EMAILS.has(normalizedEmail)) {
    throw new HttpsError("permission-denied", "Admin access denied.");
  }
  return normalizedEmail;
}

function normalizeMovieTitle(movieTitle) {
  return String(movieTitle || "")
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ");
}

const ALLOWED_MOVIES = new Set([
  "Back to the Future",
  "Jurassic Park",
  "Blade Runner",
  "In The Mood For Love",
  "Mean Girls",
  "Bring It On",
  "The Notebook",
  "Blade",
  "Battle Royale",
  "Mad Max: Fury Road",
  "RomComs",
  "Sci-fi",
  "Coming of Age",
  "Thrillers/Mystery",
  "Comedy (or Satire/Black Comedy)",
  "Action/Adventure",
]);
const ALLOWED_MOVIE_LOOKUP = new Map(
  Array.from(ALLOWED_MOVIES).map((title) => [normalizeMovieTitle(title), title]),
);

// Cache for attendees
let attendeesCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 3600000; // 1 hour in milliseconds

// Fetch attendees from Eventbrite API
async function fetchEventbriteAttendees() {
  // Check if cache is still valid
  if (attendeesCache && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_DURATION) {
    logger.info("Using cached attendees list");
    return attendeesCache;
  }

  try {
    logger.info("Fetching attendees from Eventbrite API");
    
    const response = await fetch(
      `https://www.eventbriteapi.com/v3/events/${EVENTBRITE_EVENT_ID}/attendees/`,
      {
        headers: {
          "Authorization": `Bearer ${EVENTBRITE_API_KEY}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Eventbrite API error: ${response.status}`);
    }

    const data = await response.json();
    const attendees = data.attendees || [];
    
    // Extract and normalize emails
    attendeesCache = attendees
      .filter(a => a.email)
      .map(a => a.email.toLowerCase());
    
    cacheTimestamp = Date.now();
    logger.info(`Cached ${attendeesCache.length} attendees`);
    
    return attendeesCache;
  } catch (error) {
    logger.error("Error fetching Eventbrite attendees:", error);
    throw error;
  }
}

// Cloud Function to validate email against Eventbrite attendees
exports.validateEventbriteEmail = onCall(async (request) => {
  const email = request.data.email?.toLowerCase();
  
  if (!email) {
    throw new Error("Email is required");
  }

  try {
    const attendees = await fetchEventbriteAttendees();
    
    if (attendees.includes(email)) {
      return { valid: true, message: "Email verified!" };
    } else {
      return { valid: false, message: "Email not found in attendee list. Please use the email from your Eventbrite ticket." };
    }
  } catch (error) {
    logger.error("Validation error:", error);
    throw new Error("Unable to validate email at this time. Please try again.");
  }
});

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sanitizeEventId(eventId) {
  const normalizedEventId = String(eventId || "").trim();
  if (!normalizedEventId || normalizedEventId.length > 100) {
    throw new HttpsError("invalid-argument", "A valid eventId is required.");
  }
  return normalizedEventId;
}

function sanitizeMovieTitle(movieTitle) {
  const normalizedMovieTitle = String(movieTitle || "").trim();
  if (!normalizedMovieTitle || normalizedMovieTitle.length > 200) {
    throw new HttpsError("invalid-argument", "A valid movie title is required.");
  }
  return normalizedMovieTitle;
}

function sanitizeClientId(clientId) {
  const normalizedClientId = String(clientId || "").trim();
  if (!normalizedClientId || normalizedClientId.length > 200) {
    throw new HttpsError("invalid-argument", "A valid clientId is required.");
  }
  return normalizedClientId;
}

function sanitizeEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail.length > 320) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }

  // Very light validation to avoid obviously bad values
  const basicEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!basicEmailPattern.test(normalizedEmail)) {
    throw new HttpsError("invalid-argument", "A valid email is required.");
  }

  return normalizedEmail;
}

function sanitizeOptionalEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }
  return sanitizeEmail(normalizedEmail);
}

function sanitizeCaptchaToken(captchaToken) {
  const normalizedCaptchaToken = String(captchaToken || "").trim();
  if (!normalizedCaptchaToken) {
    throw new HttpsError("invalid-argument", "Complete the CAPTCHA challenge and try again.");
  }
  return normalizedCaptchaToken;
}

function movieDocId(movieTitle) {
  return String(movieTitle || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function getRequesterIp(request) {
  const forwardedFor = request.rawRequest.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return request.rawRequest.ip || "unknown";
}

async function verifyCaptchaToken(request, captchaToken) {
  if (!TURNSTILE_SECRET_KEY) {
    return;
  }

  const verificationResponse = await fetch(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      secret: TURNSTILE_SECRET_KEY,
      response: sanitizeCaptchaToken(captchaToken),
      remoteip: getRequesterIp(request),
    }).toString(),
  });

  if (!verificationResponse.ok) {
    logger.error("Turnstile verification request failed", {status: verificationResponse.status});
    throw new HttpsError("unavailable", "CAPTCHA verification is temporarily unavailable.");
  }

  const verificationResult = await verificationResponse.json();
  if (!verificationResult.success) {
    logger.warn("Turnstile verification rejected a submission", {
      errorCodes: verificationResult["error-codes"] || [],
    });
    throw new HttpsError("permission-denied", "CAPTCHA verification failed. Please try again.");
  }
}

function buildVoteLookup(eventId, clientId) {
  const clientIdHash = hashValue(clientId);
  const voteKeyRef = db.collection("events").doc(eventId).collection("voter_keys").doc(clientIdHash);
  return {clientIdHash, voteKeyRef};
}

function getRevoteCredits(voteKeyData, emailKeyData) {
  const voteKeyCredits = Number(voteKeyData?.reVoteCredits || 0);
  const emailKeyCredits = Number(emailKeyData?.reVoteCredits || 0);
  return Math.max(voteKeyCredits, emailKeyCredits, 0);
}

async function queueEliminationEmails(eventId, eliminatedTitles, emailSet) {
  if (!emailSet || emailSet.size === 0) {
    return;
  }

  const batch = db.batch();
  const titleList = eliminatedTitles.join(", ");

  // Extract event date from eventId (expects format like 'np-2026-06-01-1830')
  let eventDate = "";
  const match = eventId.match(/(\d{4}-\d{2}-\d{2})/);
  if (match) {
    eventDate = match[1];
  }
  const voteUrl = eventDate ? `https://reelvotes.com/?event=${eventDate}` : "https://reelvotes.com/";

  emailSet.forEach((email) => {
    const mailRef = db.collection("mail").doc();
    batch.set(mailRef, {
      to: [email],
      message: {
        subject: "Your voted movie was eliminated",
        text:
          `Your vote (${titleList}) was eliminated for event ${eventId}.\n` +
          `You can now vote again.\n\n` +
          `Vote again here: ${voteUrl}`,
      },
      event_id: eventId,
      type: "movie-eliminated",
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();
}

async function runNightlyEliminationForEvent(eventId) {
  const eventRef = db.collection("events").doc(eventId);

  const eliminationResult = await db.runTransaction(async (transaction) => {
    const eventDoc = await transaction.get(eventRef);
    const eventData = eventDoc.exists ? (eventDoc.data() || {}) : {};
    if (!isEliminationEnabledForEvent(eventId, eventData)) {
      return {
        status: "disabled",
        eventId,
      };
    }

    const moviesRef = eventRef.collection("movies");
    const moviesSnapshot = await transaction.get(moviesRef);
    const movies = moviesSnapshot.docs.map((doc) => ({
      ref: doc.ref,
      id: doc.id,
      data: doc.data() || {},
    }));

    const activeMovies = movies.filter((movie) => movie.data.eliminated !== true);
    if (activeMovies.length <= 1) {
      if (activeMovies.length === 1) {
        const winner = activeMovies[0].data.movie_title || activeMovies[0].id;
        transaction.set(eventRef, {
          winningMovie: winner,
          eliminationCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        return {
          status: "winner",
          eventId,
          winner,
        };
      }

      return {
        status: "no-active-movies",
        eventId,
      };
    }

    const eliminateCount = Math.min(getEliminationsPerNight(eventData), activeMovies.length - 1);
    if (eliminateCount <= 0) {
      return {
        status: "no-op",
        eventId,
      };
    }

    activeMovies.sort((a, b) => {
      const voteA = Number(a.data.vote_count || 0);
      const voteB = Number(b.data.vote_count || 0);
      if (voteA !== voteB) {
        return voteA - voteB;
      }
      const titleA = String(a.data.movie_title || a.id).toLowerCase();
      const titleB = String(b.data.movie_title || b.id).toLowerCase();
      return titleA.localeCompare(titleB);
    });

    const roundNumber = Number(eventData.currentEliminationRound || 0) + 1;
    const eliminatedMovies = activeMovies.slice(0, eliminateCount);
    const eliminatedTitles = eliminatedMovies.map((movie) => String(movie.data.movie_title || movie.id));

    eliminatedMovies.forEach((movie) => {
      transaction.set(movie.ref, {
        eliminated: true,
        eliminated_round: roundNumber,
        eliminated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    });

    const voteKeysRef = eventRef.collection("voter_keys");
    const voteKeysSnapshot = await transaction.get(voteKeysRef);
    const emailsToNotify = new Set();

    voteKeysSnapshot.docs.forEach((doc) => {
      const keyData = doc.data() || {};
      const keyMovieTitle = String(keyData.movie_title || "");
      if (!eliminatedTitles.includes(keyMovieTitle)) {
        return;
      }

      const currentCredits = Number(keyData.reVoteCredits || 0);
      transaction.set(doc.ref, {
        reVoteCredits: currentCredits + 1,
        lastEliminatedMovie: keyMovieTitle,
        reVoteGrantedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});

      const keyEmail = String(keyData.email || "").trim().toLowerCase();
      if (isLikelyRealEmail(keyEmail)) {
        emailsToNotify.add(keyEmail);
      }

      if (keyData.vote_id) {
        const voteRef = eventRef.collection("votes").doc(String(keyData.vote_id));
        transaction.set(voteRef, {
          is_active: false,
          eliminated: true,
          eliminated_at: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      }
    });

    const emailKeysRef = eventRef.collection("email_keys");
    const emailKeysSnapshot = await transaction.get(emailKeysRef);
    emailKeysSnapshot.docs.forEach((doc) => {
      const keyData = doc.data() || {};
      const keyMovieTitle = String(keyData.movie_title || "");
      if (!eliminatedTitles.includes(keyMovieTitle)) {
        return;
      }

      const currentCredits = Number(keyData.reVoteCredits || 0);
      transaction.set(doc.ref, {
        reVoteCredits: currentCredits + 1,
        lastEliminatedMovie: keyMovieTitle,
        reVoteGrantedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});

      const keyEmail = String(keyData.email || "").trim().toLowerCase();
      if (isLikelyRealEmail(keyEmail)) {
        emailsToNotify.add(keyEmail);
      }
    });

    transaction.set(eventRef.collection("elimination_rounds").doc(`round_${roundNumber}`), {
      round: roundNumber,
      eliminated_titles: eliminatedTitles,
      eliminated_count: eliminatedTitles.length,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    transaction.set(eventRef, {
      currentEliminationRound: roundNumber,
      lastEliminatedTitles: eliminatedTitles,
      lastEliminationAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    return {
      status: "eliminated",
      eventId,
      round: roundNumber,
      eliminatedTitles,
      notifyEmails: Array.from(emailsToNotify),
    };
  });

  if (eliminationResult?.status === "eliminated") {
    const emailsToNotify = new Set(eliminationResult.notifyEmails || []);
    await queueEliminationEmails(eventId, eliminationResult.eliminatedTitles || [], emailsToNotify);
    logger.info("Nightly elimination completed", {
      eventId,
      round: eliminationResult.round,
      eliminatedTitles: eliminationResult.eliminatedTitles || [],
      notifiedEmailCount: emailsToNotify.size,
    });
    return {
      ...eliminationResult,
      notifiedEmailCount: emailsToNotify.size,
    };
  }

  return eliminationResult;
}

exports.runNightlyElimination = onSchedule({
  schedule: ELIMINATION_SCHEDULE,
  timeZone: ELIMINATION_TIMEZONE,
}, async () => {
  const eventIds = Array.from(ELIMINATION_ENABLED_EVENT_IDS);
  for (const eventId of eventIds) {
    try {
      await runNightlyEliminationForEvent(eventId);
    } catch (error) {
      logger.error("Nightly elimination failed for event", {eventId, error});
    }
  }
});

exports.runEliminationRound = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const adminEmail = assertAdminEmail(request.data?.adminEmail);

  const result = await runNightlyEliminationForEvent(eventId);

  logger.info("Manual elimination round requested", {
    eventId,
    adminEmail,
    status: result?.status || "unknown",
  });

  return {
    ok: true,
    eventId,
    ...result,
  };
});

exports.getVoteStatus = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const clientId = sanitizeClientId(request.data?.clientId);
  const {voteKeyRef} = buildVoteLookup(eventId, clientId);

  const voteKeyDoc = await voteKeyRef.get();
  if (!voteKeyDoc.exists) {
    return {hasVoted: false};
  }

  const data = voteKeyDoc.data() || {};
  const reVoteCredits = Number(data.reVoteCredits || 0);
  if (reVoteCredits > 0) {
    return {
      hasVoted: false,
      canRevote: true,
      previousMovieTitle: data.movie_title || null,
      reVoteCredits,
    };
  }

  return {
    hasVoted: true,
    movieTitle: data.movie_title || null,
  };
});

exports.submitVote = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const clientId = sanitizeClientId(request.data?.clientId);
  const requestedMovieTitle = sanitizeMovieTitle(request.data?.movieTitle);
  const requiresEmail = requiresEmailForEvent(eventId);
  const email = requiresEmail ? sanitizeEmail(request.data?.email) : sanitizeOptionalEmail(request.data?.email);
  await verifyCaptchaToken(request, request.data?.captchaToken);
  const {clientIdHash, voteKeyRef} = buildVoteLookup(eventId, clientId);
  const emailHash = email ? hashValue(email) : null;
  const ipHash = hashValue(`${eventId}:${getRequesterIp(request)}`);
  const eventRef = db.collection("events").doc(eventId);
  const votesRef = eventRef.collection("votes");
  const rateLimitRef = eventRef.collection("rate_limits").doc(ipHash);
  const emailKeyRef = email ? eventRef.collection("email_keys").doc(email) : null;
  const legacyEmailKeyRef = emailHash ? eventRef.collection("email_keys").doc(emailHash) : null;
  const movieRef = eventRef.collection("movies").doc(movieDocId(requestedMovieTitle));
  const legacyMovieRef = eventRef.collection("movies").doc(requestedMovieTitle);

  return db.runTransaction(async (transaction) => {
    const rateLimitDoc = await transaction.get(rateLimitRef);
    const voteKeyDoc = await transaction.get(voteKeyRef);
    const emailKeyDoc = emailKeyRef ? await transaction.get(emailKeyRef) : null;
    const legacyEmailKeyDoc = legacyEmailKeyRef ? await transaction.get(legacyEmailKeyRef) : null;
    const movieDoc = await transaction.get(movieRef);
    const legacyMovieDoc = await transaction.get(legacyMovieRef);

    const lastAttemptAt = rateLimitDoc.exists ? rateLimitDoc.data()?.last_attempt_at : null;
    if (lastAttemptAt && Date.now() - lastAttemptAt.toMillis() < RATE_LIMIT_WINDOW_MS) {
      throw new HttpsError("resource-exhausted", "Please wait a few seconds before trying again.");
    }

    const existingVoteKeyData = voteKeyDoc.exists ? (voteKeyDoc.data() || {}) : null;
    const existingEmailKeyData = emailKeyDoc?.exists
      ? (emailKeyDoc.data() || {})
      : legacyEmailKeyDoc?.exists
        ? (legacyEmailKeyDoc.data() || {})
        : null;
    const reVoteCredits = getRevoteCredits(existingVoteKeyData, existingEmailKeyData);

    if (voteKeyDoc.exists && reVoteCredits <= 0) {
      const existingVote = voteKeyDoc.data() || {};
      return {
        status: "already-voted",
        movieTitle: existingVote.movie_title || null,
      };
    }

    if (emailKeyDoc?.exists && reVoteCredits <= 0) {
      const existingEmailVote = emailKeyDoc.data() || {};
      return {
        status: "already-voted",
        movieTitle: existingEmailVote.movie_title || null,
      };
    }

    if (legacyEmailKeyDoc?.exists && reVoteCredits <= 0) {
      const existingEmailVote = legacyEmailKeyDoc.data() || {};
      return {
        status: "already-voted",
        movieTitle: existingEmailVote.movie_title || null,
      };
    }

    if (emailHash) {
      const existingPlainEmailVoteQuery = votesRef.where("email", "==", email).limit(1);
      const existingPlainEmailVoteSnapshot = await transaction.get(existingPlainEmailVoteQuery);
      if (!existingPlainEmailVoteSnapshot.empty) {
        const existingEmailVoteDoc = existingPlainEmailVoteSnapshot.docs[0]?.data() || {};
        return {
          status: "already-voted",
          movieTitle: existingEmailVoteDoc.movie_title || null,
        };
      }

      // Legacy fallback: if old records exist without plain-email keys, still enforce one vote per email.
      const existingHashedEmailVoteQuery = votesRef.where("email_hash", "==", emailHash).limit(1);
      const existingHashedEmailVoteSnapshot = await transaction.get(existingHashedEmailVoteQuery);
      if (!existingHashedEmailVoteSnapshot.empty) {
        const existingEmailVoteDoc = existingHashedEmailVoteSnapshot.docs[0]?.data() || {};
        return {
          status: "already-voted",
          movieTitle: existingEmailVoteDoc.movie_title || null,
        };
      }
    }

    const canonicalMovieTitleFromEvent = movieDoc.exists
      ? String(movieDoc.data()?.movie_title || "").trim()
      : legacyMovieDoc.exists
        ? String(legacyMovieDoc.data()?.movie_title || "").trim()
        : "";

    const canonicalMovieTitleFromAllowList = ALLOWED_MOVIE_LOOKUP.get(normalizeMovieTitle(requestedMovieTitle)) || "";
    const movieTitle = canonicalMovieTitleFromEvent || canonicalMovieTitleFromAllowList;

    if (!movieTitle) {
      throw new HttpsError("invalid-argument", "That movie cannot be voted for.");
    }

    const isMovieEliminated = movieDoc.exists
      ? movieDoc.data()?.eliminated === true
      : legacyMovieDoc.exists
        ? legacyMovieDoc.data()?.eliminated === true
        : false;
    if (isMovieEliminated) {
      throw new HttpsError("invalid-argument", "That movie has been eliminated from this round.");
    }

    transaction.set(rateLimitRef, {
      last_attempt_at: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    const voteRef = votesRef.doc();
    const existingMovieVoteCount = movieDoc.exists
      ? (movieDoc.data()?.vote_count || 0)
      : legacyMovieDoc.exists
        ? (legacyMovieDoc.data()?.vote_count || 0)
        : 0;
    const nextVoteCount = existingMovieVoteCount + 1;
    const updatedRevoteCredits = reVoteCredits > 0 ? reVoteCredits - 1 : 0;

    const voteRecord = {
      client_id_hash: clientIdHash,
      movie_title: movieTitle,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      ip_hash: ipHash,
      is_active: true,
    };

    if (email) {
      voteRecord.email = email;
    }

    transaction.set(voteRef, voteRecord);

    const voteKeyRecord = {
      client_id_hash: clientIdHash,
      movie_title: movieTitle,
      vote_id: voteRef.id,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (emailHash) {
      voteKeyRecord.email = email;
    }
    voteKeyRecord.reVoteCredits = updatedRevoteCredits;

    transaction.set(voteKeyRef, voteKeyRecord);

    if (existingVoteKeyData?.vote_id) {
      const previousVoteRef = votesRef.doc(String(existingVoteKeyData.vote_id));
      transaction.set(previousVoteRef, {
        is_active: false,
        superseded_at: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    }

    if (emailKeyRef && email) {
      transaction.set(emailKeyRef, {
        email,
        client_id_hash: clientIdHash,
        movie_title: movieTitle,
        vote_id: voteRef.id,
        reVoteCredits: updatedRevoteCredits,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    if (movieDoc.exists) {
      transaction.update(movieRef, {
        vote_count: admin.firestore.FieldValue.increment(1),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else if (legacyMovieDoc.exists) {
      transaction.update(legacyMovieRef, {
        vote_count: admin.firestore.FieldValue.increment(1),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      transaction.set(movieRef, {
        movie_title: movieTitle,
        vote_count: 1,
        event_id: eventId,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    logger.info("Vote recorded", {eventId, movieTitle, clientIdHash});

    return {
      status: "recorded",
      movieTitle,
      voteCount: nextVoteCount,
    };
  });
});

exports.addEmailSignup = onCall(async (request) => {
  const email = sanitizeEmail(request.data?.email);

  let eventId = "unknown";
  try {
    eventId = sanitizeEventId(request.data?.eventId || "unknown");
  } catch (error) {
    // Fallback to a generic event id if the provided one is invalid
    eventId = "unknown";
  }

  const ipHash = hashValue(`email:${getRequesterIp(request)}`);

  const signupRef = db.collection("email_signups").doc(email);

  await signupRef.set({
    email,
    event_id: eventId,
    ip_hash: ipHash,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  logger.info("Email signup recorded", {eventId, email});

  return {
    status: "ok",
  };
});

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
