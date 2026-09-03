import { collection, getDocs } from "firebase/firestore/lite";
import { dbLite as db } from "./firebase-lite";
import { calculateInterestThreshold, calculateLicensingTrigger, type CampaignStatus } from "./campaign-policy";
import { publicListCampaigns } from "./firebase-core";
import { getMovieMetadataByTitle } from "./tmdb";
import { REELVOTES_EVENTS, type ConfiguredEvent } from "./events-config";

const LEGACY_CAMPAIGN_OWNER_EMAIL = "rohan@reelvotes.com";
const LEGACY_SELECTED_MOVIE_OVERRIDES: Record<string, string> = {
  newparkway1: "The Matrix",
};
const LEGACY_UNAVAILABLE_MOVIES_BY_EVENT: Record<string, string[]> = {
  newparkway1: ["The Fifth Element"],
};

type CampaignOrigin = "campaign" | "historical-vote";

export interface CampaignMovieChoice {
  campaignMovieId: string;
  campaignId: string;
  movieId: string;
  title: string;
  voteCount: number;
  originalPosition: 1 | 2 | 3;
  availabilityStatus: "not-checked" | "awaiting-theater-check" | "available" | "unavailable";
  createdAt: string | null;
  updatedAt: string | null;
  posterUrl: string | null;
}

export interface CampaignSummary {
  id: string;
  slug: string;
  origin: CampaignOrigin;
  createdByEmail: string | null;
  likedByEmail?: string | null;
  title: string;
  market: string;
  preferredTheaters: string[];
  dateWindowLabel: string;
  screeningDateTime?: string | null;
  deadTimeSlot?: {
    slotId: string;
    theaterKey: string | null;
    theaterName: string | null;
    market: string | null;
    dayOfWeek: string | null;
    timeLabel: string | null;
    screeningDateTime: string | null;
    label: string | null;
  } | null;
  status: CampaignStatus;
  selectedMovieTitle: string | null;
  choices: CampaignMovieChoice[];
  counts: {
    interested: number;
    backing: number;
  };
  viewerSupport: "interested" | "backing" | null;
  viewerMovieVoteCampaignMovieId: string | null;
  replacement: {
    replacedCampaignId: string | null;
    replacedByCampaignId: string | null;
    notifyPreviousSupporters: boolean;
    carriedInterestedCount: number;
    notifiedPreviousSupporterCount: number;
    notifiedPreviousSupportersAt: string | null;
  };
  thresholds: {
    backing: number;
    interested: number;
    licensingTriggerBacking: number;
    licensingTriggerInterested: number;
  };
}

const fallbackCampaigns: CampaignSummary[] = [
  {
    id: "campaign_thething_oakland",
    slug: "the-thing-oakland",
    origin: "campaign",
    createdByEmail: null,
    title: "Friday Night Sci-Fi",
    market: "Oakland, CA",
    preferredTheaters: ["The New Parkway Theater", "AMC Bay Street"],
    dateWindowLabel: "Oct 10, 2026",
    screeningDateTime: "2026-10-10T19:30:00",
    status: "movie-available",
    selectedMovieTitle: "The Thing",
    choices: [
      {
        campaignMovieId: "campaign_thething_oakland_1",
        campaignId: "campaign_thething_oakland",
        movieId: "the_thing",
        title: "The Thing",
        voteCount: 42,
        originalPosition: 1,
        availabilityStatus: "available",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
      {
        campaignMovieId: "campaign_thething_oakland_2",
        campaignId: "campaign_thething_oakland",
        movieId: "alien",
        title: "Alien",
        voteCount: 37,
        originalPosition: 2,
        availabilityStatus: "not-checked",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
      {
        campaignMovieId: "campaign_thething_oakland_3",
        campaignId: "campaign_thething_oakland",
        movieId: "predator",
        title: "Predator",
        voteCount: 21,
        originalPosition: 3,
        availabilityStatus: "not-checked",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
    ],
    counts: { interested: 127, backing: 64 },
    viewerSupport: null,
    viewerMovieVoteCampaignMovieId: null,
    replacement: {
      replacedCampaignId: null,
      replacedByCampaignId: null,
      notifyPreviousSupporters: true,
      carriedInterestedCount: 0,
      notifiedPreviousSupporterCount: 0,
      notifiedPreviousSupportersAt: null,
    },
    thresholds: {
      backing: 75,
      interested: 150,
      licensingTriggerBacking: 53,
      licensingTriggerInterested: 105,
    },
  },
  {
    id: "campaign_horror_oakland",
    slug: "friday-night-horror-oakland",
    origin: "campaign",
    createdByEmail: null,
    title: "Friday Night Horror",
    market: "Oakland, CA",
    preferredTheaters: ["The New Parkway Theater"],
    dateWindowLabel: "Nov 2, 2026",
    screeningDateTime: "2026-11-02T20:00:00",
    status: "theater-check",
    selectedMovieTitle: null,
    choices: [
      {
        campaignMovieId: "campaign_horror_oakland_1",
        campaignId: "campaign_horror_oakland",
        movieId: "the_shining",
        title: "The Shining",
        voteCount: 33,
        originalPosition: 1,
        availabilityStatus: "not-checked",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
      {
        campaignMovieId: "campaign_horror_oakland_2",
        campaignId: "campaign_horror_oakland",
        movieId: "halloween",
        title: "Halloween",
        voteCount: 31,
        originalPosition: 2,
        availabilityStatus: "not-checked",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
      {
        campaignMovieId: "campaign_horror_oakland_3",
        campaignId: "campaign_horror_oakland",
        movieId: "a_nightmare_on_elm_street",
        title: "A Nightmare on Elm Street",
        voteCount: 24,
        originalPosition: 3,
        availabilityStatus: "not-checked",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
    ],
    counts: { interested: 109, backing: 38 },
    viewerSupport: null,
    viewerMovieVoteCampaignMovieId: null,
    replacement: {
      replacedCampaignId: null,
      replacedByCampaignId: null,
      notifyPreviousSupporters: true,
      carriedInterestedCount: 0,
      notifiedPreviousSupporterCount: 0,
      notifiedPreviousSupportersAt: null,
    },
    thresholds: {
      backing: 75,
      interested: 150,
      licensingTriggerBacking: 53,
      licensingTriggerInterested: 105,
    },
  },
  {
    id: "campaign_neo_noir_sf",
    slug: "neo-noir-weekend-san-francisco",
    origin: "campaign",
    createdByEmail: null,
    title: "Neo-Noir Weekend",
    market: "San Francisco, CA",
    preferredTheaters: ["Roxie Theater"],
    dateWindowLabel: "Nov 20, 2026",
    screeningDateTime: "2026-11-20T19:00:00",
    status: "active",
    selectedMovieTitle: null,
    choices: [
      {
        campaignMovieId: "campaign_neo_noir_sf_1",
        campaignId: "campaign_neo_noir_sf",
        movieId: "heat",
        title: "Heat",
        voteCount: 29,
        originalPosition: 1,
        availabilityStatus: "not-checked",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
      {
        campaignMovieId: "campaign_neo_noir_sf_2",
        campaignId: "campaign_neo_noir_sf",
        movieId: "collateral",
        title: "Collateral",
        voteCount: 25,
        originalPosition: 2,
        availabilityStatus: "not-checked",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
      {
        campaignMovieId: "campaign_neo_noir_sf_3",
        campaignId: "campaign_neo_noir_sf",
        movieId: "drive",
        title: "Drive",
        voteCount: 20,
        originalPosition: 3,
        availabilityStatus: "not-checked",
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      },
    ],
    counts: { interested: 74, backing: 26 },
    viewerSupport: null,
    viewerMovieVoteCampaignMovieId: null,
    replacement: {
      replacedCampaignId: null,
      replacedByCampaignId: null,
      notifyPreviousSupporters: true,
      carriedInterestedCount: 0,
      notifiedPreviousSupporterCount: 0,
      notifiedPreviousSupportersAt: null,
    },
    thresholds: {
      backing: 75,
      interested: 150,
      licensingTriggerBacking: 53,
      licensingTriggerInterested: 105,
    },
  },
];

function normalizeStatus(raw: unknown): CampaignStatus {
  const value = String(raw || "").trim().toLowerCase();
  if (
    value === "draft" ||
    value === "active" ||
    value === "licensing-pending" ||
    value === "theater-check" ||
    value === "movie-available" ||
    value === "tipped" ||
    value === "scheduled" ||
    value === "confirmed" ||
    value === "screening" ||
    value === "completed" ||
    value === "suspended" ||
    value === "expired" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "active";
}

function normalizeChoices(raw: unknown): CampaignMovieChoice[] {
  const source = Array.isArray(raw) ? raw : [];
  const parsed = source
    .map((item, idx): CampaignMovieChoice | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const originalPosition = Number(row.originalPosition || row.rank || idx + 1);
      const title = String(row.title || "").trim();
      const availabilityRaw = String(
        row.availabilityStatus || row.availability || row.licensing || "not-checked",
      )
        .trim()
        .toLowerCase();
      const availabilityStatus: CampaignMovieChoice["availabilityStatus"] =
        availabilityRaw === "available" || availabilityRaw === "unavailable" || availabilityRaw === "awaiting-theater-check"
          ? availabilityRaw
          : "not-checked";
      const campaignId = String(row.campaignId || "").trim();
      const movieId = String(row.movieId || "").trim();
      const campaignMovieId = String(row.campaignMovieId || row.id || "").trim();
      const voteCount = Math.max(0, Number(row.voteCount ?? row.vote_count ?? 0));
      const posterRaw = String(
        row.posterUrl || row.posterURL || row.poster_path || row.posterPath || row.poster || "",
      ).trim();
      const posterUrl = posterRaw.startsWith("/")
        ? `https://image.tmdb.org/t/p/w500${posterRaw}`
        : (posterRaw || null);
      if (!title || ![1, 2, 3].includes(originalPosition)) return null;
      return {
        campaignMovieId: campaignMovieId || `${campaignId || "campaign"}_${originalPosition}`,
        campaignId,
        movieId: movieId || toComparableMovieTitle(title).replace(/\s+/g, "_"),
        title,
        voteCount,
        originalPosition: originalPosition as 1 | 2 | 3,
        availabilityStatus,
        createdAt: row.createdAt ? String(row.createdAt) : null,
        updatedAt: row.updatedAt ? String(row.updatedAt) : null,
        posterUrl,
      };
    })
    .filter((row): row is CampaignMovieChoice => row !== null);

  const byPosition = new Map<number, CampaignMovieChoice>();
  parsed.forEach((row) => {
    if (!byPosition.has(row.originalPosition)) {
      byPosition.set(row.originalPosition, row);
    }
  });

  return Array.from(byPosition.values())
    .sort((a, b) => a.originalPosition - b.originalPosition)
    .slice(0, 3);
}

function normalizeLegacyChoices(raw: unknown): CampaignMovieChoice[] {
  const source = Array.isArray(raw) ? raw : [];
  const parsed = source
    .map((item, idx): CampaignMovieChoice | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const originalPosition = Number(row.rank || idx + 1);
      const title = String(row.title || "").trim();
      const licensingRaw = String(row.licensing || "unconfirmed").trim().toLowerCase();
      const availabilityStatus: CampaignMovieChoice["availabilityStatus"] =
        licensingRaw === "available"
          ? "available"
          : licensingRaw === "unavailable"
            ? "unavailable"
            : "not-checked";
      if (!title || ![1, 2, 3].includes(originalPosition)) return null;
      return {
        campaignMovieId: `${toComparableMovieTitle(title).replace(/\s+/g, "_") || `choice_${idx + 1}`}_${originalPosition}`,
        campaignId: "",
        movieId: toComparableMovieTitle(title).replace(/\s+/g, "_"),
        title,
        voteCount: Math.max(0, Number(row.voteCount ?? row.vote_count ?? 0)),
        originalPosition: originalPosition as 1 | 2 | 3,
        availabilityStatus,
        createdAt: null,
        updatedAt: null,
        posterUrl: null,
      };
    })
    .filter((row): row is CampaignMovieChoice => row !== null);

  const byPosition = new Map<number, CampaignMovieChoice>();
  parsed.forEach((row) => {
    if (!byPosition.has(row.originalPosition)) {
      byPosition.set(row.originalPosition, row);
    }
  });

  return Array.from(byPosition.values())
    .sort((a, b) => a.originalPosition - b.originalPosition)
    .slice(0, 3);
}

export function rankCampaignChoices(choices: CampaignMovieChoice[]): CampaignMovieChoice[] {
  return [...choices].sort((a, b) => {
    if (b.voteCount !== a.voteCount) return b.voteCount - a.voteCount;
    return a.originalPosition - b.originalPosition;
  });
}

function buildCampaignSummary(id: string, data: Record<string, unknown>): CampaignSummary | null {
  const title = String(data.title || "").trim();
  if (!title) return null;

  const thresholdsSource =
    data.thresholds && typeof data.thresholds === "object" ? (data.thresholds as Record<string, unknown>) : {};
  const countsSource = data.counts && typeof data.counts === "object" ? (data.counts as Record<string, unknown>) : {};
  const replacementSource =
    data.replacement && typeof data.replacement === "object" ? (data.replacement as Record<string, unknown>) : {};

  const backing = Math.max(1, Number(thresholdsSource.backing || data.backingThreshold || 75));
  const interested = Math.max(
    backing,
    Number(thresholdsSource.interested || data.interestedThreshold || calculateInterestThreshold(backing)),
  );

  const normalizedCampaignMovies = normalizeChoices(data.campaignMovies);
  const choices = normalizedCampaignMovies.length > 0 ? normalizedCampaignMovies : normalizeLegacyChoices(data.choices);
  const hydratedChoices = choices.map((choice, index) => ({
    ...choice,
    campaignId: choice.campaignId || id,
    campaignMovieId: choice.campaignMovieId || `${id}_${index + 1}`,
  }));

  return {
    id,
    slug: String(data.slug || id).trim(),
    origin: "campaign",
    createdByEmail: data.createdByEmail ? String(data.createdByEmail).trim() : null,
    likedByEmail: data.likedByEmail ? String(data.likedByEmail).trim().toLowerCase() : null,
    title,
    market: String(data.market || "Unknown market").trim(),
    preferredTheaters: Array.isArray(data.preferredTheaters)
      ? data.preferredTheaters.map((value) => String(value || "").trim()).filter(Boolean)
      : [],
    dateWindowLabel: String(data.dateWindowLabel || "Date window TBD").trim(),
    screeningDateTime: data.screeningDateTime ? String(data.screeningDateTime).trim() : null,
    deadTimeSlot: data.deadTimeSlot && typeof data.deadTimeSlot === "object"
      ? {
          slotId: String((data.deadTimeSlot as Record<string, unknown>).slotId || "").trim(),
          theaterKey: (data.deadTimeSlot as Record<string, unknown>).theaterKey
            ? String((data.deadTimeSlot as Record<string, unknown>).theaterKey).trim()
            : null,
          theaterName: (data.deadTimeSlot as Record<string, unknown>).theaterName
            ? String((data.deadTimeSlot as Record<string, unknown>).theaterName).trim()
            : null,
          market: (data.deadTimeSlot as Record<string, unknown>).market
            ? String((data.deadTimeSlot as Record<string, unknown>).market).trim()
            : null,
          dayOfWeek: (data.deadTimeSlot as Record<string, unknown>).dayOfWeek
            ? String((data.deadTimeSlot as Record<string, unknown>).dayOfWeek).trim()
            : null,
          timeLabel: (data.deadTimeSlot as Record<string, unknown>).timeLabel
            ? String((data.deadTimeSlot as Record<string, unknown>).timeLabel).trim()
            : null,
          screeningDateTime: (data.deadTimeSlot as Record<string, unknown>).screeningDateTime
            ? String((data.deadTimeSlot as Record<string, unknown>).screeningDateTime).trim()
            : null,
          label: (data.deadTimeSlot as Record<string, unknown>).label
            ? String((data.deadTimeSlot as Record<string, unknown>).label).trim()
            : null,
        }
      : null,
    status: normalizeStatus(data.status),
    selectedMovieTitle: data.selectedMovieTitle ? String(data.selectedMovieTitle).trim() : null,
    choices: hydratedChoices,
    counts: {
      interested: Math.max(0, Number(countsSource.interested || 0)),
      backing: Math.max(0, Number(countsSource.backing || 0)),
    },
    viewerSupport:
      data.viewerSupport === "backing" || data.viewerSupport === "interested"
        ? data.viewerSupport
        : null,
    viewerMovieVoteCampaignMovieId: data.viewerMovieVoteCampaignMovieId
      ? String(data.viewerMovieVoteCampaignMovieId)
      : null,
    replacement: {
      replacedCampaignId: replacementSource.replacedCampaignId ? String(replacementSource.replacedCampaignId).trim() : null,
      replacedByCampaignId: replacementSource.replacedByCampaignId ? String(replacementSource.replacedByCampaignId).trim() : null,
      notifyPreviousSupporters: replacementSource.notifyPreviousSupporters !== false,
      carriedInterestedCount: Math.max(0, Number(replacementSource.carriedInterestedCount || 0)),
      notifiedPreviousSupporterCount: Math.max(0, Number(replacementSource.notifiedPreviousSupporterCount || 0)),
      notifiedPreviousSupportersAt: replacementSource.notifiedPreviousSupportersAt
        ? String(replacementSource.notifiedPreviousSupportersAt)
        : null,
    },
    thresholds: {
      backing,
      interested,
      licensingTriggerBacking: calculateLicensingTrigger(backing),
      licensingTriggerInterested: calculateLicensingTrigger(interested),
    },
  };
}

function toComparableMovieTitle(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveLegacyOverrideKey(eventId: string, data: Record<string, unknown>): string | null {
  const byId = String(eventId || "").trim();
  if (byId && (LEGACY_SELECTED_MOVIE_OVERRIDES[byId] || LEGACY_UNAVAILABLE_MOVIES_BY_EVENT[byId])) {
    return byId;
  }
  const dateTime = String(data.screeningDateTime || "").trim();
  if (dateTime.startsWith("2026-04-27")) {
    return "newparkway1";
  }
  return null;
}

function toScreeningSortTime(eventId: string, data: Record<string, unknown>): number {
  const direct = String(data.screeningDateTime || "").trim();
  const parsedDirect = direct ? Date.parse(direct) : Number.NaN;
  if (Number.isFinite(parsedDirect)) return parsedDirect;
  const parsedFromId = eventId ? Date.parse(eventId) : Number.NaN;
  return Number.isFinite(parsedFromId) ? parsedFromId : Number.NaN;
}

function parseDateTimeFromEventId(eventId: string): Date | null {
  const raw = String(eventId || "").trim();
  if (!raw) return null;
  const match = raw.match(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, datePart, hh, mm] = match;
  const iso = `${datePart}T${hh}:${mm}:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function looksLikeOpaqueEventId(value: string): boolean {
  return /(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})$/.test(String(value || "").trim());
}

function normalizeTheaterNameForDisplay(name: string): string {
  const cleaned = String(name || "").trim();
  if (cleaned.toLowerCase().includes("new parkway")) {
    return "The New Parkway Theater";
  }
  return cleaned;
}

function buildReadableScreeningLabel(eventId: string, data: Record<string, unknown>): string {
  const explicit = String(data.screeningLabel || "").trim();
  if (explicit && explicit !== eventId && !looksLikeOpaqueEventId(explicit)) {
    return explicit;
  }

  const screeningDateTime = String(data.screeningDateTime || "").trim();
  const fromDateTime = screeningDateTime ? new Date(screeningDateTime) : null;
  const resolved = fromDateTime && !Number.isNaN(fromDateTime.getTime()) ? fromDateTime : parseDateTimeFromEventId(eventId);
  if (!resolved) return explicit || eventId;

  return resolved.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function loadHistoricalVoteCampaigns(): Promise<CampaignSummary[]> {
  const seededById = new Map<string, Record<string, unknown>>();
  (REELVOTES_EVENTS as ConfiguredEvent[]).forEach((event) => {
    const eventId = String(event.firestoreEventId || event.id || "").trim();
    if (!eventId) return;
    seededById.set(eventId, {
      screeningLabel: event.screeningLabel || "",
      screeningDateTime: event.screeningDateTime || "",
      voteStatus: event.voteStatus || "not-started",
      allowedMovies: Array.isArray(event.allowedMovies) ? event.allowedMovies : [],
      theaterName: event.theaterName || "The New Parkway Theater",
      theaterCity: event.theaterCity || "Oakland, CA",
    });
  });

  const eventsSnap = await getDocs(collection(db, "events"));
  const mergedById = new Map<string, Record<string, unknown>>(seededById);
  eventsSnap.docs.forEach((docSnap) => {
    const id = docSnap.id;
    const existing = mergedById.get(id) || {};
    mergedById.set(id, {
      ...existing,
      ...(docSnap.data() || {}),
    });
  });

  const now = Date.now();
  const eventRows = Array.from(mergedById.entries())
    .map(([id, data]) => ({ id, data }))
    .filter(({ id, data }) => {
      const status = String(data.voteStatus || "").trim().toLowerCase();
      const sortTime = toScreeningSortTime(id, data);
      const isPast = Number.isFinite(sortTime) ? sortTime <= now : false;
      return status === "ended" || isPast;
    });

  const campaigns = await Promise.all(
    eventRows.map(async ({ id, data }): Promise<CampaignSummary | null> => {
      const overrideKey = resolveLegacyOverrideKey(id, data);
      const selectedOverride = overrideKey ? LEGACY_SELECTED_MOVIE_OVERRIDES[overrideKey] : null;
      const unavailableOverrides = new Set(
        (overrideKey ? LEGACY_UNAVAILABLE_MOVIES_BY_EVENT[overrideKey] || [] : []).map((title) =>
          toComparableMovieTitle(title),
        ),
      );

      const moviesSnap = await getDocs(collection(db, "events", id, "movies"));
      const voteRows = moviesSnap.docs
        .map((movieDoc) => {
          const movieData = (movieDoc.data() || {}) as Record<string, unknown>;
          const title = String(movieData.movie_title || movieData.title || movieDoc.id || "").trim();
          const voteCount = Math.max(0, Number(movieData.vote_count ?? movieData.voteCount ?? 0));
          const licensingRaw = String(movieData.licensing || "").trim().toLowerCase();
          const licensing: "unconfirmed" | "available" | "unavailable" =
            licensingRaw === "available" || licensingRaw === "unavailable" ? licensingRaw : "available";
          return { title, voteCount, licensing };
        })
        .filter((row) => Boolean(row.title));

      const allowedMovies = Array.isArray(data.allowedMovies)
        ? data.allowedMovies.map((value) => String(value || "").trim()).filter(Boolean)
        : [];

      const byComparableTitle = new Map<string, { title: string; voteCount: number; licensing: "unconfirmed" | "available" | "unavailable" }>();
      voteRows.forEach((row) => {
        byComparableTitle.set(toComparableMovieTitle(row.title), row);
      });

      allowedMovies.forEach((title) => {
        const key = toComparableMovieTitle(title);
        if (!key || byComparableTitle.has(key)) return;
        byComparableTitle.set(key, {
          title,
          voteCount: 0,
          licensing: "available",
        });
      });

      const topChoices = Array.from(byComparableTitle.values())
        .sort((a, b) => {
          if (b.voteCount !== a.voteCount) return b.voteCount - a.voteCount;
          return a.title.localeCompare(b.title);
        })
        .slice(0, 3);

      if (selectedOverride) {
        const selectedKey = toComparableMovieTitle(selectedOverride);
        const selectedInTopThree = topChoices.some((choice) => toComparableMovieTitle(choice.title) === selectedKey);
        if (!selectedInTopThree) {
          const match = Array.from(byComparableTitle.values()).find(
            (choice) => toComparableMovieTitle(choice.title) === selectedKey,
          );
          if (match) {
            topChoices[2] = match;
          }
        }
      }

      if (topChoices.length < 3) return null;

      const winningMovieRaw = String(data.winningMovie || data.selectedMovieTitle || "").trim();
      const winningMovieCandidate = selectedOverride || winningMovieRaw;
      const winningMovie =
        winningMovieCandidate &&
        topChoices.some((choice) => toComparableMovieTitle(choice.title) === toComparableMovieTitle(winningMovieCandidate))
          ? winningMovieCandidate
          : topChoices.find((choice) => choice.licensing !== "unavailable")?.title || topChoices[0]?.title || null;

      const screeningLabel = buildReadableScreeningLabel(id, data);
      const eventScreeningDateTime = String(data.screeningDateTime || "").trim();
      const theaterName = normalizeTheaterNameForDisplay(String(data.theaterName || "The New Parkway Theater").trim());
      const baseLabel = String(data.campaignTitle || data.title || "Screening vote").trim() || "Screening vote";
      const theaterCity = String(data.theaterCity || "Oakland, CA").trim();
      const totalVotes = Math.max(0, topChoices.reduce((sum, choice) => sum + choice.voteCount, 0));
      const reservationCount = Math.max(
        0,
        Number(
          data.backingCount ??
            data.backing ??
            data.reservationCount ??
            data.reservations ??
            data.ticketsSold ??
            data.presales ??
            0,
        ),
      );

      return {
        id: `legacy_vote_${id}`,
        slug: `legacy-vote-${id}`,
        origin: "historical-vote",
        createdByEmail: LEGACY_CAMPAIGN_OWNER_EMAIL,
        title: `${baseLabel} @ ${theaterName}`,
        market: theaterCity,
        preferredTheaters: [theaterName],
        dateWindowLabel: screeningLabel,
        screeningDateTime: eventScreeningDateTime || null,
        deadTimeSlot: {
          slotId: `legacy-slot-${id}`,
          theaterKey: null,
          theaterName,
          market: theaterCity,
          dayOfWeek: null,
          timeLabel: null,
          screeningDateTime: eventScreeningDateTime || null,
          label: screeningLabel,
        },
        status: "completed",
        selectedMovieTitle: winningMovie,
        choices: topChoices.map((choice, index) => ({
          campaignMovieId: `legacy_vote_${id}_${index + 1}`,
          campaignId: `legacy_vote_${id}`,
          movieId: toComparableMovieTitle(choice.title).replace(/\s+/g, "_"),
          title: choice.title,
          voteCount: Math.max(0, Number(choice.voteCount || 0)),
          originalPosition: (index + 1) as 1 | 2 | 3,
          availabilityStatus: unavailableOverrides.has(toComparableMovieTitle(choice.title))
            ? "unavailable"
            : choice.licensing === "available"
              ? "available"
              : "not-checked",
          createdAt: null,
          updatedAt: null,
          posterUrl: null,
        })),
        counts: {
          interested: totalVotes,
          backing: reservationCount,
        },
        viewerSupport: null,
        viewerMovieVoteCampaignMovieId: null,
        replacement: {
          replacedCampaignId: null,
          replacedByCampaignId: null,
          notifyPreviousSupporters: false,
          carriedInterestedCount: 0,
          notifiedPreviousSupporterCount: 0,
          notifiedPreviousSupportersAt: null,
        },
        thresholds: {
          backing: totalVotes,
          interested: Math.max(totalVotes, calculateInterestThreshold(totalVotes)),
          licensingTriggerBacking: calculateLicensingTrigger(totalVotes),
          licensingTriggerInterested: calculateLicensingTrigger(Math.max(totalVotes, calculateInterestThreshold(totalVotes))),
        },
      };
    }),
  );

  return campaigns.filter((row): row is CampaignSummary => row !== null);
}

async function enrichCampaignPosters(campaigns: CampaignSummary[]): Promise<CampaignSummary[]> {
  return Promise.all(
    campaigns.map(async (campaign) => {
      const choices = await Promise.all(
        campaign.choices.map(async (choice) => {
          if (choice.posterUrl || !choice.title) {
            return choice;
          }
          const metadata = await getMovieMetadataByTitle(choice.title);
          return {
            ...choice,
            posterUrl: metadata.poster || null,
          };
        }),
      );

      return {
        ...campaign,
        choices,
      };
    }),
  );
}

export async function getCampaignSummaries(options?: {
  includeHistoricalVotes?: boolean;
  historicalVotesOnly?: boolean;
}): Promise<CampaignSummary[]> {
  const includeHistoricalVotes = Boolean(options?.includeHistoricalVotes || options?.historicalVotesOnly);
  const historicalVotesOnly = Boolean(options?.historicalVotesOnly);

  async function appendHistoricalVotes(baseCampaigns: CampaignSummary[]): Promise<CampaignSummary[]> {
    if (!includeHistoricalVotes) return baseCampaigns;
    try {
      const historical = await loadHistoricalVoteCampaigns();
      if (historicalVotesOnly) return historical;
      const combined = [...baseCampaigns, ...historical];
      const byId = new Map<string, CampaignSummary>();
      combined.forEach((campaign) => {
        byId.set(campaign.id, campaign);
      });
      return Array.from(byId.values());
    } catch (error) {
      console.warn("[campaigns] Could not load historical vote campaigns.", error);
      return historicalVotesOnly ? [] : baseCampaigns;
    }
  }

  try {
    const response = await publicListCampaigns({ limit: 100 });
    const rows = Array.isArray((response as any)?.data?.campaigns) ? (response as any).data.campaigns : [];
    const campaigns = rows
      .map((row: Record<string, unknown>) => buildCampaignSummary(String(row.id || ""), row))
      .filter((row: CampaignSummary | null): row is CampaignSummary => Boolean(row));

    if (campaigns.length > 0) {
      return await enrichCampaignPosters(await appendHistoricalVotes(campaigns));
    }
  } catch (error) {
    console.warn("[campaigns] Could not load callable campaigns; falling back.", error);
  }

  try {
    const snapshot = await getDocs(collection(db, "campaigns"));
    const campaigns = snapshot.docs
      .map((docSnap) => buildCampaignSummary(docSnap.id, docSnap.data() as Record<string, unknown>))
      .filter((row): row is CampaignSummary => Boolean(row));

    if (campaigns.length > 0) {
      return await enrichCampaignPosters(await appendHistoricalVotes(campaigns));
    }
  } catch (error) {
    console.warn("[campaigns] Could not read live campaigns.", error);
  }

  return await enrichCampaignPosters(await appendHistoricalVotes([]));
}
