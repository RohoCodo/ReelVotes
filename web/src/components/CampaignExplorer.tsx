import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "firebase/auth";
import { getCampaignSummaries, rankCampaignChoices, type CampaignSummary } from "../lib/campaigns";
import { adminSetCampaignStatus, upsertCampaignMovieVote, upsertCampaignSupport } from "../lib/firebase";
import { auth, isPopupSignInCancellation, onAuthStateChanged, signInWithGoogle } from "../lib/firebase-auth";
import CampaignDiscussionInline from "./CampaignDiscussionInline";

const ADMIN_EMAILS = new Set([
  "rt332@cornell.edu",
  "moses@thenewparkway.com",
  "programming@thenewparkway.com",
  "nikki@thenewparkwaytheater.com",
]);

const adminStatusOptions = [
  "active",
  "theater-check",
  "movie-available",
  "scheduled",
  "confirmed",
  "suspended",
  "expired",
  "cancelled",
] as const;

const statusLabel: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  "licensing-pending": "Licensing not confirmed",
  "theater-check": "Theater checking availability",
  "movie-available": "Movie availability confirmed",
  tipped: "Tipped",
  scheduled: "Scheduled",
  confirmed: "Screening confirmed",
  screening: "Screening in progress",
  completed: "Completed",
  suspended: "Suspended",
  expired: "Expired",
  cancelled: "Cancelled",
};

const statusTone: Record<string, string> = {
  draft: "border-line text-ink-faint",
  active: "border-marquee/30 text-marquee",
  "licensing-pending": "border-line text-ink-faint",
  "theater-check": "border-gold/35 text-rose",
  "movie-available": "border-emerald/40 text-emerald",
  tipped: "border-gold/40 text-rose",
  scheduled: "border-emerald/40 text-emerald",
  confirmed: "border-emerald/40 text-emerald",
  screening: "border-emerald/40 text-emerald",
  completed: "border-emerald/40 text-emerald",
  suspended: "border-red-300/40 text-red-300",
  expired: "border-line text-ink-faint",
  cancelled: "border-line text-ink-faint",
};

function meter(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function campaignHandle(slug: string): string {
  return String(slug || "campaign")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "campaign";
}

function rankBadgeClass(rank: number): string {
  if (rank === 1) return "bg-marquee/90 text-white";
  if (rank === 2) return "bg-gold/80 text-ink";
  return "bg-ink/75 text-cream";
}

function availabilityLabel(status: CampaignSummary["choices"][number]["availabilityStatus"]): string {
  if (status === "available") return "Available";
  if (status === "unavailable") return "Unavailable";
  if (status === "awaiting-theater-check") return "Awaiting theater check";
  return "Not checked";
}

function availabilityClass(status: CampaignSummary["choices"][number]["availabilityStatus"]): string {
  if (status === "available") return "bg-emerald-soft/60 text-emerald";
  if (status === "unavailable") return "bg-red-100 text-red-500";
  if (status === "awaiting-theater-check") return "bg-gold/25 text-rose";
  return "bg-paper text-ink-faint";
}

function availabilityTagText(status: CampaignSummary["choices"][number]["availabilityStatus"]): string {
  if (status === "available") return "Checked • Available";
  if (status === "unavailable") return "Checked • Unavailable";
  if (status === "awaiting-theater-check") return "Checking";
  return "Not checked";
}

function comparableTitle(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTheaterNameForDisplay(name: string): string {
  const cleaned = String(name || "").trim();
  if (cleaned.toLowerCase().includes("new parkway")) {
    return "The New Parkway Theater";
  }
  return cleaned;
}

function getDisplayTheaterName(campaign: CampaignSummary): string {
  const theater =
    String(campaign.deadTimeSlot?.theaterName || "").trim() ||
    String(campaign.preferredTheaters?.[0] || "").trim();
  return normalizeTheaterNameForDisplay(theater);
}

function campaignTitleWithTheater(campaign: CampaignSummary): string {
  const title = String(campaign.title || "").trim();
  const theater = getDisplayTheaterName(campaign);
  if (!theater) return title;
  const existingMarker = `@ ${theater}`.toLowerCase();
  if (title.toLowerCase().includes(existingMarker)) return title;
  return `${title} @ ${theater}`;
}

function campaignDateKey(campaign: CampaignSummary): string {
  const direct = String(campaign.deadTimeSlot?.screeningDateTime || campaign.screeningDateTime || "").trim();
  if (direct) {
    const match = direct.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    const parsed = new Date(direct);
    if (!Number.isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  return "";
}

export default function CampaignExplorer({
  compact = false,
  layout = "grid",
  mode = "all",
  showCreateButton = true,
  showSearch = true,
  statusFilter,
  readOnly = false,
}: {
  compact?: boolean;
  layout?: "grid" | "feed";
  mode?: "all" | "historical-votes";
  showCreateButton?: boolean;
  showSearch?: boolean;
  statusFilter?: CampaignSummary["status"][];
  readOnly?: boolean;
}) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [pendingById, setPendingById] = useState<Record<string, boolean>>({});
  const [pendingVoteById, setPendingVoteById] = useState<Record<string, boolean>>({});
  const [adminPendingById, setAdminPendingById] = useState<Record<string, boolean>>({});
  const [adminStatusById, setAdminStatusById] = useState<Record<string, string>>({});
  const [adminMovieById, setAdminMovieById] = useState<Record<string, string>>({});
  const [adminAvailabilityByCampaignId, setAdminAvailabilityByCampaignId] = useState<Record<string, Record<string, string>>>({});
  const [adminNoteById, setAdminNoteById] = useState<Record<string, string>>({});
  const [bookmarkedById, setBookmarkedById] = useState<Record<string, boolean>>({});
  const [discussionOpenById, setDiscussionOpenById] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState("");
  const [canRenderFloatingCreate, setCanRenderFloatingCreate] = useState(false);
  const [floatingCreateRight, setFloatingCreateRight] = useState(16);
  const [showFloatingCreate, setShowFloatingCreate] = useState(false);
  const feedContainerRef = useRef<HTMLDivElement | null>(null);
  const floatingCreateTriggerRef = useRef<HTMLDivElement | null>(null);
  const isFeedLayout = layout === "feed" && !compact;

  function formatCount(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
    return String(Math.round(value));
  }

  async function handleShare(campaign: CampaignSummary) {
    try {
      const shareUrl = `${window.location.origin}/campaigns#${campaign.id}`;
      const shareText = `${campaign.title} • ${campaign.market}`;
      if (navigator.share) {
        await navigator.share({ title: campaign.title, text: shareText, url: shareUrl });
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
      }
    } catch {
      // no-op: silently ignore cancelled shares/copy failures
    }
  }

  useEffect(() => {
    let cancelled = false;
    getCampaignSummaries({
      includeHistoricalVotes: mode === "historical-votes",
      historicalVotesOnly: mode === "historical-votes",
    }).then((rows) => {
      if (!cancelled) setCampaigns(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => setAuthUser(user));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    setCanRenderFloatingCreate(true);

    const updateFloatingCta = () => {
      const viewportWidth = window.innerWidth || 0;
      const viewportHeight = window.innerHeight || 0;
      const feedMaxWidth = 672;
      const nextRight = Math.max(16, ((viewportWidth - feedMaxWidth) / 2) + 16);
      setFloatingCreateRight(Math.round(nextRight));

      const feedRect = feedContainerRef.current?.getBoundingClientRect();
      if (!feedRect || !isFeedLayout || !showCreateButton) {
        setShowFloatingCreate(false);
        return;
      }

      const topCreateButton = document.querySelector('[data-create-campaign-top="true"]') as HTMLElement | null;
      const externalTriggerPassed = topCreateButton ? topCreateButton.getBoundingClientRect().bottom <= 0 : false;
      const internalTriggerPassed = floatingCreateTriggerRef.current
        ? floatingCreateTriggerRef.current.getBoundingClientRect().top <= 0
        : false;
      const hasPassedTopTrigger = externalTriggerPassed || (!topCreateButton && internalTriggerPassed);

      // Keep button visible only while feed still has room behind the fixed CTA.
      const floatingButtonHeight = 56;
      const floatingBottomOffset = 24;
      const floatingButtonTop = viewportHeight - (floatingBottomOffset + floatingButtonHeight);
      const aboveFeedTop = feedRect.top < (viewportHeight - 48);
      const aboveFeedBottom = feedRect.bottom > (floatingButtonTop + 8);
      const withinFeedBounds = aboveFeedTop && aboveFeedBottom;
      setShowFloatingCreate(hasPassedTopTrigger && withinFeedBounds);
    };

    updateFloatingCta();
    window.addEventListener("resize", updateFloatingCta);
    window.addEventListener("scroll", updateFloatingCta, { passive: true });
    window.visualViewport?.addEventListener("resize", updateFloatingCta);
    window.visualViewport?.addEventListener("scroll", updateFloatingCta);

    return () => {
      window.removeEventListener("resize", updateFloatingCta);
      window.removeEventListener("scroll", updateFloatingCta);
      window.visualViewport?.removeEventListener("resize", updateFloatingCta);
      window.visualViewport?.removeEventListener("scroll", updateFloatingCta);
    };
  }, [isFeedLayout, showCreateButton]);

  async function handleSupport(campaign: CampaignSummary, level: "interested" | "backing" | "none") {
    setActionError("");

    if (!authUser) {
      try {
        await signInWithGoogle();
      } catch (error) {
        if (isPopupSignInCancellation(error)) {
          return;
        }
        setActionError(String((error as any)?.message || "Sign-in required to support campaigns."));
        return;
      }
    }

    setPendingById((prev) => ({ ...prev, [campaign.id]: true }));
    try {
      const response: any = await upsertCampaignSupport({ campaignId: campaign.id, level });
      const nextCounts = response?.data?.counts || {};
      const nextStatus = String(response?.data?.status || campaign.status);
      const viewerSupport =
        response?.data?.viewerSupport === "backing" || response?.data?.viewerSupport === "interested"
          ? response.data.viewerSupport
          : null;

      setCampaigns((prev) => {
        if (!prev) return prev;
        return prev.map((row) =>
          row.id === campaign.id
            ? {
                ...row,
                status: nextStatus as CampaignSummary["status"],
                counts: {
                  interested: Math.max(0, Number(nextCounts.interested || 0)),
                  backing: Math.max(0, Number(nextCounts.backing || 0)),
                },
                viewerSupport,
              }
            : row,
        );
      });
    } catch (error) {
      setActionError(String((error as any)?.message || "Could not update support right now."));
    } finally {
      setPendingById((prev) => ({ ...prev, [campaign.id]: false }));
    }
  }

  async function handleAdminUpdate(campaign: CampaignSummary) {
    setActionError("");
    const status = (adminStatusById[campaign.id] || campaign.status) as CampaignSummary["status"];
    const selectedMovieTitle = (adminMovieById[campaign.id] || campaign.selectedMovieTitle || "").trim();
    const movieAvailabilityByCampaignMovieId = adminAvailabilityByCampaignId[campaign.id] || {};
    const note = (adminNoteById[campaign.id] || "").trim();

    setAdminPendingById((prev) => ({ ...prev, [campaign.id]: true }));
    try {
      const response: any = await adminSetCampaignStatus({
        campaignId: campaign.id,
        status,
        selectedMovieTitle,
        movieAvailabilityByCampaignMovieId,
        note,
      });

      const nextStatus = String(response?.data?.status || status) as CampaignSummary["status"];
      const nextSelectedMovieTitle = response?.data?.selectedMovieTitle
        ? String(response.data.selectedMovieTitle)
        : null;

      setCampaigns((prev) => {
        if (!prev) return prev;
        return prev.map((row) =>
          row.id === campaign.id
            ? {
                ...row,
                status: nextStatus,
                selectedMovieTitle: nextSelectedMovieTitle,
              }
            : row,
        );
      });

      setAdminNoteById((prev) => ({ ...prev, [campaign.id]: "" }));
    } catch (error) {
      setActionError(String((error as any)?.message || "Could not update campaign status."));
    } finally {
      setAdminPendingById((prev) => ({ ...prev, [campaign.id]: false }));
    }
  }

  async function handleVote(campaign: CampaignSummary, campaignMovieId: string) {
    setActionError("");

    if (!authUser) {
      try {
        await signInWithGoogle();
      } catch (error) {
        if (isPopupSignInCancellation(error)) {
          return;
        }
        setActionError(String((error as any)?.message || "Sign-in required to vote."));
        return;
      }
    }

    setPendingVoteById((prev) => ({ ...prev, [campaign.id]: true }));
    try {
      const response: any = await upsertCampaignMovieVote({ campaignId: campaign.id, campaignMovieId });
      const returnedMovies = Array.isArray(response?.data?.campaignMovies) ? response.data.campaignMovies : null;
      const selectedMovieTitle = response?.data?.selectedMovieTitle ? String(response.data.selectedMovieTitle) : null;
      const chosenChoice = campaign.choices.find((choice) => choice.campaignMovieId === campaignMovieId);
      const reserveTitle = selectedMovieTitle || chosenChoice?.title || "this movie";

      setCampaigns((prev) => {
        if (!prev) return prev;
        return prev.map((row) =>
          row.id === campaign.id
            ? {
                ...row,
                choices: returnedMovies || row.choices,
                selectedMovieTitle,
                viewerMovieVoteCampaignMovieId: campaignMovieId,
              }
            : row,
        );
      });

      // A movie vote implies "I'd watch this" interest.
      await handleSupport(campaign, "interested");

      const wantsReservation = window.confirm(
        `Reserve a ticket in advance for the current winning movie (${reserveTitle})?`,
      );
      if (wantsReservation) {
        await handleSupport(campaign, "backing");
      }
    } catch (error) {
      setActionError(String((error as any)?.message || "Could not submit vote right now."));
    } finally {
      setPendingVoteById((prev) => ({ ...prev, [campaign.id]: false }));
    }
  }

  const isAdminUser = Boolean(authUser?.email && ADMIN_EMAILS.has(String(authUser.email).toLowerCase()));

  const visible = useMemo(() => {
    if (!campaigns) return null;
    const q = search.trim().toLowerCase();
    const dateFilter = String(selectedDate || "").trim();
    const allowedStatuses = statusFilter ? new Set(statusFilter) : null;
    const rows = campaigns.filter((campaign) => {
      if (allowedStatuses && !allowedStatuses.has(campaign.status)) return false;
      if (dateFilter) {
        const candidateDate = campaignDateKey(campaign);
        if (!candidateDate || candidateDate !== dateFilter) return false;
      }
      if (!q) return true;
      return (
        campaign.title.toLowerCase().includes(q) ||
        campaign.market.toLowerCase().includes(q) ||
        campaign.choices.some((choice) => choice.title.toLowerCase().includes(q))
      );
    });
    return compact ? rows.slice(0, 3) : rows;
  }, [campaigns, compact, search, selectedDate, statusFilter]);

  if (visible === null) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {Array.from({ length: compact ? 3 : 6 }).map((_, index) => (
          <div key={index} className="rounded-2xl border border-line bg-paper p-5">
            <div className="skeleton h-5 w-2/3 rounded" />
            <div className="skeleton mt-3 h-3.5 w-1/2 rounded" />
            <div className="skeleton mt-5 h-20 w-full rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div ref={floatingCreateTriggerRef} className="h-px" aria-hidden="true" />

      {!compact && showSearch && (
        <div className={isFeedLayout ? "mx-auto mb-5 w-full max-w-2xl" : "mb-5"}>
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search campaigns, movies, or markets"
              className="w-full min-w-0 flex-1 rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
            />
            <div className="relative w-full sm:w-auto">
              <button
                type="button"
                onClick={() => setShowDateFilter((prev) => !prev)}
                className={`inline-flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition-colors sm:w-auto ${selectedDate ? "border-marquee text-marquee" : "border-line text-ink-soft hover:border-marquee hover:text-marquee"}`}
                aria-label="Filter campaigns by date"
              >
                <span aria-hidden="true">📅</span>
                <span>{selectedDate ? selectedDate : "Date"}</span>
              </button>
              {showDateFilter && (
                <div className="absolute inset-x-0 z-20 mt-2 w-full rounded-xl border border-line bg-paper p-3 shadow-[0_12px_28px_-12px_rgba(48,59,107,0.25)] sm:inset-x-auto sm:right-0 sm:w-72">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-ink-faint" htmlFor="campaignDateFilter">
                    Specific date
                  </label>
                  <input
                    id="campaignDateFilter"
                    type="date"
                    value={selectedDate}
                    onChange={(event) => setSelectedDate(event.target.value)}
                    className="mt-2 w-full rounded-lg border border-line bg-cream px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-marquee"
                  />
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedDate("")}
                      className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-soft transition-colors hover:border-marquee hover:text-marquee"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowDateFilter(false)}
                      className="rounded-lg bg-marquee px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Done
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div ref={feedContainerRef} className={isFeedLayout ? "mx-auto w-full max-w-2xl" : "grid grid-cols-1 gap-4 lg:grid-cols-2"}>
        {isFeedLayout ? (
          visible.length === 0 ? (
            <div className="rounded-2xl border border-line bg-paper p-6 text-sm text-ink-soft">
              {mode === "historical-votes"
                ? "No previous vote campaigns are available yet for this theater."
                : "No campaigns match your filters right now."}
            </div>
          ) : (
          <div className="snap-y snap-mandatory space-y-4">
            {visible.map((campaign) => {
              const rankedChoices = rankCampaignChoices(campaign.choices);
              const displayTitle = campaignTitleWithTheater(campaign);
              const chosenMovie = rankedChoices[0]?.title || campaign.selectedMovieTitle || "Movie TBD";
              const supportPending = Boolean(pendingById[campaign.id]);
              const votePending = Boolean(pendingVoteById[campaign.id]);
              const reservationCount = Math.max(0, Number(campaign.counts.backing || 0));
              const reservationThreshold = Math.max(1, Number(campaign.thresholds.backing || 1));
              const votingCount = Math.max(0, Number(campaign.counts.interested || 0));
              const votingThreshold = Math.max(reservationThreshold, Number(campaign.thresholds.interested || reservationThreshold * 2));
              const handle = campaignHandle(campaign.slug);
              const votedCampaignMovieId = campaign.viewerMovieVoteCampaignMovieId;
              const isHistoricalVoteCampaign = campaign.origin === "historical-vote";
              const canVoteAtAll = !isHistoricalVoteCampaign && !readOnly;
              const canVote = canVoteAtAll;
              const totalVotes = rankedChoices.reduce((sum, choice) => sum + Math.max(0, Number(choice.voteCount || 0)), 0);
              const username = campaign.createdByEmail
                ? String(campaign.createdByEmail).split("@")[0]
                : handle;
              const prefersSelectedMovie =
                isHistoricalVoteCampaign || ["completed", "confirmed", "screening"].includes(String(campaign.status || ""));
              const highlightedComparable = comparableTitle(
                prefersSelectedMovie && campaign.selectedMovieTitle
                  ? campaign.selectedMovieTitle
                  : (rankedChoices[0]?.title || campaign.selectedMovieTitle || ""),
              );
              const commentsAnchorId = `campaign-comments-${campaign.id}`;
              const isDiscussionOpen = Boolean(discussionOpenById[campaign.id]);

              return (
                <article key={campaign.id} className="snap-start snap-always flex scroll-mt-24 flex-col rounded-2xl border border-line bg-paper p-3 sm:p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-marquee/15 text-xs font-semibold text-marquee">
                        {String(username || "rv").slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <p className="line-clamp-1 text-sm font-semibold text-ink">{displayTitle}</p>
                        <p className="truncate text-[11px] text-ink-faint">Date: {campaign.dateWindowLabel}</p>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${statusTone[campaign.status] || statusTone.active}`}>
                      {statusLabel[campaign.status] || campaign.status}
                    </span>
                  </div>

                  <div className="mt-3 overflow-hidden rounded-2xl border border-line bg-cream p-2">
                    <div className="mb-2 flex items-center justify-between gap-2 px-1">
                      <p className="line-clamp-1 text-xs font-semibold text-ink">{displayTitle}</p>
                      <p className="text-[11px] text-ink-soft">Leading: <span className="font-semibold text-ink">{chosenMovie}</span></p>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {rankedChoices.map((choice, idx) => {
                        const currentRank = idx + 1;
                        const statusText = availabilityTagText(choice.availabilityStatus);
                        const statusClass = availabilityClass(choice.availabilityStatus);
                        const isVoted = votedCampaignMovieId === choice.campaignMovieId;
                        const isHighlighted = comparableTitle(choice.title) === highlightedComparable;

                        return (
                          <div
                            key={`${campaign.id}-feed-${choice.campaignMovieId}`}
                            className={`group relative min-h-0 overflow-hidden rounded-xl border text-left ${
                              isHighlighted ? "border-emerald/60 ring-2 ring-emerald/30" : "border-line"
                            }`}
                          >
                            <div className="relative h-full w-full bg-gradient-to-br from-cream to-cream-soft">
                              {choice.posterUrl ? (
                                <img src={choice.posterUrl} alt={`${choice.title} poster`} className="h-full w-full object-cover" loading="lazy" />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center px-2 text-center text-[11px] font-semibold leading-snug text-ink-soft">
                                  {choice.title}
                                </div>
                              )}
                              <span className={`absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${rankBadgeClass(currentRank)}`}>
                                #{currentRank}
                              </span>
                              <span className={`absolute right-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusClass}`}>
                                {statusText}
                              </span>
                              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent px-1.5 pb-1.5 pt-6 text-[10px] font-medium text-white/95">
                                {choice.voteCount} votes
                              </span>
                              {canVote && (
                                <button
                                  type="button"
                                  disabled={votePending || isVoted || !canVote}
                                  onClick={() => handleVote(campaign, choice.campaignMovieId)}
                                  className={`absolute right-1.5 bottom-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold transition-colors ${
                                    isVoted
                                      ? "border-emerald/60 bg-emerald/90 text-white"
                                      : "border-white/70 bg-black/55 text-white hover:border-marquee hover:text-marquee"
                                  }`}
                                >
                                  {isVoted ? "Voted ✓" : votePending ? "Saving…" : "Vote"}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <button
                          type="button"
                          disabled={supportPending || isHistoricalVoteCampaign || readOnly}
                          onClick={() => handleSupport(campaign, "backing")}
                          className={`rounded-full border px-2.5 py-1.5 text-[10px] font-semibold whitespace-nowrap transition-colors ${campaign.viewerSupport === "backing" ? "border-rose bg-rose/10 text-rose" : "border-line text-ink-soft hover:border-rose hover:text-rose"}`}
                        >
                          {supportPending && campaign.viewerSupport !== "backing" ? "Saving…" : `🎟️ Reserve ${reservationCount}/${reservationThreshold}`}
                        </button>
                        <span className="inline-flex items-center gap-1 rounded-full border border-marquee/35 bg-marquee/10 px-2.5 py-1.5 text-[10px] font-semibold whitespace-nowrap text-marquee">
                          🗳️ Votes {totalVotes.toLocaleString()}/{votingThreshold}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setDiscussionOpenById((prev) => ({
                              ...prev,
                              [campaign.id]: !prev[campaign.id],
                            }));
                            window.setTimeout(() => {
                              document.getElementById(commentsAnchorId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                            }, 60);
                          }}
                          aria-label={isDiscussionOpen ? "Hide comments" : "Open comments"}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line text-ink-soft transition-colors hover:border-marquee hover:text-marquee"
                        >
                          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.3 8.3 0 0 1-3.8-.9L3 21l1.9-5.7a8.3 8.3 0 0 1-.9-3.8A8.5 8.5 0 1 1 21 11.5z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleShare(campaign)}
                          aria-label="Share campaign"
                          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-line text-ink-soft transition-colors hover:border-marquee hover:text-marquee"
                        >
                          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <path d="M22 2 11 13" />
                            <path d="m22 2-7 20-4-9-9-4 20-7z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => setBookmarkedById((prev) => ({ ...prev, [campaign.id]: !prev[campaign.id] }))}
                          aria-label={bookmarkedById[campaign.id] ? "Remove bookmark" : "Bookmark campaign"}
                          className={`inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${
                            bookmarkedById[campaign.id]
                              ? "border-rose/60 bg-rose/10 text-rose"
                              : "border-line text-ink-soft hover:border-rose hover:text-rose"
                          }`}
                        >
                          <svg viewBox="0 0 24 24" className="h-5 w-5" fill={bookmarkedById[campaign.id] ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
                            <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {!isHistoricalVoteCampaign && (
                      <div id={commentsAnchorId}>
                        {isDiscussionOpen ? (
                          <CampaignDiscussionInline
                            campaignId={campaign.id}
                            choices={rankedChoices}
                            variant="full"
                          />
                        ) : (
                          <CampaignDiscussionInline
                            campaignId={campaign.id}
                            choices={rankedChoices}
                            variant="preview"
                            previewLimit={2}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          )
        ) : (
          visible.length === 0 ? (
            <div className="rounded-2xl border border-line bg-paper p-6 text-sm text-ink-soft lg:col-span-2">
              {mode === "historical-votes"
                ? "No previous vote campaigns are available yet for this theater."
                : "No campaigns match your filters right now."}
            </div>
          ) : (
          visible.map((campaign) => {
            const interestPct = meter(campaign.counts.interested, campaign.thresholds.interested);
            const backingPct = meter(campaign.counts.backing, campaign.thresholds.backing);
            const reservationCount = Math.max(0, Number(campaign.counts.backing || 0));
            const reservationThreshold = Math.max(1, Number(campaign.thresholds.backing || 1));
            const votingCount = Math.max(0, Number(campaign.counts.interested || 0));
            const votingThreshold = Math.max(reservationThreshold, Number(campaign.thresholds.interested || reservationThreshold * 2));
            const rankedChoices = rankCampaignChoices(campaign.choices);
            const displayTitle = campaignTitleWithTheater(campaign);
            const chosenMovie = rankedChoices[0]?.title || campaign.selectedMovieTitle || "Movie TBD";
            const supportPending = Boolean(pendingById[campaign.id]);
            const votePending = Boolean(pendingVoteById[campaign.id]);
            const adminPending = Boolean(adminPendingById[campaign.id]);
            const adminDraftStatus = adminStatusById[campaign.id] || campaign.status;
            const adminDraftMovie = adminMovieById[campaign.id] ?? (campaign.selectedMovieTitle || "");
            const adminDraftNote = adminNoteById[campaign.id] || "";
            const rankedTitles = rankedChoices.map((choice) => choice.title).filter(Boolean).join(" • ");
            const selectedComparable = comparableTitle(chosenMovie);
            const votedCampaignMovieId = campaign.viewerMovieVoteCampaignMovieId;
            const isHistoricalVoteCampaign = campaign.origin === "historical-vote";
            const canVoteAtAll = !isHistoricalVoteCampaign && !readOnly;
            const canVoteNow = canVoteAtAll;
            const prefersSelectedMovie =
              isHistoricalVoteCampaign || ["completed", "confirmed", "screening"].includes(String(campaign.status || ""));
            const highlightedComparable = comparableTitle(
              prefersSelectedMovie && campaign.selectedMovieTitle
                ? campaign.selectedMovieTitle
                : (rankedChoices[0]?.title || campaign.selectedMovieTitle || ""),
            );

            return (
              <article key={campaign.id} className="rounded-2xl border border-line bg-paper p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTone[campaign.status] || statusTone.active}`}>
                    {statusLabel[campaign.status] || campaign.status}
                  </span>
                  <span className="text-xs text-ink-faint">{campaign.market}</span>
                </div>

                <h3 className="mt-3 font-display text-2xl font-semibold text-ink">{displayTitle}</h3>
                <p className="mt-1 text-sm text-ink-soft">Date: {campaign.dateWindowLabel}</p>
                {campaign.createdByEmail && (
                  <p className="mt-1 text-xs text-ink-faint">Created by {campaign.createdByEmail}</p>
                )}

                <div className="mt-4 rounded-2xl border border-line bg-cream p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Community Vote</p>
                    <p className="text-xs text-ink-soft">Leading: <span className="font-semibold text-ink">{chosenMovie}</span></p>
                  </div>

                  <div className="grid grid-cols-3 gap-2.5">
                    {rankedChoices.map((choice, idx) => {
                      const currentRank = idx + 1;
                      const statusText = availabilityTagText(choice.availabilityStatus);
                      const statusClass = availabilityClass(choice.availabilityStatus);
                      const isLeader = comparableTitle(choice.title) === selectedComparable;
                      const isHighlighted = comparableTitle(choice.title) === highlightedComparable;
                      const isVoted = votedCampaignMovieId === choice.campaignMovieId;

                      return (
                        <div
                          key={`${campaign.id}-feed-${choice.campaignMovieId}`}
                          className={`overflow-hidden rounded-xl border bg-paper ${
                            isHighlighted || isLeader
                              ? "border-emerald/60 ring-2 ring-emerald/35"
                              : "border-line"
                          }`}
                        >
                          <div className="relative aspect-[2/3] bg-gradient-to-br from-cream to-cream-soft">
                            {choice.posterUrl ? (
                              <img
                                src={choice.posterUrl}
                                alt={`${choice.title} poster`}
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center px-2 text-center text-[11px] font-semibold leading-snug text-ink-soft">
                                {choice.title}
                              </div>
                            )}
                            <span className={`absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${rankBadgeClass(currentRank)}`}>
                              #{currentRank}
                            </span>
                            <span className={`absolute right-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusClass}`}>
                              {statusText}
                            </span>
                            {isVoted && (
                              <span className="absolute right-1.5 top-7 rounded-full bg-emerald px-1.5 py-0.5 text-[10px] font-semibold text-white">
                                Voted ✓
                              </span>
                            )}
                          </div>
                          <div className="space-y-1 p-2.5">
                            <p className="line-clamp-2 text-[11px] font-semibold leading-tight text-ink">{choice.title}</p>
                            <p className="text-[11px] text-ink-soft">{choice.voteCount} votes</p>
                            {canVoteAtAll && (
                              <button
                                type="button"
                                disabled={votePending || isVoted || !canVoteNow}
                                onClick={() => handleVote(campaign, choice.campaignMovieId)}
                                className={`mt-1 w-full rounded-full border px-2 py-1 text-[10px] font-semibold transition-colors ${
                                  isVoted
                                    ? "border-emerald/50 bg-emerald/10 text-emerald"
                                    : "border-line text-ink-soft hover:border-marquee hover:text-marquee"
                                }`}
                              >
                                {isVoted ? "Voted ✓" : votePending ? "Saving…" : "Vote"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <p className="mt-3 text-xs leading-relaxed text-ink-soft">
                    {rankedTitles || "No ranked picks yet."}
                  </p>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-marquee/30 bg-gradient-to-br from-marquee/10 to-paper px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-marquee">🗳️ Votes</p>
                    <div className="mt-1 flex items-end justify-between gap-2">
                      <p className="text-sm font-semibold text-ink">{campaign.counts.interested} / {campaign.thresholds.interested}</p>
                      <p className="text-[11px] font-semibold text-marquee">{interestPct}%</p>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-cream-soft">
                      <div className="h-full rounded-full bg-marquee" style={{ width: `${interestPct}%` }} />
                    </div>
                  </div>
                  <div className="rounded-xl border border-rose/30 bg-gradient-to-br from-rose/10 to-paper px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-rose">🎟️ Reservations</p>
                    <div className="mt-1 flex items-end justify-between gap-2">
                      <p className="text-sm font-semibold text-ink">{campaign.counts.backing} / {campaign.thresholds.backing}</p>
                      <p className="text-[11px] font-semibold text-rose">{backingPct}%</p>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-cream-soft">
                      <div className="h-full rounded-full bg-rose" style={{ width: `${backingPct}%` }} />
                    </div>
                  </div>
                </div>

                {!isHistoricalVoteCampaign && <CampaignDiscussionInline campaignId={campaign.id} choices={rankedChoices} />}

                {!compact && !isHistoricalVoteCampaign && !readOnly && (
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      disabled={supportPending}
                      onClick={() => handleSupport(campaign, "backing")}
                      className={`rounded-full border px-3.5 py-2 text-xs font-semibold transition-colors ${campaign.viewerSupport === "backing" ? "border-rose bg-rose/10 text-rose" : "border-line text-ink-soft hover:border-rose hover:text-rose"}`}
                    >
                      {supportPending && campaign.viewerSupport !== "backing" ? "Saving…" : `🎟️ Reserve ${reservationCount}/${reservationThreshold}`}
                    </button>
                    {campaign.viewerSupport && (
                      <button
                        type="button"
                        disabled={supportPending}
                        onClick={() => handleSupport(campaign, "none")}
                        className="rounded-full border border-line px-3.5 py-2 text-xs font-semibold text-ink-faint transition-colors hover:border-ink/30 hover:text-ink-soft"
                      >
                        Remove support
                      </button>
                    )}
                  </div>
                )}

                {!compact && isAdminUser && !isHistoricalVoteCampaign && !readOnly && (
                  <div className="mt-4 rounded-xl border border-line bg-cream p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Admin controls</p>
                    {campaign.replacement.replacedCampaignId && (
                      <div className="mt-2 rounded-lg border border-line bg-paper p-2.5 text-[11px] text-ink-soft">
                        <p>
                          <strong className="text-ink">Replacement of:</strong> {campaign.replacement.replacedCampaignId}
                        </p>
                        <p className="mt-1">
                          Carried interested supporters: <strong className="text-ink">{campaign.replacement.carriedInterestedCount}</strong>
                        </p>
                        <p className="mt-1">
                          Notification queue count: <strong className="text-ink">{campaign.replacement.notifiedPreviousSupporterCount}</strong>
                        </p>
                        {campaign.replacement.notifiedPreviousSupportersAt ? (
                          <p className="mt-1">Last notified: {campaign.replacement.notifiedPreviousSupportersAt}</p>
                        ) : (
                          <p className="mt-1">Last notified: not yet</p>
                        )}
                      </div>
                    )}
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <select
                        value={adminDraftStatus}
                        onChange={(event) =>
                          setAdminStatusById((prev) => ({ ...prev, [campaign.id]: event.target.value }))
                        }
                        className="rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink outline-none transition-colors focus:border-marquee"
                      >
                        {adminStatusOptions.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={adminDraftMovie}
                        onChange={(event) =>
                          setAdminMovieById((prev) => ({ ...prev, [campaign.id]: event.target.value }))
                        }
                        placeholder="Selected movie title"
                        className="rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink outline-none transition-colors focus:border-marquee"
                      />
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      {campaign.choices.map((choice) => {
                        const draftAvailability =
                          adminAvailabilityByCampaignId[campaign.id]?.[choice.campaignMovieId] || choice.availabilityStatus;
                        return (
                          <label key={`${campaign.id}-${choice.campaignMovieId}`} className="grid gap-1">
                            <span className="line-clamp-1 text-[10px] text-ink-faint">{choice.title}</span>
                            <select
                              value={draftAvailability}
                              onChange={(event) =>
                                setAdminAvailabilityByCampaignId((prev) => ({
                                  ...prev,
                                  [campaign.id]: {
                                    ...(prev[campaign.id] || {}),
                                    [choice.campaignMovieId]: event.target.value,
                                  },
                                }))
                              }
                              className="rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink outline-none transition-colors focus:border-marquee"
                            >
                              <option value="not-checked">not-checked</option>
                              <option value="awaiting-theater-check">awaiting-theater-check</option>
                              <option value="available">available</option>
                              <option value="unavailable">unavailable</option>
                            </select>
                          </label>
                        );
                      })}
                    </div>
                    <textarea
                      rows={2}
                      value={adminDraftNote}
                      onChange={(event) =>
                        setAdminNoteById((prev) => ({ ...prev, [campaign.id]: event.target.value }))
                      }
                      placeholder="Internal note (optional)"
                      className="mt-2 w-full rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink outline-none transition-colors focus:border-marquee"
                    />
                    <button
                      type="button"
                      disabled={adminPending}
                      onClick={() => handleAdminUpdate(campaign)}
                      className="mt-2 rounded-full bg-ink px-3.5 py-2 text-xs font-semibold text-white transition-opacity disabled:opacity-60"
                    >
                      {adminPending ? "Updating…" : "Update campaign"}
                    </button>
                  </div>
                )}
              </article>
            );
          })
          )
        )}
      </div>

      {!compact && actionError && <p className="mt-4 rounded-xl border border-red-300/30 bg-red-900/20 p-3 text-sm text-red-200">{actionError}</p>}

      {canRenderFloatingCreate &&
        isFeedLayout &&
        showCreateButton &&
        showFloatingCreate &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50"
            style={{
              right: `${floatingCreateRight}px`,
              bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
            }}
          >
            <a
              href="/create"
              aria-label="Create campaign"
              className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-marquee px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-marquee/35 transition-transform hover:-translate-y-0.5"
            >
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-lg leading-none">+</span>
              <span className="hidden sm:inline">Create campaign</span>
            </a>
          </div>,
          document.body,
        )}

    </div>
  );
}
