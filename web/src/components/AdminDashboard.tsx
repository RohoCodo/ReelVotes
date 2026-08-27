import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import type { User } from "firebase/auth";
import {
  db,
  getEventVoteStats,
  setEventVoteStatus,
  saveEventAdminSettings,
  createEventShowtime,
  deleteEventShowtime,
  runEliminationRound,
  revertLatestEliminationRound,
  rebuildEventMovieVoteCounts,
  reelSuccessSetAccess,
  reelSuccessListAccess,
} from "../lib/firebase";
import { auth, googleProvider, onAuthStateChanged, signInWithPopup, signOut } from "../lib/firebase-auth";

// A placeholder eventId used only to ping an admin-gated callable on load,
// to determine whether the signed-in user has admin access. getEventVoteStats
// doesn't require the event to actually exist — it just reads (possibly empty)
// subcollections — so this is safe and doesn't depend on any real event data.
const ACCESS_CHECK_EVENT_ID = "__admin_access_check__";

type AccessState = "checking" | "granted" | "denied";
type TabId = "results" | "edit" | "showtime";
type VoteStatus = "not-started" | "live" | "ended";

interface EventSummary {
  id: string;
  screeningLabel: string;
  screeningDateTime: string;
  voteStatus: VoteStatus;
  requireEmail: boolean;
  currentEliminationRound: number;
}

interface MovieRow {
  id: string;
  title: string;
  voteCount: number;
  eliminated: boolean;
}

interface AccessGrant {
  email: string;
  enabled: boolean;
  theater_key: string | null;
  updated_by: string | null;
}

function resolveVoteStatus(raw: unknown): VoteStatus {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "live" || normalized === "ended") return normalized;
  return "not-started";
}

function getErrorCode(error: unknown): string {
  return String((error as any)?.code || "");
}

function getErrorMessage(error: unknown): string {
  const raw = String((error as any)?.message || "Something went wrong. Please try again.");
  // Firebase callable errors sometimes prefix the message oddly; keep as-is otherwise.
  return raw;
}

export default function AdminDashboard() {
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [signInError, setSignInError] = useState("");
  const [accessState, setAccessState] = useState<AccessState>("checking");
  const [accessError, setAccessError] = useState("");

  const [events, setEvents] = useState<EventSummary[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const [tab, setTab] = useState<TabId>("results");

  // --- Auth ------------------------------------------------------------
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => setAuthUser(user));
    return () => unsubscribe();
  }, []);

  async function handleSignIn() {
    setSignInError("");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Admin sign-in failed:", error);
      setSignInError(getErrorMessage(error));
    }
  }

  async function handleSignOut() {
    await signOut(auth);
    setAccessState("checking");
    setAccessError("");
  }

  // --- Admin access check: ping an admin-gated callable ------------------
  useEffect(() => {
    if (!authUser?.email) return;
    let cancelled = false;
    setAccessState("checking");
    setAccessError("");

    (async () => {
      try {
        await getEventVoteStats({ eventId: ACCESS_CHECK_EVENT_ID, adminEmail: authUser.email });
        if (!cancelled) setAccessState("granted");
      } catch (error) {
        if (cancelled) return;
        if (getErrorCode(error) === "functions/permission-denied") {
          setAccessState("denied");
        } else {
          // Any other error (network, etc.) — surface it but don't silently
          // grant access.
          setAccessState("denied");
          setAccessError(getErrorMessage(error));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authUser?.email]);

  // --- Events list (live) ------------------------------------------------
  useEffect(() => {
    if (accessState !== "granted") return;
    const eventsQuery = query(collection(db, "events"), orderBy("screeningDateTime", "desc"));
    const unsubscribe = onSnapshot(
      eventsQuery,
      (snapshot) => {
        const rows: EventSummary[] = snapshot.docs.map((eventDoc) => {
          const data = eventDoc.data() || {};
          return {
            id: eventDoc.id,
            screeningLabel: data.screeningLabel || eventDoc.id,
            screeningDateTime: data.screeningDateTime || "",
            voteStatus: resolveVoteStatus(data.voteStatus),
            requireEmail: data.requireEmail !== false,
            currentEliminationRound: Number(data.currentEliminationRound || 0),
          };
        });
        setEvents(rows);
        setSelectedEventId((current) => (current && rows.some((r) => r.id === current) ? current : rows[0]?.id || ""));
      },
      (error) => console.error("Could not load events list:", error),
    );
    return () => unsubscribe();
  }, [accessState]);

  // --- Render gates --------------------------------------------------------
  if (authUser === undefined) {
    return <StatusCard>Loading…</StatusCard>;
  }

  if (!authUser) {
    return (
      <StatusCard>
        <h2 className="font-display text-xl font-semibold text-ink">Admin sign-in</h2>
        <p className="mt-2 text-sm text-ink-soft">Sign in with your ReelVotes admin Google account to continue.</p>
        <button
          type="button"
          onClick={handleSignIn}
          className="mt-5 rounded-full bg-marquee px-6 py-3 text-sm font-semibold text-white shadow-md shadow-marquee/30 transition-transform hover:-translate-y-0.5"
        >
          Sign in with Google
        </button>
        {signInError && <p className="mt-3 text-xs text-red-600">{signInError}</p>}
      </StatusCard>
    );
  }

  if (accessState === "checking") {
    return <StatusCard>Checking admin access…</StatusCard>;
  }

  if (accessState === "denied") {
    return (
      <StatusCard>
        <h2 className="font-display text-xl font-semibold text-ink">You don't have admin access</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Signed in as {authUser.email}. This account isn't on the admin list. Ask an existing admin to grant access,
          or sign in with a different account.
        </p>
        {accessError && <p className="mt-2 text-xs text-red-600">{accessError}</p>}
        <button
          type="button"
          onClick={handleSignOut}
          className="mt-5 rounded-full border border-line px-6 py-3 text-sm font-semibold text-ink"
        >
          Sign out
        </button>
      </StatusCard>
    );
  }

  const selectedEvent = events.find((e) => e.id === selectedEventId) || null;

  return (
    <div className="mx-auto max-w-3xl">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink sm:text-3xl">Admin Dashboard</h1>
          <p className="mt-1 text-sm text-ink-soft">Signed in as {authUser.email}</p>
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="self-start rounded-full border border-line px-4 py-2 text-xs font-semibold text-ink sm:self-auto"
        >
          Sign out
        </button>
      </header>

      <div className="mt-6">
        <label className="block text-xs font-semibold uppercase tracking-wide text-ink-faint">Showtime</label>
        <select
          value={selectedEventId}
          onChange={(event) => setSelectedEventId(event.target.value)}
          className="mt-1 w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
        >
          {events.length === 0 && <option value="">No showtimes yet</option>}
          {events.map((event) => (
            <option key={event.id} value={event.id}>
              {event.screeningLabel} · {event.voteStatus}
            </option>
          ))}
        </select>
      </div>

      <nav className="mt-6 flex gap-1 rounded-xl border border-line bg-cream-soft p-1">
        {(
          [
            ["results", "Results"],
            ["edit", "Edit"],
            ["showtime", "Showtime"],
          ] as [TabId, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
              tab === id ? "bg-paper text-ink shadow-sm" : "text-ink-soft hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="mt-6 pb-16">
        {tab === "results" && (
          <ResultsTab key={selectedEventId} event={selectedEvent} adminEmail={authUser.email || ""} />
        )}
        {tab === "edit" && (
          <EditTab key={selectedEventId} event={selectedEvent} adminEmail={authUser.email || ""} />
        )}
        {tab === "showtime" && <ShowtimeTab adminEmail={authUser.email || ""} onCreated={(id) => { setSelectedEventId(id); setTab("results"); }} />}
      </div>
    </div>
  );
}

// --- Results tab -----------------------------------------------------------

function ResultsTab({ event, adminEmail }: { event: EventSummary | null; adminEmail: string }) {
  const [movies, setMovies] = useState<MovieRow[]>([]);
  const [stats, setStats] = useState<{ totalVotes: number; totalPeople: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmAction, setConfirmAction] = useState<null | "end" | "reopen" | "eliminate" | "revert">(null);

  useEffect(() => {
    if (!event) return;
    const moviesQuery = query(collection(db, "events", event.id, "movies"));
    const unsubscribe = onSnapshot(moviesQuery, (snapshot) => {
      const rows: MovieRow[] = snapshot.docs.map((movieDoc) => {
        const data = movieDoc.data() || {};
        return {
          id: movieDoc.id,
          title: data.movie_title || movieDoc.id,
          voteCount: Number(data.vote_count || 0),
          eliminated: data.eliminated === true,
        };
      });
      rows.sort((a, b) => b.voteCount - a.voteCount);
      setMovies(rows);
    });
    return () => unsubscribe();
  }, [event?.id]);

  const refreshStats = useCallback(async () => {
    if (!event) return;
    try {
      const response: any = await getEventVoteStats({ eventId: event.id, adminEmail });
      setStats({ totalVotes: response?.data?.totalVotes || 0, totalPeople: response?.data?.totalPeople || 0 });
    } catch (err) {
      console.error("Could not load vote stats:", err);
    }
  }, [event?.id, adminEmail]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  if (!event) {
    return <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">Create a showtime first.</p>;
  }

  async function runAction(action: "end" | "reopen" | "eliminate" | "revert") {
    setConfirmAction(null);
    setBusy(action);
    setNotice("");
    setError("");
    try {
      if (action === "end") {
        await setEventVoteStatus({ eventId: event!.id, adminEmail, voteStatus: "ended" });
        setNotice("Vote ended.");
      } else if (action === "reopen") {
        await setEventVoteStatus({ eventId: event!.id, adminEmail, voteStatus: "live" });
        setNotice("Vote reopened.");
      } else if (action === "eliminate") {
        const response: any = await runEliminationRound({ eventId: event!.id, adminEmail });
        const eliminated: string[] = response?.data?.eliminatedTitles || [];
        setNotice(
          eliminated.length > 0
            ? `Eliminated: ${eliminated.join(", ")}`
            : response?.data?.status
              ? `Elimination round result: ${response.data.status}`
              : "Elimination round complete.",
        );
      } else if (action === "revert") {
        const response: any = await revertLatestEliminationRound({ eventId: event!.id, adminEmail });
        setNotice(`Reverted round ${response?.data?.revertedRound}. Restored ${response?.data?.restoredMovieCount ?? 0} movie(s).`);
      }
      await refreshStats();
    } catch (err) {
      console.error(`Admin action "${action}" failed:`, err);
      if (action === "reopen" && getErrorCode(err) === "functions/permission-denied") {
        setError("Only a super-admin can reopen an ended vote.");
      } else {
        setError(getErrorMessage(err));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleRebuildVoteCounts() {
    setBusy("rebuild");
    setNotice("");
    setError("");
    try {
      const response: any = await rebuildEventMovieVoteCounts({ eventId: event!.id, adminEmail });
      setNotice(`Vote counts rebuilt from ${response?.data?.matchedVoteCount ?? "?"} matched vote(s).`);
    } catch (err) {
      console.error("Rebuild vote counts failed:", err);
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const total = movies.reduce((sum, m) => sum + m.voteCount, 0);

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-line bg-paper p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">{event.screeningLabel}</h2>
            <p className="mt-0.5 text-xs text-ink-soft">
              Status: <span className="font-semibold text-ink">{event.voteStatus}</span>
              {event.currentEliminationRound > 0 && <> · Elimination round {event.currentEliminationRound}</>}
            </p>
          </div>
          {stats && (
            <p className="text-sm text-ink-soft">
              {stats.totalVotes} vote{stats.totalVotes === 1 ? "" : "s"} · {stats.totalPeople} voter
              {stats.totalPeople === 1 ? "" : "s"}
            </p>
          )}
        </div>

        {notice && <p className="mt-3 rounded-lg bg-emerald-soft px-3 py-2 text-xs text-emerald">{notice}</p>}
        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        <div className="mt-4 flex flex-wrap gap-2">
          {event.voteStatus !== "ended" ? (
            <ActionButton busy={busy === "end"} onClick={() => setConfirmAction("end")} variant="primary">
              End Vote
            </ActionButton>
          ) : (
            <ActionButton busy={busy === "reopen"} onClick={() => setConfirmAction("reopen")} variant="primary">
              Reopen Vote
            </ActionButton>
          )}
          <ActionButton busy={busy === "eliminate"} onClick={() => setConfirmAction("eliminate")} variant="neutral">
            Run Elimination Round
          </ActionButton>
          <ActionButton
            busy={busy === "revert"}
            onClick={() => setConfirmAction("revert")}
            variant="neutral"
            disabled={event.currentEliminationRound <= 0}
          >
            Revert Last Elimination Round
          </ActionButton>
        </div>
      </section>

      <section>
        <h3 className="font-display text-base font-semibold text-ink">Live Standings</h3>
        <div className="mt-3 flex flex-col gap-2">
          {movies.length === 0 && (
            <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">No votes yet.</p>
          )}
          {movies.map((movie) => {
            const percent = total > 0 ? Math.round((movie.voteCount / total) * 100) : 0;
            return (
              <div
                key={movie.id}
                className={`rounded-xl border p-3 ${movie.eliminated ? "border-line bg-cream-soft opacity-60" : "border-line bg-paper"}`}
              >
                <div className="flex items-center justify-between gap-3 text-sm">
                  <p className="truncate font-semibold text-ink">
                    {movie.title}
                    {movie.eliminated && <span className="ml-2 text-xs font-semibold text-red-600">Eliminated</span>}
                  </p>
                  <p className="shrink-0 text-ink-soft">
                    {movie.voteCount} · {percent}%
                  </p>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-cream-soft">
                  <div className="h-full rounded-full bg-marquee" style={{ width: `${Math.min(percent, 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-line/60 bg-cream-soft/50 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Repair utility</p>
        <p className="mt-1 text-xs text-ink-soft">
          Recomputes vote counts on every movie from raw vote records. Use after suspected data drift.
        </p>
        <button
          type="button"
          onClick={handleRebuildVoteCounts}
          disabled={busy === "rebuild"}
          className="mt-3 rounded-full border border-line px-4 py-2 text-xs font-semibold text-ink-soft transition-colors hover:text-ink disabled:opacity-50"
        >
          {busy === "rebuild" ? "Rebuilding…" : "Rebuild Vote Counts"}
        </button>
      </section>

      {confirmAction && (
        <ConfirmModal
          title={
            confirmAction === "end"
              ? "End vote?"
              : confirmAction === "reopen"
                ? "Reopen ended vote?"
                : confirmAction === "eliminate"
                  ? "Run elimination round?"
                  : "Revert last elimination round?"
          }
          message={
            confirmAction === "end"
              ? "Voters will no longer be able to submit ballots for this showtime."
              : confirmAction === "reopen"
                ? "This reopens a vote that was already ended. Only a super-admin can do this."
                : confirmAction === "eliminate"
                  ? "This eliminates the 3 lowest-vote-count active movies and emails affected voters a re-vote link. This cannot be undone from here except via Revert."
                  : "This restores the movies eliminated in the most recent round and reactivates their votes."
          }
          confirmLabel="Confirm"
          danger={confirmAction === "eliminate"}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => runAction(confirmAction)}
        />
      )}
    </div>
  );
}

// --- Edit tab ----------------------------------------------------------

function EditTab({ event, adminEmail }: { event: EventSummary | null; adminEmail: string }) {
  const [requireEmail, setRequireEmail] = useState(true);
  const [ballotText, setBallotText] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const [grants, setGrants] = useState<AccessGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantEmail, setGrantEmail] = useState("");
  const [grantRole, setGrantRole] = useState<"theater_user" | "super_admin">("theater_user");
  const [grantTheaterKey, setGrantTheaterKey] = useState("");
  const [grantEnabled, setGrantEnabled] = useState(true);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantNotice, setGrantNotice] = useState("");
  const [grantError, setGrantError] = useState("");

  useEffect(() => {
    if (!event) return;
    setRequireEmail(event.requireEmail);
    setNotice("");
    setError("");
    const moviesQuery = query(collection(db, "events", event.id, "movies"));
    const unsubscribe = onSnapshot(moviesQuery, (snapshot) => {
      const titles = snapshot.docs
        .map((movieDoc) => (movieDoc.data() || {}).movie_title || movieDoc.id)
        .sort((a, b) => String(a).localeCompare(String(b)));
      setBallotText(titles.join("\n"));
    });
    return () => unsubscribe();
  }, [event?.id]);

  const loadGrants = useCallback(async () => {
    setGrantsLoading(true);
    setGrantError("");
    try {
      const response: any = await reelSuccessListAccess({ adminEmail });
      setGrants(response?.data?.users || []);
    } catch (err) {
      console.error("Could not load ReelSuccess access list:", err);
      setGrantError(getErrorMessage(err));
    } finally {
      setGrantsLoading(false);
    }
  }, [adminEmail]);

  useEffect(() => {
    void loadGrants();
  }, [loadGrants]);

  if (!event) {
    return <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">Create a showtime first.</p>;
  }

  async function handleSave(formEvent: FormEvent) {
    formEvent.preventDefault();
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const movieTitles = ballotText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const response: any = await saveEventAdminSettings({
        eventId: event!.id,
        adminEmail,
        requireEmail,
        movieTitles,
      });
      setNotice(
        `Saved. ${response?.data?.movieCount ?? movieTitles.length} title(s) on the ballot` +
          (response?.data?.deletedMovieCount ? `, ${response.data.deletedMovieCount} removed.` : "."),
      );
    } catch (err) {
      console.error("Save event settings failed:", err);
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      await deleteEventShowtime({ eventId: event!.id, adminEmail });
      setConfirmDelete(false);
      // Selection will move on automatically once the events onSnapshot
      // listener in the parent picks up the deletion.
    } catch (err) {
      console.error("Delete showtime failed:", err);
      setError(getErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  async function handleGrant(formEvent: FormEvent) {
    formEvent.preventDefault();
    setGrantBusy(true);
    setGrantNotice("");
    setGrantError("");
    try {
      await reelSuccessSetAccess({
        adminEmail,
        targetEmail: grantEmail.trim(),
        role: grantRole,
        theaterKey: grantRole === "theater_user" ? grantTheaterKey.trim() : undefined,
        enabled: grantEnabled,
      });
      setGrantNotice(`Access ${grantEnabled ? "granted" : "revoked"} for ${grantEmail.trim()}.`);
      setGrantEmail("");
      setGrantTheaterKey("");
      await loadGrants();
    } catch (err) {
      console.error("Grant ReelSuccess access failed:", err);
      setGrantError(getErrorMessage(err));
    } finally {
      setGrantBusy(false);
    }
  }

  const deleteConfirmTarget = event.screeningLabel || event.id;

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={handleSave} className="rounded-2xl border border-line bg-paper p-5">
        <h2 className="font-display text-lg font-semibold text-ink">{event.screeningLabel}</h2>

        <label className="mt-4 flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={requireEmail}
            onChange={(e) => setRequireEmail(e.target.checked)}
            className="h-4 w-4 rounded border-line accent-[var(--color-marquee)]"
          />
          Require email to vote
        </label>

        <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Ballot (one title per line)
        </label>
        <textarea
          value={ballotText}
          onChange={(e) => setBallotText(e.target.value)}
          rows={10}
          className="mt-1 w-full rounded-xl border border-line bg-paper px-4 py-3 font-mono text-sm text-ink outline-none transition-colors focus:border-marquee"
          placeholder={"Back to the Future\nJurassic Park\nBlade Runner"}
        />

        {notice && <p className="mt-3 rounded-lg bg-emerald-soft px-3 py-2 text-xs text-emerald">{notice}</p>}
        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-full bg-marquee px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-marquee/30 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmDelete(true);
              setDeleteConfirmText("");
            }}
            className="rounded-full border border-red-300 px-6 py-2.5 text-sm font-semibold text-red-600"
          >
            Delete Showtime
          </button>
        </div>
      </form>

      <section className="rounded-2xl border border-line bg-paper p-5">
        <h3 className="font-display text-base font-semibold text-ink">Grant ReelSuccess Access</h3>
        <p className="mt-1 text-xs text-ink-soft">
          Grants another user access to the ReelSuccess analytics tool. This dashboard only manages who can get in.
        </p>

        <form onSubmit={handleGrant} className="mt-4 flex flex-col gap-3">
          <input
            type="email"
            required
            value={grantEmail}
            onChange={(e) => setGrantEmail(e.target.value)}
            placeholder="user@example.com"
            className="w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-sm text-ink outline-none transition-colors focus:border-marquee"
          />
          <div className="flex flex-wrap gap-3">
            <select
              value={grantRole}
              onChange={(e) => setGrantRole(e.target.value as "theater_user" | "super_admin")}
              className="rounded-xl border border-line bg-paper px-4 py-2.5 text-sm text-ink outline-none focus:border-marquee"
            >
              <option value="theater_user">theater_user</option>
              <option value="super_admin">super_admin</option>
            </select>
            {grantRole === "theater_user" && (
              <input
                type="text"
                required
                value={grantTheaterKey}
                onChange={(e) => setGrantTheaterKey(e.target.value)}
                placeholder="theaterKey"
                className="min-w-0 flex-1 rounded-xl border border-line bg-paper px-4 py-2.5 text-sm text-ink outline-none focus:border-marquee"
              />
            )}
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={grantEnabled}
                onChange={(e) => setGrantEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-line accent-[var(--color-marquee)]"
              />
              Enabled
            </label>
          </div>
          {grantNotice && <p className="rounded-lg bg-emerald-soft px-3 py-2 text-xs text-emerald">{grantNotice}</p>}
          {grantError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{grantError}</p>}
          <button
            type="submit"
            disabled={grantBusy}
            className="self-start rounded-full bg-marquee px-6 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {grantBusy ? "Saving…" : "Grant Access"}
          </button>
        </form>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-xs">
            <thead>
              <tr className="border-b border-line text-ink-faint">
                <th className="py-2 pr-3 font-semibold">Email</th>
                <th className="py-2 pr-3 font-semibold">Enabled</th>
                <th className="py-2 pr-3 font-semibold">Theater</th>
                <th className="py-2 font-semibold">Updated by</th>
              </tr>
            </thead>
            <tbody>
              {grantsLoading && (
                <tr>
                  <td colSpan={4} className="py-3 text-ink-soft">
                    Loading…
                  </td>
                </tr>
              )}
              {!grantsLoading && grants.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-ink-soft">
                    No grants yet.
                  </td>
                </tr>
              )}
              {grants.map((grant) => (
                <tr key={grant.email} className="border-b border-line/60 text-ink">
                  <td className="py-2 pr-3">{grant.email}</td>
                  <td className="py-2 pr-3">{grant.enabled ? "Yes" : "No"}</td>
                  <td className="py-2 pr-3">{grant.theater_key || "—"}</td>
                  <td className="py-2 text-ink-soft">{grant.updated_by || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {confirmDelete && (
        <ConfirmModal
          title="Delete this showtime?"
          message={
            <>
              This permanently deletes <strong>{deleteConfirmTarget}</strong> and all votes, movies, and elimination
              records under it. This cannot be undone. Type the showtime name below to confirm.
            </>
          }
          confirmLabel={deleting ? "Deleting…" : "Delete permanently"}
          danger
          disableConfirm={deleteConfirmText.trim() !== deleteConfirmTarget || deleting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={handleDelete}
        >
          <input
            type="text"
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder={deleteConfirmTarget}
            className="mt-3 w-full rounded-xl border border-line bg-paper px-4 py-2.5 text-sm text-ink outline-none focus:border-red-400"
          />
        </ConfirmModal>
      )}
    </div>
  );
}

// --- Showtime (create) tab -----------------------------------------------

function ShowtimeTab({ adminEmail, onCreated }: { adminEmail: string; onCreated: (eventId: string) => void }) {
  const [screeningDateTime, setScreeningDateTime] = useState("");
  const [voteStatus, setVoteStatus] = useState<VoteStatus>("not-started");
  const [requireEmail, setRequireEmail] = useState(true);
  const [ballotText, setBallotText] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function handleCreate(formEvent: FormEvent) {
    formEvent.preventDefault();
    setCreating(true);
    setNotice("");
    setError("");
    try {
      const movieTitles = ballotText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const response: any = await createEventShowtime({
        adminEmail,
        screeningDateTime,
        voteStatus,
        requireEmail,
        movieTitles,
      });
      const eventId = response?.data?.eventId;
      setNotice(`Created "${response?.data?.event?.screeningLabel || eventId}".`);
      setScreeningDateTime("");
      setBallotText("");
      setVoteStatus("not-started");
      if (eventId) onCreated(eventId);
    } catch (err) {
      console.error("Create showtime failed:", err);
      setError(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <form onSubmit={handleCreate} className="rounded-2xl border border-line bg-paper p-5">
      <h2 className="font-display text-lg font-semibold text-ink">Create a new showtime</h2>

      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Screening date &amp; time
      </label>
      <input
        type="datetime-local"
        required
        value={screeningDateTime}
        onChange={(e) => setScreeningDateTime(e.target.value)}
        className="mt-1 w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
      />

      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Initial vote status
      </label>
      <select
        value={voteStatus}
        onChange={(e) => setVoteStatus(e.target.value as VoteStatus)}
        className="mt-1 w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none focus:border-marquee"
      >
        <option value="not-started">not-started</option>
        <option value="live">live</option>
      </select>

      <label className="mt-4 flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={requireEmail}
          onChange={(e) => setRequireEmail(e.target.checked)}
          className="h-4 w-4 rounded border-line accent-[var(--color-marquee)]"
        />
        Require email to vote
      </label>

      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Initial ballot (optional, one title per line — can be filled in later via Edit)
      </label>
      <textarea
        value={ballotText}
        onChange={(e) => setBallotText(e.target.value)}
        rows={8}
        className="mt-1 w-full rounded-xl border border-line bg-paper px-4 py-3 font-mono text-sm text-ink outline-none transition-colors focus:border-marquee"
        placeholder={"Back to the Future\nJurassic Park\nBlade Runner"}
      />

      {notice && <p className="mt-3 rounded-lg bg-emerald-soft px-3 py-2 text-xs text-emerald">{notice}</p>}
      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={creating}
        className="mt-4 rounded-full bg-marquee px-6 py-2.5 text-sm font-semibold text-white shadow-md shadow-marquee/30 disabled:opacity-50"
      >
        {creating ? "Creating…" : "Create Showtime"}
      </button>
    </form>
  );
}

// --- Shared UI bits ---------------------------------------------------

function StatusCard({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-line bg-paper p-8 text-center">
      {typeof children === "string" ? <p className="text-sm text-ink-soft">{children}</p> : children}
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  busy,
  variant,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
  variant: "primary" | "neutral";
  disabled?: boolean;
}) {
  const base = "rounded-full px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-marquee text-white shadow-md shadow-marquee/30"
      : "border border-line text-ink hover:border-marquee/40";
  return (
    <button type="button" onClick={onClick} disabled={busy || disabled} className={`${base} ${styles}`}>
      {busy ? "Working…" : children}
    </button>
  );
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  disableConfirm,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  disableConfirm?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-5"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-line bg-paper p-6 shadow-xl">
        <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
        <p className="mt-2 text-sm text-ink-soft">{message}</p>
        {children}
        <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            onClick={onConfirm}
            disabled={disableConfirm}
            className={`rounded-full px-5 py-2.5 text-sm font-semibold text-white sm:flex-1 disabled:cursor-not-allowed disabled:opacity-50 ${
              danger ? "bg-red-600" : "bg-marquee"
            }`}
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink sm:flex-1"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
