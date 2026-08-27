import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { collection, onSnapshot, orderBy, query, Timestamp } from "firebase/firestore";
import { db, joinMovieChatRoom, sendMovieChatMessage } from "../lib/firebase";

const PARTICIPANT_STORAGE_KEY = "reelchatParticipantId";
const LAST_THREAD_STORAGE_KEY = "reelchatLastThreadId";
const MAX_MESSAGE_LENGTH = 500;
const SEND_COOLDOWN_MS = 1500;

interface RoomState {
  threadId: string;
  movieTitle: string;
  roomCode: string;
  displayName: string;
}

interface ChatMessage {
  id: string;
  participantId: string;
  displayName: string;
  text: string;
  createdAtMillis: number;
}

type Phase = "loading" | "join" | "room";

function normalizeRoomCode(raw: string): string {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{4,32}$/.test(code);
}

function generateParticipantId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function getOrCreateParticipantId(): string {
  try {
    let id = window.localStorage.getItem(PARTICIPANT_STORAGE_KEY);
    if (!id || !/^[a-z0-9_-]{8,120}$/i.test(id)) {
      id = generateParticipantId();
      window.localStorage.setItem(PARTICIPANT_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return generateParticipantId();
  }
}

function roomStorageKey(threadId: string): string {
  return `reelchatRoom_${threadId}`;
}

function readStoredRoom(threadId: string): RoomState | null {
  try {
    const raw = window.localStorage.getItem(roomStorageKey(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.threadId === "string" && typeof parsed.roomCode === "string") {
      return parsed as RoomState;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredRoom(room: RoomState) {
  try {
    window.localStorage.setItem(roomStorageKey(room.threadId), JSON.stringify(room));
    window.localStorage.setItem(LAST_THREAD_STORAGE_KEY, room.threadId);
  } catch {
    // ignore storage failures (private browsing, quota, etc.)
  }
}

function clearStoredRoom(threadId: string) {
  try {
    window.localStorage.removeItem(roomStorageKey(threadId));
    if (window.localStorage.getItem(LAST_THREAD_STORAGE_KEY) === threadId) {
      window.localStorage.removeItem(LAST_THREAD_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
}

function getJoinErrorMessage(error: any): string {
  const code = error?.code;
  if (code === "functions/permission-denied") return "Incorrect room code.";
  if (code === "functions/invalid-argument") {
    return String(error?.message || "") || "Please check the movie title and room code and try again.";
  }
  return "Could not join this chat room. Please try again.";
}

function formatTime(millis: number): string {
  try {
    return new Date(millis).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function ChatRoom() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [participantId, setParticipantId] = useState<string>("");

  // Join form state
  const [movieTitleInput, setMovieTitleInput] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");

  // Room state
  const [room, setRoom] = useState<RoomState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendCooldown, setSendCooldown] = useState(false);
  const [sendError, setSendError] = useState("");
  const [codeFixMode, setCodeFixMode] = useState(false);
  const [codeFixValue, setCodeFixValue] = useState("");
  const [codeFixSubmitting, setCodeFixSubmitting] = useState(false);
  const [codeFixError, setCodeFixError] = useState("");

  const feedEndRef = useRef<HTMLDivElement | null>(null);

  const enterRoom = useCallback((nextRoom: RoomState) => {
    writeStoredRoom(nextRoom);
    setRoom(nextRoom);
    setMessages([]);
    setSendError("");
    setCodeFixMode(false);
    setPhase("room");
  }, []);

  const returnToJoinForm = useCallback((threadIdToClear?: string) => {
    if (threadIdToClear) clearStoredRoom(threadIdToClear);
    setRoom(null);
    setMessages([]);
    setSendError("");
    setCodeFixMode(false);
    setPhase("join");
  }, []);

  // --- Bootstrap: resolve participant id, then either rejoin a stored room
  // or prefill the join form from ?movie=&code= query params. ---
  useEffect(() => {
    const pid = getOrCreateParticipantId();
    setParticipantId(pid);

    // A deep link always wins, even over a previously-stored room — otherwise
    // a returning chat user could never follow a fresh invite to a different
    // movie's room, since they'd get silently bounced back to their last one.
    const params = new URLSearchParams(window.location.search);
    const movieParam = params.get("movie") || "";
    const codeParam = normalizeRoomCode(params.get("code") || "");

    if (movieParam.trim() && isValidRoomCode(codeParam)) {
      setMovieTitleInput(movieParam);
      setRoomCodeInput(codeParam);
      setPhase("join");
      void performJoin(movieParam, codeParam, "", pid);
      return;
    }

    let storedRoom: RoomState | null = null;
    try {
      const lastThreadId = window.localStorage.getItem(LAST_THREAD_STORAGE_KEY);
      if (lastThreadId) storedRoom = readStoredRoom(lastThreadId);
    } catch {
      storedRoom = null;
    }

    if (storedRoom) {
      setRoom(storedRoom);
      setPhase("room");
      return;
    }

    setMovieTitleInput(movieParam);
    setRoomCodeInput(codeParam);
    setPhase("join");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function performJoin(movieTitle: string, roomCode: string, displayName: string, pid: string) {
    setJoining(true);
    setJoinError("");
    try {
      const response: any = await joinMovieChatRoom({
        movieTitle: movieTitle.trim(),
        roomCode,
        displayName: displayName.trim() || undefined,
        participantId: pid,
      });
      const data = response?.data || {};
      enterRoom({
        threadId: data.threadId,
        movieTitle: data.movieTitle || movieTitle.trim(),
        roomCode,
        displayName: displayName.trim(),
      });
    } catch (error) {
      console.error("Could not join chat room:", error);
      setJoinError(getJoinErrorMessage(error));
    } finally {
      setJoining(false);
    }
  }

  function handleJoinSubmit(event: FormEvent) {
    event.preventDefault();
    const title = movieTitleInput.trim();
    const code = normalizeRoomCode(roomCodeInput);
    setRoomCodeInput(code);

    if (!title) {
      setJoinError("Please enter the movie title.");
      return;
    }
    if (!isValidRoomCode(code)) {
      setJoinError("Room codes are 4–32 letters and numbers.");
      return;
    }
    void performJoin(title, code, displayNameInput, participantId);
  }

  // --- Subscribe to the message feed once we have a room. ---
  useEffect(() => {
    if (!room) return;
    const q = query(collection(db, "threads", room.threadId, "messages"), orderBy("createdAt", "asc"));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const rows: ChatMessage[] = snapshot.docs.map((docSnap) => {
          const data = docSnap.data() || {};
          const createdAt = data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : null;
          const createdAtClient = typeof data.createdAtClient === "number" ? data.createdAtClient : 0;
          return {
            id: docSnap.id,
            participantId: String(data.participantId || ""),
            displayName: String(data.displayName || "").trim() || "Guest",
            text: String(data.text || ""),
            createdAtMillis: createdAt ?? createdAtClient,
          };
        });
        // Re-sort client-side: a just-sent message's server `createdAt` is
        // still null for a moment (serverTimestamp resolves async), which
        // would otherwise sort it first under Firestore's orderBy. Falling
        // back to createdAtClient keeps the feed visually stable.
        rows.sort((a, b) => a.createdAtMillis - b.createdAtMillis);
        setMessages(rows);
      },
      (error) => {
        console.error("Message feed subscription failed:", error);
      },
    );
    return () => unsubscribe();
  }, [room?.threadId]);

  // Auto-scroll to the latest message.
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  async function handleSendSubmit(event: FormEvent) {
    event.preventDefault();
    if (!room) return;
    const text = messageText.trim();
    if (!text || sending || sendCooldown) return;

    setSending(true);
    setSendError("");
    try {
      await sendMovieChatMessage({
        threadId: room.threadId,
        roomCode: room.roomCode,
        participantId,
        text,
      });
      setMessageText("");
      setSendCooldown(true);
      window.setTimeout(() => setSendCooldown(false), SEND_COOLDOWN_MS);
    } catch (error: any) {
      console.error("Could not send chat message:", error);
      const code = error?.code;
      if (code === "functions/not-found") {
        setSendError("Movie chat room not found.");
        returnToJoinForm(room.threadId);
        return;
      }
      if (code === "functions/failed-precondition" || code === "functions/permission-denied") {
        setSendError("That room code doesn't look right anymore. Please re-enter it below.");
        setCodeFixValue(room.roomCode);
        setCodeFixMode(true);
      } else if (code === "functions/resource-exhausted") {
        setSendError("Sending too fast, wait a moment.");
      } else {
        setSendError("Could not send your message. Please try again.");
      }
    } finally {
      setSending(false);
    }
  }

  async function handleCodeFixSubmit(event: FormEvent) {
    event.preventDefault();
    if (!room) return;
    const code = normalizeRoomCode(codeFixValue);
    setCodeFixValue(code);
    if (!isValidRoomCode(code)) {
      setCodeFixError("Room codes are 4–32 letters and numbers.");
      return;
    }
    setCodeFixSubmitting(true);
    setCodeFixError("");
    try {
      const response: any = await joinMovieChatRoom({
        movieTitle: room.movieTitle,
        roomCode: code,
        displayName: room.displayName || undefined,
        participantId,
      });
      const data = response?.data || {};
      const updatedRoom: RoomState = { ...room, threadId: data.threadId || room.threadId, roomCode: code };
      writeStoredRoom(updatedRoom);
      setRoom(updatedRoom);
      setCodeFixMode(false);
      setSendError("");
    } catch (error) {
      console.error("Could not update room code:", error);
      setCodeFixError(getJoinErrorMessage(error));
    } finally {
      setCodeFixSubmitting(false);
    }
  }

  function handleLeaveRoom() {
    if (room) clearStoredRoom(room.threadId);
    setMovieTitleInput("");
    setRoomCodeInput("");
    setDisplayNameInput("");
    returnToJoinForm();
  }

  // --- Render ---------------------------------------------------------

  if (phase === "loading") {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-line bg-paper p-8 text-center">
        <p className="text-sm text-ink-soft">Loading…</p>
      </div>
    );
  }

  if (phase === "join") {
    return (
      <div className="mx-auto max-w-md">
        <header className="mb-6 text-center">
          <div className="text-3xl" aria-hidden="true">💬</div>
          <h1 className="mt-2 font-display text-2xl font-semibold text-ink sm:text-3xl">Movie Chat</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Enter the movie title and room code from your post-screening card.
          </p>
        </header>

        <form onSubmit={handleJoinSubmit} className="grid gap-4 rounded-2xl border border-line bg-paper p-6">
          <div>
            <label htmlFor="chatMovieTitle" className="mb-1.5 block text-sm font-medium text-ink">
              Movie title
            </label>
            <input
              id="chatMovieTitle"
              type="text"
              required
              value={movieTitleInput}
              onChange={(event) => {
                setMovieTitleInput(event.target.value);
                setJoinError("");
              }}
              placeholder="e.g. In the Mood for Love"
              className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
            />
          </div>

          <div>
            <label htmlFor="chatRoomCode" className="mb-1.5 block text-sm font-medium text-ink">
              Room code
            </label>
            <input
              id="chatRoomCode"
              type="text"
              required
              maxLength={32}
              autoCapitalize="characters"
              autoComplete="one-time-code"
              value={roomCodeInput}
              onChange={(event) => {
                setRoomCodeInput(normalizeRoomCode(event.target.value));
                setJoinError("");
              }}
              placeholder="e.g. ODYSSEY"
              className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm uppercase tracking-wide text-ink outline-none transition-colors focus:border-marquee"
            />
          </div>

          <div>
            <label htmlFor="chatDisplayName" className="mb-1.5 block text-sm font-medium text-ink">
              Display name <span className="text-ink-faint">(optional)</span>
            </label>
            <input
              id="chatDisplayName"
              type="text"
              maxLength={40}
              value={displayNameInput}
              onChange={(event) => setDisplayNameInput(event.target.value)}
              placeholder="MovieFan92"
              className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
            />
          </div>

          {joinError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{joinError}</div>
          )}

          <button
            type="submit"
            disabled={joining}
            className="rounded-full bg-marquee px-6 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {joining ? "Joining…" : "Join Chat"}
          </button>
          <p className="text-center text-xs text-ink-faint">
            No room yet? Joining with a new movie title and code creates it.
          </p>
        </form>
      </div>
    );
  }

  // phase === "room"
  if (!room) return null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col pb-32">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-display text-xl font-semibold text-ink sm:text-2xl">{room.movieTitle}</h1>
          <p className="mt-0.5 text-xs text-ink-soft">
            Room code <span className="font-semibold text-ink">{room.roomCode}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={handleLeaveRoom}
          className="shrink-0 rounded-full border border-line px-3.5 py-2 text-xs font-semibold text-ink-soft transition-colors hover:border-marquee/40 hover:text-marquee"
        >
          Switch room
        </button>
      </header>

      <div className="flex min-h-[55vh] flex-col gap-3 rounded-2xl border border-line bg-paper p-4 sm:min-h-[60vh]">
        {messages.length === 0 && (
          <p className="m-auto text-center text-sm text-ink-faint">No messages yet. Say hello!</p>
        )}
        {messages.map((message) => {
          const isOwn = message.participantId === participantId;
          return (
            <div key={message.id} className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}>
              {!isOwn && <span className="mb-0.5 px-1 text-xs font-semibold text-ink-faint">{message.displayName}</span>}
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                  isOwn
                    ? "rounded-br-sm bg-marquee text-white"
                    : "rounded-bl-sm border border-line bg-cream-soft text-ink"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{message.text}</p>
              </div>
              <span className="mt-0.5 px-1 text-[11px] text-ink-faint">{formatTime(message.createdAtMillis)}</span>
            </div>
          );
        })}
        <div ref={feedEndRef} />
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 px-5 py-3 backdrop-blur-sm [padding-bottom:calc(0.75rem+env(safe-area-inset-bottom))] sm:px-8">
        <div className="mx-auto max-w-2xl">
          {sendError && (
            <div className="mb-2 rounded-xl border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">{sendError}</div>
          )}

          {codeFixMode ? (
            <form onSubmit={handleCodeFixSubmit} className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                maxLength={32}
                value={codeFixValue}
                onChange={(event) => {
                  setCodeFixValue(normalizeRoomCode(event.target.value));
                  setCodeFixError("");
                }}
                placeholder="Room code"
                className="min-w-0 flex-1 rounded-xl border border-line bg-paper px-3 py-2.5 text-sm uppercase text-ink outline-none focus:border-marquee"
              />
              <button
                type="submit"
                disabled={codeFixSubmitting}
                className="shrink-0 rounded-full bg-marquee px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {codeFixSubmitting ? "Checking…" : "Update"}
              </button>
              {codeFixError && <p className="w-full text-xs text-red-600">{codeFixError}</p>}
            </form>
          ) : (
            <form onSubmit={handleSendSubmit} className="flex items-end gap-2">
              <textarea
                value={messageText}
                onChange={(event) => setMessageText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void handleSendSubmit(event as unknown as FormEvent);
                  }
                }}
                maxLength={MAX_MESSAGE_LENGTH}
                rows={1}
                placeholder="What did you think of the movie?"
                className="min-w-0 flex-1 resize-none rounded-xl border border-line bg-paper px-4 py-2.5 text-sm text-ink outline-none transition-colors focus:border-marquee"
              />
              <button
                type="submit"
                disabled={sending || sendCooldown || !messageText.trim()}
                className="shrink-0 rounded-full bg-marquee px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
