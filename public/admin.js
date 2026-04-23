import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

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
let currentEventId = urlEventId
  ? (EVENT_ID_ALIASES[urlEventId] || configuredEvents.find(e => e.id === urlEventId)?.firestoreEventId || urlEventId)
  : (configuredEvents[0]?.firestoreEventId || "newparkway1");

const eventLabel = document.getElementById("eventLabel");
const updatedAtEl = document.getElementById("updatedAt");
const adminList = document.getElementById("adminList");
const ballotListEl = document.getElementById("ballotList");
const eventSelector = document.getElementById("eventSelector");
const backLink = document.querySelector("a[href='index.html']");

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

// Update event label
function updateEventLabel(firestoreId) {
  if (eventLabel) eventLabel.textContent = `Firestore event: ${firestoreId}`;
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

function isAdminEmail(email) {
  return ADMIN_EMAILS.has(normalizeEmail(email));
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

let unsubscribeLive = null;

function fetchBallotForEvent(firestoreId) {
  // Look up the event in events-config.js by firestoreEventId
  const ev = configuredEvents.find(e =>
    (EVENT_ID_ALIASES[e.id] || e.firestoreEventId || e.id) === firestoreId
  );
  // Return the event's allowedMovies if defined; undefined/null means "not configured"
  return ev && Array.isArray(ev.allowedMovies) ? ev.allowedMovies : null;
}

function startLiveListener(firestoreId) {
  firestoreId = firestoreId || currentEventId;
  if (unsubscribeLive) { unsubscribeLive(); unsubscribeLive = null; }
  updateEventLabel(firestoreId);
  renderBallot(fetchBallotForEvent(firestoreId));
  const moviesRef = collection(db, "events", firestoreId, "movies");

  unsubscribeLive = onSnapshot(moviesRef, (snapshot) => {
    const movies = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      movies.push({ id: doc.id, ...data });
    });

    // Sort by votes desc
    movies.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));

    renderMovies(movies);

    if (updatedAtEl) {
      const now = new Date();
      updatedAtEl.textContent = `Last updated: ${now.toLocaleTimeString()}`;
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
    startLiveListener(resolved);
  });
}

async function ensureAdminAccess() {
  const STORAGE_KEY = "reelvotes_admin_email";

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && isAdminEmail(stored)) {
    return stored;
  }

  // Simple prompt-based gate; production users won't see this link.
  const input = window.prompt("Admin access only. Enter your theater email to continue:");
  const email = normalizeEmail(input);

  if (!email || !isAdminEmail(email)) {
    if (adminList) {
      adminList.innerHTML = "";
      const denied = document.createElement("div");
      denied.className = "chosen-movie";
      denied.textContent = "Access denied. This view is only for authorized staff.";
      adminList.appendChild(denied);
    }
    if (updatedAtEl) {
      updatedAtEl.textContent = "";
    }
    throw new Error("Unauthorized admin email");
  }

  window.localStorage.setItem(STORAGE_KEY, email);
  return email;
}

ensureAdminAccess()
  .then(() => {
    startLiveListener(currentEventId);
  })
  .catch((err) => {
    console.warn("Admin access blocked:", err.message);
  });

if (backLink) {
	backLink.addEventListener("click", (event) => {
		event.preventDefault();
		window.location.href = "index.html";
	});
}
