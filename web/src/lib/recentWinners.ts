import { collection, getDocs, limit, orderBy, query } from "firebase/firestore/lite";
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
}

// Module-level cache so multiple components (the hero's decorative posters
// and the full "Picked by the audience" showcase) share one Firestore/TMDB
// fetch instead of each running it independently.
let cachedWinnersPromise: Promise<WinnerCard[]> | null = null;

async function fetchRecentWinners(): Promise<WinnerCard[]> {
  // Fetch by date (a single-field index, always available) and filter to
  // "ended" client-side, rather than a where()+orderBy() combo that would
  // need a new composite index deployed to the production Firestore project.
  const recentEventsQuery = query(collection(db, "events"), orderBy("screeningDateTime", "desc"), limit(20));
  const eventsSnapshot = await getDocs(recentEventsQuery);
  const endedEvents = eventsSnapshot.docs
    .map((docSnap): EventDoc => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((event) => event.voteStatus === "ended")
    .slice(0, 6);

  const results = await Promise.all(
    endedEvents.map(async (event): Promise<WinnerCard | null> => {
      const moviesSnapshot = await getDocs(collection(db, "events", event.id, "movies"));
      const movies = moviesSnapshot.docs.map((docSnap) => docSnap.data() as Record<string, unknown>);
      if (movies.length === 0) return null;

      const winner = movies.reduce((top, current) =>
        Number(current.vote_count || 0) > Number(top.vote_count || 0) ? current : top
      );
      const movieTitle = String(winner.movie_title || "").trim();
      if (!movieTitle) return null;

      const metadata = await getMovieMetadataByTitle(movieTitle);
      return {
        eventId: event.id,
        movieTitle,
        poster: (winner.poster as string) || metadata.poster,
        theaterName: String(event.theaterName || "The New Parkway Theater"),
        voteCount: Number(winner.vote_count || 0),
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
