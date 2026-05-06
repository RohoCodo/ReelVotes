/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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

// Maps known admin/programmer emails to their theater's theater_key in the ReelSuccess index.
// Used as the authoritative fallback for My Theater when no Firestore theater_key is stored.
const ADMIN_EMAIL_THEATER_KEY_MAP = new Map([
  ["moses@thenewparkway.com", "PFR|The New Parkway Theater|Oakland, CA"],
  ["programming@thenewparkway.com", "PFR|The New Parkway Theater|Oakland, CA"],
  ["nikki@thenewparkwaytheater.com", "PFR|The New Parkway Theater|Oakland, CA"],
]);
const REELSUCCESS_DATA_DIR = path.join(__dirname, "reelsuccess-data");
let reelSuccessCache = null;

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new HttpsError("failed-precondition", `Missing ReelSuccess data file: ${path.basename(filePath)}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadReelSuccessData() {
  if (reelSuccessCache) {
    return reelSuccessCache;
  }

  const theaterIndexPath = path.join(REELSUCCESS_DATA_DIR, "theater_index.json");
  const theaterInsightsPath = path.join(REELSUCCESS_DATA_DIR, "theater_insights_by_key.json");
  const metadataPath = path.join(REELSUCCESS_DATA_DIR, "metadata.json");

  const theaterIndex = readJsonFileSafe(theaterIndexPath);
  const theaterInsightsByKey = readJsonFileSafe(theaterInsightsPath);
  const metadata = readJsonFileSafe(metadataPath);

  reelSuccessCache = {
    theaterIndex,
    theaterInsightsByKey,
    metadata,
  };

  return reelSuccessCache;
}

function sanitizePositiveInt(value, fallback, maxValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  const floored = Math.floor(n);
  return Math.min(floored, maxValue);
}

function normalizeSearchQuery(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeAlphaNumeric(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function tokenizeMeaningfulText(value) {
  const stopWords = new Set([
    "the", "theater", "theatre", "cinema", "cinemas", "movies", "movie",
    "films", "film", "screen", "screens", "plex", "mall", "center", "centre",
    "regal", "amc",
  ]);
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !stopWords.has(t));
}

function commonPrefixLength(a, b) {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i;
}

function inferTheaterFromEmail(email, theaterIndex = []) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) return null;

  const [localPart, domainPart] = normalizedEmail.split("@");
  // Strip TLD so "thenewparkway.com" -> "thenewparkway"
  const domainRoot = normalizeAlphaNumeric(
    String(domainPart || "").split(".").slice(0, -1).join(""),
  );
  const emailHaystack = normalizeAlphaNumeric(`${localPart} ${domainRoot} ${normalizedEmail}`);

  const scoredMatches = theaterIndex.map((theater) => {
    const nameKey = normalizeAlphaNumeric(theater.theater_name);
    const cityKey = normalizeAlphaNumeric(theater.city || "");
    const nameTokens = tokenizeMeaningfulText(theater.theater_name);
    const cityTokens = tokenizeMeaningfulText(theater.city || "");

    let score = 0;

    // Full normalized name is a substring of the email haystack
    if (nameKey.length >= 6 && emailHaystack.includes(nameKey)) {
      score += 120 + Math.min(nameKey.length, 30);
    }

    // Long common prefix between domain root and theater name key
    // Catches "thenewparkway" matching "thenewparkwaytheater"
    if (domainRoot.length >= 6 && nameKey.length >= 6) {
      const prefixLen = commonPrefixLength(domainRoot, nameKey);
      if (prefixLen >= 6) {
        score += 40 + prefixLen * 4;
      }
    }

    // Each meaningful name token that appears as a substring in the email haystack
    let tokenHits = 0;
    let tokenScore = 0;
    for (const token of nameTokens) {
      if (token.length >= 5 && emailHaystack.includes(token)) {
        tokenHits++;
        tokenScore += 25 + Math.min(token.length, 12);
      }
    }
    if (tokenHits >= 2) {
      score += tokenScore + 25;
    } else if (tokenHits === 1) {
      score += tokenScore;
    }

    // City token in email
    for (const token of cityTokens) {
      if (token.length >= 5 && emailHaystack.includes(token)) {
        score += 15;
        break;
      }
    }
    if (cityKey.length >= 4 && emailHaystack.includes(cityKey)) {
      score += 10;
    }

    return {theater, score};
  })
  .filter((row) => row.score >= 30)
  .sort((a, b) => b.score - a.score);

  if (!scoredMatches.length) return null;

  const best = scoredMatches[0];
  const runnerUp = scoredMatches[1] || null;

  // Require a clear margin so we don't guess wrong
  if (runnerUp && best.score < runnerUp.score + 20) return null;

  return best.theater || null;
}
function tokenizeMeaningfulText(value) {
  const stopWords = new Set([
    "the", "theater", "theatre", "cinema", "cinemas", "movies", "movie",
    "films", "film", "screen", "screens", "plex", "mall", "center", "centre",
    "regal", "amc",
  ]);
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !stopWords.has(t));
}

function commonPrefixLength(a, b) {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i;
}

function inferTheaterFromEmail(email, theaterIndex = []) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !normalizedEmail.includes("@")) return null;

  const [localPart, domainPart] = normalizedEmail.split("@");
  // domainRoot = everything before the TLD, e.g. "thenewparkway" from "thenewparkway.com"
  const domainRoot = normalizeAlphaNumeric(
    String(domainPart || "").split(".").slice(0, -1).join(""),
  );
  const emailHaystack = normalizeAlphaNumeric(`${localPart} ${domainRoot} ${normalizedEmail}`);

  const scoredMatches = theaterIndex.map((theater) => {
    const nameKey = normalizeAlphaNumeric(theater.theater_name);
    const cityKey = normalizeAlphaNumeric(theater.city || "");
    const nameTokens = tokenizeMeaningfulText(theater.theater_name);
    const cityTokens = tokenizeMeaningfulText(theater.city || "");

    let score = 0;

    // Full normalized name is a substring of the email haystack — very strong
    if (nameKey.length >= 6 && emailHaystack.includes(nameKey)) {
      score += 120 + Math.min(nameKey.length, 30);
    }

    // Long common prefix between domain root and theater name key
    // Catches "thenewparkway" ↔ "thenewparkwaytheater"
    if (domainRoot.length >= 6 && nameKey.length >= 6) {
      const prefixLen = commonPrefixLength(domainRoot, nameKey);
      if (prefixLen >= 6) {
        score += 40 + prefixLen * 4;
      }
    }

    // Each meaningful name token that appears as a substring in the email haystack
    let tokenHits = 0;
    let tokenScore = 0;
    for (const token of nameTokens) {
      if (token.length >= 5 && emailHaystack.includes(token)) {
        tokenHits++;
        tokenScore += 25 + Math.min(token.length, 12);
      }
    }
    if (tokenHits >= 2) {
      score += tokenScore + 25;
    } else if (tokenHits === 1) {
      score += tokenScore;
    }

    // City token in email
    for (const token of cityTokens) {
      if (token.length >= 5 && emailHaystack.includes(token)) {
        score += 15;
        break;
      }
    }
    if (cityKey.length >= 4 && emailHaystack.includes(cityKey)) {
      score += 10;
    }

    return {theater, score};
  })
  .filter((row) => row.score >= 30)
  .sort((a, b) => b.score - a.score);

  if (!scoredMatches.length) return null;

  const best = scoredMatches[0];
  const runnerUp = scoredMatches[1] || null;

  // Require a clear margin so we don't guess wrong
  if (runnerUp && best.score < runnerUp.score + 20) return null;

  return best.theater || null;
}

function sanitizeTheaterKey(value) {
  const theaterKey = String(value || "").trim();
  if (!theaterKey) {
    throw new HttpsError("invalid-argument", "theaterKey is required.");
  }
  return theaterKey;
}

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

async function hasReelSuccessAccess(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return false;
  }

  if (ADMIN_EMAILS.has(normalizedEmail)) {
    return true;
  }

  const accessDoc = await db.collection("reelsuccess_access").doc("users").collection("allowed").doc(normalizedEmail).get();
  if (!accessDoc.exists) {
    return false;
  }

  const accessData = accessDoc.data() || {};
  return accessData.enabled !== false;
}

async function getReelSuccessAccessData(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  const accessDoc = await db.collection("reelsuccess_access").doc("users").collection("allowed").doc(normalizedEmail).get();
  if (!accessDoc.exists) {
    return null;
  }

  return accessDoc.data() || {};
}

async function assertReelSuccessAccess(email) {
  const normalizedEmail = normalizeEmail(email);
  const allowed = await hasReelSuccessAccess(normalizedEmail);
  if (!allowed) {
    throw new HttpsError("permission-denied", "ReelSuccess access denied.");
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

function sanitizeMovieTitles(movieTitlesInput) {
  const rawTitles = Array.isArray(movieTitlesInput)
    ? movieTitlesInput
    : movieTitlesInput == null
      ? []
      : [movieTitlesInput];

  const deduped = [];
  const seen = new Set();

  rawTitles.forEach((title) => {
    const sanitized = sanitizeMovieTitle(title);
    const key = normalizeMovieTitle(sanitized);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(sanitized);
    }
  });

  if (deduped.length === 0) {
    throw new HttpsError("invalid-argument", "Select at least one movie before submitting.");
  }

  if (deduped.length > 20) {
    throw new HttpsError("invalid-argument", "You can submit up to 20 movies per ballot.");
  }

  return deduped;
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
    // 1. All reads first
    const eventDoc = await transaction.get(eventRef);
    const eventData = eventDoc.exists ? (eventDoc.data() || {}) : {};
    if (!isEliminationEnabledForEvent(eventId, eventData)) {
      return {
        status: "disabled",
        eventId,
      };
    }

    const moviesRef = eventRef.collection("movies");
    const voteKeysRef = eventRef.collection("voter_keys");
    const emailKeysRef = eventRef.collection("email_keys");

    // Read all required data before any writes
    const [moviesSnapshot, voteKeysSnapshot, emailKeysSnapshot] = await Promise.all([
      transaction.get(moviesRef),
      transaction.get(voteKeysRef),
      transaction.get(emailKeysRef),
    ]);

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

    // 2. All writes after reads
    eliminatedMovies.forEach((movie) => {
      transaction.set(movie.ref, {
        eliminated: true,
        eliminated_round: roundNumber,
        eliminated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
    });

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

// Nightly elimination is currently disabled. To re-enable, uncomment the code below.
// exports.runNightlyElimination = onSchedule({
//   schedule: ELIMINATION_SCHEDULE,
//   timeZone: ELIMINATION_TIMEZONE,
// }, async () => {
//   const eventIds = Array.from(ELIMINATION_ENABLED_EVENT_IDS);
//   for (const eventId of eventIds) {
//     try {
//       await runNightlyEliminationForEvent(eventId);
//     } catch (error) {
//       logger.error("Nightly elimination failed for event", {eventId, error});
//     }
//   }
// });

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
    movieTitles: Array.isArray(data.movie_titles)
      ? data.movie_titles
      : data.movie_title
        ? [data.movie_title]
        : [],
  };
});

exports.submitVote = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const clientId = sanitizeClientId(request.data?.clientId);
  const requestedMovieTitles = sanitizeMovieTitles(
    Array.isArray(request.data?.movieTitles) && request.data.movieTitles.length > 0
      ? request.data.movieTitles
      : request.data?.movieTitle,
  );
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
  const requestedMovieRefs = requestedMovieTitles.map((requestedMovieTitle) => ({
    requestedMovieTitle,
    movieRef: eventRef.collection("movies").doc(movieDocId(requestedMovieTitle)),
    legacyMovieRef: eventRef.collection("movies").doc(requestedMovieTitle),
  }));

  return db.runTransaction(async (transaction) => {
    const rateLimitDoc = await transaction.get(rateLimitRef);
    const voteKeyDoc = await transaction.get(voteKeyRef);
    const emailKeyDoc = emailKeyRef ? await transaction.get(emailKeyRef) : null;
    const legacyEmailKeyDoc = legacyEmailKeyRef ? await transaction.get(legacyEmailKeyRef) : null;
    const requestedMovieDocs = [];
    for (const requested of requestedMovieRefs) {
      const movieDoc = await transaction.get(requested.movieRef);
      const legacyMovieDoc = await transaction.get(requested.legacyMovieRef);
      requestedMovieDocs.push({
        ...requested,
        movieDoc,
        legacyMovieDoc,
      });
    }

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
        movieTitles: Array.isArray(existingVote.movie_titles)
          ? existingVote.movie_titles
          : existingVote.movie_title
            ? [existingVote.movie_title]
            : [],
      };
    }

    if (emailKeyDoc?.exists && reVoteCredits <= 0) {
      const existingEmailVote = emailKeyDoc.data() || {};
      return {
        status: "already-voted",
        movieTitle: existingEmailVote.movie_title || null,
        movieTitles: Array.isArray(existingEmailVote.movie_titles)
          ? existingEmailVote.movie_titles
          : existingEmailVote.movie_title
            ? [existingEmailVote.movie_title]
            : [],
      };
    }

    if (legacyEmailKeyDoc?.exists && reVoteCredits <= 0) {
      const existingEmailVote = legacyEmailKeyDoc.data() || {};
      return {
        status: "already-voted",
        movieTitle: existingEmailVote.movie_title || null,
        movieTitles: Array.isArray(existingEmailVote.movie_titles)
          ? existingEmailVote.movie_titles
          : existingEmailVote.movie_title
            ? [existingEmailVote.movie_title]
            : [],
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
          movieTitles: existingEmailVoteDoc.movie_title
            ? [existingEmailVoteDoc.movie_title]
            : [],
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
          movieTitles: existingEmailVoteDoc.movie_title
            ? [existingEmailVoteDoc.movie_title]
            : [],
        };
      }
    }

    const canonicalMovieMeta = [];
    const seenCanonicalTitles = new Set();

    requestedMovieDocs.forEach((requested) => {
      const canonicalMovieTitleFromEvent = requested.movieDoc.exists
        ? String(requested.movieDoc.data()?.movie_title || "").trim()
        : requested.legacyMovieDoc.exists
          ? String(requested.legacyMovieDoc.data()?.movie_title || "").trim()
          : "";

      const canonicalMovieTitleFromAllowList = ALLOWED_MOVIE_LOOKUP.get(normalizeMovieTitle(requested.requestedMovieTitle)) || "";
      const movieTitle = canonicalMovieTitleFromEvent || canonicalMovieTitleFromAllowList;

      if (!movieTitle) {
        throw new HttpsError("invalid-argument", `That movie cannot be voted for: ${requested.requestedMovieTitle}`);
      }

      const isMovieEliminated = requested.movieDoc.exists
        ? requested.movieDoc.data()?.eliminated === true
        : requested.legacyMovieDoc.exists
          ? requested.legacyMovieDoc.data()?.eliminated === true
          : false;
      if (isMovieEliminated) {
        throw new HttpsError("invalid-argument", `That movie has been eliminated: ${movieTitle}`);
      }

      const canonicalKey = normalizeMovieTitle(movieTitle);
      if (seenCanonicalTitles.has(canonicalKey)) {
        return;
      }
      seenCanonicalTitles.add(canonicalKey);

      canonicalMovieMeta.push({
        movieTitle,
        movieRef: requested.movieRef,
        legacyMovieRef: requested.legacyMovieRef,
        movieDoc: requested.movieDoc,
        legacyMovieDoc: requested.legacyMovieDoc,
      });
    });

    if (canonicalMovieMeta.length === 0) {
      throw new HttpsError("invalid-argument", "Select at least one valid movie before submitting.");
    }

    const movieTitles = canonicalMovieMeta.map((item) => item.movieTitle);
    const primaryMovieTitle = movieTitles[0];

    transaction.set(rateLimitRef, {
      last_attempt_at: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    const updatedRevoteCredits = reVoteCredits > 0 ? reVoteCredits - 1 : 0;

    const ballotId = votesRef.doc().id;
    const voteRefs = canonicalMovieMeta.map(() => votesRef.doc());

    voteRefs.forEach((voteRef, index) => {
      const voteRecord = {
        ballot_id: ballotId,
        client_id_hash: clientIdHash,
        movie_title: movieTitles[index],
        movie_titles: movieTitles,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        ip_hash: ipHash,
        is_active: true,
      };

      if (email) {
        voteRecord.email = email;
      }

      transaction.set(voteRef, voteRecord);
    });

    const voteKeyRecord = {
      client_id_hash: clientIdHash,
      movie_title: primaryMovieTitle,
      movie_titles: movieTitles,
      vote_id: voteRefs[0].id,
      vote_ids: voteRefs.map((ref) => ref.id),
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

    if (Array.isArray(existingVoteKeyData?.vote_ids)) {
      existingVoteKeyData.vote_ids.forEach((voteId) => {
        if (!voteId) {
          return;
        }
        const previousVoteRef = votesRef.doc(String(voteId));
        transaction.set(previousVoteRef, {
          is_active: false,
          superseded_at: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      });
    }

    if (emailKeyRef && email) {
      transaction.set(emailKeyRef, {
        email,
        client_id_hash: clientIdHash,
        movie_title: primaryMovieTitle,
        movie_titles: movieTitles,
        vote_id: voteRefs[0].id,
        vote_ids: voteRefs.map((ref) => ref.id),
        reVoteCredits: updatedRevoteCredits,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    canonicalMovieMeta.forEach((movieMeta) => {
      if (movieMeta.movieDoc.exists) {
        transaction.update(movieMeta.movieRef, {
          vote_count: admin.firestore.FieldValue.increment(1),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else if (movieMeta.legacyMovieDoc.exists) {
        transaction.update(movieMeta.legacyMovieRef, {
          vote_count: admin.firestore.FieldValue.increment(1),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        transaction.set(movieMeta.movieRef, {
          movie_title: movieMeta.movieTitle,
          vote_count: 1,
          event_id: eventId,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });

    logger.info("Vote recorded", {eventId, movieTitles, clientIdHash});

    return {
      status: "recorded",
      movieTitle: primaryMovieTitle,
      movieTitles,
      voteCount: movieTitles.length,
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

exports.reelSuccessListTheaters = onCall(async (request) => {
  await assertReelSuccessAccess(request.data?.adminEmail);
  const {theaterIndex, metadata} = loadReelSuccessData();

  const query = normalizeSearchQuery(request.data?.query);
  const limit = sanitizePositiveInt(request.data?.limit, 25, 100);

  let filtered = theaterIndex;
  if (query) {
    filtered = theaterIndex.filter((row) => {
      const haystack = [
        row.theater_name,
        row.theater_city_state,
        row.theater_code,
        row.city,
        row.state_abbr,
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }

  return {
    ok: true,
    total: filtered.length,
    limit,
    dataVersion: metadata?.created_at || null,
    theaters: filtered.slice(0, limit),
  };
});

exports.reelSuccessGetTheaterInsights = onCall(async (request) => {
  await assertReelSuccessAccess(request.data?.adminEmail);
  const {theaterInsightsByKey, metadata} = loadReelSuccessData();
  const theaterKey = sanitizeTheaterKey(request.data?.theaterKey);

  const insights = theaterInsightsByKey[theaterKey] || null;
  if (!insights) {
    throw new HttpsError("not-found", "No ReelSuccess insights found for theaterKey.");
  }

  return {
    ok: true,
    dataVersion: metadata?.created_at || null,
    ...insights,
  };
});

exports.reelSuccessGetMyTheater = onCall(async (request) => {
  const adminEmail = await assertReelSuccessAccess(request.data?.adminEmail);
  const accessData = await getReelSuccessAccessData(adminEmail);
  const {theaterIndex, metadata} = loadReelSuccessData();

  let theater = null;

  // 1. Hardcoded admin map (guaranteed correct for known staff)
  const hardcodedKey = ADMIN_EMAIL_THEATER_KEY_MAP.get(adminEmail);
  if (hardcodedKey) {
    theater = theaterIndex.find((row) => row.theater_key === hardcodedKey) || null;
  }

  // 2. Explicit theater_key stored on the Firestore access record
  const requestedTheaterKey = String(accessData?.theater_key || accessData?.theaterKey || "").trim();
  if (!theater && requestedTheaterKey) {
    theater = theaterIndex.find((row) => row.theater_key === requestedTheaterKey) || null;
  }

  // 3. theater_code or theater_name on the access record
  const requestedTheaterCode = normalizeSearchQuery(accessData?.theater_code || accessData?.theaterCode || "");
  const requestedTheaterName = normalizeSearchQuery(accessData?.theater_name || accessData?.theaterName || "");

  if (!theater && requestedTheaterCode) {
    theater = theaterIndex.find((row) => normalizeSearchQuery(row.theater_code) === requestedTheaterCode) || null;
  }

  if (!theater && requestedTheaterName) {
    theater = theaterIndex.find((row) => normalizeSearchQuery(row.theater_name) === requestedTheaterName) || null;
  }

  // 4. Heuristic inference from login email domain/local part
  if (!theater) {
    theater = inferTheaterFromEmail(adminEmail, theaterIndex);
  }

  if (!theater) {
    throw new HttpsError(
      "not-found",
      "No theater could be inferred from this ReelSuccess login email. Add theater_key to the user's access record.",
    );
  }

  return {
    ok: true,
    dataVersion: metadata?.created_at || null,
    theater,
  };
});

exports.reelSuccessSetAccess = onCall(async (request) => {
  const adminEmail = assertAdminEmail(request.data?.adminEmail);
  const targetEmail = normalizeEmail(request.data?.targetEmail);
  const enabled = request.data?.enabled !== false;
  const theaterKeyInput = request.data?.theaterKey;

  if (!targetEmail || !targetEmail.includes("@")) {
    throw new HttpsError("invalid-argument", "Valid targetEmail is required.");
  }

  const accessRef = db.collection("reelsuccess_access").doc("users").collection("allowed").doc(targetEmail);
  const payload = {
    email: targetEmail,
    enabled,
    updated_by: adminEmail,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (theaterKeyInput !== undefined) {
    payload.theater_key = theaterKeyInput ? sanitizeTheaterKey(theaterKeyInput) : admin.firestore.FieldValue.delete();
  }

  await accessRef.set(payload, {merge: true});

  return {
    ok: true,
    targetEmail,
    enabled,
    theaterKey: payload.theater_key && typeof payload.theater_key === "string" ? payload.theater_key : null,
  };
});

exports.reelSuccessListAccess = onCall(async (request) => {
  assertAdminEmail(request.data?.adminEmail);

  const snapshot = await db.collection("reelsuccess_access").doc("users").collection("allowed").get();
  const users = snapshot.docs
    .map((doc) => {
      const row = doc.data() || {};
      return {
        email: row.email || doc.id,
        enabled: row.enabled !== false,
        theater_key: row.theater_key || null,
        updated_by: row.updated_by || null,
        updated_at: row.updated_at || null,
      };
    })
    .sort((a, b) => String(a.email || "").localeCompare(String(b.email || "")));

  return {
    ok: true,
    count: users.length,
    users,
  };
});

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
