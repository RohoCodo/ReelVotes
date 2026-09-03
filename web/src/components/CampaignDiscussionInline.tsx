import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { Timestamp, collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { db, joinCampaignDiscussion, sendCampaignDiscussionMessage } from "../lib/firebase";
import { auth, isPopupSignInCancellation, onAuthStateChanged, signInWithGoogle } from "../lib/firebase-auth";
import type { CampaignMovieChoice } from "../lib/campaigns";

interface DiscussionMessage {
  id: string;
  userId: string;
  displayName: string;
  body: string;
  campaignMovieId: string | null;
  createdAtMillis: number;
}

function buildCampaignDiscussionThreadId(campaignId: string): string {
  const normalized = String(campaignId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return `campaign_${normalized || "campaign"}`;
}

function formatTime(millis: number): string {
  if (!Number.isFinite(millis) || millis <= 0) return "";
  return new Date(millis).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function CampaignDiscussionInline({
  campaignId,
  choices,
  variant = "full",
  previewLimit = 3,
}: {
  campaignId: string;
  choices: CampaignMovieChoice[];
  variant?: "full" | "preview";
  previewLimit?: number;
}) {
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [body, setBody] = useState("");
  const [aboutCampaignMovieId, setAboutCampaignMovieId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const threadId = useMemo(() => buildCampaignDiscussionThreadId(campaignId), [campaignId]);
  const movieTitleById = useMemo(() => {
    const map = new Map<string, string>();
    choices.forEach((choice) => map.set(choice.campaignMovieId, choice.title));
    return map;
  }, [choices]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => setAuthUser(user));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const q = query(collection(db, "threads", threadId, "messages"), orderBy("createdAt", "asc"), limit(120));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const next = snapshot.docs.map((docSnap) => {
          const data = docSnap.data() || {};
          const createdAt = data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : 0;
          const createdAtClient = Number(data.createdAtClient || 0);
          return {
            id: docSnap.id,
            userId: String(data.userId || data.participantId || ""),
            displayName: String(data.displayName || "Member").trim() || "Member",
            body: String(data.body || data.text || ""),
            campaignMovieId: data.campaignMovieId ? String(data.campaignMovieId) : null,
            createdAtMillis: createdAt || createdAtClient,
          };
        });
        next.sort((a, b) => a.createdAtMillis - b.createdAtMillis);
        setMessages(next);
      },
      () => setMessages([]),
    );

    return () => unsubscribe();
  }, [threadId]);

  async function ensureAuthed() {
    if (auth.currentUser) return auth.currentUser;
    await signInWithGoogle();
    return auth.currentUser;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = body.trim();
    if (!text || submitting) return;

    setSubmitting(true);
    setErrorMessage("");
    try {
      await ensureAuthed();
      await joinCampaignDiscussion({ campaignId });
      await sendCampaignDiscussionMessage({
        campaignId,
        campaignMovieId: aboutCampaignMovieId || undefined,
        body: text,
      });
      setBody("");
    } catch (error) {
      if (isPopupSignInCancellation(error)) {
        return;
      }
      setErrorMessage(String((error as any)?.message || "Could not post comment."));
    } finally {
      setSubmitting(false);
    }
  }

  if (variant === "preview") {
    const preview = messages.slice(Math.max(0, messages.length - Math.max(1, previewLimit)));
    return (
      <div id={`campaign-comments-${campaignId}`} className="mt-2 space-y-1">
        {preview.length === 0 ? (
          <p className="text-xs text-ink-soft">Be the first to comment.</p>
        ) : (
          preview.map((message) => (
            <p key={message.id} className="line-clamp-1 text-xs text-ink-soft">
              <span className="font-semibold text-ink">{message.displayName}</span> {message.body}
            </p>
          ))
        )}
        <p className="text-[11px] text-ink-faint">{messages.length} comment{messages.length === 1 ? "" : "s"}</p>
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-cream p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Campaign discussion</p>
        <p className="text-[11px] text-ink-faint">{messages.length} comment{messages.length === 1 ? "" : "s"}</p>
      </div>

      <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <p className="rounded-lg bg-paper px-3 py-2 text-xs text-ink-soft">Be the first to comment on this campaign.</p>
        ) : (
          messages.map((message) => {
            const aboutTitle = message.campaignMovieId ? movieTitleById.get(message.campaignMovieId) : null;
            return (
              <article key={message.id} className="rounded-lg border border-line bg-paper px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-marquee/15 text-[10px] font-semibold text-marquee">
                    {message.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <p className="text-xs font-semibold text-ink">{message.displayName}</p>
                  <span className="text-[10px] text-ink-faint">{formatTime(message.createdAtMillis)}</span>
                </div>
                {aboutTitle && <p className="mt-1 text-[10px] text-ink-faint">about {aboutTitle}</p>}
                <p className="mt-1 text-xs leading-relaxed text-ink-soft">{message.body}</p>
              </article>
            );
          })
        )}
      </div>

      <form onSubmit={handleSubmit} className="mt-3 grid gap-2">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <input
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={authUser ? "Add a comment" : "Sign in to comment"}
            className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink outline-none transition-colors focus:border-marquee"
            maxLength={500}
            required
          />
          <button
            type="submit"
            disabled={submitting}
            className="rounded-full bg-marquee px-4 py-2 text-xs font-semibold text-white transition-opacity disabled:opacity-60"
          >
            {submitting ? "Posting…" : "Post"}
          </button>
        </div>

        <label className="text-[11px] text-ink-faint">
          About movie (optional)
          <select
            value={aboutCampaignMovieId}
            onChange={(event) => setAboutCampaignMovieId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink outline-none transition-colors focus:border-marquee"
          >
            <option value="">General campaign comment</option>
            {choices.map((choice) => (
              <option key={choice.campaignMovieId} value={choice.campaignMovieId}>
                {choice.title}
              </option>
            ))}
          </select>
        </label>

        {errorMessage && <p className="rounded-lg border border-red-300/30 bg-red-900/20 px-3 py-2 text-xs text-red-200">{errorMessage}</p>}
      </form>
    </div>
  );
}
