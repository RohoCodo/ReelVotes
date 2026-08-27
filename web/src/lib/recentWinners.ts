import { collection, getDocs } from "firebase/firestore/lite";
import { dbLite as db } from "./firebase-lite";
import { getMovieMetadataByTitle } from "./tmdb";

export interface WinnerCard {
  eventId: string;
  movieTitle: string;
  poster: string | null;
  theaterName: string;
  voteCount: number;
}

interface EventDoc {
  id: string;
  voteStatus?: string;
  theaterName?: string;
  screeningDateTime?: unknown;
}

function getWinnerVoteCount(movie: Record<string, unknown>): number {
  const raw = movie.vote_count ?? movie.voteCount ?? movie.votes ?? 0;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getWinnerTitle(movie: Record<string, unknown>): string {
  return String(movie.movie_title ?? movie.title ?? movie.movieTitle ?? "").trim();
}

function getWinnerPoster(movie: Record<string, unknown>): string | null {
  const poster = movie.poster ?? movie.posterUrl ?? movie.poster_url ?? null;
  return poster ? String(poster) : null;
}

function toSortTimestamp(value: unknown): number {
  if (!value) return 0;

  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  if (typeof value === "object" && value !== null) {
    const maybeTimestamp = value as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (typeof maybeTimestamp.toMillis === "function") {
      const millis = maybeTimestamp.toMillis();
      return Number.isFinite(millis) ? millis : 0;
    }
    if (typeof maybeTimestamp.seconds === "number") {
      return maybeTimestamp.seconds * 1000 + Math.floor((maybeTimestamp.nanoseconds || 0) / 1_000_000);
    }
  }

  return 0;
}

// Module-level cache so multiple components (the hero's decorative posters
// and the full "Picked by the audience" showcase) share one Firestore/TMDB
// fetch instead of each running it independently.
let cachedWinnersPromise: Promise<WinnerCard[]> | null = null;

async function fetchRecentWinners(): Promise<WinnerCard[]> {
  // Fetch all events (no orderBy so we don't exclude legacy docs missing
  // screeningDateTime), then sort client-side and keep every ended poll.
  const eventsSnapshot = await getDocs(collection(db, "events"));
  const endedEvents = eventsSnapshot.docs
    .map((docSnap): EventDoc => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((event) => event.voteStatus === "ended")
    .sort((a, b) => toSortTimestamp(b.screeningDateTime) - toSortTimestamp(a.screeningDateTime));

  const results = await Promise.all(
    endedEvents.map(async (event): Promise<WinnerCard | null> => {
      const moviesSnapshot = await getDocs(collection(db, "events", event.id, "movies"));
      const movies = moviesSnapshot.docs.map((docSnap) => docSnap.data() as Record<string, unknown>);
      if (movies.length === 0) return null;

      const winner = movies.reduce((top, current) =>
        getWinnerVoteCount(current) > getWinnerVoteCount(top) ? current : top
      );
      const movieTitle = getWinnerTitle(winner);
      if (!movieTitle) return null;

      const metadata = await getMovieMetadataByTitle(movieTitle);
      return {
        eventId: event.id,
        movieTitle,
        poster: getWinnerPoster(winner) || metadata.poster,
        theaterName: String(event.theaterName || "The New Parkway Theater"),
        voteCount: getWinnerVoteCount(winner),
      };
    })
  );

  return results.filter((card): card is WinnerCard => card !== null);
}

export function getRecentWinners(): Promise<WinnerCard[]> {
  if (!cachedWinnersPromise) {
    cachedWinnersPromise = fetchRecentWinners().catch((error) => {
      console.error("[recentWinners] Could not load recent winners:", error);
      cachedWinnersPromise = null; // allow a retry on the next call
      return [];
    });
  }
  return cachedWinnersPromise;
}
