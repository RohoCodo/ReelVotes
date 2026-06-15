import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getFirestore, collection, onSnapshot, orderBy, query, limit } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-functions.js";
import { getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDMa_twNQAZVrnLHUNNNsxk6aTa-9FrnSc",
  authDomain: "reelconvo.firebaseapp.com",
  projectId: "reelconvo",
  storageBucket: "reelconvo.firebasestorage.app",
  messagingSenderId: "913820455359",
  appId: "1:913820455359:web:1c75954a231b921b55510a"
};

let currentAdminEmail = null;
let theatersCache = [];
let currentUser = null;
let currentClaims = {};
let unsubscribeGrossUploads = null;
let currentTheaterKey = "";
let currentTheaterId = "";
let isSuperAdmin = false;
const SUPER_ADMIN_EMAIL = "rt332@cornell.edu";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const storage = getStorage(app);
const listTheatersCallable = httpsCallable(functions, "reelSuccessListTheaters");
const getInsightsCallable = httpsCallable(functions, "reelSuccessGetTheaterInsights");
const getMyTheaterCallable = httpsCallable(functions, "reelSuccessGetMyTheater");
const createGrossUploadSessionCallable = httpsCallable(functions, "reelSuccessCreateGrossUploadSession");
const finalizeGrossUploadCallable = httpsCallable(functions, "reelSuccessFinalizeGrossUpload");
const deleteGrossUploadCallable = httpsCallable(functions, "reelSuccessDeleteGrossUpload");
const provisionMyClaimsCallable = httpsCallable(functions, "reelSuccessProvisionMyClaims");
const syncAccessCallable = httpsCallable(functions, "reelSuccessSyncAccess");
const authProvider = new GoogleAuthProvider();

const theaterSearchInput = document.getElementById("theaterSearchInput");
const myTheaterButton = document.getElementById("myTheaterButton");
const theaterSelect = document.getElementById("theaterSelect");
const theaterSearchResults = document.getElementById("theaterSearchResults");
const statusEl = document.getElementById("reelsuccessStatus");
const identityEl = document.getElementById("reelsuccessIdentity");
const signInBtn = document.getElementById("reelsuccessSignInBtn");
const signOutBtn = document.getElementById("reelsuccessSignOutBtn");

const grossTheaterSearchInput = document.getElementById("grossTheaterSearchInput");
const grossMyTheaterButton = document.getElementById("grossMyTheaterButton");
const grossTheaterSelect = document.getElementById("grossTheaterSelect");
const grossTheaterSearchResults = document.getElementById("grossTheaterSearchResults");
const grossTheaterStatus = document.getElementById("grossTheaterStatus");

const findMovieTabBtn = document.getElementById("findMovieTabBtn");
const grossUploadTabBtn = document.getElementById("grossUploadTabBtn");
const findMovieTabPanel = document.getElementById("findMovieTabPanel");
const grossUploadTabPanel = document.getElementById("grossUploadTabPanel");

const profileEl = document.getElementById("reelsuccessProfile");
const similarSectionEl = document.getElementById("reelsuccessSimilarSection");
const similarBodyEl = document.getElementById("similarTheatersBody");
const recsSectionEl = document.getElementById("reelsuccessRecsSection");
const recsBodyEl = document.getElementById("recommendationsBody");
const demographicsStatusEl = document.getElementById("reelsuccessDemographicsStatus");
const recScoreTabsWrapEl = document.getElementById("reelsuccessScoreTabs");
const recScoreExplainerEl = document.getElementById("reelsuccessScoreExplainer");

// TMDB API Config
const TMDB_API_KEY = "05e2d906f097b769ba4d7e8c7305accf";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_TITLE_OVERRIDES = {
  "blade runner": { tmdbId: 78 },
};

const grossBusinessDateInput = document.getElementById("grossBusinessDateInput");
const grossPdfInput = document.getElementById("grossPdfInput");
const grossUploadBtn = document.getElementById("grossUploadBtn");
const grossUploadProgress = document.getElementById("grossUploadProgress");
const grossUploadsBody = document.getElementById("grossUploadsBody");

let lastLoadedTheaterKey = "";
let searchTimer = null;
let grossSearchTimer = null;
let findAutoSelectTimer = null;
let grossAutoSelectTimer = null;
let recommendationSets = null;
let activeRecommendationScoreKey = "robust_blend";
let movieMetadataCache = new Map();

const RECOMMENDATION_SCORE_META = {
  robust_blend: {
    label: "Robust Blend",
    field: "score_robust_blend",
    explainer: "Best overall: combines base signal, support, lift, and popularity penalty.",
  },
  baseline: {
    label: "Baseline",
    field: "score_baseline",
    explainer: "Original similarity × neighbor movie-signal score.",
  },
  support_boosted: {
    label: "Support Boosted",
    field: "score_support_boosted",
    explainer: "Prioritizes titles supported by more similar theaters.",
  },
  lift_adjusted: {
    label: "Lift Adjusted",
    field: "score_lift_adjusted",
    explainer: "Rewards titles unusually strong among similar theaters vs global rate.",
  },
};

const canUploadForTheater = (theaterId) => {
  if (!theaterId) return false;
  if (currentClaims?.admin === true) return true;
  if (currentClaims?.role === "super_admin" || currentClaims?.role === "admin") return true;
  return String(currentClaims?.theaterId || "") === theaterId;
};

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#ff6b6b" : "#bbb";
}

function setUploadStatus(message, isError = false) {
  if (!grossUploadProgress) return;
  grossUploadProgress.textContent = message || "";
  grossUploadProgress.style.color = isError ? "#ff6b6b" : "#bbb";
}

function setIdentity(text) {
  if (!identityEl) return;
  identityEl.textContent = text;
}

function formatUploadError(error, theaterId = "") {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const looksLikePermissionError =
    code.includes("permission-denied") ||
    message.includes("permission") ||
    message.includes("insufficient permissions") ||
    message.includes("unauthorized");

  if (looksLikePermissionError) {
    const expected = theaterId ? ` Expected theaterId claim: ${theaterId}.` : "";
    return `Missing or insufficient permissions. Your account needs Firebase custom claims (admin=true or matching theaterId).${expected}`;
  }

  return error?.message || "Upload failed.";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toTheaterId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function requireSignedIn() {
  if (!currentUser?.uid) {
    throw new Error("Please sign in first.");
  }
}

async function signInNow() {
  await signInWithPopup(auth, authProvider);
}

function formatAuthError(error) {
  const code = String(error?.code || "").toLowerCase();
  if (code.includes("auth/unauthorized-domain")) {
    return "Sign-in is blocked because this domain is not yet authorized in Firebase Auth.";
  }
  if (code.includes("auth/popup-closed-by-user")) {
    return "Sign-in popup was closed before completing sign-in.";
  }
  return error?.message || "Sign in failed.";
}

async function signOutNow() {
  await signOut(auth);
}

function showTab(tab) {
  const showFind = tab === "find";
  if (findMovieTabPanel) findMovieTabPanel.hidden = !showFind;
  if (grossUploadTabPanel) grossUploadTabPanel.hidden = showFind;
  if (findMovieTabBtn) findMovieTabBtn.classList.toggle("active", showFind);
  if (grossUploadTabBtn) grossUploadTabBtn.classList.toggle("active", !showFind);
}

async function ensureClaimsReady(user, tokenClaims = {}) {
  const role = String(tokenClaims?.role || "").trim().toLowerCase();
  const hasClaims = tokenClaims?.admin === true
    || role === "super_admin"
    || role === "admin"
    || (role === "theater_user" && Boolean(tokenClaims?.theaterId))
    || (role === "theater" && Boolean(tokenClaims?.theaterId));

  if (hasClaims) {
    return tokenClaims;
  }

  try {
    await syncAccessCallable({});
  } catch (error) {
    // Backward-compatible fallback while rolling out updated function set.
    await provisionMyClaimsCallable({});
  }

  const refreshedToken = await user.getIdTokenResult(true);
  return refreshedToken?.claims || {};
}

function getVisibleTheaters(theaters = []) {
  if (isSuperAdmin) {
    return theaters;
  }
  if (!currentClaims?.theaterId) {
    return [];
  }
  return theaters.filter((t) => toTheaterId(t.theater_key) === currentClaims.theaterId);
}

function theaterMatchesQuery(theater, query = "") {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;

  const haystack = [
    theater?.theater_name,
    theater?.theater_city_state,
    theater?.theater_code,
    theater?.theater_key,
  ].map((v) => String(v || "").toLowerCase());

  return haystack.some((text) => text.includes(q));
}

function getFilteredVisibleTheaters(theaters = [], query = "") {
  const visible = getVisibleTheaters(theaters);
  return visible.filter((t) => theaterMatchesQuery(t, query));
}

function clearInlineResults(container) {
  if (!container) return;
  container.innerHTML = "";
  container.classList.add("hidden");
}

function renderInlineResults(container, theaters = [], selectedKey = "", onPick = null) {
  if (!container) return;

  container.innerHTML = "";
  if (!theaters.length) {
    container.classList.add("hidden");
    return;
  }

  theaters.slice(0, 8).forEach((theater) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "reelsuccess-search-result-item";
    if (theater.theater_key === selectedKey) {
      row.classList.add("active");
    }
    row.innerHTML = `
      <span class="title">${escapeHtml(theater.theater_name || "Unknown Theater")}</span>
      <span class="meta">${escapeHtml(theater.theater_city_state || theater.theater_code || "")}</span>
    `;
    row.addEventListener("click", async () => {
      if (typeof onPick === "function") {
        await onPick(theater.theater_key);
      }
    });
    container.appendChild(row);
  });

  container.classList.remove("hidden");
}

function setSearchInputsToSelected(theaterKey) {
  const theater = theatersCache.find((t) => t.theater_key === theaterKey);
  if (!theater) return;
  const label = theater.theater_name || theater.theater_code || theater.theater_key;
  if (theaterSearchInput) theaterSearchInput.value = label;
  if (grossTheaterSearchInput) grossTheaterSearchInput.value = label;
}

function renderTheaterOptions(theaters) {
  theatersCache = theaters || [];
  if (!theaterSelect) return;

  theaterSelect.innerHTML = "";
  
  // Filter theaters based on user role
  let visibleTheaters = theatersCache;
  let isDisabled = false;
  
  if (!isSuperAdmin && currentClaims?.theaterId) {
    // Regular user: only show their assigned theater
    visibleTheaters = theatersCache.filter(t => toTheaterId(t.theater_key) === currentClaims.theaterId);
    if (!visibleTheaters.length) {
      theaterSelect.innerHTML = "<option value=''>Your theater not found</option>";
      theaterSelect.disabled = true;
      isDisabled = true;
    }
  }
  
  if (isDisabled) {
    return;
  }
  
  if (!visibleTheaters.length) {
    theaterSelect.innerHTML = "<option value=''>No theaters found</option>";
    return;
  }

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = isSuperAdmin ? "Select a theater..." : "Select your theater...";
  theaterSelect.appendChild(defaultOption);

  visibleTheaters.forEach((theater) => {
    const opt = document.createElement("option");
    opt.value = theater.theater_key;
    opt.textContent = `${theater.theater_name} — ${theater.theater_city_state}`;
    theaterSelect.appendChild(opt);
  });
  
  theaterSelect.disabled = false;
}

function renderGrossTheaterOptions(theaters) {
  theatersCache = theaters || [];
  if (!grossTheaterSelect) return;

  grossTheaterSelect.innerHTML = "";
  
  // Filter theaters based on user role
  let visibleTheaters = theatersCache;
  let isDisabled = false;
  
  if (!isSuperAdmin && currentClaims?.theaterId) {
    // Regular user: only show their assigned theater
    visibleTheaters = theatersCache.filter(t => toTheaterId(t.theater_key) === currentClaims.theaterId);
    if (!visibleTheaters.length) {
      grossTheaterSelect.innerHTML = "<option value=''>Your theater not found</option>";
      grossTheaterSelect.disabled = true;
      isDisabled = true;
    }
  }
  
  if (isDisabled) {
    return;
  }
  
  if (!visibleTheaters.length) {
    grossTheaterSelect.innerHTML = "<option value=''>No theaters found</option>";
    return;
  }

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = isSuperAdmin ? "Select a theater..." : "Select your theater...";
  grossTheaterSelect.appendChild(defaultOption);

  visibleTheaters.forEach((theater) => {
    const opt = document.createElement("option");
    opt.value = theater.theater_key;
    opt.textContent = `${theater.theater_name} — ${theater.theater_city_state}`;
    grossTheaterSelect.appendChild(opt);
  });
  
  grossTheaterSelect.disabled = false;
}

function setCurrentTheater(theaterKey) {
  currentTheaterKey = String(theaterKey || "").trim();
  currentTheaterId = toTheaterId(currentTheaterKey);
  
  // Get theater info for display
  const selectedTheater = theatersCache.find(t => t.theater_key === theaterKey);
  const theaterDisplay = selectedTheater 
    ? `${selectedTheater.theater_name} (${selectedTheater.theater_city_state})`
    : "No theater selected";
  
  if (!canUploadForTheater(currentTheaterId)) {
    if (grossUploadBtn) grossUploadBtn.disabled = true;
    setUploadStatus(currentTheaterId ? `Read-only access to ${theaterDisplay}` : "Select a theater.");
  } else {
    if (grossUploadBtn) grossUploadBtn.disabled = false;
    setUploadStatus(currentTheaterId ? `Ready to upload to: ${theaterDisplay}` : "Select a theater.");
  }
  startGrossUploadsListener();
}

function setCurrentGrossTheater(theaterKey) {
  currentTheaterKey = String(theaterKey || "").trim();
  currentTheaterId = toTheaterId(currentTheaterKey);
  if (theaterSelect) theaterSelect.value = currentTheaterKey;
  if (grossTheaterSelect) grossTheaterSelect.value = currentTheaterKey;
  if (currentTheaterKey) {
    setSearchInputsToSelected(currentTheaterKey);
  }
  
  // Get theater info for display
  const selectedTheater = theatersCache.find(t => t.theater_key === theaterKey);
  const theaterDisplay = selectedTheater 
    ? `${selectedTheater.theater_name} (${selectedTheater.theater_city_state})`
    : "No theater selected";
  
  if (!canUploadForTheater(currentTheaterId)) {
    if (grossUploadBtn) grossUploadBtn.disabled = true;
    if (grossTheaterStatus) {
      grossTheaterStatus.textContent = currentTheaterId ? `Read-only access to ${theaterDisplay}` : "Select a theater.";
      grossTheaterStatus.style.color = currentTheaterId ? "#ff6b6b" : "#bbb";
    }
  } else {
    if (grossUploadBtn) grossUploadBtn.disabled = false;
    if (grossTheaterStatus) {
      grossTheaterStatus.textContent = currentTheaterId ? `Ready to upload to: ${theaterDisplay}` : "Select a theater.";
      grossTheaterStatus.style.color = "#bbb";
    }
  }
  startGrossUploadsListener();
}

function clearInsights() {
  profileEl?.classList.add("hidden");
  similarSectionEl?.classList.add("hidden");
  recsSectionEl?.classList.add("hidden");
  if (similarBodyEl) similarBodyEl.innerHTML = "";
  if (recsBodyEl) recsBodyEl.innerHTML = "";
  if (demographicsStatusEl) demographicsStatusEl.textContent = "";
  recommendationSets = null;
  lastLoadedTheaterKey = "";
}

function updateDemographicsStatus(profile) {
  if (!demographicsStatusEl) return;
  const status = String(profile?.demographics_status || "").trim().toLowerCase();
  if (status === "matched") {
    demographicsStatusEl.textContent = "Demographics: available and included in scoring.";
    demographicsStatusEl.style.color = "#8fe388";
    return;
  }
  if (status) {
    demographicsStatusEl.textContent = `Demographics: missing (${status}). Similarity currently relies on historical and operational features.`;
    demographicsStatusEl.style.color = "#ffb36b";
    return;
  }
  demographicsStatusEl.textContent = "";
}

async function searchTMDB(query) {
  try {
    const response = await fetch(`${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`);
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error("TMDB search error:", error);
    return [];
  }
}

async function getMovieDetails(movieId) {
  try {
    const response = await fetch(`${TMDB_BASE_URL}/movie/${movieId}?api_key=${TMDB_API_KEY}&append_to_response=credits`);
    return await response.json();
  } catch (error) {
    console.error("Error fetching movie details:", error);
    return null;
  }
}

function buildPosterUrl(posterPath, size = "w185") {
  return posterPath ? `https://image.tmdb.org/t/p/${size}${posterPath}` : null;
}

async function getMovieMetadataByTitle(title) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) {
    return { tmdbId: null, poster: null };
  }

  if (movieMetadataCache.has(normalizedTitle)) {
    return movieMetadataCache.get(normalizedTitle);
  }

  try {
    const normalizedLookup = normalizedTitle.toLowerCase();
    const override = TMDB_TITLE_OVERRIDES[normalizedLookup];

    if (override?.tmdbId) {
      const details = await getMovieDetails(override.tmdbId);
      const metadata = {
        tmdbId: override.tmdbId,
        poster: buildPosterUrl(details?.poster_path),
      };
      movieMetadataCache.set(normalizedTitle, metadata);
      return metadata;
    }

    const results = await searchTMDB(normalizedTitle);
    const match = results.find((movie) => movie.title?.trim().toLowerCase() === normalizedLookup) || results[0];
    const metadata = {
      tmdbId: match?.id || null,
      poster: buildPosterUrl(match?.poster_path),
    };
    movieMetadataCache.set(normalizedTitle, metadata);
    return metadata;
  } catch (error) {
    console.error("Error fetching movie metadata:", error);
    const metadata = { tmdbId: null, poster: null };
    movieMetadataCache.set(normalizedTitle, metadata);
    return metadata;
  }
}

function getRecommendationsForScoreKey(scoreKey) {
  if (!recommendationSets) return [];
  const byScore = recommendationSets?.recommendations_by_score || null;
  if (byScore && Array.isArray(byScore[scoreKey]) && byScore[scoreKey].length) {
    return byScore[scoreKey];
  }
  return recommendationSets?.recommendations || [];
}

function updateRecommendationScoreTabsUI() {
  if (!recScoreTabsWrapEl) return;
  const buttons = recScoreTabsWrapEl.querySelectorAll(".reelsuccess-score-tab-btn");
  buttons.forEach((btn) => {
    const scoreKey = btn.dataset?.scoreKey || "";
    btn.classList.toggle("active", scoreKey === activeRecommendationScoreKey);
  });

  if (recScoreExplainerEl) {
    recScoreExplainerEl.textContent = RECOMMENDATION_SCORE_META[activeRecommendationScoreKey]?.explainer || "";
  }
}

async function selectAndLoadTheater(theaterKey) {
  if (!theaterKey) {
    if (theaterSelect) theaterSelect.value = "";
    if (grossTheaterSelect) grossTheaterSelect.value = "";
    setCurrentTheater("");
    clearInsights();
    return;
  }

  if (theaterSelect) theaterSelect.value = theaterKey;
  if (grossTheaterSelect) grossTheaterSelect.value = theaterKey;
  setSearchInputsToSelected(theaterKey);
  setCurrentTheater(theaterKey);
  if (lastLoadedTheaterKey === theaterKey) {
    setStatus(`Insights loaded for ${theaterSelect?.selectedOptions?.[0]?.textContent || "theater"}.`);
    return;
  }

  await loadInsights(theaterKey);
}

function renderProfile(profile) {
  if (!profileEl) return;
  if (!profile) {
    profileEl.classList.add("hidden");
    updateDemographicsStatus(null);
    return;
  }

  profileEl.classList.remove("hidden");
  profileEl.innerHTML = `
    <h2>${escapeHtml(profile.theater_name)}</h2>
    <p style="margin-top:0;color:#cfcfcf;">${escapeHtml(profile.theater_city_state)}</p>
    <div class="reelsuccess-stats-grid">
      <div><strong>${Number(profile.population || 0).toLocaleString()}</strong><span>Population</span></div>
      <div><strong>$${Number(profile.median_household_income || 0).toLocaleString()}</strong><span>Median income</span></div>
      <div><strong>${Number(profile.median_age || 0).toFixed(1)}</strong><span>Median age</span></div>
      <div><strong>${Number(profile.unique_movies || 0)}</strong><span>Unique movies</span></div>
    </div>
  `;
  updateDemographicsStatus(profile);
}

function renderSimilarTheaters(rows) {
  if (!similarBodyEl || !similarSectionEl) return;
  similarBodyEl.innerHTML = "";
  if (!rows || !rows.length) {
    similarSectionEl.classList.add("hidden");
    return;
  }

  similarSectionEl.classList.remove("hidden");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.theater_name)}</td>
      <td>${escapeHtml(row.theater_city_state)}</td>
      <td>${Number(row.score || 0).toFixed(3)}</td>
    `;
    similarBodyEl.appendChild(tr);
  });
}

async function renderRecommendations(rows, scoreKey = activeRecommendationScoreKey) {
  if (!recsBodyEl || !recsSectionEl) return;
  recsBodyEl.innerHTML = "";
  const scoreField = RECOMMENDATION_SCORE_META[scoreKey]?.field || "recommendation_score";
  if (!rows || !rows.length) {
    recsSectionEl.classList.add("hidden");
    return;
  }

  recsSectionEl.classList.remove("hidden");
  for (const row of rows) {
    const displayScore = Number(row?.[scoreField] ?? row?.recommendation_score ?? 0);
    const metadata = row?.posterUrl || row?.poster || row?.poster_url
      ? { poster: row.posterUrl || row.poster || row.poster_url }
      : await getMovieMetadataByTitle(row.movie_title);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="reelsuccess-rec-title-cell">
        <div class="reelsuccess-rec-movie-cell">
          ${metadata.poster ? `<img class="reelsuccess-rec-poster" src="${metadata.poster}" alt="${escapeHtml(row.movie_title)} poster" loading="lazy" />` : `<div class="reelsuccess-rec-poster reelsuccess-rec-poster-fallback" aria-hidden="true"></div>`}
          <span class="reelsuccess-rec-title">${escapeHtml(row.movie_title)}</span>
        </div>
      </td>
      <td>${displayScore.toFixed(3)}</td>
      <td>${Number(row.support_theater_count || 0)}</td>
    `;
    recsBodyEl.appendChild(tr);
  }

  updateRecommendationScoreTabsUI();
}

async function loadTheaters(query = "") {
  requireSignedIn();
  setStatus("Loading theaters...");
  const result = await listTheatersCallable({
    adminEmail: currentAdminEmail,
    query,
    limit: 100,
  });

  const theaters = result?.data?.theaters || [];
  renderTheaterOptions(theaters);
  renderGrossTheaterOptions(theaters);
  setStatus(`Loaded ${result?.data?.total || theaters.length} theaters.`);
  return theaters;
}

async function loadInsights(theaterKey) {
  if (!theaterKey) return;
  requireSignedIn();

  setStatus("Loading insights...");
  const result = await getInsightsCallable({
    adminEmail: currentAdminEmail,
    theaterKey,
  });

  const data = result?.data || {};
  recommendationSets = {
    recommendations: data.recommendations || [],
    recommendations_by_score: data.recommendations_by_score || null,
  };
  renderProfile(data.profile || null);
  renderSimilarTheaters(data.similar_theaters || []);
  renderRecommendations(getRecommendationsForScoreKey(activeRecommendationScoreKey), activeRecommendationScoreKey);
  lastLoadedTheaterKey = theaterKey;
  setStatus(`Insights loaded for ${data?.profile?.theater_name || "theater"}.`);
}

function bindRecommendationScoreTabs() {
  if (!recScoreTabsWrapEl) return;
  const buttons = recScoreTabsWrapEl.querySelectorAll(".reelsuccess-score-tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const scoreKey = String(btn.dataset?.scoreKey || "").trim();
      if (!RECOMMENDATION_SCORE_META[scoreKey]) return;
      activeRecommendationScoreKey = scoreKey;
      const rows = getRecommendationsForScoreKey(scoreKey);
      renderRecommendations(rows, scoreKey);
    });
  });
  updateRecommendationScoreTabsUI();
}

async function searchAndAutoSelect(query = "") {
  const theaters = await loadTheaters(query);
  const visibleTheaters = getFilteredVisibleTheaters(theaters, query);
  
  const firstTheaterKey = visibleTheaters?.[0]?.theater_key || "";

  if (!firstTheaterKey) {
    clearInlineResults(theaterSearchResults);
    clearInlineResults(grossTheaterSearchResults);
    clearInsights();
    const msg = !isSuperAdmin && currentClaims?.theaterId 
      ? "Your theater is not in the database." 
      : query ? "No theaters found for that search." : "No theaters found.";
    setStatus(msg, true);
    return;
  }

  await selectAndLoadTheater(firstTheaterKey);
  renderInlineResults(theaterSearchResults, visibleTheaters, firstTheaterKey, async (theaterKey) => {
    await selectAndLoadTheater(theaterKey);
    clearInlineResults(theaterSearchResults);
  });
  renderInlineResults(grossTheaterSearchResults, visibleTheaters, firstTheaterKey, async (theaterKey) => {
    setCurrentGrossTheater(theaterKey);
    clearInlineResults(grossTheaterSearchResults);
  });
}

async function searchWithoutChangingSelection(query = "") {
  const previousTheaterKey = String(currentTheaterKey || "").trim();
  const theaters = await loadTheaters(query);
  const visibleTheaters = getFilteredVisibleTheaters(theaters, query);

  renderInlineResults(theaterSearchResults, visibleTheaters, previousTheaterKey, async (theaterKey) => {
    cancelPendingSearch();
    await selectAndLoadTheater(theaterKey);
    clearInlineResults(theaterSearchResults);
  });

  if (!visibleTheaters.length) {
    clearInlineResults(theaterSearchResults);
    setCurrentTheater("");
    clearInsights();
    setStatus(query ? "No theaters found for that search." : "No theaters found.", true);
    return;
  }

  if (findAutoSelectTimer) {
    window.clearTimeout(findAutoSelectTimer);
    findAutoSelectTimer = null;
  }

  if (visibleTheaters.length === 1) {
    const only = visibleTheaters[0];
    findAutoSelectTimer = window.setTimeout(async () => {
      if (String(theaterSearchInput?.value || "") !== String(query || "")) return;
      await selectAndLoadTheater(only.theater_key);
      clearInlineResults(theaterSearchResults);
    }, 220);
    setStatus("1 theater match found. Auto-selecting...", false);
    return;
  }

  if (previousTheaterKey && visibleTheaters.some((t) => t.theater_key === previousTheaterKey)) {
    if (theaterSelect) {
      theaterSelect.value = previousTheaterKey;
    }
    setStatus(`Found ${visibleTheaters.length} theater${visibleTheaters.length === 1 ? "" : "s"}.`);
    return;
  }

  if (theaterSelect) {
    theaterSelect.value = "";
  }
  setCurrentTheater("");
  clearInsights();
  setStatus(`Found ${visibleTheaters.length} theater${visibleTheaters.length === 1 ? "" : "s"}. Pick one from the list below.`);
}

function cancelPendingSearch() {
  if (searchTimer) {
    window.clearTimeout(searchTimer);
    searchTimer = null;
  }
}

function scheduleSearch() {
  cancelPendingSearch();
  searchTimer = window.setTimeout(async () => {
    searchTimer = null;
    try {
      await searchWithoutChangingSelection(theaterSearchInput?.value || "");
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Search failed.", true);
    }
  }, 250);
}

async function runSearchNow() {
  cancelPendingSearch();
  await searchWithoutChangingSelection(theaterSearchInput?.value || "");
}

function cancelGrossSearch() {
  if (grossSearchTimer) {
    window.clearTimeout(grossSearchTimer);
    grossSearchTimer = null;
  }
}

function scheduleGrossSearch() {
  cancelGrossSearch();
  grossSearchTimer = window.setTimeout(async () => {
    grossSearchTimer = null;
    try {
      await searchGrossWithoutChangingSelection(grossTheaterSearchInput?.value || "");
    } catch (error) {
      console.error(error);
      if (grossTheaterStatus) grossTheaterStatus.textContent = error?.message || "Search failed.";
      if (grossTheaterStatus) grossTheaterStatus.style.color = "#ff6b6b";
    }
  }, 250);
}

async function runGrossSearchNow() {
  cancelGrossSearch();
  await searchGrossWithoutChangingSelection(grossTheaterSearchInput?.value || "");
}

async function searchGrossWithoutChangingSelection(query = "") {
  const previousTheaterKey = String(currentTheaterKey || "").trim();
  const theaters = await loadTheaters(query);
  const visibleTheaters = getFilteredVisibleTheaters(theaters, query);

  renderInlineResults(grossTheaterSearchResults, visibleTheaters, previousTheaterKey, async (theaterKey) => {
    cancelGrossSearch();
    setCurrentGrossTheater(theaterKey);
    clearInlineResults(grossTheaterSearchResults);
  });

  if (!visibleTheaters.length) {
    clearInlineResults(grossTheaterSearchResults);
    setCurrentTheater("");
    if (grossTheaterStatus) {
      grossTheaterStatus.textContent = query ? "No theaters found for that search." : "No theaters found.";
      grossTheaterStatus.style.color = "#ff6b6b";
    }
    return;
  }

  if (grossAutoSelectTimer) {
    window.clearTimeout(grossAutoSelectTimer);
    grossAutoSelectTimer = null;
  }

  if (visibleTheaters.length === 1) {
    const only = visibleTheaters[0];
    grossAutoSelectTimer = window.setTimeout(() => {
      if (String(grossTheaterSearchInput?.value || "") !== String(query || "")) return;
      setCurrentGrossTheater(only.theater_key);
      clearInlineResults(grossTheaterSearchResults);
    }, 220);
    if (grossTheaterStatus) {
      grossTheaterStatus.textContent = "1 theater match found. Auto-selecting...";
      grossTheaterStatus.style.color = "#bbb";
    }
    return;
  }

  if (previousTheaterKey && visibleTheaters.some((t) => t.theater_key === previousTheaterKey)) {
    if (grossTheaterSelect) {
      grossTheaterSelect.value = previousTheaterKey;
    }
    if (grossTheaterStatus) {
      grossTheaterStatus.textContent = `Found ${visibleTheaters.length} theater${visibleTheaters.length === 1 ? "" : "s"}.`;
      grossTheaterStatus.style.color = "#bbb";
    }
    return;
  }

  if (grossTheaterSelect) {
    grossTheaterSelect.value = "";
  }
  setCurrentTheater("");
  if (grossTheaterStatus) {
    grossTheaterStatus.textContent = `Found ${visibleTheaters.length} theater${visibleTheaters.length === 1 ? "" : "s"}. Pick one from the list below.`;
    grossTheaterStatus.style.color = "#bbb";
  }
}

async function loadGrossMyTheater() {
  requireSignedIn();
  if (grossTheaterStatus) {
    grossTheaterStatus.textContent = "Finding your theater...";
    grossTheaterStatus.style.color = "#bbb";
  }
  const result = await getMyTheaterCallable({
    adminEmail: currentAdminEmail,
  });

  const theater = result?.data?.theater || null;
  if (!theater?.theater_key) {
    throw new Error("No theater is linked to this ReelSuccess account yet.");
  }

  if (grossTheaterSearchInput) {
    grossTheaterSearchInput.value = theater.theater_name || theater.theater_code || "";
  }

  renderGrossTheaterOptions([theater]);
  setCurrentGrossTheater(theater.theater_key);
  clearInlineResults(grossTheaterSearchResults);
}

async function loadMyTheater() {
  requireSignedIn();
  setStatus("Finding your theater...");
  const result = await getMyTheaterCallable({
    adminEmail: currentAdminEmail,
  });

  const theater = result?.data?.theater || null;
  if (!theater?.theater_key) {
    throw new Error("No theater is linked to this ReelSuccess account yet.");
  }

  if (theaterSearchInput) {
    theaterSearchInput.value = theater.theater_name || theater.theater_code || "";
  }

  renderTheaterOptions([theater]);
  await selectAndLoadTheater(theater.theater_key);
  clearInlineResults(theaterSearchResults);
}

function renderGrossUploads(rows) {
  if (!grossUploadsBody) return;

  if (!rows.length) {
    grossUploadsBody.innerHTML = "<tr><td colspan='4' style='text-align:center;color:#aaa;'>No uploads yet.</td></tr>";
    return;
  }

  grossUploadsBody.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const uploadedAt = row.uploadedAt?.toDate ? row.uploadedAt.toDate().toLocaleString() : "—";
    tr.innerHTML = `
      <td>${escapeHtml(row.businessDate || "—")}</td>
      <td>${escapeHtml(row.fileName || "—")}</td>
      <td>${escapeHtml(uploadedAt)}</td>
      <td>
        <button type="button" class="reelsuccess-any-button" data-action="open" data-path="${escapeHtml(row.storagePath || "")}" style="padding:6px 10px;">Open</button>
        <button type="button" class="reelsuccess-any-button" data-action="delete" data-id="${escapeHtml(row.id || "")}" style="padding:6px 10px;">Delete</button>
      </td>
    `;
    grossUploadsBody.appendChild(tr);
  });
}

function stopGrossUploadsListener() {
  if (unsubscribeGrossUploads) {
    unsubscribeGrossUploads();
    unsubscribeGrossUploads = null;
  }
}

function startGrossUploadsListener() {
  stopGrossUploadsListener();
  if (!currentTheaterId || !currentUser?.uid) {
    renderGrossUploads([]);
    return;
  }

  const uploadsRef = collection(db, "theaters", currentTheaterId, "grossUploads");
  const uploadsQuery = query(uploadsRef, orderBy("businessDate", "desc"), orderBy("uploadedAt", "desc"), limit(100));
  unsubscribeGrossUploads = onSnapshot(uploadsQuery, (snapshot) => {
    const rows = snapshot.docs.map((d) => ({id: d.id, ...(d.data() || {})}));
    renderGrossUploads(rows);
  }, (error) => {
    console.error(error);
    setUploadStatus(formatUploadError(error, currentTheaterId) || "Failed to load uploads.", true);
  });
}

async function uploadGrossPdf() {
  requireSignedIn();

  if (!currentTheaterKey || !currentTheaterId) {
    throw new Error("Select a theater first.");
  }
  if (!canUploadForTheater(currentTheaterId)) {
    throw new Error("You do not have upload access for this theater.");
  }
  
  // Non-super-admin users can only upload to their assigned theater
  if (!isSuperAdmin && currentClaims?.theaterId && currentTheaterId !== currentClaims.theaterId) {
    throw new Error(`You can only upload to your assigned theater. Your theater ID: ${currentClaims.theaterId}`);
  }

  const businessDate = String(grossBusinessDateInput?.value || "").trim();
  const files = Array.from(grossPdfInput?.files || []);
  if (!businessDate) {
    throw new Error("Choose a business date.");
  }
  if (files.length === 0) {
    throw new Error("Choose at least one PDF file.");
  }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const isPdf = file.type === "application/pdf" || String(file.name || "").toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      throw new Error(`Only PDF files are allowed: ${file.name || "unknown file"}`);
    }

    setUploadStatus(`Creating upload session (${i + 1}/${files.length})...`);
    const sessionResponse = await createGrossUploadSessionCallable({
      theaterKey: currentTheaterKey,
      businessDate,
      fileName: file.name,
      contentType: file.type || "application/pdf",
      size: file.size,
    });

    const storagePath = sessionResponse?.data?.storagePath;
    if (!storagePath) {
      throw new Error("Upload session failed.");
    }

    const uploadRef = storageRef(storage, storagePath);
    const task = uploadBytesResumable(uploadRef, file, {
      contentType: "application/pdf",
      customMetadata: {
        theaterKey: currentTheaterKey,
        businessDate,
      },
    });

    await new Promise((resolve, reject) => {
      task.on("state_changed", (snapshot) => {
        const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        setUploadStatus(`Uploading ${i + 1}/${files.length}... ${pct}%`);
      }, reject, resolve);
    });

    setUploadStatus(`Finalizing ${i + 1}/${files.length}...`);
    await finalizeGrossUploadCallable({
      theaterKey: currentTheaterKey,
      businessDate,
      fileName: file.name,
      storagePath,
    });
  }

  if (grossPdfInput) grossPdfInput.value = "";
  setUploadStatus(`Upload complete. ${files.length} file${files.length === 1 ? "" : "s"} saved.`);
}

async function openGrossUpload(storagePath) {
  if (!storagePath) return;
  const url = await getDownloadURL(storageRef(storage, storagePath));
  window.open(url, "_blank", "noopener,noreferrer");
}

async function deleteGrossUpload(uploadId) {
  requireSignedIn();
  if (!uploadId) {
    throw new Error("Missing upload id.");
  }
  if (!window.confirm("Delete this upload?")) {
    return;
  }

  setUploadStatus("Deleting upload...");
  await deleteGrossUploadCallable({
    theaterKey: currentTheaterKey,
    uploadId,
  });
  setUploadStatus("Upload deleted.");
}

function bindGrossUploadsActions() {
  grossUploadsBody?.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const action = target.dataset?.action;
    if (!action) {
      return;
    }

    try {
      if (action === "open") {
        await openGrossUpload(target.dataset?.path || "");
        return;
      }
      if (action === "delete") {
        await deleteGrossUpload(target.dataset?.id || "");
      }
    } catch (error) {
      console.error(error);
      setUploadStatus(error?.message || "Action failed.", true);
    }
  });
}

function bindAuth() {
  signInBtn?.addEventListener("click", async () => {
    try {
      await signInNow();
    } catch (error) {
      console.error(error);
      setStatus(formatAuthError(error), true);
    }
  });

  signOutBtn?.addEventListener("click", async () => {
    try {
      await signOutNow();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Sign out failed.", true);
    }
  });

  onAuthStateChanged(auth, async (user) => {
    currentUser = user || null;
    currentAdminEmail = normalizeEmail(user?.email || "");
    isSuperAdmin = false;

    if (!user) {
      currentClaims = {};
      isSuperAdmin = false;
      setIdentity("Not signed in.");
      if (signInBtn) signInBtn.style.display = "";
      if (signOutBtn) signOutBtn.style.display = "none";
      renderTheaterOptions([]);
      renderGrossTheaterOptions([]);
      clearInlineResults(theaterSearchResults);
      clearInlineResults(grossTheaterSearchResults);
      clearInsights();
      setCurrentTheater("");
      setStatus("Sign in with an authorized account.");
      return;
    }

    try {
      const tokenResult = await user.getIdTokenResult();
      currentClaims = await ensureClaimsReady(user, tokenResult?.claims || {});
      isSuperAdmin = currentClaims?.admin === true
        || String(currentClaims?.role || "").toLowerCase() === "super_admin"
        || normalizeEmail(user?.email || "") === SUPER_ADMIN_EMAIL;
    } catch (error) {
      console.error(error);
      currentClaims = {};
      isSuperAdmin = false;
      setIdentity(`Signed in as ${user.email || user.uid}`);
      setStatus(error?.message || "This account is not provisioned for ReelSuccess yet.", true);
      setCurrentTheater("");
      return;
    }
    
    const role = String(currentClaims?.role || "").toLowerCase();
    const roleText = isSuperAdmin ? " (Super Admin)" : role === "theater_user" || role === "theater" ? " (Theater User)" : "";
    setIdentity(`Signed in as ${user.email || user.uid}${roleText}`);
    if (signInBtn) signInBtn.style.display = "none";
    if (signOutBtn) signOutBtn.style.display = "";

    try {
      await searchAndAutoSelect("");
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Unable to load ReelSuccess.", true);
    }
  });
}

async function bootstrap() {
  try {
    bindAuth();
    bindGrossUploadsActions();
    bindRecommendationScoreTabs();

    findMovieTabBtn?.addEventListener("click", () => showTab("find"));
    grossUploadTabBtn?.addEventListener("click", () => showTab("upload"));
    showTab("find");

    theaterSelect?.addEventListener("change", async () => {
      try {
        cancelPendingSearch();
        await selectAndLoadTheater(theaterSelect.value);
        clearInlineResults(theaterSearchResults);
        // Sync gross upload dropdown
        if (grossTheaterSelect) {
          grossTheaterSelect.value = theaterSelect.value;
        }
      } catch (error) {
        console.error(error);
        setStatus(error?.message || "Failed to load insights.", true);
      }
    });

    grossTheaterSelect?.addEventListener("change", async () => {
      try {
        cancelGrossSearch();
        setCurrentGrossTheater(grossTheaterSelect.value);
        clearInlineResults(grossTheaterSearchResults);
        // Sync find movie dropdown
        if (theaterSelect) {
          theaterSelect.value = grossTheaterSelect.value;
        }
      } catch (error) {
        console.error(error);
        if (grossTheaterStatus) {
          grossTheaterStatus.textContent = error?.message || "Failed to select theater.";
          grossTheaterStatus.style.color = "#ff6b6b";
        }
      }
    });

    theaterSearchInput?.addEventListener("input", () => {
      try {
        scheduleSearch();
      } catch (error) {
        console.error(error);
        setStatus(error?.message || "Search failed.", true);
      }
    });

    theaterSearchInput?.addEventListener("focus", () => {
      const query = theaterSearchInput.value || "";
      const visibleTheaters = getFilteredVisibleTheaters(theatersCache, query);
      renderInlineResults(theaterSearchResults, visibleTheaters, currentTheaterKey, async (theaterKey) => {
        await selectAndLoadTheater(theaterKey);
        clearInlineResults(theaterSearchResults);
      });
    });

    grossTheaterSearchInput?.addEventListener("input", () => {
      try {
        scheduleGrossSearch();
      } catch (error) {
        console.error(error);
        if (grossTheaterStatus) {
          grossTheaterStatus.textContent = error?.message || "Search failed.";
          grossTheaterStatus.style.color = "#ff6b6b";
        }
      }
    });

    grossTheaterSearchInput?.addEventListener("focus", () => {
      const query = grossTheaterSearchInput.value || "";
      const visibleTheaters = getFilteredVisibleTheaters(theatersCache, query);
      renderInlineResults(grossTheaterSearchResults, visibleTheaters, currentTheaterKey, async (theaterKey) => {
        setCurrentGrossTheater(theaterKey);
        clearInlineResults(grossTheaterSearchResults);
      });
    });

    theaterSearchInput?.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      try {
        await runSearchNow();
      } catch (error) {
        console.error(error);
        setStatus(error?.message || "Search failed.", true);
      }
    });

    grossTheaterSearchInput?.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") {
        return;
      }

      event.preventDefault();
      try {
        await runGrossSearchNow();
      } catch (error) {
        console.error(error);
        if (grossTheaterStatus) {
          grossTheaterStatus.textContent = error?.message || "Search failed.";
          grossTheaterStatus.style.color = "#ff6b6b";
        }
      }
    });

    myTheaterButton?.addEventListener("click", async () => {
      try {
        cancelPendingSearch();
        await loadMyTheater();
      } catch (error) {
        console.error(error);
        setStatus(error?.message || "Unable to load your theater.", true);
      }
    });

    grossMyTheaterButton?.addEventListener("click", async () => {
      try {
        cancelGrossSearch();
        await loadGrossMyTheater();
      } catch (error) {
        console.error(error);
        if (grossTheaterStatus) {
          grossTheaterStatus.textContent = error?.message || "Unable to load your theater.";
          grossTheaterStatus.style.color = "#ff6b6b";
        }
      }
    });

    grossUploadBtn?.addEventListener("click", async () => {
      try {
        if (grossUploadBtn) grossUploadBtn.disabled = true;
        await uploadGrossPdf();
      } catch (error) {
        console.error(error);
        setUploadStatus(formatUploadError(error, currentTheaterId), true);
      } finally {
        if (grossUploadBtn) grossUploadBtn.disabled = !canUploadForTheater(currentTheaterId);
      }
    });

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      if (!target.closest("#theaterSearchInput") && !target.closest("#theaterSearchResults")) {
        clearInlineResults(theaterSearchResults);
      }
      if (!target.closest("#grossTheaterSearchInput") && !target.closest("#grossTheaterSearchResults")) {
        clearInlineResults(grossTheaterSearchResults);
      }
    });
  } catch (error) {
    console.error(error);
    setStatus(error?.message || "Unable to initialize ReelSuccess.", true);
  }
}

bootstrap();
