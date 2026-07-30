import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore, collection, getDocs, getDoc, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-functions.js";

// Firebase Config (same as main app)
const firebaseConfig = {
  apiKey: "AIzaSyDMa_twNQAZVrnLHUNNNsxk6aTa-9FrnSc",
  authDomain: "reelconvo.firebaseapp.com",
  projectId: "reelconvo",
  storageBucket: "reelconvo.firebasestorage.app",
  messagingSenderId: "913820455359",
  appId: "1:913820455359:web:1c75954a231b921b55510a"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const functions = getFunctions(app);
const runEliminationRoundCallable = httpsCallable(functions, "runEliminationRound");
const saveEventAdminSettingsCallable = httpsCallable(functions, "saveEventAdminSettings");
const createEventShowtimeCallable = httpsCallable(functions, "createEventShowtime");
const deleteEventShowtimeCallable = httpsCallable(functions, "deleteEventShowtime");
const updateEventShowtimeDateTimeCallable = httpsCallable(functions, "updateEventShowtimeDateTime");
const setEventVoteStatusCallable = httpsCallable(functions, "setEventVoteStatus");
const getEventVoteStatsCallable = httpsCallable(functions, "getEventVoteStats");
const rebuildEventMovieVoteCountsCallable = httpsCallable(functions, "rebuildEventMovieVoteCounts");
const reelSuccessSetAccessCallable = httpsCallable(functions, "reelSuccessSetAccess");
const reelSuccessListAccessCallable = httpsCallable(functions, "reelSuccessListAccess");

// Admin whitelist (normalized to lowercase)
const ADMIN_EMAILS = new Set([
  "rt332@cornell.edu",
  "moses@thenewparkway.com",
  "programming@thenewparkway.com",
  "nikki@thenewparkwaytheater.com"
]);
const PRIVILEGED_ADMIN_EMAIL = "rt332@cornell.edu";

// Alias map: date-based ID → Firestore event ID
const EVENT_ID_ALIASES = { "2026-04-27": "newparkway1" };

// Get event ID from URL parameters (default to first configured event)
const urlParams = new URLSearchParams(window.location.search);
const configuredEvents = (typeof window.REELVOTES_EVENTS !== 'undefined' ? window.REELVOTES_EVENTS : null) || [];
const urlEventId = urlParams.get("event");
const defaultConfiguredEvent = configuredEvents.find((event) => event.voteStatus === "live")
  || configuredEvents.find((event) => event.voteStatus !== "ended")
  || configuredEvents[0]
  || null;
let currentEventId = urlEventId
  ? (EVENT_ID_ALIASES[urlEventId] || configuredEvents.find(e => e.id === urlEventId)?.firestoreEventId || urlEventId)
  : (defaultConfiguredEvent?.firestoreEventId || defaultConfiguredEvent?.id || "newparkway1");

const eventLabel = document.getElementById("eventLabel");
const updatedAtEl = document.getElementById("updatedAt");
const adminIdentityEl = document.getElementById("adminIdentity");
const adminList = document.getElementById("adminList");
const ballotListEl = document.getElementById("ballotList");
const eventSelector = document.getElementById("eventSelector");
const publicPreviewLink = document.getElementById("publicPreviewLink");
const endVoteBtn = document.getElementById("endVoteBtn");
const runEliminationBtn = document.getElementById("runEliminationBtn");
const rebuildCountsBtn = document.getElementById("rebuildCountsBtn");
const voteControlStatusEl = document.getElementById("voteControlStatus");
const eliminationStatusEl = document.getElementById("eliminationStatus");
const rebuildCountsStatusEl = document.getElementById("rebuildCountsStatus");
const adminRequireEmailCheckbox = document.getElementById("adminRequireEmailCheckbox");
const adminMoviesInput = document.getElementById("adminMoviesInput");
const adminSaveBtn = document.getElementById("adminSaveBtn");
const adminSaveStatus = document.getElementById("adminSaveStatus");
const adminDeleteBtn = document.getElementById("adminDeleteBtn");
const adminDeleteStatus = document.getElementById("adminDeleteStatus");
const adminRescheduleDateInput = document.getElementById("adminRescheduleDate");
const adminRescheduleTimeInput = document.getElementById("adminRescheduleTime");
const adminRescheduleBtn = document.getElementById("adminRescheduleBtn");
const adminRescheduleStatus = document.getElementById("adminRescheduleStatus");
const adminCurrentDateTime = document.getElementById("adminCurrentDateTime");
const adminNewShowtimeDateInput = document.getElementById("adminNewShowtimeDate");
const adminNewShowtimeTimeInput = document.getElementById("adminNewShowtimeTime");
const adminNewVoteStatusSelect = document.getElementById("adminNewVoteStatus");
const adminNewRequireEmailCheckbox = document.getElementById("adminNewRequireEmailCheckbox");
const adminNewMoviesInput = document.getElementById("adminNewMoviesInput");
const adminCreateBtn = document.getElementById("adminCreateBtn");
const adminCreateStatus = document.getElementById("adminCreateStatus");
let currentAdminEmail = null;
let currentVoteStatus = "not-started";
let currentUniqueVoterCount = null;
let currentActiveVoteCount = null;
const TMDB_API_KEY = "05e2d906f097b769ba4d7e8c7305accf";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const adminMovieMetadataCache = new Map();

function buildPosterUrl(posterPath, size = "w185") {
  return posterPath ? `https://image.tmdb.org/t/p/${size}${posterPath}` : null;
}

async function searchTMDB(query) {
  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`
    );
    const data = await response.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch {
    return [];
  }
}

async function getMovieMetadataByTitle(title) {
  const normalized = String(title || "").trim();
  if (!normalized) return { poster: null, tmdbId: null };

  const cacheKey = normalized.toLowerCase();
  if (adminMovieMetadataCache.has(cacheKey)) {
    const cached = adminMovieMetadataCache.get(cacheKey);
    if (cached?.poster || cached?.tmdbId) {
      return cached;
    }
  }

  try {
    const results = await searchTMDB(normalized);
    const exact = results.find((row) => String(row?.title || "").trim().toLowerCase() === cacheKey) || null;
    const withPoster = results.find((row) => Boolean(row?.poster_path)) || null;
    const exactWithPoster = results.find((row) => String(row?.title || "").trim().toLowerCase() === cacheKey && row?.poster_path) || null;
    const match = exactWithPoster || withPoster || exact || results[0] || null;
    const metadata = {
      poster: buildPosterUrl(match?.poster_path, "w185"),
      tmdbId: match?.id || null,
    };
    if (metadata.poster || metadata.tmdbId) {
      adminMovieMetadataCache.set(cacheKey, metadata);
    }
    return metadata;
  } catch {
    return { poster: null, tmdbId: null };
  }
}

function normalizeVoteStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "live") return "live";
  if (status === "ended") return "ended";
  return "not-started";
}

function getEventSortTime(event) {
  const rawDateTime = String(event?.screeningDateTime || "").trim();
  const parsedDateTime = rawDateTime ? Date.parse(rawDateTime) : Number.NaN;
  if (Number.isFinite(parsedDateTime)) {
    return parsedDateTime;
  }

  const rawId = String(event?.id || event?.firestoreEventId || "").trim();
  const parsedId = rawId ? Date.parse(rawId) : Number.NaN;
  return Number.isFinite(parsedId) ? parsedId : Number.NEGATIVE_INFINITY;
}

function sortEventsByTime(events) {
  return [...events].sort((left, right) => getEventSortTime(left) - getEventSortTime(right));
}

// Populate event selector dropdown
function populateSelector() {
  if (!eventSelector) return;
  eventSelector.innerHTML = "";
  if (configuredEvents.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No showtimes available";
    eventSelector.appendChild(opt);
    return;
  }
  sortEventsByTime(configuredEvents).forEach(ev => {
    const opt = document.createElement("option");
    const resolvedId = EVENT_ID_ALIASES[ev.id] || ev.firestoreEventId || ev.id;
    opt.value = ev.id;
    opt.textContent = `${ev.screeningLabel || ev.id}${ev.voteStatus === 'ended' ? ' (ended)' : ev.voteStatus === 'live' ? ' (live)' : ''}`;
    if (resolvedId === currentEventId || ev.id === currentEventId || ev.id === (urlEventId || '')) opt.selected = true;
    eventSelector.appendChild(opt);
  });
}
populateSelector();

// Tab switching
const tabResultsBtn = document.getElementById("tabResultsBtn");
const tabEditBtn = document.getElementById("tabEditBtn");
const tabShowtimeBtn = document.getElementById("tabShowtimeBtn");
const tabResultsPanel = document.getElementById("tabResults");
const tabEditPanel = document.getElementById("tabEdit");
const tabShowtimePanel = document.getElementById("tabShowtime");

const accessTargetEmailInput = document.getElementById("accessTargetEmail");
const accessRoleSelect = document.getElementById("accessRoleSelect");
const accessActiveCheckbox = document.getElementById("accessActiveCheckbox");
const accessTheaterKeyWrap = document.getElementById("accessTheaterKeyWrap");
const accessTheaterKeyInput = document.getElementById("accessTheaterKeyInput");
const accessSaveBtn = document.getElementById("accessSaveBtn");
const accessRefreshBtn = document.getElementById("accessRefreshBtn");
const accessStatus = document.getElementById("accessStatus");
const accessListBody = document.getElementById("accessListBody");

function showTab(tab) {
  const onResults = tab === "results";
  const onEdit = tab === "edit";
  const onShowtime = tab === "showtime";
  if (tabResultsPanel) tabResultsPanel.style.display = onResults ? "" : "none";
  if (tabEditPanel) tabEditPanel.style.display = onEdit ? "" : "none";
  if (tabShowtimePanel) tabShowtimePanel.style.display = onShowtime ? "" : "none";
  if (tabResultsBtn) {
    tabResultsBtn.style.background = onResults ? "#ff4757" : "#222";
    tabResultsBtn.style.color = onResults ? "#fff" : "#aaa";
  }
  if (tabEditBtn) {
    tabEditBtn.style.background = onEdit ? "#ff4757" : "#222";
    tabEditBtn.style.color = onEdit ? "#fff" : "#aaa";
  }
  if (tabShowtimeBtn) {
    tabShowtimeBtn.style.background = onShowtime ? "#ff4757" : "#222";
    tabShowtimeBtn.style.color = onShowtime ? "#fff" : "#aaa";
  }
}

if (tabResultsBtn) tabResultsBtn.addEventListener("click", () => showTab("results"));
if (tabEditBtn) tabEditBtn.addEventListener("click", () => showTab("edit"));
if (tabShowtimeBtn) tabShowtimeBtn.addEventListener("click", () => showTab("showtime"));

// Start on results tab
showTab("results");
function updateEventLabel(firestoreId) {
  const event = resolveEvent(firestoreId);
  const label = event?.screeningLabel || event?.id || firestoreId;
  if (eventLabel) eventLabel.textContent = `Event: ${label}`;
  updatePublicPreviewLink();
}
updateEventLabel(currentEventId);

function getPublicPreviewEventId() {
  const selectedEventId = String(eventSelector?.value || "").trim();
  if (selectedEventId) {
    const selectedEvent = configuredEvents.find((item) => (
      item.id === selectedEventId
      || item.firestoreEventId === selectedEventId
      || (EVENT_ID_ALIASES[item.id] || item.firestoreEventId || item.id) === selectedEventId
    )) || null;
    return selectedEvent?.id || selectedEventId;
  }

  const event = resolveEvent(currentEventId);
  return event?.id || currentEventId;
}

function updatePublicPreviewLink() {
  if (!publicPreviewLink) return;
  const queryEventId = getPublicPreviewEventId();
  publicPreviewLink.href = `/?event=${encodeURIComponent(queryEventId)}`;
}

if (publicPreviewLink) {
  publicPreviewLink.addEventListener("click", () => {
    updatePublicPreviewLink();
  });
}

function buildEventIdCandidates(rawEventId) {
  const normalized = String(rawEventId || "").trim();
  const event = resolveEvent(normalized)
    || configuredEvents.find((item) => item.id === normalized || item.firestoreEventId === normalized)
    || null;

  return Array.from(new Set([
    normalized,
    EVENT_ID_ALIASES[normalized],
    event?.firestoreEventId,
    EVENT_ID_ALIASES[event?.id],
    event?.id,
  ].filter(Boolean)));
}

async function resolveEventDataId(rawEventId) {
  const candidates = buildEventIdCandidates(rawEventId);
  if (!candidates.length) {
    return rawEventId;
  }

  const scoredCandidates = [];

  for (const candidate of candidates) {
    try {
      const [eventDoc, moviesSnapshot, votesSnapshot] = await Promise.all([
        getDoc(doc(db, "events", candidate)),
        getDocs(collection(db, "events", candidate, "movies")),
        getDocs(collection(db, "events", candidate, "votes")),
      ]);

      const movieCount = moviesSnapshot.size;
      const voteCount = votesSnapshot.size;
      const score = (voteCount * 1000) + (movieCount * 10) + (eventDoc.exists() ? 1 : 0);

      scoredCandidates.push({ candidate, score, voteCount, movieCount, exists: eventDoc.exists() });
    } catch {
      scoredCandidates.push({ candidate, score: 0, voteCount: 0, movieCount: 0, exists: false });
    }
  }

  scoredCandidates.sort((a, b) => b.score - a.score);

  const best = scoredCandidates[0];
  if (best && best.score > 0) {
    return best.candidate;
  }

  return candidates[0] || rawEventId;
}

// Render ballot (allowed movies list)
function renderBallot(allowedMovies) {
  const ballotSection = ballotListEl ? ballotListEl.closest('.ballot-section') : null;
  if (!ballotListEl) return;
  ballotListEl.innerHTML = "";
  if (!allowedMovies || allowedMovies.length === 0) {
    // Hide only the dedicated ballot section when present.
    if (ballotSection) ballotSection.style.display = "none";
    return;
  }
  if (ballotSection) ballotSection.style.display = "";
  allowedMovies.forEach((title, i) => {
    const item = document.createElement("div");
    item.className = "chosen-movie";
    item.style.cssText = "display:flex;align-items:center;gap:10px;pointer-events:none;cursor:default;";
    item.innerHTML = `<span style="color:#aaa;font-size:13px;min-width:20px;">${i + 1}.</span><span>${title}</span>`;
    ballotListEl.appendChild(item);
  });
}

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

function setAdminIdentity(email) {
  if (!adminIdentityEl) return;
  adminIdentityEl.textContent = `Signed in as: ${email}`;
}

function setSaveStatus(message, isError = false) {
  if (!adminSaveStatus) return;
  adminSaveStatus.textContent = message;
  adminSaveStatus.style.color = isError ? "#ff6b6b" : "#bbb";
}

function setDeleteStatus(message, isError = false) {
  if (!adminDeleteStatus) return;
  adminDeleteStatus.textContent = message;
  adminDeleteStatus.style.color = isError ? "#ff6b6b" : "#bbb";
}

function setCreateStatus(message, isError = false) {
  if (!adminCreateStatus) return;
  adminCreateStatus.textContent = message;
  adminCreateStatus.style.color = isError ? "#ff6b6b" : "#bbb";
}

function setRescheduleStatus(message, isError = false) {
  if (!adminRescheduleStatus) return;
  adminRescheduleStatus.textContent = message;
  adminRescheduleStatus.style.color = isError ? "#ff6b6b" : "#bbb";
}

function formatScreeningDateTimeLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "—";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }
  return `${parsed.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })} @ ${parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function parseLocalDateTimeParts(screeningDateTime) {
  const raw = String(screeningDateTime || "").trim();
  if (!raw.includes("T")) {
    return { date: "", time: "" };
  }

  const [datePart, timePart] = raw.split("T");
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : "";
  const normalizedTime = String(timePart || "").slice(0, 5);
  const isValidTime = /^\d{2}:\d{2}$/.test(normalizedTime);

  return {
    date: normalizedDate,
    time: isValidTime ? normalizedTime : "",
  };
}

function collectMovieTitles(rawValue) {
  return Array.from(
    new Map(
      String(rawValue || "")
        .split("\n")
        .map((title) => title.trim())
        .filter(Boolean)
        .map((title) => [title.toLowerCase(), title]),
    ).values(),
  );
}

async function refreshConfiguredEventsFromFirestore() {
  const snapshot = await getDocs(collection(db, "events"));
  const mergedByFirestoreId = new Map();

  configuredEvents.forEach((event) => {
    const firestoreEventId = EVENT_ID_ALIASES[event.id] || event.firestoreEventId || event.id;
    mergedByFirestoreId.set(firestoreEventId, {...event, firestoreEventId});
  });

  snapshot.forEach((eventDoc) => {
    const eventData = eventDoc.data() || {};
    if (!eventData.screeningLabel && !eventData.screeningDateTime) {
      return;
    }

    const firestoreEventId = eventDoc.id;
    const existing = mergedByFirestoreId.get(firestoreEventId) || {};
    mergedByFirestoreId.set(firestoreEventId, {
      ...existing,
      id: existing.id || firestoreEventId,
      firestoreEventId,
      screeningLabel: eventData.screeningLabel || existing.screeningLabel || firestoreEventId,
      screeningDateTime: eventData.screeningDateTime || existing.screeningDateTime || "",
      voteStatus: String(eventData.voteStatus || existing.voteStatus || "not-started").trim().toLowerCase(),
      voteWindowLabel: eventData.voteWindowLabel || existing.voteWindowLabel || "",
      requireEmail: typeof eventData.requireEmail === "boolean" ? eventData.requireEmail : (existing.requireEmail !== false),
      showLiveVoteCounts: eventData.showLiveVoteCounts === true || existing.showLiveVoteCounts === true,
      allowedMovies: Array.isArray(existing.allowedMovies) ? existing.allowedMovies : [],
    });
  });

  const nextEvents = sortEventsByTime(Array.from(mergedByFirestoreId.values()));
  configuredEvents.splice(0, configuredEvents.length, ...nextEvents);
  populateSelector();
  updateEventLabel(currentEventId);
}

function setAccessStatus(message, isError = false) {
  if (!accessStatus) return;
  accessStatus.textContent = message;
  accessStatus.style.color = isError ? "#ff6b6b" : "#bbb";
}

function updateAccessRoleUI() {
  const role = String(accessRoleSelect?.value || "theater_user");
  if (!accessTheaterKeyWrap) return;
  accessTheaterKeyWrap.style.display = role === "theater_user" ? "" : "none";
}

function renderAccessRows(users = []) {
  if (!accessListBody) return;
  accessListBody.innerHTML = "";
  if (!users.length) {
    accessListBody.innerHTML = "<tr><td colspan='5' style='text-align:center;color:#aaa;'>No records found.</td></tr>";
    return;
  }

  users.forEach((user) => {
    const tr = document.createElement("tr");
    const role = String(user.role || "theater_user");
    const enabled = user.enabled !== false;
    tr.innerHTML = `
      <td>${user.email || ""}</td>
      <td>${role}</td>
      <td>${user.theater_key || "—"}</td>
      <td>${enabled ? "Yes" : "No"}</td>
      <td>${user.updated_by || "—"}</td>
    `;
    tr.style.cursor = "pointer";
    tr.title = "Click to load into form";
    tr.addEventListener("click", () => {
      if (accessTargetEmailInput) accessTargetEmailInput.value = String(user.email || "");
      if (accessRoleSelect) accessRoleSelect.value = role;
      if (accessActiveCheckbox) accessActiveCheckbox.checked = enabled;
      if (accessTheaterKeyInput) accessTheaterKeyInput.value = String(user.theater_key || "");
      updateAccessRoleUI();
      setAccessStatus(`Loaded ${user.email || "record"} into form.`);
    });
    accessListBody.appendChild(tr);
  });
}

async function refreshAccessList() {
  if (!currentAdminEmail) {
    setAccessStatus("Admin session missing.", true);
    return;
  }
  setAccessStatus("Loading access list...");
  try {
    const response = await reelSuccessListAccessCallable({
      adminEmail: currentAdminEmail,
    });
    const users = response?.data?.users || [];
    renderAccessRows(users);
    setAccessStatus(`Loaded ${users.length} access record${users.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error(error);
    setAccessStatus(error?.message || "Failed loading access list.", true);
  }
}

async function saveAccessRecord() {
  if (!currentAdminEmail) {
    setAccessStatus("Admin session missing.", true);
    return;
  }

  const targetEmail = normalizeEmail(accessTargetEmailInput?.value || "");
  const role = String(accessRoleSelect?.value || "theater_user");
  const enabled = accessActiveCheckbox?.checked !== false;
  const theaterKey = String(accessTheaterKeyInput?.value || "").trim();

  if (!targetEmail || !targetEmail.includes("@")) {
    setAccessStatus("Enter a valid target email.", true);
    return;
  }
  if (role === "theater_user" && !theaterKey) {
    setAccessStatus("Theater key is required for theater_user.", true);
    return;
  }

  if (accessSaveBtn) accessSaveBtn.disabled = true;
  setAccessStatus("Saving access...");
  try {
    await reelSuccessSetAccessCallable({
      adminEmail: currentAdminEmail,
      targetEmail,
      enabled,
      role,
      theaterKey: role === "theater_user" ? theaterKey : "",
    });
    setAccessStatus(`Saved access for ${targetEmail}.`);
    await refreshAccessList();
  } catch (error) {
    console.error(error);
    setAccessStatus(error?.message || "Failed saving access.", true);
  } finally {
    if (accessSaveBtn) accessSaveBtn.disabled = false;
  }
}

function resolveEvent(firestoreId) {
  return configuredEvents.find((event) =>
    (EVENT_ID_ALIASES[event.id] || event.firestoreEventId || event.id) === firestoreId,
  ) || null;
}

function isAdminEmail(email) {
  return ADMIN_EMAILS.has(normalizeEmail(email));
}

function isPrivilegedAdminEmail(email) {
  return normalizeEmail(email) === PRIVILEGED_ADMIN_EMAIL;
}

function setEliminationStatus(message, isError = false) {
  if (!eliminationStatusEl) return;
  eliminationStatusEl.textContent = message;
  eliminationStatusEl.style.color = isError ? "#ff6b6b" : "#bbb";
}

function setVoteControlStatus(message, isError = false) {
  if (!voteControlStatusEl) return;
  voteControlStatusEl.textContent = message;
  voteControlStatusEl.style.color = isError ? "#ff6b6b" : "#bbb";
}

function setRebuildCountsStatus(message, isError = false) {
  if (!rebuildCountsStatusEl) return;
  rebuildCountsStatusEl.textContent = message;
  rebuildCountsStatusEl.style.color = isError ? "#ff6b6b" : "#bbb";
}

function updateEndVoteButton() {
  if (!endVoteBtn) return;
  const isEnded = currentVoteStatus === "ended";
  const isNotStarted = currentVoteStatus === "not-started";
  const isPrivileged = isPrivilegedAdminEmail(currentAdminEmail);
  const hideReopen = isEnded && !isPrivileged;
  endVoteBtn.disabled = !currentAdminEmail || !currentEventId;
  endVoteBtn.textContent = isNotStarted ? "Start vote" : (isEnded ? "Reopen vote" : "End vote");
  endVoteBtn.style.display = hideReopen ? "none" : "";
  endVoteBtn.style.opacity = endVoteBtn.disabled ? "0.6" : "1";
  endVoteBtn.style.cursor = endVoteBtn.disabled ? "not-allowed" : "pointer";

  if (runEliminationBtn) {
    runEliminationBtn.style.display = isPrivileged ? "" : "none";
  }
  if (rebuildCountsBtn) {
    rebuildCountsBtn.style.display = isPrivileged ? "" : "none";
  }
}

async function endVoteNow() {
  if (!currentAdminEmail) {
    setVoteControlStatus("Admin session missing. Refresh and sign in again.", true);
    return;
  }

  if (!currentEventId) {
    setVoteControlStatus("No event selected.", true);
    return;
  }

  const previousVoteStatus = currentVoteStatus;
  const nextVoteStatus = previousVoteStatus === "not-started"
    ? "live"
    : (previousVoteStatus === "ended" ? "live" : "ended");
  if (previousVoteStatus === "ended" && !isPrivilegedAdminEmail(currentAdminEmail)) {
    setVoteControlStatus(`Only ${PRIVILEGED_ADMIN_EMAIL} can reopen votes.`, true);
    return;
  }
  const confirmed = window.confirm(
    nextVoteStatus === "ended"
      ? "End voting for this event now? This will block new votes."
      : (previousVoteStatus === "not-started"
        ? "Start voting for this event now?"
        : "Reopen voting for this event now? This will allow new votes."),
  );
  if (!confirmed) {
    return;
  }

  try {
    if (endVoteBtn) {
      endVoteBtn.disabled = true;
      endVoteBtn.textContent = nextVoteStatus === "ended"
        ? "Ending…"
        : (previousVoteStatus === "not-started" ? "Starting…" : "Reopening…");
    }
    setVoteControlStatus(
      nextVoteStatus === "ended"
        ? "Ending vote..."
        : (previousVoteStatus === "not-started" ? "Starting vote..." : "Reopening vote...")
    );

    await setEventVoteStatusCallable({
      eventId: currentEventId,
      adminEmail: currentAdminEmail,
      voteStatus: nextVoteStatus,
    });

    currentVoteStatus = nextVoteStatus;
    const configuredEvent = resolveEvent(currentEventId);
    if (configuredEvent) {
      configuredEvent.voteStatus = nextVoteStatus;
    }
    populateSelector();
    updateEndVoteButton();
    setVoteControlStatus(
      nextVoteStatus === "ended"
        ? "Vote ended. New vote submissions are now blocked."
        : (previousVoteStatus === "not-started"
          ? "Vote started. New vote submissions are now allowed."
          : "Vote reopened. New vote submissions are now allowed."),
    );
  } catch (error) {
    console.error("Failed ending vote:", error);
    setVoteControlStatus(error?.message || "Failed to update vote status.", true);
    updateEndVoteButton();
  }
}

async function runEliminationRoundNow() {
  if (!currentAdminEmail) {
    setEliminationStatus("Admin session missing. Refresh and sign in again.", true);
    return;
  }

  if (!currentEventId) {
    setEliminationStatus("No event selected.", true);
    return;
  }

  if (!isPrivilegedAdminEmail(currentAdminEmail)) {
    setEliminationStatus(`Only ${PRIVILEGED_ADMIN_EMAIL} can run elimination rounds.`, true);
    return;
  }

  try {
    if (runEliminationBtn) {
      runEliminationBtn.disabled = true;
      runEliminationBtn.textContent = "Running…";
    }
    setEliminationStatus("Running elimination round...");

    const response = await runEliminationRoundCallable({
      eventId: currentEventId,
      adminEmail: currentAdminEmail,
    });

    const result = response.data || {};
    if (result.status === "eliminated") {
      const removed = Array.isArray(result.eliminatedTitles) ? result.eliminatedTitles.join(", ") : "";
      setEliminationStatus(`Round ${result.round}: eliminated ${removed || "movies"}. Notified ${result.notifiedEmailCount || 0} voters.`);
    } else if (result.status === "winner") {
      setEliminationStatus(`Winner locked: ${result.winner || "final movie"}.`);
    } else if (result.status === "disabled") {
      setEliminationStatus("Elimination is disabled for this event.", true);
    } else {
      setEliminationStatus(`No changes (${result.status || "no-op"}).`);
    }
  } catch (error) {
    console.error("Manual elimination failed:", error);
    setEliminationStatus(error?.message || "Failed to run elimination.", true);
  } finally {
    if (runEliminationBtn) {
      runEliminationBtn.disabled = false;
      runEliminationBtn.textContent = "Run elimination round now";
    }
  }
}

async function rebuildMovieCountsNow() {
  if (!currentAdminEmail) {
    setRebuildCountsStatus("Admin session missing. Refresh and sign in again.", true);
    return;
  }

  if (!currentEventId) {
    setRebuildCountsStatus("No event selected.", true);
    return;
  }

  if (!isPrivilegedAdminEmail(currentAdminEmail)) {
    setRebuildCountsStatus(`Only ${PRIVILEGED_ADMIN_EMAIL} can rebuild vote counts.`, true);
    return;
  }

  try {
    if (rebuildCountsBtn) {
      rebuildCountsBtn.disabled = true;
      rebuildCountsBtn.textContent = "Rebuilding…";
    }

    setRebuildCountsStatus("Rebuilding movie vote counts from votes...");

    const response = await rebuildEventMovieVoteCountsCallable({
      eventId: currentEventId,
      adminEmail: currentAdminEmail,
    });

    const data = response?.data || {};
    const unmatched = Number(data.unmatchedTitleCount || 0);
    const usedInactiveFallback = data.usedInactiveFallback === true;
    if (unmatched > 0) {
      setRebuildCountsStatus(`Rebuilt counts. Matched ${data.matchedVoteCount || 0}/${data.activeVoteCount || 0} active votes. ${unmatched} vote title(s) did not match current movie titles.`, true);
    } else {
      setRebuildCountsStatus(`Rebuilt counts. Matched ${data.matchedVoteCount || 0}/${data.activeVoteCount || 0} active votes.`);
    }
    if (usedInactiveFallback) {
      setRebuildCountsStatus(`Rebuilt counts using fallback (all historical votes) because no active votes were found. Matched ${data.matchedVoteCount || 0} vote records.`);
    }

    await refreshVoteStats(currentEventId);
  } catch (error) {
    console.error("Failed rebuilding movie counts:", error);
    const code = String(error?.code || "").toLowerCase();
    const message = String(error?.message || "");
    const needsDeploy = code.includes("not-found") || code.includes("unavailable") || /no\s+function|does\s+not\s+exist|no\s+endpoint/i.test(message);
    if (needsDeploy) {
      setRebuildCountsStatus("Rebuild function is not deployed yet. Deploy functions and try again.", true);
      window.alert("Rebuild function is not deployed yet. Run: firebase deploy --only functions:rebuildEventMovieVoteCounts");
    } else {
      setRebuildCountsStatus(message || "Failed rebuilding movie vote counts.", true);
    }
  } finally {
    if (rebuildCountsBtn) {
      rebuildCountsBtn.disabled = false;
      rebuildCountsBtn.textContent = "Rebuild counts from votes";
    }
  }
}

async function renderMovies(movies) {
  if (!adminList) return;

  adminList.innerHTML = "";

  if (!movies.length) {
    const empty = document.createElement("div");
    empty.className = "chosen-movie";
    empty.textContent = "No votes yet for this event.";
    adminList.appendChild(empty);
    return;
  }

  const totalVotes = typeof currentActiveVoteCount === "number"
    ? currentActiveVoteCount
    : movies.reduce((sum, m) => sum + (m.vote_count || 0), 0);

  if (totalVotes === 0) {
    const empty = document.createElement("div");
    empty.className = "chosen-movie";
    empty.textContent = "No votes yet for this event.";
    adminList.appendChild(empty);
    return;
  }

  const totalPeople = typeof currentUniqueVoterCount === "number"
    ? currentUniqueVoterCount
    : totalVotes;
  const maxVotes = movies.reduce((max, movie) => Math.max(max, movie.vote_count || 0), 0);

  const totalEl = document.createElement("div");
  totalEl.style.cssText = "color:#aaa;font-size:13px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #333;display:flex;justify-content:center;align-items:center;gap:16px;flex-wrap:wrap;text-align:center;width:100%;";
  totalEl.innerHTML = `<span>Total votes: ${totalVotes}</span><span>Total people: ${totalPeople}</span>`;
  adminList.appendChild(totalEl);

  const moviesWithMetadata = await Promise.all(movies.map(async (movie) => {
    const title = movie.movie_title || movie.title || movie.id;
    const metadata = await getMovieMetadataByTitle(title);
    return {
      ...movie,
      title,
      poster: movie.poster || movie.posterUrl || movie.poster_url || metadata.poster || null,
    };
  }));

  moviesWithMetadata.forEach((movie) => {
    const voteCount = movie.vote_count || 0;
    const percentage = maxVotes > 0 ? Math.round((voteCount / maxVotes) * 100) : 0;
    const poster = movie.poster || null;
    const title = movie.title || movie.movie_title || movie.id;
    const safeTitle = String(title || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
    const safePoster = String(poster || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

    const item = document.createElement("div");
    item.className = "chosen-movie";
    item.innerHTML = `
      <div class="chosen-movie-header">
        ${poster
          ? `<img class="chosen-movie-poster" src="${safePoster}" alt="${safeTitle} poster" loading="lazy" />`
          : '<div class="chosen-movie-poster chosen-movie-poster-fallback" aria-hidden="true"></div>'}
        <span class="admin-movie-title">${safeTitle}</span>
      </div>
      <div class="chosen-movie-bar">
        <div class="chosen-movie-fill" style="width: ${Math.min(percentage, 100)}%"></div>
      </div>
      <div class="chosen-movie-count">${voteCount} vote${voteCount === 1 ? "" : "s"}</div>
    `;

    adminList.appendChild(item);
  });
}

async function loadAdminControlsForEvent(firestoreId) {
  const configuredEvent = resolveEvent(firestoreId);
  const configuredRequireEmail = configuredEvent?.requireEmail !== false;
  const configuredVoteStatus = normalizeVoteStatus(configuredEvent?.voteStatus);
  currentVoteStatus = configuredVoteStatus;
  updateEndVoteButton();
  setSaveStatus("Loading settings…");
  setVoteControlStatus("");

  try {
    const [eventDoc, moviesSnapshot] = await Promise.all([
      getDoc(doc(db, "events", firestoreId)),
      getDocs(collection(db, "events", firestoreId, "movies")),
    ]);

    const eventData = eventDoc.exists() ? (eventDoc.data() || {}) : {};
    const runtimeVoteStatusRaw = String(eventData.voteStatus || "").trim();
    currentVoteStatus = runtimeVoteStatusRaw
      ? normalizeVoteStatus(runtimeVoteStatusRaw)
      : configuredVoteStatus;
    if (configuredEvent) {
      configuredEvent.voteStatus = currentVoteStatus;
      populateSelector();
    }
    updateEndVoteButton();

    if (adminRequireEmailCheckbox) {
      adminRequireEmailCheckbox.checked = typeof eventData.requireEmail === "boolean"
        ? eventData.requireEmail
        : configuredRequireEmail;
    }

    const runtimeScreeningDateTime = String(eventData.screeningDateTime || configuredEvent?.screeningDateTime || "").trim();
    const { date: rescheduleDate, time: rescheduleTime } = parseLocalDateTimeParts(runtimeScreeningDateTime);
    if (adminRescheduleDateInput) adminRescheduleDateInput.value = rescheduleDate;
    if (adminRescheduleTimeInput) adminRescheduleTimeInput.value = rescheduleTime;
    if (adminCurrentDateTime) {
      adminCurrentDateTime.textContent = `Current: ${formatScreeningDateTimeLabel(runtimeScreeningDateTime)}`;
    }
    setRescheduleStatus("");

    const titles = moviesSnapshot.docs
      .map((movieDoc) => String(movieDoc.data()?.movie_title || movieDoc.id).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    if (adminMoviesInput) {
      adminMoviesInput.value = titles.join("\n");
    }

    renderBallot(titles);

    if (shouldAutoOpenEditForEmptySelection) {
      if (titles.length === 0) {
        showTab("edit");
      }
      shouldAutoOpenEditForEmptySelection = false;
    }

    setSaveStatus(`Loaded ${titles.length} movie${titles.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error("Failed loading admin controls:", error);
    if (shouldAutoOpenEditForEmptySelection) {
      shouldAutoOpenEditForEmptySelection = false;
    }
    setSaveStatus("Could not load settings.", true);
  }
}

async function rescheduleCurrentShowtime() {
  if (!currentAdminEmail) {
    setRescheduleStatus("Admin session missing. Refresh and sign in again.", true);
    return;
  }

  if (!currentEventId) {
    setRescheduleStatus("No showtime selected.", true);
    return;
  }

  const showDate = String(adminRescheduleDateInput?.value || "").trim();
  const showTime = String(adminRescheduleTimeInput?.value || "").trim();

  if (!showDate) {
    setRescheduleStatus("Select a show date.", true);
    return;
  }

  if (!showTime) {
    setRescheduleStatus("Select a show time.", true);
    return;
  }

  if (adminRescheduleBtn) adminRescheduleBtn.disabled = true;
  setRescheduleStatus("Updating showtime date/time...");

  try {
    const response = await updateEventShowtimeDateTimeCallable({
      eventId: currentEventId,
      adminEmail: currentAdminEmail,
      screeningDateTime: `${showDate}T${showTime}`,
    });

    const updatedEvent = response?.data?.event || null;
    currentEventId = String(response?.data?.eventId || updatedEvent?.firestoreEventId || currentEventId);

    await refreshConfiguredEventsFromFirestore();

    if (eventSelector) {
      const selected = configuredEvents.find((event) => {
        const resolvedId = EVENT_ID_ALIASES[event.id] || event.firestoreEventId || event.id;
        return resolvedId === currentEventId;
      });
      if (selected) {
        eventSelector.value = selected.id;
      }
    }

    startLiveListener(currentEventId);
    await loadAdminControlsForEvent(currentEventId);
    setRescheduleStatus(`Updated to ${updatedEvent?.screeningLabel || currentEventId}.`);
    setSaveStatus("Loaded rescheduled showtime.");
  } catch (error) {
    console.error("Failed rescheduling showtime:", error);
    setRescheduleStatus(error?.message || "Failed updating showtime date/time.", true);
  } finally {
    if (adminRescheduleBtn) adminRescheduleBtn.disabled = false;
  }
}

async function saveAdminControls() {
  if (!currentEventId) {
    setSaveStatus("No event selected.", true);
    return;
  }

  const dedupedTitles = collectMovieTitles(adminMoviesInput?.value || "");

  if (dedupedTitles.length === 0) {
    setSaveStatus("Enter at least one movie.", true);
    return;
  }

  if (adminSaveBtn) adminSaveBtn.disabled = true;
  setSaveStatus("Saving…");

  try {
    if (!currentAdminEmail) {
      throw new Error("Admin session missing. Refresh and sign in again.");
    }

    await saveEventAdminSettingsCallable({
      eventId: currentEventId,
      adminEmail: currentAdminEmail,
      requireEmail: adminRequireEmailCheckbox?.checked === true,
      movieTitles: dedupedTitles,
    });

    renderBallot(dedupedTitles);
    await loadAdminControlsForEvent(currentEventId);
    setSaveStatus(`Saved ${dedupedTitles.length} movies. Email required: ${adminRequireEmailCheckbox?.checked ? "on" : "off"}.`);
  } catch (error) {
    console.error("Failed saving admin controls:", error);
    setSaveStatus(`Save failed: ${error?.message || "unknown error"}`, true);
  } finally {
    if (adminSaveBtn) adminSaveBtn.disabled = false;
  }
}

async function createShowtime() {
  if (!currentAdminEmail) {
    setCreateStatus("Admin session missing. Refresh and sign in again.", true);
    return;
  }

  const showDate = String(adminNewShowtimeDateInput?.value || "").trim();
  const showTime = String(adminNewShowtimeTimeInput?.value || "").trim();
  const voteStatus = String(adminNewVoteStatusSelect?.value || "not-started").trim();
  const movieTitles = collectMovieTitles(adminNewMoviesInput?.value || "");

  if (!showDate) {
    setCreateStatus("Select a show date.", true);
    return;
  }
  if (!showTime) {
    setCreateStatus("Select a show time.", true);
    return;
  }

  if (adminCreateBtn) adminCreateBtn.disabled = true;
  setCreateStatus("Creating showtime...");

  try {
    const response = await createEventShowtimeCallable({
      adminEmail: currentAdminEmail,
      screeningDateTime: `${showDate}T${showTime}`,
      voteStatus,
      requireEmail: adminNewRequireEmailCheckbox?.checked === true,
      movieTitles,
    });

    const createdEvent = response?.data?.event || null;
    if (adminNewMoviesInput) adminNewMoviesInput.value = "";
    await refreshConfiguredEventsFromFirestore();

    currentEventId = createdEvent?.firestoreEventId || response?.data?.eventId || currentEventId;
    populateSelector();
    updateEventLabel(currentEventId);
    if (eventSelector) {
      const selected = configuredEvents.find((event) => (EVENT_ID_ALIASES[event.id] || event.firestoreEventId || event.id) === currentEventId);
      if (selected) {
        eventSelector.value = selected.id;
      }
    }

    await loadAdminControlsForEvent(currentEventId);
    startLiveListener(currentEventId);
    showTab("edit");

    setCreateStatus(`Created ${createdEvent?.screeningLabel || currentEventId}.`);
    setSaveStatus("Loaded new showtime.");
  } catch (error) {
    console.error("Failed creating showtime:", error);
    setCreateStatus(error?.message || "Failed creating showtime.", true);
  } finally {
    if (adminCreateBtn) adminCreateBtn.disabled = false;
  }
}

function clearAdminViewForNoEvent() {
  currentEventId = "";
  currentVoteStatus = "not-started";
  currentUniqueVoterCount = null;
  currentActiveVoteCount = null;
  latestMoviesForRender = [];

  if (unsubscribeLive) { unsubscribeLive(); unsubscribeLive = null; }
  if (unsubscribeVoterCount) { unsubscribeVoterCount(); unsubscribeVoterCount = null; }
  if (voteStatsPollTimer) {
    window.clearInterval(voteStatsPollTimer);
    voteStatsPollTimer = null;
  }

  populateSelector();
  updateEventLabel("");
  updateEndVoteButton();
  renderBallot([]);

  if (adminMoviesInput) adminMoviesInput.value = "";
  if (adminRequireEmailCheckbox) adminRequireEmailCheckbox.checked = true;
  if (adminList) {
    adminList.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "chosen-movie";
    empty.textContent = "No showtime selected.";
    adminList.appendChild(empty);
  }
  if (updatedAtEl) updatedAtEl.textContent = "";

  setVoteControlStatus("No showtime selected.", true);
  setSaveStatus("Select or create a showtime to edit.");
}

async function deleteCurrentShowtime() {
  if (!currentAdminEmail) {
    setDeleteStatus("Admin session missing. Refresh and sign in again.", true);
    return;
  }

  if (!currentEventId) {
    setDeleteStatus("No showtime selected.", true);
    return;
  }

  const deletedEventId = currentEventId;
  const event = resolveEvent(deletedEventId);
  const label = event?.screeningLabel || event?.id || deletedEventId;
  const confirmed = window.confirm(`Delete \"${label}\" permanently? This removes its movies and vote history.`);
  if (!confirmed) {
    return;
  }

  if (adminDeleteBtn) adminDeleteBtn.disabled = true;
  setDeleteStatus("Deleting showtime...");

  try {
    await deleteEventShowtimeCallable({
      eventId: deletedEventId,
      adminEmail: currentAdminEmail,
    });

    const keptEvents = configuredEvents.filter((item) => {
      const resolvedId = EVENT_ID_ALIASES[item.id] || item.firestoreEventId || item.id;
      return resolvedId !== deletedEventId;
    });
    configuredEvents.splice(0, configuredEvents.length, ...keptEvents);

    await refreshConfiguredEventsFromFirestore();

    const nextEvent = configuredEvents.find((item) => {
      const resolvedId = EVENT_ID_ALIASES[item.id] || item.firestoreEventId || item.id;
      return resolvedId !== deletedEventId;
    }) || null;

    if (!nextEvent) {
      clearAdminViewForNoEvent();
      setDeleteStatus(`Deleted ${label}.`);
      return;
    }

    currentEventId = EVENT_ID_ALIASES[nextEvent.id] || nextEvent.firestoreEventId || nextEvent.id;

    if (eventSelector) {
      eventSelector.value = nextEvent.id;
    }

    startLiveListener(currentEventId);
    await loadAdminControlsForEvent(currentEventId);
    setDeleteStatus(`Deleted ${label}.`);
    setSaveStatus(`Loaded ${nextEvent.screeningLabel || nextEvent.id}.`);
    showTab("edit");
  } catch (error) {
    console.error("Failed deleting showtime:", error);
    setDeleteStatus(error?.message || "Failed deleting showtime.", true);
  } finally {
    if (adminDeleteBtn) adminDeleteBtn.disabled = false;
  }
}

let unsubscribeLive = null;
let unsubscribeVoterCount = null;
let latestMoviesForRender = [];
let voteStatsPollTimer = null;
let shouldAutoOpenEditForEmptySelection = false;

async function refreshVoteStats(firestoreId) {
  if (!firestoreId || !currentAdminEmail) {
    return;
  }

  try {
    const response = await getEventVoteStatsCallable({
      eventId: firestoreId,
      adminEmail: currentAdminEmail,
    });

    const totalVotes = Number(response?.data?.totalVotes);
    const totalPeople = Number(response?.data?.totalPeople);

    currentActiveVoteCount = Number.isFinite(totalVotes) ? totalVotes : null;
    currentUniqueVoterCount = Number.isFinite(totalPeople) ? totalPeople : null;

    if (latestMoviesForRender.length > 0 || currentUniqueVoterCount === 0) {
      renderMovies(latestMoviesForRender);
    }
  } catch (error) {
    console.error("Error loading voter totals:", error);
  }
}

function startLiveListener(firestoreId) {
  firestoreId = firestoreId || currentEventId;
  if (unsubscribeLive) { unsubscribeLive(); unsubscribeLive = null; }
  if (unsubscribeVoterCount) { unsubscribeVoterCount(); unsubscribeVoterCount = null; }
  if (voteStatsPollTimer) {
    window.clearInterval(voteStatsPollTimer);
    voteStatsPollTimer = null;
  }
  currentUniqueVoterCount = null;
  currentActiveVoteCount = null;
  latestMoviesForRender = [];
  updateEventLabel(firestoreId);
  const moviesRef = collection(db, "events", firestoreId, "movies");

  refreshVoteStats(firestoreId);
  voteStatsPollTimer = window.setInterval(() => {
    refreshVoteStats(firestoreId);
  }, 5000);

  unsubscribeLive = onSnapshot(moviesRef, (snapshot) => {
    const movies = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      movies.push({ id: doc.id, ...data });
    });

    // Sort by votes desc
    movies.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
    latestMoviesForRender = movies;

    const ballotTitles = movies
      .map((movie) => String(movie.movie_title || movie.id || "").trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    renderBallot(ballotTitles);

    renderMovies(movies);

    if (updatedAtEl) {
      const now = new Date();
      updatedAtEl.textContent = `Live updated: ${now.toLocaleTimeString()}`;
    }
  }, (error) => {
    console.error("Error listening for votes:", error);
    if (updatedAtEl) {
      updatedAtEl.textContent = "Error loading votes (check console)";
    }
  });

}

// Handle event selector changes
if (eventSelector) {
  eventSelector.addEventListener("change", async () => {
    const selectedId = String(eventSelector.value || "").trim();
    const resolved = EVENT_ID_ALIASES[selectedId]
      || configuredEvents.find((e) => e.id === selectedId || e.firestoreEventId === selectedId)?.firestoreEventId
      || selectedId;
    shouldAutoOpenEditForEmptySelection = true;
    updatePublicPreviewLink();
    currentEventId = await resolveEventDataId(resolved);
    currentVoteStatus = normalizeVoteStatus(resolveEvent(currentEventId)?.voteStatus);
    updateEndVoteButton();
    setVoteControlStatus("");
    startLiveListener(currentEventId);
    await loadAdminControlsForEvent(currentEventId);
  });
}

if (adminSaveBtn) {
  adminSaveBtn.addEventListener("click", saveAdminControls);
}

if (adminDeleteBtn) {
  adminDeleteBtn.addEventListener("click", deleteCurrentShowtime);
}

if (adminRescheduleBtn) {
  adminRescheduleBtn.addEventListener("click", rescheduleCurrentShowtime);
}

if (adminCreateBtn) {
  adminCreateBtn.addEventListener("click", createShowtime);
}

function promptLoginModal(validateFn) {
  return new Promise((resolve) => {
    const modal = document.getElementById("loginModal");
    const input = document.getElementById("loginEmailInput");
    const errorEl = document.getElementById("loginEmailError");
    const submitBtn = document.getElementById("loginSubmitBtn");
    if (!modal || !input || !submitBtn) {
      // Fallback if modal elements are missing
      const raw = window.prompt("Enter your theater email to continue:");
      resolve(normalizeEmail(raw || ""));
      return;
    }

    modal.classList.remove("hidden");
    input.value = "";
    if (errorEl) errorEl.textContent = "";
    setTimeout(() => input.focus(), 50);

    function attempt() {
      const email = normalizeEmail(input.value);
      if (!email || !email.includes("@")) {
        if (errorEl) errorEl.textContent = "Please enter a valid email address.";
        input.focus();
        return;
      }
      if (!validateFn(email)) {
        if (errorEl) errorEl.textContent = "That email isn't authorized. Try a different one.";
        input.select();
        return;
      }
      modal.classList.add("hidden");
      submitBtn.removeEventListener("click", attempt);
      input.removeEventListener("keydown", keyHandler);
      resolve(email);
    }

    function keyHandler(e) {
      if (e.key === "Enter") attempt();
    }

    submitBtn.addEventListener("click", attempt);
    input.addEventListener("keydown", keyHandler);
  });
}

async function ensureAdminAccess() {
  const STORAGE_KEY = "reelvotes_admin_email";
  const LEGACY_REELSUCCESS_STORAGE_KEY = "reelsuccess_admin_email";

  const stored = window.localStorage.getItem(STORAGE_KEY)
    || window.localStorage.getItem(LEGACY_REELSUCCESS_STORAGE_KEY);
  if (stored && isAdminEmail(stored)) {
    window.localStorage.setItem(STORAGE_KEY, normalizeEmail(stored));
    window.localStorage.removeItem(LEGACY_REELSUCCESS_STORAGE_KEY);
    return normalizeEmail(stored);
  }

  const email = await promptLoginModal(isAdminEmail);
  window.localStorage.setItem(STORAGE_KEY, email);
  return email;
}

ensureAdminAccess()
  .then(async (adminEmail) => {
    currentAdminEmail = adminEmail;
    setAdminIdentity(adminEmail);
    refreshConfiguredEventsFromFirestore().catch((error) => {
      console.error("Failed loading runtime event catalog:", error);
    });
    currentEventId = await resolveEventDataId(currentEventId);
    startLiveListener(currentEventId);
    loadAdminControlsForEvent(currentEventId);
    if (runEliminationBtn) {
      runEliminationBtn.addEventListener("click", runEliminationRoundNow);
    }
    if (rebuildCountsBtn) {
      rebuildCountsBtn.addEventListener("click", rebuildMovieCountsNow);
    }
    if (endVoteBtn) {
      endVoteBtn.addEventListener("click", endVoteNow);
      updateEndVoteButton();
    }
    if (accessRoleSelect) {
      accessRoleSelect.addEventListener("change", updateAccessRoleUI);
      updateAccessRoleUI();
    }
    if (accessSaveBtn) {
      accessSaveBtn.addEventListener("click", saveAccessRecord);
    }
    if (accessRefreshBtn) {
      accessRefreshBtn.addEventListener("click", refreshAccessList);
    }
    refreshAccessList();
  })
  .catch((err) => {
    console.warn("Admin access blocked:", err.message);
    if (runEliminationBtn) {
      runEliminationBtn.disabled = true;
    }
    if (rebuildCountsBtn) {
      rebuildCountsBtn.disabled = true;
    }
    if (endVoteBtn) {
      endVoteBtn.disabled = true;
    }
  });
