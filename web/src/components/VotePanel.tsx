import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { collection, doc, getDocs, limit, onSnapshot, query, where } from "firebase/firestore";
import { db, getVoteStatus, submitVote } from "../lib/firebase";
import { getMovieMetadataByTitle, type MovieMetadata } from "../lib/tmdb";
import { withTimeout } from "../lib/withTimeout";

const DEFAULT_ALLOWED_MOVIES = [
  "Back to the Future",
  "Jurassic Park",
  "Blade Runner",
  "In The Mood For Love",
  "Mean Girls",
  "Bring It On",
  "The Notebook",
  "Blade",
  "Battle Royale",
  "Mad Max: Fury Road",
];

type VoteStatus = "live" | "ended" | "not-started";

interface EventDoc {
  voteStatus: VoteStatus;
  requireEmail: boolean;
  showLiveVoteCounts: boolean;
  screeningLabel: string;
  screeningDateTime: string;
  allowedMovies: string[];
}

interface RuntimeMovie {
  title: string;
  voteCount: number;
  eliminated: boolean;
  poster: string | null;
  tmdbId: number | null;
}

interface Confirmation {
  titles: string[];
  subtitle: string;
  fresh: boolean;
}

type Phase = "loading" | "no-event" | "not-started" | "voting" | "confirmation" | "ended-results";

function resolveVoteStatus(raw: unknown): VoteStatus {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "live" || normalized === "ended") return normalized;
  return "not-started";
}

function movieKey(title: string): string {
  return String(title || "").trim().toLowerCase();
}

function readMovieTitle(data: Record<string, unknown>): string {
  return String(data.movie_title || data.title || data.movieTitle || "").trim();
}

function readMovieVoteCount(data: Record<string, unknown>): number {
  const numeric = Number(data.vote_count ?? data.voteCount ?? data.votes ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readMoviePoster(data: Record<string, unknown>): string | null {
  const poster = data.poster || data.posterUrl || data.poster_url || null;
  return poster ? String(poster) : null;
}

function readMovieTmdbId(data: Record<string, unknown>): number | null {
  const raw = data.tmdb_id ?? data.tmdbId ?? null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function generateClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function getOrCreateClientId(eventId: string): string {
  const key = `voterClientId_${eventId}`;
  try {
    let clientId = window.localStorage.getItem(key);
    if (!clientId) {
      clientId = generateClientId();
      window.localStorage.setItem(key, clientId);
    }
    return clientId;
  } catch {
    return generateClientId();
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function getSubmitErrorMessage(error: any): string {
  const code = error?.code;
  const message = String(error?.message || "");
  const lower = message.toLowerCase();

  if (code === "functions/resource-exhausted") {
    return "You are moving too fast. Please wait a few seconds and try again.";
  }
  if (code === "functions/failed-precondition") {
    return "Voting has ended for this event.";
  }
  if (code === "functions/permission-denied") {
    return "Please complete the CAPTCHA challenge and try again.";
  }
  if (code === "functions/invalid-argument") {
    if (lower.includes("captcha")) return "Please complete the CAPTCHA challenge and try again.";
    if (lower.includes("email")) return "Please enter a valid email address.";
    if (lower.includes("movie")) return "That movie cannot be voted for. Please pick one from the current list.";
    return message || "Invalid vote request. Please try again.";
  }
  return message || "Something went wrong recording your vote. Please try again.";
}

function getCaptchaErrorMessage(errorCode: string): string {
  if (errorCode === "invalid-sitekey") return "CAPTCHA configuration error: invalid site key.";
  if (errorCode === "invalid-domain") return "CAPTCHA is blocked for this domain.";
  if (errorCode === "network-error") return "CAPTCHA network error. Check ad blockers or your connection and try again.";
  return "CAPTCHA failed to load. Please refresh and try again.";
}

// --- Cloudflare Turnstile -----------------------------------------------
// Loaded dynamically only once a voter has actually selected a movie, and
// only if a site key is configured (window.REELVOTES_CONFIG, set by
// public/runtime-config.js — a plain global so ops can rotate/enable the
// key without a rebuild, matching the old site's approach).

function getTurnstileSiteKey(): string {
  return (window as any)?.REELVOTES_CONFIG?.turnstileSiteKey || "";
}

function useTurnstile(enabled: boolean) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const ensureWidget = useCallback(async () => {
    if (!enabled || !containerRef.current || widgetIdRef.current !== null) return;

    const win = window as any;
    if (!win.turnstile) {
      await new Promise<void>((resolve) => {
        const existing = document.querySelector("script[data-turnstile]");
        if (existing) {
          existing.addEventListener("load", () => resolve());
          if (win.turnstile) resolve();
          return;
        }
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
        script.async = true;
        script.defer = true;
        script.dataset.turnstile = "true";
        script.onload = () => resolve();
        script.onerror = () => resolve();
        document.head.appendChild(script);
      });
    }

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (win.turnstile?.render) break;
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }

    if (!win.turnstile?.render) {
      setNotice("CAPTCHA failed to load. Please refresh and try again.");
      return;
    }

    widgetIdRef.current = win.turnstile.render(containerRef.current, {
      sitekey: getTurnstileSiteKey(),
      theme: "light",
      callback: (t: string) => {
        setToken(t);
        setNotice("");
      },
      "expired-callback": () => {
        setToken(null);
        setNotice("CAPTCHA expired. Please complete it again.");
      },
      "error-callback": (errorCode: string) => {
        setToken(null);
        setNotice(getCaptchaErrorMessage(errorCode));
      },
    });
  }, [enabled]);

  const reset = useCallback(() => {
    setToken(null);
    const win = window as any;
    if (widgetIdRef.current !== null && win.turnstile?.reset) {
      win.turnstile.reset(widgetIdRef.current);
    }
  }, []);

  return { containerRef, token, notice, ensureWidget, reset };
}

export default function VotePanel() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [eventId, setEventId] = useState<string | null>(null);
  const [eventDoc, setEventDoc] = useState<EventDoc | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [movies, setMovies] = useState<RuntimeMovie[]>([]);
  const [metadata, setMetadata] = useState<Record<string, MovieMetadata>>({});
  const [selectedTitles, setSelectedTitles] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [showSingleVoteReminder, setShowSingleVoteReminder] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailValue, setEmailValue] = useState("");
  const [emailError, setEmailError] = useState("");

  const captchaEnabled = typeof window !== "undefined" && Boolean(getTurnstileSiteKey());
  const turnstile = useTurnstile(captchaEnabled && selectedTitles.length > 0);

  // --- Resolve the event id from ?event=, or fall back to whichever event is live. ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const requested = params.get("event");
      if (requested) {
        if (!cancelled) setEventId(requested);
        return;
      }
      try {
        const snapshot = await withTimeout(
          getDocs(query(collection(db, "events"), where("voteStatus", "==", "live"), limit(1))),
          6000,
          null,
          "live event lookup",
        );
        if (cancelled) return;
        if (snapshot && !snapshot.empty) {
          setEventId(snapshot.docs[0].id);
        } else {
          setPhase("no-event");
        }
      } catch (error) {
        console.error("Could not resolve a live event:", error);
        if (!cancelled) setPhase("no-event");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Absolute fallback so the UI never appears stuck on "Loading the ballot…"
  // if hydration/network behavior is unexpectedly degraded.
  useEffect(() => {
    if (phase !== "loading") return;
    const timeoutId = window.setTimeout(() => {
      setPhase((current) => (current === "loading" ? "no-event" : current));
    }, 15000);
    return () => window.clearTimeout(timeoutId);
  }, [phase]);

  // --- Subscribe to the event document so status changes reflect live. ---
  useEffect(() => {
    if (!eventId) return;
    setClientId(getOrCreateClientId(eventId));

    const fallbackDoc: EventDoc = {
      voteStatus: "not-started",
      requireEmail: true,
      showLiveVoteCounts: false,
      screeningLabel: "",
      screeningDateTime: "",
      allowedMovies: DEFAULT_ALLOWED_MOVIES,
    };

    // If the realtime subscription hasn't delivered a first snapshot within
    // a few seconds (e.g. no network), fall back rather than spinning forever.
    let receivedFirstSnapshot = false;
    const startupTimeoutId = window.setTimeout(() => {
      if (!receivedFirstSnapshot) {
        console.warn("[reelvotes] Event subscription timed out; using fallback defaults.");
        setEventDoc(fallbackDoc);
      }
    }, 6000);

    const unsubscribe = onSnapshot(
      doc(db, "events", eventId),
      (snapshot) => {
        receivedFirstSnapshot = true;
        window.clearTimeout(startupTimeoutId);
        const data = snapshot.data() || {};
        const allowedMovies = Array.isArray(data.allowedMovies)
          ? data.allowedMovies.filter((title: unknown) => typeof title === "string" && title.trim().length > 0)
          : [];
        setEventDoc({
          voteStatus: resolveVoteStatus(data.voteStatus),
          requireEmail: data.requireEmail !== false,
          showLiveVoteCounts: data.showLiveVoteCounts === true,
          screeningLabel: data.screeningLabel || "",
          screeningDateTime: data.screeningDateTime || "",
          allowedMovies: allowedMovies.length > 0 ? allowedMovies : DEFAULT_ALLOWED_MOVIES,
        });
      },
      (error) => {
        console.error("Event subscription failed:", error);
        receivedFirstSnapshot = true;
        window.clearTimeout(startupTimeoutId);
        setEventDoc(fallbackDoc);
      },
    );
    return () => {
      window.clearTimeout(startupTimeoutId);
      unsubscribe();
    };
  }, [eventId]);

  const refreshMovies = useCallback(async (): Promise<RuntimeMovie[]> => {
    if (!eventId) return [];
    try {
      const snapshot = await withTimeout(
        getDocs(collection(db, "events", eventId, "movies")),
        6000,
        null,
        "movie results load",
      );
      if (!snapshot) return [];
      const rows: RuntimeMovie[] = [];
      snapshot.forEach((movieDoc) => {
        const data = (movieDoc.data() || {}) as Record<string, unknown>;
        const title = readMovieTitle(data);
        if (!title) return;
        rows.push({
          title,
          voteCount: readMovieVoteCount(data),
          eliminated: data.eliminated === true,
          poster: readMoviePoster(data),
          tmdbId: readMovieTmdbId(data),
        });
      });
      setMovies(rows);
      return rows;
    } catch (error) {
      console.error("Could not load movie results:", error);
      return [];
    }
  }, [eventId]);

  // --- Determine whether this voter already has a ballot on file. ---
  useEffect(() => {
    if (!eventId || !clientId || !eventDoc) return;

    let cancelled = false;
    (async () => {
      if (eventDoc.voteStatus === "ended") {
        await refreshMovies();
        if (!cancelled) setPhase("ended-results");
        return;
      }

      try {
        const response: any = await withTimeout(
          getVoteStatus({ eventId, clientId }),
          6000,
          { data: { hasVoted: false } },
          "existing vote status lookup",
        );
        if (cancelled) return;
        const data = response?.data || {};
        const titles: string[] = Array.isArray(data.movieTitles)
          ? data.movieTitles
          : data.movieTitle
            ? [data.movieTitle]
            : [];

        if (data.hasVoted && titles.length > 0) {
          await refreshMovies();
          if (cancelled) return;
          setConfirmation({
            titles,
            subtitle: "Thanks for voting! Your ballot is already in. Share the vote with friends to boost your picks.",
            fresh: false,
          });
          setPhase("confirmation");
          return;
        }
      } catch (error) {
        console.error("Could not check vote status:", error);
      }

      const runtimeMovies = await refreshMovies();
      if (cancelled) return;

      const hasActiveBallot = runtimeMovies.length > 0 || eventDoc.voteStatus === "live";
      setPhase(hasActiveBallot ? "voting" : "not-started");
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, clientId, eventDoc?.voteStatus]);

  // React live to the event doc flipping to "ended" or "live" while the voter is on the page.
  useEffect(() => {
    if (!eventDoc || phase === "loading" || phase === "no-event") return;
    if (eventDoc.voteStatus === "ended" && phase !== "ended-results") {
      refreshMovies().then(() => setPhase("ended-results"));
    }
  }, [eventDoc?.voteStatus, phase, refreshMovies]);

  const ballotTitles = useMemo(() => {
    if (!eventDoc) return [];
    const runtimeTitles = movies.map((m) => m.title);
    return runtimeTitles.length > 0 ? runtimeTitles : eventDoc.allowedMovies;
  }, [eventDoc, movies]);

  const filteredTitles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return ballotTitles;
    return ballotTitles.filter((title) => title.toLowerCase().includes(q));
  }, [ballotTitles, searchQuery]);

  const movieByTitle = useMemo(() => {
    const map = new Map<string, RuntimeMovie>();
    movies.forEach((movie) => map.set(movieKey(movie.title), movie));
    return map;
  }, [movies]);

  // Lazily enrich each visible ballot title with TMDB poster/rating/trailer.
  useEffect(() => {
    const missing = filteredTitles.filter((title) => !metadata[movieKey(title)]);
    if (!missing.length) return;
    let cancelled = false;
    missing.forEach((title) => {
      getMovieMetadataByTitle(title).then((data) => {
        if (cancelled) return;
        setMetadata((prev) => (prev[movieKey(title)] ? prev : { ...prev, [movieKey(title)]: data }));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [filteredTitles, metadata]);

  function toggleTitle(title: string) {
    const key = movieKey(title);
    setSelectedTitles((prev) =>
      prev.some((t) => movieKey(t) === key) ? prev.filter((t) => movieKey(t) !== key) : [...prev, title],
    );
    setErrorMessage("");
  }

  async function doSubmit(email: string | null) {
    if (!eventId || !clientId || selectedTitles.length === 0) return;

    setSubmitting(true);
    setErrorMessage("");

    try {
      const payload: Record<string, unknown> = {
        eventId,
        movieTitle: selectedTitles[0],
        movieTitles: selectedTitles,
        clientId,
        captchaToken: turnstile.token,
      };
      if (eventDoc?.requireEmail && email) {
        payload.email = email;
      }

      const response: any = await submitVote(payload);
      const result = response?.data || {};

      if (result.status === "already-voted") {
        const titles: string[] = Array.isArray(result.movieTitles)
          ? result.movieTitles
          : result.movieTitle
            ? [result.movieTitle]
            : selectedTitles;
        await refreshMovies();
        turnstile.reset();
        setConfirmation({
          titles,
          subtitle: "Thanks for voting! Your ballot is already in. Share the vote with friends to boost your picks.",
          fresh: false,
        });
        setPhase("confirmation");
        return;
      }

      const submittedTitles: string[] = Array.isArray(result.movieTitles) ? result.movieTitles : selectedTitles;
      await refreshMovies();
      turnstile.reset();
      setConfirmation({
        titles: submittedTitles,
        subtitle: "Thanks for voting! Help your movie win by sharing this vote with friends.",
        fresh: true,
      });
      setPhase("confirmation");
    } catch (error) {
      console.error("Error recording vote:", error);
      const code = (error as any)?.code;
      if (code === "functions/permission-denied" || (code === "functions/invalid-argument" && /captcha/i.test(String((error as any)?.message || "")))) {
        turnstile.reset();
      }
      setErrorMessage(getSubmitErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmitClick() {
    if (selectedTitles.length === 0) return;
    setErrorMessage("");

    if (selectedTitles.length === 1) {
      setShowSingleVoteReminder(true);
      return;
    }
    proceedPastReminder();
  }

  function proceedPastReminder() {
    setShowSingleVoteReminder(false);

    if (captchaEnabled && !turnstile.token) {
      turnstile.ensureWidget();
      return;
    }

    if (eventDoc?.requireEmail) {
      setEmailValue("");
      setEmailError("");
      setShowEmailModal(true);
      return;
    }

    void doSubmit(null);
  }

  function handleEmailConfirm(event: FormEvent) {
    event.preventDefault();
    const email = emailValue.trim();
    if (!isValidEmail(email)) {
      setEmailError("Please enter a valid email address.");
      return;
    }
    setShowEmailModal(false);
    void doSubmit(email);
  }

  // --- Render -------------------------------------------------------------

  if (phase === "loading") {
    return <StatusCard>Loading the ballot…</StatusCard>;
  }

  if (phase === "no-event") {
    return (
      <StatusCard>
        <p>We couldn't find an active vote right now.</p>
        <a href="/showtimes" className="mt-4 inline-block rounded-full bg-marquee px-6 py-3 text-sm font-semibold text-white">
          Browse showtimes
        </a>
      </StatusCard>
    );
  }

  if (phase === "not-started") {
    return (
      <StatusCard>
        <h2 className="font-display text-xl font-semibold text-ink">Voting has not started</h2>
        <p className="mt-2 text-sm text-ink-soft">This showtime doesn't have an active ballot yet. Please check back soon.</p>
      </StatusCard>
    );
  }

  if (phase === "ended-results") {
    return (
      <div className="mx-auto max-w-2xl">
        <header className="text-center">
          <div className="text-3xl" aria-hidden="true">🏁</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Voting Ended</h2>
          <p className="mt-1 text-sm text-ink-soft">Final rankings are in for this screening.</p>
        </header>
        <div className="mt-8">
          <Leaderboard movies={movies} title="Final Results" />
        </div>
      </div>
    );
  }

  if (phase === "confirmation" && confirmation) {
    return (
      <div className="mx-auto max-w-2xl">
        <header className="text-center">
          <div className="text-3xl" aria-hidden="true">🎬</div>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink">You're In</h2>
          <p className="mt-1 text-sm text-ink-soft">{confirmation.subtitle}</p>
        </header>

        <div className="mt-6 flex flex-col gap-2">
          {confirmation.titles.map((title) => (
            <div key={title} className="flex items-center gap-3 rounded-xl border border-line bg-paper p-3">
              {metadata[movieKey(title)]?.poster ? (
                <img src={metadata[movieKey(title)]!.poster!} alt="" className="h-16 w-11 rounded-md object-cover" />
              ) : (
                <div className="h-16 w-11 shrink-0 rounded-md bg-cream-soft" />
              )}
              <p className="text-sm font-semibold text-ink">{title}</p>
            </div>
          ))}
        </div>

        <div className="mt-6 text-center">
          <a href="/showtimes" className="text-sm font-semibold text-marquee hover:underline">
            &larr; Browse other showtimes
          </a>
        </div>

        {(eventDoc?.showLiveVoteCounts || eventDoc?.voteStatus === "ended") && movies.length > 0 && (
          <div className="mt-10">
            <Leaderboard movies={movies} title={eventDoc?.voteStatus === "ended" ? "Final Results" : "Current Standings"} />
          </div>
        )}
      </div>
    );
  }

  if (submitting) {
    return (
      <StatusCard>
        <div className="text-3xl" aria-hidden="true">⏳</div>
        <h2 className="mt-2 font-display text-xl font-semibold text-ink">Counting your vote…</h2>
        <p className="mt-1 text-sm text-ink-soft">Fetching live results now.</p>
      </StatusCard>
    );
  }

  // phase === "voting"
  return (
    <div className="mx-auto max-w-2xl pb-28">
      {eventDoc?.screeningLabel && (
        <header className="mb-6 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-soft px-3 py-1 text-xs font-semibold text-emerald">
            Voting live
          </span>
          <h1 className="mt-3 font-display text-2xl font-semibold text-ink sm:text-3xl">{eventDoc.screeningLabel}</h1>
        </header>
      )}

      <input
        type="search"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder="Search the ballot"
        className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
      />

      {errorMessage && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage}</div>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {filteredTitles.length === 0 && (
          <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">No movies match your search.</p>
        )}
        {filteredTitles.map((title) => {
          const key = movieKey(title);
          const runtime = movieByTitle.get(key);
          const meta = metadata[key];
          const poster = runtime?.poster || meta?.poster || null;
          const eliminated = runtime?.eliminated === true;
          const selected = selectedTitles.some((t) => movieKey(t) === key);
          const trailerUrl = meta?.trailerUrl;

          return (
            <button
              key={title}
              type="button"
              disabled={eliminated}
              onClick={() => toggleTitle(title)}
              className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                eliminated
                  ? "cursor-not-allowed border-line bg-cream-soft opacity-50"
                  : selected
                    ? "border-marquee bg-marquee-soft"
                    : "border-line bg-paper hover:border-marquee/40"
              }`}
            >
              {poster ? (
                <img src={poster} alt="" className="h-20 w-14 shrink-0 rounded-md object-cover" />
              ) : (
                <div className="h-20 w-14 shrink-0 rounded-md bg-cream-soft" />
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{title}</p>
                <div className="mt-1 flex items-center gap-2 text-xs text-ink-soft">
                  {meta?.starRating && <span>{meta.starRating}</span>}
                  {eventDoc?.showLiveVoteCounts && runtime && (
                    <span>
                      {runtime.voteCount} vote{runtime.voteCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {eliminated && <span className="font-semibold text-red-600">Eliminated</span>}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {trailerUrl && (
                  <a
                    href={trailerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Watch ${title} trailer on YouTube`}
                    className="grid h-8 w-8 place-items-center rounded-full border border-line text-ink transition-colors hover:border-marquee/50 hover:text-marquee"
                  >
                    ▶
                  </a>
                )}
                <span
                  className={`grid h-6 w-6 place-items-center rounded-full border text-xs font-bold ${
                    selected ? "border-marquee bg-marquee text-white" : "border-line text-transparent"
                  }`}
                  aria-hidden="true"
                >
                  ✓
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {selectedTitles.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 px-5 py-4 backdrop-blur-sm sm:px-8">
          <div className="mx-auto max-w-2xl">
            {captchaEnabled && (
              <div className="mb-3">
                <div ref={turnstile.containerRef} />
                {turnstile.notice && <p className="mt-1 text-xs text-red-600">{turnstile.notice}</p>}
              </div>
            )}
            <button
              type="button"
              onClick={handleSubmitClick}
              disabled={captchaEnabled && !turnstile.token}
              className="w-full rounded-full bg-marquee px-6 py-3.5 text-sm font-semibold text-white shadow-md shadow-marquee/30 transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Submit {selectedTitles.length > 1 ? `${selectedTitles.length} Votes` : "Vote"}
            </button>
          </div>
        </div>
      )}

      {showSingleVoteReminder && (
        <Modal onDismiss={() => setShowSingleVoteReminder(false)}>
          <h3 className="font-display text-lg font-semibold text-ink">You can vote for multiple movies</h3>
          <p className="mt-2 text-sm text-ink-soft">
            Press OK to submit your ballot as-is, or go back and select more movies you'd want to see.
          </p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
            <button
              type="button"
              onClick={proceedPastReminder}
              className="rounded-full bg-marquee px-5 py-2.5 text-sm font-semibold text-white sm:flex-1"
            >
              OK, submit
            </button>
            <button
              type="button"
              onClick={() => setShowSingleVoteReminder(false)}
              className="rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink sm:flex-1"
            >
              Go back
            </button>
          </div>
        </Modal>
      )}

      {showEmailModal && (
        <Modal onDismiss={() => setShowEmailModal(false)}>
          <h3 className="font-display text-lg font-semibold text-ink">One last step</h3>
          <p className="mt-2 text-sm text-ink-soft">Your vote is not counted until a valid email is added.</p>
          <form onSubmit={handleEmailConfirm} className="mt-4">
            <input
              type="email"
              autoFocus
              required
              value={emailValue}
              onChange={(event) => setEmailValue(event.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
            />
            {emailError && <p className="mt-2 text-xs text-red-600">{emailError}</p>}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
              <button type="submit" className="rounded-full bg-marquee px-5 py-2.5 text-sm font-semibold text-white sm:flex-1">
                Count my vote
              </button>
              <button
                type="button"
                onClick={() => setShowEmailModal(false)}
                className="rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink sm:flex-1"
              >
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function StatusCard({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-line bg-paper p-8 text-center">
      {typeof children === "string" ? <p className="text-sm text-ink-soft">{children}</p> : children}
    </div>
  );
}

function Modal({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-5"
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-line bg-paper p-6 shadow-xl">{children}</div>
    </div>
  );
}

function Leaderboard({ movies, title }: { movies: RuntimeMovie[]; title: string }) {
  const rows = [...movies].sort((a, b) => b.voteCount - a.voteCount);
  const total = rows.reduce((sum, item) => sum + item.voteCount, 0);

  if (!rows.length) {
    return <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">No votes yet.</p>;
  }

  return (
    <section>
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      <div className="mt-4 flex flex-col gap-3">
        {rows.map((item, index) => {
          const percent = total > 0 ? Math.round((item.voteCount / total) * 100) : 0;
          return (
            <div
              key={item.title}
              className={`rounded-xl border p-4 ${index === 0 ? "border-gold/50 bg-gold-soft" : "border-line bg-paper"}`}
            >
              <div className="flex items-center justify-between gap-3 text-sm">
                <p className="font-semibold text-ink">
                  #{index + 1} {item.title}
                </p>
                <p className="shrink-0 text-ink-soft">
                  {item.voteCount} · {percent}%
                </p>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-cream-soft">
                <div
                  className={`h-full rounded-full ${index === 0 ? "bg-gold" : "bg-marquee"}`}
                  style={{ width: `${Math.min(percent, 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
