import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { User } from "firebase/auth";
import { collection, onSnapshot, orderBy, query as fsQuery } from "firebase/firestore";
import { ref as storageRef, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import {
  db,
  reelSuccessSyncAccess,
  reelSuccessListTheaters,
  reelSuccessGetMyTheater,
  reelSuccessGetTheaterInsights,
  reelSuccessCreateGrossUploadSession,
  reelSuccessFinalizeGrossUpload,
  reelSuccessDeleteGrossUpload,
} from "../lib/firebase";
import { auth, googleProvider, signInWithPopup, onAuthStateChanged, signOut } from "../lib/firebase-auth";
import { storage } from "../lib/firebase-storage";
import { getMovieMetadataByTitle, type MovieMetadata } from "../lib/tmdb";
import { withTimeout } from "../lib/withTimeout";

// --- Types -----------------------------------------------------------------

type Role = "theater_user" | "super_admin";

interface Claims {
  role: Role | null;
  admin: boolean;
  theaterId: string | null;
  theaterKey: string | null;
}

interface TheaterSummary {
  theater_key: string;
  theater_code?: string;
  theater_name: string;
  theater_city_state?: string;
  demographics_status?: string;
  city?: string;
  state_abbr?: string;
  population?: number;
  median_household_income?: number;
  median_age?: number;
  total_screens?: number;
  unique_movies?: number;
  non_friday_rate?: number;
}

interface SimilarTheater {
  theater_key: string;
  theater_name: string;
  theater_city_state?: string;
  score: number;
  confidence?: string | number;
  historical_overlap_score?: number;
  movie_similarity?: number;
  demographic_similarity?: number;
  operational_similarity?: number;
}

interface RecommendationSimilarTheater {
  theater_key: string;
  theater_name: string;
  theater_city_state?: string;
  similarity_score: number;
}

interface Recommendation {
  movie_title: string;
  recommendation_score: number;
  support_theater_count: number;
  weighted_movie_signal?: number;
  similar_theaters: RecommendationSimilarTheater[];
}

interface InsightsResponse {
  ok: boolean;
  dataVersion?: string;
  profile: TheaterSummary | null;
  similar_theaters: SimilarTheater[];
  recommendations: Recommendation[];
  based_on_similar_theaters?: number;
}

interface GrossUploadRow {
  id: string;
  businessDate?: string;
  fileName?: string;
  uploadedAt?: { toDate?: () => Date } | null;
  uploadedByEmail?: string;
  status?: string;
  storagePath?: string;
}

type FileUploadStatus = "pending" | "uploading" | "finalizing" | "done" | "error";

interface FileUploadState {
  key: string;
  name: string;
  status: FileUploadStatus;
  progress: number;
  error?: string;
}

type AuthPhase = "checking" | "signed-out" | "syncing" | "no-access" | "ready";
type Tab = "find" | "grosses";

// --- Helpers -----------------------------------------------------------------

function formatNumber(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function formatCurrency(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString()}`;
}

function formatPercent(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  // Values may already be 0-1 fractions or 0-100 — normalize.
  const pct = n <= 1 ? n * 100 : n;
  return `${Math.round(pct)}%`;
}

function movieKey(title: string): string {
  return String(title || "").trim().toLowerCase();
}

function getAccessErrorMessage(error: any): string {
  const message = String(error?.message || "");
  return message || "You don't have ReelSuccess access. Contact an admin to be granted access.";
}

// --- Component ---------------------------------------------------------------

export default function ReelSuccessDashboard() {
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<Claims | null>(null);
  const [accessError, setAccessError] = useState("");
  const [signInError, setSignInError] = useState("");
  const [tab, setTab] = useState<Tab>("find");

  const isSuperAdmin = claims?.admin === true || claims?.role === "super_admin";

  // --- Auth lifecycle --------------------------------------------------------
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      setSignInError("");
      if (!nextUser) {
        setUser(null);
        setClaims(null);
        setAuthPhase("signed-out");
        return;
      }

      setUser(nextUser);
      setAuthPhase("syncing");
      setAccessError("");

      try {
        await reelSuccessSyncAccess();
        const tokenResult = await nextUser.getIdTokenResult(true);
        const rawClaims = tokenResult?.claims || {};
        const role = String(rawClaims.role || "").trim();
        setClaims({
          role: role === "super_admin" || role === "theater_user" ? (role as Role) : null,
          admin: rawClaims.admin === true,
          theaterId: (rawClaims.theaterId as string) || null,
          theaterKey: (rawClaims.theaterKey as string) || null,
        });
        setAuthPhase("ready");
      } catch (error) {
        console.error("ReelSuccess access sync failed:", error);
        setAccessError(getAccessErrorMessage(error));
        setAuthPhase("no-access");
      }
    });
    return () => unsubscribe();
  }, []);

  async function handleSignIn() {
    setSignInError("");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: any) {
      console.error("Sign-in failed:", error);
      setSignInError(error?.message || "Sign in failed. Please try again.");
    }
  }

  async function handleSignOut() {
    await signOut(auth);
  }

  // --- Render: gates ----------------------------------------------------------

  if (authPhase === "checking") {
    return <StatusCard>Loading ReelSuccess…</StatusCard>;
  }

  if (authPhase === "signed-out") {
    return (
      <StatusCard>
        <h2 className="font-display text-xl font-semibold text-ink">Sign in to ReelSuccess</h2>
        <p className="mt-2 text-sm text-ink-soft">
          ReelSuccess is an internal analytics tool for theater partners. Sign in with your Google account to
          continue.
        </p>
        <button
          type="button"
          onClick={handleSignIn}
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-marquee px-6 py-3 text-sm font-semibold text-white shadow-md shadow-marquee/30 transition-transform hover:-translate-y-0.5"
        >
          Sign in with Google
        </button>
        {signInError && <p className="mt-3 text-xs text-red-600">{signInError}</p>}
      </StatusCard>
    );
  }

  if (authPhase === "syncing") {
    return <StatusCard>Checking your access…</StatusCard>;
  }

  if (authPhase === "no-access") {
    return (
      <StatusCard>
        <h2 className="font-display text-xl font-semibold text-ink">No ReelSuccess access</h2>
        <p className="mt-2 text-sm text-ink-soft">{accessError}</p>
        <p className="mt-4 text-xs text-ink-faint">Signed in as {user?.email}</p>
        <button
          type="button"
          onClick={handleSignOut}
          className="mt-4 rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-ink/30"
        >
          Sign out
        </button>
      </StatusCard>
    );
  }

  // authPhase === "ready"
  return (
    <div>
      <DashboardHeader user={user} claims={claims} onSignOut={handleSignOut} />

      <div className="mt-6 grid grid-cols-2 gap-1 rounded-full bg-cream-soft p-1 text-sm font-semibold sm:inline-grid sm:w-auto">
        <button
          type="button"
          onClick={() => setTab("find")}
          className={`rounded-full px-4 py-2 transition-colors ${
            tab === "find" ? "bg-marquee text-white" : "text-ink-soft"
          }`}
        >
          Find Your Next Movie
        </button>
        <button
          type="button"
          onClick={() => setTab("grosses")}
          className={`rounded-full px-4 py-2 transition-colors ${
            tab === "grosses" ? "bg-marquee text-white" : "text-ink-soft"
          }`}
        >
          Upload and Manage Grosses
        </button>
      </div>

      <div className="mt-6">
        {tab === "find" ? (
          <FindMovieTab isSuperAdmin={Boolean(isSuperAdmin)} />
        ) : (
          <GrossesTab claims={claims!} isSuperAdmin={Boolean(isSuperAdmin)} userEmail={user?.email || ""} />
        )}
      </div>
    </div>
  );
}

function DashboardHeader({
  user,
  claims,
  onSignOut,
}: {
  user: User | null;
  claims: Claims | null;
  onSignOut: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink sm:text-3xl">ReelSuccess</h1>
        <p className="mt-1 text-sm text-ink-soft">
          {claims?.admin || claims?.role === "super_admin" ? "Super admin" : "Theater partner"} · {user?.email}
        </p>
      </div>
      <button
        type="button"
        onClick={onSignOut}
        className="shrink-0 rounded-full border border-line px-4 py-2 text-xs font-semibold text-ink transition-colors hover:border-ink/30"
      >
        Sign out
      </button>
    </header>
  );
}

function StatusCard({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-line bg-paper p-8 text-center">
      {typeof children === "string" ? <p className="text-sm text-ink-soft">{children}</p> : children}
    </div>
  );
}

// --- Shared theater selection -------------------------------------------------
// Both tabs need "which theater is selected" but each has its own search UI
// instance (mirrors the old site's two independent search boxes). We keep the
// selection itself lifted to a small shared hook so switching tabs doesn't
// lose context.

function useTheaterSelection(isSuperAdmin: boolean) {
  const [selected, setSelected] = useState<TheaterSummary | null>(null);
  const [loadingMine, setLoadingMine] = useState(false);
  const [myTheaterError, setMyTheaterError] = useState("");

  const loadMyTheater = useCallback(async () => {
    setLoadingMine(true);
    setMyTheaterError("");
    try {
      const response: any = await reelSuccessGetMyTheater();
      const theater = response?.data?.theater || response?.data;
      if (theater && theater.theater_key) {
        setSelected(theater as TheaterSummary);
      } else {
        setMyTheaterError("No theater is linked to this account yet.");
      }
    } catch (error: any) {
      console.error("reelSuccessGetMyTheater failed:", error);
      setMyTheaterError(error?.message || "Could not load your theater.");
    } finally {
      setLoadingMine(false);
    }
  }, []);

  // Non-admins are locked to their own theater — auto-resolve on mount,
  // never show a picker.
  useEffect(() => {
    if (!isSuperAdmin) {
      void loadMyTheater();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  return { selected, setSelected, loadingMine, myTheaterError, loadMyTheater };
}

function TheaterPicker({
  isSuperAdmin,
  selected,
  setSelected,
  loadingMine,
  myTheaterError,
  loadMyTheater,
}: {
  isSuperAdmin: boolean;
  selected: TheaterSummary | null;
  setSelected: (t: TheaterSummary | null) => void;
  loadingMine: boolean;
  myTheaterError: string;
  loadMyTheater: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<TheaterSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function runSearch(q: string) {
    setSearchQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const response: any = await withTimeout(
          reelSuccessListTheaters({ query: q }),
          6000,
          null,
          "theater search",
        );
        const rows: TheaterSummary[] = Array.isArray(response?.data?.theaters) ? response.data.theaters : [];
        setResults(rows);
      } catch (error) {
        console.error("reelSuccessListTheaters failed:", error);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 200);
  }

  useEffect(() => {
    if (isSuperAdmin) runSearch("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin]);

  // Non-admin: no picker at all, just theater context + loading/error states.
  if (!isSuperAdmin) {
    if (loadingMine) {
      return <p className="text-sm text-ink-soft">Loading your theater…</p>;
    }
    if (myTheaterError) {
      return (
        <div className="rounded-xl border border-line bg-cream-soft p-4">
          <p className="text-sm text-ink-soft">{myTheaterError}</p>
          <button
            type="button"
            onClick={loadMyTheater}
            className="mt-3 rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-ink/30"
          >
            Retry
          </button>
        </div>
      );
    }
    if (!selected) {
      return <p className="text-sm text-ink-soft">Resolving your theater…</p>;
    }
    return <TheaterContextCard theater={selected} />;
  }

  // Super admin: full search + select experience.
  return (
    <div>
      {selected ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-cream p-4">
          <TheaterContextCard theater={selected} bare />
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="shrink-0 whitespace-nowrap rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-ink/30"
          >
            Change
          </button>
        </div>
      ) : (
        <>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => runSearch(event.target.value)}
            placeholder="Search theaters by name or city"
            className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
          />
          <div className="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto">
            {searching && <p className="p-2 text-xs text-ink-faint">Searching…</p>}
            {!searching && results.length === 0 && (
              <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">No theaters found.</p>
            )}
            {results.map((theater) => (
              <button
                key={theater.theater_key}
                type="button"
                onClick={() => setSelected(theater)}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-cream px-4 py-3 text-left transition-colors hover:border-marquee/40"
              >
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-ink">{theater.theater_name}</h3>
                  <p className="mt-0.5 truncate text-xs text-ink-soft">{theater.theater_city_state}</p>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TheaterContextCard({ theater, bare = false }: { theater: TheaterSummary; bare?: boolean }) {
  const content = (
    <div className="min-w-0">
      <h3 className="truncate text-sm font-semibold text-ink">{theater.theater_name}</h3>
      <p className="mt-0.5 truncate text-xs text-ink-soft">{theater.theater_city_state}</p>
    </div>
  );
  if (bare) return content;
  return <div className="rounded-xl border border-line bg-cream p-4">{content}</div>;
}

// --- Tab 1: Find Your Next Movie ----------------------------------------------

function FindMovieTab({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const { selected, setSelected, loadingMine, myTheaterError, loadMyTheater } = useTheaterSelection(isSuperAdmin);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
      <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold text-ink">Theater</h2>
        <div className="mt-4">
          <TheaterPicker
            isSuperAdmin={isSuperAdmin}
            selected={selected}
            setSelected={setSelected}
            loadingMine={loadingMine}
            myTheaterError={myTheaterError}
            loadMyTheater={loadMyTheater}
          />
        </div>
      </section>

      <div className="min-w-0">
        {selected ? (
          <InsightsPanel theaterKey={selected.theater_key} />
        ) : (
          <div className="rounded-2xl border border-dashed border-line bg-paper p-8 text-center text-sm text-ink-soft">
            Select a theater to see recommendations.
          </div>
        )}
      </div>
    </div>
  );
}

function InsightsPanel({ theaterKey }: { theaterKey: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [insights, setInsights] = useState<InsightsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setInsights(null);

    reelSuccessGetTheaterInsights({ theaterKey })
      .then((response: any) => {
        if (cancelled) return;
        setInsights(response?.data || null);
      })
      .catch((err: any) => {
        console.error("reelSuccessGetTheaterInsights failed:", err);
        if (!cancelled) setError(err?.message || "Could not load insights for this theater.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [theaterKey]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-line bg-paper p-8 text-center text-sm text-ink-soft">
        Loading insights…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-line bg-paper p-8 text-center">
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (!insights) {
    return (
      <div className="rounded-2xl border border-line bg-paper p-8 text-center text-sm text-ink-soft">
        No insights available.
      </div>
    );
  }

  const noData =
    (!insights.similar_theaters || insights.similar_theaters.length === 0) &&
    (!insights.recommendations || insights.recommendations.length === 0);

  return (
    <div className="flex flex-col gap-6">
      {insights.profile && <ProfileCard profile={insights.profile} />}

      {noData ? (
        <div className="rounded-2xl border border-dashed border-line bg-paper p-8 text-center text-sm text-ink-soft">
          Not enough data for this theater yet.
        </div>
      ) : (
        <>
          <SimilarTheatersCard theaters={insights.similar_theaters || []} />
          <RecommendationsCard recommendations={insights.recommendations || []} />
        </>
      )}
    </div>
  );
}

function ProfileCard({ profile }: { profile: TheaterSummary }) {
  const stats: Array<{ label: string; value: string }> = [
    { label: "Population", value: formatNumber(profile.population) },
    { label: "Median household income", value: formatCurrency(profile.median_household_income) },
    { label: "Median age", value: profile.median_age != null ? String(profile.median_age) : "—" },
    { label: "Total screens", value: formatNumber(profile.total_screens) },
    { label: "Unique movies programmed", value: formatNumber(profile.unique_movies) },
    { label: "Non-Friday-opening rate", value: formatPercent(profile.non_friday_rate) },
  ];

  return (
    <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold text-ink">{profile.theater_name}</h2>
      {profile.theater_city_state && <p className="mt-1 text-xs text-ink-soft">{profile.theater_city_state}</p>}
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {stats.map((stat) => (
          <div key={stat.label}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{stat.label}</p>
            <p className="mt-1 font-display text-lg font-semibold text-ink">{stat.value}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function SimilarTheatersCard({ theaters }: { theaters: SimilarTheater[] }) {
  if (!theaters.length) {
    return (
      <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold text-ink">Most Similar Theaters</h2>
        <p className="mt-3 text-sm text-ink-soft">No similar theaters found.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold text-ink">Most Similar Theaters</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              <th className="pb-2 pr-3">Theater</th>
              <th className="pb-2 pr-3">City / State</th>
              <th className="pb-2">Similarity</th>
            </tr>
          </thead>
          <tbody>
            {theaters.map((t) => {
              const pct = Math.max(0, Math.min(100, t.score <= 1 ? t.score * 100 : t.score));
              return (
                <tr key={t.theater_key} className="border-b border-line-soft last:border-b-0">
                  <td className="py-2.5 pr-3 font-medium text-ink">{t.theater_name}</td>
                  <td className="py-2.5 pr-3 text-ink-soft">{t.theater_city_state || "—"}</td>
                  <td className="py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-cream-soft">
                        <div className="h-full rounded-full bg-marquee" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="whitespace-nowrap text-xs text-ink-soft">{formatPercent(t.score)}</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RecommendationsCard({ recommendations }: { recommendations: Recommendation[] }) {
  const [metadata, setMetadata] = useState<Record<string, MovieMetadata>>({});

  useEffect(() => {
    const missing = recommendations.filter((r) => !metadata[movieKey(r.movie_title)]);
    if (!missing.length) return;
    let cancelled = false;
    missing.forEach((r) => {
      getMovieMetadataByTitle(r.movie_title).then((data) => {
        if (cancelled) return;
        setMetadata((prev) => (prev[movieKey(r.movie_title)] ? prev : { ...prev, [movieKey(r.movie_title)]: data }));
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendations]);

  const sorted = useMemo(
    () => [...recommendations].sort((a, b) => (b.recommendation_score || 0) - (a.recommendation_score || 0)),
    [recommendations],
  );

  if (!sorted.length) {
    return (
      <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold text-ink">Recommended Movies</h2>
        <p className="mt-3 text-sm text-ink-soft">No recommendations found.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold text-ink">Recommended Movies</h2>
      <p className="mt-1 text-xs text-ink-soft">Ranked by recommendation score, based on similar theaters' performance.</p>
      <div className="mt-4 flex flex-col gap-3">
        {sorted.map((rec, index) => {
          const key = movieKey(rec.movie_title);
          const poster = metadata[key]?.poster || null;
          return (
            <div key={rec.movie_title} className="flex items-center gap-3 rounded-xl border border-line bg-cream p-3">
              <span className="w-5 shrink-0 text-center text-xs font-semibold text-ink-faint">{index + 1}</span>
              {poster ? (
                <img src={poster} alt="" className="h-20 w-14 shrink-0 rounded-md object-cover" />
              ) : (
                <div className="h-20 w-14 shrink-0 rounded-md bg-cream-soft" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{rec.movie_title}</p>
                <p className="mt-1 text-xs text-ink-soft">
                  Score {rec.recommendation_score?.toFixed ? rec.recommendation_score.toFixed(2) : rec.recommendation_score}
                  {" · "}
                  {rec.support_theater_count} similar theater{rec.support_theater_count === 1 ? "" : "s"} showed this
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Tab 2: Upload and Manage Grosses -----------------------------------------

function GrossesTab({ claims, isSuperAdmin, userEmail }: { claims: Claims; isSuperAdmin: boolean; userEmail: string }) {
  const { selected, setSelected, loadingMine, myTheaterError, loadMyTheater } = useTheaterSelection(isSuperAdmin);

  // theaterId (Firestore doc id under `theaters/`) is what the grossUploads
  // subcollection is keyed by. For a theater_user it comes straight from
  // their claims; for an admin browsing another theater we fall back to the
  // theater_key (the two are usually the same identifier in this dataset,
  // but claims.theaterId is authoritative for the signed-in user's own
  // theater).
  const theaterId = useMemo(() => {
    if (!selected) return null;
    if (!isSuperAdmin && claims.theaterId) return claims.theaterId;
    return selected.theater_key;
  }, [selected, isSuperAdmin, claims.theaterId]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,320px)_1fr]">
      <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold text-ink">Theater</h2>
        <div className="mt-4">
          <TheaterPicker
            isSuperAdmin={isSuperAdmin}
            selected={selected}
            setSelected={setSelected}
            loadingMine={loadingMine}
            myTheaterError={myTheaterError}
            loadMyTheater={loadMyTheater}
          />
        </div>
      </section>

      <div className="min-w-0 flex flex-col gap-6">
        {selected && theaterId ? (
          <>
            <UploadForm theaterKey={selected.theater_key} userEmail={userEmail} />
            <UploadsTable theaterId={theaterId} theaterKey={selected.theater_key} />
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-line bg-paper p-8 text-center text-sm text-ink-soft">
            Select a theater to manage gross uploads.
          </div>
        )}
      </div>
    </div>
  );
}

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

function UploadForm({ theaterKey, userEmail }: { theaterKey: string; userEmail: string }) {
  const [businessDate, setBusinessDate] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploadStates, setUploadStates] = useState<FileUploadState[]>([]);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFormError("");
    const picked = Array.from(event.target.files || []);
    const invalid: string[] = [];
    const valid: File[] = [];

    picked.forEach((file) => {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) {
        invalid.push(`${file.name} (not a PDF)`);
        return;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        invalid.push(`${file.name} (over 15MB)`);
        return;
      }
      valid.push(file);
    });

    if (invalid.length) {
      setFormError(`Skipped: ${invalid.join(", ")}`);
    }
    setFiles(valid);
  }

  async function handleSubmit() {
    if (!businessDate) {
      setFormError("Choose a business date.");
      return;
    }
    if (files.length === 0) {
      setFormError("Choose at least one PDF file.");
      return;
    }

    setFormError("");
    setUploading(true);
    const initialStates: FileUploadState[] = files.map((f, i) => ({
      key: `${f.name}-${i}-${f.size}`,
      name: f.name,
      status: "pending",
      progress: 0,
    }));
    setUploadStates(initialStates);

    // Independent per-file upload — one file's failure doesn't stop the rest.
    await Promise.all(
      files.map(async (file, index) => {
        const key = initialStates[index].key;
        const updateState = (patch: Partial<FileUploadState>) => {
          setUploadStates((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
        };

        try {
          updateState({ status: "uploading", progress: 0 });
          const sessionResponse: any = await reelSuccessCreateGrossUploadSession({
            theaterKey,
            businessDate,
            fileName: file.name,
            contentType: file.type || "application/pdf",
            size: file.size,
          });
          const storagePath = sessionResponse?.data?.storagePath;
          if (!storagePath) throw new Error("Upload session failed.");

          const uploadRef = storageRef(storage, storagePath);
          const task = uploadBytesResumable(uploadRef, file, {
            contentType: "application/pdf",
            customMetadata: { theaterKey, businessDate },
          });

          await new Promise<void>((resolve, reject) => {
            task.on(
              "state_changed",
              (snapshot) => {
                const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
                updateState({ progress: pct });
              },
              (error) => reject(error),
              () => resolve(),
            );
          });

          updateState({ status: "finalizing", progress: 100 });
          await reelSuccessFinalizeGrossUpload({ theaterKey, businessDate, fileName: file.name, storagePath });
          updateState({ status: "done" });
        } catch (error: any) {
          console.error(`Upload failed for ${file.name}:`, error);
          updateState({ status: "error", error: error?.message || "Upload failed." });
        }
      }),
    );

    setUploading(false);
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold text-ink">Upload Grosses</h2>
      <p className="mt-1 text-xs text-ink-soft">Uploading as {userEmail}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs font-semibold text-ink-soft" htmlFor="rs-business-date">
            Business date
          </label>
          <input
            id="rs-business-date"
            type="date"
            value={businessDate}
            onChange={(event) => setBusinessDate(event.target.value)}
            className="mt-1 w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-ink-soft" htmlFor="rs-pdf-files">
            PDF files (max 15MB each)
          </label>
          <input
            id="rs-pdf-files"
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            onChange={handleFileChange}
            className="mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none transition-colors file:mr-3 file:rounded-full file:border-0 file:bg-marquee-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-marquee focus:border-marquee"
          />
        </div>
      </div>

      {formError && <p className="mt-3 text-xs text-red-600">{formError}</p>}

      {files.length > 0 && (
        <p className="mt-2 text-xs text-ink-soft">
          {files.length} file{files.length === 1 ? "" : "s"} ready to upload.
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={uploading}
        className="mt-4 rounded-full bg-marquee px-6 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "Upload"}
      </button>

      {uploadStates.length > 0 && (
        <div className="mt-5 flex flex-col gap-2">
          {uploadStates.map((state) => (
            <div key={state.key} className="rounded-xl border border-line bg-cream p-3">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate font-medium text-ink">{state.name}</span>
                <span
                  className={`shrink-0 font-semibold ${
                    state.status === "error"
                      ? "text-red-600"
                      : state.status === "done"
                        ? "text-emerald"
                        : "text-ink-soft"
                  }`}
                >
                  {state.status === "done"
                    ? "Done"
                    : state.status === "error"
                      ? "Failed"
                      : state.status === "finalizing"
                        ? "Finalizing…"
                        : `${state.progress}%`}
                </span>
              </div>
              {state.status !== "error" && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-cream-soft">
                  <div
                    className={`h-full rounded-full ${state.status === "done" ? "bg-emerald" : "bg-marquee"}`}
                    style={{ width: `${state.status === "done" ? 100 : state.progress}%` }}
                  />
                </div>
              )}
              {state.error && <p className="mt-1.5 text-[11px] text-red-600">{state.error}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function UploadsTable({ theaterId, theaterKey }: { theaterId: string; theaterKey: string }) {
  const [rows, setRows] = useState<GrossUploadRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  useEffect(() => {
    setRows(null);
    setLoadError("");
    const uploadsRef = collection(db, "theaters", theaterId, "grossUploads");
    const uploadsQuery = fsQuery(uploadsRef, orderBy("businessDate", "desc"));
    const unsubscribe = onSnapshot(
      uploadsQuery,
      (snapshot) => {
        const next: GrossUploadRow[] = snapshot.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setRows(next);
      },
      (error) => {
        console.error("grossUploads subscription failed:", error);
        setLoadError(error?.message || "Could not load uploads.");
        setRows([]);
      },
    );
    return () => unsubscribe();
  }, [theaterId]);

  async function handleOpen(row: GrossUploadRow) {
    if (!row.storagePath) return;
    setOpeningId(row.id);
    setRowError((prev) => ({ ...prev, [row.id]: "" }));
    try {
      const url = await getDownloadURL(storageRef(storage, row.storagePath));
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error: any) {
      console.error("Could not resolve download URL:", error);
      setRowError((prev) => ({ ...prev, [row.id]: "Could not open file." }));
    } finally {
      setOpeningId(null);
    }
  }

  async function handleDelete(row: GrossUploadRow) {
    if (!window.confirm(`Delete the upload for ${row.businessDate || "this date"} (${row.fileName || "file"})? This cannot be undone.`)) {
      return;
    }
    setDeletingId(row.id);
    setRowError((prev) => ({ ...prev, [row.id]: "" }));
    try {
      await reelSuccessDeleteGrossUpload({ theaterKey, uploadId: row.id });
    } catch (error: any) {
      console.error("reelSuccessDeleteGrossUpload failed:", error);
      setRowError((prev) => ({ ...prev, [row.id]: error?.message || "Could not delete upload." }));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold text-ink">Past Uploads</h2>

      {loadError && <p className="mt-3 text-sm text-red-600">{loadError}</p>}

      {rows === null && !loadError && <p className="mt-3 text-sm text-ink-soft">Loading uploads…</p>}

      {rows && rows.length === 0 && <p className="mt-3 text-sm text-ink-soft">No uploads yet.</p>}

      {rows && rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                <th className="pb-2 pr-3">Business date</th>
                <th className="pb-2 pr-3">File</th>
                <th className="pb-2 pr-3">Uploaded</th>
                <th className="pb-2 pr-3">By</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const uploadedAt = row.uploadedAt?.toDate ? row.uploadedAt.toDate().toLocaleString() : "—";
                return (
                  <tr key={row.id} className="border-b border-line-soft align-top last:border-b-0">
                    <td className="py-2.5 pr-3 font-medium text-ink">{row.businessDate || "—"}</td>
                    <td className="py-2.5 pr-3 text-ink-soft">{row.fileName || "—"}</td>
                    <td className="py-2.5 pr-3 text-ink-soft">{uploadedAt}</td>
                    <td className="py-2.5 pr-3 text-ink-soft">{row.uploadedByEmail || "—"}</td>
                    <td className="py-2.5 pr-3 text-ink-soft">{row.status || "—"}</td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleOpen(row)}
                          disabled={!row.storagePath || openingId === row.id}
                          className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {openingId === row.id ? "Opening…" : "Open"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(row)}
                          disabled={deletingId === row.id}
                          className="rounded-full border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {deletingId === row.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                      {rowError[row.id] && <p className="mt-1 text-[11px] text-red-600">{rowError[row.id]}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
