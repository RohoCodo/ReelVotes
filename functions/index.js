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

exports.getVoteStatus = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const clientId = sanitizeClientId(request.data?.clientId);
  const {voteKeyRef} = buildVoteLookup(eventId, clientId);

  const voteKeyDoc = await voteKeyRef.get();
  if (!voteKeyDoc.exists) {
    return {hasVoted: false};
  }

  const data = voteKeyDoc.data() || {};
  return {
    hasVoted: true,
    movieTitle: data.movie_title || null,
  };
});

exports.submitVote = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const clientId = sanitizeClientId(request.data?.clientId);
  const requestedMovieTitle = sanitizeMovieTitle(request.data?.movieTitle);
  const email = sanitizeEmail(request.data?.email);
  await verifyCaptchaToken(request, request.data?.captchaToken);
  const {clientIdHash, voteKeyRef} = buildVoteLookup(eventId, clientId);
  const emailHash = hashValue(email);
  const ipHash = hashValue(`${eventId}:${getRequesterIp(request)}`);
  const eventRef = db.collection("events").doc(eventId);
  const votesRef = eventRef.collection("votes");
  const rateLimitRef = eventRef.collection("rate_limits").doc(ipHash);
  const emailKeyRef = eventRef.collection("email_keys").doc(emailHash);
  const movieRef = eventRef.collection("movies").doc(movieDocId(requestedMovieTitle));
  const legacyMovieRef = eventRef.collection("movies").doc(requestedMovieTitle);

  return db.runTransaction(async (transaction) => {
    const rateLimitDoc = await transaction.get(rateLimitRef);
    const voteKeyDoc = await transaction.get(voteKeyRef);
    const emailKeyDoc = await transaction.get(emailKeyRef);
    const movieDoc = await transaction.get(movieRef);
    const legacyMovieDoc = await transaction.get(legacyMovieRef);

    const lastAttemptAt = rateLimitDoc.exists ? rateLimitDoc.data()?.last_attempt_at : null;
    if (lastAttemptAt && Date.now() - lastAttemptAt.toMillis() < RATE_LIMIT_WINDOW_MS) {
      throw new HttpsError("resource-exhausted", "Please wait a few seconds before trying again.");
    }

    transaction.set(rateLimitRef, {
      last_attempt_at: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    if (voteKeyDoc.exists) {
      const existingVote = voteKeyDoc.data() || {};
      return {
        status: "already-voted",
        movieTitle: existingVote.movie_title || null,
      };
    }

    if (emailKeyDoc.exists) {
      const existingEmailVote = emailKeyDoc.data() || {};
      return {
        status: "already-voted",
        movieTitle: existingEmailVote.movie_title || null,
      };
    }

    // Legacy fallback: if old records exist without email_keys, still enforce one vote per email.
    const existingEmailVoteQuery = votesRef.where("email_hash", "==", emailHash).limit(1);
    const existingEmailVoteSnapshot = await transaction.get(existingEmailVoteQuery);
    if (!existingEmailVoteSnapshot.empty) {
      const existingEmailVoteDoc = existingEmailVoteSnapshot.docs[0]?.data() || {};
      return {
        status: "already-voted",
        movieTitle: existingEmailVoteDoc.movie_title || null,
      };
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

    const voteRef = votesRef.doc();
    const existingMovieVoteCount = movieDoc.exists
      ? (movieDoc.data()?.vote_count || 0)
      : legacyMovieDoc.exists
        ? (legacyMovieDoc.data()?.vote_count || 0)
        : 0;
    const nextVoteCount = existingMovieVoteCount + 1;

    transaction.set(voteRef, {
      client_id_hash: clientIdHash,
      email,
      email_hash: emailHash,
      movie_title: movieTitle,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      ip_hash: ipHash,
    });

    transaction.set(voteKeyRef, {
      client_id_hash: clientIdHash,
      email_hash: emailHash,
      movie_title: movieTitle,
      vote_id: voteRef.id,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    transaction.set(emailKeyRef, {
      email_hash: emailHash,
      client_id_hash: clientIdHash,
      movie_title: movieTitle,
      vote_id: voteRef.id,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

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

  const emailHash = hashValue(email);
  const ipHash = hashValue(`email:${getRequesterIp(request)}`);

  const signupRef = db.collection("email_signups").doc(emailHash);

  await signupRef.set({
    email,
    email_hash: emailHash,
    event_id: eventId,
    ip_hash: ipHash,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  logger.info("Email signup recorded", {eventId, emailHash});

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
