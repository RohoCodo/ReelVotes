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
const ALLOWED_MOVIES = new Set([
  "Clueless",
  "The Fifth Element",
  "The Matrix",
  "The Hangover",
  "Bridesmaids",
  "Superbad",
  "8 Mile",
  "Saw",
  "Shrek",
  "The Truman Show",
]);

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
  if (!ALLOWED_MOVIES.has(normalizedMovieTitle)) {
    throw new HttpsError("invalid-argument", "That movie cannot be voted for.");
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

function sanitizeCaptchaToken(captchaToken) {
  const normalizedCaptchaToken = String(captchaToken || "").trim();
  if (!normalizedCaptchaToken) {
    throw new HttpsError("invalid-argument", "Complete the CAPTCHA challenge and try again.");
  }
  return normalizedCaptchaToken;
}

function movieDocId(movieTitle) {
  return movieTitle.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "");
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
  const movieTitle = sanitizeMovieTitle(request.data?.movieTitle);
  await verifyCaptchaToken(request, request.data?.captchaToken);
  const {clientIdHash, voteKeyRef} = buildVoteLookup(eventId, clientId);
  const ipHash = hashValue(`${eventId}:${getRequesterIp(request)}`);
  const eventRef = db.collection("events").doc(eventId);
  const votesRef = eventRef.collection("votes");
  const rateLimitRef = eventRef.collection("rate_limits").doc(ipHash);
  const movieRef = eventRef.collection("movies").doc(movieDocId(movieTitle));

  return db.runTransaction(async (transaction) => {
    const rateLimitDoc = await transaction.get(rateLimitRef);
    const voteKeyDoc = await transaction.get(voteKeyRef);
    const movieDoc = await transaction.get(movieRef);

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

    const voteRef = votesRef.doc();
    const nextVoteCount = (movieDoc.exists ? (movieDoc.data()?.vote_count || 0) : 0) + 1;

    transaction.set(voteRef, {
      client_id_hash: clientIdHash,
      movie_title: movieTitle,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      ip_hash: ipHash,
    });

    transaction.set(voteKeyRef, {
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

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
