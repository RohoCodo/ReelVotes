import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc, updateDoc, increment, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
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
const validateEventbriteEmail = httpsCallable(functions, "validateEventbriteEmail");

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
let emailVerified = false;
const movieMetadataCache = new Map();

// Hardcoded total votes needed to reach goal
const VOTES_NEEDED = 50;

// Admin/exception emails that skip verification
const EXCEPTION_EMAILS = new Set([
  "rtrocks722@gmail.com",
  "rt332@cornell.edu"
]);

// Get event ID from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const EVENT_ID = urlParams.get("event") || "newparkway1";

// Get or prompt for voter email - start as null to force verification flow
let voterEmail = null;

const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const moviePreview = document.getElementById("moviePreview");
const chosenList = document.getElementById("chosenList");
const chosenSection = document.getElementById("chosenMovies");
const submitBtn = document.getElementById("submitBtn");
const resultsDiv = document.getElementById("results");
const clearSearchBtn = document.getElementById("clearSearchBtn");

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

// Generate app link with authentication token
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
    submitBtn.classList.remove("hidden");
    submitBtn.disabled = false;
    
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
  submitBtn.classList.remove("hidden");
  submitBtn.disabled = false;
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
      submitBtn.classList.remove("hidden");
      submitBtn.disabled = false;
    };
    
    chosenList.appendChild(item);
  });

  chosenSection.style.display = emailVerified ? "block" : "none";
}

// Check if an email has already voted for this event
// Check if email has already voted (can be just true/false or return the movie if we need it)
async function checkIfEmailVoted(email) {
  try {
    // Query individual votes for this email in this event
    const votesRef = collection(db, "events", EVENT_ID, "votes");
    const q = query(votesRef, where("voter_email", "==", email));
    const querySnapshot = await getDocs(q);
    
    if (querySnapshot.size > 0) {
      // Email has already voted - return the movie title
      const voteDoc = querySnapshot.docs[0];
      const movieTitle = voteDoc.data().movie_title;
      
      // Get vote count for this movie
      const moviesRef = collection(db, "events", EVENT_ID, "movies");
      const movieDocId = movieTitle.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
      const movieRef = doc(moviesRef, movieDocId);
      const movieDoc = await getDoc(movieRef);
      
      return {
        title: movieTitle,
        vote_count: movieDoc.exists() ? (movieDoc.data().vote_count || 0) : 0,
        year: null
      };
    }
    
    return null;
  } catch (error) {
    console.error("Error checking if email voted:", error);
    return null;
  }
}

// Clear movie selection
function clearMovieSelection() {
  selectedMovie = null;
  moviePreview.classList.add("hidden");
  searchInput.value = "";
  searchResults.classList.add("hidden");
  submitBtn.classList.add("hidden");
  submitBtn.disabled = true;
  clearSearchBtn.classList.remove("shown");
}

// Search handler
searchInput.addEventListener("input", (e) => {
  const query = e.target.value.trim();
  
  // Clear selection when user starts typing
  if (query.length > 0) {
    selectedMovie = null;
    selectedMovieCard = null;
    moviePreview.classList.add("hidden");
    submitBtn.classList.add("hidden");
    submitBtn.disabled = true;
    
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
    if (!selectedMovie || !voterEmail) return;
    // Check if email has already voted
    const alreadyVoted = await checkIfEmailVoted(voterEmail);
    if (alreadyVoted) {
      alert("You've already voted! Each email can only vote once per event.");
      return;
    }
    
    // Store just the movie title
    const movieTitle = selectedMovie.title;
    
    // Reference to event
    const eventRef = doc(db, "events", EVENT_ID);
    
    // 1. Store individual vote
    const votesRef = collection(db, "events", EVENT_ID, "votes");
    await setDoc(doc(votesRef), {
      voter_email: voterEmail,
      movie_title: movieTitle,
      created_at: new Date()
    });
    
    // 2. Update or create movie summary
    const moviesRef = collection(db, "events", EVENT_ID, "movies");
    // Create safe document ID: lowercase, replace spaces with underscores, remove special chars
    const movieDocId = movieTitle.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
    const movieRef = doc(moviesRef, movieDocId);
    const movieDoc = await getDoc(movieRef);
    
    if (movieDoc.exists()) {
      // Movie summary already exists - increment vote count
      await updateDoc(movieRef, {
        vote_count: increment(1),
        updated_at: new Date()
      });
    } else {
      // First vote for this movie - create summary
      await setDoc(movieRef, {
        movie_title: movieTitle,
        vote_count: 1,
        event_id: EVENT_ID,
        created_at: new Date(),
        updated_at: new Date()
      });
    }
    
  } catch (error) {
    console.error("Error recording vote:", error);
    alert("Error recording vote: " + error.message);
    throw error;
  }
}

// Submit vote
submitBtn.onclick = async () => {
  if (!selectedMovie) return;
  
  if (!emailVerified) {
    alert('Please verify your email first.');
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
  await recordVote();
  console.log("Vote recorded, fetching updated data...");
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
      <div class="checkmark">✓</div>
      ${selectedMovie.poster ? `<img class="confirmation-poster" src="${selectedMovie.poster}" alt="${selectedMovie.title} poster" />` : ''}
      <h2>You voted for:</h2>
      <p class="voted-movie"><b>${selectedMovie.title}</b></p>
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
      <div class="checkmark">✓</div>
      ${movieMetadata.poster ? `<img class="confirmation-poster" src="${movieMetadata.poster}" alt="${movie.title} poster" />` : ''}
      <h2>You've Already Voted!</h2>
      <p class="voted-movie"><b>${movie.title}</b></p>
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
}

async function promptForEmail() {
  if (voterEmail && emailVerified) {
    showVotingInterface();
    return; // Already verified in this session
  }
  
  // Hide voting interface, keep card visible
  hideVotingInterface();
  
  // Create email form in the card
  const card = document.querySelector('.card');
  
  if (!card) {
    console.error('Card not found');
    return;
  }
  
  const emailForm = document.createElement('div');
  emailForm.id = 'emailStep';
  
  // Check if we have a cached email to pre-fill
  const cachedEmail = localStorage.getItem(`voterEmail_${EVENT_ID}`);
  const emailValue = cachedEmail ? cachedEmail : '';
  
  emailForm.innerHTML = `
    <div class="email-step">
      <h2>Verify Your Email</h2>
      <p>Use the email you used to purchase your Eventbrite ticket</p>
      <input type="email" id="emailInputField" placeholder="your@email.com" value="${emailValue}" autofocus />
      <button id="emailConfirmBtn" class="submit-btn">Continue to Vote</button>
      
      <p class="email-help">
        Haven't bought a ticket yet? 
        <a href="https://www.eventbrite.com" target="_blank">Get your ticket here →</a>
      </p>
    </div>
  `;
  
  // Insert at the beginning of the card content (after title/subtitle)
  const searchSection = card.querySelector('#search-section');
  if (searchSection) {
    searchSection.parentNode.insertBefore(emailForm, searchSection);
  } else {
    card.appendChild(emailForm);
  }
  
  const emailInputField = document.getElementById('emailInputField');
  const emailConfirmBtn = document.getElementById('emailConfirmBtn');
  
  return new Promise((resolve) => {
    emailConfirmBtn.onclick = async () => {
      const email = emailInputField.value.trim();
      
      if (!email) {
        alert('Please enter an email address.');
        return;
      }
      
      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        alert('Please enter a valid email address.');
        return;
      }
      
      // Validate against Eventbrite
      try {
        emailConfirmBtn.disabled = true;
        emailConfirmBtn.innerText = 'Validating...';
        
        // Check if this is an exception email
        if (EXCEPTION_EMAILS.has(email)) {
          voterEmail = email;
          emailVerified = true;
          localStorage.setItem(`voterEmail_${EVENT_ID}`, voterEmail);

          const existingVote = await checkIfEmailVoted(email);
          emailForm.remove();

          if (existingVote) {
            await showExistingVoteConfirmation(existingVote);
          } else {
            await fetchChosenMovies();
            showVotingInterface();
          }
          resolve();
          return;
        }
        
        const result = await validateEventbriteEmail({ email: email });
        
        if (result.data.valid) {
          voterEmail = email;
          emailVerified = true;
          localStorage.setItem(`voterEmail_${EVENT_ID}`, voterEmail);

          const existingVote = await checkIfEmailVoted(email);
          emailForm.remove();

          if (existingVote) {
            await showExistingVoteConfirmation(existingVote);
          } else {
            await fetchChosenMovies();
            showVotingInterface();
          }
          resolve();
        } else {
          alert(result.data.message || 'Email not found in attendee list.');
          emailConfirmBtn.disabled = false;
          emailConfirmBtn.innerText = 'Continue to Vote';
        }
      } catch (error) {
        alert('Error validating email. Please try again.');
        emailConfirmBtn.disabled = false;
        emailConfirmBtn.innerText = 'Continue to Vote';
      }
    };
    
    // Allow Enter key to submit
    emailInputField.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') emailConfirmBtn.click();
    });
  });
}

// Update app link with authentication
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
  await promptForEmail();
  // Email verification already shows voting interface or confirmation
  // No need to call fetchChosenMovies again
  await updateAppLink();
}

init();