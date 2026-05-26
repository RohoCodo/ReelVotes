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
const setEventVoteStatusCallable = httpsCallable(functions, "setEventVoteStatus");

// Hardcoded total votes needed to reach goal (same as main app)
const VOTES_NEEDED = 50;

// Admin whitelist (normalized to lowercase)
const ADMIN_EMAILS = new Set([
  "rt332@cornell.edu",
  "moses@thenewparkway.com",
  "programming@thenewparkway.com",
  "nikki@thenewparkwaytheater.com"
]);

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
const voteControlStatusEl = document.getElementById("voteControlStatus");
const eliminationStatusEl = document.getElementById("eliminationStatus");
const adminRequireEmailCheckbox = document.getElementById("adminRequireEmailCheckbox");
const adminMoviesInput = document.getElementById("adminMoviesInput");
const adminSaveBtn = document.getElementById("adminSaveBtn");
const adminSaveStatus = document.getElementById("adminSaveStatus");
let currentAdminEmail = null;
let currentVoteStatus = "live";

// Populate event selector dropdown
function populateSelector() {
  if (!eventSelector) return;
  eventSelector.innerHTML = "";
  if (configuredEvents.length === 0) {
    const opt = document.createElement("option");
    opt.value = currentEventId;
    opt.textContent = currentEventId;
    eventSelector.appendChild(opt);
    return;
  }
  configuredEvents.forEach(ev => {
    const opt = document.createElement("option");
    opt.value = ev.id;
    opt.textContent = `${ev.screeningLabel || ev.id}${ev.voteStatus === 'ended' ? ' (ended)' : ev.voteStatus === 'live' ? ' (live)' : ''}`;
    const resolvedId = EVENT_ID_ALIASES[ev.id] || ev.firestoreEventId || ev.id;
    if (resolvedId === currentEventId || ev.id === (urlEventId || '')) opt.selected = true;
    eventSelector.appendChild(opt);
  });
}
populateSelector();

// Tab switching
const tabResultsBtn = document.getElementById("tabResultsBtn");
const tabEditBtn = document.getElementById("tabEditBtn");
const tabResultsPanel = document.getElementById("tabResults");
const tabEditPanel = document.getElementById("tabEdit");

function showTab(tab) {
  const onResults = tab === "results";
  if (tabResultsPanel) tabResultsPanel.style.display = onResults ? "" : "none";
  if (tabEditPanel) tabEditPanel.style.display = onResults ? "none" : "";
  if (tabResultsBtn) {
    tabResultsBtn.style.background = onResults ? "#ff4757" : "#222";
    tabResultsBtn.style.color = onResults ? "#fff" : "#aaa";
  }
  if (tabEditBtn) {
    tabEditBtn.style.background = onResults ? "#222" : "#ff4757";
    tabEditBtn.style.color = onResults ? "#aaa" : "#fff";
  }
}

if (tabResultsBtn) tabResultsBtn.addEventListener("click", () => showTab("results"));
if (tabEditBtn) tabEditBtn.addEventListener("click", () => showTab("edit"));

// Start on results tab
showTab("results");
function updateEventLabel(firestoreId) {
  const event = resolveEvent(firestoreId);
  const label = event?.screeningLabel || event?.id || firestoreId;
  if (eventLabel) eventLabel.textContent = `Event: ${label}`;
  if (publicPreviewLink) {
    const queryEventId = event?.id || firestoreId;
    publicPreviewLink.href = `index.html?event=${encodeURIComponent(queryEventId)}`;
  }
}
updateEventLabel(currentEventId);

// Render ballot (allowed movies list)
function renderBallot(allowedMovies) {
  const ballotSection = ballotListEl ? ballotListEl.closest('.ballot-section') || ballotListEl.parentElement : null;
  if (!ballotListEl) return;
  ballotListEl.innerHTML = "";
  if (!allowedMovies || allowedMovies.length === 0) {
    // Hide the ballot heading + list entirely
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

function resolveEvent(firestoreId) {
  return configuredEvents.find((event) =>
    (EVENT_ID_ALIASES[event.id] || event.firestoreEventId || event.id) === firestoreId,
  ) || null;
}

function isAdminEmail(email) {
  return ADMIN_EMAILS.has(normalizeEmail(email));
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

function updateEndVoteButton() {
  if (!endVoteBtn) return;
  const isEnded = currentVoteStatus === "ended";
  endVoteBtn.disabled = !currentAdminEmail;
  endVoteBtn.textContent = isEnded ? "Reopen vote" : "End vote";
  endVoteBtn.style.opacity = endVoteBtn.disabled ? "0.6" : "1";
  endVoteBtn.style.cursor = endVoteBtn.disabled ? "not-allowed" : "pointer";
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

  const nextVoteStatus = currentVoteStatus === "ended" ? "live" : "ended";
  const confirmed = window.confirm(
    nextVoteStatus === "ended"
      ? "End voting for this event now? This will block new votes."
      : "Reopen voting for this event now? This will allow new votes.",
  );
  if (!confirmed) {
    return;
  }

  try {
    if (endVoteBtn) {
      endVoteBtn.disabled = true;
      endVoteBtn.textContent = nextVoteStatus === "ended" ? "Ending…" : "Reopening…";
    }
    setVoteControlStatus(nextVoteStatus === "ended" ? "Ending vote..." : "Reopening vote...");

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
        : "Vote reopened. New vote submissions are now allowed.",
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

function renderMovies(movies) {
  if (!adminList) return;

  adminList.innerHTML = "";

  if (!movies.length) {
    const empty = document.createElement("div");
    empty.className = "chosen-movie";
    empty.textContent = "No votes yet";
    adminList.appendChild(empty);
    return;
  }

  const totalVotes = movies.reduce((sum, m) => sum + (m.vote_count || 0), 0);
  const totalEl = document.createElement("div");
  totalEl.style.cssText = "color:#aaa;font-size:13px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #333;";
  totalEl.textContent = `Total votes cast: ${totalVotes}`;
  adminList.appendChild(totalEl);

  movies.forEach((movie) => {
    const voteCount = movie.vote_count || 0;
    const percentage = Math.round((voteCount / VOTES_NEEDED) * 100);

    const item = document.createElement("div");
    item.className = "chosen-movie";
    item.innerHTML = `
      <div class="chosen-movie-title">
        <span>${movie.movie_title || movie.title || movie.id}</span>
      </div>
      <div class="chosen-movie-bar">
        <div class="chosen-movie-fill" style="width: ${Math.min(percentage, 100)}%"></div>
      </div>
      <div class="chosen-movie-count">${voteCount} / ${VOTES_NEEDED} needed</div>
    `;

    adminList.appendChild(item);
  });
}

async function loadAdminControlsForEvent(firestoreId) {
  const configuredEvent = resolveEvent(firestoreId);
  const configuredRequireEmail = configuredEvent?.requireEmail !== false;
  currentVoteStatus = configuredEvent?.voteStatus === "ended" ? "ended" : "live";
  updateEndVoteButton();
  setSaveStatus("Loading settings…");
  setVoteControlStatus("");

  try {
    const [eventDoc, moviesSnapshot] = await Promise.all([
      getDoc(doc(db, "events", firestoreId)),
      getDocs(collection(db, "events", firestoreId, "movies")),
    ]);

    const eventData = eventDoc.exists() ? (eventDoc.data() || {}) : {};
    const runtimeVoteStatus = String(eventData.voteStatus || "").trim().toLowerCase();
    currentVoteStatus = runtimeVoteStatus === "ended" ? "ended" : (configuredEvent?.voteStatus === "ended" ? "ended" : "live");
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

    const titles = moviesSnapshot.docs
      .map((movieDoc) => String(movieDoc.data()?.movie_title || movieDoc.id).trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    if (adminMoviesInput) {
      adminMoviesInput.value = titles.join("\n");
    }

    renderBallot(titles);
    setSaveStatus(`Loaded ${titles.length} movie${titles.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error("Failed loading admin controls:", error);
    setSaveStatus("Could not load settings.", true);
  }
}

async function saveAdminControls() {
  if (!currentEventId) {
    setSaveStatus("No event selected.", true);
    return;
  }

  const rawTitles = String(adminMoviesInput?.value || "")
    .split("\n")
    .map((title) => title.trim())
    .filter(Boolean);
  const dedupedTitles = Array.from(new Map(rawTitles.map((title) => [title.toLowerCase(), title])).values());

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

let unsubscribeLive = null;

function startLiveListener(firestoreId) {
  firestoreId = firestoreId || currentEventId;
  if (unsubscribeLive) { unsubscribeLive(); unsubscribeLive = null; }
  updateEventLabel(firestoreId);
  const moviesRef = collection(db, "events", firestoreId, "movies");

  unsubscribeLive = onSnapshot(moviesRef, (snapshot) => {
    const movies = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      movies.push({ id: doc.id, ...data });
    });

    // Sort by votes desc
    movies.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));

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
  eventSelector.addEventListener("change", () => {
    const selectedId = eventSelector.value;
    const resolved = EVENT_ID_ALIASES[selectedId]
      || configuredEvents.find(e => e.id === selectedId)?.firestoreEventId
      || selectedId;
    currentEventId = resolved;
    currentVoteStatus = "live";
    updateEndVoteButton();
    setVoteControlStatus("");
    startLiveListener(resolved);
    loadAdminControlsForEvent(resolved);
  });
}

if (adminSaveBtn) {
  adminSaveBtn.addEventListener("click", saveAdminControls);
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
  .then((adminEmail) => {
    currentAdminEmail = adminEmail;
    setAdminIdentity(adminEmail);
    startLiveListener(currentEventId);
    loadAdminControlsForEvent(currentEventId);
    if (runEliminationBtn) {
      runEliminationBtn.disabled = false;
      runEliminationBtn.addEventListener("click", runEliminationRoundNow);
    }
    if (endVoteBtn) {
      endVoteBtn.disabled = false;
      endVoteBtn.addEventListener("click", endVoteNow);
      updateEndVoteButton();
    }
  })
  .catch((err) => {
    console.warn("Admin access blocked:", err.message);
    if (runEliminationBtn) {
      runEliminationBtn.disabled = true;
    }
    if (endVoteBtn) {
      endVoteBtn.disabled = true;
    }
  });
