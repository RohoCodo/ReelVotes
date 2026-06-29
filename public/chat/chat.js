import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import {
  collection,
  limitToLast,
  onSnapshot,
  orderBy,
  query,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyDMa_twNQAZVrnLHUNNNsxk6aTa-9FrnSc",
  authDomain: "reelconvo.firebaseapp.com",
  projectId: "reelconvo",
  storageBucket: "reelconvo.firebasestorage.app",
  messagingSenderId: "913820455359",
  appId: "1:913820455359:web:1c75954a231b921b55510a",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const functions = getFunctions(app);
const joinMovieChatRoomCallable = httpsCallable(functions, "joinMovieChatRoom");
const sendMovieChatMessageCallable = httpsCallable(functions, "sendMovieChatMessage");

const movieInput = document.getElementById("chatMovieInput");
const roomCodeInput = document.getElementById("chatRoomCodeInput");
const displayNameInput = document.getElementById("chatDisplayNameInput");
const joinBtn = document.getElementById("joinChatBtn");
const statusEl = document.getElementById("chatStatus");
const roomPanel = document.getElementById("chatRoomPanel");
const roomHeading = document.getElementById("chatRoomHeading");
const shareLink = document.getElementById("chatShareLink");
const messagesEl = document.getElementById("chatMessages");
const messageInput = document.getElementById("chatMessageInput");
const sendBtn = document.getElementById("sendChatBtn");

const DISPLAY_NAME_STORAGE_KEY = "reelvotes_chat_display_name";
const PARTICIPANT_ID_STORAGE_KEY = "reelvotes_chat_participant_id";

let currentRoom = null;
let stopMessagesListener = null;

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#ff8e8e" : "#aaa";
}

function normalizeMovieKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function sanitizeDisplayName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return name || "";
}

function sanitizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 32);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) return "";
  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function getParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    movie: params.get("movie") || "",
    code: params.get("code") || "",
  };
}

function updateUrl(movieTitle) {
  const params = new URLSearchParams(window.location.search);
  params.set("movie", movieTitle);
  window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
}

function getDisplayName(participantId) {
  const custom = sanitizeDisplayName(displayNameInput?.value);
  if (custom) return custom;
  try {
    const stored = sanitizeDisplayName(window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY));
    if (stored) return stored;
  } catch {
    // ignore storage errors
  }
  const tail = String(participantId || "").slice(-5) || "guest";
  return `Guest-${tail}`;
}

function persistDisplayName(name) {
  const normalized = sanitizeDisplayName(name);
  if (!normalized) return;
  try {
    window.localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, normalized);
  } catch {
    // ignore storage errors
  }
}

function createParticipantId() {
  const randomPart = Math.random().toString(36).slice(2, 12);
  const timePart = Date.now().toString(36);
  return `guest_${timePart}_${randomPart}`.slice(0, 96);
}

function getParticipantId() {
  try {
    const existing = String(window.localStorage.getItem(PARTICIPANT_ID_STORAGE_KEY) || "").trim();
    if (/^[a-z0-9_-]{8,120}$/i.test(existing)) {
      return existing;
    }
  } catch {
    // ignore storage errors
  }

  const nextId = createParticipantId();
  try {
    window.localStorage.setItem(PARTICIPANT_ID_STORAGE_KEY, nextId);
  } catch {
    // ignore storage errors
  }
  return nextId;
}

function renderMessages(items) {
  if (!messagesEl) return;

  if (!items.length) {
    messagesEl.innerHTML = '<article class="moment-item"><div class="moment-item-body">No messages yet. Start the conversation.</div></article>';
    return;
  }

  messagesEl.innerHTML = items.map((item) => {
    const text = escapeHtml(item.text || "");
    const author = escapeHtml(item.displayName || "Anonymous");
    const stamp = escapeHtml(formatDate(item.createdAt || item.createdAtClient));

    return `
      <article class="moment-item">
        <div class="moment-item-body">${text}</div>
        <div class="moment-item-meta">${author}${stamp ? ` • ${stamp}` : ""}</div>
      </article>
    `;
  }).join("");

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function joinRoom() {
  const movieTitle = String(movieInput?.value || "").trim();
  const movieKey = normalizeMovieKey(movieTitle);
  const roomCode = sanitizeRoomCode(roomCodeInput?.value);

  if (!movieTitle || !movieKey) {
    setStatus("Enter a movie title to join chat.", true);
    return;
  }
  if (!roomCode) {
    setStatus("Enter the room code from your card.", true);
    return;
  }

  joinBtn.disabled = true;
  setStatus("Joining chat room...");

  try {
    const participantId = getParticipantId();
    const displayName = getDisplayName(participantId);
    persistDisplayName(displayName);

    const joinResult = await joinMovieChatRoomCallable({
      movieTitle,
      roomCode,
      displayName,
      participantId,
    });

    const joined = joinResult?.data || {};
    const threadId = String(joined.threadId || "").trim();
    const resolvedMovieTitle = String(joined.movieTitle || movieTitle).trim() || movieTitle;

    if (!threadId) {
      throw new Error("Chat room unavailable.");
    }

    updateUrl(resolvedMovieTitle);
    currentRoom = { movieTitle: resolvedMovieTitle, movieKey, threadId };

    if (roomHeading) {
      roomHeading.textContent = resolvedMovieTitle;
    }
    if (roomPanel) {
      roomPanel.classList.remove("hidden");
    }

    if (shareLink) {
      const roomUrl = `${window.location.origin}/chat/?movie=${encodeURIComponent(resolvedMovieTitle)}`;
      shareLink.href = roomUrl;
      shareLink.onclick = async (event) => {
        event.preventDefault();
        try {
          await navigator.clipboard.writeText(roomUrl);
          setStatus("Room link copied.");
        } catch {
          setStatus("Copy failed. You can copy from the browser URL bar.", true);
        }
      };
    }

    if (stopMessagesListener) {
      stopMessagesListener();
      stopMessagesListener = null;
    }

    const messagesQuery = query(
      collection(db, "threads", threadId, "messages"),
      orderBy("createdAt", "asc"),
      limitToLast(200)
    );

    stopMessagesListener = onSnapshot(messagesQuery, (snapshot) => {
      const items = snapshot.docs.map((entry) => entry.data() || {});
      renderMessages(items);
      setStatus(`Connected as ${displayName}.`);
    }, (error) => {
      console.warn("[chat] realtime listener failed", error);
      setStatus("Could not load chat messages.", true);
    });
  } catch (error) {
    console.warn("[chat] join failed", error);
    setStatus(error?.message || "Could not join chat room.", true);
  } finally {
    joinBtn.disabled = false;
  }
}

async function sendMessage() {
  if (!currentRoom?.threadId) {
    setStatus("Join a room before sending a message.", true);
    return;
  }

  const text = String(messageInput?.value || "").trim();
  if (!text) {
    setStatus("Type a message first.", true);
    return;
  }
  if (text.length > 500) {
    setStatus("Message is too long.", true);
    return;
  }

  sendBtn.disabled = true;

  try {
    const participantId = getParticipantId();
    const roomCode = sanitizeRoomCode(roomCodeInput?.value);
    if (!roomCode) {
      setStatus("Enter the room code from your card.", true);
      return;
    }

    await sendMovieChatMessageCallable({
      threadId: currentRoom.threadId,
      roomCode,
      participantId,
      text,
    });

    messageInput.value = "";
    setStatus("Message sent.");
  } catch (error) {
    console.warn("[chat] send failed", error);
    setStatus(error?.message || "Could not send message.", true);
  } finally {
    sendBtn.disabled = false;
  }
}

function hydrateFromQuery() {
  const params = getParams();
  if (params.movie && movieInput) {
    movieInput.value = params.movie;
  }
  if (params.code && roomCodeInput) {
    roomCodeInput.value = sanitizeRoomCode(params.code);
  }

  try {
    const stored = sanitizeDisplayName(window.localStorage.getItem(DISPLAY_NAME_STORAGE_KEY));
    if (stored && displayNameInput) {
      displayNameInput.value = stored;
    }
  } catch {
    // ignore storage errors
  }

  if (params.movie && params.code) {
    joinRoom();
  }
}

joinBtn?.addEventListener("click", joinRoom);
sendBtn?.addEventListener("click", sendMessage);
messageInput?.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    sendMessage();
  }
});

hydrateFromQuery();
