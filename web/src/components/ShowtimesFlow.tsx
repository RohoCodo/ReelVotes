import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db, publicListTheaters, submitTheaterPetition } from "../lib/firebase";
import { REELVOTES_EVENTS, type ConfiguredEvent } from "../lib/events-config";
import { withTimeout } from "../lib/withTimeout";

type VoteStatus = "live" | "ended" | "not-started";

interface MergedEvent {
  id: string;
  firestoreEventId: string;
  screeningLabel: string;
  screeningDateTime: string;
  voteStatus: VoteStatus;
  theaterName: string;
  theaterCity: string;
  partnered: boolean;
}

interface Theater {
  id: string;
  name: string;
  city: string;
  partnered: boolean;
}

const STATUS_META: Record<VoteStatus, { label: string; className: string }> = {
  live: { label: "Voting live", className: "bg-emerald-soft text-emerald" },
  ended: { label: "Voting ended", className: "bg-cream-soft text-ink-faint" },
  "not-started": { label: "Voting upcoming", className: "bg-gold-soft text-gold" },
};

function slug(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toDateKey(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(value: string): string {
  const raw = String(value || "").trim();
  if (!raw) return "TBD";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    const parts = raw.split("T");
    return parts[1] ? parts[1].slice(0, 5) : "TBD";
  }
  return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function resolveStatus(raw: unknown): VoteStatus {
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "live" || normalized === "ended") return normalized;
  return "not-started";
}

function getEventSortTime(event: { screeningDateTime?: string; id?: string }): number {
  const rawDateTime = String(event?.screeningDateTime || "").trim();
  const parsedDateTime = rawDateTime ? Date.parse(rawDateTime) : Number.NaN;
  if (Number.isFinite(parsedDateTime)) return parsedDateTime;
  const rawId = String(event?.id || "").trim();
  const parsedId = rawId ? Date.parse(rawId) : Number.NaN;
  return Number.isFinite(parsedId) ? parsedId : Number.NEGATIVE_INFINITY;
}

async function loadMergedEvents(): Promise<MergedEvent[]> {
  const mergedById = new Map<string, MergedEvent>();

  (REELVOTES_EVENTS as ConfiguredEvent[]).forEach((event) => {
    const firestoreEventId = event.firestoreEventId || event.id;
    mergedById.set(firestoreEventId, {
      id: event.id,
      firestoreEventId,
      screeningLabel: event.screeningLabel || event.id,
      screeningDateTime: event.screeningDateTime || "",
      voteStatus: resolveStatus(event.voteStatus),
      theaterName: event.theaterName || "The New Parkway Theater",
      theaterCity: event.theaterCity || "Oakland, CA",
      partnered: event.partnered !== false,
    });
  });

  try {
    const snapshot = await withTimeout(getDocs(collection(db, "events")), 5000, null, "showtimes events load");
    if (!snapshot) {
      return Array.from(mergedById.values()).sort((a, b) => getEventSortTime(a) - getEventSortTime(b));
    }
    snapshot.forEach((eventDoc) => {
      const data = eventDoc.data() || {};
      if (!data.screeningLabel && !data.screeningDateTime) return;

      const firestoreEventId = eventDoc.id;
      const existing = mergedById.get(firestoreEventId);
      mergedById.set(firestoreEventId, {
        id: existing?.id || firestoreEventId,
        firestoreEventId,
        screeningLabel: data.screeningLabel || existing?.screeningLabel || firestoreEventId,
        screeningDateTime: data.screeningDateTime || existing?.screeningDateTime || "",
        voteStatus: resolveStatus(data.voteStatus || existing?.voteStatus),
        theaterName: data.theaterName || existing?.theaterName || "The New Parkway Theater",
        theaterCity: data.theaterCity || existing?.theaterCity || "Oakland, CA",
        partnered: data.partnered !== false,
      });
    });
  } catch (error) {
    console.error("Could not load runtime events:", error);
  }

  return Array.from(mergedById.values()).sort((a, b) => getEventSortTime(a) - getEventSortTime(b));
}

function buildTheaters(events: MergedEvent[]): Theater[] {
  const byKey = new Map<string, Theater>();
  events.forEach((event) => {
    const name = event.theaterName.trim();
    const city = event.theaterCity.trim();
    const key = `${slug(name)}|${slug(city)}`;
    if (!byKey.has(key)) {
      byKey.set(key, { id: slug(`${name}-${city}`), name, city, partnered: event.partnered });
    }
  });

  if (!byKey.size) {
    byKey.set("new-parkway-oakland", {
      id: "new-parkway-oakland",
      name: "The New Parkway Theater",
      city: "Oakland, CA",
      partnered: true,
    });
  }

  return Array.from(byKey.values());
}

export default function ShowtimesFlow() {
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<MergedEvent[]>([]);
  const [baseTheaters, setBaseTheaters] = useState<Theater[]>([]);
  const [searchResults, setSearchResults] = useState<Theater[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTheater, setSelectedTheater] = useState<Theater | null>(null);

  const [viewMode, setViewMode] = useState<"calendar" | "agenda">("calendar");
  const now = useMemo(() => new Date(), []);
  const [currentYear, setCurrentYear] = useState(now.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(now.getMonth());
  const [selectedDateKey, setSelectedDateKey] = useState("");

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadMergedEvents().then((merged) => {
      if (cancelled) return;
      setEvents(merged);
      const theaters = buildTheaters(merged);
      setBaseTheaters(theaters);
      setLoading(false);

      const defaultTheater =
        theaters.find((t) => t.name.toLowerCase().includes("new parkway")) ||
        theaters.find((t) => t.partnered) ||
        theaters[0] ||
        null;
      if (defaultTheater) {
        setSelectedTheater(defaultTheater);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const partneredKeys = useMemo(
    () => new Set(baseTheaters.filter((t) => t.partnered).map((t) => `${slug(t.name)}|${slug(t.city)}`)),
    [baseTheaters],
  );

  async function queryTheaters(rawQuery: string): Promise<Theater[]> {
    const trimmed = rawQuery.trim();
    try {
      const response: any = await withTimeout(
        publicListTheaters({ query: trimmed, limit: trimmed ? 24 : 60 }),
        5000,
        null,
        "theater search",
      );
      if (!response) throw new Error("theater search timed out");
      const rows: any[] = Array.isArray(response?.data?.theaters) ? response.data.theaters : [];

      const remoteTheaters: Theater[] = rows.map((row) => {
        const name = String(row?.theater_name || row?.theater_code || "Unknown Theater").trim();
        const city = String(row?.theater_city_state || row?.city || "").trim();
        const key = `${slug(name)}|${slug(city)}`;
        return {
          id: slug(row?.theater_key || `${name}-${city}`),
          name,
          city,
          partnered: partneredKeys.has(key),
        };
      });

      const merged = new Map<string, Theater>();
      [...baseTheaters, ...remoteTheaters].forEach((theater) => {
        const key = `${slug(theater.name)}|${slug(theater.city)}`;
        if (key) merged.set(key, theater);
      });

      const all = Array.from(merged.values());
      if (!trimmed) return all;

      const lowerQuery = trimmed.toLowerCase();
      return all.filter((theater) =>
        [theater.name, theater.city, theater.id].some((value) => value.toLowerCase().includes(lowerQuery)),
      );
    } catch (error) {
      console.error("Theater search failed, using local list:", error);
      if (!trimmed) return baseTheaters;
      const lowerQuery = trimmed.toLowerCase();
      return baseTheaters.filter((theater) =>
        `${theater.name} ${theater.city}`.toLowerCase().includes(lowerQuery),
      );
    }
  }

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      queryTheaters(value).then(setSearchResults);
    }, 150);
  }

  function selectTheater(theater: Theater) {
    setSelectedTheater(theater);
    setSearchQuery("");
    setSearchResults(null);
  }

  const matchedEvents = useMemo(() => {
    if (!selectedTheater) return [];
    return events.filter(
      (event) =>
        event.theaterName.toLowerCase() === selectedTheater.name.toLowerCase() &&
        event.theaterCity.toLowerCase() === selectedTheater.city.toLowerCase(),
    );
  }, [events, selectedTheater]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, MergedEvent[]>();
    matchedEvents.forEach((event) => {
      const dateKey = toDateKey(event.screeningDateTime || event.id);
      if (!dateKey) return;
      if (!map.has(dateKey)) map.set(dateKey, []);
      map.get(dateKey)!.push(event);
    });
    return map;
  }, [matchedEvents]);

  // Whenever the selected theater's screenings change, pick a sensible default date:
  // prefer the latest date within the currently visible month, else the latest overall.
  useEffect(() => {
    if (!selectedTheater || !selectedTheater.partnered) return;

    const sortedDateKeys = Array.from(eventsByDate.keys()).sort((a, b) => a.localeCompare(b));
    const monthPrefix = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-`;
    const inVisibleMonth = sortedDateKeys.filter((key) => key.startsWith(monthPrefix));
    const next = inVisibleMonth[inVisibleMonth.length - 1] || sortedDateKeys[sortedDateKeys.length - 1] || "";
    setSelectedDateKey(next);

    if (next) {
      const [year, month] = next.split("-").map(Number);
      setCurrentYear(year);
      setCurrentMonth(month - 1);
    }
    // Only re-run when the theater (and therefore its event set) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTheater, eventsByDate]);

  function goToVote(event: MergedEvent) {
    window.location.href = `/vote?event=${encodeURIComponent(event.firestoreEventId)}`;
  }

  function moveMonth(delta: number) {
    const next = new Date(currentYear, currentMonth + delta, 1);
    setCurrentYear(next.getFullYear());
    setCurrentMonth(next.getMonth());
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-line bg-paper p-8 text-center text-sm text-ink-soft">
        Loading showtimes…
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold text-ink">1. Find your local theater</h2>
        <div className="mt-4">
          {selectedTheater ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-cream p-4">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink">{selectedTheater.name}</h3>
                <p className="mt-0.5 truncate text-xs text-ink-soft">{selectedTheater.city}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span
                  className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    selectedTheater.partnered ? "bg-emerald-soft text-emerald" : "bg-cream-soft text-ink-faint"
                  }`}
                >
                  {selectedTheater.partnered ? "Partner" : "Not partnered"}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedTheater(null)}
                  className="whitespace-nowrap rounded-full border border-line px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-ink/30"
                >
                  Change
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => handleSearchInput(event.target.value)}
                placeholder="Find your local theater"
                className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee"
              />
              <div className="mt-3 flex flex-col gap-2">
                {(searchResults ?? baseTheaters).length ? (
                  (searchResults ?? baseTheaters).map((theater) => (
                    <button
                      key={theater.id}
                      type="button"
                      onClick={() => selectTheater(theater)}
                      className="flex items-center justify-between gap-3 rounded-xl border border-line bg-cream px-4 py-3 text-left transition-colors hover:border-marquee/40"
                    >
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold text-ink">{theater.name}</h3>
                        <p className="mt-0.5 truncate text-xs text-ink-soft">{theater.city}</p>
                      </div>
                      <span
                        className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                          theater.partnered ? "bg-emerald-soft text-emerald" : "bg-cream-soft text-ink-faint"
                        }`}
                      >
                        {theater.partnered ? "Partner" : "Not partnered"}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">
                    No theaters found. You can still send a petition below.
                  </p>
                )}
                {searchQuery.trim() && (
                  <button
                    type="button"
                    onClick={() =>
                      selectTheater({ id: "custom-request", name: searchQuery.trim(), city: "", partnered: false })
                    }
                    className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-line bg-paper px-4 py-3 text-left transition-colors hover:border-marquee/40"
                  >
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-ink">Request: {searchQuery.trim()}</h3>
                      <p className="mt-0.5 text-xs text-ink-soft">Don't see your theater? Send a petition.</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-cream-soft px-2.5 py-1 text-[11px] font-semibold text-ink-faint">
                      Request
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {selectedTheater && !selectedTheater.partnered && (
        <PetitionSection
          prefillName={selectedTheater.id === "custom-request" ? "" : ""}
          prefillTheaterName={selectedTheater.name}
          prefillCity={selectedTheater.city}
        />
      )}

      {selectedTheater && selectedTheater.partnered && (
        <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold text-ink">2. Choose a screening</h2>
          <p className="mt-1 text-xs text-ink-soft">
            {selectedTheater.name} · {selectedTheater.city}
          </p>

          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={() => moveMonth(-1)}
              aria-label="Previous month"
              className="grid h-8 w-8 place-items-center rounded-full border border-line text-ink transition-colors hover:border-ink/30"
            >
              ←
            </button>
            <h3 className="text-sm font-semibold text-ink">
              {new Date(currentYear, currentMonth, 1).toLocaleDateString([], { month: "long", year: "numeric" })}
            </h3>
            <button
              type="button"
              onClick={() => moveMonth(1)}
              aria-label="Next month"
              className="grid h-8 w-8 place-items-center rounded-full border border-line text-ink transition-colors hover:border-ink/30"
            >
              →
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-1 rounded-full bg-cream-soft p-1 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setViewMode("calendar")}
              className={`rounded-full py-1.5 transition-colors ${
                viewMode === "calendar" ? "bg-marquee text-white" : "text-ink-soft"
              }`}
            >
              Calendar
            </button>
            <button
              type="button"
              onClick={() => setViewMode("agenda")}
              className={`rounded-full py-1.5 transition-colors ${
                viewMode === "agenda" ? "bg-marquee text-white" : "text-ink-soft"
              }`}
            >
              Agenda
            </button>
          </div>

          {viewMode === "calendar" ? (
            <CalendarGrid
              year={currentYear}
              month={currentMonth}
              eventsByDate={eventsByDate}
              selectedDateKey={selectedDateKey}
              onSelectDate={setSelectedDateKey}
            />
          ) : (
            <AgendaList
              year={currentYear}
              month={currentMonth}
              eventsByDate={eventsByDate}
              onSelectDate={setSelectedDateKey}
            />
          )}

          <div className="mt-5">
            <DayScreenings dateKey={selectedDateKey} events={eventsByDate.get(selectedDateKey) || []} onSelect={goToVote} />
          </div>
        </section>
      )}
    </div>
  );
}

function CalendarGrid({
  year,
  month,
  eventsByDate,
  selectedDateKey,
  onSelectDate,
}: {
  year: number;
  month: number;
  eventsByDate: Map<string, MergedEvent[]>;
  selectedDateKey: string;
  onSelectDate: (dateKey: string) => void;
}) {
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: ReactNode[] = [];
  for (let i = 0; i < startWeekday; i += 1) {
    cells.push(<div key={`empty-${i}`} aria-hidden="true" />);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hasEvents = eventsByDate.has(dateKey);
    const isSelected = selectedDateKey === dateKey;
    cells.push(
      <button
        key={dateKey}
        type="button"
        disabled={!hasEvents}
        onClick={() => onSelectDate(dateKey)}
        aria-label={`${dateKey}${hasEvents ? ", has screenings" : ""}`}
        className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-lg text-xs transition-colors ${
          !hasEvents
            ? "text-ink-faint/50"
            : isSelected
              ? "bg-marquee font-semibold text-white"
              : "bg-marquee-soft font-semibold text-marquee hover:bg-marquee/20"
        }`}
      >
        <span>{day}</span>
        {hasEvents && <em className={`h-1 w-1 rounded-full not-italic ${isSelected ? "bg-white" : "bg-marquee"}`} />}
      </button>,
    );
  }

  return (
    <div className="mt-3">
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase text-ink-faint">
        <span>Sun</span>
        <span>Mon</span>
        <span>Tue</span>
        <span>Wed</span>
        <span>Thu</span>
        <span>Fri</span>
        <span>Sat</span>
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">{cells}</div>
    </div>
  );
}

function AgendaList({
  year,
  month,
  eventsByDate,
  onSelectDate,
}: {
  year: number;
  month: number;
  eventsByDate: Map<string, MergedEvent[]>;
  onSelectDate: (dateKey: string) => void;
}) {
  const rows = Array.from(eventsByDate.entries())
    .filter(([dateKey]) => {
      const [y, m] = dateKey.split("-").map(Number);
      return y === year && m === month + 1;
    })
    .sort(([a], [b]) => a.localeCompare(b));

  if (!rows.length) {
    return <p className="mt-4 rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">No screenings this month yet.</p>;
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {rows.map(([dateKey, dayEvents]) => (
        <button
          key={dateKey}
          type="button"
          onClick={() => onSelectDate(dateKey)}
          className="flex items-center justify-between gap-3 rounded-xl border border-line bg-cream px-4 py-3 text-left transition-colors hover:border-marquee/40"
        >
          <div>
            <p className="text-sm font-semibold text-ink">
              {new Date(`${dateKey}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
            </p>
            <p className="mt-0.5 text-xs text-ink-soft">
              {dayEvents.length} screening{dayEvents.length === 1 ? "" : "s"}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-marquee-soft px-3 py-1.5 text-xs font-semibold text-marquee">Select</span>
        </button>
      ))}
    </div>
  );
}

function DayScreenings({
  dateKey,
  events,
  onSelect,
}: {
  dateKey: string;
  events: MergedEvent[];
  onSelect: (event: MergedEvent) => void;
}) {
  if (!dateKey) {
    return <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">Select a highlighted day to view screenings.</p>;
  }
  if (!events.length) {
    return <p className="rounded-xl bg-cream-soft p-4 text-center text-sm text-ink-soft">No screenings available on this day.</p>;
  }

  const dateLabel = new Date(`${dateKey}T12:00:00`).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-semibold text-ink">{dateLabel}</h4>
        <p className="text-xs text-ink-soft">
          {events.length} screening{events.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {events.map((event) => {
          const meta = STATUS_META[event.voteStatus];
          return (
            <button
              key={event.firestoreEventId}
              type="button"
              onClick={() => onSelect(event)}
              className="rounded-xl border border-line bg-cream p-4 text-left transition-colors hover:border-marquee/50 hover:bg-paper"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-ink-soft">🕒 {formatTime(event.screeningDateTime)}</p>
                <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.className}`}>
                  {meta.label}
                </span>
              </div>
              <h3 className="mt-2 font-display text-base font-semibold text-ink">{event.screeningLabel}</h3>
              <p className="mt-1 text-xs text-ink-soft">
                📍 {event.theaterName} · {event.theaterCity}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PetitionSection({
  prefillName,
  prefillTheaterName,
  prefillCity,
}: {
  prefillName: string;
  prefillTheaterName: string;
  prefillCity: string;
}) {
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());

    setStatus("submitting");
    setErrorMessage("");
    try {
      await submitTheaterPetition(data);
      setStatus("done");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Could not send petition. Please try again.");
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-paper p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold text-ink">2. Bring this theater to ReelVotes</h2>
      <p className="mt-1 text-xs text-ink-soft">Want voting nights at your local theater? Send a request and we'll reach out.</p>

      {status === "done" ? (
        <div className="mt-4 rounded-xl border border-emerald/30 bg-emerald-soft p-5 text-center">
          <h3 className="font-display text-base font-semibold text-ink">Thanks!</h3>
          <p className="mt-2 text-sm text-ink-soft">
            We'll contact the theater and let them know people want ReelVotes in their community.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-4 grid gap-3">
          <input name="name" required type="text" defaultValue={prefillName} placeholder="Your name" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee" />
          <input name="email" required type="email" placeholder="Email" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee" />
          <input name="theaterName" required type="text" defaultValue={prefillTheaterName} placeholder="Theater name" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee" />
          <input name="city" required type="text" defaultValue={prefillCity} placeholder="City" className="w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee" />
          <textarea name="message" placeholder="Message" rows={3} className="w-full resize-y rounded-xl border border-line bg-paper px-4 py-3 text-sm text-ink outline-none transition-colors focus:border-marquee" />
          <button
            type="submit"
            disabled={status === "submitting"}
            className="rounded-full bg-marquee px-6 py-3 text-sm font-semibold text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "submitting" ? "Sending…" : "Send petition"}
          </button>
          {status === "error" && <p className="text-sm text-red-600">{errorMessage}</p>}
        </form>
      )}
    </section>
  );
}
