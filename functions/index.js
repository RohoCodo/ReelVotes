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
const SCREENING_WORKFLOW_SWEEP_SCHEDULE = "every 15 minutes";
const SCREENING_WORKFLOW_TIMEZONE = "America/Los_Angeles";
const ELIMINATION_ENABLED_EVENT_IDS = new Set([]);
const DEFAULT_ELIMINATIONS_PER_NIGHT = 3;
const LEGACY_ANON_EMAIL_SUFFIX = "@reelvotes.local";
const EMAIL_OPTIONAL_EVENT_IDS = new Set([]);
const PRIVILEGED_ADMIN_EMAIL = "rt332@cornell.edu";
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
const REELSUCCESS_CALL_OPTIONS = {
  memory: "1GiB",
  timeoutSeconds: 120,
};
let reelSuccessCache = {
  theaterIndex: null,
  theaterInsightsByKey: null,
  metadata: null,
};

const WORKFLOW_STATUS = Object.freeze({
  VOTING: "VOTING",
  LICENSING: "LICENSING",
  THEATER_APPROVAL: "THEATER_APPROVAL",
  PRESALE: "PRESALE",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
  COMPLETED: "COMPLETED",
});

const TRANSITIONAL_WORKFLOW_STATES = new Set([
  WORKFLOW_STATUS.VOTING,
  WORKFLOW_STATUS.LICENSING,
  WORKFLOW_STATUS.THEATER_APPROVAL,
  WORKFLOW_STATUS.PRESALE,
  WORKFLOW_STATUS.CONFIRMED,
]);

function readJsonFileSafe(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new HttpsError("failed-precondition", `Missing ReelSuccess data file: ${path.basename(filePath)}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function loadReelSuccessIndexData() {
  const theaterIndexPath = path.join(REELSUCCESS_DATA_DIR, "theater_index.json");
  const metadataPath = path.join(REELSUCCESS_DATA_DIR, "metadata.json");

  if (!reelSuccessCache.theaterIndex) {
    reelSuccessCache.theaterIndex = readJsonFileSafe(theaterIndexPath);
  }
  if (!reelSuccessCache.metadata) {
    reelSuccessCache.metadata = readJsonFileSafe(metadataPath);
  }

  return {
    theaterIndex: reelSuccessCache.theaterIndex,
    metadata: reelSuccessCache.metadata,
  };
}

function loadReelSuccessInsightsData() {
  const theaterInsightsPath = path.join(REELSUCCESS_DATA_DIR, "theater_insights_by_key.json");

  if (!reelSuccessCache.theaterInsightsByKey) {
    if (fs.existsSync(theaterInsightsPath)) {
      reelSuccessCache.theaterInsightsByKey = readJsonFileSafe(theaterInsightsPath);
    } else {
      console.warn(`[reelSuccess] Missing optional insights file: ${path.basename(theaterInsightsPath)}. Falling back to profile-only insights.`);
      reelSuccessCache.theaterInsightsByKey = {};
    }
  }

  return {
    theaterInsightsByKey: reelSuccessCache.theaterInsightsByKey,
  };
}

function loadReelSuccessData() {
  const indexData = loadReelSuccessIndexData();
  const insightsData = loadReelSuccessInsightsData();

  return {
    theaterIndex: indexData.theaterIndex,
    metadata: indexData.metadata,
    theaterInsightsByKey: insightsData.theaterInsightsByKey,
  };
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

function requiresEmailForEvent(eventId, eventData = {}) {
  if (typeof eventData.requireEmail === "boolean") {
    return eventData.requireEmail;
  }
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

function normalizeAccessRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "super_admin" || role === "admin") return "super_admin";
  if (role === "theater_user" || role === "theater") return "theater_user";
  return "none";
}

function sanitizeBusinessDate(value) {
  const businessDate = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new HttpsError("invalid-argument", "businessDate must be YYYY-MM-DD.");
  }
  return businessDate;
}

function sanitizePdfFileName(fileName) {
  const raw = String(fileName || "").trim();
  if (!raw) {
    throw new HttpsError("invalid-argument", "fileName is required.");
  }
  if (!raw.toLowerCase().endsWith(".pdf")) {
    throw new HttpsError("invalid-argument", "Only PDF uploads are supported.");
  }

  const cleaned = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);

  if (!cleaned || !cleaned.toLowerCase().endsWith(".pdf")) {
    throw new HttpsError("invalid-argument", "Invalid PDF file name.");
  }

  return cleaned;
}

function toTheaterId(value) {
  const theaterId = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  if (!theaterId) {
    throw new HttpsError("invalid-argument", "A valid theater identifier is required.");
  }

  return theaterId;
}

function isAdminToken(token = {}) {
  const role = normalizeAccessRole(token.role);
  return token.admin === true || role === "super_admin";
}

function getRequestIdentity(request) {
  const token = request.auth?.token || {};
  const uid = request.auth?.uid || null;
  const authEmail = normalizeEmail(token.email);
  const providedEmail = normalizeEmail(request.data?.adminEmail || request.data?.email);
  const email = authEmail || providedEmail;
  return {uid, token, email};
}

async function assertReelSuccessRequester(request, {requireAuth = true} = {}) {
  const identity = getRequestIdentity(request);
  if (requireAuth && !identity.uid) {
    throw new HttpsError("unauthenticated", "Sign in is required.");
  }

  const accessData = identity.email ? await getReelSuccessAccessData(identity.email) : null;
  const normalizedRole = normalizeAccessRole(accessData?.role);
  const hasExplicitAccess = identity.email
    ? (ADMIN_EMAILS.has(identity.email) || (accessData && accessData.enabled !== false && normalizedRole !== "none"))
    : false;

  if (!hasExplicitAccess && !isAdminToken(identity.token)) {
    throw new HttpsError("permission-denied", "ReelSuccess access denied.");
  }

  const tokenTheaterKey = String(identity.token?.theaterKey || identity.token?.theater_key || "").trim();
  const accessTheaterKey = String(accessData?.theater_key || accessData?.theaterKey || "").trim();
  const theaterKey = tokenTheaterKey || accessTheaterKey;

  const tokenTheaterId = String(identity.token?.theaterId || "").trim();
  const accessTheaterId = String(accessData?.theater_id || "").trim();
  const theaterId = tokenTheaterId || accessTheaterId || (theaterKey ? toTheaterId(theaterKey) : "");

  const isAdmin = isAdminToken(identity.token)
    || ADMIN_EMAILS.has(identity.email)
    || normalizeAccessRole(accessData?.role) === "super_admin";

  return {
    uid: identity.uid,
    email: identity.email,
    token: identity.token,
    accessData,
    isAdmin,
    theaterKey,
    theaterId,
  };
}

function assertTheaterScope(ctx, requestedTheaterKey) {
  const theaterKey = sanitizeTheaterKey(requestedTheaterKey);
  const theaterId = toTheaterId(theaterKey);

  if (!ctx.isAdmin && ctx.theaterId !== theaterId) {
    throw new HttpsError("permission-denied", "You are not allowed to access this theater.");
  }

  return {theaterKey, theaterId};
}

function assertAdminEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!ADMIN_EMAILS.has(normalizedEmail)) {
    throw new HttpsError("permission-denied", "Admin access denied.");
  }
  return normalizedEmail;
}

function assertPrivilegedAdminEmail(email, actionName = "this action") {
  const normalizedEmail = assertAdminEmail(email);
  if (normalizedEmail !== PRIVILEGED_ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", `Only ${PRIVILEGED_ADMIN_EMAIL} can ${actionName}.`);
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

  const accessData = await getReelSuccessAccessData(normalizedEmail);
  if (!accessData) return false;
  return accessData.enabled !== false;
}

async function getReelSuccessAccessData(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  const theaterUserDoc = await db.collection("theaterUsers").doc(normalizedEmail).get();
  if (theaterUserDoc.exists) {
    const row = theaterUserDoc.data() || {};
    const normalizedRole = normalizeAccessRole(row.role);
    const inferredRole = normalizedRole !== "none"
      ? normalizedRole
      : ((row.theater_key || row.theaterKey || row.theater_id || row.theaterId) ? "theater_user" : "none");
    return {
      ...row,
      email: row.email || normalizedEmail,
      role: inferredRole,
      theater_key: row.theater_key || row.theaterKey || "",
      theater_id: row.theater_id || row.theaterId || "",
      enabled: row.active !== false && row.enabled !== false,
      source: "theaterUsers",
    };
  }

  const accessDoc = await db.collection("reelsuccess_access").doc("users").collection("allowed").doc(normalizedEmail).get();
  if (!accessDoc.exists) {
    return null;
  }

  const row = accessDoc.data() || {};
  const normalizedRole = normalizeAccessRole(row.role);
  const inferredRole = normalizedRole !== "none"
    ? normalizedRole
    : ((row.theater_key || row.theaterKey || row.theater_id || row.theaterId) ? "theater_user" : "none");
  return {
    ...row,
    email: row.email || normalizedEmail,
    role: inferredRole,
    theater_key: row.theater_key || row.theaterKey || "",
    theater_id: row.theater_id || row.theaterId || "",
    enabled: row.enabled !== false,
    source: "reelsuccess_access",
  };
}

function buildReelSuccessClaims({email, accessData, existingClaims = {}}) {
  const role = ADMIN_EMAILS.has(email)
    ? "super_admin"
    : normalizeAccessRole(accessData?.role);

  const nextClaims = {
    ...existingClaims,
  };

  if (role === "super_admin") {
    nextClaims.role = "super_admin";
    nextClaims.admin = true;
    delete nextClaims.theaterId;
    delete nextClaims.theaterKey;
    return nextClaims;
  }

  let theaterKey = String(accessData?.theater_key || accessData?.theaterKey || "").trim();
  let theaterIdFromAccess = String(accessData?.theater_id || accessData?.theaterId || "").trim();

  if (!theaterKey && !theaterIdFromAccess) {
    const {theaterIndex} = loadReelSuccessIndexData();
    const inferredTheater = inferTheaterFromEmail(email, theaterIndex);
    theaterKey = String(inferredTheater?.theater_key || "").trim();
  }

  const theaterId = theaterIdFromAccess || (theaterKey ? toTheaterId(theaterKey) : "");

  if (!theaterId) {
    throw new HttpsError(
      "failed-precondition",
      "No theater mapping found for this account. Add theaterKey/theaterId in theaterUsers.",
    );
  }

  nextClaims.role = "theater_user";
  nextClaims.admin = false;
  nextClaims.theaterId = theaterId;
  if (theaterKey) {
    nextClaims.theaterKey = theaterKey;
  } else {
    delete nextClaims.theaterKey;
  }
  return nextClaims;
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

function normalizeMovieTitleLoose(movieTitle) {
  return normalizeMovieTitle(movieTitle)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMovieTitleCompact(movieTitle) {
  return normalizeMovieTitle(movieTitle)
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

const VOTE_TITLE_ALIASES = new Map([
  ["the live", "they live"],
]);

function normalizeVoteTitleForMatching(movieTitle) {
  const normalized = normalizeMovieTitle(movieTitle);
  return VOTE_TITLE_ALIASES.get(normalized) || normalized;
}

const EVENT_ALLOWED_MOVIES = new Map([
  ["np-2026-05-26-1830", [
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
  ]],
  ["np-2026-06-01-1830", [
    "Donnie Darko",
    "Brazil",
    "Soylent Green",
    "A Clockwork Orange",
    "THX1138",
    "The Man Who Fell to Earth",
    "12 Monkeys",
    "Invasion of the Body Snatchers",
    "Videodrome",
    "Nausicaa of the Valley of the Wind",
  ]],
  ["np-2026-06-08-1830", [
    "Hereditary",
    "The Lighthouse",
    "Climax",
    "Under the Skin",
    "The Green Knight",
    "Pearl",
    "Bodies Bodies Bodies",
    "Love Lies Bleeding",
    "Ex Machina",
    "Good Time",
  ]],
  ["np-2026-06-15-1830", [
    "Children of Men",
    "War of the Worlds",
    "Serenity",
    "Vanilla Sky",
    "Star Trek (2009)",
    "V For Vendetta",
    "Slither",
    "Zombieland",
    "28 Days Later",
    "Cloverfield",
  ]],
]);

function getAllowedMovieLookupForEvent(eventId) {
  return new Map(
    (EVENT_ALLOWED_MOVIES.get(eventId) || [])
      .map((title) => [normalizeMovieTitle(title), title]),
  );
}

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

function buildMovieChatKey(movieTitle) {
  const normalized = normalizeMovieTitleLoose(movieTitle)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  if (!normalized) {
    throw new HttpsError("invalid-argument", "Unable to build a valid movie chat room key.");
  }

  return normalized;
}

function buildMovieChatThreadId(movieTitle) {
  return `movie__${buildMovieChatKey(movieTitle)}`;
}

function sanitizeMovieChatThreadId(threadId) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!/^movie__[a-z0-9-]{2,120}$/.test(normalizedThreadId)) {
    throw new HttpsError("invalid-argument", "Invalid movie chat room id.");
  }
  return normalizedThreadId;
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function sanitizeRoomCode(roomCode) {
  const normalizedCode = normalizeRoomCode(roomCode);
  if (normalizedCode.length < 4 || normalizedCode.length > 32) {
    throw new HttpsError("invalid-argument", "Room code must be 4-32 letters or numbers.");
  }
  return normalizedCode;
}

function sanitizeParticipantId(participantId) {
  const normalizedParticipantId = String(participantId || "").trim();
  if (!/^[a-z0-9_-]{8,120}$/i.test(normalizedParticipantId)) {
    throw new HttpsError("invalid-argument", "Invalid chat participant id.");
  }
  return normalizedParticipantId;
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

function sanitizeOptionalMovieTitles(movieTitlesInput) {
  if (movieTitlesInput == null) {
    return [];
  }

  const rawTitles = Array.isArray(movieTitlesInput)
    ? movieTitlesInput
    : [movieTitlesInput];

  if (rawTitles.length === 0) {
    return [];
  }

  const deduped = [];
  const seen = new Set();

  rawTitles.forEach((title) => {
    const normalizedMovieTitle = String(title || "").trim();
    if (!normalizedMovieTitle) {
      return;
    }
    if (normalizedMovieTitle.length > 200) {
      throw new HttpsError("invalid-argument", "Movie titles must be 200 characters or fewer.");
    }

    const key = normalizeMovieTitle(normalizedMovieTitle);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(normalizedMovieTitle);
    }
  });

  if (deduped.length > 20) {
    throw new HttpsError("invalid-argument", "You can preload up to 20 movies per event.");
  }

  return deduped;
}

async function deleteCollectionDocuments(collectionRef, batchSize = 400) {
  let deletedCount = 0;

  while (true) {
    const snapshot = await collectionRef.limit(batchSize).get();
    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();
    snapshot.docs.forEach((docSnapshot) => {
      batch.delete(docSnapshot.ref);
    });
    await batch.commit();

    deletedCount += snapshot.size;

    if (snapshot.size < batchSize) {
      break;
    }
  }

  return deletedCount;
}

function sanitizeVoteStatus(voteStatusInput) {
  const normalizedVoteStatus = String(voteStatusInput || "not-started").trim().toLowerCase();
  if (!["not-started", "live", "ended"].includes(normalizedVoteStatus)) {
    throw new HttpsError("invalid-argument", "voteStatus must be 'not-started', 'live', or 'ended'.");
  }
  return normalizedVoteStatus;
}

function deriveWorkflowStatus(eventData = {}) {
  const configured = String(eventData.workflowStatus || "").trim().toUpperCase();
  if (Object.values(WORKFLOW_STATUS).includes(configured)) {
    return configured;
  }

  const voteStatus = sanitizeVoteStatus(eventData.voteStatus);
  return voteStatus === "ended" ? WORKFLOW_STATUS.LICENSING : WORKFLOW_STATUS.VOTING;
}

function toDateOrNull(value) {
  if (!value) return null;

  if (typeof value.toDate === "function") {
    const dateValue = value.toDate();
    if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
      return dateValue;
    }
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

function hasReached(deadline, now) {
  const dateValue = toDateOrNull(deadline);
  return Boolean(dateValue && dateValue.getTime() <= now.getTime());
}

function toNumberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addDays(dateValue, days) {
  const next = new Date(dateValue.getTime());
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function buildInitialWorkflowFields(voteStatusInput, now = new Date()) {
  const voteStatus = sanitizeVoteStatus(voteStatusInput);
  const workflowStatus = voteStatus === "ended" ? WORKFLOW_STATUS.LICENSING : WORKFLOW_STATUS.VOTING;
  const workflow = {
    workflowStatus,
    workflowUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    [`stateTimestamps.${workflowStatus}`]: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (voteStatus === "live") {
    workflow.voteStartedAt = now;
    workflow.voteEndsAt = addDays(now, 7);
  }

  return workflow;
}

function getWorkflowTransition(eventData = {}, now = new Date()) {
  const currentState = deriveWorkflowStatus(eventData);
  const update = {
    workflowUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_by: "workflow-bot",
  };

  if (currentState === WORKFLOW_STATUS.VOTING) {
    const voteEnded = sanitizeVoteStatus(eventData.voteStatus) === "ended";
    if (voteEnded || hasReached(eventData.voteEndsAt, now)) {
      return {
        nextState: WORKFLOW_STATUS.LICENSING,
        update: {
          ...update,
          voteStatus: "ended",
          voteWindowLabel: buildVoteWindowLabel("ended"),
        },
        reason: "voting-window-ended",
      };
    }
  }

  if (currentState === WORKFLOW_STATUS.LICENSING) {
    const licensingApproved = eventData.licensingApproved === true
      || eventData?.licensing?.approved === true;
    const licensingDenied = eventData.licensingApproved === false
      || eventData?.licensing?.approved === false;

    if (licensingApproved) {
      return {
        nextState: WORKFLOW_STATUS.THEATER_APPROVAL,
        update,
        reason: "licensing-approved",
      };
    }

    if (licensingDenied) {
      return {
        nextState: WORKFLOW_STATUS.CANCELLED,
        update: {
          ...update,
          cancellationReason: "Licensing not approved",
        },
        reason: "licensing-denied",
      };
    }
  }

  if (currentState === WORKFLOW_STATUS.THEATER_APPROVAL) {
    const theaterApproved = eventData.theaterApproved === true
      || eventData?.theaterApproval?.approved === true;
    const theaterRejected = eventData.theaterApproved === false
      || eventData?.theaterApproval?.approved === false;

    if (theaterApproved) {
      return {
        nextState: WORKFLOW_STATUS.PRESALE,
        update,
        reason: "theater-approved",
      };
    }

    if (theaterRejected) {
      return {
        nextState: WORKFLOW_STATUS.CANCELLED,
        update: {
          ...update,
          cancellationReason: "Theater did not approve screening",
        },
        reason: "theater-rejected",
      };
    }
  }

  if (currentState === WORKFLOW_STATUS.PRESALE && hasReached(eventData.presaleEndsAt, now)) {
    const sold = toNumberOrZero(eventData.ticketsSold);
    const threshold = toNumberOrZero(eventData.presaleThreshold);
    const passed = sold >= threshold;
    return {
      nextState: passed ? WORKFLOW_STATUS.CONFIRMED : WORKFLOW_STATUS.CANCELLED,
      update: {
        ...update,
        cancellationReason: passed ? admin.firestore.FieldValue.delete() : "Presale threshold not met",
      },
      reason: passed ? "presale-threshold-met" : "presale-threshold-not-met",
    };
  }

  if (currentState === WORKFLOW_STATUS.CONFIRMED && hasReached(eventData.screeningDateTime, now)) {
    return {
      nextState: WORKFLOW_STATUS.COMPLETED,
      update,
      reason: "screening-date-passed",
    };
  }

  return null;
}

async function processScreeningTransitionsOnce() {
  const now = new Date();
  const eventsSnapshot = await db.collection("events").get();

  let transitioned = 0;
  const summaries = [];

  for (const eventDoc of eventsSnapshot.docs) {
    const eventData = eventDoc.data() || {};
    const currentState = deriveWorkflowStatus(eventData);
    if (!TRANSITIONAL_WORKFLOW_STATES.has(currentState)) {
      continue;
    }

    const transition = getWorkflowTransition(eventData, now);
    if (!transition) {
      continue;
    }

    await eventDoc.ref.set({
      workflowStatus: transition.nextState,
      workflowUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      [`stateTimestamps.${transition.nextState}`]: admin.firestore.FieldValue.serverTimestamp(),
      ...transition.update,
    }, {merge: true});

    transitioned += 1;
    summaries.push({
      eventId: eventDoc.id,
      from: currentState,
      to: transition.nextState,
      reason: transition.reason,
    });
  }

  return {
    scanned: eventsSnapshot.size,
    transitioned,
    summaries,
  };
}

function sanitizeScreeningDateTime(screeningDateTimeInput) {
  const normalizedDateTime = String(screeningDateTimeInput || "").trim();
  if (!normalizedDateTime) {
    throw new HttpsError("invalid-argument", "screeningDateTime is required.");
  }

  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
  if (!isoPattern.test(normalizedDateTime)) {
    throw new HttpsError("invalid-argument", "screeningDateTime must look like YYYY-MM-DDTHH:mm.");
  }

  const parsedDate = new Date(normalizedDateTime);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new HttpsError("invalid-argument", "screeningDateTime is invalid.");
  }

  return normalizedDateTime.length === 16 ? `${normalizedDateTime}:00` : normalizedDateTime;
}

function buildScreeningLabel(screeningDateTime) {
  const [datePart, timePart] = String(screeningDateTime).split("T");
  const [, month, day] = datePart.split("-");
  const [hoursRaw, minutes] = timePart.split(":");
  const hours = Number(hoursRaw);
  const suffix = hours >= 12 ? "pm" : "am";
  const displayHour = hours % 12 || 12;
  return `${Number(month)}/${Number(day)} @ ${displayHour}:${minutes}${suffix}`;
}

function buildShowtimeFirestoreId(screeningDateTime) {
  const [datePart, timePart] = String(screeningDateTime).split("T");
  const compactTime = timePart.slice(0, 5).replace(":", "");
  return `np-${datePart}-${compactTime}`;
}

function buildVoteWindowLabel(voteStatus) {
  if (voteStatus === "live") return "Voting now";
  if (voteStatus === "ended") return "Voting ended";
  return "Voting opens soon";
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

async function runNightlyEliminationForEvent(eventId, {manual = false} = {}) {
  const eventRef = db.collection("events").doc(eventId);

  const eliminationResult = await db.runTransaction(async (transaction) => {
    // 1. All reads first
    const eventDoc = await transaction.get(eventRef);
    const eventData = eventDoc.exists ? (eventDoc.data() || {}) : {};
    // Auto/nightly eliminations are disabled. Only manual button-triggered rounds should run.
    if (!manual) {
      return {
        status: "auto-disabled",
        eventId,
      };
    }

    if (!manual && !isEliminationEnabledForEvent(eventId, eventData)) {
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

      const keyEmail = String(keyData.email || "").trim().toLowerCase();
      if (isLikelyRealEmail(keyEmail)) {
        emailsToNotify.add(keyEmail);
      }
    });

    emailKeysSnapshot.docs.forEach((doc) => {
      const keyData = doc.data() || {};
      const keyMovieTitle = String(keyData.movie_title || "");
      if (!eliminatedTitles.includes(keyMovieTitle)) {
        return;
      }

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

// Keep this export so an older deployed scheduled function with the same name is overwritten.
// It intentionally performs no eliminations.
exports.runNightlyElimination = onSchedule({
  schedule: ELIMINATION_SCHEDULE,
  timeZone: ELIMINATION_TIMEZONE,
}, async () => {
  logger.info("runNightlyElimination skipped: automatic eliminations are disabled.");
});

exports.processScreeningTransitions = onSchedule({
  schedule: SCREENING_WORKFLOW_SWEEP_SCHEDULE,
  timeZone: SCREENING_WORKFLOW_TIMEZONE,
}, async () => {
  const summary = await processScreeningTransitionsOnce();
  logger.info("processScreeningTransitions completed", summary);
  return summary;
});

exports.runEliminationRound = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const adminEmail = assertPrivilegedAdminEmail(request.data?.adminEmail, "run elimination rounds");

  const result = await runNightlyEliminationForEvent(eventId, {manual: true});

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

exports.revertLatestEliminationRound = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const adminEmail = assertPrivilegedAdminEmail(request.data?.adminEmail, "revert elimination rounds");

  const eventRef = db.collection("events").doc(eventId);
  const moviesRef = eventRef.collection("movies");
  const votesRef = eventRef.collection("votes");
  const voteKeysRef = eventRef.collection("voter_keys");
  const emailKeysRef = eventRef.collection("email_keys");

  const eventDoc = await eventRef.get();
  const eventData = eventDoc.exists ? (eventDoc.data() || {}) : {};
  const currentRound = Number(eventData.currentEliminationRound || 0);
  if (!Number.isFinite(currentRound) || currentRound <= 0) {
    throw new HttpsError("failed-precondition", "No elimination round exists to revert.");
  }

  const roundRef = eventRef.collection("elimination_rounds").doc(`round_${currentRound}`);
  const roundDoc = await roundRef.get();
  if (!roundDoc.exists) {
    throw new HttpsError("failed-precondition", `Elimination round ${currentRound} record was not found.`);
  }

  const roundData = roundDoc.data() || {};
  const eliminatedTitlesRaw = Array.isArray(roundData.eliminated_titles)
    ? roundData.eliminated_titles
    : [];
  const eliminatedTitles = Array.from(new Set(
    eliminatedTitlesRaw
      .map((title) => String(title || "").trim())
      .filter((title) => title.length > 0),
  ));

  if (eliminatedTitles.length === 0) {
    throw new HttpsError("failed-precondition", `Elimination round ${currentRound} has no movies to restore.`);
  }

  const normalizedEliminatedTitles = new Set(eliminatedTitles.map((title) => normalizeMovieTitle(title)));

  const [moviesSnapshot, votesSnapshot, voteKeysSnapshot, emailKeysSnapshot] = await Promise.all([
    moviesRef.get(),
    votesRef.get(),
    voteKeysRef.get(),
    emailKeysRef.get(),
  ]);

  const now = admin.firestore.FieldValue.serverTimestamp();
  const writer = db.bulkWriter();
  const writes = [];

  let restoredMovieCount = 0;
  moviesSnapshot.forEach((movieDoc) => {
    const movieData = movieDoc.data() || {};
    const movieTitle = String(movieData.movie_title || movieDoc.id || "").trim();
    const normalizedMovieTitle = normalizeMovieTitle(movieTitle);
    const wasEliminatedInRound = Number(movieData.eliminated_round || 0) === currentRound;
    if (!wasEliminatedInRound && !normalizedEliminatedTitles.has(normalizedMovieTitle)) {
      return;
    }

    restoredMovieCount += 1;
    writes.push(
      writer.set(movieDoc.ref, {
        eliminated: false,
        eliminated_round: admin.firestore.FieldValue.delete(),
        eliminated_at: admin.firestore.FieldValue.delete(),
        restored_at: now,
        updated_at: now,
      }, {merge: true}),
    );
  });

  let reactivatedVotes = 0;
  const normalizedVoteTitles = new Set();
  votesSnapshot.forEach((voteDoc) => {
    const voteData = voteDoc.data() || {};
    const normalizedPrimaryTitle = normalizeMovieTitle(voteData.movie_title || "");
    const normalizedBallotTitles = Array.isArray(voteData.movie_titles)
      ? voteData.movie_titles.map((title) => normalizeMovieTitle(title))
      : [];
    const matchedEliminatedTitle = normalizedEliminatedTitles.has(normalizedPrimaryTitle)
      || normalizedBallotTitles.some((title) => normalizedEliminatedTitles.has(title));

    if (!matchedEliminatedTitle || voteData.is_active !== false) {
      return;
    }

    reactivatedVotes += 1;
    writes.push(
      writer.set(voteDoc.ref, {
        is_active: true,
        eliminated: false,
        eliminated_at: admin.firestore.FieldValue.delete(),
        reactivated_at: now,
        updated_at: now,
      }, {merge: true}),
    );
  });

  let revertedVoteKeyCredits = 0;
  voteKeysSnapshot.forEach((voteKeyDoc) => {
    const voteKeyData = voteKeyDoc.data() || {};
    const keyTitle = normalizeMovieTitle(voteKeyData.lastEliminatedMovie || voteKeyData.movie_title || "");
    const currentCredits = Number(voteKeyData.reVoteCredits || 0);
    if (!normalizedEliminatedTitles.has(keyTitle) || currentCredits <= 0) {
      return;
    }

    revertedVoteKeyCredits += 1;
    writes.push(
      writer.set(voteKeyDoc.ref, {
        reVoteCredits: Math.max(0, currentCredits - 1),
        lastEliminatedMovie: admin.firestore.FieldValue.delete(),
        reVoteGrantedAt: admin.firestore.FieldValue.delete(),
        updated_at: now,
      }, {merge: true}),
    );
  });

  let revertedEmailKeyCredits = 0;
  emailKeysSnapshot.forEach((emailKeyDoc) => {
    const emailKeyData = emailKeyDoc.data() || {};
    const keyTitle = normalizeMovieTitle(emailKeyData.lastEliminatedMovie || emailKeyData.movie_title || "");
    const currentCredits = Number(emailKeyData.reVoteCredits || 0);
    if (!normalizedEliminatedTitles.has(keyTitle) || currentCredits <= 0) {
      return;
    }

    revertedEmailKeyCredits += 1;
    writes.push(
      writer.set(emailKeyDoc.ref, {
        reVoteCredits: Math.max(0, currentCredits - 1),
        lastEliminatedMovie: admin.firestore.FieldValue.delete(),
        reVoteGrantedAt: admin.firestore.FieldValue.delete(),
        updated_at: now,
      }, {merge: true}),
    );
  });

  const normalizedMovieToDocId = new Map();
  const normalizedLooseMovieToDocId = new Map();
  const normalizedCompactMovieToDocId = new Map();
  const countsByDocId = new Map();

  moviesSnapshot.forEach((movieDoc) => {
    const movieData = movieDoc.data() || {};
    const movieTitle = String(movieData.movie_title || movieDoc.id || "").trim();
    const normalizedMovie = normalizeMovieTitle(movieTitle);
    const normalizedLooseMovie = normalizeMovieTitleLoose(movieTitle);
    const normalizedCompactMovie = normalizeMovieTitleCompact(movieTitle);
    if (!normalizedMovieToDocId.has(normalizedMovie)) {
      normalizedMovieToDocId.set(normalizedMovie, movieDoc.id);
    }
    if (normalizedLooseMovie && !normalizedLooseMovieToDocId.has(normalizedLooseMovie)) {
      normalizedLooseMovieToDocId.set(normalizedLooseMovie, movieDoc.id);
    }
    if (normalizedCompactMovie && !normalizedCompactMovieToDocId.has(normalizedCompactMovie)) {
      normalizedCompactMovieToDocId.set(normalizedCompactMovie, movieDoc.id);
    }
    countsByDocId.set(movieDoc.id, 0);
  });

  let activeVoteCount = 0;
  let matchedVoteCount = 0;
  const unmatchedTitles = new Set();

  votesSnapshot.forEach((voteDoc) => {
    const voteData = voteDoc.data() || {};
    const isInactiveBeforeRevert = voteData.is_active === false;
    const normalizedPrimaryTitle = normalizeMovieTitle(voteData.movie_title || "");
    const normalizedBallotTitles = Array.isArray(voteData.movie_titles)
      ? voteData.movie_titles.map((title) => normalizeMovieTitle(title))
      : [];
    const becameActiveBecauseOfRevert = isInactiveBeforeRevert && (
      normalizedEliminatedTitles.has(normalizedPrimaryTitle)
      || normalizedBallotTitles.some((title) => normalizedEliminatedTitles.has(title))
    );
    const isActiveAfterRevert = voteData.is_active !== false || becameActiveBecauseOfRevert;
    if (!isActiveAfterRevert) {
      return;
    }

    activeVoteCount += 1;

    const votedTitle = String(
      voteData.movie_title ||
      (Array.isArray(voteData.movie_titles) && voteData.movie_titles.length ? voteData.movie_titles[0] : ""),
    ).trim();
    if (!votedTitle) {
      return;
    }

    const normalizedVoteTitle = normalizeMovieTitle(votedTitle);
    const normalizedLooseVoteTitle = normalizeMovieTitleLoose(votedTitle);
    const normalizedCompactVoteTitle = normalizeMovieTitleCompact(votedTitle);
    const movieDocId = normalizedMovieToDocId.get(normalizedVoteTitle)
      || normalizedLooseMovieToDocId.get(normalizedLooseVoteTitle)
      || normalizedCompactMovieToDocId.get(normalizedCompactVoteTitle);

    if (!movieDocId) {
      unmatchedTitles.add(votedTitle);
      return;
    }

    countsByDocId.set(movieDocId, Number(countsByDocId.get(movieDocId) || 0) + 1);
    matchedVoteCount += 1;
  });

  countsByDocId.forEach((voteCount, movieDocId) => {
    writes.push(
      writer.set(moviesRef.doc(movieDocId), {
        vote_count: voteCount,
        updated_at: now,
      }, {merge: true}),
    );
  });

  writes.push(
    writer.set(eventRef, {
      currentEliminationRound: Math.max(0, currentRound - 1),
      lastEliminatedTitles: admin.firestore.FieldValue.delete(),
      lastEliminationAt: admin.firestore.FieldValue.delete(),
      updated_at: now,
      updated_by: adminEmail,
    }, {merge: true}),
  );

  writes.push(writer.delete(roundRef));

  await Promise.all(writes);
  await writer.close();

  logger.info("Admin reverted latest elimination round", {
    eventId,
    adminEmail,
    revertedRound: currentRound,
    restoredMovieCount,
    reactivatedVotes,
    revertedVoteKeyCredits,
    revertedEmailKeyCredits,
    activeVoteCount,
    matchedVoteCount,
    unmatchedTitleCount: unmatchedTitles.size,
  });

  return {
    ok: true,
    eventId,
    revertedRound: currentRound,
    restoredMovieCount,
    reactivatedVotes,
    revertedVoteKeyCredits,
    revertedEmailKeyCredits,
    activeVoteCount,
    matchedVoteCount,
    unmatchedTitleCount: unmatchedTitles.size,
    unmatchedTitles: Array.from(unmatchedTitles).slice(0, 20),
  };
});

exports.saveEventAdminSettings = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const adminEmail = assertAdminEmail(request.data?.adminEmail);
  const movieTitles = sanitizeMovieTitles(request.data?.movieTitles);

  if (typeof request.data?.requireEmail !== "boolean") {
    throw new HttpsError("invalid-argument", "requireEmail must be a boolean.");
  }
  const requireEmail = request.data.requireEmail;

  const eventRef = db.collection("events").doc(eventId);
  const moviesRef = eventRef.collection("movies");
  const snapshot = await moviesRef.get();

  const existingById = new Map();
  snapshot.forEach((movieDoc) => {
    existingById.set(movieDoc.id, movieDoc.data() || {});
  });

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  batch.set(eventRef, {
    requireEmail,
    updated_at: now,
    updated_by: adminEmail,
  }, {merge: true});

  const newIds = new Set();
  movieTitles.forEach((title) => {
    const docId = movieDocId(title);
    newIds.add(docId);
    const existing = existingById.get(docId) || {};

    batch.set(moviesRef.doc(docId), {
      event_id: eventId,
      movie_title: title,
      vote_count: Number(existing.vote_count || 0),
      created_at: existing.created_at || now,
      updated_at: now,
    });
  });

  let deletedMovieCount = 0;
  existingById.forEach((_, oldId) => {
    if (!newIds.has(oldId)) {
      deletedMovieCount += 1;
      batch.delete(moviesRef.doc(oldId));
    }
  });

  await batch.commit();

  logger.info("Admin event settings saved", {
    eventId,
    adminEmail,
    movieCount: movieTitles.length,
    deletedMovieCount,
    requireEmail,
  });

  return {
    ok: true,
    eventId,
    movieCount: movieTitles.length,
    deletedMovieCount,
    requireEmail,
  };
});

exports.createEventShowtime = onCall(async (request) => {
  const adminEmail = assertAdminEmail(request.data?.adminEmail);
  const screeningDateTime = sanitizeScreeningDateTime(request.data?.screeningDateTime);
  const voteStatus = sanitizeVoteStatus(request.data?.voteStatus);
  const requireEmail = request.data?.requireEmail !== false;
  const movieTitles = sanitizeOptionalMovieTitles(request.data?.movieTitles);

  const eventId = buildShowtimeFirestoreId(screeningDateTime);
  const screeningLabel = buildScreeningLabel(screeningDateTime);
  const voteWindowLabel = buildVoteWindowLabel(voteStatus);
  const eventRef = db.collection("events").doc(eventId);
  const eventDoc = await eventRef.get();
  const initialWorkflowFields = buildInitialWorkflowFields(voteStatus);

  if (eventDoc.exists) {
    throw new HttpsError("already-exists", `A showtime already exists for ${screeningLabel}.`);
  }

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  batch.set(eventRef, {
    screeningLabel,
    screeningDateTime,
    voteStatus,
    voteWindowLabel,
    ...initialWorkflowFields,
    requireEmail,
    updated_at: now,
    updated_by: adminEmail,
    created_at: now,
    created_by: adminEmail,
  }, {merge: true});

  movieTitles.forEach((title) => {
    const movieRef = eventRef.collection("movies").doc(movieDocId(title));
    batch.set(movieRef, {
      event_id: eventId,
      movie_title: title,
      vote_count: 0,
      created_at: now,
      updated_at: now,
    });
  });

  await batch.commit();

  logger.info("Admin created showtime", {
    eventId,
    adminEmail,
    screeningDateTime,
    voteStatus,
    requireEmail,
    movieCount: movieTitles.length,
  });

  return {
    ok: true,
    eventId,
    event: {
      id: eventId,
      firestoreEventId: eventId,
      screeningLabel,
      screeningDateTime,
      voteStatus,
      voteWindowLabel,
      requireEmail,
      allowedMovies: movieTitles,
    },
  };
});

exports.deleteEventShowtime = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const adminEmail = assertAdminEmail(request.data?.adminEmail);

  const eventRef = db.collection("events").doc(eventId);
  const eventDoc = await eventRef.get();
  if (!eventDoc.exists) {
    throw new HttpsError("not-found", "That showtime no longer exists.");
  }

  const subcollections = await eventRef.listCollections();
  let deletedSubcollectionDocCount = 0;

  for (const subcollectionRef of subcollections) {
    const deletedCount = await deleteCollectionDocuments(subcollectionRef);
    deletedSubcollectionDocCount += deletedCount;
  }

  await eventRef.delete();

  logger.info("Admin deleted showtime", {
    eventId,
    adminEmail,
    deletedSubcollectionCount: subcollections.length,
    deletedSubcollectionDocCount,
  });

  return {
    ok: true,
    eventId,
    deletedSubcollectionCount: subcollections.length,
    deletedSubcollectionDocCount,
  };
});

exports.setEventVoteStatus = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const adminEmail = assertAdminEmail(request.data?.adminEmail);
  const voteStatus = String(request.data?.voteStatus || "").trim().toLowerCase();

  if (!["live", "ended"].includes(voteStatus)) {
    throw new HttpsError("invalid-argument", "voteStatus must be 'live' or 'ended'.");
  }

  const eventRef = db.collection("events").doc(eventId);
  const eventDoc = await eventRef.get();
  const currentVoteStatus = sanitizeVoteStatus(eventDoc.data()?.voteStatus);
  const isReopenRequest = currentVoteStatus === "ended" && voteStatus === "live";
  if (isReopenRequest && adminEmail !== PRIVILEGED_ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", `Only ${PRIVILEGED_ADMIN_EMAIL} can reopen votes.`);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();

  await eventRef.set({
    voteStatus,
    workflowStatus: voteStatus === "ended" ? WORKFLOW_STATUS.LICENSING : WORKFLOW_STATUS.VOTING,
    workflowUpdatedAt: now,
    [`stateTimestamps.${voteStatus === "ended" ? WORKFLOW_STATUS.LICENSING : WORKFLOW_STATUS.VOTING}`]: now,
    voteWindowLabel: buildVoteWindowLabel(voteStatus),
    ...(voteStatus === "live" ? {voteStartedAt: new Date(), voteEndsAt: addDays(new Date(), 7)} : {}),
    updated_at: now,
    updated_by: adminEmail,
  }, {merge: true});

  logger.info("Admin updated vote status", {
    eventId,
    adminEmail,
    voteStatus,
  });

  return {
    ok: true,
    eventId,
    voteStatus,
  };
});

exports.getEventVoteStats = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const adminEmail = assertAdminEmail(request.data?.adminEmail);

  const votesSnapshot = await db.collection("events").doc(eventId).collection("votes").get();
  let totalVotes = 0;
  const uniquePeople = new Set();

  votesSnapshot.forEach((voteDoc) => {
    const voteData = voteDoc.data() || {};
    if (voteData.is_active === false) {
      return;
    }

    totalVotes += 1;

    const normalizedEmail = normalizeEmail(voteData.email || "");
    const clientHash = String(voteData.client_id_hash || "").trim();
    const ipHash = String(voteData.ip_hash || "").trim();
    const ballotId = String(voteData.ballot_id || "").trim();
    const personKey = normalizedEmail || clientHash || ipHash || ballotId || voteDoc.id;

    uniquePeople.add(personKey);
  });

  logger.info("Admin requested event vote stats", {
    eventId,
    adminEmail,
    totalVotes,
    totalPeople: uniquePeople.size,
  });

  return {
    ok: true,
    eventId,
    totalVotes,
    totalPeople: uniquePeople.size,
  };
});

exports.rebuildEventMovieVoteCounts = onCall(async (request) => {
  const eventId = sanitizeEventId(request.data?.eventId);
  const adminEmail = assertPrivilegedAdminEmail(request.data?.adminEmail, "rebuild vote counts");

  const eventRef = db.collection("events").doc(eventId);
  const moviesRef = eventRef.collection("movies");
  const votesRef = eventRef.collection("votes");

  const [moviesSnapshot, votesSnapshot] = await Promise.all([
    moviesRef.get(),
    votesRef.get(),
  ]);

  if (moviesSnapshot.empty) {
    throw new HttpsError("failed-precondition", "No movies exist for this event.");
  }

  const normalizedMovieToDocId = new Map();
  const normalizedLooseMovieToDocId = new Map();
  const normalizedCompactMovieToDocId = new Map();
  const countsByDocId = new Map();

  moviesSnapshot.forEach((movieDoc) => {
    const movieData = movieDoc.data() || {};
    const movieTitle = String(movieData.movie_title || movieDoc.id || "").trim();
    const normalizedMovie = normalizeMovieTitle(movieTitle);
    const normalizedLooseMovie = normalizeMovieTitleLoose(movieTitle);
    const normalizedCompactMovie = normalizeMovieTitleCompact(movieTitle);
    if (!normalizedMovieToDocId.has(normalizedMovie)) {
      normalizedMovieToDocId.set(normalizedMovie, movieDoc.id);
    }
    if (normalizedLooseMovie && !normalizedLooseMovieToDocId.has(normalizedLooseMovie)) {
      normalizedLooseMovieToDocId.set(normalizedLooseMovie, movieDoc.id);
    }
    if (normalizedCompactMovie && !normalizedCompactMovieToDocId.has(normalizedCompactMovie)) {
      normalizedCompactMovieToDocId.set(normalizedCompactMovie, movieDoc.id);
    }
    countsByDocId.set(movieDoc.id, 0);
  });

  let activeVoteCount = 0;
  let matchedVoteCount = 0;
  const unmatchedTitles = new Set();

  const tallyVotes = (includeInactiveVotes = false) => {
    let tallyActiveVoteCount = 0;
    let tallyMatchedVoteCount = 0;
    const tallyUnmatchedTitles = new Set();
    const localCounts = new Map();

    countsByDocId.forEach((_, movieDocId) => {
      localCounts.set(movieDocId, 0);
    });

    votesSnapshot.forEach((voteDoc) => {
      const voteData = voteDoc.data() || {};
      const isInactive = voteData.is_active === false;
      if (isInactive && !includeInactiveVotes) {
        return;
      }

      tallyActiveVoteCount += 1;

      const votedTitle = String(
        voteData.movie_title ||
        (Array.isArray(voteData.movie_titles) && voteData.movie_titles.length ? voteData.movie_titles[0] : ""),
      ).trim();

      if (!votedTitle) {
        return;
      }

      const normalizedVoteTitle = normalizeVoteTitleForMatching(votedTitle);
      const normalizedLooseVoteTitle = normalizeMovieTitleLoose(normalizedVoteTitle);
      const normalizedCompactVoteTitle = normalizeMovieTitleCompact(normalizedVoteTitle);
      const movieDocId = normalizedMovieToDocId.get(normalizedVoteTitle)
        || normalizedLooseMovieToDocId.get(normalizedLooseVoteTitle)
        || normalizedCompactMovieToDocId.get(normalizedCompactVoteTitle);

      if (!movieDocId) {
        tallyUnmatchedTitles.add(votedTitle);
        return;
      }

      localCounts.set(movieDocId, Number(localCounts.get(movieDocId) || 0) + 1);
      tallyMatchedVoteCount += 1;
    });

    return {
      counts: localCounts,
      activeVoteCount: tallyActiveVoteCount,
      matchedVoteCount: tallyMatchedVoteCount,
      unmatchedTitles: tallyUnmatchedTitles,
    };
  };

  let usedInactiveFallback = false;
  let tally = tallyVotes(false);
  if (tally.activeVoteCount === 0 && !votesSnapshot.empty) {
    const fallbackTally = tallyVotes(true);
    if (fallbackTally.matchedVoteCount > 0) {
      tally = fallbackTally;
      usedInactiveFallback = true;
    }
  }

  activeVoteCount = tally.activeVoteCount;
  matchedVoteCount = tally.matchedVoteCount;
  tally.unmatchedTitles.forEach((title) => unmatchedTitles.add(title));
  tally.counts.forEach((count, movieDocId) => {
    countsByDocId.set(movieDocId, count);
  });

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  countsByDocId.forEach((voteCount, movieDocId) => {
    batch.set(moviesRef.doc(movieDocId), {
      vote_count: voteCount,
      updated_at: now,
    }, {merge: true});
  });

  batch.set(eventRef, {
    updated_at: now,
    updated_by: adminEmail,
  }, {merge: true});

  await batch.commit();

  logger.info("Admin rebuilt movie vote counts", {
    eventId,
    adminEmail,
    movieCount: countsByDocId.size,
    activeVoteCount,
    matchedVoteCount,
    unmatchedTitleCount: unmatchedTitles.size,
    usedInactiveFallback,
  });

  return {
    ok: true,
    eventId,
    movieCount: countsByDocId.size,
    activeVoteCount,
    matchedVoteCount,
    unmatchedTitles: Array.from(unmatchedTitles).slice(0, 20),
    unmatchedTitleCount: unmatchedTitles.size,
    usedInactiveFallback,
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
  const email = sanitizeOptionalEmail(request.data?.email);
  await verifyCaptchaToken(request, request.data?.captchaToken);
  const {clientIdHash, voteKeyRef} = buildVoteLookup(eventId, clientId);
  const emailHash = email ? hashValue(email) : null;
  const ipHash = hashValue(`${eventId}:${getRequesterIp(request)}`);
  const eventRef = db.collection("events").doc(eventId);
  const votesRef = eventRef.collection("votes");
  const rateLimitRef = eventRef.collection("rate_limits").doc(ipHash);
  const emailKeyRef = email ? eventRef.collection("email_keys").doc(email) : null;
  const legacyEmailKeyRef = emailHash ? eventRef.collection("email_keys").doc(emailHash) : null;
  const allowedMovieLookup = getAllowedMovieLookupForEvent(eventId);
  const requestedMovieRefs = requestedMovieTitles.map((requestedMovieTitle) => ({
    requestedMovieTitle,
    movieRef: eventRef.collection("movies").doc(movieDocId(requestedMovieTitle)),
    legacyMovieRef: eventRef.collection("movies").doc(requestedMovieTitle),
  }));

  return db.runTransaction(async (transaction) => {
    const eventDoc = await transaction.get(eventRef);
    const eventData = eventDoc.exists ? (eventDoc.data() || {}) : {};
    const eventVoteStatus = String(eventData.voteStatus || "").trim().toLowerCase();

    if (eventVoteStatus === "ended") {
      throw new HttpsError("failed-precondition", "Voting has ended for this event.");
    }

    const requiresEmail = requiresEmailForEvent(eventId, eventData);
    if (requiresEmail && !email) {
      throw new HttpsError("invalid-argument", "A valid email is required.");
    }

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

      const canonicalMovieTitleFromAllowList = allowedMovieLookup.get(normalizeMovieTitle(requested.requestedMovieTitle)) || "";
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

async function handleEmailSignup(request) {
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
}

exports.addEmailSignup = onCall(async (request) => handleEmailSignup(request));

// Backward-compatible alias for older clients.
exports.submitEmailSignup = onCall(async (request) => handleEmailSignup(request));

function sanitizeTextField(value, {required = false, maxLength = 500} = {}) {
  const text = String(value || "").trim();
  if (!text) {
    if (required) {
      throw new HttpsError("invalid-argument", "Missing required field.");
    }
    return "";
  }
  return text.slice(0, maxLength);
}

exports.submitMovieSuggestion = onCall(async (request) => {
  const title = sanitizeTextField(request.data?.title, {required: true, maxLength: 200});
  const yearRaw = sanitizeTextField(request.data?.year, {maxLength: 4});
  const genre = sanitizeTextField(request.data?.genre, {maxLength: 80});
  const why = sanitizeTextField(request.data?.why, {required: true, maxLength: 1200});
  const link = sanitizeTextField(request.data?.link, {maxLength: 500});

  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? yearRaw : "";

  await db.collection("movie_suggestions").add({
    title,
    year,
    genre,
    why,
    link,
    status: "new",
    source: "web",
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info("Movie suggestion submitted", {title, genre});
  return {ok: true};
});

exports.submitTheaterPetition = onCall(async (request) => {
  const name = sanitizeTextField(request.data?.name, {required: true, maxLength: 120});
  const email = sanitizeEmail(request.data?.email);
  const theaterName = sanitizeTextField(request.data?.theaterName, {required: true, maxLength: 200});
  const city = sanitizeTextField(request.data?.city, {required: true, maxLength: 120});
  const message = sanitizeTextField(request.data?.message, {maxLength: 1200});

  const theaterEmail = sanitizeTextField(request.data?.theaterEmail, {maxLength: 320});
  const normalizedTheaterEmail = theaterEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(theaterEmail)
    ? theaterEmail.toLowerCase()
    : "";

  const payload = {
    name,
    email,
    theater_name: theaterName,
    city,
    message,
    status: "new",
    source: "web",
    admin_follow_up: {
      queued: true,
      owner: "",
    },
    theater_email: normalizedTheaterEmail,
    theater_email_status: normalizedTheaterEmail ? "pending" : "not-available",
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = await db.collection("theater_petitions").add(payload);

  logger.info("Theater petition submitted", {
    petitionId: docRef.id,
    theaterName,
    city,
    theaterEmailStatus: payload.theater_email_status,
  });

  return {
    ok: true,
    petitionId: docRef.id,
    emailedTheater: payload.theater_email_status === "pending",
  };
});

exports.joinMovieChatRoom = onCall(async (request) => {
  const movieTitle = sanitizeMovieTitle(request.data?.movieTitle);
  const roomCode = sanitizeRoomCode(request.data?.roomCode);
  const displayName = sanitizeTextField(request.data?.displayName, {maxLength: 40});
  const participantId = sanitizeParticipantId(request.data?.participantId);
  const threadId = buildMovieChatThreadId(movieTitle);

  const threadRef = db.collection("threads").doc(threadId);
  const memberRef = threadRef.collection("members").doc(participantId);

  await db.runTransaction(async (transaction) => {
    const threadDoc = await transaction.get(threadRef);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const roomCodeHash = hashValue(roomCode);

    if (!threadDoc.exists) {
      transaction.set(threadRef, {
        threadId,
        movieTitle,
        movieKey: buildMovieChatKey(movieTitle),
        roomCodeHash,
        codeRequired: true,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: participantId,
      });
    } else {
      const threadData = threadDoc.data() || {};
      const configuredRoomCodeHash = String(threadData.roomCodeHash || "").trim();

      if (!configuredRoomCodeHash) {
        throw new HttpsError(
          "failed-precondition",
          "Room code is not configured for this movie chat yet.",
        );
      }

      if (configuredRoomCodeHash !== roomCodeHash) {
        throw new HttpsError("permission-denied", "Incorrect room code.");
      }

      transaction.set(threadRef, {
        updatedAt: now,
      }, {merge: true});
    }

    transaction.set(memberRef, {
      participantId,
      movieTitle,
      displayName,
      joinedAt: now,
      updatedAt: now,
      verifiedByRoomCode: true,
    }, {merge: true});
  });

  return {
    ok: true,
    threadId,
    movieTitle,
  };
});

exports.sendMovieChatMessage = onCall(async (request) => {
  const threadId = sanitizeMovieChatThreadId(request.data?.threadId);
  const roomCode = sanitizeRoomCode(request.data?.roomCode);
  const participantId = sanitizeParticipantId(request.data?.participantId);
  const displayNameInput = sanitizeTextField(request.data?.displayName, {maxLength: 40});
  const text = sanitizeTextField(request.data?.text, {required: true, maxLength: 500});

  const threadRef = db.collection("threads").doc(threadId);
  const memberRef = threadRef.collection("members").doc(participantId);
  const messageRef = threadRef.collection("messages").doc();

  await db.runTransaction(async (transaction) => {
    const [threadDoc, memberDoc] = await Promise.all([
      transaction.get(threadRef),
      transaction.get(memberRef),
    ]);

    if (!threadDoc.exists) {
      throw new HttpsError("not-found", "Movie chat room not found.");
    }

    const threadData = threadDoc.data() || {};
    const configuredRoomCodeHash = String(threadData.roomCodeHash || "").trim();
    if (!configuredRoomCodeHash) {
      throw new HttpsError("failed-precondition", "Room code is not configured for this movie chat.");
    }
    if (configuredRoomCodeHash !== hashValue(roomCode)) {
      throw new HttpsError("permission-denied", "Incorrect room code.");
    }

    if (!memberDoc.exists) {
      throw new HttpsError("permission-denied", "Join the room with a valid code first.");
    }

    const memberData = memberDoc.data() || {};
    const nowMillis = Date.now();
    const lastSentAt = memberData.lastSentAt;
    if (
      lastSentAt &&
      typeof lastSentAt.toMillis === "function" &&
      nowMillis - lastSentAt.toMillis() < 1200
    ) {
      throw new HttpsError("resource-exhausted", "You are sending messages too quickly.");
    }

    const movieTitle = String(threadData.movieTitle || "").trim() || "Untitled movie";
    const movieKey = String(threadData.movieKey || "").trim() || buildMovieChatKey(movieTitle);
    const displayName =
      displayNameInput ||
      sanitizeTextField(memberData.displayName, {maxLength: 40}) ||
      "Guest";
    const now = admin.firestore.FieldValue.serverTimestamp();

    transaction.set(messageRef, {
      threadId,
      movieTitle,
      movieKey,
      participantId,
      displayName,
      text,
      createdAt: now,
      createdAtClient: nowMillis,
    });

    transaction.set(threadRef, {
      updatedAt: now,
      lastMessageAt: now,
      lastMessagePreview: text.slice(0, 120),
      messageCount: Number(threadData.messageCount || 0) + 1,
    }, {merge: true});

    transaction.set(memberRef, {
      displayName,
      updatedAt: now,
      lastSentAt: now,
    }, {merge: true});
  });

  return {
    ok: true,
    threadId,
    messageId: messageRef.id,
  };
});

exports.reelSuccessListTheaters = onCall(REELSUCCESS_CALL_OPTIONS, async (request) => {
  await assertReelSuccessRequester(request);
  const {theaterIndex, metadata} = loadReelSuccessIndexData();

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

exports.publicListTheaters = onCall(async (request) => {
  const {theaterIndex, metadata} = loadReelSuccessIndexData();

  const query = normalizeSearchQuery(request.data?.query);
  const limit = sanitizePositiveInt(request.data?.limit, 25, 200);

  let filtered = theaterIndex;
  if (query) {
    filtered = theaterIndex.filter((row) => {
      const haystack = [
        row.theater_name,
        row.theater_city_state,
        row.theater_code,
        row.city,
        row.state_abbr,
        row.theater_key,
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

exports.reelSuccessGetTheaterInsights = onCall(REELSUCCESS_CALL_OPTIONS, async (request) => {
  await assertReelSuccessRequester(request);
  const {theaterIndex, metadata} = loadReelSuccessIndexData();
  const {theaterInsightsByKey} = loadReelSuccessInsightsData();
  const theaterKey = sanitizeTheaterKey(request.data?.theaterKey);

  const insights = theaterInsightsByKey[theaterKey] || null;
  if (insights) {
    return {
      ok: true,
      dataVersion: metadata?.created_at || null,
      ...insights,
    };
  }

  const profile = theaterIndex.find((row) => row.theater_key === theaterKey) || null;
  if (!profile) {
    throw new HttpsError("not-found", "No ReelSuccess insights found for theaterKey.");
  }

  return {
    ok: true,
    dataVersion: metadata?.created_at || null,
    profile,
    similar_theaters: [],
    recommendations: [],
    recommendations_by_score: null,
    based_on_similar_theaters: 0,
  };
});

exports.reelSuccessGetMyTheater = onCall(REELSUCCESS_CALL_OPTIONS, async (request) => {
  const requester = await assertReelSuccessRequester(request);
  const adminEmail = requester.email;
  const accessData = requester.accessData || await getReelSuccessAccessData(adminEmail);
  const {theaterIndex, metadata} = loadReelSuccessIndexData();

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
  const role = normalizeAccessRole(request.data?.role || "theater_user");

  if (!targetEmail || !targetEmail.includes("@")) {
    throw new HttpsError("invalid-argument", "Valid targetEmail is required.");
  }

  if (role === "none") {
    throw new HttpsError("invalid-argument", "role must be super_admin or theater_user.");
  }

  const theaterKey = theaterKeyInput ? sanitizeTheaterKey(theaterKeyInput) : "";
  const theaterId = theaterKey ? toTheaterId(theaterKey) : "";
  if (role === "theater_user" && !theaterId) {
    throw new HttpsError("invalid-argument", "theaterKey is required for theater_user.");
  }

  const accessRef = db.collection("reelsuccess_access").doc("users").collection("allowed").doc(targetEmail);
  const payload = {
    email: targetEmail,
    enabled,
    active: enabled,
    role,
    theater_id: role === "theater_user" ? theaterId : admin.firestore.FieldValue.delete(),
    updated_by: adminEmail,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (theaterKeyInput !== undefined) {
    payload.theater_key = theaterKey || admin.firestore.FieldValue.delete();
  }

  await accessRef.set(payload, {merge: true});

  const theaterUsersPayload = {
    email: targetEmail,
    role,
    active: enabled,
    updated_by: adminEmail,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (role === "theater_user") {
    theaterUsersPayload.theaterKey = theaterKey;
    theaterUsersPayload.theaterId = theaterId;
  }

  await db.collection("theaterUsers").doc(targetEmail).set(theaterUsersPayload, {merge: true});

  return {
    ok: true,
    targetEmail,
    enabled,
    role,
    theaterKey: role === "theater_user" ? theaterKey : null,
    theaterId: role === "theater_user" ? theaterId : null,
  };
});

exports.reelSuccessSetUserClaims = onCall(async (request) => {
  const actor = await assertReelSuccessRequester(request);
  if (!actor.isAdmin) {
    throw new HttpsError("permission-denied", "Only admins can set user claims.");
  }

  const targetEmail = normalizeEmail(request.data?.targetEmail);
  if (!targetEmail || !targetEmail.includes("@")) {
    throw new HttpsError("invalid-argument", "Valid targetEmail is required.");
  }

  const role = normalizeAccessRole(request.data?.role || "theater_user");
  if (role === "none") {
    throw new HttpsError("invalid-argument", "role must be super_admin or theater_user.");
  }

  const theaterKeyInput = String(request.data?.theaterKey || "").trim();
  const theaterIdInput = String(request.data?.theaterId || "").trim();
  const theaterId = role === "theater_user"
    ? (theaterIdInput || (theaterKeyInput ? toTheaterId(theaterKeyInput) : ""))
    : "";

  if (role === "theater_user" && !theaterId) {
    throw new HttpsError("invalid-argument", "theaterId or theaterKey is required for theater users.");
  }

  const userRecord = await admin.auth().getUserByEmail(targetEmail);
  const existingClaims = userRecord.customClaims || {};
  const updatedClaims = {
    ...existingClaims,
    role,
    admin: role === "super_admin",
  };

  if (role === "theater_user") {
    updatedClaims.theaterId = theaterId;
    if (theaterKeyInput) {
      updatedClaims.theaterKey = theaterKeyInput;
    }
  } else {
    delete updatedClaims.theaterId;
    delete updatedClaims.theaterKey;
  }

  await admin.auth().setCustomUserClaims(userRecord.uid, updatedClaims);

  return {
    ok: true,
    uid: userRecord.uid,
    email: targetEmail,
    claims: updatedClaims,
  };
});

exports.reelSuccessSyncAccess = onCall(async (request) => {
  const uid = request.auth?.uid || null;
  const email = normalizeEmail(request.auth?.token?.email);

  if (!uid || !email) {
    throw new HttpsError("unauthenticated", "Sign in is required.");
  }

  const userRecord = await admin.auth().getUser(uid);
  const existingClaims = userRecord.customClaims || {};
  const accessData = await getReelSuccessAccessData(email);

  if (!ADMIN_EMAILS.has(email) && (!accessData || accessData.enabled === false)) {
    throw new HttpsError(
      "permission-denied",
      "This account is not enabled for ReelSuccess yet. Ask an admin to grant access.",
    );
  }

  const nextClaims = buildReelSuccessClaims({
    email,
    accessData,
    existingClaims,
  });

  await admin.auth().setCustomUserClaims(uid, nextClaims);

  return {
    ok: true,
    email,
    role: nextClaims.role,
    theaterId: nextClaims.theaterId || null,
    theaterKey: nextClaims.theaterKey || null,
    claims: nextClaims,
  };
});

exports.reelSuccessProvisionMyClaims = onCall(async (request) => {
  const uid = request.auth?.uid || null;
  const email = normalizeEmail(request.auth?.token?.email);

  if (!uid || !email) {
    throw new HttpsError("unauthenticated", "Sign in is required.");
  }

  const userRecord = await admin.auth().getUser(uid);
  const existingClaims = userRecord.customClaims || {};
  const accessData = await getReelSuccessAccessData(email);
  if (!ADMIN_EMAILS.has(email) && (!accessData || accessData.enabled === false)) {
    throw new HttpsError(
      "permission-denied",
      "This account is not enabled for ReelSuccess yet. Ask an admin to grant access.",
    );
  }

  const nextClaims = buildReelSuccessClaims({
    email,
    accessData,
    existingClaims,
  });

  await admin.auth().setCustomUserClaims(uid, nextClaims);

  return {
    ok: true,
    email,
    claims: nextClaims,
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

exports.reelSuccessCreateGrossUploadSession = onCall(REELSUCCESS_CALL_OPTIONS, async (request) => {
  const requester = await assertReelSuccessRequester(request);
  const {theaterKey, theaterId} = assertTheaterScope(requester, request.data?.theaterKey);
  const {theaterIndex} = loadReelSuccessIndexData();
  const theater = theaterIndex.find((row) => row.theater_key === theaterKey) || null;
  if (!theater) {
    throw new HttpsError("not-found", "Selected theater was not found in ReelSuccess index.");
  }
  const businessDate = sanitizeBusinessDate(request.data?.businessDate);
  const fileName = sanitizePdfFileName(request.data?.fileName);
  const contentType = String(request.data?.contentType || "").trim().toLowerCase();
  const size = Number(request.data?.size || 0);

  if (contentType && contentType !== "application/pdf") {
    throw new HttpsError("invalid-argument", "Only PDF content type is allowed.");
  }

  const MAX_SIZE_BYTES = 15 * 1024 * 1024;
  if (!Number.isFinite(size) || size <= 0 || size > MAX_SIZE_BYTES) {
    throw new HttpsError("invalid-argument", "File size must be between 1 byte and 15 MB.");
  }

  const timestamp = Date.now();
  const storagePath = `box-office-grosses/${theaterId}/${businessDate}/${timestamp}_${fileName}`;

  return {
    ok: true,
    theaterKey,
    theaterId,
    theaterName: theater.theater_name || null,
    theaterCityState: theater.theater_city_state || null,
    businessDate,
    storagePath,
    maxSizeBytes: MAX_SIZE_BYTES,
  };
});

exports.reelSuccessFinalizeGrossUpload = onCall(REELSUCCESS_CALL_OPTIONS, async (request) => {
  const requester = await assertReelSuccessRequester(request);
  const {theaterKey, theaterId} = assertTheaterScope(requester, request.data?.theaterKey);
  const {theaterIndex} = loadReelSuccessIndexData();
  const theater = theaterIndex.find((row) => row.theater_key === theaterKey) || null;
  if (!theater) {
    throw new HttpsError("not-found", "Selected theater was not found in ReelSuccess index.");
  }
  const businessDate = sanitizeBusinessDate(request.data?.businessDate);
  const fileName = sanitizePdfFileName(request.data?.fileName);
  const storagePath = String(request.data?.storagePath || "").trim();

  if (!storagePath.startsWith(`box-office-grosses/${theaterId}/${businessDate}/`)) {
    throw new HttpsError("permission-denied", "storagePath does not match theater/date scope.");
  }
  if (!storagePath.toLowerCase().endsWith(".pdf")) {
    throw new HttpsError("invalid-argument", "storagePath must point to a PDF.");
  }

  const bucket = admin.storage().bucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new HttpsError("not-found", "Uploaded file not found in Storage.");
  }

  const [metadata] = await file.getMetadata();
  const contentType = String(metadata?.contentType || "").toLowerCase();
  if (contentType && contentType !== "application/pdf") {
    throw new HttpsError("failed-precondition", "Stored object is not a PDF.");
  }

  const uploadRef = db.collection("theaters").doc(theaterId).collection("grossUploads").doc();
  await uploadRef.set({
    theaterId,
    theaterKey,
    theaterName: theater.theater_name || null,
    theaterCityState: theater.theater_city_state || null,
    theaterCode: theater.theater_code || null,
    businessDate,
    fileName,
    storagePath,
    uploadedByUid: requester.uid || null,
    uploadedByEmail: requester.email || null,
    uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "uploaded",
  }, {merge: true});

  return {
    ok: true,
    uploadId: uploadRef.id,
    theaterId,
    storagePath,
  };
});

exports.reelSuccessDeleteGrossUpload = onCall(REELSUCCESS_CALL_OPTIONS, async (request) => {
  const requester = await assertReelSuccessRequester(request);
  const {theaterId} = assertTheaterScope(requester, request.data?.theaterKey);
  const uploadId = String(request.data?.uploadId || "").trim();

  if (!uploadId) {
    throw new HttpsError("invalid-argument", "uploadId is required.");
  }

  const uploadRef = db.collection("theaters").doc(theaterId).collection("grossUploads").doc(uploadId);
  const uploadDoc = await uploadRef.get();
  if (!uploadDoc.exists) {
    throw new HttpsError("not-found", "Upload not found.");
  }

  const data = uploadDoc.data() || {};
  const storagePath = String(data.storagePath || "").trim();
  if (!storagePath.startsWith(`box-office-grosses/${theaterId}/`)) {
    throw new HttpsError("permission-denied", "Upload path scope mismatch.");
  }

  const bucket = admin.storage().bucket();
  const file = bucket.file(storagePath);
  try {
    await file.delete({ignoreNotFound: true});
  } catch (error) {
    logger.warn("Failed deleting gross PDF from storage", {
      uploadId,
      theaterId,
      storagePath,
      error: error?.message || String(error),
    });
  }

  await uploadRef.set({
    status: "deleted",
    deletedAt: admin.firestore.FieldValue.serverTimestamp(),
    deletedByUid: requester.uid || null,
    deletedByEmail: requester.email || null,
  }, {merge: true});

  await uploadRef.delete();

  return {
    ok: true,
    uploadId,
  };
});

exports.reelSuccessListGrossStoragePdfs = onCall(REELSUCCESS_CALL_OPTIONS, async (request) => {
  const adminEmail = assertAdminEmail(request.data?.adminEmail);
  const requestedPrefix = String(request.data?.prefix || "").trim();
  const requestedTheaterId = String(request.data?.theaterId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

  let prefix = requestedPrefix;
  if (!prefix) {
    prefix = requestedTheaterId
      ? `box-office-grosses/${requestedTheaterId}/`
      : "box-office-grosses/";
  }

  if (!prefix.startsWith("box-office-grosses/")) {
    throw new HttpsError("invalid-argument", "prefix must start with box-office-grosses/.");
  }
  if (!prefix.endsWith("/")) {
    prefix = `${prefix}/`;
  }

  const maxResults = sanitizePositiveInt(request.data?.maxResults, 1000, 5000);
  const signedUrlHours = sanitizePositiveInt(request.data?.signedUrlHours, 12, 72);
  const includeSignedUrls = request.data?.includeSignedUrls !== false;

  const bucket = admin.storage().bucket();
  const files = [];

  let pageToken;
  do {
    const [batch, , response] = await bucket.getFiles({
      prefix,
      maxResults: Math.min(1000, maxResults - files.length),
      pageToken,
      autoPaginate: false,
    });

    files.push(...batch);
    pageToken = response?.nextPageToken;
  } while (pageToken && files.length < maxResults);

  const pdfFiles = files.filter((file) => String(file.name || "").toLowerCase().endsWith(".pdf"));
  const expiresMs = Date.now() + (signedUrlHours * 60 * 60 * 1000);

  const pdfs = await Promise.all(pdfFiles.map(async (file) => {
    const [metadata] = await file.getMetadata();

    const tokenString = String(metadata?.metadata?.firebaseStorageDownloadTokens || "").trim();
    const firstToken = tokenString ? tokenString.split(",")[0].trim() : "";
    const tokenDownloadUrl = firstToken
      ? `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(file.name)}?alt=media&token=${encodeURIComponent(firstToken)}`
      : null;

    let signedUrl = null;
    if (includeSignedUrls) {
      try {
        const [url] = await file.getSignedUrl({
          action: "read",
          expires: expiresMs,
          version: "v4",
        });
        signedUrl = url;
      } catch (error) {
        logger.warn("Unable to generate signed URL for gross PDF", {
          file: file.name,
          error: error?.message || String(error),
        });
      }
    }

    return {
      name: file.name,
      bucket: bucket.name,
      size: Number(metadata?.size || 0),
      updated: metadata?.updated || null,
      contentType: metadata?.contentType || null,
      tokenDownloadUrl,
      signedUrl,
    };
  }));

  pdfs.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

  logger.info("ReelSuccess gross storage PDF listing generated", {
    adminEmail,
    prefix,
    requestedTheaterId,
    returned: pdfs.length,
  });

  return {
    ok: true,
    prefix,
    count: pdfs.length,
    signedUrlHours,
    includeSignedUrls,
    pdfs,
  };
});

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });
