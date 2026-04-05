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

// Get event ID from URL parameters (default to main event)
const urlParams = new URLSearchParams(window.location.search);
const EVENT_ID = urlParams.get("event") || "newparkway1";

const eventLabel = document.getElementById("eventLabel");
const updatedAtEl = document.getElementById("updatedAt");
const adminList = document.getElementById("adminList");
const backLink = document.querySelector("a[href='index.html']");

if (eventLabel) {
  eventLabel.textContent = `Event: ${EVENT_ID}`;
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

function startLiveListener() {
  const moviesRef = collection(db, "events", EVENT_ID, "movies");

  onSnapshot(moviesRef, (snapshot) => {
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
    startLiveListener();
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
