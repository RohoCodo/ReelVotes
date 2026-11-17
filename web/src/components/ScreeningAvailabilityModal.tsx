import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Ticket,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 24h "HH:mm" times, e.g. { start: "17:00", end: "21:00" }. */
export interface TimeSlot {
  start: string;
  end: string;
}

/** One selected calendar day ("YYYY-MM-DD") and the voter's windows for it. */
export interface DateAvailability {
  date: string;
  timeSlots: TimeSlot[];
}

/** Payload handed to `onSubmit`. */
export interface AvailabilityPayload {
  voteId: string;
  eventId: string;
  availability: DateAvailability[];
}

export interface ScreeningAvailabilityModalProps {
  /** Controls visibility; the modal renders nothing when false. */
  isOpen: boolean;
  voteId: string;
  eventId: string;
  /** Movie / event title shown in the header. */
  title: string;
  /** First selectable date (inclusive). Date object or "YYYY-MM-DD". */
  minDate: Date | string;
  /** Last selectable date (inclusive). Date object or "YYYY-MM-DD". */
  maxDate: Date | string;
  onSubmit: (availabilityData: AvailabilityPayload) => void;
  /** Called by "Skip for Now", the X button, ESC, and backdrop clicks. */
  onSkip: () => void;
}

interface TimePreset {
  id: string;
  label: string;
  slot: TimeSlot;
}

// ---------------------------------------------------------------------------
// Constants & date helpers
// ---------------------------------------------------------------------------

const TIME_PRESETS: TimePreset[] = [
  { id: "afternoon", label: "Afternoon (12PM – 5PM)", slot: { start: "12:00", end: "17:00" } },
  { id: "evening", label: "Evening (5PM – 9PM)", slot: { start: "17:00", end: "21:00" } },
  { id: "night", label: "Night (9PM – Late)", slot: { start: "21:00", end: "23:59" } },
];

const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** "HH:mm" options in 30-minute increments for the custom range dropdowns. */
const TIME_OPTIONS: string[] = Array.from({ length: 48 }, (_, i) => {
  const hours = Math.floor(i / 2);
  const minutes = i % 2 === 0 ? "00" : "30";
  return `${String(hours).padStart(2, "0")}:${minutes}`;
});

function toDate(value: Date | string): Date {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTimeLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function formatDateChip(key: string): string {
  const date = toDate(key);
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** 6-row calendar grid (leading/trailing days included) for a given month. */
function buildCalendarWeeks(year: number, month: number): Date[][] {
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
  const weeks: Date[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const row: Date[] = [];
    for (let day = 0; day < 7; day += 1) {
      row.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + week * 7 + day));
    }
    weeks.push(row);
  }
  return weeks;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScreeningAvailabilityModal({
  isOpen,
  voteId,
  eventId,
  title,
  minDate,
  maxDate,
  onSubmit,
  onSkip,
}: ScreeningAvailabilityModalProps) {
  const min = useMemo(() => toDate(minDate), [minDate]);
  const max = useMemo(() => toDate(maxDate), [maxDate]);
  const minKey = toDateKey(min);
  const maxKey = toDateKey(max);

  const [selectedDateKeys, setSelectedDateKeys] = useState<Set<string>>(new Set());
  const [selectedPresetIds, setSelectedPresetIds] = useState<Set<string>>(new Set());
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [validationError, setValidationError] = useState<string>("");
  const [viewYear, setViewYear] = useState<number>(min.getFullYear());
  const [viewMonth, setViewMonth] = useState<number>(min.getMonth());

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // Reset all state each time the modal opens for a fresh vote.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedDateKeys(new Set());
    setSelectedPresetIds(new Set());
    setCustomStart("");
    setCustomEnd("");
    setValidationError("");
    setViewYear(min.getFullYear());
    setViewMonth(min.getMonth());
  }, [isOpen, min]);

  // Focus management: move focus in on open, restore it on close.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onSkip();
        return;
      }
      if (event.key !== "Tab") return;

      // Keyboard trap: cycle Tab / Shift+Tab within the dialog.
      const container = dialogRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button, select, input, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onSkip],
  );

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString([], {
    month: "long",
    year: "numeric",
  });
  const canGoPrevMonth = new Date(viewYear, viewMonth, 1) > new Date(min.getFullYear(), min.getMonth(), 1);
  const canGoNextMonth = new Date(viewYear, viewMonth, 1) < new Date(max.getFullYear(), max.getMonth(), 1);
  const weeks = useMemo(() => buildCalendarWeeks(viewYear, viewMonth), [viewYear, viewMonth]);

  function changeMonth(delta: number) {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  }

  function toggleDate(key: string) {
    setValidationError("");
    setSelectedDateKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function togglePreset(id: string) {
    setValidationError("");
    setSelectedPresetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Union of chosen preset windows plus the custom range, if valid. */
  function buildTimeSlots(): TimeSlot[] | null {
    const slots: TimeSlot[] = TIME_PRESETS.filter((preset) => selectedPresetIds.has(preset.id)).map(
      (preset) => ({ ...preset.slot }),
    );

    if (customStart && customEnd) {
      if (customStart >= customEnd) {
        setValidationError("The custom “From” time must be earlier than the “To” time.");
        return null;
      }
      slots.push({ start: customStart, end: customEnd });
    } else if (customStart || customEnd) {
      setValidationError("Pick both a “From” and “To” time for your custom window.");
      return null;
    }

    return slots;
  }

  function handleSubmit() {
    setValidationError("");
    if (selectedDateKeys.size === 0) {
      setValidationError("Select at least one date you can attend.");
      return;
    }
    const timeSlots = buildTimeSlots();
    if (timeSlots === null) return;
    if (timeSlots.length === 0) {
      setValidationError("Pick at least one time window (a preset or a custom range).");
      return;
    }

    const availability: DateAvailability[] = Array.from(selectedDateKeys)
      .sort()
      .map((date) => ({ date, timeSlots: timeSlots.map((slot) => ({ ...slot })) }));

    onSubmit({ voteId, eventId, availability });
  }

  if (!isOpen) return null;

  const sortedSelectedDates = Array.from(selectedDateKeys).sort();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onSkip();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="availability-modal-title"
        aria-describedby="availability-modal-description"
        onKeyDown={handleKeyDown}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-paper p-6 shadow-xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald">
              <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
              Vote Recorded! 🎟️
            </p>
            <h2 id="availability-modal-title" className="mt-2 font-display text-2xl font-semibold text-ink">
              {title}
            </h2>
            <p id="availability-modal-description" className="mt-1.5 text-sm leading-relaxed text-ink-soft">
              When could you make it to the screening? Pick every date and time window that works —
              it helps the theater lock in the best showtime.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onSkip}
            aria-label="Close availability form"
            className="rounded-full border border-line p-1.5 text-ink-soft transition-colors hover:border-marquee hover:text-marquee"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Date selection */}
        <section className="mt-5" aria-label="Choose available dates">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            Available dates
          </p>

          <div className="mt-2 rounded-xl border border-line bg-cream p-3">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => changeMonth(-1)}
                disabled={!canGoPrevMonth}
                aria-label="Previous month"
                className="rounded-full border border-line p-1 text-ink-soft transition-colors hover:border-marquee hover:text-marquee disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <p className="text-sm font-semibold text-ink">{monthLabel}</p>
              <button
                type="button"
                onClick={() => changeMonth(1)}
                disabled={!canGoNextMonth}
                aria-label="Next month"
                className="rounded-full border border-line p-1 text-ink-soft transition-colors hover:border-marquee hover:text-marquee disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <table className="mt-2 w-full border-separate border-spacing-0.5" role="grid" aria-label={monthLabel}>
              <thead>
                <tr>
                  {WEEKDAY_LABELS.map((label) => (
                    <th key={label} scope="col" className="pb-1 text-center text-[10px] font-semibold uppercase text-ink-faint">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((week, weekIndex) => (
                  <tr key={weekIndex}>
                    {week.map((day) => {
                      const key = toDateKey(day);
                      const inMonth = day.getMonth() === viewMonth;
                      const inRange = key >= minKey && key <= maxKey;
                      const selected = selectedDateKeys.has(key);
                      return (
                        <td key={key} className="p-0 text-center">
                          <button
                            type="button"
                            disabled={!inRange}
                            onClick={() => toggleDate(key)}
                            aria-pressed={selected}
                            aria-label={day.toLocaleDateString([], {
                              weekday: "long",
                              month: "long",
                              day: "numeric",
                            })}
                            className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                              selected
                                ? "bg-marquee text-white"
                                : inRange
                                  ? "text-ink hover:bg-marquee/15"
                                  : `cursor-not-allowed ${inMonth ? "text-ink-faint/40" : "text-ink-faint/20"}`
                            }`}
                          >
                            {day.getDate()}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sortedSelectedDates.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5" aria-live="polite">
              {sortedSelectedDates.map((key) => (
                <span
                  key={key}
                  className="inline-flex items-center gap-1 rounded-full border border-marquee/35 bg-marquee/10 px-2.5 py-1 text-[11px] font-semibold text-marquee"
                >
                  <Check className="h-3 w-3" aria-hidden="true" />
                  {formatDateChip(key)}
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Time availability */}
        <section className="mt-5" aria-label="Choose available times">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Time windows
          </p>

          <div className="mt-2 flex flex-wrap gap-2">
            {TIME_PRESETS.map((preset) => {
              const active = selectedPresetIds.has(preset.id);
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => togglePreset(preset.id)}
                  aria-pressed={active}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    active
                      ? "border-marquee bg-marquee/10 text-marquee"
                      : "border-line text-ink-soft hover:border-marquee hover:text-marquee"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-[11px] font-semibold text-ink-faint">Custom — From</span>
              <select
                value={customStart}
                onChange={(event) => {
                  setValidationError("");
                  setCustomStart(event.target.value);
                }}
                className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-marquee"
              >
                <option value="">No custom time</option>
                {TIME_OPTIONS.map((time) => (
                  <option key={time} value={time}>
                    {formatTimeLabel(time)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-[11px] font-semibold text-ink-faint">Custom — To</span>
              <select
                value={customEnd}
                onChange={(event) => {
                  setValidationError("");
                  setCustomEnd(event.target.value);
                }}
                className="rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-marquee"
              >
                <option value="">No custom time</option>
                {TIME_OPTIONS.map((time) => (
                  <option key={time} value={time}>
                    {formatTimeLabel(time)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {validationError && (
          <p role="alert" className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            {validationError}
          </p>
        )}

        {/* Actions */}
        <div className="mt-6 flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
          <button
            type="button"
            onClick={onSkip}
            className="rounded-full border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:border-marquee hover:text-marquee"
          >
            Skip for Now
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="rounded-full bg-marquee px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-marquee/90"
          >
            Submit Availability
          </button>
        </div>
      </div>
    </div>
  );
}
