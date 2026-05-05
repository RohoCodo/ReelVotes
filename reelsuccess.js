import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyDMa_twNQAZVrnLHUNNNsxk6aTa-9FrnSc",
  authDomain: "reelconvo.firebaseapp.com",
  projectId: "reelconvo",
  storageBucket: "reelconvo.firebasestorage.app",
  messagingSenderId: "913820455359",
  appId: "1:913820455359:web:1c75954a231b921b55510a"
};

const STORAGE_KEY = "reelsuccess_admin_email";
let currentAdminEmail = null;
let theatersCache = [];

const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);
const listTheatersCallable = httpsCallable(functions, "reelSuccessListTheaters");
const getInsightsCallable = httpsCallable(functions, "reelSuccessGetTheaterInsights");

const theaterSearchInput = document.getElementById("theaterSearchInput");
const theaterSelect = document.getElementById("theaterSelect");
const statusEl = document.getElementById("reelsuccessStatus");
const profileEl = document.getElementById("reelsuccessProfile");
const similarSectionEl = document.getElementById("reelsuccessSimilarSection");
const similarBodyEl = document.getElementById("similarTheatersBody");
const recsSectionEl = document.getElementById("reelsuccessRecsSection");
const recsBodyEl = document.getElementById("recommendationsBody");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#ff6b6b" : "#bbb";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function ensureAccess() {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && stored.includes("@")) {
    currentAdminEmail = normalizeEmail(stored);
    return;
  }

  const input = window.prompt("ReelSuccess access only. Enter admin/programmer email:");
  const email = normalizeEmail(input);
  if (!email || !email.includes("@")) {
    document.body.innerHTML = "<div style='padding:40px;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;'>Access denied.</div>";
    throw new Error("Access denied");
  }

  currentAdminEmail = email;
  window.localStorage.setItem(STORAGE_KEY, email);
}

function renderTheaterOptions(theaters) {
  theatersCache = theaters || [];
  if (!theaterSelect) return;

  theaterSelect.innerHTML = "";
  if (!theatersCache.length) {
    theaterSelect.innerHTML = "<option value=''>No theaters found</option>";
    return;
  }

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Select a theater...";
  theaterSelect.appendChild(defaultOption);

  theatersCache.forEach((theater) => {
    const opt = document.createElement("option");
    opt.value = theater.theater_key;
    opt.textContent = `${theater.theater_name} — ${theater.theater_city_state}`;
    theaterSelect.appendChild(opt);
  });
}

function renderProfile(profile) {
  if (!profileEl) return;
  if (!profile) {
    profileEl.classList.add("hidden");
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

function renderRecommendations(rows) {
  if (!recsBodyEl || !recsSectionEl) return;
  recsBodyEl.innerHTML = "";
  if (!rows || !rows.length) {
    recsSectionEl.classList.add("hidden");
    return;
  }

  recsSectionEl.classList.remove("hidden");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.movie_title)}</td>
      <td>${Number(row.recommendation_score || 0).toFixed(3)}</td>
      <td>${Number(row.support_theater_count || 0)}</td>
    `;
    recsBodyEl.appendChild(tr);
  });
}

async function loadTheaters(query = "") {
  setStatus("Loading theaters...");
  const result = await listTheatersCallable({
    adminEmail: currentAdminEmail,
    query,
    limit: 100,
  });

  const theaters = result?.data?.theaters || [];
  renderTheaterOptions(theaters);
  setStatus(`Loaded ${result?.data?.total || theaters.length} theaters.`);
}

async function loadInsights(theaterKey) {
  if (!theaterKey) return;

  setStatus("Loading insights...");
  const result = await getInsightsCallable({
    adminEmail: currentAdminEmail,
    theaterKey,
  });

  const data = result?.data || {};
  renderProfile(data.profile || null);
  renderSimilarTheaters(data.similar_theaters || []);
  renderRecommendations(data.recommendations || []);
  setStatus(`Insights loaded for ${data?.profile?.theater_name || "theater"}.`);
}

function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}

async function bootstrap() {
  try {
    await ensureAccess();
    await loadTheaters("");

    theaterSelect?.addEventListener("change", async () => {
      try {
        await loadInsights(theaterSelect.value);
      } catch (error) {
        console.error(error);
        setStatus(error?.message || "Failed to load insights.", true);
      }
    });

    const onSearch = debounce(async () => {
      try {
        await loadTheaters(theaterSearchInput?.value || "");
      } catch (error) {
        console.error(error);
        setStatus(error?.message || "Search failed.", true);
      }
    }, 250);

    theaterSearchInput?.addEventListener("input", onSearch);
  } catch (error) {
    console.error(error);
    setStatus(error?.message || "Unable to initialize ReelSuccess.", true);
  }
}

bootstrap();
