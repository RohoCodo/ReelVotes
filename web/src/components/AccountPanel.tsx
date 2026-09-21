import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../lib/firebase";
import { getCampaignSummaries, type CampaignSummary } from "../lib/campaigns";
import { auth, onAuthStateChanged, signInWithGoogle, signOut } from "../lib/firebase-auth";
import { rememberPostAuthDestination } from "../lib/post-auth-redirect";

const LOCAL_BOOKMARKS_KEY_PREFIX = "reelvotes:local-bookmarks:";

type BookmarkedCampaignRecord = {
  campaignId: string;
  slug: string;
  title: string;
  market: string;
  dateWindowLabel: string;
  status: string;
  bookmarkedAtMs: number;
};

type AccountTab = "campaigns" | "moviemarks" | "votes" | "reservations";

type CampaignListItem = {
  campaignId: string;
  title: string;
  market: string;
  dateWindowLabel: string;
  status: string;
  href: string;
  subtitle: string;
};

function localBookmarksStorageKey(uid: string): string {
  return `${LOCAL_BOOKMARKS_KEY_PREFIX}${String(uid || "anon").trim() || "anon"}`;
}

function readLocalBookmarksByUser(uid: string): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(localBookmarksStorageKey(uid));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<string, boolean> = {};
    Object.entries(parsed).forEach(([campaignId, value]) => {
      if (value) next[String(campaignId)] = true;
    });
    return next;
  } catch {
    return {};
  }
}

function localBookmarkIds(uid: string): string[] {
  return Object.keys(readLocalBookmarksByUser(uid)).filter(Boolean);
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = String((error as any)?.code || "").toLowerCase();
  const message = String((error as any)?.message || "").toLowerCase();
  return code.includes("permission-denied") || message.includes("insufficient permissions");
}

function tabButtonClass(active: boolean): string {
  return active
    ? "bg-marquee text-white shadow-sm"
    : "text-ink-soft hover:text-marquee";
}

export default function AccountPanel() {
  const [authUser, setAuthUser] = useState<User | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [bookmarkedCampaigns, setBookmarkedCampaigns] = useState<BookmarkedCampaignRecord[]>([]);
  const [localBookmarkedIds, setLocalBookmarkedIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<AccountTab>("campaigns");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => setAuthUser(user));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!authUser) {
      setBookmarkedCampaigns([]);
      setLocalBookmarkedIds([]);
      return;
    }

    setLocalBookmarkedIds(localBookmarkIds(authUser.uid));

    const bookmarksRef = collection(db, "userProfiles", authUser.uid, "bookmarks");
    const unsubscribe = onSnapshot(
      bookmarksRef,
      (snapshot) => {
        const next = snapshot.docs
          .map((bookmarkDoc) => bookmarkDoc.data() as BookmarkedCampaignRecord)
          .filter((record) => Boolean(record?.campaignId))
          .sort((left, right) => (right.bookmarkedAtMs || 0) - (left.bookmarkedAtMs || 0));
        setBookmarkedCampaigns(next);
        setLocalBookmarkedIds(localBookmarkIds(authUser.uid));
      },
      (error) => {
        setBookmarkedCampaigns([]);
        if (isPermissionDeniedError(error)) {
          setLocalBookmarkedIds(localBookmarkIds(authUser.uid));
        }
      },
    );

    return () => unsubscribe();
  }, [authUser]);

  useEffect(() => {
    if (!authUser) {
      setCampaigns([]);
      return;
    }

    let cancelled = false;

    getCampaignSummaries()
      .then((rows) => {
        if (!cancelled) {
          setCampaigns(rows);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCampaigns([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authUser]);

  async function handleSignIn() {
    setPending(true);
    setErrorMessage("");
    try {
      rememberPostAuthDestination("/campaigns");
      await signInWithGoogle();
    } catch (error) {
      setErrorMessage(String((error as any)?.message || "Could not sign in right now."));
    } finally {
      setPending(false);
    }
  }

  async function handleSignOut() {
    setPending(true);
    setErrorMessage("");
    try {
      await signOut(auth);
    } catch (error) {
      setErrorMessage(String((error as any)?.message || "Could not sign out right now."));
    } finally {
      setPending(false);
    }
  }

  const userEmail = String(authUser?.email || "").toLowerCase();
  const yourCampaigns = useMemo(() => {
    return campaigns
      .filter((campaign) => String(campaign.createdByEmail || "").toLowerCase() === userEmail)
      .map((campaign) => toListItem(campaign, "Created by you"));
  }, [campaigns, userEmail]);

  const movieVotes = useMemo(() => {
    return campaigns
      .filter((campaign) => Boolean(campaign.viewerMovieVoteCampaignMovieId))
      .map((campaign) => toListItem(campaign, campaign.viewerMovieVoteCampaignMovieId ? "Movie vote saved" : ""));
  }, [campaigns]);

  const reservations = useMemo(() => {
    return campaigns
      .filter((campaign) => campaign.viewerSupport === "backing")
      .map((campaign) => toListItem(campaign, "Reservation saved"));
  }, [campaigns]);

  const moviemarks = useMemo(() => {
    const byId = new Map<string, CampaignListItem>();

    bookmarkedCampaigns.forEach((campaign) => {
      byId.set(campaign.campaignId, {
        campaignId: campaign.campaignId,
        title: campaign.title,
        market: campaign.market,
        dateWindowLabel: campaign.dateWindowLabel,
        status: campaign.status,
        href: `/campaigns#${campaign.campaignId}`,
        subtitle: "Bookmarked campaign",
      });
    });

    localBookmarkedIds.forEach((campaignId) => {
      if (byId.has(campaignId)) return;
      const campaign = campaigns.find((entry) => entry.id === campaignId);
      if (!campaign) return;
      byId.set(campaignId, {
        campaignId,
        title: campaign.title,
        market: campaign.market,
        dateWindowLabel: campaign.dateWindowLabel,
        status: campaign.status,
        href: `/campaigns#${campaignId}`,
        subtitle: "Bookmarked campaign",
      });
    });

    return Array.from(byId.values());
  }, [bookmarkedCampaigns, localBookmarkedIds, campaigns]);

  const tabCounts: Record<AccountTab, number> = {
    campaigns: yourCampaigns.length,
    moviemarks: moviemarks.length,
    votes: movieVotes.length,
    reservations: reservations.length,
  };

  const tabItems = {
    campaigns: yourCampaigns,
    moviemarks,
    votes: movieVotes,
    reservations,
  }[activeTab];

  function toListItem(campaign: CampaignSummary, subtitle: string): CampaignListItem {
    return {
      campaignId: campaign.id,
      title: campaign.title,
      market: campaign.market,
      dateWindowLabel: campaign.dateWindowLabel,
      status: campaign.status,
      href: `/campaigns#${campaign.id}`,
      subtitle,
    };
  }

  if (authUser === undefined) {
    return (
      <div className="rounded-2xl border border-line bg-paper p-6">
        <div className="skeleton h-5 w-40 rounded" />
        <div className="skeleton mt-3 h-4 w-56 rounded" />
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-paper p-6">
      {authUser ? (
        <>
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Signed in</p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Your account</h2>
            <p className="mt-2 text-sm text-ink-soft">{authUser.displayName || authUser.email || "ReelVotes member"}</p>
            {authUser.email && <p className="mt-1 text-xs text-ink-faint">{authUser.email}</p>}
          </div>

          <div className="mt-6 border-t border-line pt-5">
            <div className="mx-auto flex w-full max-w-full flex-nowrap items-center gap-1 overflow-x-auto rounded-full border border-line bg-paper p-1.5 shadow-[0_1px_0_rgba(255,255,255,0.02)_inset] sm:w-fit sm:justify-center">
              <button type="button" onClick={() => setActiveTab("campaigns")} className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors sm:px-4 sm:text-xs ${tabButtonClass(activeTab === "campaigns")}`}>
                <span aria-hidden="true">📁</span>
                <span>Campaigns</span>
                <span className="rounded-full bg-cream/40 px-1.5 py-0.5 text-[10px] font-semibold leading-none">{tabCounts.campaigns}</span>
              </button>
              <button type="button" onClick={() => setActiveTab("moviemarks")} className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors sm:px-4 sm:text-xs ${tabButtonClass(activeTab === "moviemarks")}`}>
                <span aria-hidden="true">🎬</span>
                <span>Moviemarks</span>
                <span className="rounded-full bg-cream/40 px-1.5 py-0.5 text-[10px] font-semibold leading-none">{tabCounts.moviemarks}</span>
              </button>
              <button type="button" onClick={() => setActiveTab("votes")} className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors sm:px-4 sm:text-xs ${tabButtonClass(activeTab === "votes")}`}>
                <span aria-hidden="true">🗳️</span>
                <span>Votes</span>
                <span className="rounded-full bg-cream/40 px-1.5 py-0.5 text-[10px] font-semibold leading-none">{tabCounts.votes}</span>
              </button>
              <button type="button" onClick={() => setActiveTab("reservations")} className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors sm:px-4 sm:text-xs ${tabButtonClass(activeTab === "reservations")}`}>
                <span aria-hidden="true">🎟️</span>
                <span>Reservations</span>
                <span className="rounded-full bg-cream/40 px-1.5 py-0.5 text-[10px] font-semibold leading-none">{tabCounts.reservations}</span>
              </button>
            </div>

            <div className="mt-4 rounded-3xl border border-line bg-cream p-4 shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-lg font-semibold text-ink">
                  {activeTab === "campaigns" && "Your campaigns"}
                  {activeTab === "moviemarks" && "Moviemarks"}
                  {activeTab === "votes" && "Movie Votes"}
                  {activeTab === "reservations" && "Reservations"}
                </h3>
                <span className="text-xs text-ink-faint">{tabItems.length} saved</span>
              </div>

              {tabItems.length > 0 ? (
                <div className="mt-4 grid gap-3">
                  {tabItems.map((item) => (
                    <a key={item.campaignId} href={item.href} className="group rounded-2xl border border-line bg-paper p-4 transition-colors hover:border-marquee hover:shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-ink group-hover:text-marquee">{item.title}</p>
                          <p className="mt-1 text-xs text-ink-soft">{item.market}</p>
                          <p className="mt-1 text-xs text-ink-faint">Date: {item.dateWindowLabel}</p>
                          <p className="mt-1 text-[11px] font-medium text-ink-soft">{item.subtitle}</p>
                        </div>
                        <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[10px] font-semibold text-ink-soft">
                          {item.status}
                        </span>
                      </div>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-ink-soft">
                  {activeTab === "campaigns" && "Campaigns you create will appear here."}
                  {activeTab === "moviemarks" && "Saved moviemarks will appear here."}
                  {activeTab === "votes" && "Movie votes you cast will appear here."}
                  {activeTab === "reservations" && "Reservations you place will appear here."}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={handleSignOut}
            className="mx-auto mt-6 block rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-marquee hover:text-marquee disabled:opacity-60"
          >
            {pending ? "Signing out..." : "Sign Out"}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Account</p>
          <h2 className="mt-2 font-display text-2xl font-semibold text-ink">Sign in to view your account</h2>
          <p className="mt-2 text-sm text-ink-soft">Use Google sign-in to manage your ReelVotes account.</p>

          <button
            type="button"
            disabled={pending}
            onClick={handleSignIn}
            className="mt-6 rounded-full bg-marquee px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-marquee-dark disabled:opacity-60"
          >
            {pending ? "Opening sign in..." : "Sign In"}
          </button>
        </>
      )}

      {errorMessage && (
        <p className="mt-4 rounded-lg border border-red-300/30 bg-red-900/20 px-3 py-2 text-xs text-red-200">{errorMessage}</p>
      )}
    </div>
  );
}
