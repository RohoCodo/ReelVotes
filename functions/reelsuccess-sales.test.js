"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const {
  createSalesApi,
  parseSalesFile,
  suggestMapping,
  validateMapping,
  normalizeSalesRow,
  screeningIdentity,
  validateMovieMatches,
  calculateAnalytics,
  matchesFilters,
} = require("./reelsuccess-sales");

const mapping = {
  movieTitle: "Movie",
  screeningDate: "Date",
  startTime: "Time",
  auditorium: "Screen",
  capacity: "Capacity",
  ticketsSold: "Tickets",
  complimentaryTickets: "Comps",
  grossRevenue: "Gross",
  ticketPrice: "Price",
  screeningType: "Type",
  genre: "Genre",
  releaseYear: "Year",
  runtimeMinutes: "Runtime",
};

function row(values = {}) {
  return {
    Movie: "Example Film",
    Date: "2025-01-03",
    Time: "19:30",
    Screen: "1",
    Capacity: "100",
    Tickets: "70",
    Comps: "5",
    Gross: "700.00",
    Price: "10.00",
    Type: "standard",
    Genre: "Drama",
    Year: "2020",
    Runtime: "110",
    ...values,
  };
}

test("CSV parsing preserves quoted cells, header suggestions, and source row numbers", async () => {
  const parsed = await parseSalesFile(
    "csv",
    Buffer.from('Movie Title,Screening Date,Start Time,Auditorium,Gross Revenue\n"Film, One",2025-01-03,19:30,1,1.25\n'),
  );
  assert.deepEqual(parsed.headers, ["Movie Title", "Screening Date", "Start Time", "Auditorium", "Gross Revenue"]);
  assert.equal(parsed.rows[0].raw["Movie Title"], "Film, One");
  assert.equal(parsed.rows[0].rowNumber, 2);
  assert.deepEqual(suggestMapping(parsed.headers), {
    movieTitle: "Movie Title",
    screeningDate: "Screening Date",
    startTime: "Start Time",
    auditorium: "Auditorium",
    grossRevenue: "Gross Revenue",
  });
});

test("CSV source row numbers account for blank lines and multiline fields", async () => {
  const parsed = await parseSalesFile(
    "csv",
    Buffer.from('Movie,Date\n\n"Film\nOne",2025-01-03\nLast,2025-01-04\n'),
  );
  assert.equal(parsed.rows[0].rowNumber, 3);
  assert.equal(parsed.rows[0].raw.Movie, "Film\nOne");
  assert.equal(parsed.rows[1].rowNumber, 5);
});

test("canonical camelCase headers are suggested and empty mappings are omitted", () => {
  const headers = [
    "movieTitle", "screeningDate", "startTime", "auditorium", "capacity", "ticketsSold",
    "complimentaryTickets", "grossRevenue", "ticketPrice", "screeningType", "genre",
    "releaseYear", "runtimeMinutes",
  ];
  assert.deepEqual(suggestMapping(headers), Object.fromEntries(headers.map((header) => [header, header])
    .map(([key, value]) => [key, value])));
  assert.deepEqual(validateMapping({
    movieTitle: "movieTitle",
    screeningDate: "",
    startTime: "",
    auditorium: "auditorium",
  }, headers), {movieTitle: "movieTitle", auditorium: "auditorium"});
});

test("imports over 200 records fail explicitly without truncating", async () => {
  const csv = ["Movie,Date", ...Array.from({length: 201}, (_, index) => `Film ${index},2025-01-03`)].join("\n");
  await assert.rejects(parseSalesFile("csv", Buffer.from(csv)), (error) =>
    error.code === "resource-exhausted" && /maximum is 200/.test(error.message));
});

test("XLSX parsing accepts date and time cells and emits ISO sales values", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sales");
  sheet.addRow(["Movie", "Date", "Time", "Screen", "Type"]);
  sheet.addRow([]);
  const salesRow = sheet.addRow([
    "Example Film",
    new Date("2025-01-03T00:00:00.000Z"),
    new Date("1899-12-30T19:30:00.000Z"),
    "1",
    "standard",
  ]);
  salesRow.getCell(2).numFmt = "yyyy-mm-dd";
  salesRow.getCell(3).numFmt = "hh:mm";
  const parsed = await parseSalesFile("xlsx", await workbook.xlsx.writeBuffer());
  const result = normalizeSalesRow(parsed.rows[0].raw, {
    movieTitle: "Movie",
    screeningDate: "Date",
    startTime: "Time",
    auditorium: "Screen",
    screeningType: "Type",
  }, {"example film": {movieId: "tmdb:123", title: "Example Film"}}, {
    source: "xlsx",
    importBatchId: "draft",
    rowNumber: parsed.rows[0].rowNumber,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(parsed.rows[0].rowNumber, 3);
  assert.equal(result.record.screeningDate, "2025-01-03");
  assert.equal(result.record.startTime, "19:30");
});

test("XLSX with multiple nonempty sheets is explicitly rejected", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("First").addRow(["Movie", "Date"]);
  workbook.addWorksheet("Second").addRow(["Movie", "Date"]);
  await assert.rejects(parseSalesFile("xlsx", await workbook.xlsx.writeBuffer()), /multiple nonempty worksheets/);
});

test("XLSX formula and error cells are rejected instead of becoming blank values", async () => {
  for (const [value, message] of [
    [{formula: "1+1", result: 2}, /formula cells/],
    [{error: "#DIV/0!"}, /error cells/],
  ]) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sales");
    sheet.addRow(["Movie", "Gross"]);
    sheet.addRow(["Film", value]);
    await assert.rejects(parseSalesFile("xlsx", await workbook.xlsx.writeBuffer()), message);
  }
});

test("normalization strictly validates dates, times, counts, cents, and capacity", () => {
  const matches = {"example film": {movieId: "tmdb:123", title: "Example Film", releaseYear: 2020}};
  const result = normalizeSalesRow(row(), mapping, matches, {
    source: "csv",
    importBatchId: "draft",
    rowNumber: 2,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.record.grossRevenueCents, 70000);
  assert.equal(result.record.ticketPriceCents, 1000);
  assert.equal(result.record.movieId, "tmdb:123");
  assert.equal(result.record.rowNumber, 2);

  const invalid = normalizeSalesRow(row({
    Date: "2025-02-30",
    Time: "25:61",
    Tickets: "1.5",
    Gross: "-1",
    Capacity: "2",
    Comps: "2",
  }), mapping, matches, {source: "csv", importBatchId: "draft", rowNumber: 3});
  assert.equal(invalid.record, null);
  assert.ok(invalid.errors.some((error) => error.includes("ISO YYYY-MM-DD")));
  assert.ok(invalid.errors.some((error) => error.includes("24-hour ISO time")));
  assert.ok(invalid.errors.some((error) => error.includes("nonnegative integer")));
  assert.ok(invalid.errors.some((error) => error.includes("dollar amount")));

  const compsOverCapacity = normalizeSalesRow(row({
    Tickets: "",
    Comps: "11",
    Capacity: "10",
  }), mapping, matches, {source: "csv", importBatchId: "draft", rowNumber: 4});
  assert.ok(compsOverCapacity.errors.some((error) => error.includes("Complimentary admissions exceed capacity")));
});

test("missing and reported-zero sales remain distinct nullable values", () => {
  const matches = {"example film": {movieId: "tmdb:123", title: "Example Film"}};
  const missing = normalizeSalesRow(row({
    Capacity: "",
    Tickets: "",
    Comps: "",
    Gross: "",
    Price: "",
  }), mapping, matches, {source: "csv", importBatchId: "draft", rowNumber: 2});
  assert.deepEqual(missing.errors, []);
  assert.equal(missing.record.capacity, null);
  assert.equal(missing.record.ticketsSold, null);
  assert.equal(missing.record.grossRevenueCents, null);
  assert.equal(missing.record.ticketPriceCents, null);

  const zero = normalizeSalesRow(row({
    Capacity: "0",
    Tickets: "0",
    Comps: "0",
    Gross: "0.00",
    Price: "0.00",
  }), mapping, matches, {source: "csv", importBatchId: "draft", rowNumber: 3});
  assert.deepEqual(zero.errors, []);
  assert.equal(zero.record.capacity, 0);
  assert.equal(zero.record.ticketsSold, 0);
  assert.equal(zero.record.grossRevenueCents, 0);
  assert.equal(zero.record.ticketPriceCents, 0);
});

test("unmatched titles and malformed TMDB IDs cannot create records", () => {
  const unmatched = normalizeSalesRow(row(), mapping, {}, {
    source: "csv",
    importBatchId: "draft",
    rowNumber: 2,
  });
  assert.equal(unmatched.record, null);
  assert.ok(unmatched.errors.some((error) => error.includes("manually confirmed TMDB match")));
  assert.throws(() => validateMovieMatches({
    "Example Film": {movieId: "123", title: "Example Film"},
  }), /Invalid manually selected TMDB match/);
  assert.deepEqual(validateMovieMatches({
    Film: {movieId: "tmdb:123", title: "Film", releaseYear: 2020},
    film: {movieId: "tmdb:123", title: " film ", releaseYear: 2020},
  }), {
    film: {movieId: "tmdb:123", title: "Film", releaseYear: 2020},
  });
  assert.throws(() => validateMovieMatches({
    Film: {movieId: "tmdb:123", title: "Film", releaseYear: 2020},
    film: {movieId: "tmdb:456", title: "Film", releaseYear: 2020},
  }), /ambiguous/);
});

test("screening identity is stable for the same theater, canonical movie, and slot", () => {
  const record = {
    movieId: "tmdb:123",
    screeningDate: "2025-01-03",
    startTime: "19:30",
    auditorium: "Main 1",
  };
  assert.equal(screeningIdentity("theater-a", record), screeningIdentity("theater-a", {...record, auditorium: " main 1 "}));
  assert.notEqual(screeningIdentity("theater-a", record), screeningIdentity("theater-b", record));
});

test("analytics preserve missing values, weight occupancy and prices, and withhold the index", () => {
  const records = [
    {movieId: "tmdb:1", movieTitle: "One", screeningDate: "2025-01-03", ticketsSold: 20, capacity: 100, grossRevenueCents: 20000, ticketPriceCents: 1000, screeningType: "standard"},
    {movieId: "tmdb:1", movieTitle: "One", screeningDate: "2025-01-10", ticketsSold: 60, capacity: 100, grossRevenueCents: null, ticketPriceCents: 1500, screeningType: "standard"},
    {movieId: "tmdb:2", movieTitle: "Two", screeningDate: "2025-01-10", ticketsSold: null, capacity: 100, grossRevenueCents: null, ticketPriceCents: null, screeningType: "event"},
  ];
  const calculated = calculateAnalytics(records);
  assert.equal(calculated.summary.paidAdmissions, 80);
  assert.equal(calculated.summary.grossRevenueCents, 20000);
  assert.equal(calculated.summary.averageOccupancy, 80 / 200);
  assert.equal(calculated.coverage.paidAdmissions, 2);
  assert.equal(calculated.movies.find((movie) => movie.movieId === "tmdb:2").paidAdmissions, null);
  assert.equal(calculated.movies.find((movie) => movie.movieId === "tmdb:1").averageTicketPriceCents, 1375);
  assert.equal(calculated.movies[0].performanceIndex, null);
  assert.match(calculated.movies[0].indexReason, /Withheld/);
  assert.equal(matchesFilters(records[0], {weekday: 5}), true);
  assert.equal(matchesFilters(records[0], {weekday: 1}), false);
  assert.match(calculated.warnings[0], /paid admissions reported for 2\/3/);
  assert.match(calculated.warnings[0], /Weighted paid occupancy uses 2\/3 screenings/);
});

function comparableFixture() {
  const targets = ["2025-01-03", "2025-01-04", "2025-01-10"].map((screeningDate, index) => ({
    movieId: "tmdb:target",
    movieTitle: "Target",
    screeningDate,
    startTime: "19:30",
    auditorium: "Target",
    capacity: 100,
    ticketsSold: 60,
    ticketPriceCents: 1000,
    screeningType: "standard",
    importBatchId: "target",
    rowNumber: index + 2,
  }));
  const peers = [];
  let rowNumber = 100;
  for (const screeningDate of ["2025-01-03", "2025-01-04", "2025-01-10"]) {
    for (const [index, ticketsSold] of [20, 40, 20, 40, 30].entries()) {
      peers.push({
        movieId: index % 2 ? "tmdb:peer-2" : "tmdb:peer-1",
        movieTitle: "Peer",
        screeningDate,
        startTime: "19:30",
        auditorium: `Peer ${index}`,
        capacity: 100,
        ticketsSold,
        ticketPriceCents: 1000,
        screeningType: "standard",
        importBatchId: "peers",
        rowNumber: rowNumber++,
      });
    }
  }
  return [...targets, ...peers];
}

test("performance index uses leave-one-film-out exact-context comparables and exposes evidence", () => {
  const rows = comparableFixture();
  rows.push({...rows[0], rowNumber: 5, ticketsSold: 60});
  const target = calculateAnalytics(rows).movies.find((movie) => movie.movieId === "tmdb:target");
  assert.equal(target.performanceIndex, 2);
  assert.equal(target.expectedPaidAdmissions, 120);
  assert.equal(target.baselineCount, 15);
  assert.equal(target.baselineScreeningKeys.length, 15);
  assert.ok(target.baselineScreeningKeys.every((key) => key.startsWith("peers:")));
  assert.match(target.indexReason, /not a causal or predictive/);
});

test("performance index withholds when any target context lacks adequate exact matches", () => {
  const dimensions = [
    ["capacity", 90],
    ["ticketPriceCents", 900],
    ["startTime", "20:00"],
    ["screeningDate", "2025-02-07"],
    ["screeningType", "event"],
  ];
  for (const [field, value] of dimensions) {
    const rows = comparableFixture();
    rows.filter((record) => record.movieId !== "tmdb:target").slice(0, 11)
      .forEach((peer) => {
        peer[field] = value;
      });
    const target = calculateAnalytics(rows).movies.find((movie) => movie.movieId === "tmdb:target");
    assert.equal(target.performanceIndex, null, `${field} mismatch must withhold index`);
    assert.match(target.indexReason, /at least 5 matched other-film screenings/);
  }

  const weekdayRows = comparableFixture();
  weekdayRows.filter((record) => record.movieId !== "tmdb:target").slice(0, 11)
    .forEach((peer) => {
      peer.screeningDate = "2025-01-04";
    });
  assert.equal(calculateAnalytics(weekdayRows).movies.find((movie) =>
    movie.movieId === "tmdb:target").performanceIndex, null);

  const oneContextMissing = comparableFixture();
  oneContextMissing.filter((record) => record.movieId !== "tmdb:target" && record.screeningDate === "2025-01-04")
    .forEach((peer) => {
      peer.startTime = "20:00";
    });
  assert.equal(calculateAnalytics(oneContextMissing).movies.find((movie) =>
    movie.movieId === "tmdb:target").performanceIndex, null);

  const insufficientTargets = comparableFixture().filter((record) =>
    record.movieId !== "tmdb:target" || record.screeningDate !== "2025-01-10");
  assert.equal(calculateAnalytics(insufficientTargets).movies.find((movie) =>
    movie.movieId === "tmdb:target").performanceIndex, null);

  const missingTarget = comparableFixture();
  missingTarget[0].ticketPriceCents = null;
  assert.match(calculateAnalytics(missingTarget).movies.find((movie) =>
    movie.movieId === "tmdb:target").indexReason, /every target screening/);

  const oneOtherMovie = comparableFixture().map((record) =>
    record.movieId === "tmdb:target" ? record : {...record, movieId: "tmdb:peer-1"});
  const oneMovieIndex = calculateAnalytics(oneOtherMovie).movies.find((movie) => movie.movieId === "tmdb:target");
  assert.equal(oneMovieIndex.performanceIndex, null);
  assert.match(oneMovieIndex.indexReason, /at least 5 matched other-film screenings across at least 2 movies/);

  const zeroBaseline = comparableFixture().map((record) =>
    record.movieId === "tmdb:target" ? record : {...record, ticketsSold: 0});
  const zeroIndex = calculateAnalytics(zeroBaseline).movies.find((movie) => movie.movieId === "tmdb:target");
  assert.equal(zeroIndex.performanceIndex, null);
  assert.equal(zeroIndex.expectedPaidAdmissions, 0);
  assert.match(zeroIndex.indexReason, /zero expected paid-admissions baseline/);
});

class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeFirestore() {
  const docs = new Map();
  let autoId = 0;
  const snapshot = (ref) => {
    const data = docs.get(ref.path);
    return {id: ref.id, exists: data !== undefined, data: () => data && structuredClone(data)};
  };
  const makeRef = (path) => ({
    path,
    id: path.split("/").at(-1),
    collection(name) {
      return makeCollection(`${path}/${name}`);
    },
    async get() {
      return snapshot(this);
    },
  });
  const makeCollection = (path) => ({
    path,
    doc(id) {
      return makeRef(`${path}/${id || `auto-${++autoId}`}`);
    },
    where(field, operator, value) {
      const filters = [{field, operator, value}];
      return queryFor(path, filters, []);
    },
    orderBy(field, direction = "asc") {
      return queryFor(path, [], [{field, direction}]);
    },
  });
  const queryFor = (path, filters, orderings, pageLimit = Infinity, startAfter = null) => {
    const query = {
      where(field, operator, value) {
        return queryFor(path, [...filters, {field, operator, value}], orderings, pageLimit, startAfter);
      },
      orderBy(field, direction = "asc") {
        return queryFor(path, filters, [...orderings, {field, direction}], pageLimit, startAfter);
      },
      limit(limit) {
        return queryFor(path, filters, orderings, limit, startAfter);
      },
      startAfter(doc) {
        return queryFor(path, filters, orderings, pageLimit, doc);
      },
      async get() {
        let rows = [...docs.entries()]
          .filter(([docPath]) => docPath.startsWith(`${path}/`) && !docPath.slice(path.length + 1).includes("/"))
          .map(([docPath]) => makeRef(docPath))
          .map((ref) => snapshot(ref));
        rows = rows.filter((entry) => filters.every(({field, operator, value}) => {
          const current = entry.data()[field];
          return operator === ">=" ? current >= value : operator === "<=" ? current <= value : current === value;
        }));
        for (const {field, direction} of [...orderings].reverse()) {
          rows.sort((a, b) => {
            const comparison = a.data()[field] < b.data()[field] ? -1 : a.data()[field] > b.data()[field] ? 1 : 0;
            return direction === "desc" ? -comparison : comparison;
          });
        }
        if (startAfter) {
          const index = rows.findIndex((entry) => entry.id === startAfter.id);
          if (index >= 0) rows = rows.slice(index + 1);
        }
        return {docs: rows.slice(0, pageLimit)};
      },
    };
    return query;
  };
  const db = {
    collection: makeCollection,
    async getAll(...refs) {
      return refs.map(snapshot);
    },
    batch() {
      const writes = [];
      return {
        set(ref, data) {
          writes.push([ref.path, structuredClone(data)]);
        },
        async commit() {
          for (const [path, data] of writes) docs.set(path, data);
        },
      };
    },
    async runTransaction(callback) {
      const writes = [];
      const transaction = {
        async get(ref) {
          return snapshot(ref);
        },
        async getAll(...refs) {
          return refs.map(snapshot);
        },
        create(ref, data) {
          writes.push(["create", ref.path, structuredClone(data)]);
        },
        update(ref, data) {
          writes.push(["update", ref.path, structuredClone(data)]);
        },
      };
      const result = await callback(transaction);
      for (const [operation, path, data] of writes) {
        if (operation === "create" && docs.has(path)) throw new Error("already exists");
        docs.set(path, operation === "update" ? {...docs.get(path), ...data} : data);
      }
      return result;
    },
    docs,
  };
  return db;
}

test("callables require token email, stage server-normalized rows, confirm atomically, and filter metrics", async () => {
  const db = makeFirestore();
  let authHelperCalls = 0;
  const api = createSalesApi({
    db,
    admin: {firestore: {}},
    onCall: (handler) => handler,
    HttpsError,
    assertReelSuccessRequester: async () => {
      authHelperCalls += 1;
      return {uid: "user-1", email: "user@example.test", isAdmin: false, theaterId: "theater-1"};
    },
    assertTheaterScope: (ctx, theaterKey) => {
      assert.equal(theaterKey, "north");
      return {theaterKey: "north", theaterId: ctx.theaterId};
    },
  });
  const csv = [
    "Movie,Date,Time,Screen,Capacity,Tickets,Comps,Gross,Price,Type,Genre,Year,Runtime",
    "Example Film,2025-01-03,19:30,1,100,70,5,700.00,10.00,standard,Drama,2020,110",
    "Example Film,2025-01-10,19:30,1,100,60,2,600.00,10.00,standard,Drama,2020,110",
  ].join("\n");
  const baseRequest = {
    auth: {uid: "user-1", token: {email: "user@example.test"}},
    data: {
      theaterKey: "north",
      fileName: "sales.csv",
      fileBase64: Buffer.from(csv).toString("base64"),
      mapping: {...mapping, movieTitle: "Movie", screeningDate: "Date", startTime: "Time", auditorium: "Screen"},
      movieMatches: {"Example Film": {movieId: "tmdb:123", title: "Example Film", releaseYear: 2020}},
    },
  };
  await assert.rejects(api.reelSuccessPreviewSalesImport({
    ...baseRequest,
    auth: {uid: "user-1", token: {}},
  }), (error) => error.code === "unauthenticated");
  assert.equal(authHelperCalls, 0);

  const suggested = await api.reelSuccessPreviewSalesImport({
    ...baseRequest,
    data: {
      ...baseRequest.data,
      mapping: Object.fromEntries(Object.keys(mapping).map((field) => [field, ""])),
    },
  });
  assert.equal(suggested.counts.total, 2);
  assert.equal(suggested.counts.valid, 0);
  assert.equal(suggested.counts.invalid, 0);
  assert.deepEqual(suggested.mapping.movieTitle, "Movie");
  assert.deepEqual(suggested.rows[0].errors, []);

  const preview = await api.reelSuccessPreviewSalesImport(baseRequest);
  assert.equal(preview.counts.valid, 2);
  assert.equal(preview.counts.invalid, 0);
  assert.equal(preview.rows[0].record.movieId, "tmdb:123");
  const confirmed = await api.reelSuccessConfirmSalesImport({
    auth: baseRequest.auth,
    data: {theaterKey: "north", draftId: preview.draftId},
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.rowCount, 2);
  assert.equal(db.docs.size, 9);
  const repeated = await api.reelSuccessConfirmSalesImport({
    auth: baseRequest.auth,
    data: {theaterKey: "north", draftId: preview.draftId},
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.importId, preview.draftId);
  assert.equal(db.docs.size, 9);

  const result = await api.reelSuccessGetSalesAnalytics({
    auth: baseRequest.auth,
    data: {theaterKey: "north", startDate: "2025-01-01", endDate: "2025-01-31", filters: {weekday: 5}},
  });
  assert.equal(result.summary.screenings, 2);
  assert.equal(result.summary.paidAdmissions, 130);
  assert.deepEqual(result.filterOptions.genres, ["Drama"]);
  assert.equal(result.movies[0].performanceIndex, null);
  const imports = await api.reelSuccessListSalesImports({
    auth: baseRequest.auth,
    data: {theaterKey: "north"},
  });
  assert.equal(imports.imports.length, 1);
  assert.equal(imports.imports[0].rowCount, 2);

  const duplicatePreview = await api.reelSuccessPreviewSalesImport({
    ...baseRequest,
    data: {
      ...baseRequest.data,
      fileBase64: Buffer.from([
        "Movie,Date,Time,Screen,Capacity,Tickets,Comps,Gross,Price,Type,Genre,Year,Runtime",
        "Example Film,2025-02-01,19:30,1,100,70,0,700.00,10.00,standard,Drama,2020,110",
        "Example Film,2025-02-01,19:30,1,100,65,0,650.00,10.00,standard,Drama,2020,110",
      ].join("\n")).toString("base64"),
    },
  });
  assert.equal(duplicatePreview.counts.duplicates, 1);
  assert.equal(duplicatePreview.counts.valid, 1);
  assert.equal(duplicatePreview.counts.invalid, 1);
  await assert.rejects(api.reelSuccessConfirmSalesImport({
    auth: baseRequest.auth,
    data: {theaterKey: "north", draftId: duplicatePreview.draftId},
  }), (error) => error.code === "failed-precondition");
  assert.equal([...db.docs.keys()].filter((path) => path.includes("/salesImports/")).length, 1);

  const stalePreview = await api.reelSuccessPreviewSalesImport({
    ...baseRequest,
    data: {
      ...baseRequest.data,
      fileBase64: Buffer.from([
        "Movie,Date,Time,Screen,Capacity,Tickets,Comps,Gross,Price,Type,Genre,Year,Runtime",
        "Example Film,2025-02-01,19:30,1,100,70,0,700.00,10.00,standard,Drama,2020,110",
      ].join("\n")).toString("base64"),
    },
  });
  const staleRecord = stalePreview.rows[0].record;
  const staleIdentity = screeningIdentity("theater-1", staleRecord);
  db.docs.set(`theaters/theater-1/salesScreenings/${staleIdentity}`, {
    ...staleRecord,
    screeningId: staleIdentity,
  });
  await assert.rejects(api.reelSuccessConfirmSalesImport({
    auth: baseRequest.auth,
    data: {theaterKey: "north", draftId: stalePreview.draftId},
  }), (error) => error.code === "already-exists");
  assert.equal(db.docs.has(`theaters/theater-1/salesImports/${stalePreview.draftId}`), false);
});

test("wrong-theater requests to all four callables reject before database access", async () => {
  let databaseAccesses = 0;
  const db = {
    collection() {
      databaseAccesses += 1;
      throw new Error("Database must not be accessed for an unauthorized theater.");
    },
    getAll() {
      databaseAccesses += 1;
      throw new Error("Database must not be accessed for an unauthorized theater.");
    },
    batch() {
      databaseAccesses += 1;
      throw new Error("Database must not be accessed for an unauthorized theater.");
    },
    runTransaction() {
      databaseAccesses += 1;
      throw new Error("Database must not be accessed for an unauthorized theater.");
    },
  };
  const api = createSalesApi({
    db,
    admin: {firestore: {}},
    onCall: (handler) => handler,
    HttpsError,
    assertReelSuccessRequester: async () => ({
      uid: "user-1",
      email: "user@example.test",
      isAdmin: false,
      theaterId: "theater-1",
    }),
    assertTheaterScope: () => {
      throw new HttpsError("permission-denied", "Wrong theater.");
    },
  });
  const request = {
    auth: {uid: "user-1", token: {email: "user@example.test"}},
    data: {theaterKey: "other"},
  };
  for (const [callable, data] of [
    ["reelSuccessPreviewSalesImport", {
      fileName: "sales.csv",
      fileBase64: Buffer.from("Movie,Date\nFilm,2025-01-03").toString("base64"),
    }],
    ["reelSuccessConfirmSalesImport", {draftId: "draft-1"}],
    ["reelSuccessGetSalesAnalytics", {startDate: "2025-01-01", endDate: "2025-01-31"}],
    ["reelSuccessListSalesImports", {}],
  ]) {
    await assert.rejects(api[callable]({...request, data: {...request.data, ...data}}),
      (error) => error.code === "permission-denied");
  }
  assert.equal(databaseAccesses, 0);
});
