import { useEffect, useRef, useState } from "react";
import {
  confirmSalesImport, downloadCsv, getSalesAnalytics, listSalesImports,
  previewSalesImport, salesErrorMessage,
  type ImportPreview, type MovieMatch, type MovieMetrics, type SalesAnalytics,
  type SalesFilters, type SalesImport, type SalesRecord,
} from "../lib/reelsuccess-sales";
import { searchMoviesByQuery, type MovieSearchResult } from "../lib/tmdb";

export type SalesView = "overview" | "performance" | "imports";
const inputClass = "min-w-0 rounded-xl border border-line bg-cream px-3 py-2.5 text-sm text-ink";
const buttonClass = "rounded-full bg-violet-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-violet-300 disabled:opacity-50";
const cardClass = "min-w-0 rounded-2xl border border-line bg-paper p-5 sm:p-6";
const dayMs = 86400000;
const dateString = (date: Date) => date.toISOString().slice(0, 10);
const number = (value: number | null, digits = 0) => value === null ? "Not reported" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const money = (value: number | null) => value === null ? "Not reported" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
const percent = (value: number | null) => value === null ? "Not reported" : `${(value * 100).toFixed(1)}%`;

function presetPeriod(preset: string) {
  const today = new Date();
  const endDate = dateString(today);
  const start = new Date(`${endDate}T00:00:00Z`);
  if (preset === "12months") start.setUTCFullYear(start.getUTCFullYear() - 1);
  else start.setTime(start.getTime() - (Number(preset) - 1) * dayMs);
  return { startDate: dateString(start), endDate };
}

export default function ReelSuccessSalesWorkspace({ theaterKey, theaterName, view }: {
  theaterKey: string; theaterName: string; view: SalesView;
}) {
  const [period, setPeriod] = useState(() => presetPeriod("30"));
  const [preset, setPreset] = useState("30");
  const [filters, setFilters] = useState<SalesFilters>({});
  const [data, setData] = useState<SalesAnalytics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [compared, setCompared] = useState<string[]>([]);
  const [selectedMovieId, setSelectedMovieId] = useState("");

  useEffect(() => {
    if (view === "imports") return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    setCompared([]);
    setSelectedMovieId("");
    if (!period.startDate || !period.endDate || period.startDate > period.endDate) {
      setError("Choose a valid date range; the start must be on or before the end.");
      setLoading(false);
      return;
    }
    getSalesAnalytics({ theaterKey, ...period, filters })
      .then(result => { if (!cancelled) setData(result.data); })
      .catch(cause => { if (!cancelled) setError(salesErrorMessage(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [theaterKey, period, filters, revision, view]);

  function exportReport() {
    if (!data) return;
    const chosen = compared.length ? data.movies.filter(movie => compared.includes(movie.movieId)) : data.movies;
    downloadCsv("reelsuccess-movie-performance.csv", [
      ["Theater", theaterName],
      ["Period", data.period.startDate, data.period.endDate],
      ["Generated at", new Date().toISOString()],
      ["Source", "Confirmed theater sales imports; USD; blanks mean not reported"],
      ["Coverage", JSON.stringify(data.coverage)],
      ["Filters", JSON.stringify(filters)],
      ["Caveats", ...data.warnings],
      ...Object.entries(data.definitions).map(([metric, definition]) => [metric, definition]),
      ["Performance index methodology", data.methodology],
      [],
      ["Movie", "Screenings", "Paid admissions", "Gross ticket revenue (USD)", "Average paid tickets", "Paid occupancy", "Revenue per screening (USD)", "Average reported ticket price (USD)", "Performance index", "Baseline count", "Baseline expected paid admissions", "Baseline source row keys", "Index caveat"],
      ...chosen.map(movie => [movie.title, movie.screenings, movie.paidAdmissions,
        movie.grossRevenueCents === null ? null : movie.grossRevenueCents / 100,
        movie.averageTickets, movie.averageOccupancy,
        movie.revenuePerScreeningCents === null ? null : movie.revenuePerScreeningCents / 100,
        movie.averageTicketPriceCents === null ? null : movie.averageTicketPriceCents / 100,
        movie.performanceIndex, movie.baselineCount, movie.expectedPaidAdmissions, movie.baselineScreeningKeys.join("; "), movie.indexReason]),
    ]);
  }

  if (view === "imports") {
    return <SalesImports key={theaterKey} theaterKey={theaterKey} onImported={() => setRevision(value => value + 1)} />;
  }

  const selectedMovie = data?.movies.find(movie => movie.movieId === selectedMovieId);
  const movies = data?.movies || [];
  const sorted = [...movies].filter(movie => movie.averageTickets !== null)
    .sort((a, b) => (b.averageTickets || 0) - (a.averageTickets || 0));

  return (
    <div className="min-w-0 space-y-6">
      <section className={cardClass}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold text-ink">{view === "overview" ? "Theater overview" : "Movie performance"}</h2>
            <p className="mt-2 text-sm text-ink-soft">Actual reported sales. Votes, reservations, and complimentary tickets are not paid admissions.</p>
          </div>
          <button type="button" disabled={!data || loading || !movies.length} onClick={exportReport} className={buttonClass}>Export {compared.length ? "comparison" : "report"} CSV</button>
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-soft">Period
            <select className={inputClass} value={preset} onChange={event => {
              setPreset(event.target.value);
              if (event.target.value !== "custom") setPeriod(presetPeriod(event.target.value));
            }}>
              <option value="1">Today (UTC)</option><option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option><option value="90">Last 90 days</option>
              <option value="12months">Last 12 months</option><option value="custom">Custom dates</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-soft">Start date
            <input type="date" className={inputClass} value={period.startDate} onChange={event => { setPreset("custom"); setPeriod({ ...period, startDate: event.target.value }); }} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-soft">End date
            <input type="date" className={inputClass} value={period.endDate} onChange={event => { setPreset("custom"); setPeriod({ ...period, endDate: event.target.value }); }} />
          </label>
          <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} className="rounded-full border border-line px-4 py-2.5 text-sm text-ink">Refresh</button>
        </div>
        <p className="mt-4 text-xs text-ink-soft">Latest confirmed import: {data?.lastImportedAt ? new Date(data.lastImportedAt).toLocaleString() : "No confirmed import reported"}. Preset boundaries use UTC; screening dates retain the source theater's calendar date.</p>
      </section>

      {loading && <p role="status" className={cardClass}>Loading authorized theater sales...</p>}
      {error && <p role="alert" className={`${cardClass} text-red-300`}>{error}</p>}
      {data && !loading && (
        <>
          {data.warnings.length > 0 && <section className={`${cardClass} border-orange-300/30`} aria-label="Data quality">
            <h3 className="font-semibold text-orange-200">Data coverage and limitations</h3>
            <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-ink-soft">{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </section>}
          {view === "performance" && <section className={cardClass}>
            <h3 className="font-display text-lg text-ink">Compare like-for-like programming</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <FilterSelect label="Genre" value={filters.genre || ""} options={data.filterOptions.genres} onChange={genre => setFilters({ ...filters, genre: genre || undefined })} />
              <FilterSelect label="Release year" value={String(filters.releaseYear || "")} options={data.filterOptions.releaseYears.map(String)} onChange={year => setFilters({ ...filters, releaseYear: year ? Number(year) : undefined })} />
              <FilterSelect label="Decade" value={String(filters.decade || "")} options={[...new Set(data.filterOptions.releaseYears.map(year => String(Math.floor(year / 10) * 10)))]} onChange={decade => setFilters({ ...filters, decade: decade ? Number(decade) : undefined })} />
              <FilterSelect label="Screening type" value={filters.screeningType || ""} options={data.filterOptions.screeningTypes} onChange={screeningType => setFilters({ ...filters, screeningType: screeningType || undefined })} />
              <label className="flex flex-col gap-1 text-xs text-ink-soft">Weekday
                <select className={inputClass} value={filters.weekday === undefined ? "" : filters.weekday} onChange={event => setFilters({ ...filters, weekday: event.target.value ? Number(event.target.value) : undefined })}>
                  <option value="">All weekdays</option>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => <option key={day} value={index}>{day}</option>)}
                </select>
              </label>
              <FilterSelect label="Start time" value={filters.startTime || ""} options={data.filterOptions.startTimes} onChange={startTime => setFilters({ ...filters, startTime: startTime || undefined })} />
              <button type="button" className="self-end rounded-full border border-line px-4 py-2.5 text-sm text-ink" onClick={() => setFilters({})}>Clear filters</button>
            </div>
            <p className="mt-3 text-xs text-ink-soft">Filters recalculate metrics from matching screenings, not just movie titles. Missing genre or release-year data is excluded by those filters.</p>
          </section>}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Paid admissions" value={number(data.summary.paidAdmissions)} definition="Reported paid tickets, excluding complimentary admissions." coverage={`${data.coverage.paidAdmissions} / ${data.summary.screenings} screenings reported`} />
            <Metric label="Gross ticket revenue" value={money(data.summary.grossRevenueCents)} definition="Reported ticket revenue, before deductions. Not net profit or concessions." coverage={`${data.coverage.revenue} / ${data.summary.screenings} screenings reported`} />
            <Metric label="Paid tickets per screening" value={number(data.summary.averageTickets, 1)} definition="Average over screenings with paid-ticket counts, including reported zero sales." coverage={`${data.summary.screenings} screenings in this period`} />
            <Metric label="Average paid occupancy" value={percent(data.summary.averageOccupancy)} definition="Paid admissions relative to reported auditorium capacity; complimentary tickets excluded." coverage={`${data.screenings.filter(record => record.ticketsSold !== null && record.capacity !== null && record.capacity > 0).length} / ${data.summary.screenings} screenings have paid counts and usable capacity`} />
          </div>
          {!data.summary.screenings ? <section className={cardClass}>
            <h3 className="font-display text-xl text-ink">No confirmed sales in this period</h3>
            <p className="mt-2 text-sm text-ink-soft">Use Data & Imports to upload screening-level sales, or choose another period. Missing records are not zero sales.</p>
          </section> : <>
            {view === "overview" && (
              <>
                <SalesTrend trend={data.trend} period={data.period} />
                <div className="grid gap-5 lg:grid-cols-2">
                  <MovieHighlights title="Higher paid tickets per screening" movies={sorted.slice(0, 5)} onSelect={setSelectedMovieId} />
                  <MovieHighlights title="Lower paid tickets per screening" movies={[...sorted].reverse().slice(0, 5)} onSelect={setSelectedMovieId} />
                </div>
                <p className="text-xs leading-relaxed text-ink-soft">These are descriptive averages, not judgments of programming quality. Different capacities, ticket prices, and time slots can change results. Inspect source screenings, data coverage, and baseline evidence before comparing films. The performance index is withheld unless all targets have sufficient matched comparables.</p>
              </>
            )}
            <section className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-display text-xl text-ink">Movie comparison</h3>
                <button type="button" onClick={() => setCompared([])} className="text-sm text-violet-300">Clear comparison</button>
              </div>
              <p className="mt-2 text-sm text-ink-soft">Select movies to compare. All values cover {data.period.startDate} to {data.period.endDate}.</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {movies.map(movie => <label key={movie.movieId} className="flex max-w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm text-ink">
                  <input type="checkbox" checked={compared.includes(movie.movieId)} onChange={event => setCompared(current => event.target.checked ? [...current, movie.movieId] : current.filter(id => id !== movie.movieId))} />
                  <span className="break-words">{movie.title}</span>
                </label>)}
              </div>
              <MovieTable movies={compared.length ? movies.filter(movie => compared.includes(movie.movieId)) : movies} onSelect={setSelectedMovieId} />
            </section>
            {selectedMovie && <MovieEvidence movie={selectedMovie} data={data} onClose={() => setSelectedMovieId("")} />}
          </>}
          <section className={cardClass}>
            <h3 className="font-display text-lg text-ink">Metric definitions and fair comparisons</h3>
            <dl className="mt-3 space-y-3 text-sm">{Object.entries(data.definitions).map(([metric, definition]) => <div key={metric}>
              <dt className="font-semibold text-ink">{metric}</dt><dd className="mt-1 text-ink-soft">{definition}</dd>
            </div>)}</dl>
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">{data.methodology}</p>
          </section>
          {view === "overview" && <section className={cardClass}>
            <h3 className="font-display text-lg text-ink">What this release does not infer</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">Upcoming demand, presale pacing, actual attendance, validated forecasts, and programming recommendations are not available from these historical sales imports. They will require separate source data and validation. Nothing here automatically schedules a film.</p>
          </section>}
        </>
      )}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-soft">{label}
    <select className={inputClass} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">All</option>{options.map(option => <option value={option} key={option}>{option}</option>)}
    </select>
  </label>;
}
function Metric({ label, value, definition, coverage }: { label: string; value: string; definition: string; coverage: string }) {
  return <section className={cardClass}>
    <h3 className="text-sm font-medium text-ink-soft">{label}</h3><p className="mt-3 text-2xl font-semibold text-ink">{value}</p>
    <p className="mt-2 text-xs leading-relaxed text-ink-soft">{definition}</p><p className="mt-3 text-xs text-orange-200">{coverage}</p>
  </section>;
}
function MovieHighlights({ title, movies, onSelect }: { title: string; movies: MovieMetrics[]; onSelect: (id: string) => void }) {
  return <section className={cardClass}>
    <h3 className="font-display text-lg text-ink">{title}</h3>
    {!movies.length && <p className="mt-3 text-sm text-ink-soft">Paid admissions have not been reported.</p>}
    <ul className="mt-3 space-y-3">{movies.map(movie => <li key={movie.movieId} className="flex items-center justify-between gap-3">
      <button type="button" className="min-w-0 break-words text-left text-sm text-violet-300 hover:underline" onClick={() => onSelect(movie.movieId)}>{movie.title}</button>
      <span className="shrink-0 text-sm text-ink">{number(movie.averageTickets, 1)} <span className="text-xs text-ink-soft">paid / screening</span></span>
    </li>)}</ul>
  </section>;
}
function SalesTrend({ trend, period, metric = "paid" }: {
  trend: SalesAnalytics["trend"]; period: SalesAnalytics["period"]; metric?: "paid" | "revenue";
}) {
  const amount = (point: SalesAnalytics["trend"][number]) => metric === "paid" ? point.paidAdmissions : point.grossRevenueCents;
  const display = (value: number | null) => metric === "paid" ? number(value) : money(value);
  const maximum = Math.max(1, ...trend.map(point => amount(point) || 0));
  return <section className={cardClass}>
    <h3 className="font-display text-lg text-ink">{metric === "paid" ? "Reported paid admissions" : "Reported gross ticket revenue"} by screening date</h3>
    <p className="mt-1 text-xs text-ink-soft">{period.startDate} to {period.endDate}. Dates without records are omitted, not plotted as zero.</p>
    <div className="mt-5 max-h-80 space-y-2 overflow-y-auto">
      {trend.map(point => <div key={point.date} className="grid grid-cols-[6rem_minmax(0,1fr)_5rem] items-center gap-2 text-xs">
        <span className="text-ink-soft">{point.date}</span>
        <div className="h-5 rounded bg-cream" title={`${point.date}: ${number(point.paidAdmissions)} paid admissions; ${money(point.grossRevenueCents)} gross; ${point.screenings} screenings`}>
          {amount(point) !== null && <div className="h-full rounded bg-violet-400" style={{ width: `${Math.max((amount(point) || 0) > 0 ? 1 : 0, (amount(point) || 0) / maximum * 100)}%` }} />}
        </div>
        <span className="text-right text-ink">{amount(point) === null ? "N/A" : display(amount(point))}</span>
      </div>)}
    </div>
    <details className="mt-4 text-sm text-ink-soft"><summary className="cursor-pointer text-violet-300">View accessible daily totals</summary>
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th className="p-2">Date</th><th className="p-2">Paid admissions</th><th className="p-2">Gross ticket revenue</th><th className="p-2">Screenings</th></tr></thead>
        <tbody>{trend.map(point => <tr key={point.date}><td className="p-2">{point.date}</td><td className="p-2">{number(point.paidAdmissions)}</td><td className="p-2">{money(point.grossRevenueCents)}</td><td className="p-2">{point.screenings}</td></tr>)}</tbody></table></div>
    </details>
  </section>;
}
function MovieTable({ movies, onSelect }: { movies: MovieMetrics[]; onSelect: (id: string) => void }) {
  return <div className="mt-4 overflow-x-auto">
    <table className="w-full min-w-[800px] text-left text-sm">
      <caption className="sr-only">Reported movie performance in the selected theater and period</caption>
      <thead><tr className="text-xs text-ink-soft">{["Movie", "Screenings", "Paid admissions", "Gross revenue", "Paid / screening", "Paid occupancy", "Performance index"].map(label => <th key={label} scope="col" className="p-3">{label}</th>)}</tr></thead>
      <tbody>{movies.map(movie => <tr key={movie.movieId} className="border-t border-line">
        <th scope="row" className="p-3"><button type="button" className="text-left font-medium text-violet-300 hover:underline" onClick={() => onSelect(movie.movieId)}>{movie.title}</button><p className="mt-1 text-xs font-normal text-ink-soft">{movie.releaseYear || "Year unreported"} / {movie.genre || "Genre unreported"}</p></th>
        <td className="p-3">{movie.screenings}</td><td className="p-3">{number(movie.paidAdmissions)}</td>
        <td className="p-3">{money(movie.grossRevenueCents)}</td><td className="p-3">{number(movie.averageTickets, 1)}</td><td className="p-3">{percent(movie.averageOccupancy)}</td>
        <td className="p-3" title={movie.indexReason}>{movie.performanceIndex === null ? "Insufficient data" : movie.performanceIndex.toFixed(2)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
function MovieEvidence({ movie, data, onClose }: { movie: MovieMetrics; data: SalesAnalytics; onClose: () => void }) {
  const screenings = data.screenings.filter(record => record.movieId === movie.movieId);
  const baselineKeys = new Set(movie.baselineScreeningKeys);
  const baselineScreenings = data.screenings.filter(record => baselineKeys.has(`${record.importBatchId}:${record.rowNumber}`));
  const [poster, setPoster] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setPoster(null); setMetadataError("");
    searchMoviesByQuery(movie.title, 20).then(results => {
      const exact = results.find(result => `tmdb:${result.tmdbId}` === movie.movieId);
      if (!cancelled) setPoster(exact?.poster || null);
    }).catch(cause => { if (!cancelled) setMetadataError(salesErrorMessage(cause)); });
    return () => { cancelled = true; };
  }, [movie.movieId, movie.title]);
  const dates = [...new Set(screenings.map(record => record.screeningDate))].sort();
  const movieTrend = dates.map(date => {
    const rows = screenings.filter(record => record.screeningDate === date);
    const paid = rows.map(row => row.ticketsSold).filter((value): value is number => value !== null);
    const revenue = rows.map(row => row.grossRevenueCents).filter((value): value is number => value !== null);
    return {
      date, screenings: rows.length,
      paidAdmissions: paid.length ? paid.reduce((sum, value) => sum + value, 0) : null,
      grossRevenueCents: revenue.length ? revenue.reduce((sum, value) => sum + value, 0) : null,
    };
  });
  return <section className={`${cardClass} border-violet-400/40`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex min-w-0 items-start gap-4">
      {poster && <img src={poster} alt={`${movie.title} poster`} loading="lazy" className="h-28 w-20 shrink-0 rounded-xl object-cover" />}
      <div>
      <h3 className="font-display text-2xl text-ink">{movie.title}</h3>
      <p className="mt-2 text-sm text-ink-soft">{movie.releaseYear || "Release year not reported"} / {movie.genre || "Genre not reported"} / {movie.runtimeMinutes ? `${movie.runtimeMinutes} minutes` : "Runtime not reported"}</p>
      {metadataError && <p className="mt-2 text-xs text-orange-200">Poster lookup unavailable: {metadataError}</p>}
      </div>
    </div><button type="button" onClick={onClose} className="rounded-full border border-line px-3 py-2 text-sm text-ink">Close detail</button></div>
    <div className="mt-5 grid gap-3 sm:grid-cols-3">
      <Metric label="Revenue per screening" value={money(movie.revenuePerScreeningCents)} definition="Over screenings with reported gross revenue." coverage={`${screenings.filter(record => record.grossRevenueCents !== null).length} / ${screenings.length} screenings report revenue`} />
      <Metric label="Average reported ticket price" value={money(movie.averageTicketPriceCents)} definition="Paid-admission-weighted mean of explicitly reported ticket prices, not revenue divided by tickets." coverage={`${screenings.filter(record => record.ticketsSold !== null && record.ticketsSold > 0 && record.ticketPriceCents !== null).length} / ${screenings.length} screenings have weighted price inputs`} />
      <Metric label="Performance index" value={movie.performanceIndex === null ? "Insufficient data" : movie.performanceIndex.toFixed(2)} definition={movie.indexReason} coverage={`${movie.baselineCount} baseline comparables`} />
    </div>
    <div className="mt-5 grid gap-4 xl:grid-cols-2">
      <SalesTrend trend={movieTrend} period={data.period} />
      <SalesTrend trend={movieTrend} period={data.period} metric="revenue" />
    </div>
    <h4 className="mt-6 font-semibold text-ink">Underlying screenings</h4>
    <ScreeningTable records={screenings} caption={`${movie.title}: source screenings`} />
    <h4 className="mt-6 font-semibold text-ink">Comparable baseline evidence</h4>
    <p className="mt-2 text-sm text-ink-soft">{movie.indexReason} Baseline expected paid admissions: {number(movie.expectedPaidAdmissions, 1)}. A 1.00 index matches the baseline; this is descriptive, not a forecast or causal claim.</p>
    {baselineScreenings.length > 0 && <ScreeningTable records={baselineScreenings} caption={`${movie.title}: other-film baseline screenings`} />}
  </section>;
}

function ScreeningTable({ records, caption }: { records: SalesRecord[]; caption: string }) {
  return <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[850px] text-left text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead><tr>{["Movie", "Date / time", "Auditorium", "Type", "Paid", "Complimentary", "Capacity", "Reported price", "Gross revenue", "Source / batch / row"].map(label => <th scope="col" className="p-2" key={label}>{label}</th>)}</tr></thead>
      <tbody>{records.map(record => <tr key={`${record.importBatchId}:${record.rowNumber}`} className="border-t border-line">
        <td className="p-2">{record.movieTitle}</td>
        <td className="p-2">{record.screeningDate} {record.startTime}</td><td className="p-2">{record.auditorium}</td><td className="p-2">{record.screeningType}</td><td className="p-2">{number(record.ticketsSold)}</td>
        <td className="p-2">{number(record.complimentaryTickets)}</td><td className="p-2">{number(record.capacity)}</td><td className="p-2">{money(record.ticketPriceCents)}</td><td className="p-2">{money(record.grossRevenueCents)}</td><td className="max-w-48 break-all p-2">{record.source} / {record.importBatchId} / {record.rowNumber}</td>
      </tr>)}</tbody></table></div>
}

const importFields = [
  ["movieTitle", "Movie title", true], ["screeningDate", "Screening date (YYYY-MM-DD)", true],
  ["startTime", "Start time (HH:MM)", true], ["auditorium", "Auditorium", true],
  ["screeningType", "Screening type", true], ["ticketsSold", "Paid tickets sold", false],
  ["complimentaryTickets", "Complimentary tickets", false], ["capacity", "Auditorium capacity", false],
  ["grossRevenue", "Gross ticket revenue (USD)", false], ["ticketPrice", "Ticket price (USD)", false],
  ["genre", "Genre", false], ["releaseYear", "Release year", false], ["runtimeMinutes", "Runtime (minutes)", false],
  ["currency", "Currency (USD only)", false],
] as const;

function SalesImports({ theaterKey, onImported }: { theaterKey: string; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [matches, setMatches] = useState<Record<string, MovieMatch>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [imports, setImports] = useState<SalesImport[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setHistoryError("");
    setHistoryLoading(true);
    listSalesImports({ theaterKey }).then(result => {
      if (!cancelled) { setImports(result.data.imports); setNextCursor(result.data.nextCursor); }
    }).catch(cause => { if (!cancelled) setHistoryError(salesErrorMessage(cause)); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [theaterKey, revision]);

  async function readFile(picked: File | undefined) {
    setError(""); setMessage(""); setPreview(null); setFile(null); setMapping({}); setMatches({});
    const version = ++generation.current;
    if (!picked) return;
    if (!/\.(csv|xlsx)$/i.test(picked.name) || picked.size <= 0 || picked.size > 3 * 1024 * 1024) {
      setError("Choose a non-empty CSV or XLSX file up to 3 MB. The initial release accepts at most 200 screening rows per import.");
      return;
    }
    setBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Could not read the selected file."));
        reader.onload = () => {
          if (typeof reader.result !== "string") return reject(new Error("Could not read the selected file."));
          resolve(reader.result.slice(reader.result.indexOf(",") + 1));
        };
        reader.readAsDataURL(picked);
      });
      const result = await previewSalesImport({ theaterKey, fileName: picked.name, fileBase64: base64 });
      if (version !== generation.current) return;
      setFile({ name: picked.name, base64 }); setPreview(result.data); setMapping(result.data.mapping);
    } catch (cause) { if (version === generation.current) setError(salesErrorMessage(cause)); }
    finally { if (version === generation.current) setBusy(false); }
  }

  async function validate() {
    if (!file) return;
    setBusy(true); setError(""); setMessage(""); setPreview(current => current ? { ...current, draftId: null } : null);
    try {
      const result = await previewSalesImport({ theaterKey, fileName: file.name, fileBase64: file.base64, mapping, movieMatches: matches });
      setPreview(result.data);
    } catch (cause) { setError(salesErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function confirm() {
    if (!preview?.draftId) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await confirmSalesImport({ theaterKey, draftId: preview.draftId });
      setMessage(`Confirmed ${result.data.rowCount} screening records. Source rows and import history were retained.`);
      setPreview(null); setFile(null); setMatches({}); setRevision(value => value + 1); onImported();
    } catch (cause) { setError(salesErrorMessage(cause)); }
    finally { setBusy(false); }
  }
  function invalidateDraft() { setPreview(current => current ? { ...current, draftId: null } : null); }
  async function loadMore() {
    setBusy(true); setHistoryError("");
    try {
      const result = await listSalesImports({ theaterKey, cursor: nextCursor });
      setImports(current => [...current, ...result.data.imports]); setNextCursor(result.data.nextCursor);
    } catch (cause) { setHistoryError(salesErrorMessage(cause)); }
    finally { setBusy(false); }
  }

  const movieTitles = preview && mapping.movieTitle
    ? [...new Set(preview.rows.map(row => String(row.raw[mapping.movieTitle] ?? "").trim()).filter(Boolean))]
    : [];

  return <div className="min-w-0 space-y-6">
    <section className={cardClass}>
      <p className="text-xs font-semibold uppercase tracking-widest text-orange-200">Data foundation</p>
      <h2 className="mt-2 font-display text-2xl text-ink">Import actual screening sales</h2>
      <p className="mt-3 text-sm leading-relaxed text-ink-soft">Upload, map columns, confirm movie identities, review every row, then explicitly confirm. Invalid or duplicate rows are never silently skipped. Correct the source file and re-upload before confirming.</p>
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">USD only. One screening per row; at most 200 rows / 3 MB. Missing paid tickets, capacity, or revenue stays unknown. Existing PDF uploads remain separate and are not automatically interpreted as ticket sales.</p>
      <label className="mt-5 block text-sm text-ink">CSV or XLSX source file
        <input type="file" accept=".csv,.xlsx" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} className="mt-2 block w-full min-w-0 text-sm text-ink-soft file:mr-3 file:rounded-full file:border-0 file:bg-violet-400 file:px-4 file:py-2.5 file:font-semibold file:text-slate-950" />
      </label>
      <button type="button" className="mt-4 text-sm text-violet-300 hover:underline" onClick={() => downloadCsv("reelsuccess-sales-template.csv", [importFields.map(([key]) => key)])}>Download blank CSV template</button>
      {busy && <p role="status" className="mt-3 text-sm text-ink-soft">Processing import...</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
      {message && <p role="status" className="mt-3 text-sm text-emerald">{message}</p>}
    </section>
    {preview && <>
      <section className={cardClass}>
        <h3 className="font-display text-xl text-ink">1. Map source columns</h3>
        <p className="mt-2 text-sm text-ink-soft">Required fields are marked *. Dates must use YYYY-MM-DD and start times HH:MM. Monetary values are dollars, not cents.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {importFields.map(([field, label, required]) => <label key={field} className="flex min-w-0 flex-col gap-1 text-xs text-ink-soft">{label}{required ? " *" : ""}
            <select className={inputClass} disabled={busy} value={mapping[field] || ""} onChange={event => {
              setMapping(current => ({ ...current, [field]: event.target.value })); invalidateDraft(); setMatches({});
            }}><option value="">Not supplied</option>{preview.headers.map(header => <option key={header} value={header}>{header}</option>)}</select>
          </label>)}
        </div>
      </section>
      <section className={cardClass}>
        <h3 className="font-display text-xl text-ink">2. Confirm canonical movie matches</h3>
        <p className="mt-2 text-sm text-ink-soft">Movie titles alone can be ambiguous. Search TMDB and choose the correct film and release year. Changing title mappings requires revalidation.</p>
        <div className="mt-4 space-y-4">{movieTitles.map(title => <MovieMatcher key={title} title={title} match={matches[title]} disabled={busy} onMatch={match => {
          setMatches(current => ({ ...current, [title]: match })); invalidateDraft();
        }} />)}</div>
        <button type="button" disabled={busy || !file} className={`mt-5 ${buttonClass}`} onClick={validate}>Validate mapped rows and matches</button>
      </section>
      <section className={cardClass}>
        <h3 className="font-display text-xl text-ink">3. Review and confirm</h3>
        <p className="mt-2 text-sm text-ink-soft">{preview.counts.total} rows / {preview.counts.valid} valid / {preview.counts.invalid} invalid / {preview.counts.duplicates} duplicates</p>
        {preview.warnings.map((warning, index) => <p key={index} className="mt-2 text-sm text-orange-200">{warning}</p>)}
        <div className="mt-4 max-h-96 overflow-auto">
          <table className="w-full min-w-[650px] text-left text-xs">
            <caption className="sr-only">All source rows and validation findings</caption>
            <thead><tr>{["Source row", "Raw source", "Normalized screening", "Errors / warnings"].map(label => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
            <tbody>{preview.rows.map(row => <tr key={row.rowNumber} className="border-t border-line">
              <td className="p-2">{row.rowNumber}</td><td className="max-w-60 break-all p-2">{JSON.stringify(row.raw)}</td>
              <td className="p-2">{row.record ? `${row.record.movieTitle} / ${row.record.screeningDate} ${row.record.startTime}; paid ${number(row.record.ticketsSold)}; gross ${money(row.record.grossRevenueCents)}` : "Needs correction"}</td>
              <td className="max-w-60 p-2">{row.errors.map((issue, index) => <p key={`e${index}`} className="text-red-300">{issue}</p>)}{row.warnings.map((issue, index) => <p key={`w${index}`} className="text-orange-200">{issue}</p>)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="mt-4 text-xs text-ink-soft">Confirm is enabled only after server validation succeeds. No rows are excluded, existing sales are not overwritten, and duplicate checks run again on confirmation.</p>
        <button type="button" disabled={busy || !preview.draftId || preview.counts.valid !== preview.counts.total || preview.counts.invalid > 0 || preview.counts.duplicates > 0 || !preview.counts.total} onClick={confirm} className={`mt-4 ${buttonClass}`}>Confirm import of {preview.counts.total} screenings</button>
      </section>
    </>}
    <section className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-display text-xl text-ink">Confirmed import history</h3><button type="button" onClick={() => setRevision(value => value + 1)} className="text-sm text-violet-300">Refresh history</button></div>
      {historyError && <p role="alert" className="mt-3 text-sm text-red-300">{historyError}</p>}
      {historyLoading && <p role="status" className="mt-3 text-sm text-ink-soft">Loading import history...</p>}
      {!imports.length && !historyError && !historyLoading && <p className="mt-3 text-sm text-ink-soft">No confirmed imports yet.</p>}
      <ul className="mt-4 space-y-3">{imports.map(batch => <li className="rounded-xl border border-line p-4" key={batch.id}>
        <p className="break-all text-sm font-semibold text-ink">{batch.fileName}</p><p className="mt-1 text-xs text-ink-soft">{batch.rowCount} screenings / {new Date(batch.importedAt).toLocaleString()} / {batch.source}</p>
        <p className="mt-1 break-all text-xs text-ink-soft">Batch: {batch.id}</p>
      </li>)}</ul>
      {nextCursor && <button type="button" disabled={busy} onClick={loadMore} className={`mt-4 ${buttonClass}`}>Load more imports</button>}
    </section>
  </div>;
}

function MovieMatcher({ title, match, disabled, onMatch }: {
  title: string; match?: MovieMatch; disabled: boolean; onMatch: (match: MovieMatch) => void;
}) {
  const [query, setQuery] = useState(title);
  const [results, setResults] = useState<MovieSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function search() {
    if (query.trim().length < 2) { setError("Enter at least two characters."); return; }
    setLoading(true); setError("");
    try {
      const found = await searchMoviesByQuery(query, 12);
      setResults(found);
      if (!found.length) setError("No movie matches found. Correct the title or try another query.");
    } catch (cause) { setError(salesErrorMessage(cause)); }
    finally { setLoading(false); }
  }
  return <div className="rounded-xl border border-line p-4">
    <p className="text-sm font-semibold text-ink">Source title: {title}</p>
    {match && <p className="mt-1 text-xs text-emerald">Confirmed: {match.title} {match.releaseYear || ""} ({match.movieId})</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <label className="min-w-0 flex-1"><span className="sr-only">Search canonical movie for {title}</span><input className={`w-full ${inputClass}`} value={query} onChange={event => setQuery(event.target.value)} disabled={disabled || loading} /></label>
      <button type="button" onClick={search} disabled={disabled || loading} className="rounded-full border border-line px-4 py-2 text-sm text-violet-300">{loading ? "Searching..." : "Search movies"}</button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    <div className="mt-3 grid gap-2 sm:grid-cols-2">{results.map(result => <button type="button" key={result.tmdbId} disabled={disabled} className="flex items-center gap-3 rounded-xl border border-line p-3 text-left hover:border-violet-400" onClick={() => {
      onMatch({ movieId: `tmdb:${result.tmdbId}`, title: result.title, ...(result.releaseDate ? { releaseYear: Number(result.releaseDate.slice(0, 4)) } : {}) });
      setResults([]);
    }}>
      {result.poster && <img src={result.poster} alt="" loading="lazy" className="h-16 w-11 rounded object-cover" />}
      <span className="text-sm text-ink">{result.title}<span className="block text-xs text-ink-soft">{result.releaseDate?.slice(0, 4) || "Year unavailable"} / TMDB {result.tmdbId}</span></span>
    </button>)}</div>
  </div>;
}
