# ReelSuccess sales data foundation (Milestone 1)

This module is intentionally separate from the legacy ReelSuccess recommendation
pipeline. It does not import, infer admissions from, or modify legacy screening
counts. Only records uploaded and confirmed through this sales workflow contribute
to sales analytics.

## Callable integration

`functions/reelsuccess-sales.js` exports `createSalesApi(deps)`. The parent
callable module can register its results with:

```js
Object.assign(exports, createSalesApi({
  db,
  admin,
  onCall,
  HttpsError,
  assertReelSuccessRequester,
  assertTheaterScope,
}));
```

All four callables require a signed-in Firebase token with a non-empty `email`.
The token email is checked before invoking the ReelSuccess access helper; an
email supplied in request data is never used for authorization. Every operation
is scoped by `assertTheaterScope`.

### Preview

`reelSuccessPreviewSalesImport` accepts:

```ts
{
  theaterKey: string;
  fileName: string;
  fileBase64: string;
  mapping?: Record<string, string>;
  movieMatches?: Record<string, {
    movieId: `tmdb:${number}`;
    title: string;
    releaseYear?: number;
  }>;
}
```

Only `.csv` and `.xlsx` files are accepted (3 MiB maximum, 200 data records
maximum). Oversized files/record sets are rejected before staging; rows are
never silently truncated. A request without a mapping returns header-based
mapping suggestions and does not validate or import rows. A mapped preview
validates every row. Each distinct input movie title needs a manually selected
TMDB candidate; the server validates the candidate shape and positive integer
TMDB ID, and stores the canonical ID as `tmdb:<id>`. This module does not search
TMDB or trust client-supplied normalized records.
Canonical camelCase headers in the blank template are recognized, and empty
mapping strings are treated as omitted fields.

Response:

```ts
{
  draftId: string | null;
  headers: string[];
  mapping: Record<string, string>;
  rows: Array<{
    rowNumber: number;
    raw: Record<string, unknown>;
    record: SalesRecord | null;
    errors: string[];
    warnings: string[];
  }>;
  movieTitles: string[];
  counts: { total: number; valid: number; invalid: number; duplicates: number };
  warnings: string[];
}
```

Canonical mapping keys are `movieTitle`, `screeningDate`, `startTime`,
`auditorium`, `capacity`, `ticketsSold`, `complimentaryTickets`, `grossRevenue`,
`ticketPrice`, `screeningType`, `genre`, `releaseYear`, `runtimeMinutes`, and
optional `currency`. Monetary input fields are dollar amounts with at most two
decimal places and are stored as integer cents. Currency is USD only. Blank
sales values stay `null`; they are not converted to zero. Dates must be real
`YYYY-MM-DD` dates. Times must be 24-hour `HH:mm` or `HH:mm:ss` values (stored
as `HH:mm`). Count fields must be nonnegative integers. Paid attendance cannot
exceed capacity, and paid plus complimentary attendance cannot exceed capacity
when those values are known.

### Confirmation

`reelSuccessConfirmSalesImport` accepts `{theaterKey, draftId}` only. It reads
the server-staged draft and row subdocuments in a transaction; normalized data
is never accepted from the client. Confirmation is all-or-nothing. Any invalid,
unmatched, or duplicate row rejects the entire import. Already imported
screening identities are never overwritten. Retrying a confirmed draft is
idempotent.

### Analytics

`reelSuccessGetSalesAnalytics` accepts:

```ts
{
  theaterKey: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  filters?: {
    genre?: string;
    releaseYear?: number;
    decade?: number;
    screeningType?: string;
    weekday?: number; // Sunday 0 through Saturday 6, UTC calendar date
    startTime?: string;
  };
}
```

The callable queries only the selected date range, using the
`salesScreenings.screeningDate` single-field index, and errors if the period
contains more than 2,000 records. All supplied filters are applied to the
selected-period records before every metric is calculated. `filterOptions`
(`genres`, `releaseYears`, `screeningTypes`, and `startTimes`) are derived from
the unfiltered period records so the UI can offer choices independent of its
current filters.

Response:

```ts
{
  period: { startDate: string; endDate: string };
  currency: "USD";
  summary: {
    screenings: number;
    paidAdmissions: number | null;
    grossRevenueCents: number | null;
    averageTickets: number | null;
    averageOccupancy: number | null;
  };
  coverage: { paidAdmissions: number; revenue: number; capacity: number };
  movies: MovieMetrics[];
  trend: Array<{
    date: string;
    paidAdmissions: number | null;
    grossRevenueCents: number | null;
    screenings: number;
  }>;
  screenings: SalesRecord[];
  warnings: string[];
  lastImportedAt: string | null;
  definitions: Record<string, string>;
  methodology: string;
  filterOptions: {
    genres: string[];
    releaseYears: number[];
    screeningTypes: string[];
    startTimes: string[];
  };
}

type MovieMetrics = {
  movieId: string;
  title: string;
  releaseYear: number | null;
  genre: string | null;
  runtimeMinutes: number | null;
  screenings: number;
  paidAdmissions: number | null;
  grossRevenueCents: number | null;
  averageTickets: number | null;
  averageOccupancy: number | null;
  revenuePerScreeningCents: number | null;
  averageTicketPriceCents: number | null;
  performanceIndex: number | null;
  baselineCount: number;
  baselineScreeningKeys: string[];
  expectedPaidAdmissions: number | null;
  indexReason: string;
};
```

`averageOccupancy` is weighted paid occupancy: known paid admissions divided
by their paired known capacities; complimentary tickets are excluded. Movie
`averageTickets` uses only screenings with known paid admissions.
`averageTicketPriceCents` is a paid-admission-weighted mean of explicitly
reported ticket prices, using only rows with both values known.
`revenuePerScreeningCents` divides known revenue by the number of screenings
with known revenue. Missing values are excluded from those calculations, with
coverage counts provided; a metric is `null` when it has no usable data.
Partial-data warnings report paid-admissions, revenue, and capacity coverage,
as well as the exact number of rows with both paid admissions and capacity
that contribute to weighted occupancy.

`performanceIndex` is only calculated for movies with at least three screenings
where every target row has known paid admissions, positive capacity, and an
explicit positive ticket price. Every target row independently needs at least
five other-film screenings from at least two other canonical films, matching
exact capacity, ticket price, weekday, start time, calendar month, and
screening type in the selected theater, period, and filters. Expected paid
admissions sum each target row's mean admissions among its matched peers; the
index is target paid admissions divided by that expected total. The response
includes the union of unique peer keys as `baselineScreeningKeys`
(`{importBatchId}:{rowNumber}`), plus `baselineCount`,
`expectedPaidAdmissions`, and an explicit `indexReason`. Insufficient
comparables, missing target inputs, and a zero baseline withhold the index.
This leave-one-film-out metric is descriptive evidence for the selected period
only; it makes no causal or forecast claim.

### Import history

`reelSuccessListSalesImports` accepts `{theaterKey, limit?, cursor?}`. Pages
contain at most 100 records (25 by default); `nextCursor` is omitted at the end.
Response:

```ts
{
  imports: Array<{
    id: string;
    fileName: string;
    importedAt: string;
    rowCount: number;
    source: "csv" | "xlsx";
  }>;
  nextCursor?: string;
}
```

## Firestore schema

All paths below are scoped to a resolved `theaterId`.

- `theaters/{theaterId}/salesImportDrafts/{draftId}` stores preview metadata,
  mapping, creator, state, and row count.
- `theaters/{theaterId}/salesImportDrafts/{draftId}/rows/{rowNumber}` stores
  each original raw row beside its server-normalized record, validation errors,
  and warnings. This keeps private source data available for audit without
  uploading the source file to public storage.
- `theaters/{theaterId}/salesImports/{draftId}` stores immutable confirmed
  import provenance: filename, timestamp, row count, source, uploader, and
  draft ID.
- `theaters/{theaterId}/salesScreenings/{screeningId}` stores one normalized
  screening. `screeningId` is a SHA-256 identity over theater, canonical movie,
  screening date, normalized start time, and case-insensitive auditorium.

`SalesRecord`:

```ts
{
  movieId: string; // tmdb:<positive integer>
  movieTitle: string;
  screeningDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  auditorium: string;
  capacity: number | null;
  ticketsSold: number | null;
  complimentaryTickets: number | null;
  grossRevenueCents: number | null;
  ticketPriceCents: number | null;
  screeningType: string;
  genre: string | null;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  source: "csv" | "xlsx";
  importBatchId: string;
  rowNumber: number;
}
```

Screening analytics use a date-range query ordered by the single field
`screeningDate`; no collection-group query or legacy dataset index is needed.
Existing Firebase security rules should continue to deny direct client writes
to these collections; all mutations are performed by the callable backend.

## Validation

From the repository root, run:

```sh
npm --prefix functions test
```

Frontend validation:

```sh
cd web
npm run build
npm run test:sales
npx tsc --noEmit --pretty false
```

For the local browser preview, run `npm --prefix web run dev -- --host
127.0.0.1 --port 4327` and open `http://localhost:4327/reelsuccess/`.
Use the `localhost` hostname: it is in the Firebase project's authorized
OAuth domains, whereas `127.0.0.1` is not. Binding the server to the loopback
address does not require using that IP address in the browser URL.
The dashboard initializes on page load, including when an integrated browser
tab starts hidden. Sign in with an authorized Google account; access controls
are not bypassed for localhost. The current client configuration uses deployed
Firebase services, not local emulators. Running Astro alone does not start
the new sales callables: imports and analytics need a separately configured
backend environment with those functions deployed.

## Milestone 1 workspace and verification

The existing `/reelsuccess/` route now opens Overview, with Movie Performance
and Data & Imports alongside the preserved discovery and PDF-upload workflows.
It reuses the existing sign-in, access synchronization, and theater picker.
Partner accounts retain their existing single-theater assignment; administrators
retain the theater selector. This release does not introduce multi-venue grants.

Overview and Movie Performance provide period presets, source coverage,
reported admissions/revenue, weighted paid occupancy, movie comparisons,
screening-level filters, daily trends, and inspectable source and baseline
records. CSV exports include theater, period, filters, generation time,
definitions, coverage, and caveats. Imports require column review, explicit
TMDB selection, server validation, and confirmation. Currency is USD only.

Verified locally:

- Backend: 16 passing tests, covering CSV/XLSX parsing, normalization, missing
  versus zero sales, identities, duplicate protection, idempotent confirmation,
  authorization, filters, and supported/withheld performance indices.
- Frontend: 3 passing CSV-export tests; production Astro build succeeds.
- Browser: actual components with isolated synthetic callable responses at
  390, 768, and 1440 pixels; baseline evidence, movie comparisons, empty/error
  states, mapping changes, and blocked unvalidated confirmation checked.
  Desktop/mobile screenshots were displayed inline; these are synthetic
  validation evidence, not actual theater results.
- Full TypeScript checking still reports 11 existing errors in
  `web/src/components/CampaignExplorer.tsx`; no errors in the new sales files.
  The shared navigation has pre-existing horizontal overflow at 768 pixels;
  the sales workspace itself stays within the viewport.

### Remaining launch work and limits

No functions, hosting, rules, or production data were deployed or migrated.
Backend persistence tests use an in-memory Firestore double, not a live or
emulated Firebase integration. Before launch, exercise authenticated imports,
concurrent confirmation, denied cross-theater access, and history pagination
against a staging Firebase environment.

The initial limits are 200 records / 3 MiB per import and 2,000 screenings per
analytics period; larger requests fail explicitly and require smaller files
or narrower periods. Drafts retain original parsed rows, not original file
bytes. Draft retention/cleanup and corrections to confirmed imports are not
implemented. XLSX uploads require a single populated, values-only sheet.
TMDB candidate identities are manually selected; the backend validates their
shape but does not independently retrieve their metadata.

Legacy weekly PDF/movie-presence data cannot reliably become screening-level
paid sales, so it remains separate rather than undergoing a fabricated sales
migration. Recommendations with decision tracking, demand conversion,
forecasts, scheduling, and AI assistance remain later milestones.
