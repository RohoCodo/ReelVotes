import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { createPortal } from "react-dom";
import type { User } from "firebase/auth";
import { collection, deleteDoc, doc, onSnapshot, setDoc } from "firebase/firestore";
import { DayPicker, type DateRange } from "react-day-picker";
import "react-day-picker/dist/style.css";
import { getCampaignSummaries, rankCampaignChoices, type CampaignSummary } from "../lib/campaigns";
import { adminSetCampaignStatus, upsertCampaignMovieVote, upsertCampaignSupport } from "../lib/firebase";
import { db } from "../lib/firebase";
import {
  auth,
  clearLastAuthError,
  isPopupSignInCancellation,
  onAuthStateChanged,
  readLastAuthError,
  signInWithGoogle,
} from "../lib/firebase-auth";
import { dbLite } from "../lib/firebase-lite";
import { getMovieMetadataByTitle } from "../lib/tmdb";

const ADMIN_EMAILS = new Set([
  "rt332@cornell.edu",
  "rohan@reelvotes.com",
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

const POST_AUTH_CAMPAIGN_KEY = "reelvotes:post-auth-campaign";

function isShareCancellation(error: unknown): boolean {
  const name = String((error as any)?.name || "").toLowerCase();
  const message = String((error as any)?.message || "").toLowerCase();
  return name === "aborterror" || message.includes("share canceled") || message.includes("share cancelled");
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy copy path below.
    }
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

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

function rightsTagText(status: CampaignSummary["status"]): string {
  if (status === "active" || status === "licensing-pending") return "Rights Pending";
  return "Confirmed";
}

function rightsTagClass(status: CampaignSummary["status"]): string {
  if (status === "active" || status === "licensing-pending") return "border-gold/35 bg-gold/10 text-rose";
  return "border-emerald/35 bg-emerald/10 text-emerald";
}

type BookmarkedCampaignRecord = {
  campaignId: string;
  slug: string;
  title: string;
  market: string;
  dateWindowLabel: string;
  status: CampaignSummary["status"];
  bookmarkedAtMs: number;
};

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

function campaignTitleWithoutTheater(campaign: CampaignSummary): string {
  const rawTitle = String(campaign.title || "").trim();
  const theater = getDisplayTheaterName(campaign);
  if (!rawTitle || !theater) return rawTitle;

  const suffix = `@ ${theater}`;
  const lowerRaw = rawTitle.toLowerCase();
  const lowerSuffix = suffix.toLowerCase();
  if (lowerRaw.endsWith(lowerSuffix)) {
    return rawTitle.slice(0, rawTitle.length - suffix.length).trim();
  }

  return rawTitle;
}

function formatAuthErrorMessage(rawCode: string, rawMessage: string): string {
  const code = String(rawCode || "").toLowerCase();
  const message = String(rawMessage || "").trim();
  const lowerMessage = message.toLowerCase();

  if (code === "auth/unauthorized-domain") {
    return "Sign-in blocked: this domain is not authorized in Firebase Auth. Add reelvotes.com and www.reelvotes.com in Firebase Authentication > Settings > Authorized domains.";
  }
  if (code === "auth/web-storage-unsupported") {
    return "Sign-in blocked: this browser is blocking web storage/cookies. On iPhone, disable Prevent Cross-Site Tracking for this test or try Safari private tab off.";
  }
  if (code === "auth/popup-blocked" || code === "auth/popup-closed-by-user") {
    return "Google sign-in popup was blocked or closed. Please allow popups for ReelVotes and try Vote again.";
  }
  if (code === "auth/missing-initial-state" || lowerMessage.includes("missing initial state")) {
    return "Sign-in could not be completed in this browser session because auth storage is partitioned/blocked. Open ReelVotes directly in Safari or Chrome (not an in-app browser), then try voting again.";
  }
  if (code === "auth/network-request-failed") {
    return "Sign-in failed due to network restrictions. Please retry on a stable connection and disable strict content blockers for ReelVotes.";
  }

  return `Sign-in error (${rawCode || "unknown"}): ${message || "Unknown authentication error."}`;
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatRangeLabel(range: DateRange | undefined): string {
  if (!range?.from && !range?.to) return "Dates";
  const formatter = new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric"});
  if (range?.from && !range?.to) {
    return formatter.format(range.from);
  }
  if (range?.from && range?.to) {
    return `${formatter.format(range.from)} - ${formatter.format(range.to)}`;
  }
  return "Dates";
}

function rememberPostAuthCampaign(campaignId: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      POST_AUTH_CAMPAIGN_KEY,
      JSON.stringify({
        campaignId: String(campaignId || "").trim(),
        createdAt: Date.now(),
      }),
    );
  } catch {
    // Ignore storage failures and continue with auth.
  }
}

function readPostAuthCampaign(): { campaignId: string; createdAt: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(POST_AUTH_CAMPAIGN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { campaignId?: unknown; createdAt?: unknown };
    const campaignId = String(parsed?.campaignId || "").trim();
    if (!campaignId) return null;
    return {
      campaignId,
      createdAt: Number(parsed?.createdAt || 0),
    };
  } catch {
    return null;
  }
}

function clearPostAuthCampaign() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(POST_AUTH_CAMPAIGN_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export default function CampaignExplorer({
  compact = false,
  layout = "grid",
  mode = "all",
  sortBy = "default",
  showCreateButton = true,
  showSearch = true,
  statusFilter,
  readOnly = false,
}: {
  compact?: boolean;
  layout?: "grid" | "feed";
  mode?: "all" | "historical-votes";
  sortBy?: "default" | "votes-desc";
  showCreateButton?: boolean;
  showSearch?: boolean;
  statusFilter?: CampaignSummary["status"][];
  readOnly?: boolean;
}) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [selectedRange, setSelectedRange] = useState<DateRange | undefined>(undefined);
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [datePickerMonths, setDatePickerMonths] = useState(1);
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [pendingById, setPendingById] = useState<Record<string, boolean>>({});
  const [pendingVoteById, setPendingVoteById] = useState<Record<string, boolean>>({});
  const [pendingBookmarkById, setPendingBookmarkById] = useState<Record<string, boolean>>({});
  const [adminPendingById, setAdminPendingById] = useState<Record<string, boolean>>({});
  const [adminStatusById, setAdminStatusById] = useState<Record<string, string>>({});
  const [adminMovieById, setAdminMovieById] = useState<Record<string, string>>({});
  const [adminAvailabilityByCampaignId, setAdminAvailabilityByCampaignId] = useState<Record<string, Record<string, string>>>({});
  const [adminNoteById, setAdminNoteById] = useState<Record<string, string>>({});
  const [bookmarkedById, setBookmarkedById] = useState<Record<string, boolean>>({});
  const [activeChoiceByCampaignId, setActiveChoiceByCampaignId] = useState<Record<string, number>>({});
  const [actionError, setActionError] = useState("");
  const [canRenderFloatingCreate, setCanRenderFloatingCreate] = useState(false);
  const [floatingCreateRight, setFloatingCreateRight] = useState(16);
  const [showFloatingCreate, setShowFloatingCreate] = useState(false);
  const feedContainerRef = useRef<HTMLDivElement | null>(null);
  const floatingCreateTriggerRef = useRef<HTMLDivElement | null>(null);
  const datePickerRef = useRef<HTMLDivElement | null>(null);
  const isFeedLayout = layout === "feed" && !compact;

  function handleCarouselScroll(campaignId: string, event: UIEvent<HTMLDivElement>) {
    const container = event.currentTarget;
    const viewportWidth = container.clientWidth || 1;
    const nextIndex = Math.max(0, Math.round(container.scrollLeft / viewportWidth));
    setActiveChoiceByCampaignId((prev) => (
      prev[campaignId] === nextIndex
        ? prev
        : { ...prev, [campaignId]: nextIndex }
    ));
  }

  function formatCount(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
    return String(Math.round(value));
  }

  async function handleShare(campaign: CampaignSummary) {
    const shareUrl = `${window.location.origin}/campaigns#${campaign.id}`;
    const shareText = `${campaign.title} • ${campaign.market}`;
    const sharePayload = `${shareText}\n${shareUrl}`;

    try {
      if (navigator.share) {
        try {
          await navigator.share({ title: campaign.title, text: shareText, url: shareUrl });
          return;
        } catch (error) {
          if (isShareCancellation(error)) return;
        }
      }

      const copied = await copyTextToClipboard(sharePayload);
      if (copied) return;

      window.prompt("Copy this campaign link:", sharePayload);
    } catch {
      window.prompt("Copy this campaign link:", sharePayload);
    }
  }

  async function handleBookmark(campaign: CampaignSummary) {
    setActionError("");

    if (!authUser) {
      try {
        await signInWithGoogle();
      } catch (error) {
        if (isPopupSignInCancellation(error)) return;
        setActionError(String((error as any)?.message || "Sign-in required to bookmark campaigns."));
      }
      return;
    }

    const bookmarkRef = doc(db, "userProfiles", authUser.uid, "bookmarks", campaign.id);
    const nextBookmarked = !bookmarkedById[campaign.id];

    setPendingBookmarkById((prev) => ({ ...prev, [campaign.id]: true }));
    try {
      if (nextBookmarked) {
        const payload: BookmarkedCampaignRecord = {
          campaignId: campaign.id,
          slug: campaign.slug,
          title: campaign.title,
          market: campaign.market,
          dateWindowLabel: campaign.dateWindowLabel,
          status: campaign.status,
          bookmarkedAtMs: Date.now(),
        };
        await setDoc(bookmarkRef, payload, { merge: true });
      } else {
        await deleteDoc(bookmarkRef);
      }
    } catch (error) {
      setActionError(String((error as any)?.message || "Could not update bookmark right now."));
    } finally {
      setPendingBookmarkById((prev) => ({ ...prev, [campaign.id]: false }));
    }
  }

  async function openTrailerSearch(movieTitle: string) {
    const title = String(movieTitle || "").trim();
    if (!title) return;

    try {
      const metadata = await getMovieMetadataByTitle(title);
      const trailerUrl = String(metadata?.trailerUrl || "").trim();

      if (trailerUrl.includes("youtube.com/watch")) {
        const parsed = new URL(trailerUrl);
        parsed.searchParams.set("autoplay", "1");
        parsed.searchParams.set("rel", "0");
        window.open(parsed.toString(), "_blank", "noopener,noreferrer");
        return;
      }

      // Bias fallback search toward highly viewed uploads.
      const query = `${title} official trailer most viewed`;
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAMSAhAB`;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      const query = `${title} official trailer most viewed`;
      const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAMSAhAB`;
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  useEffect(() => {
    let cancelled = false;
    const timeoutMs = 8000;
    const timeoutHandle = window.setTimeout(() => {
      if (!cancelled) {
        console.warn("[CampaignExplorer] Campaign load timed out; showing empty state.");
        setCampaigns([]);
      }
    }, timeoutMs);

    getCampaignSummaries({
      includeHistoricalVotes: mode === "historical-votes",
      historicalVotesOnly: mode === "historical-votes",
    })
      .then((rows) => {
        if (!cancelled) {
          window.clearTimeout(timeoutHandle);
          setCampaigns(rows);
        }
      })
      .catch((error) => {
        console.error("[CampaignExplorer] Could not load campaigns:", error);
        if (!cancelled) {
          window.clearTimeout(timeoutHandle);
          setCampaigns([]);
        }
      });

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutHandle);
    };
  }, [mode]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setAuthUser(user);
      if (user) {
        clearLastAuthError();
        setActionError("");
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const applyLastError = () => {
      const latest = readLastAuthError();
      if (!latest) return;
      setActionError(formatAuthErrorMessage(latest.code, latest.message));
    };

    applyLastError();

    const onAuthError = (event: Event) => {
      const customEvent = event as CustomEvent<{ code?: string; message?: string }>;
      const code = String(customEvent.detail?.code || "auth/unknown");
      const message = String(customEvent.detail?.message || "Unknown authentication error.");
      setActionError(formatAuthErrorMessage(code, message));
    };

    window.addEventListener("reelvotes:auth-error", onAuthError as EventListener);
    return () => window.removeEventListener("reelvotes:auth-error", onAuthError as EventListener);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(max-width: 639px)");
    const syncViewport = () => setIsMobileViewport(mediaQuery.matches);
    syncViewport();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncViewport);
      return () => mediaQuery.removeEventListener("change", syncViewport);
    }

    mediaQuery.addListener(syncViewport);
    return () => mediaQuery.removeListener(syncViewport);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!authUser) {
      setBookmarkedById({});
      return;
    }

    const bookmarksRef = collection(db, "userProfiles", authUser.uid, "bookmarks");
    const unsubscribe = onSnapshot(
      bookmarksRef,
      (snapshot) => {
        const next: Record<string, boolean> = {};
        snapshot.forEach((bookmarkDoc) => {
          next[bookmarkDoc.id] = true;
        });
        setBookmarkedById(next);
      },
      (error) => {
        console.error("[CampaignExplorer] Could not load bookmarks:", error);
        setBookmarkedById({});
      },
    );

    return () => unsubscribe();
  }, [authUser]);

  useEffect(() => {
    if (typeof window === "undefined" || !authUser) return;

    const pendingTarget = readPostAuthCampaign();
    if (!pendingTarget?.campaignId) return;

    const targetUrl = `/campaigns#${encodeURIComponent(pendingTarget.campaignId)}`;
    const currentHash = decodeURIComponent(String(window.location.hash || "").replace(/^#/, "")).trim();
    const onTargetPage = window.location.pathname === "/campaigns" && currentHash === pendingTarget.campaignId;

    clearPostAuthCampaign();

    if (!onTargetPage) {
      window.location.assign(targetUrl);
    }
  }, [authUser]);

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

  useEffect(() => {
    if (!showDateFilter) return;

    const onDocPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (datePickerRef.current?.contains(target)) return;
      setShowDateFilter(false);
    };

    document.addEventListener("mousedown", onDocPointerDown);
    document.addEventListener("touchstart", onDocPointerDown, {passive: true});
    return () => {
      document.removeEventListener("mousedown", onDocPointerDown);
      document.removeEventListener("touchstart", onDocPointerDown);
    };
  }, [showDateFilter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(min-width: 640px)");
    const syncMonths = () => setDatePickerMonths(media.matches ? 2 : 1);
    syncMonths();

    const onChange = () => syncMonths();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

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
    const previousVotedCampaignMovieId = campaign.viewerMovieVoteCampaignMovieId;
    const previousCampaignState = campaign;
    let effectiveAuthUser = authUser;

    const adjustVoteCount = (choiceCampaignMovieId: string, delta: number, choices: CampaignSummary["choices"]) =>
      choices.map((choice) =>
        choice.campaignMovieId === choiceCampaignMovieId
          ? {
              ...choice,
              voteCount: Math.max(0, Number(choice.voteCount || 0) + delta),
            }
          : choice,
      );

    if (effectiveAuthUser === undefined) {
      setActionError("Checking sign-in status. Please try voting again in a second.");
      return;
    }

    if (!effectiveAuthUser && auth.currentUser) {
      effectiveAuthUser = auth.currentUser;
      setAuthUser(auth.currentUser);
    }

    if (!effectiveAuthUser) {
      try {
        rememberPostAuthCampaign(campaign.id);
        const signInResult = await signInWithGoogle();
        const popupUser = signInResult?.user || null;

        if (popupUser) {
          effectiveAuthUser = popupUser;
          setAuthUser(popupUser);
          clearPostAuthCampaign();
        } else if (auth.currentUser) {
          effectiveAuthUser = auth.currentUser;
          setAuthUser(auth.currentUser);
          clearPostAuthCampaign();
        } else {
          // Redirect flow may still be in progress; avoid a false negative.
          setActionError("Finishing sign-in… please tap Vote once more in a second.");
          return;
        }
      } catch (error) {
        clearPostAuthCampaign();
        if (isPopupSignInCancellation(error)) {
          return;
        }
        setActionError(String((error as any)?.message || "Sign-in required to vote."));
        return;
      }
    }

    setPendingVoteById((prev) => ({ ...prev, [campaign.id]: true }));

    // Optimistic UI switch so the selected vote updates immediately.
    setCampaigns((prev) => {
      if (!prev) return prev;
      return prev.map((row) =>
        row.id === campaign.id
          ? {
              ...row,
              choices:
                previousVotedCampaignMovieId === campaignMovieId
                  ? adjustVoteCount(campaignMovieId, -1, row.choices)
                  : adjustVoteCount(
                      campaignMovieId,
                      1,
                      previousVotedCampaignMovieId ? adjustVoteCount(previousVotedCampaignMovieId, -1, row.choices) : row.choices,
                    ),
              viewerMovieVoteCampaignMovieId: previousVotedCampaignMovieId === campaignMovieId ? null : campaignMovieId,
            }
          : row,
      );
    });

    try {
      const response: any = await upsertCampaignMovieVote({ campaignId: campaign.id, campaignMovieId });
      const returnedMovies = Array.isArray(response?.data?.campaignMovies) ? response.data.campaignMovies : null;
      const responseData = response?.data || {};
      const canonicalCampaignMovieId = Object.prototype.hasOwnProperty.call(responseData, "campaignMovieId")
        ? (responseData.campaignMovieId ? String(responseData.campaignMovieId) : null)
        : campaignMovieId;
      const selectedMovieTitle = response?.data?.selectedMovieTitle ? String(response.data.selectedMovieTitle) : null;

      setCampaigns((prev) => {
        if (!prev) return prev;
        return prev.map((row) =>
          {
            if (row.id !== campaign.id) return row;

            let nextChoices = row.choices;
            if (returnedMovies) {
              const byId = new Map(
                returnedMovies
                  .map((movie: any) => [String(movie?.campaignMovieId || ""), movie] as const)
                  .filter(([id]) => Boolean(id)),
              );
              const byPosition = new Map(
                returnedMovies
                  .map((movie: any) => [Number(movie?.originalPosition || 0), movie] as const)
                  .filter(([position]) => position > 0),
              );

              nextChoices = row.choices.map((choice) => {
                const matched = byId.get(choice.campaignMovieId) || byPosition.get(choice.originalPosition) || null;
                if (!matched) return choice;
                return {
                  ...choice,
                  ...matched,
                  // Keep any existing poster if backend payload omits it.
                  posterUrl: choice.posterUrl || matched.posterUrl || null,
                };
              });
            }

            return {
              ...row,
              choices: nextChoices,
              selectedMovieTitle,
              viewerMovieVoteCampaignMovieId: canonicalCampaignMovieId,
            };
          },
        );
      });
    } catch (error) {
      setActionError(String((error as any)?.message || "Could not submit vote right now."));
      // Roll back optimistic update on failure.
      setCampaigns((prev) => {
        if (!prev) return prev;
        return prev.map((row) =>
          row.id === campaign.id ? previousCampaignState : row,
        );
      });
    } finally {
      setPendingVoteById((prev) => ({ ...prev, [campaign.id]: false }));
    }
  }

  const isAdminUser = Boolean(authUser?.email && ADMIN_EMAILS.has(String(authUser.email).toLowerCase()));

  const visible = useMemo(() => {
    if (!campaigns) return null;
    const q = search.trim().toLowerCase();
    const start = selectedRange?.from ? toDateKey(selectedRange.from) : "";
    const end = selectedRange?.to
      ? toDateKey(selectedRange.to)
      : (selectedRange?.from ? toDateKey(selectedRange.from) : "");
    const allowedStatuses = statusFilter ? new Set(statusFilter) : null;
    const rows = campaigns.filter((campaign) => {
      if (allowedStatuses && !allowedStatuses.has(campaign.status)) return false;
      if (start || end) {
        const candidateDate = campaignDateKey(campaign);
        if (!candidateDate) return false;
        if (start && candidateDate < start) return false;
        if (end && candidateDate > end) return false;
      }
      if (!q) return true;
      return (
        campaign.title.toLowerCase().includes(q) ||
        campaign.market.toLowerCase().includes(q) ||
        campaign.choices.some((choice) => choice.title.toLowerCase().includes(q))
      );
    });

    const sortedRows = sortBy === "votes-desc"
      ? [...rows].sort((a, b) => {
          const totalVotesA = rankCampaignChoices(a.choices)
            .reduce((sum, choice) => sum + Math.max(0, Number(choice.voteCount || 0)), 0);
          const totalVotesB = rankCampaignChoices(b.choices)
            .reduce((sum, choice) => sum + Math.max(0, Number(choice.voteCount || 0)), 0);
          if (totalVotesB !== totalVotesA) return totalVotesB - totalVotesA;

          const interestedA = Math.max(0, Number(a.counts.interested || 0));
          const interestedB = Math.max(0, Number(b.counts.interested || 0));
          if (interestedB !== interestedA) return interestedB - interestedA;

          const dateA = campaignDateKey(a);
          const dateB = campaignDateKey(b);
          if (dateA && dateB && dateA !== dateB) return dateB.localeCompare(dateA);
          if (dateA && !dateB) return -1;
          if (!dateA && dateB) return 1;

          return a.title.localeCompare(b.title);
        })
      : rows;

    return compact ? sortedRows.slice(0, 3) : sortedRows;
  }, [campaigns, compact, search, selectedRange, sortBy, statusFilter]);

  const gridContainerClass = useMemo(() => {
    if (isFeedLayout) {
      return "mx-auto w-full max-w-2xl";
    }
    if (!compact) {
      return "grid grid-cols-1 gap-4 lg:grid-cols-2";
    }

    const count = visible?.length ?? 0;
    if (count <= 1) {
      return "mx-auto grid w-full max-w-2xl grid-cols-1 gap-4";
    }
    if (count === 2) {
      return "mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-2";
    }
    return "mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3";
  }, [compact, isFeedLayout, visible]);

  useEffect(() => {
    if (typeof window === "undefined" || visible === null || visible.length === 0) return;

    const hashCampaignId = decodeURIComponent(String(window.location.hash || "").replace(/^#/, "")).trim();
    if (!hashCampaignId) return;

    let cancelled = false;
    const scrollToTarget = () => {
      if (cancelled) return true;
      const target = document.getElementById(hashCampaignId);
      if (!target) return false;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      return true;
    };

    if (scrollToTarget()) {
      return;
    }

    const timeoutHandle = window.setTimeout(() => {
      scrollToTarget();
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutHandle);
    };
  }, [visible]);

  if (visible === null) {
    return (
      <div className={compact ? "mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" : "grid grid-cols-1 gap-4 lg:grid-cols-2"}>
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
      {!compact && actionError && (
        <p className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">{actionError}</p>
      )}

      <div ref={floatingCreateTriggerRef} className="h-px" aria-hidden="true" />

      {!compact && showSearch && (
        <div className={isFeedLayout ? "mx-auto mb-5 w-full max-w-2xl" : "mb-5"}>
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={isMobileViewport ? "Search campaigns" : "Search campaigns by movies or campaign title"}
              className="w-full min-w-0 flex-1 rounded-xl border border-line bg-paper px-4 py-3 text-base text-ink outline-none transition-colors focus:border-marquee sm:text-sm"
            />
            <div className="relative shrink-0" ref={datePickerRef}>
              <button
                type="button"
                onClick={() => setShowDateFilter((prev) => !prev)}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${selectedRange?.from ? "border-marquee text-marquee" : "border-line text-ink-soft hover:border-marquee hover:text-marquee"}`}
                aria-label="Filter campaigns by date range"
              >
                <span aria-hidden="true">📅</span>
                <span>{formatRangeLabel(selectedRange)}</span>
              </button>

              {showDateFilter && (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-20 bg-black/20 sm:hidden"
                    onClick={() => setShowDateFilter(false)}
                    aria-label="Close date range picker"
                  />
                  <div className="fixed inset-x-3 top-28 z-30 rounded-2xl border border-line bg-paper p-3 shadow-[0_20px_40px_-16px_rgba(0,0,0,0.55)] sm:absolute sm:right-0 sm:top-[calc(100%+8px)] sm:inset-x-auto sm:w-[21rem] sm:rounded-xl">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Choose date range</p>
                    <DayPicker
                      mode="range"
                      selected={selectedRange}
                      onSelect={setSelectedRange}
                      numberOfMonths={datePickerMonths}
                      pagedNavigation
                      showOutsideDays
                      className="rv-date-picker text-sm"
                    />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedRange(undefined)}
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
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div ref={feedContainerRef} className={gridContainerClass}>
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
              const isHistoricalMode = mode === "historical-votes";
              const canVoteAtAll = !isHistoricalVoteCampaign && !readOnly;
              const canVote = canVoteAtAll;
              const leadLabel = readOnly ? "Winner" : "Leading";
              const displayTheater = getDisplayTheaterName(campaign);
              const totalVotes = rankedChoices.reduce((sum, choice) => sum + Math.max(0, Number(choice.voteCount || 0)), 0);
              const showReserveChip = readOnly ? reservationCount > 0 : true;
              const showVotesChip = totalVotes > 0;
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
              return (
                <article id={campaign.id} key={campaign.id} className="snap-start snap-always flex scroll-mt-24 flex-col rounded-2xl border border-line bg-paper p-3 sm:p-4">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-marquee/15 text-xs font-semibold text-marquee">
                      {String(username || "rv").slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0 pt-0.5">
                      <p className="line-clamp-2 text-[15px] font-semibold leading-tight text-ink sm:line-clamp-1">{readOnly ? campaignTitleWithoutTheater(campaign) : displayTitle}</p>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                        <p className="truncate text-xs leading-tight text-ink-faint">Date: {campaign.dateWindowLabel}</p>
                        <span className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-semibold ${statusTone[campaign.status] || statusTone.active}`}>
                          {statusLabel[campaign.status] || campaign.status}
                        </span>
                        <span className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-semibold ${rightsTagClass(campaign.status)}`}>
                          {rightsTagText(campaign.status)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 overflow-hidden rounded-2xl border border-line bg-cream p-2.5">
                    <div className="mb-2 flex items-center justify-start gap-2 px-1">
                      <p className="text-[11px] text-ink-soft">
                        {leadLabel}
                        {readOnly && displayTheater ? ` @ ${displayTheater}` : ""}: <span className="font-semibold text-ink">{chosenMovie}</span>
                      </p>
                    </div>

                    <div
                      onScroll={(event) => handleCarouselScroll(campaign.id, event)}
                      className="flex snap-x snap-mandatory overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:hidden"
                    >
                      {rankedChoices.map((choice, idx) => {
                        const currentRank = idx + 1;
                        const statusText = availabilityTagText(choice.availabilityStatus);
                        const statusClass = availabilityClass(choice.availabilityStatus);
                        const isVoted = votedCampaignMovieId === choice.campaignMovieId;
                        const isHighlighted = comparableTitle(choice.title) === highlightedComparable;

                        return (
                          <div key={`${campaign.id}-feed-mobile-${choice.campaignMovieId}`} className="w-full shrink-0 snap-center px-1 py-0.5">
                            <div className="mx-auto max-w-[210px]">
                              <div
                                className={`group relative overflow-hidden rounded-xl border text-left ${
                                  isHighlighted ? "border-emerald/60 ring-2 ring-emerald/30" : "border-line"
                                }`}
                              >
                                <div className="relative aspect-[2/3] w-full bg-gradient-to-br from-cream to-cream-soft">
                                  {choice.posterUrl ? (
                                    <img src={choice.posterUrl} alt={`${choice.title} poster`} className="h-full w-full object-cover" loading="lazy" />
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center px-2 text-center text-[11px] font-semibold leading-snug text-ink-soft">
                                      {choice.title}
                                    </div>
                                  )}
                                  <span className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${rankBadgeClass(currentRank)}`}>
                                    #{currentRank}
                                  </span>
                                  <span className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass}`}>
                                    {statusText}
                                  </span>
                                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-8 text-xs font-medium text-white/95">
                                    {choice.voteCount} votes
                                  </span>
                                </div>
                              </div>

                              {canVote && (
                                <div className="mt-2.5 grid grid-cols-[1fr_auto] gap-2">
                                  <button
                                    type="button"
                                    disabled={votePending || !canVote}
                                    onClick={() => handleVote(campaign, choice.campaignMovieId)}
                                    className={`w-full rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                                      isVoted
                                        ? "border-emerald/60 bg-emerald/10 text-emerald"
                                        : "border-line bg-paper text-ink-soft hover:border-marquee hover:text-marquee"
                                    }`}
                                  >
                                    {isVoted ? "Voted ✓" : votePending ? "Saving…" : "Vote"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openTrailerSearch(choice.title)}
                                    aria-label={`Watch trailer for ${choice.title}`}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-soft transition-colors hover:border-marquee hover:text-marquee"
                                  >
                                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                                      <rect x="3" y="5" width="18" height="14" rx="3" />
                                      <path d="M10 9v6l5-3-5-3z" fill="currentColor" stroke="none" />
                                    </svg>
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {rankedChoices.length > 1 && (
                      <div className="mt-2 flex items-center justify-center gap-1.5 sm:hidden" aria-label="Movie carousel pagination">
                        {rankedChoices.map((choice, idx) => {
                          const activeIndex = Math.max(0, Math.min(rankedChoices.length - 1, activeChoiceByCampaignId[campaign.id] ?? 0));
                          const isActive = idx === activeIndex;
                          return (
                            <span
                              key={`${campaign.id}-dot-${choice.campaignMovieId}`}
                              className={`inline-flex h-1.5 w-1.5 rounded-full ${isActive ? "bg-ink" : "bg-line"}`}
                            />
                          );
                        })}
                      </div>
                    )}

                    <div className="hidden grid-cols-3 gap-2 sm:grid">
                      {rankedChoices.map((choice, idx) => {
                        const currentRank = idx + 1;
                        const statusText = availabilityTagText(choice.availabilityStatus);
                        const statusClass = availabilityClass(choice.availabilityStatus);
                        const isVoted = votedCampaignMovieId === choice.campaignMovieId;
                        const isHighlighted = comparableTitle(choice.title) === highlightedComparable;

                        return (
                          <div
                            key={`${campaign.id}-feed-desktop-${choice.campaignMovieId}`}
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
                                <div className="absolute right-1.5 bottom-1.5 flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => openTrailerSearch(choice.title)}
                                    aria-label={`Watch trailer for ${choice.title}`}
                                    className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/70 bg-black/55 text-white transition-colors hover:border-marquee hover:text-marquee"
                                  >
                                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                                      <rect x="3" y="5" width="18" height="14" rx="3" />
                                      <path d="M10 9v6l5-3-5-3z" fill="currentColor" stroke="none" />
                                    </svg>
                                  </button>
                                  <button
                                    type="button"
                                    disabled={votePending || !canVote}
                                    onClick={() => handleVote(campaign, choice.campaignMovieId)}
                                    className={`rounded-full border px-2 py-1 text-[10px] font-semibold transition-colors ${
                                      isVoted
                                        ? "border-emerald/60 bg-emerald/90 text-white"
                                        : "border-white/70 bg-black/55 text-white hover:border-marquee hover:text-marquee"
                                    }`}
                                  >
                                    {isVoted ? "Voted ✓" : votePending ? "Saving…" : "Vote"}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {showReserveChip && (
                          <button
                            type="button"
                            disabled={supportPending || isHistoricalVoteCampaign || readOnly}
                            onClick={() => handleSupport(campaign, campaign.viewerSupport === "backing" ? "none" : "backing")}
                            className={`rounded-full border px-2.5 py-1.5 text-[10px] font-semibold whitespace-nowrap transition-colors ${campaign.viewerSupport === "backing" ? "border-rose bg-rose/10 text-rose" : "border-line text-ink-soft hover:border-rose hover:text-rose"}`}
                          >
                            {supportPending
                              ? "Saving…"
                              : campaign.viewerSupport === "backing"
                                ? `🎟️ Unreserve ${reservationCount}/${reservationThreshold}`
                                : `🎟️ Reserve ${reservationCount}/${reservationThreshold}`}
                          </button>
                        )}
                        {showVotesChip && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-marquee/35 bg-marquee/10 px-2.5 py-1.5 text-[10px] font-semibold whitespace-nowrap text-marquee">
                            🗳️ Votes {totalVotes.toLocaleString()}{isHistoricalMode ? "" : `/${votingThreshold}`}
                          </span>
                        )}
                      </div>

                      <div className="ml-auto flex shrink-0 items-center gap-2">
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
                          disabled={Boolean(pendingBookmarkById[campaign.id])}
                          onClick={() => handleBookmark(campaign)}
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
            const rankedChoices = rankCampaignChoices(campaign.choices);
            const totalVotes = rankedChoices.reduce((sum, choice) => sum + Math.max(0, Number(choice.voteCount || 0)), 0);
            const votePct = meter(totalVotes, campaign.thresholds.interested);
            const backingPct = meter(campaign.counts.backing, campaign.thresholds.backing);
            const reservationCount = Math.max(0, Number(campaign.counts.backing || 0));
            const reservationThreshold = Math.max(1, Number(campaign.thresholds.backing || 1));
            const votingThreshold = Math.max(reservationThreshold, Number(campaign.thresholds.interested || reservationThreshold * 2));
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
            const isHistoricalMode = mode === "historical-votes";
            const canVoteAtAll = !isHistoricalVoteCampaign && !readOnly;
            const canVoteNow = canVoteAtAll;
            const leadLabel = readOnly ? "Winner" : "Leading";
            const displayTheater = getDisplayTheaterName(campaign);
            const prefersSelectedMovie =
              isHistoricalVoteCampaign || ["completed", "confirmed", "screening"].includes(String(campaign.status || ""));
            const highlightedComparable = comparableTitle(
              prefersSelectedMovie && campaign.selectedMovieTitle
                ? campaign.selectedMovieTitle
                : (rankedChoices[0]?.title || campaign.selectedMovieTitle || ""),
            );

            return (
              <article id={campaign.id} key={campaign.id} className="rounded-2xl border border-line bg-paper p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusTone[campaign.status] || statusTone.active}`}>
                      {statusLabel[campaign.status] || campaign.status}
                    </span>
                    <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${rightsTagClass(campaign.status)}`}>
                      {rightsTagText(campaign.status)}
                    </span>
                    <span className="text-xs text-ink-faint">{campaign.market}</span>
                  </div>
                </div>

                <h3 className="mt-3 font-display text-2xl font-semibold text-ink">{readOnly ? campaignTitleWithoutTheater(campaign) : displayTitle}</h3>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <p className="text-sm text-ink-soft">Date: {campaign.dateWindowLabel}</p>
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${statusTone[campaign.status] || statusTone.active}`}>
                    {statusLabel[campaign.status] || campaign.status}
                  </span>
                  <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${rightsTagClass(campaign.status)}`}>
                    {rightsTagText(campaign.status)}
                  </span>
                </div>
                {campaign.createdByEmail && (
                  <p className="mt-1 text-xs text-ink-faint">Created by {campaign.createdByEmail}</p>
                )}

                <div className="mt-4 rounded-2xl border border-line bg-cream p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Community Vote</p>
                    <p className="text-xs text-ink-soft">{leadLabel}{readOnly && displayTheater ? ` @ ${displayTheater}` : ""}: <span className="font-semibold text-ink">{chosenMovie}</span></p>
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
                              <div className="mt-1 grid grid-cols-[1fr_auto] gap-1.5">
                                <button
                                  type="button"
                                  disabled={votePending || !canVoteNow}
                                  onClick={() => handleVote(campaign, choice.campaignMovieId)}
                                  className={`w-full rounded-full border px-2 py-1 text-[10px] font-semibold transition-colors ${
                                    isVoted
                                      ? "border-emerald/50 bg-emerald/10 text-emerald"
                                      : "border-line text-ink-soft hover:border-marquee hover:text-marquee"
                                  }`}
                                >
                                  {isVoted ? "Voted ✓" : votePending ? "Saving…" : "Vote"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openTrailerSearch(choice.title)}
                                  aria-label={`Watch trailer for ${choice.title}`}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-line text-ink-soft transition-colors hover:border-marquee hover:text-marquee"
                                >
                                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                                    <rect x="3" y="5" width="18" height="14" rx="3" />
                                    <path d="M10 9v6l5-3-5-3z" fill="currentColor" stroke="none" />
                                  </svg>
                                </button>
                              </div>
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
                      <p className="text-sm font-semibold text-ink">{totalVotes.toLocaleString()}</p>
                      {canVoteAtAll && !isHistoricalMode && <p className="text-[11px] font-semibold text-marquee">{votePct}%</p>}
                    </div>
                    {canVoteAtAll && !isHistoricalMode && (
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-cream-soft">
                        <div className="h-full rounded-full bg-marquee" style={{ width: `${votePct}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl border border-rose/30 bg-gradient-to-br from-rose/10 to-paper px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-rose">🎟️ Reservations</p>
                      {!isHistoricalVoteCampaign && !readOnly && (
                        <button
                          type="button"
                          disabled={supportPending}
                          onClick={() => handleSupport(campaign, campaign.viewerSupport === "backing" ? "none" : "backing")}
                          className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold whitespace-nowrap transition-colors ${campaign.viewerSupport === "backing" ? "border-rose bg-rose/10 text-rose" : "border-line text-ink-soft hover:border-rose hover:text-rose"}`}
                        >
                          {supportPending
                            ? "Saving…"
                            : campaign.viewerSupport === "backing"
                              ? "Unreserve"
                              : "Reserve"}
                        </button>
                      )}
                    </div>
                    <div className="mt-1 flex items-end justify-between gap-2">
                      <p className="text-sm font-semibold text-ink">{campaign.counts.backing} / {campaign.thresholds.backing}</p>
                      <p className="text-[11px] font-semibold text-rose">{backingPct}%</p>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-cream-soft">
                      <div className="h-full rounded-full bg-rose" style={{ width: `${backingPct}%` }} />
                    </div>
                  </div>
                </div>

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
