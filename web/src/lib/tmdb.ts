// TMDB integration — ported from the old vanilla-JS site (public/app.js).
// Movies are only ever chosen from a fixed, curated ballot list; TMDB is used
// purely to enrich each title with a poster, star rating, and trailer link.

const TMDB_API_KEY = "05e2d906f097b769ba4d7e8c7305accf";
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

// A small number of titles TMDB's search doesn't resolve well by name alone.
const TMDB_TITLE_OVERRIDES: Record<string, { tmdbId: number }> = {
  "blade runner": { tmdbId: 78 },
};

// Local fallback posters for the default ballot, in case TMDB is unreachable
// or a search comes back empty.
const LOCAL_POSTER_FALLBACKS: Record<string, string> = {
  "back to the future": "https://image.tmdb.org/t/p/w185/vN5B5WgYscRGcQpVhHl6p9DDTP0.jpg",
  "jurassic park": "https://image.tmdb.org/t/p/w185/63viWuPfYQjRYLSZSZNq7dglJP5.jpg",
  "blade runner": "https://image.tmdb.org/t/p/w185/63N9uy8nd9j7Eog2axPQ8lbr3Wj.jpg",
  "in the mood for love": "https://image.tmdb.org/t/p/w185/iYypPT4bhqXfq1b6EnmxvRt6b2Y.jpg",
  "mean girls": "https://image.tmdb.org/t/p/w185/2ZkuQXvVhh45uSvkBej4S7Ix1NJ.jpg",
  "bring it on": "https://image.tmdb.org/t/p/w185/bnVby0qI0dS7YunbShP7mw68HY3.jpg",
  "the notebook": "https://image.tmdb.org/t/p/w185/rNzQyW4f8B8cQeg7Dgj3n6eT5k9.jpg",
  "blade": "https://image.tmdb.org/t/p/w185/oWT70TvbsmQaqyphCZpsnQR7R32.jpg",
  "battle royale": "https://image.tmdb.org/t/p/w185/aLGKAQKgzWpJ6egyWzzC11jXBRJ.jpg",
  "mad max: fury road": "https://image.tmdb.org/t/p/w185/ulcAi4dKpAjHwYGS08vNyx9H6I9.jpg",
};

export interface MovieMetadata {
  tmdbId: number | null;
  poster: string | null;
  starRating: string | null;
  trailerUrl: string;
}

const movieMetadataCache = new Map<string, MovieMetadata>();

function buildPosterUrl(posterPath: string | null | undefined, size = "w185"): string | null {
  return posterPath ? `https://image.tmdb.org/t/p/${size}${posterPath}` : null;
}

function buildYouTubeTrailerSearchUrl(title: string): string {
  const query = `${String(title || "").trim()} official trailer`;
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

function selectYouTubeTrailerUrl(videos: any, fallbackTitle = ""): string {
  const items = Array.isArray(videos?.results) ? videos.results : [];
  const youtubeVideos = items.filter(
    (item: any) => String(item?.site || "").toLowerCase() === "youtube" && item?.key,
  );
  const preferred =
    youtubeVideos.find((item: any) => String(item?.type || "").toLowerCase() === "trailer") ||
    youtubeVideos.find((item: any) => String(item?.type || "").toLowerCase() === "teaser") ||
    youtubeVideos[0] ||
    null;

  if (preferred?.key) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(preferred.key)}`;
  }

  return buildYouTubeTrailerSearchUrl(fallbackTitle);
}

function formatStarRating(voteAverage: unknown): string | null {
  const numeric = Number(voteAverage);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return `${numeric.toFixed(1)}★`;
}

function normalizeMovieTitleForSearch(title: string): string {
  const raw = String(title || "").trim();
  if (!raw) return "";

  const trailingArticleMatch = raw.match(/^(.*),\s*(The|A|An)$/i);
  const withLeadingArticle = trailingArticleMatch
    ? `${trailingArticleMatch[2]} ${trailingArticleMatch[1]}`.trim()
    : raw;

  return withLeadingArticle
    .replace(/\s+/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim();
}

function getLocalPosterFallback(title: string): string | null {
  return LOCAL_POSTER_FALLBACKS[String(title || "").trim().toLowerCase()] || null;
}

async function searchTMDB(query: string): Promise<any[]> {
  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`,
    );
    if (!response.ok) return [];
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error("TMDB search error:", error);
    return [];
  }
}

async function getMovieDetails(movieId: number): Promise<any | null> {
  try {
    const response = await fetch(
      `${TMDB_BASE_URL}/movie/${movieId}?api_key=${TMDB_API_KEY}&append_to_response=credits,videos`,
    );
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("Error fetching movie details:", error);
    return null;
  }
}

export async function getMovieMetadataByTitle(title: string): Promise<MovieMetadata> {
  const normalizedLookupTitle = normalizeMovieTitleForSearch(title);
  const localPosterFallback = getLocalPosterFallback(normalizedLookupTitle);

  if (!normalizedLookupTitle) {
    return {
      tmdbId: null,
      poster: localPosterFallback,
      starRating: null,
      trailerUrl: buildYouTubeTrailerSearchUrl(title),
    };
  }

  const cacheKey = normalizedLookupTitle.toLowerCase();
  if (movieMetadataCache.has(cacheKey)) {
    return movieMetadataCache.get(cacheKey)!;
  }

  try {
    const normalizedTitle = normalizedLookupTitle.toLowerCase();
    const override = TMDB_TITLE_OVERRIDES[normalizedTitle];

    if (override?.tmdbId) {
      const details = await getMovieDetails(override.tmdbId);
      const metadata: MovieMetadata = {
        tmdbId: override.tmdbId,
        poster: buildPosterUrl(details?.poster_path, "w185"),
        starRating: formatStarRating(details?.vote_average),
        trailerUrl: selectYouTubeTrailerUrl(details?.videos, normalizedLookupTitle),
      };
      movieMetadataCache.set(cacheKey, metadata);
      return metadata;
    }

    const searchCandidates = [
      normalizedLookupTitle,
      normalizedLookupTitle.replace(/[:\-–—]/g, " ").replace(/\s+/g, " ").trim(),
      normalizedLookupTitle.replace(/\(.*?\)/g, "").trim(),
    ].filter(Boolean);

    let results: any[] = [];
    for (const candidate of searchCandidates) {
      const next = await searchTMDB(candidate);
      if (Array.isArray(next) && next.length) {
        results = next;
        break;
      }
    }

    const exact = results.find((movie) => movie.title?.trim().toLowerCase() === normalizedTitle) || null;
    const withPoster = results.find((movie) => Boolean(movie?.poster_path)) || null;
    const exactWithPoster =
      results.find((movie) => movie.title?.trim().toLowerCase() === normalizedTitle && movie?.poster_path) || null;
    const match = exactWithPoster || withPoster || exact || results[0] || null;

    let metadata: MovieMetadata = {
      tmdbId: match?.id || null,
      poster: buildPosterUrl(match?.poster_path, "w185") || localPosterFallback,
      starRating: formatStarRating(match?.vote_average),
      trailerUrl: buildYouTubeTrailerSearchUrl(normalizedLookupTitle),
    };

    if (metadata.tmdbId) {
      const details = await getMovieDetails(metadata.tmdbId);
      metadata = {
        ...metadata,
        poster: metadata.poster || buildPosterUrl(details?.poster_path, "w185"),
        starRating: metadata.starRating || formatStarRating(details?.vote_average),
        trailerUrl: selectYouTubeTrailerUrl(details?.videos, normalizedLookupTitle),
      };
    }

    movieMetadataCache.set(cacheKey, metadata);
    return metadata;
  } catch (error) {
    console.error("Error fetching movie metadata:", error);
    return {
      tmdbId: null,
      poster: localPosterFallback,
      starRating: null,
      trailerUrl: buildYouTubeTrailerSearchUrl(title),
    };
  }
}

export { buildYouTubeTrailerSearchUrl };
