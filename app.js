import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore, collection, getDocs, getDoc, doc, query, where, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-functions.js";

// Firebase Config
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
const submitVoteCallable = httpsCallable(functions, "submitVote");
const getVoteStatusCallable = httpsCallable(functions, "getVoteStatus");
const TURNSTILE_SITE_KEY = window.REELVOTES_CONFIG?.turnstileSiteKey || "";
const CAPTCHA_ENABLED = Boolean(TURNSTILE_SITE_KEY);

// TMDB API Config
const TMDB_API_KEY = "05e2d906f097b769ba4d7e8c7305accf"; // Get from https://www.themoviedb.org/settings/api
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_TITLE_OVERRIDES = {
  "blade runner": { tmdbId: 78 }
};
const LOCAL_POSTER_FALLBACKS = {
  "back to the future": "https://image.tmdb.org/t/p/w185/vN5B5WgYscRGcQpVhHl6p9DDTP0.jpg",
  "jurassic park": "https://image.tmdb.org/t/p/w185/63viWuPfYQjRYLSZSZNq7dglJP5.jpg",
  "blade runner": "https://image.tmdb.org/t/p/w185/63N9uy8nd9j7Eog2axPQ8lbr3Wj.jpg",
  "in the mood for love": "https://image.tmdb.org/t/p/w185/iYypPT4bhqXfq1b6EnmxvRt6b2Y.jpg",
  "mean girls": "https://image.tmdb.org/t/p/w185/2ZkuQXvVhh45uSvkBej4S7Ix1NJ.jpg",
  "bring it on": "https://image.tmdb.org/t/p/w185/bnVby0qI0dS7YunbShP7mw68HY3.jpg",
  "the notebook": "https://image.tmdb.org/t/p/w185/rNzQyW4f8B8cQeg7Dgj3n6eT5k9.jpg",
  "blade": "https://image.tmdb.org/t/p/w185/oWT70TvbsmQaqyphCZpsnQR7R32.jpg",
  "battle royale": "https://image.tmdb.org/t/p/w185/aLGKAQKgzWpJ6egyWzzC11jXBRJ.jpg",
  "mad max: fury road": "https://image.tmdb.org/t/p/w185/ulcAi4dKpAjHwYGS08vNyx9H6I9.jpg",
};

// Restricted list - movies that cannot be voted for
const RESTRICTED_MOVIES = new Set([]);

// Default allowed movies - used when an event-specific list is not configured
const DEFAULT_ALLOWED_MOVIES = [
  "Back to the Future",
  "Jurassic Park",
  "Blade Runner",
  "In The Mood For Love",
  "Mean Girls",
  "Bring It On",
  "The Notebook",
  "Blade",
  "Battle Royale",
  "Mad Max: Fury Road"
];

let selectedMovie = null;
let selectedMovieCard = null;
let selectedBallotMovies = [];
let chosenMovies = [];
const eliminatedMovieTitles = new Set();
let hasActiveMovieList = false;
let voterClientId = null;
const movieMetadataCache = new Map();

// Get event ID from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const requestedEventId = urlParams.get("event");
const EVENT_ID_ALIASES = {
  "2026-04-27": "newparkway1"
};
const requestedEventDataId = EVENT_ID_ALIASES[requestedEventId] || requestedEventId;
if (window.REELVOTES_EVENT_PROMISE && typeof window.REELVOTES_EVENT_PROMISE.then === "function") {
  await window.REELVOTES_EVENT_PROMISE;
}
const configuredEvents = window.REELVOTES_EVENTS || [];

function getEventSortTime(event) {
  const rawDateTime = String(event?.screeningDateTime || "").trim();
  const parsedDateTime = rawDateTime ? Date.parse(rawDateTime) : Number.NaN;
  if (Number.isFinite(parsedDateTime)) {
    return parsedDateTime;
  }

  const rawId = String(event?.id || "").trim();
  const parsedId = rawId ? Date.parse(rawId) : Number.NaN;
  return Number.isFinite(parsedId) ? parsedId : Number.NEGATIVE_INFINITY;
}

function getLatestConfiguredEvent(predicate) {
  return configuredEvents
    .filter((event) => predicate(event))
    .sort((left, right) => getEventSortTime(right) - getEventSortTime(left))[0] || null;
}

const defaultConfiguredEvent = getLatestConfiguredEvent((event) => event.voteStatus === "live")
  || getLatestConfiguredEvent((event) => event.voteStatus !== "ended")
  || configuredEvents[0]
  || null;
const selectedEvent = window.REELVOTES_EVENT || (requestedEventId
  ? configuredEvents.find(
    (event) => event.id === requestedEventId || event.firestoreEventId === requestedEventId || event.firestoreEventId === requestedEventDataId,
  )
  : defaultConfiguredEvent
) || null;
const EVENT_ID = selectedEvent?.firestoreEventId
  || requestedEventDataId
  || defaultConfiguredEvent?.firestoreEventId
  || defaultConfiguredEvent?.id
  || "newparkway1";
let EVENT_DATA_ID = EVENT_ID;
let EVENT_STATUS = selectedEvent?.voteStatus || null;
let EVENT_REQUIRES_EMAIL = selectedEvent?.requireEmail !== false;
const EVENT_SHOW_LIVE_VOTE_COUNTS = selectedEvent?.showLiveVoteCounts === true;
const EVENT_ALLOWED_MOVIES = Array.isArray(selectedEvent?.allowedMovies)
  ? selectedEvent.allowedMovies.filter((title) => typeof title === "string" && title.trim().length > 0)
  : [];
const ACTIVE_ALLOWED_MOVIES = EVENT_ALLOWED_MOVIES.length > 0 ? EVENT_ALLOWED_MOVIES : DEFAULT_ALLOWED_MOVIES;

let _eventStatusInitialized = false;
let _unsubscribeEventStatus = null;

function withTimeout(promise, timeoutMs, fallbackValue, label = "async task") {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[app] ${label} timed out after ${timeoutMs}ms; using fallback.`);
      resolve(fallbackValue);
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        console.warn(`[app] ${label} failed; using fallback.`, error);
        resolve(fallbackValue);
      });
  });
}

function buildEventIdCandidates(rawEventId) {
  const normalized = String(rawEventId || "").trim();
  const event = configuredEvents.find((item) => (
    item.id === normalized
    || item.firestoreEventId === normalized
    || EVENT_ID_ALIASES[item.id] === normalized
  )) || null;

  return Array.from(new Set([
    normalized,
    requestedEventId,
    requestedEventDataId,
    event?.firestoreEventId,
    event?.id,
    EVENT_ID_ALIASES[event?.id],
  ].filter(Boolean)));
}

async function resolveEventDataId(rawEventId) {
  const candidates = buildEventIdCandidates(rawEventId);
  if (!candidates.length) {
    return rawEventId;
  }

  const scored = [];
  for (const candidate of candidates) {
    try {
      const [eventDoc, moviesSnapshot, votesSnapshot] = await Promise.all([
        getDoc(doc(db, "events", candidate)),
        getDocs(collection(db, "events", candidate, "movies")),
        getDocs(query(collection(db, "events", candidate, "votes"), limit(1))),
      ]);

      const movieCount = moviesSnapshot.size;
      const hasVotes = !votesSnapshot.empty;
      const score = (hasVotes ? 1000 : 0) + (movieCount * 10) + (eventDoc.exists() ? 1 : 0);
      scored.push({ candidate, score });
    } catch {
      scored.push({ candidate, score: 0 });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.candidate || candidates[0] || rawEventId;
}

async function loadEventRuntimeSettings() {
  return new Promise((resolve) => {
    let resolved = false;
    const finishInitialLoad = () => {
      if (resolved) return;
      resolved = true;
      _eventStatusInitialized = true;
      resolve();
    };

    const startupTimeoutId = window.setTimeout(() => {
      console.warn("[app] Runtime event settings load timed out; continuing with configured defaults.");
      finishInitialLoad();
    }, 2500);

    if (_unsubscribeEventStatus) {
      _unsubscribeEventStatus();
    }

    _unsubscribeEventStatus = onSnapshot(
      doc(db, "events", EVENT_DATA_ID),
      (eventDoc) => {
        const eventData = eventDoc.exists() ? (eventDoc.data() || {}) : {};
        const newStatus = typeof eventData.voteStatus === "string" && eventData.voteStatus.trim()
          ? eventData.voteStatus.trim().toLowerCase()
          : EVENT_STATUS;
        const prevStatus = EVENT_STATUS;

        EVENT_STATUS = newStatus;

        if (typeof eventData.requireEmail === "boolean") {
          EVENT_REQUIRES_EMAIL = eventData.requireEmail;
        }

        if (!_eventStatusInitialized) {
          window.clearTimeout(startupTimeoutId);
          finishInitialLoad();
          return;
        }

        // Status changed to ended while voter is on the page — switch UI immediately
        if (prevStatus !== "ended" && newStatus === "ended") {
          console.log("[app] Vote status changed to ended — redirecting to results view");
          fetchChosenMovies().then(() => {
            showEndedResultsInterface();
          });
        }
      },
      (error) => {
        console.warn("[app] Could not load runtime event settings, using config defaults", error);
        if (!_eventStatusInitialized) {
          window.clearTimeout(startupTimeoutId);
          finishInitialLoad();
        }
      }
    );
  });
}

console.log("[app] Bootstrap", {
  href: window.location.href,
  requestedEventId,
  selectedEvent,
  EVENT_ID,
  EVENT_STATUS
});

if (!requestedEventId && selectedEvent?.id) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("event", selectedEvent.id);
  window.history.replaceState({}, "", nextUrl.toString());
}

const VOTER_CLIENT_ID_KEY = (eventId) => `voterClientId_${eventId}`;
const CAST_VOTE_KEY = (eventId) => `castVote_${eventId}`;

const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const moviePreview = document.getElementById("moviePreview");
const chosenList = document.getElementById("chosenList");
const chosenSection = document.getElementById("chosenMovies");
const chosenLabel = document.querySelector(".chosen-label");
const submitBtn = document.getElementById("submitBtn");
const resultsDiv = document.getElementById("results");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const captchaContainer = document.getElementById("captchaContainer");
const captchaNotice = document.getElementById("captchaNotice");
const emailVoteModal = document.getElementById("emailVoteModal");
const singleVoteReminderModal = document.getElementById("singleVoteReminderModal");
const reelVotesMissionModal = document.getElementById("reelVotesMissionModal");
const voteEmailInput = document.getElementById("voteEmailInput");
const voteEmailStatus = document.getElementById("voteEmailStatus");
const confirmEmailVoteBtn = document.getElementById("confirmEmailVoteBtn");
const cancelEmailVoteBtn = document.getElementById("cancelEmailVoteBtn");
const singleVoteReminderAddMoreBtn = document.getElementById("singleVoteReminderAddMoreBtn");
const singleVoteReminderOkBtn = document.getElementById("singleVoteReminderOkBtn");
const reelVotesMissionContinueBtn = document.getElementById("reelVotesMissionContinueBtn");
const mainTabList = document.getElementById("mainTabList");
const tabVoteBtn = document.getElementById("tabVoteBtn");
const tabMomentsBtn = document.getElementById("tabMomentsBtn");
const tabAccountBtn = document.getElementById("tabAccountBtn");
const tabVotePanel = document.getElementById("tabVotePanel");
const tabMomentsPanel = document.getElementById("tabMomentsPanel");
const tabAccountPanel = document.getElementById("tabAccountPanel");
const votePageHeading = document.getElementById("votePageHeading");
const momentsFeed = document.getElementById("momentsFeed");
const momentsStatus = document.getElementById("momentsStatus");
const momentsRefreshBtn = document.getElementById("momentsRefreshBtn");
const accountStatus = document.getElementById("accountStatus");
const accountGuestState = document.getElementById("accountGuestState");
const accountSignedInState = document.getElementById("accountSignedInState");
const accountEmail = document.getElementById("accountEmail");
const accountSignOutBtn = document.getElementById("accountSignOutBtn");
const accountSignInBtn = document.getElementById("accountSignInBtn");
const accountAdminLink = document.getElementById("accountAdminLink");

const MAIN_TABS = ["vote", "moments", "account"];
const MAIN_TAB_BUTTONS = {
  vote: tabVoteBtn,
  moments: tabMomentsBtn,
  account: tabAccountBtn
};
const MAIN_TAB_PANELS = {
  vote: tabVotePanel,
  moments: tabMomentsPanel,
  account: tabAccountPanel
};
const TAB_STORAGE_KEY = `reelvotesTab_${EVENT_ID}`;
const ADMIN_EMAIL_STORAGE_KEY = "reelvotes_admin_email";

let captchaToken = null;
let captchaWidgetId = null;
let momentsLoaded = false;
let momentsLoading = false;

function updateVotePageHeading(status) {
  if (!votePageHeading) {
    return;
  }

  const normalizedStatus = String(status || EVENT_STATUS || "").trim().toLowerCase();
  const defaultHeading = votePageHeading.dataset.defaultHeading || "Pick the Next Movie Night";
  votePageHeading.textContent = normalizedStatus === "ended" ? "Movie Night Results" : defaultHeading;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatMomentDate(value) {
  if (!value) {
    return "";
  }

  let date = null;
  if (typeof value?.toDate === "function") {
    date = value.toDate();
  } else if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    date = new Date(value);
  } else if (typeof value === "string") {
    date = new Date(value);
  }

  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString();
}

function setMomentsStatus(message, isError = false) {
  if (!momentsStatus) {
    return;
  }

  momentsStatus.textContent = message || "";
  momentsStatus.style.color = isError ? "#ff8e8e" : "#aaa";
}

function normalizeAccountEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return normalized.includes("@") ? normalized : "";
}

function getStoredAccountEmail() {
  try {
    return normalizeAccountEmail(window.localStorage.getItem(ADMIN_EMAIL_STORAGE_KEY));
  } catch {
    return "";
  }
}

function setAccountStatus(message, isError = false) {
  if (!accountStatus) {
    return;
  }

  accountStatus.textContent = message || "";
  accountStatus.style.color = isError ? "#ff8e8e" : "#aaa";
}

function updateAccountLinks() {
  const eventParam = selectedEvent?.id || requestedEventId || EVENT_ID;
  const adminHref = `admin.html?event=${encodeURIComponent(eventParam)}`;
  if (accountSignInBtn) {
    accountSignInBtn.href = adminHref;
  }
  if (accountAdminLink) {
    accountAdminLink.href = adminHref;
  }
}

function renderAccountState() {
  updateAccountLinks();

  const storedEmail = getStoredAccountEmail();
  const hasSession = Boolean(storedEmail);

  if (accountGuestState) {
    accountGuestState.classList.toggle("hidden", hasSession);
  }
  if (accountSignedInState) {
    accountSignedInState.classList.toggle("hidden", !hasSession);
  }

  if (hasSession) {
    if (accountEmail) {
      accountEmail.textContent = storedEmail;
    }
    setAccountStatus("Active admin session found on this browser.");
  } else {
    if (accountEmail) {
      accountEmail.textContent = "";
    }
    setAccountStatus("You are browsing as a guest.");
  }
}

function clearAccountSession() {
  try {
    window.localStorage.removeItem(ADMIN_EMAIL_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
  renderAccountState();
  setAccountStatus("Signed out of local admin session.");
}

function renderMomentItems(items) {
  if (!momentsFeed) {
    return;
  }

  if (!items.length) {
    momentsFeed.innerHTML = `<div class="moment-item"><div class="moment-item-body">No moments yet for this event.</div></div>`;
    return;
  }

  momentsFeed.innerHTML = items.map((item) => {
    const movieTitle = escapeHtml(item.movieTitle || item.title || "Untitled movie");
    const text = escapeHtml(item.text || item.take || item.content || "No text provided.");
    const author = escapeHtml(item.author || item.authorName || "Anonymous");
    const stamp = escapeHtml(formatMomentDate(item.createdAt || item.timestamp || item.created_at || item.updatedAt));

    return `
      <article class="moment-item">
        <div class="moment-item-title">${movieTitle}</div>
        <div class="moment-item-body">${text}</div>
        <div class="moment-item-meta">${author}${stamp ? ` • ${stamp}` : ""}</div>
      </article>
    `;
  }).join("");
}

async function loadMomentsFeed({ force = false } = {}) {
  if (momentsLoading || (!force && momentsLoaded)) {
    return;
  }

  momentsLoading = true;
  if (momentsRefreshBtn) {
    momentsRefreshBtn.disabled = true;
  }

  setMomentsStatus("Loading moments...");

  try {
    const takeQuery = query(
      collection(db, "takes"),
      where("eventId", "==", EVENT_ID),
      orderBy("createdAt", "desc"),
      limit(20)
    );

    const snapshot = await getDocs(takeQuery);
    const items = snapshot.docs.map((entry) => entry.data() || {});

    momentsLoaded = true;
    renderMomentItems(items);

    if (items.length) {
      setMomentsStatus(`Showing ${items.length} moment${items.length === 1 ? "" : "s"}.`);
    } else {
      setMomentsStatus("No moments found for this event yet.");
    }
  } catch (error) {
    console.warn("[moments] Unable to load takes feed", error);

    try {
      const moviesSnapshot = await getDocs(collection(db, "events", EVENT_ID, "movies"));
      const fallback = moviesSnapshot.docs
        .map((entry) => ({
          movieTitle: entry.id,
          text: "Audience voting is active for this title.",
          author: "ReelVotes",
          createdAt: null,
          voteCount: Number(entry.data()?.voteCount || 0)
        }))
        .sort((a, b) => b.voteCount - a.voteCount)
        .slice(0, 12);

      momentsLoaded = true;
      renderMomentItems(fallback);
      setMomentsStatus("Live takes are unavailable in this view. Showing event movie pulse instead.");
    } catch (fallbackError) {
      console.warn("[moments] Fallback feed also failed", fallbackError);
      renderMomentItems([]);
      setMomentsStatus("Could not load moments right now.", true);
    }
  } finally {
    momentsLoading = false;
    if (momentsRefreshBtn) {
      momentsRefreshBtn.disabled = false;
    }
  }
}

function normalizeMainTab(tab) {
  const value = String(tab || "").toLowerCase();
  return MAIN_TABS.includes(value) ? value : null;
}

function getMainTabFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return normalizeMainTab(params.get("tab"));
}

function getStoredMainTab() {
  try {
    return normalizeMainTab(window.sessionStorage.getItem(TAB_STORAGE_KEY));
  } catch {
    return null;
  }
}

function persistMainTab(tab) {
  try {
    window.sessionStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // ignore session storage failures
  }
}

function updateMainTabUrl(tab) {
  const normalized = normalizeMainTab(tab);
  if (!normalized) {
    return;
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("tab", normalized);
  window.history.replaceState({}, "", nextUrl.toString());
}

function removeLegacyTabsUi() {
  // Remove stale tab query param from old links/bookmarks.
  try {
    const nextUrl = new URL(window.location.href);
    if (nextUrl.searchParams.has("tab")) {
      nextUrl.searchParams.delete("tab");
      window.history.replaceState({}, "", nextUrl.toString());
    }
  } catch {
    // ignore URL parsing failures
  }

  // Remove legacy tab button row if present in cached HTML.
  if (mainTabList?.parentElement) {
    mainTabList.parentElement.removeChild(mainTabList);
  }

  // Keep only vote panel visible.
  if (tabVotePanel) {
    tabVotePanel.hidden = false;
    tabVotePanel.style.display = "";
  }
  if (tabMomentsPanel) {
    tabMomentsPanel.hidden = true;
    tabMomentsPanel.style.display = "none";
  }
  if (tabAccountPanel) {
    tabAccountPanel.hidden = true;
    tabAccountPanel.style.display = "none";
  }
}

function onVoteTabEnter() {
  updateVoteActionState();
}

function onMomentsTabEnter() {
  loadMomentsFeed();
}

function onAccountTabEnter() {
  renderAccountState();
}

function switchMainTab(tab, { persist = true, updateUrl = true } = {}) {
  const normalized = normalizeMainTab(tab) || "vote";

  MAIN_TABS.forEach((name) => {
    const isActive = name === normalized;
    const button = MAIN_TAB_BUTTONS[name];
    const panel = MAIN_TAB_PANELS[name];

    if (button) {
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.tabIndex = isActive ? 0 : -1;
    }

    if (panel) {
      panel.hidden = !isActive;
    }
  });

  if (persist) {
    persistMainTab(normalized);
  }

  if (updateUrl) {
    updateMainTabUrl(normalized);
  }

  if (normalized === "vote") {
    onVoteTabEnter();
  } else if (normalized === "moments") {
    onMomentsTabEnter();
  } else {
    onAccountTabEnter();
  }
}

function restoreMainTabFromUrlOrSession() {
  return getMainTabFromUrl() || getStoredMainTab() || "vote";
}

function initMainTabs() {
  if (!mainTabList || !tabVoteBtn || !tabMomentsBtn || !tabAccountBtn) {
    return;
  }

  tabVoteBtn.addEventListener("click", () => switchMainTab("vote"));
  tabMomentsBtn.addEventListener("click", () => switchMainTab("moments"));
  tabAccountBtn.addEventListener("click", () => switchMainTab("account"));
  momentsRefreshBtn?.addEventListener("click", () => {
    momentsLoaded = false;
    loadMomentsFeed({ force: true });
  });
  accountSignOutBtn?.addEventListener("click", clearAccountSession);

  mainTabList.addEventListener("keydown", (event) => {
    if (!event.target || !(event.target instanceof HTMLElement)) {
      return;
    }

    const currentIndex = MAIN_TABS.findIndex((name) => MAIN_TAB_BUTTONS[name] === event.target);
    if (currentIndex === -1) {
      return;
    }

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % MAIN_TABS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + MAIN_TABS.length) % MAIN_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = MAIN_TABS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = MAIN_TABS[nextIndex];
    const nextButton = MAIN_TAB_BUTTONS[nextTab];
    if (nextButton) {
      switchMainTab(nextTab);
      nextButton.focus();
    }
  });

  switchMainTab(restoreMainTabFromUrlOrSession(), { persist: true, updateUrl: true });
}

function getCaptchaErrorMessage(errorCode) {
  if (errorCode === "invalid-sitekey") {
    return "CAPTCHA configuration error: invalid site key.";
  }
  if (errorCode === "invalid-domain") {
    return "CAPTCHA is blocked for this domain. Add this hostname in Turnstile settings.";
  }
  if (errorCode === "network-error") {
    return "CAPTCHA network error. Check ad blockers, VPN, or firewall and try again.";
  }
  return "CAPTCHA failed to load. Please refresh and try again.";
}

function setCaptchaNotice(message) {
  if (!captchaNotice) {
    return;
  }

  captchaNotice.textContent = message;
  captchaNotice.classList.toggle("hidden", !message);
}

function updateSubmitButtonState() {
  const hasSelectedMovies = selectedBallotMovies.length > 0;
  submitBtn.disabled = !hasSelectedMovies || (CAPTCHA_ENABLED && !captchaToken);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function buildAnonymousVoteEmail() {
  const safeEventId = String(EVENT_ID || "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "event";
  const safeClientId = String(voterClientId || "client")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "client";
  return `anon-${safeEventId}-${safeClientId}@reelvotes.local`;
}

function setVoteEmailStatus(message, isError = false) {
  if (!voteEmailStatus) {
    return;
  }

  voteEmailStatus.textContent = message;
  voteEmailStatus.style.color = isError ? "#ff6b6b" : "#ccc";
  voteEmailStatus.classList.toggle("hidden", !message);
}

function showEmailVoteModal() {
  if (!emailVoteModal) {
    return;
  }

  setVoteEmailStatus("");
  if (voteEmailInput) {
    voteEmailInput.value = "";
  }
  emailVoteModal.classList.remove("hidden");
  voteEmailInput?.focus();
}

function hideEmailVoteModal() {
  if (!emailVoteModal) {
    return;
  }

  emailVoteModal.classList.add("hidden");
  setVoteEmailStatus("");
}

function showSingleVoteReminderModal() {
  if (!singleVoteReminderModal) {
    return;
  }

  singleVoteReminderModal.classList.remove("hidden");
  singleVoteReminderOkBtn?.focus();
}

function hideSingleVoteReminderModal() {
  if (!singleVoteReminderModal) {
    return;
  }

  singleVoteReminderModal.classList.add("hidden");
}

function continueAddingMovies() {
  hideSingleVoteReminderModal();
  searchInput?.focus();
}

function showReelVotesMissionModal() {
  return new Promise((resolve) => {
    if (!reelVotesMissionModal || !reelVotesMissionContinueBtn) {
      resolve();
      return;
    }

    reelVotesMissionModal.classList.remove("hidden");

    const closeModal = () => {
      reelVotesMissionModal.classList.add("hidden");
      reelVotesMissionContinueBtn.removeEventListener("click", onContinue);
      reelVotesMissionModal.removeEventListener("click", onBackdropClick);
      document.removeEventListener("keydown", onKeyDown);
      resolve();
    };

    const onContinue = () => closeModal();
    const onBackdropClick = (event) => {
      if (event.target === reelVotesMissionModal) {
        closeModal();
      }
    };
    const onKeyDown = (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        closeModal();
      }
    };

    reelVotesMissionContinueBtn.addEventListener("click", onContinue);
    reelVotesMissionModal.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onKeyDown);
    reelVotesMissionContinueBtn.focus();
  });
}

async function waitForTurnstile() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (window.turnstile?.render) {
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }

  throw new Error("Turnstile did not finish loading.");
}

async function ensureCaptchaWidget() {
  if (!CAPTCHA_ENABLED || !captchaContainer) {
    return;
  }

  captchaContainer.classList.remove("hidden");
  setCaptchaNotice(captchaToken ? "" : "Complete the CAPTCHA to enable vote submission.");

  if (captchaWidgetId !== null) {
    updateSubmitButtonState();
    return;
  }

  await waitForTurnstile();

  captchaWidgetId = window.turnstile.render(captchaContainer, {
    sitekey: TURNSTILE_SITE_KEY,
    theme: "dark",
    callback: (token) => {
      captchaToken = token;
      setCaptchaNotice("");
      updateSubmitButtonState();
    },
    "expired-callback": () => {
      captchaToken = null;
      setCaptchaNotice("CAPTCHA expired. Please complete it again.");
      updateSubmitButtonState();
    },
    "error-callback": (errorCode) => {
      captchaToken = null;
      const message = getCaptchaErrorMessage(errorCode);
      console.error("Turnstile error:", { errorCode, siteKey: TURNSTILE_SITE_KEY, hostname: window.location.hostname });
      setCaptchaNotice(message);
      updateSubmitButtonState();
    }
  });

  updateSubmitButtonState();
}

function resetCaptcha({ keepVisible = false } = {}) {
  captchaToken = null;

  if (CAPTCHA_ENABLED && captchaWidgetId !== null && window.turnstile?.reset) {
    window.turnstile.reset(captchaWidgetId);
  }

  if (captchaContainer) {
    captchaContainer.classList.toggle("hidden", !keepVisible || !CAPTCHA_ENABLED);
  }

  setCaptchaNotice(keepVisible && CAPTCHA_ENABLED ? "Complete the CAPTCHA to enable vote submission." : "");
  updateSubmitButtonState();
}

function updateVoteActionState() {
  if (selectedBallotMovies.length === 0) {
    submitBtn.classList.add("hidden");
    resetCaptcha();
    return;
  }

  submitBtn.classList.remove("hidden");

  if (CAPTCHA_ENABLED) {
    ensureCaptchaWidget().catch((error) => {
      console.error("Error loading CAPTCHA:", error);
      setCaptchaNotice("CAPTCHA script failed to load. Check blockers/network and refresh.");
    });
  } else {
    if (captchaContainer) {
      captchaContainer.classList.add("hidden");
    }
    setCaptchaNotice("");
  }

  updateSubmitButtonState();
}

function generateClientId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  const randomPart = Math.random().toString(36).slice(2);
  return `rv_${Date.now().toString(36)}_${randomPart}`;
}

function getOrCreateClientId() {
  try {
    let clientId = window.localStorage.getItem(VOTER_CLIENT_ID_KEY(EVENT_ID));
    if (!clientId) {
      clientId = generateClientId();
      window.localStorage.setItem(VOTER_CLIENT_ID_KEY(EVENT_ID), clientId);
    }
    return clientId;
  } catch (error) {
    console.error("Error getting voter client ID:", error);
    return generateClientId();
  }
}

function persistCastVote(movieTitles) {
  const normalizedTitles = Array.isArray(movieTitles)
    ? movieTitles.filter((title) => typeof title === "string" && title.trim().length > 0)
    : [];

  window.localStorage.setItem(CAST_VOTE_KEY(EVENT_ID), JSON.stringify({
    titles: normalizedTitles,
    title: normalizedTitles[0] || null,
    storedAt: Date.now()
  }));
}

function getPersistedCastVote() {
  try {
    const storedVote = window.localStorage.getItem(CAST_VOTE_KEY(EVENT_ID));
    return storedVote ? JSON.parse(storedVote) : null;
  } catch (error) {
    console.error("Error reading stored vote:", error);
    return null;
  }
}

function clearPersistedCastVote() {
  try {
    window.localStorage.removeItem(CAST_VOTE_KEY(EVENT_ID));
  } catch (error) {
    console.error("Error clearing stored vote:", error);
  }
}

async function getExistingVote() {
  try {
    const response = await getVoteStatusCallable({
      eventId: EVENT_DATA_ID,
      clientId: voterClientId
    });

    const responseTitles = Array.isArray(response.data?.movieTitles)
      ? response.data.movieTitles
      : response.data?.movieTitle
        ? [response.data.movieTitle]
        : [];

    if (!response.data?.hasVoted || responseTitles.length === 0) {
      clearPersistedCastVote();
      return null;
    }

    persistCastVote(responseTitles);
    return {
      titles: responseTitles,
      title: responseTitles[0],
      vote_count: 0,
      year: null
    };
  } catch (error) {
    console.error("Error fetching vote status, falling back to local vote:", error);
    const localVote = getPersistedCastVote();
    const localTitles = Array.isArray(localVote?.titles)
      ? localVote.titles
      : localVote?.title
        ? [localVote.title]
        : [];
    if (localTitles.length === 0) {
      return null;
    }
    return {
      titles: localTitles,
      title: localTitles[0],
      vote_count: 0,
      year: null
    };
  }
}

async function routeCurrentVoter() {
  console.log("[app] Routing current voter", {
    EVENT_ID,
    EVENT_STATUS
  });

  if (EVENT_STATUS === "ended") {
    console.log("[app] Event ended, showing results view");
    await fetchChosenMovies();
    showEndedResultsInterface();
    return;
  }

  const [existingVote] = await Promise.all([
    withTimeout(getExistingVote(), 1800, null, "existing vote status lookup"),
    fetchChosenMovies()
  ]);

  if (existingVote) {
    await showExistingVoteConfirmation(existingVote);
    return;
  }

  showVotingInterface();
}

function movieTitleKey(movieTitle) {
  return String(movieTitle || "").trim().toLowerCase();
}

function isMovieSelected(movieTitle) {
  const targetKey = movieTitleKey(movieTitle);
  return selectedBallotMovies.some((item) => movieTitleKey(item.title) === targetKey);
}

function updateAllowedMovieHighlights() {
  const allMovieItems = document.querySelectorAll(".allowed-movie-item");
  allMovieItems.forEach((item) => {
    const itemTitle = item.dataset.movieTitle || "";
    const selected = isMovieSelected(itemTitle);
    item.classList.toggle("selected", selected);
  });
}

function refreshSelectedBallotUi() {
  if (!submitBtn) {
    return;
  }
  submitBtn.textContent = selectedBallotMovies.length > 1
    ? `Submit ${selectedBallotMovies.length} Votes`
    : "Submit Vote";
  updateAllowedMovieHighlights();
  updateSubmitButtonState();
}

function toggleSelectedMovie(movie) {
  if (!movie?.title) {
    return;
  }

  const targetKey = movieTitleKey(movie.title);
  const alreadyIncluded = isMovieSelected(movie.title);
  if (alreadyIncluded) {
    selectedBallotMovies = selectedBallotMovies.filter((item) => movieTitleKey(item.title) !== targetKey);
    refreshSelectedBallotUi();
    return;
  }

  selectedBallotMovies.push(movie);
  refreshSelectedBallotUi();
}

// Fetch active movies from Firebase
async function fetchChosenMovies() {
  try {
    console.log("Fetching votes from Firebase...");
    // Fetch from the new movies collection under events/{event_id}/movies/
    const moviesRef = collection(db, "events", EVENT_DATA_ID, "movies");
    const querySnapshot = await getDocs(moviesRef);
    
    console.log("Query snapshot size:", querySnapshot.size);
    
    const moviesArray = [];
    eliminatedMovieTitles.clear();
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.eliminated === true && data.movie_title) {
        eliminatedMovieTitles.add(String(data.movie_title).trim().toLowerCase());
      }
      moviesArray.push({
        id: doc.id,
        title: data.movie_title,
        vote_count: data.vote_count || 0,
        eliminated: data.eliminated === true,
        year: null
      });
    });

    chosenMovies = moviesArray;
    console.log("Total unique movies:", chosenMovies.length);
    console.log("Movies:", chosenMovies);
    console.log("[app] Computed movie list state", {
      EVENT_ID,
      EVENT_DATA_ID,
      EVENT_STATUS,
      chosenMoviesLength: chosenMovies.length
    });

    hasActiveMovieList = chosenMovies.length > 0 || EVENT_STATUS === "live";

    // Hide section if no movies
    if (!hasActiveMovieList) {
      console.log("No votes found - hiding section");
      chosenSection.style.display = "none";
    } else {
      console.log("Found votes - showing section");
      chosenSection.style.display = "block";
        await displayChosenMovies(EVENT_SHOW_LIVE_VOTE_COUNTS);
    }
  } catch (error) {
    console.error("Error fetching votes:", error);
    chosenSection.style.display = "none";
  }
}

// Generate the public app link for the current event
async function generateAppLink() {
  try {
    return `${window.location.origin}${window.location.pathname}?event=${encodeURIComponent(EVENT_ID)}`;
  } catch (error) {
    console.error("Error generating app link:", error);
    return `${window.location.origin}${window.location.pathname}`;
  }
}

// Search TMDB API
async function searchTMDB(query) {
  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`
    );
    if (!response.ok) {
      console.warn("TMDB search non-200 response", { status: response.status, query });
      return [];
    }
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error("TMDB search error:", error);
    return [];
  }
}

// Get movie details from TMDB
async function getMovieDetails(movieId) {
  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/movie/${movieId}?api_key=${TMDB_API_KEY}&append_to_response=credits,videos`
    );
    if (!response.ok) {
      console.warn("TMDB details non-200 response", { status: response.status, movieId });
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error("Error fetching movie details:", error);
    return null;
  }
}

function buildPosterUrl(posterPath, size = "w185") {
  return posterPath ? `https://image.tmdb.org/t/p/${size}${posterPath}` : null;
}

function buildYouTubeTrailerSearchUrl(title) {
  const query = `${String(title || "").trim()} official trailer`;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function selectYouTubeTrailerUrl(videos, fallbackTitle = "") {
  const items = Array.isArray(videos?.results) ? videos.results : [];
  const youtubeVideos = items.filter((item) => String(item?.site || "").toLowerCase() === "youtube" && item?.key);
  const preferred = youtubeVideos.find((item) => String(item?.type || "").toLowerCase() === "trailer")
    || youtubeVideos.find((item) => String(item?.type || "").toLowerCase() === "teaser")
    || youtubeVideos[0]
    || null;

  if (preferred?.key) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(preferred.key)}`;
  }

  return buildYouTubeTrailerSearchUrl(fallbackTitle);
}

function formatStarRating(voteAverage) {
  const numeric = Number(voteAverage);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return `${numeric.toFixed(1)}★`;
}

function normalizeMovieTitleForSearch(title) {
  const raw = String(title || "").trim();
  if (!raw) return "";

  const trailingArticleMatch = raw.match(/^(.*),\s*(The|A|An)$/i);
  const withLeadingArticle = trailingArticleMatch
    ? `${trailingArticleMatch[2]} ${trailingArticleMatch[1]}`.trim()
    : raw;

  return withLeadingArticle
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
}

function getLocalPosterFallback(title) {
  return LOCAL_POSTER_FALLBACKS[String(title || "").trim().toLowerCase()] || null;
}

async function getMovieMetadataByTitle(title) {
  const normalizedLookupTitle = normalizeMovieTitleForSearch(title);
  const localPosterFallback = getLocalPosterFallback(normalizedLookupTitle);
  if (!normalizedLookupTitle) {
    return {
      tmdbId: null,
      poster: localPosterFallback,
      starRating: null,
      trailerUrl: buildYouTubeTrailerSearchUrl(title),
    };
  }

  const cacheKey = normalizedLookupTitle.toLowerCase();
  if (movieMetadataCache.has(cacheKey)) {
    return movieMetadataCache.get(cacheKey);
  }

  try {
    const normalizedTitle = normalizedLookupTitle.toLowerCase();
    const override = TMDB_TITLE_OVERRIDES[normalizedTitle];

    if (override?.tmdbId) {
      const details = await getMovieDetails(override.tmdbId);
      const metadata = {
        tmdbId: override.tmdbId,
        poster: buildPosterUrl(details?.poster_path, "w154"),
        starRating: formatStarRating(details?.vote_average),
        trailerUrl: selectYouTubeTrailerUrl(details?.videos, normalizedLookupTitle),
      };
      movieMetadataCache.set(cacheKey, metadata);
      return metadata;
    }

    const searchCandidates = [
      normalizedLookupTitle,
      normalizedLookupTitle.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim(),
      normalizedLookupTitle.replace(/\(.*?\)/g, "").trim(),
    ].filter(Boolean);

    let results = [];
    for (const candidate of searchCandidates) {
      const next = await searchTMDB(candidate);
      if (Array.isArray(next) && next.length) {
        results = next;
        break;
      }
    }

    const match = results.find(movie => movie.title?.trim().toLowerCase() === normalizedTitle) || results[0];
    let metadata = {
      tmdbId: match?.id || null,
      poster: buildPosterUrl(match?.poster_path, "w154") || localPosterFallback,
      starRating: formatStarRating(match?.vote_average),
      trailerUrl: buildYouTubeTrailerSearchUrl(normalizedLookupTitle),
    };

    if (metadata.tmdbId) {
      const details = await getMovieDetails(metadata.tmdbId);
      metadata = {
        ...metadata,
        poster: metadata.poster || buildPosterUrl(details?.poster_path, "w154"),
        starRating: metadata.starRating || formatStarRating(details?.vote_average),
        trailerUrl: selectYouTubeTrailerUrl(details?.videos, normalizedLookupTitle),
      };
    }

    movieMetadataCache.set(cacheKey, metadata);
    return metadata;
  } catch (error) {
    console.error("Error fetching movie metadata:", error);
    const metadata = {
      tmdbId: null,
      poster: localPosterFallback,
      starRating: null,
      trailerUrl: buildYouTubeTrailerSearchUrl(title),
    };
    movieMetadataCache.set(cacheKey, metadata);
    return metadata;
  }
}

// Display allowed movies list
function displayAllowedMovies() {
  console.log("Displaying allowed movies. SearchResults element:", searchResults);
  
  if (!searchResults) {
    console.error("searchResults element not found!");
    return;
  }
  
  searchResults.innerHTML = "";

  const runtimeMovieTitles = chosenMovies
    .map((movie) => String(movie?.title || "").trim())
    .filter((title) => title.length > 0);
  const movieTitlesForDisplay = runtimeMovieTitles.length > 0
    ? runtimeMovieTitles
    : ACTIVE_ALLOWED_MOVIES;

  const runtimeMoviesByTitle = new Map(
    chosenMovies.map((movie) => [
      String(movie?.title || "").trim().toLowerCase(),
      movie,
    ])
  );

  for (const movieTitle of movieTitlesForDisplay) {
    const runtimeMovie = runtimeMoviesByTitle.get(String(movieTitle || "").trim().toLowerCase()) || null;
    const movie = {
      title: movieTitle,
      poster: runtimeMovie?.poster || null,
      tmdbId: runtimeMovie?.tmdb_id || runtimeMovie?.tmdbId || null,
      starRating: null,
      trailerUrl: buildYouTubeTrailerSearchUrl(movieTitle),
    };
    const existingMovie = chosenMovies.find(m =>
      String(m.title || "").trim().toLowerCase() === String(movie.title || "").trim().toLowerCase()
    );
    const isEliminated = Boolean(existingMovie?.eliminated) || eliminatedMovieTitles.has(String(movie.title || "").trim().toLowerCase());
    const voteCount = existingMovie?.vote_count || 0;
    const showCount = EVENT_SHOW_LIVE_VOTE_COUNTS;

    const item = document.createElement("div");
    item.className = `search-result-item allowed-movie-item${isEliminated ? " eliminated" : ""}`;
    item.dataset.movieTitle = movie.title;
    item.innerHTML = `
      <div class="allowed-movie-content">
        <div class="allowed-movie-main">
          <img class="allowed-movie-poster" src="${movie.poster || ''}" alt="${movie.title} poster" ${movie.poster ? '' : 'style="display:none;"'} />
          <span class="allowed-movie-title">${movie.title}</span>
        </div>
        <div class="allowed-movie-side">
          <span class="allowed-movie-rating" aria-label="Star rating">${movie.starRating || "—"}</span>
          ${showCount ? `<span class="allowed-movie-votes">${voteCount} vote${voteCount !== 1 ? 's' : ''}</span>` : ''}
          <a class="allowed-movie-trailer-link" href="${movie.trailerUrl}" target="_blank" rel="noopener noreferrer" aria-label="Watch ${escapeHtml(movie.title)} trailer on YouTube" title="Watch trailer on YouTube">▶</a>
        </div>
      </div>
    `;
    item.onclick = () => {
      if (isEliminated) {
        return;
      }
      selectMovie({ title: movie.title, poster: movie.poster, tmdbId: movie.tmdbId, eliminated: false });
    };
    searchResults.appendChild(item);

    const trailerLinkEl = item.querySelector(".allowed-movie-trailer-link");
    trailerLinkEl?.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    const ratingEl = item.querySelector(".allowed-movie-rating");

    if (!movie.poster || !movie.starRating || !movie.tmdbId) {
      getMovieMetadataByTitle(movie.title)
        .then((metadata) => {
          if (!metadata?.poster && !metadata?.tmdbId && !metadata?.starRating) {
            return;
          }

          movie.poster = metadata.poster || movie.poster;
          movie.tmdbId = metadata.tmdbId || movie.tmdbId;
          movie.starRating = metadata.starRating || movie.starRating;
          movie.trailerUrl = metadata.trailerUrl || movie.trailerUrl;

          const posterEl = item.querySelector(".allowed-movie-poster");
          if (posterEl && movie.poster) {
            posterEl.src = movie.poster;
            posterEl.style.display = "block";
          }

          if (ratingEl && movie.starRating) {
            ratingEl.textContent = movie.starRating;
          }

          if (trailerLinkEl && movie.trailerUrl) {
            trailerLinkEl.href = movie.trailerUrl;
          }
        })
        .catch((error) => {
          console.warn("[app] Could not enrich movie metadata", { title: movie.title, error });
        });
    }
  }

  updateAllowedMovieHighlights();
  
  // Remove hidden class - it has !important in CSS so this is crucial
  searchResults.classList.remove("hidden");
  // Also override with attribute to ensure it takes precedence
  searchResults.setAttribute('style', 'display: block !important; visibility: visible !important;');
  console.log("Movies displayed, searchResults now visible");
}

// Display search results
async function displaySearchResults(query) {
  if (!query.trim()) {
    searchResults.classList.add("hidden");
    return;
  }

  const results = await searchTMDB(query);
  const filtered = results.filter(movie => !RESTRICTED_MOVIES.has(movie.title));

  searchResults.innerHTML = "";

  if (filtered.length === 0) {
    searchResults.innerHTML = "<div class='search-result-item'>No movies found</div>";
  } else {
    filtered.slice(0, 5).forEach(movie => {
      const item = document.createElement("div");
      item.className = "search-result-item";
      item.innerHTML = movie.title;
      item.onclick = () => selectMovie(movie);
      searchResults.appendChild(item);
    });
  }

  searchResults.classList.remove("hidden");
}

// Select and preview a movie
async function selectMovie(tmdbMovie) {
  console.log("selectMovie called with:", tmdbMovie);

  if (tmdbMovie?.eliminated) {
    return;
  }

  const normalizedTitle = String(tmdbMovie?.title || "").trim().toLowerCase();
  if (normalizedTitle && eliminatedMovieTitles.has(normalizedTitle)) {
    alert("That movie has been eliminated and cannot be selected.");
    return;
  }
  
  // For allowed movies (passed as simple objects with just title)
  if (!tmdbMovie.id && tmdbMovie.title) {
    const metadata = tmdbMovie.poster || tmdbMovie.tmdbId
      ? { poster: tmdbMovie.poster || null, tmdbId: tmdbMovie.tmdbId || null }
      : await getMovieMetadataByTitle(tmdbMovie.title);

    selectedMovie = {
      title: tmdbMovie.title,
      year: "N/A",
      director: "Unknown",
      actors: "Unknown",
      poster: metadata.poster,
      tmdbId: metadata.tmdbId
    };
    
    console.log("Selected movie:", selectedMovie);
    
    // Make sure searchResults is visible (remove hidden class which has !important)
    if (searchResults) {
      searchResults.classList.remove("hidden");
      searchResults.setAttribute('style', 'display: block !important; visibility: visible !important;');
      console.log("SearchResults made visible");
    }
    
    console.log("Showing submit button");
    toggleSelectedMovie(selectedMovie);
    updateVoteActionState();
    
    return;
  }
  
  // For TMDB movies (search results)
  const details = await getMovieDetails(tmdbMovie.id);
  console.log("Movie details fetched:", details);
  
  if (!details) {
    console.error("Failed to get movie details");
    return;
  }

  selectedMovie = {
    title: details.title,
    year: details.release_date?.split("-")[0] || "N/A",
    director: details.credits?.crew?.find(c => c.job === "Director")?.name || "Unknown",
    actors: details.credits?.cast?.slice(0, 3).map(c => c.name).join(", ") || "Unknown",
    poster: details.poster_path ? `https://image.tmdb.org/t/p/w200${details.poster_path}` : null,
    tmdbId: details.id
  };
  
  console.log("Selected movie:", selectedMovie);
  
  console.log("Showing submit button");
  toggleSelectedMovie(selectedMovie);
  updateVoteActionState();
}

// Display chosen movies with vote bars
async function displayChosenMovies(showVoteCounts = false) {
  chosenList.innerHTML = "";

  const shouldShowLiveThemeCounts = Boolean(
    showVoteCounts &&
    EVENT_SHOW_LIVE_VOTE_COUNTS &&
    EVENT_STATUS === "live" &&
    ACTIVE_ALLOWED_MOVIES.length > 0
  );

  let moviesSource = chosenMovies;

  if (shouldShowLiveThemeCounts) {
    const existingByTitle = new Map(
      chosenMovies.map((movie) => [String(movie.title || "").trim().toLowerCase(), movie])
    );

    moviesSource = ACTIVE_ALLOWED_MOVIES.map((themeTitle) => {
      const key = String(themeTitle || "").trim().toLowerCase();
      const existing = existingByTitle.get(key);
      return existing || {
        id: key,
        title: themeTitle,
        vote_count: 0,
        year: null,
      };
    });
  }

  if (moviesSource.length === 0) {
    chosenSection.style.display = "none";
    return;
  }

  const movies = await Promise.all(moviesSource.map(async (movie) => {
    const title = String(movie?.title || "").trim();
    const metadata = await getMovieMetadataByTitle(title);
    return {
      movie: {
        ...movie,
        poster: movie?.poster || metadata.poster || null,
        tmdb_id: movie?.tmdb_id || metadata.tmdbId || null,
      },
      voteCount: movie.vote_count || 0,
    };
  }));

  const totalVotes = movies.reduce((sum, entry) => sum + entry.voteCount, 0);
  const maxVotes = movies.reduce((max, entry) => Math.max(max, entry.voteCount), 0);

  // Sort by vote count descending
  movies.sort((a, b) => b.voteCount - a.voteCount);

  movies.forEach(({ movie, voteCount }) => {
    const percentage = maxVotes > 0 ? Math.round((voteCount / maxVotes) * 100) : 0;
    const item = document.createElement("div");
    item.className = "chosen-movie";
    item.innerHTML = `
      <div class="chosen-movie-header">
        ${movie.poster
          ? `<img class="chosen-movie-poster" src="${movie.poster}" alt="${escapeHtml(movie.title)} poster" loading="lazy" />`
          : `<div class="chosen-movie-poster chosen-movie-poster-fallback" aria-hidden="true"></div>`}
        <div class="chosen-movie-title">
          <span>${movie.title}</span>
        </div>
      </div>
      ${showVoteCounts ? `
      <div class="chosen-movie-bar">
        <div class="chosen-movie-fill" style="width: ${Math.min(percentage, 100)}%"></div>
      </div>
      <div class="chosen-movie-count">${voteCount} vote${voteCount === 1 ? "" : "s"}</div>
      ` : ''}
    `;
    
    // Make clickable to select movie
    item.onclick = async () => {
      console.log("Clicked on current vote:", movie.title);
      // Remove highlight from previously selected card
      if (selectedMovieCard) {
        selectedMovieCard.classList.remove("selected");
      }
      // Highlight this card
      item.classList.add("selected");
      selectedMovieCard = item;
      
      // Fetch full movie details to populate preview
      let movieDetails = null;
      if (movie.tmdb_id) {
        console.log("Fetching details for TMDB ID:", movie.tmdb_id);
        movieDetails = await getMovieDetails(movie.tmdb_id);
      }
      
      if (movieDetails) {
        console.log("Got movie details:", movieDetails.title);
        selectedMovie = {
          title: movieDetails.title,
          year: movieDetails.release_date?.split("-")[0] || movie.year || "N/A",
          director: movieDetails.credits?.crew?.find(c => c.job === "Director")?.name || "Unknown",
          actors: movieDetails.credits?.cast?.slice(0, 3).map(c => c.name).join(", ") || "Unknown",
          poster: movieDetails.poster_path ? `https://image.tmdb.org/t/p/w200${movieDetails.poster_path}` : null,
          tmdbId: movie.tmdb_id
        };
        
        // Display preview
        document.getElementById("movieTitle").innerText = selectedMovie.title;
        document.getElementById("movieYear").innerText = `Year: ${selectedMovie.year}`;
        document.getElementById("movieDirector").innerText = `Director: ${selectedMovie.director}`;
        document.getElementById("movieActors").innerText = `Cast: ${selectedMovie.actors}`;
        
        if (selectedMovie.poster) {
          document.getElementById("moviePoster").src = selectedMovie.poster;
          document.getElementById("moviePoster").style.display = 'block';
        } else {
          document.getElementById("moviePoster").src = '';
          document.getElementById("moviePoster").style.display = 'none';
        }
      } else {
        // Fallback if we can't fetch details
        console.log("No movie details, using fallback");
        selectedMovie = {
          title: movie.title,
          year: movie.year,
          tmdbId: movie.tmdb_id
        };
        
        document.getElementById("movieTitle").innerText = selectedMovie.title;
        document.getElementById("movieYear").innerText = `Year: ${selectedMovie.year}`;
        document.getElementById("movieDirector").innerText = `Director: Unknown`;
        document.getElementById("movieActors").innerText = `Cast: Unknown`;
      }
      
      console.log("Showing preview for:", selectedMovie.title);
      moviePreview.classList.remove("hidden");
      searchResults.classList.add("hidden");
      searchInput.value = movie.title;
      updateVoteActionState();
    };
    
    chosenList.appendChild(item);
  });

  chosenSection.style.display = "block";
}

// Clear movie selection
function clearMovieSelection() {
  selectedMovie = null;
  selectedBallotMovies = [];
  moviePreview.classList.add("hidden");
  searchInput.value = "";
  searchResults.classList.add("hidden");
  clearSearchBtn.classList.remove("shown");
  refreshSelectedBallotUi();
  updateVoteActionState();
}

// Search handler
searchInput.addEventListener("input", (e) => {
  const query = e.target.value.trim();
  
  // Clear selection when user starts typing
  if (query.length > 0) {
    selectedMovie = null;
    selectedMovieCard = null;
    moviePreview.classList.add("hidden");
    updateVoteActionState();
    
    // Remove highlight from all chosen movies
    document.querySelectorAll('.chosen-movie').forEach(card => {
      card.classList.remove("selected");
    });
  }
  
  // Show/hide clear button
  if (query) {
    clearSearchBtn.classList.add("shown");
  } else {
    clearSearchBtn.classList.remove("shown");
  }
  
  displaySearchResults(query);
});

searchInput.addEventListener("focus", (e) => {
  if (e.target.value.trim()) {
    displaySearchResults(e.target.value);
    clearSearchBtn.classList.add("shown");
  }
});

// Clear search button handler
clearSearchBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearSearchBtn.classList.remove("shown");
  searchResults.classList.add("hidden");
  moviePreview.classList.add("hidden");
  selectedMovie = null;
  selectedMovieCard = null;
  updateVoteActionState();
  displayChosenMovies(EVENT_SHOW_LIVE_VOTE_COUNTS);
});

// Hide clear button on blur if input is empty
searchInput.addEventListener("blur", (e) => {
  if (!e.target.value.trim()) {
    clearSearchBtn.classList.remove("shown");
  }
});

// Close search on outside click
document.addEventListener("click", (e) => {
  if (e.target !== searchInput && e.target !== clearSearchBtn) {
    searchResults.classList.add("hidden");
  }
});

// Record vote to Firebase (new structure with individual votes)
async function recordVote(email = null) {
  try {
    if (!selectedBallotMovies.length || !voterClientId) return null;
    const movieTitles = selectedBallotMovies
      .map((movie) => String(movie?.title || "").trim())
      .filter((title) => title.length > 0);

    if (movieTitles.length === 0) {
      return null;
    }

    const payload = {
      eventId: EVENT_DATA_ID,
      movieTitle: movieTitles[0],
      movieTitles,
      clientId: voterClientId,
      captchaToken
    };

    if (EVENT_REQUIRES_EMAIL && email) {
      payload.email = email;
    }

    const response = await submitVoteCallable(payload);

    const result = response.data || {};
    const recordedTitles = Array.isArray(result.movieTitles)
      ? result.movieTitles
      : result.movieTitle
        ? [result.movieTitle]
        : movieTitles;

    if (recordedTitles.length > 0) {
      persistCastVote(recordedTitles);
    }

    return result;
  } catch (error) {
    console.error("Error recording vote:", error);
    const errorMessage = String(error?.message || "");
    const lowerErrorMessage = errorMessage.toLowerCase();
    if (error.code === "functions/resource-exhausted") {
      alert("You are moving too fast. Please wait a few seconds and try again.");
    } else if (error.code === "functions/failed-precondition") {
      alert("Voting has ended for this event.");
    } else if (error.code === "functions/permission-denied") {
      resetCaptcha({ keepVisible: true });
      alert("Please complete the CAPTCHA challenge and try again.");
    } else if (error.code === "functions/invalid-argument") {
      if (lowerErrorMessage.includes("captcha")) {
        resetCaptcha({ keepVisible: true });
        alert("Please complete the CAPTCHA challenge and try again.");
      } else if (lowerErrorMessage.includes("email")) {
        alert("Please enter a valid email address.");
      } else if (lowerErrorMessage.includes("movie")) {
        alert("That movie cannot be voted for. Please pick one from the current list.");
      } else {
        alert(errorMessage || "Invalid vote request. Please try again.");
      }
    } else if (error.code === "functions/unavailable") {
      resetCaptcha({ keepVisible: true });
      alert("CAPTCHA verification is temporarily unavailable. Please try again.");
    } else {
      alert("Error recording vote: " + (errorMessage || "Please try again."));
    }
    throw error;
  }
}

async function submitSelectedVote(email = null) {
  if (!selectedBallotMovies.length) return;

  console.log("Submitting vote for:", selectedBallotMovies);

  // Hide voting interface
  moviePreview.classList.add("hidden");
  if (searchInput && searchInput.parentElement) {
    searchInput.parentElement.style.display = 'none';
  }
  // Hide all search-related elements
  const searchDisclaimer = document.querySelector('.search-disclaimer');
  if (searchDisclaimer) {
    searchDisclaimer.style.display = 'none';
  }
  chosenSection.classList.add("hidden");
  chosenSection.style.display = "none !important";
  submitBtn.classList.add("hidden");

  // Show confirmation shell immediately after click.
  resultsDiv.classList.remove("hidden");
  resultsDiv.innerHTML = `
    <div class="confirmation">
      <h2>Counting your vote…</h2>
      <p class="track-results">Fetching live results now.</p>
    </div>
  `;

  // Record vote and refresh data
  console.log("Recording vote...");
  const voteResult = await recordVote(email);
  if (voteResult?.status === "already-voted") {
    resetCaptcha();
    const searchSection = document.getElementById("search-section");
    if (searchSection) {
      searchSection.classList.add("hidden");
      searchSection.style.display = "none";
    }
    searchResults.classList.add("hidden");
    searchResults.setAttribute('style', '');
    await fetchChosenMovies();
    const existingTitles = Array.isArray(voteResult.movieTitles)
      ? voteResult.movieTitles
      : voteResult.movieTitle
        ? [voteResult.movieTitle]
        : selectedBallotMovies.map((movie) => movie.title);
    await showExistingVoteConfirmation({
      titles: existingTitles,
      title: existingTitles[0] || null,
      vote_count: 0,
      year: null
    });
    return;
  }

  console.log("Vote recorded, fetching updated data...");
  resetCaptcha();
  await fetchChosenMovies();

  const submittedTitles = Array.isArray(voteResult?.movieTitles)
    ? voteResult.movieTitles
    : selectedBallotMovies.map((movie) => movie.title);

  const posterMovie = selectedBallotMovies[0] || null;
  const listItems = submittedTitles.map((title) => `<li>${title}</li>`).join("");

  // Keep chosen section hidden on confirmation screen
  chosenSection.classList.add("hidden");
  chosenSection.style.display = "none !important";

  // Hide the movies list
  searchResults.classList.add("hidden");
  searchResults.setAttribute('style', '');

  resultsDiv.classList.remove("hidden");
  resultsDiv.innerHTML = `
    <div class="confirmation">
      ${posterMovie?.poster ? `<img class="confirmation-poster" src="${posterMovie.poster}" alt="${posterMovie.title} poster" />` : ''}
      <h2>Your ballot has been counted</h2>
      <div class="voted-movie-row">
        <div class="checkmark">✓</div>
        <p class="voted-movie"><b>${submittedTitles.length} movie${submittedTitles.length === 1 ? "" : "s"} selected</b></p>
      </div>
      <ul style="text-align:left;margin:10px 0 0 26px;">${listItems}</ul>
      <p class="vote-counted">The vote has been counted</p>

    </div>

    <button class="share-btn" onclick="shareVote()">📤 Share & Grow</button>
  `;
}

// Submit vote
submitBtn.onclick = async () => {
  if (!selectedBallotMovies.length) return;

  if (selectedBallotMovies.length === 1) {
    showSingleVoteReminderModal();
    return;
  }

  if (CAPTCHA_ENABLED && !captchaToken) {
    await ensureCaptchaWidget();
    setCaptchaNotice("Complete the CAPTCHA to enable vote submission.");
    return;
  }

  if (EVENT_REQUIRES_EMAIL) {
    showEmailVoteModal();
    return;
  }

  await submitSelectedVote();
};

cancelEmailVoteBtn?.addEventListener("click", () => {
  hideEmailVoteModal();
});

emailVoteModal?.addEventListener("click", (event) => {
  if (event.target === emailVoteModal) {
    hideEmailVoteModal();
  }
});

voteEmailInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    confirmEmailVoteBtn?.click();
  }
});

confirmEmailVoteBtn?.addEventListener("click", async () => {
  const email = String(voteEmailInput?.value || "").trim();
  if (!isValidEmail(email)) {
    setVoteEmailStatus("Invalid email. Please enter a valid email address.", true);
    voteEmailInput?.focus();
    return;
  }

  try {
    confirmEmailVoteBtn.disabled = true;
    confirmEmailVoteBtn.textContent = "Counting...";
    setVoteEmailStatus("");
    hideEmailVoteModal();
    await submitSelectedVote(email);
  } catch (error) {
    console.error("Vote submission failed after email confirmation:", error);
  } finally {
    confirmEmailVoteBtn.disabled = false;
    confirmEmailVoteBtn.textContent = "Count my vote";
  }
});

singleVoteReminderOkBtn?.addEventListener("click", async () => {
  hideSingleVoteReminderModal();

  if (CAPTCHA_ENABLED && !captchaToken) {
    await ensureCaptchaWidget();
    setCaptchaNotice("Complete the CAPTCHA to enable vote submission.");
    return;
  }

  if (EVENT_REQUIRES_EMAIL) {
    showEmailVoteModal();
    return;
  }

  await submitSelectedVote();
});

singleVoteReminderAddMoreBtn?.addEventListener("click", () => {
  continueAddingMovies();
});

window.shareVote = async function() {
  const ballotTitles = selectedBallotMovies.map((movie) => movie.title);
  const leadTitle = ballotTitles[0] || "a movie";
  const text = ballotTitles.length > 1
    ? `I just voted for ${ballotTitles.length} movies on ReelVotes (including ${leadTitle})! 🎬 Join the vote and make it happen!`
    : `I'm backing ${leadTitle} for movie night! 🎬 Join the vote and make it happen!`;
  const appLink = await generateAppLink();
  const url = `${appLink}&vote=${encodeURIComponent(leadTitle)}`;
  
  if (navigator.share) {
    navigator.share({
      title: "ReelVotes",
      text: text,
      url: url
    }).catch(err => console.log("Share failed:", err));
  } else {
    navigator.clipboard.writeText(`${text}\n${url}`);
    alert("Vote link copied to clipboard!");
  }
};

// Show confirmation page for an existing vote
async function showExistingVoteConfirmation(movie) {
  const movieTitles = Array.isArray(movie?.titles)
    ? movie.titles
    : movie?.title
      ? [movie.title]
      : [];

  const leadTitle = movieTitles[0] || "your selected movie";

  // Hide voting interface
  const searchSection = document.getElementById("search-section");
  if (searchSection) {
    searchSection.classList.add("hidden");
    searchSection.style.display = 'none';
  }
  if (searchInput && searchInput.parentElement) {
    searchInput.parentElement.style.display = 'none';
  }
  if (searchResults) {
    searchResults.classList.add("hidden");
    searchResults.setAttribute('style', '');
  }
  if (moviePreview) {
    moviePreview.classList.add("hidden");
  }
  const searchDisclaimer = document.querySelector('.search-disclaimer');
  if (searchDisclaimer) {
    searchDisclaimer.style.display = 'none';
  }
  chosenSection.classList.add("hidden");
  chosenSection.style.display = "none !important";
  submitBtn.classList.add("hidden");
  
  const movieMetadata = await getMovieMetadataByTitle(leadTitle);
  const listItems = movieTitles.map((title) => `<li>${title}</li>`).join("");
  
  // Display confirmation
  resultsDiv.classList.remove("hidden");
  resultsDiv.innerHTML = `
    <div class="confirmation">
      ${movieMetadata.poster ? `<img class="confirmation-poster" src="${movieMetadata.poster}" alt="${leadTitle} poster" />` : ''}
      <h2>You've Already Voted!</h2>
      <div class="voted-movie-row">
        <div class="checkmark">✓</div>
        <p class="voted-movie"><b>${movieTitles.length} movie${movieTitles.length === 1 ? "" : "s"} on your ballot</b></p>
      </div>
      ${movieTitles.length ? `<ul style="text-align:left;margin:10px 0 0 26px;">${listItems}</ul>` : ""}
      <p class="vote-counted">Your vote has been counted</p>
    </div>

    <button class="share-btn" onclick="shareExistingVote('${leadTitle.replace(/'/g, "\\'")}')">📤 Share & Grow</button>
  `;
}

// Share existing vote
window.shareExistingVote = async function(movieTitle) {
  const text = `I'm backing ${movieTitle} for movie night! 🎬 Join the vote and make it happen!`;
  const appLink = await generateAppLink();
  const url = `${appLink}&vote=${encodeURIComponent(movieTitle)}`;
  
  if (navigator.share) {
    navigator.share({
      title: "ReelVotes",
      text: text,
      url: url
    }).catch(err => console.log("Share failed:", err));
  } else {
    navigator.clipboard.writeText(`${text}\n${url}`);
    alert("Vote link copied to clipboard!");
  }
};

// Hide voting interface initially
function hideVotingInterface() {
  if (searchInput && searchInput.parentElement) {
    searchInput.parentElement.style.display = 'none';
  }
  if (chosenSection) {
    chosenSection.style.display = 'none';
  }
  if (moviePreview) {
    moviePreview.classList.add("hidden");
  }
  if (submitBtn) {
    submitBtn.classList.add("hidden");
  }
  resetCaptcha();
  if (resultsDiv) {
    resultsDiv.classList.add("hidden");
  }
}

function showVotingInterface() {
  console.log("[app] showVotingInterface", {
    hasActiveMovieList,
    EVENT_STATUS
  });

  updateVotePageHeading(EVENT_STATUS);

  // Hide results if visible
  resultsDiv.classList.add("hidden");
  selectedBallotMovies = [];
  refreshSelectedBallotUi();

  if (!hasActiveMovieList) {
    if (searchInput && searchInput.parentElement) {
      searchInput.parentElement.style.display = 'none';
    }
    if (chosenSection) {
      chosenSection.style.display = 'none';
    }
    resultsDiv.classList.remove("hidden");
    resultsDiv.innerHTML = `
      <div class="confirmation">
        <h2>Voting has not started</h2>
        <p class="track-results">This showtime does not have an active movie list yet. Please check back soon.</p>
      </div>
    `;
    return;
  }
  
  // Show search-section to display the movies list (but hide input)
  if (searchInput && searchInput.parentElement) {
    searchInput.parentElement.style.display = 'flex';
    searchInput.style.display = 'none';
  }
  if (chosenSection) {
    chosenSection.style.display = 'none';
  }
  if (moviePreview) {
    moviePreview.classList.add("hidden");
  }
  
  // Show the allowed movies list instead (vote counts are shown on the cards)
  displayAllowedMovies();
  updateVoteActionState();
}

function showEndedResultsInterface() {
  console.log("[app] showEndedResultsInterface", {
    hasActiveMovieList,
    chosenMoviesLength: chosenMovies.length
  });

  updateVotePageHeading("ended");

  resultsDiv.classList.add("hidden");
  resultsDiv.innerHTML = "";

  if (searchInput && searchInput.parentElement) {
    searchInput.parentElement.style.display = 'none';
  }
  if (searchResults) {
    searchResults.classList.add("hidden");
  }
  if (moviePreview) {
    moviePreview.classList.add("hidden");
  }
  if (submitBtn) {
    submitBtn.classList.add("hidden");
  }
  if (captchaContainer) {
    captchaContainer.classList.add("hidden");
  }
  if (captchaNotice) {
    captchaNotice.classList.add("hidden");
  }

  if (chosenLabel) {
    chosenLabel.textContent = "Final results:";
  }

  if (chosenSection) {
    chosenSection.style.display = hasActiveMovieList ? "block" : "none";
  }

  // Disable clicking on result items
  const chosenList = document.getElementById("chosenList");
  if (chosenList) {
    chosenList.classList.add("no-click");
  }

  displayChosenMovies(true);
}

// Update the share link shown in the footer
async function updateAppLink() {
  const appLink = document.getElementById('appLink');
  if (appLink) {
    const generatedLink = await generateAppLink();
    appLink.href = generatedLink;
  }
}

// Check Firestore voteStatus for a given firestoreEventId
async function getFirestoreVoteStatus(firestoreEventId) {
  try {
    const eventDoc = await getDoc(doc(db, "events", firestoreEventId));
    const eventData = eventDoc.exists() ? (eventDoc.data() || {}) : {};
    return String(eventData.voteStatus || "").trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

// If no explicit event was requested, send user to showtimes list.
// If the current event is ended, also send them to showtimes.
async function redirectIfEndedWithoutExplicitRequest() {
  if (requestedEventId) {
    // User explicitly picked this event; respect that choice.
    return;
  }

  // No event was requested — redirect to showtimes/event selector
  window.location.replace('select-event.html');
}

// Initialize
async function init() {
  removeLegacyTabsUi();
  renderAccountState();
  hideVotingInterface();
  // If an event was explicitly requested in the URL, preserve that exact screening.
  // This avoids heuristics redirecting to a different event when the selected one has no votes yet.
  EVENT_DATA_ID = requestedEventId ? EVENT_ID : await resolveEventDataId(EVENT_ID);
  voterClientId = getOrCreateClientId();
  await loadEventRuntimeSettings();
  await redirectIfEndedWithoutExplicitRequest();
  await routeCurrentVoter();

  await updateAppLink();
}

init();