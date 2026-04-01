import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
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

// Restricted list - movies that cannot be voted for
const RESTRICTED_MOVIES = new Set([]);

// Allowed movies - only these can be voted for
const ALLOWED_MOVIES = [
  "Clueless",
  "The Fifth Element",
  "The Matrix",
  "The Hangover",
  "Bridesmaids",
  "Superbad",
  "8 Mile",
  "Saw",
  "Shrek",
  "The Truman Show"
];

let selectedMovie = null;
let selectedMovieCard = null;
let chosenMovies = [];
let voterClientId = null;
const movieMetadataCache = new Map();

// Hardcoded total votes needed to reach goal
const VOTES_NEEDED = 50;

// Get event ID from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const EVENT_ID = urlParams.get("event") || "newparkway1";

const VOTER_CLIENT_ID_KEY = (eventId) => `voterClientId_${eventId}`;
const CAST_VOTE_KEY = (eventId) => `castVote_${eventId}`;

const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const moviePreview = document.getElementById("moviePreview");
const chosenList = document.getElementById("chosenList");
const chosenSection = document.getElementById("chosenMovies");
const submitBtn = document.getElementById("submitBtn");
const resultsDiv = document.getElementById("results");
const clearSearchBtn = document.getElementById("clearSearchBtn");
const captchaContainer = document.getElementById("captchaContainer");
const captchaNotice = document.getElementById("captchaNotice");

let captchaToken = null;
let captchaWidgetId = null;

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
  const hasSelectedMovie = Boolean(selectedMovie);
  submitBtn.disabled = !hasSelectedMovie || (CAPTCHA_ENABLED && !captchaToken);
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
  if (!selectedMovie) {
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

function persistCastVote(movieTitle) {
  window.localStorage.setItem(CAST_VOTE_KEY(EVENT_ID), JSON.stringify({
    title: movieTitle,
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

async function getExistingVote() {
  const localVote = getPersistedCastVote();
  if (localVote?.title) {
    return {
      title: localVote.title,
      vote_count: 0,
      year: null
    };
  }

  const response = await getVoteStatusCallable({
    eventId: EVENT_ID,
    clientId: voterClientId
  });

  if (!response.data?.hasVoted || !response.data.movieTitle) {
    return null;
  }

  persistCastVote(response.data.movieTitle);
  return {
    title: response.data.movieTitle,
    vote_count: 0,
    year: null
  };
}

async function routeCurrentVoter() {
  const existingVote = await getExistingVote();
  if (existingVote) {
    await fetchChosenMovies();
    await showExistingVoteConfirmation(existingVote);
    return;
  }

  await fetchChosenMovies();
  showVotingInterface();
}

// Fetch active movies from Firebase
async function fetchChosenMovies() {
  try {
    console.log("Fetching votes from Firebase...");
    // Fetch from the new movies collection under events/{event_id}/movies/
    const moviesRef = collection(db, "events", EVENT_ID, "movies");
    const querySnapshot = await getDocs(moviesRef);
    
    console.log("Query snapshot size:", querySnapshot.size);
    
    const moviesArray = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      moviesArray.push({
        id: doc.id,
        title: data.movie_title,
        vote_count: data.vote_count || 0,
        year: null
      });
    });

    chosenMovies = moviesArray;
    console.log("Total unique movies:", chosenMovies.length);
    console.log("Movies:", chosenMovies);

    // Hide section if no movies
    if (chosenMovies.length === 0) {
      console.log("No votes found - hiding section");
      chosenSection.style.display = "none";
    } else {
      console.log("Found votes - showing section");
      chosenSection.style.display = "block";
      await displayChosenMovies();
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
      `${TMDB_BASE_URL}/movie/${movieId}?api_key=${TMDB_API_KEY}&append_to_response=credits`
    );
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
  if (movieMetadataCache.has(title)) {
    return movieMetadataCache.get(title);
  }

  try {
    const results = await searchTMDB(title);
    const normalizedTitle = title.trim().toLowerCase();
    const match = results.find(movie => movie.title?.trim().toLowerCase() === normalizedTitle) || results[0];
    const metadata = {
      tmdbId: match?.id || null,
      poster: buildPosterUrl(match?.poster_path)
    };
    movieMetadataCache.set(title, metadata);
    return metadata;
  } catch (error) {
    console.error("Error fetching movie metadata:", error);
    const metadata = { tmdbId: null, poster: null };
    movieMetadataCache.set(title, metadata);
    return metadata;
  }
}

// Display allowed movies list
async function displayAllowedMovies() {
  console.log("Displaying allowed movies. SearchResults element:", searchResults);
  
  if (!searchResults) {
    console.error("searchResults element not found!");
    return;
  }
  
  searchResults.innerHTML = "";

  const allowedMovieData = await Promise.all(
    ALLOWED_MOVIES.map(async (movieTitle) => {
      const metadata = await getMovieMetadataByTitle(movieTitle);
      return { title: movieTitle, ...metadata };
    })
  );

  for (const movie of allowedMovieData) {
    // Find if this movie already has votes
    const existingMovie = chosenMovies.find(m => m.title === movie.title || m.title.startsWith(movie.title));
    const voteCount = existingMovie?.vote_count || 0;
    
    const item = document.createElement("div");
    item.className = "search-result-item allowed-movie-item";
    item.innerHTML = `
      <div class="allowed-movie-content">
        <div class="allowed-movie-main">
          <img class="allowed-movie-poster" src="${movie.poster || ''}" alt="${movie.title} poster" ${movie.poster ? '' : 'style="display:none;"'} />
          <span class="allowed-movie-title">${movie.title}</span>
        </div>
        <span class="allowed-movie-votes">${voteCount} votes</span>
      </div>
    `;
    item.onclick = () => selectMovie({ title: movie.title, poster: movie.poster, tmdbId: movie.tmdbId });
    searchResults.appendChild(item);
  }
  
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
    
    // Highlight the selected item in yellow
    const allMovieItems = document.querySelectorAll('.allowed-movie-item');
    console.log("Found movie items:", allMovieItems.length);
    
    allMovieItems.forEach(item => {
      console.log("Checking item:", item.innerText);
      if (item.innerText.includes(selectedMovie.title)) {
        item.style.backgroundColor = '#FFD700'; // Gold/yellow
        item.style.fontWeight = 'bold';
        console.log("Highlighted:", selectedMovie.title);
      } else {
        item.style.backgroundColor = '';
        item.style.fontWeight = 'normal';
      }
    });
    
    // Make sure searchResults is visible (remove hidden class which has !important)
    if (searchResults) {
      searchResults.classList.remove("hidden");
      searchResults.setAttribute('style', 'display: block !important; visibility: visible !important;');
      console.log("SearchResults made visible");
    }
    
    console.log("Showing submit button");
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
  
  // Highlight the selected item in yellow
  const allMovieItems = document.querySelectorAll('.allowed-movie-item');
  allMovieItems.forEach(item => {
    item.style.backgroundColor = '';
    item.style.fontWeight = 'normal';
  });
  
  console.log("Showing submit button");
  updateVoteActionState();
}

// Display chosen movies with vote bars
async function displayChosenMovies() {
  chosenList.innerHTML = "";

  if (chosenMovies.length === 0) {
    chosenSection.style.display = "none";
    return;
  }

  const movies = chosenMovies.map(movie => ({
    movie,
    voteCount: movie.vote_count || 0
  }));

  // Sort by vote count descending
  movies.sort((a, b) => b.voteCount - a.voteCount);

  movies.forEach(({ movie, voteCount }) => {
    const percentage = Math.round((voteCount / VOTES_NEEDED) * 100);
    const item = document.createElement("div");
    item.className = "chosen-movie";
    item.innerHTML = `
      <div class="chosen-movie-title">
        <span>${movie.title}</span>
      </div>
      <div class="chosen-movie-bar">
        <div class="chosen-movie-fill" style="width: ${Math.min(percentage, 100)}%"></div>
      </div>
      <div class="chosen-movie-count">${voteCount} / ${VOTES_NEEDED} needed</div>
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
  moviePreview.classList.add("hidden");
  searchInput.value = "";
  searchResults.classList.add("hidden");
  clearSearchBtn.classList.remove("shown");
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
  displayChosenMovies();
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
async function recordVote() {
  try {
    if (!selectedMovie || !voterClientId) return null;
    const movieTitle = selectedMovie.title;

    const response = await submitVoteCallable({
      eventId: EVENT_ID,
      movieTitle,
      clientId: voterClientId,
      captchaToken
    });

    const result = response.data || {};
    if (result.movieTitle) {
      persistCastVote(result.movieTitle);
    }

    return result;
  } catch (error) {
    console.error("Error recording vote:", error);
    if (error.code === "functions/resource-exhausted") {
      alert("You are moving too fast. Please wait a few seconds and try again.");
    } else if (error.code === "functions/permission-denied" || error.code === "functions/invalid-argument") {
      resetCaptcha({ keepVisible: true });
      alert("Please complete the CAPTCHA challenge and try again.");
    } else if (error.code === "functions/unavailable") {
      resetCaptcha({ keepVisible: true });
      alert("CAPTCHA verification is temporarily unavailable. Please try again.");
    } else {
      alert("Error recording vote: " + (error.message || "Please try again."));
    }
    throw error;
  }
}

// Submit vote
submitBtn.onclick = async () => {
  if (!selectedMovie) return;

  if (CAPTCHA_ENABLED && !captchaToken) {
    await ensureCaptchaWidget();
    setCaptchaNotice("Complete the CAPTCHA to enable vote submission.");
    return;
  }

  console.log("Submitting vote for:", selectedMovie);
  
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

  // Record vote and refresh data
  console.log("Recording vote...");
  const voteResult = await recordVote();
  if (voteResult?.status === "already-voted") {
    resetCaptcha();
    await fetchChosenMovies();
    await showExistingVoteConfirmation({
      title: voteResult.movieTitle || selectedMovie.title,
      vote_count: 0,
      year: null
    });
    return;
  }

  console.log("Vote recorded, fetching updated data...");
  resetCaptcha();
  await fetchChosenMovies();

  const movieData = chosenMovies.find(m => m.title === selectedMovie.title);
  const voteCount = movieData?.vote_count || 1;

  // Keep chosen section hidden on confirmation screen
  chosenSection.classList.add("hidden");
  chosenSection.style.display = "none !important";
  
  // Hide the movies list
  searchResults.classList.add("hidden");
  searchResults.setAttribute('style', '');

  resultsDiv.classList.remove("hidden");
  resultsDiv.innerHTML = `
    <div class="confirmation">
      ${selectedMovie.poster ? `<img class="confirmation-poster" src="${selectedMovie.poster}" alt="${selectedMovie.title} poster" />` : ''}
      <h2>You voted for:</h2>
      <div class="voted-movie-row">
        <div class="checkmark">✓</div>
        <p class="voted-movie"><b>${selectedMovie.title}</b></p>
      </div>
      <p class="vote-counted">The vote has been counted</p>
      
    </div>

    <button class="share-btn" onclick="shareVote()">📤 Share & Grow</button>
  `;
};

window.shareVote = async function() {
  const text = `I'm backing ${selectedMovie.title} for movie night! 🎬 Join the vote and make it happen!`;
  const appLink = await generateAppLink();
  const url = `${appLink}&vote=${encodeURIComponent(selectedMovie.title)}`;
  
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
  // Hide voting interface
  if (searchInput && searchInput.parentElement) {
    searchInput.parentElement.style.display = 'none';
  }
  const searchDisclaimer = document.querySelector('.search-disclaimer');
  if (searchDisclaimer) {
    searchDisclaimer.style.display = 'none';
  }
  chosenSection.classList.add("hidden");
  chosenSection.style.display = "none !important";
  submitBtn.classList.add("hidden");
  
  const movieMetadata = await getMovieMetadataByTitle(movie.title);
  
  // Display confirmation
  resultsDiv.classList.remove("hidden");
  resultsDiv.innerHTML = `
    <div class="confirmation">
      ${movieMetadata.poster ? `<img class="confirmation-poster" src="${movieMetadata.poster}" alt="${movie.title} poster" />` : ''}
      <h2>You've Already Voted!</h2>
      <div class="voted-movie-row">
        <div class="checkmark">✓</div>
        <p class="voted-movie"><b>${movie.title}</b></p>
      </div>
      <p class="vote-counted">Your vote has been counted</p>
    </div>

    <button class="share-btn" onclick="shareExistingVote('${movie.title}')">📤 Share & Grow</button>
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
  // Hide results if visible
  resultsDiv.classList.add("hidden");
  
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
  
  // Show the allowed movies list instead
  displayAllowedMovies();
  updateVoteActionState();
}

// Update the share link shown in the footer
async function updateAppLink() {
  const appLink = document.getElementById('appLink');
  if (appLink) {
    const generatedLink = await generateAppLink();
    appLink.href = generatedLink;
  }
}

// Initialize
async function init() {
  hideVotingInterface();
  voterClientId = getOrCreateClientId();
  await routeCurrentVoter();

  await updateAppLink();
}

init();