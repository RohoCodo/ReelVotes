"use strict";

const crypto = require("node:crypto");
const {parse: parseCsv} = require("csv-parse/sync");
const ExcelJS = require("exceljs");

const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_IMPORT_ROWS = 200;
const MAX_ANALYTICS_ROWS = 2000;
const MAX_IMPORT_PAGE_SIZE = 100;
const DEFAULT_IMPORT_PAGE_SIZE = 25;
const MAX_STAGED_DOCUMENT_BYTES = 700 * 1024;
const MAX_STAGED_BATCH_BYTES = 8 * 1024 * 1024;

const FIELD_ALIASES = {
  movieTitle: ["movie title", "movie", "film", "title", "movieTitle"],
  screeningDate: ["screening date", "date", "show date", "screeningDate"],
  startTime: ["start time", "screening time", "showtime", "time", "startTime"],
  auditorium: ["auditorium", "screen", "room", "auditorium"],
  capacity: ["capacity", "seats", "auditorium capacity"],
  ticketsSold: ["tickets sold", "paid admissions", "admissions", "tickets", "ticketsSold"],
  complimentaryTickets: ["complimentary tickets", "complimentary", "comps", "complimentaryTickets"],
  grossRevenue: ["gross revenue", "revenue", "box office", "box office revenue", "grossRevenue"],
  ticketPrice: ["ticket price", "average ticket price", "ticketPrice"],
  screeningType: ["screening type", "show type", "type", "screeningType"],
  genre: ["genre"],
  releaseYear: ["release year", "year", "releaseYear"],
  runtimeMinutes: ["runtime minutes", "runtime", "duration", "runtimeMinutes"],
  currency: ["currency"],
};

const REQUIRED_FIELDS = ["movieTitle", "screeningDate", "startTime", "auditorium", "screeningType"];
const MAPPED_FIELDS = new Set(Object.keys(FIELD_ALIASES));

function createSalesApi(deps) {
  const {
    db,
    admin,
    onCall,
    HttpsError,
    assertReelSuccessRequester,
    assertTheaterScope,
  } = deps;
  if (!db || !admin || typeof onCall !== "function" || !HttpsError
    || typeof assertReelSuccessRequester !== "function" || typeof assertTheaterScope !== "function") {
    throw new TypeError("createSalesApi requires db, admin, onCall, HttpsError, and ReelSuccess authorization helpers.");
  }

  const fail = (code, message) => {
    throw new HttpsError(code, message);
  };

  async function authorize(request) {
    const uid = request?.auth?.uid;
    const email = request?.auth?.token?.email;
    if (!uid || typeof email !== "string" || !email.trim()) {
      fail("unauthenticated", "Sign in with an email-bearing account is required.");
    }
    const requester = await assertReelSuccessRequester(request);
    const scoped = assertTheaterScope(requester, request.data?.theaterKey);
    return {requester, ...scoped};
  }

  function collection(theaterId, name) {
    return db.collection("theaters").doc(theaterId).collection(name);
  }

  async function getAll(refs) {
    if (!refs.length) return [];
    if (typeof db.getAll === "function") return db.getAll(...refs);
    return Promise.all(refs.map((ref) => ref.get()));
  }

  async function preview(request) {
    const scope = await authorize(request);
    const {fileName, fileBase64} = request.data || {};
    if (typeof fileName !== "string" || !fileName.trim() || fileName.length > 200
      || /[\\/]/.test(fileName)) {
      fail("invalid-argument", "fileName must be a plain CSV or XLSX filename.");
    }
    const source = fileName.toLowerCase().endsWith(".csv")
      ? "csv"
      : fileName.toLowerCase().endsWith(".xlsx") ? "xlsx" : null;
    if (!source) fail("invalid-argument", "Only CSV and XLSX files are supported.");
    const buffer = decodeBase64(fileBase64, fail);
    const parsed = await parseSalesFile(source, buffer, fail);
    const draftId = collection(scope.theaterId, "salesImportDrafts").doc().id;
    const requestMapping = request.data.mapping;
    const mappingProvided = requestMapping !== undefined && requestMapping !== null
      && (typeof requestMapping !== "object" || Array.isArray(requestMapping)
        || Object.values(requestMapping).some((header) => header !== ""));
    const mapping = mappingProvided
      ? validateMapping(requestMapping, parsed.headers, fail)
      : suggestMapping(parsed.headers);
    const shouldValidate = mappingProvided && Object.keys(mapping).length > 0;
    const movieMatches = validateMovieMatches(request.data.movieMatches, fail);
    const stagedRows = parsed.rows.map(({rowNumber, raw}) => ({
      rowNumber,
      raw,
      record: null,
      errors: [],
      warnings: [],
    }));

    if (shouldValidate) {
      for (const row of stagedRows) {
        const result = normalizeSalesRow(row.raw, mapping, movieMatches, {
          source,
          importBatchId: draftId,
          rowNumber: row.rowNumber,
        });
        row.record = result.record;
        row.errors = result.errors;
        row.warnings = result.warnings;
      }

      const seen = new Set();
      const candidateRows = [];
      for (const row of stagedRows) {
        if (!row.record) continue;
        const identity = screeningIdentity(scope.theaterId, row.record);
        if (seen.has(identity)) {
          row.errors.push("Duplicate screening in this import.");
          continue;
        }
        seen.add(identity);
        candidateRows.push({row, identity});
      }
      const refs = candidateRows.map(({identity}) =>
        collection(scope.theaterId, "salesScreenings").doc(identity));
      const snapshots = await getAll(refs);
      snapshots.forEach((snapshot, index) => {
        if (snapshot.exists) candidateRows[index].row.errors.push("This screening has already been imported.");
      });
    }

    const drafts = collection(scope.theaterId, "salesImportDrafts");
    const draftRef = drafts.doc(draftId);
    const importedAt = new Date();
    const summaryWarnings = [];
    if (!shouldValidate) summaryWarnings.push("Choose or confirm a column mapping, then preview again to validate rows.");
    if (stagedRows.some((row) => row.errors.some((error) => error.includes("TMDB match")))) {
      summaryWarnings.push("Every movie needs a manually confirmed TMDB match before confirmation.");
    }
    let stagedBytes = Buffer.byteLength(JSON.stringify({
      fileName: fileName.trim(),
      source,
      createdBy: scope.requester.uid,
      headers: parsed.headers,
      mapping,
      warnings: summaryWarnings,
    }));
    if (stagedBytes > MAX_STAGED_DOCUMENT_BYTES) {
      fail("resource-exhausted", "The import headers exceed the private draft document size limit.");
    }
    for (const row of stagedRows) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row));
      if (rowBytes > MAX_STAGED_DOCUMENT_BYTES) {
        fail("resource-exhausted", `Row ${row.rowNumber} is too large to stage safely.`);
      }
      stagedBytes += rowBytes;
    }
    if (stagedBytes > MAX_STAGED_BATCH_BYTES) {
      fail("resource-exhausted", "The parsed rows exceed the private staging request size limit.");
    }
    const batch = db.batch();
    batch.set(draftRef, {
      fileName: fileName.trim(),
      source,
      createdAt: importedAt,
      createdBy: scope.requester.uid,
      status: "preview",
      rowCount: stagedRows.length,
      headers: parsed.headers,
      mapping,
      mappingConfirmed: shouldValidate,
      rowNumbers: stagedRows.map((row) => row.rowNumber),
      warnings: summaryWarnings,
    });
    for (const row of stagedRows) {
      batch.set(draftRef.collection("rows").doc(String(row.rowNumber).padStart(4, "0")), row);
    }
    await batch.commit();

    const duplicates = stagedRows.filter((row) => row.errors.some((error) => error.startsWith("Duplicate screening")
      || error.startsWith("This screening"))).length;
    const valid = shouldValidate ? stagedRows.filter((row) => row.record && row.errors.length === 0).length : 0;
    const invalid = shouldValidate ? stagedRows.length - valid : 0;
    return {
      draftId,
      headers: parsed.headers,
      mapping,
      rows: stagedRows,
      movieTitles: [...new Set(stagedRows.map((row) => mappedText(row.raw, mapping.movieTitle)).filter(Boolean))],
      counts: {total: stagedRows.length, valid, invalid, duplicates},
      warnings: summaryWarnings,
    };
  }

  async function confirm(request) {
    const scope = await authorize(request);
    const draftId = request.data?.draftId;
    if (typeof draftId !== "string" || !/^[A-Za-z0-9_-]{1,150}$/.test(draftId)) {
      fail("invalid-argument", "draftId is required.");
    }
    const drafts = collection(scope.theaterId, "salesImportDrafts");
    const imports = collection(scope.theaterId, "salesImports");
    const screenings = collection(scope.theaterId, "salesScreenings");
    const draftRef = drafts.doc(draftId);
    const importRef = imports.doc(draftId);
    return db.runTransaction(async (transaction) => {
      const draftSnapshot = await transaction.get(draftRef);
      if (!draftSnapshot.exists) fail("not-found", "Sales import draft was not found.");
      const draft = draftSnapshot.data();
      if (draft.status === "confirmed") {
        return {ok: true, importId: draft.importId || draftId, rowCount: draft.rowCount, importedAt: isoDate(draft.importedAt)};
      }
      if (!draft.mappingConfirmed || !Number.isInteger(draft.rowCount) || draft.rowCount < 1
        || draft.rowCount > MAX_IMPORT_ROWS || !Array.isArray(draft.rowNumbers)
        || draft.rowNumbers.length !== draft.rowCount
        || draft.rowNumbers.some((rowNumber) => !Number.isInteger(rowNumber) || rowNumber < 2)
        || new Set(draft.rowNumbers).size !== draft.rowCount) {
        fail("failed-precondition", "Preview and validate the complete import before confirming.");
      }
      const rowRefs = draft.rowNumbers.map((rowNumber) =>
        draftRef.collection("rows").doc(String(rowNumber).padStart(4, "0")));
      const rowSnapshots = await transactionGetAll(transaction, rowRefs);
      if (rowSnapshots.some((snapshot) => !snapshot.exists)) {
        fail("failed-precondition", "The staged import is incomplete; preview the file again.");
      }
      const rows = rowSnapshots.map((snapshot) => snapshot.data());
      const invalid = rows.some((row) => row.errors?.length || !isValidSalesRecord(row.record, draftId, row.rowNumber));
      if (invalid) {
        fail("failed-precondition", "All rows must be valid and matched; no rows were imported.");
      }

      const screeningRefs = rows.map((row) => screenings.doc(screeningIdentity(scope.theaterId, row.record)));
      const [screeningSnapshots, existingImport] = await Promise.all([
        transactionGetAll(transaction, screeningRefs),
        transaction.get(importRef),
      ]);
      if (existingImport.exists) {
        return {ok: true, importId: draftId, rowCount: draft.rowCount, importedAt: isoDate(existingImport.data().importedAt)};
      }
      if (screeningSnapshots.some((snapshot) => snapshot.exists)) {
        fail("already-exists", "One or more screenings were imported after preview. Preview the file again.");
      }

      const importedAt = new Date();
      rows.forEach((row, index) => {
        transaction.create(screeningRefs[index], {
          ...row.record,
          theaterId: scope.theaterId,
          theaterKey: scope.theaterKey,
          screeningId: screeningRefs[index].id,
          createdAt: importedAt,
          importedAt,
        });
      });
      transaction.create(importRef, {
        fileName: draft.fileName,
        importedAt,
        rowCount: draft.rowCount,
        source: draft.source,
        uploadedBy: scope.requester.uid,
        draftId,
      });
      transaction.update(draftRef, {
        status: "confirmed",
        importedAt,
        importId: draftId,
      });
      return {ok: true, importId: draftId, rowCount: draft.rowCount, importedAt: importedAt.toISOString()};
    });
  }

  async function analytics(request) {
    const scope = await authorize(request);
    const {startDate, endDate} = request.data || {};
    if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) {
      fail("invalid-argument", "startDate and endDate must be valid YYYY-MM-DD dates with startDate <= endDate.");
    }
    const filters = validateFilters(request.data.filters, fail);
    const screeningsCollection = collection(scope.theaterId, "salesScreenings");
    const snapshot = await screeningsCollection
      .where("screeningDate", ">=", startDate)
      .where("screeningDate", "<=", endDate)
      .orderBy("screeningDate")
      .limit(MAX_ANALYTICS_ROWS + 1)
      .get();
    if (snapshot.docs.length > MAX_ANALYTICS_ROWS) {
      fail("resource-exhausted", `Analytics period exceeds ${MAX_ANALYTICS_ROWS} screenings. Narrow the date range.`);
    }
    const unfiltered = snapshot.docs.map((doc) => doc.data());
    const filterOptions = getFilterOptions(unfiltered);
    const records = unfiltered.filter((record) => matchesFilters(record, filters))
      .sort((a, b) => a.screeningDate.localeCompare(b.screeningDate)
        || a.startTime.localeCompare(b.startTime) || a.auditorium.localeCompare(b.auditorium));
    const result = calculateAnalytics(records);
    const importsSnapshot = await collection(scope.theaterId, "salesImports")
      .orderBy("importedAt", "desc").limit(1).get();
    const lastImportedAt = importsSnapshot.docs.length
      ? isoDate(importsSnapshot.docs[0].data().importedAt) : null;
    return {
      period: {startDate, endDate},
      currency: "USD",
      summary: result.summary,
      coverage: result.coverage,
      movies: result.movies,
      trend: result.trend,
      screenings: records.map(toSalesRecord),
      warnings: result.warnings,
      lastImportedAt,
      definitions: result.definitions,
      methodology: "Only confirmed sales imports are included. Optional filters are applied to period screenings before all metrics; missing values remain unknown and are never treated as zero.",
      filterOptions,
    };
  }

  async function listImports(request) {
    const scope = await authorize(request);
    const inputLimit = request.data?.limit;
    const pageSize = inputLimit === undefined ? DEFAULT_IMPORT_PAGE_SIZE : Number(inputLimit);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_IMPORT_PAGE_SIZE) {
      fail("invalid-argument", `limit must be an integer from 1 to ${MAX_IMPORT_PAGE_SIZE}.`);
    }
    const imports = collection(scope.theaterId, "salesImports");
    let query = imports.orderBy("importedAt", "desc");
    if (request.data?.cursor !== undefined) {
      const cursor = request.data.cursor;
      if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,150}$/.test(cursor)) {
        fail("invalid-argument", "cursor is invalid.");
      }
      const cursorSnapshot = await imports.doc(cursor).get();
      if (!cursorSnapshot.exists) fail("invalid-argument", "cursor was not found.");
      query = query.startAfter(cursorSnapshot);
    }
    const snapshot = await query.limit(pageSize + 1).get();
    const docs = snapshot.docs.slice(0, pageSize);
    const response = {
      imports: docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          fileName: data.fileName,
          importedAt: isoDate(data.importedAt),
          rowCount: data.rowCount,
          source: data.source,
        };
      }),
    };
    if (snapshot.docs.length > pageSize && docs.length) response.nextCursor = docs[docs.length - 1].id;
    return response;
  }

  return {
    reelSuccessPreviewSalesImport: onCall(preview),
    reelSuccessConfirmSalesImport: onCall(confirm),
    reelSuccessGetSalesAnalytics: onCall(analytics),
    reelSuccessListSalesImports: onCall(listImports),
  };
}

function decodeBase64(value, fail) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    fail("invalid-argument", "fileBase64 must contain a valid CSV or XLSX file no larger than 3 MB.");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length > MAX_FILE_BYTES || buffer.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    fail("invalid-argument", "fileBase64 must contain a valid CSV or XLSX file no larger than 3 MB.");
  }
  return buffer;
}

async function parseSalesFile(source, buffer, fail = defaultFail) {
  let matrix;
  let sourceRowNumbers;
  if (source === "csv") {
    try {
      const records = parseCsv(buffer, {bom: true, skip_empty_lines: true, relax_column_count: false, info: true});
      matrix = records.map(({record}) => record);
      sourceRowNumbers = records.map(({record, info}) => info.lines - countEmbeddedLineBreaks(record));
    } catch (error) {
      fail("invalid-argument", `CSV could not be parsed: ${error.message}`);
    }
  } else {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const populatedWorksheets = workbook.worksheets.filter((worksheet) =>
        worksheet.actualRowCount > 0 && worksheet.actualColumnCount > 0);
      if (populatedWorksheets.length > 1) {
        fail("invalid-argument", "XLSX files with multiple nonempty worksheets are not supported; upload a single-sheet workbook.");
      }
      const worksheet = populatedWorksheets[0];
      if (!worksheet) fail("invalid-argument", "XLSX file has no worksheet.");
      matrix = [];
      sourceRowNumbers = [];
      worksheet.eachRow({includeEmpty: false}, (row) => {
        const values = [];
        for (let column = 1; column <= worksheet.columnCount; column += 1) {
          const value = row.getCell(column).value;
          values.push(normalizeSpreadsheetCell(value));
        }
        matrix.push(values);
        sourceRowNumbers.push(row.number);
      });
    } catch (error) {
      if (error instanceof Error && error.name === "HttpsError") throw error;
      fail("invalid-argument", `XLSX could not be parsed: ${error.message}`);
    }
  }
  if (!matrix?.length) fail("invalid-argument", "The file must contain a header row and at least one data row.");
  if (matrix.some((row) => row.some((cell) => cell === "\u0000FORMULA"))) {
    fail("invalid-argument", "XLSX formula cells are not supported; upload a values-only workbook.");
  }
  if (matrix.some((row) => row.some((cell) => cell === "\u0000ERROR"))) {
    fail("invalid-argument", "XLSX error cells are not supported; correct the workbook values and upload it again.");
  }
  if (matrix.some((row) => row.some((cell) => cell === "\u0000UNSUPPORTED"))) {
    fail("invalid-argument", "XLSX contains an unsupported non-value cell; upload a values-only workbook.");
  }
  const headers = matrix[0].map((cell) => String(cell ?? "").trim());
  if (!headers.length || headers.some((header) => !header)) fail("invalid-argument", "Every column must have a header.");
  if (new Set(headers).size !== headers.length) fail("invalid-argument", "Column headers must be unique.");
  const dataRows = matrix.slice(1).map((cells, index) => ({
    cells,
    rowNumber: sourceRowNumbers[index + 1] ?? index + 2,
  })).filter(({cells}) => cells.some((cell) => cell !== null && cell !== undefined && String(cell).trim() !== ""));
  if (!dataRows.length) fail("invalid-argument", "The file must contain at least one sales record.");
  if (dataRows.length > MAX_IMPORT_ROWS) {
    fail("resource-exhausted", `The import contains ${dataRows.length} records; the maximum is ${MAX_IMPORT_ROWS}. No rows were staged.`);
  }
  return {
    headers,
    rows: dataRows.map(({cells, rowNumber}) => {
      if (cells.length !== headers.length) {
        fail("invalid-argument", `Row ${rowNumber} has ${cells.length} cells; expected ${headers.length}.`);
      }
      return {
        rowNumber,
        raw: Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] ?? null])),
      };
    }),
  };
}

function normalizeSpreadsheetCell(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || "").join("");
    if (value.formula || value.sharedFormula) return "\u0000FORMULA";
    if ("error" in value) return "\u0000ERROR";
    return "\u0000UNSUPPORTED";
  }
  return value;
}

function countEmbeddedLineBreaks(record) {
  return record.reduce((count, cell) => count + (typeof cell === "string"
    ? (cell.match(/\r\n|\r|\n/g) || []).length
    : 0), 0);
}

function suggestMapping(headers) {
  const normalizedHeaders = headers.map((header) => ({header, normalized: normalizeHeader(header)}));
  const mapping = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const candidate = normalizedHeaders.find(({normalized}) =>
      normalized === normalizeHeader(field)
        || aliases.some((alias) => normalized === normalizeHeader(alias)));
    if (candidate) mapping[field] = candidate.header;
  }
  return mapping;
}

function validateMapping(mapping, headers, fail = defaultFail) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    fail("invalid-argument", "mapping must map canonical field names to file headers.");
  }
  const output = {};
  for (const [field, header] of Object.entries(mapping)) {
    if (!MAPPED_FIELDS.has(field) || typeof header !== "string") {
      fail("invalid-argument", `Invalid mapping for ${field}.`);
    }
    if (header === "") continue;
    if (!headers.includes(header)) fail("invalid-argument", `Invalid mapping for ${field}.`);
    output[field] = header;
  }
  return output;
}

function validateMovieMatches(input, fail = defaultFail) {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) fail("invalid-argument", "movieMatches must be an object.");
  const output = {};
  for (const [key, candidate] of Object.entries(input)) {
    if (!key.trim() || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      fail("invalid-argument", "Each movie match must include a title and TMDB movie ID.");
    }
    const match = /^tmdb:([1-9]\d*)$/.exec(candidate.movieId || "");
    const releaseYear = candidate.releaseYear;
    if (!match || !Number.isSafeInteger(Number(match[1])) || typeof candidate.title !== "string" || !candidate.title.trim()
      || candidate.title.trim().length > 300
      || (releaseYear !== undefined && releaseYear !== null
        && (!Number.isInteger(releaseYear) || releaseYear < 1888 || releaseYear > new Date().getUTCFullYear() + 10))) {
      fail("invalid-argument", `Invalid manually selected TMDB match for "${key}".`);
    }
    const normalizedKey = normalizeMovieTitle(key);
    const candidateValue = {
      movieId: candidate.movieId,
      title: candidate.title.trim(),
      releaseYear: releaseYear ?? null,
    };
    if (output[normalizedKey]) {
      const prior = output[normalizedKey];
      if (prior.movieId !== candidateValue.movieId
        || normalizeMovieTitle(prior.title) !== normalizeMovieTitle(candidateValue.title)
        || prior.releaseYear !== candidateValue.releaseYear) {
        fail("invalid-argument", `Movie match title "${key}" is ambiguous.`);
      }
      continue;
    }
    output[normalizedKey] = candidateValue;
  }
  return output;
}

function normalizeSalesRow(raw, mapping, movieMatches, provenance) {
  const errors = [];
  const warnings = [];
  const value = (field) => mapping[field] ? raw[mapping[field]] : null;
  const text = (field, label, required = false) => {
    const current = value(field);
    if (current === null || current === undefined || String(current).trim() === "") {
      if (required) errors.push(`${label} is required.`);
      return null;
    }
    const result = String(current).trim();
    if (result.length > 300) errors.push(`${label} is too long.`);
    return result || null;
  };
  const movieTitleInput = text("movieTitle", "Movie title", true);
  const matched = movieTitleInput ? movieMatches[normalizeMovieTitle(movieTitleInput)] : null;
  if (!matched) errors.push("Movie title requires a manually confirmed TMDB match.");
  const screeningDate = parseDate(value("screeningDate"));
  if (!screeningDate) errors.push("Screening date must be a valid ISO YYYY-MM-DD date.");
  const startTime = parseTime(value("startTime"));
  if (!startTime) errors.push("Start time must be a valid 24-hour ISO time (HH:mm or HH:mm:ss).");
  const auditorium = text("auditorium", "Auditorium", true);
  const screeningTypeInput = text("screeningType", "Screening type", true);
  const screeningType = screeningTypeInput ? normalizeScreeningType(screeningTypeInput) : null;
  if (screeningTypeInput && !screeningType) errors.push("Screening type must contain only letters, numbers, and hyphens.");

  const capacity = parseInteger(value("capacity"), "Capacity", errors);
  const ticketsSold = parseInteger(value("ticketsSold"), "Tickets sold", errors);
  const complimentaryTickets = parseInteger(value("complimentaryTickets"), "Complimentary tickets", errors);
  const grossRevenueCents = parseDollars(value("grossRevenue"), "Gross revenue", errors);
  const ticketPriceCents = parseDollars(value("ticketPrice"), "Ticket price", errors);
  const inputCurrency = text("currency", "Currency");
  if (inputCurrency && inputCurrency.toUpperCase() !== "USD") errors.push("Only USD currency is supported.");
  if (capacity !== null && ticketsSold !== null && ticketsSold > capacity) {
    errors.push("Paid admissions exceed capacity.");
  }
  if (capacity !== null && complimentaryTickets !== null && complimentaryTickets > capacity) {
    errors.push("Complimentary admissions exceed capacity.");
  }
  if (capacity !== null && ticketsSold !== null && complimentaryTickets !== null
    && ticketsSold + complimentaryTickets > capacity) {
    errors.push("Paid plus complimentary admissions exceed capacity.");
  }

  const releaseYearInput = parseInteger(value("releaseYear"), "Release year", errors);
  if (releaseYearInput !== null && (releaseYearInput < 1888 || releaseYearInput > new Date().getUTCFullYear() + 10)) {
    errors.push("Release year is outside the supported range.");
  }
  const runtimeMinutes = parseInteger(value("runtimeMinutes"), "Runtime minutes", errors);
  if (runtimeMinutes !== null && runtimeMinutes < 1) errors.push("Runtime minutes must be greater than zero.");
  const genre = text("genre", "Genre");
  if (matched?.releaseYear && releaseYearInput !== null && matched.releaseYear !== releaseYearInput) {
    warnings.push("Mapped release year differs from the selected TMDB match; the selected match was used.");
  }
  if (inputCurrency && inputCurrency.toUpperCase() === "USD") warnings.push("Currency is interpreted as USD.");

  const record = matched && screeningDate && startTime && auditorium && screeningType && errors.length === 0
    ? {
      movieId: matched.movieId,
      movieTitle: matched.title,
      screeningDate,
      startTime,
      auditorium,
      capacity,
      ticketsSold,
      complimentaryTickets,
      grossRevenueCents,
      ticketPriceCents,
      screeningType,
      genre,
      releaseYear: matched.releaseYear ?? releaseYearInput,
      runtimeMinutes,
      source: provenance.source,
      importBatchId: provenance.importBatchId,
      rowNumber: provenance.rowNumber,
    }
    : null;
  return {record, errors, warnings};
}

function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value !== "string" || !isIsoDate(value.trim())) return null;
  return value.trim();
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
  }
  if (typeof value === "number" && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

function parseInteger(value, label, errors) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    errors.push(`${label} must be a nonnegative integer.`);
    return null;
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    errors.push(`${label} is too large.`);
    return null;
  }
  return number;
}

function parseDollars(value, label, errors) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  let text = String(value).trim().replace(/^\$/, "");
  const numberText = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(text) ? text.replace(/,/g, "") : null;
  if (numberText === null) {
    errors.push(`${label} must be a nonnegative dollar amount with at most two decimal places.`);
    return null;
  }
  const [whole, fraction = ""] = numberText.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    errors.push(`${label} is too large.`);
    return null;
  }
  return cents;
}

function screeningIdentity(theaterId, record) {
  return crypto.createHash("sha256").update([
    theaterId,
    record.movieId,
    record.screeningDate,
    record.startTime,
    record.auditorium.trim().toLocaleLowerCase("en-US"),
  ].join("\u001f")).digest("hex");
}

function isValidSalesRecord(record, draftId, rowNumber) {
  return Boolean(record && record.importBatchId === draftId && record.rowNumber === rowNumber
    && /^tmdb:[1-9]\d*$/.test(record.movieId) && isIsoDate(record.screeningDate)
    && typeof record.startTime === "string" && typeof record.auditorium === "string"
    && typeof record.movieTitle === "string" && typeof record.screeningType === "string");
}

async function transactionGetAll(transaction, refs) {
  if (!refs.length) return [];
  if (typeof transaction.getAll === "function") return transaction.getAll(...refs);
  return Promise.all(refs.map((ref) => transaction.get(ref)));
}

function validateFilters(filters, fail = defaultFail) {
  if (filters === undefined || filters === null) return {};
  if (typeof filters !== "object" || Array.isArray(filters)) fail("invalid-argument", "filters must be an object.");
  const allowed = new Set(["genre", "releaseYear", "decade", "screeningType", "weekday", "startTime"]);
  for (const key of Object.keys(filters)) if (!allowed.has(key)) fail("invalid-argument", `Unsupported filter: ${key}.`);
  const output = {};
  for (const key of ["genre", "screeningType", "startTime"]) {
    if (filters[key] !== undefined && filters[key] !== "") {
      if (typeof filters[key] !== "string" || !filters[key].trim()) fail("invalid-argument", `${key} filter must be a non-empty string.`);
      output[key] = filters[key].trim();
    }
  }
  for (const key of ["releaseYear", "decade", "weekday"]) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== "") {
      if (!Number.isInteger(filters[key])) fail("invalid-argument", `${key} filter must be an integer.`);
      output[key] = filters[key];
    }
  }
  if (output.weekday !== undefined && (output.weekday < 0 || output.weekday > 6)) {
    fail("invalid-argument", "weekday must be an integer from 0 to 6.");
  }
  if (output.releaseYear !== undefined && (output.releaseYear < 1888 || output.releaseYear > new Date().getUTCFullYear() + 10)) {
    fail("invalid-argument", "releaseYear is outside the supported range.");
  }
  if (output.decade !== undefined && (output.decade < 1880 || output.decade % 10 !== 0)) {
    fail("invalid-argument", "decade must be a valid decade (for example 1990 or 2020).");
  }
  if (output.startTime !== undefined && !parseTime(output.startTime)) {
    fail("invalid-argument", "startTime must be a valid 24-hour time.");
  }
  if (output.startTime !== undefined) output.startTime = parseTime(output.startTime);
  return output;
}

function getFilterOptions(records) {
  const genres = new Set();
  const releaseYears = new Set();
  const screeningTypes = new Set();
  const startTimes = new Set();
  for (const record of records) {
    if (record.genre) genres.add(record.genre);
    if (Number.isInteger(record.releaseYear)) releaseYears.add(record.releaseYear);
    if (record.screeningType) screeningTypes.add(record.screeningType);
    if (record.startTime) startTimes.add(record.startTime);
  }
  return {
    genres: [...genres].sort((a, b) => a.localeCompare(b)),
    releaseYears: [...releaseYears].sort((a, b) => a - b),
    screeningTypes: [...screeningTypes].sort((a, b) => a.localeCompare(b)),
    startTimes: [...startTimes].sort(),
  };
}

function matchesFilters(record, filters) {
  if (filters.genre !== undefined && record.genre !== filters.genre) return false;
  if (filters.releaseYear !== undefined && record.releaseYear !== filters.releaseYear) return false;
  if (filters.decade !== undefined && (!Number.isInteger(record.releaseYear)
    || Math.floor(record.releaseYear / 10) * 10 !== filters.decade)) return false;
  if (filters.screeningType !== undefined && record.screeningType !== filters.screeningType) return false;
  if (filters.startTime !== undefined && record.startTime !== filters.startTime) return false;
  if (filters.weekday !== undefined && new Date(`${record.screeningDate}T00:00:00Z`).getUTCDay() !== filters.weekday) return false;
  return true;
}

function calculateAnalytics(records) {
  const coverage = {
    paidAdmissions: records.filter((record) => Number.isInteger(record.ticketsSold)).length,
    revenue: records.filter((record) => Number.isInteger(record.grossRevenueCents)).length,
    capacity: records.filter((record) => Number.isInteger(record.capacity)).length,
  };
  const paidAdmissions = sumKnown(records, "ticketsSold");
  const grossRevenueCents = sumKnown(records, "grossRevenueCents");
  const paidPaired = records.filter((record) => Number.isInteger(record.ticketsSold) && Number.isInteger(record.capacity));
  const paidCapacity = paidPaired.reduce((sum, record) => sum + record.capacity, 0);
  const paidCount = paidPaired.reduce((sum, record) => sum + record.ticketsSold, 0);
  const averageOccupancy = paidCapacity ? paidCount / paidCapacity : null;
  const averageTickets = coverage.paidAdmissions ? paidAdmissions / coverage.paidAdmissions : null;
  const groups = new Map();
  const trends = new Map();
  for (const record of records) {
    const movieId = record.movieId;
    if (!groups.has(movieId)) groups.set(movieId, []);
    groups.get(movieId).push(record);
    if (!trends.has(record.screeningDate)) trends.set(record.screeningDate, []);
    trends.get(record.screeningDate).push(record);
  }
  const movies = [...groups.entries()].map(([movieId, group]) => movieMetrics(movieId, group, records))
    .sort((a, b) => a.title.localeCompare(b.title));
  const trend = [...trends.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, group]) => ({
    date,
    paidAdmissions: sumKnown(group, "ticketsSold"),
    grossRevenueCents: sumKnown(group, "grossRevenueCents"),
    screenings: group.length,
  }));
  return {
    summary: {
      screenings: records.length,
      paidAdmissions,
      grossRevenueCents,
      averageTickets,
      averageOccupancy,
    },
    coverage,
    movies,
    trend,
    warnings: analyticsWarnings(records, coverage, paidPaired.length),
    definitions: {
      screenings: "Number of confirmed screening records in the selected period after all optional filters.",
      paidAdmissions: "Sum of known ticketsSold values; missing values are excluded, not treated as zero. Coverage counts screenings with a reported value.",
      grossRevenueCents: "Sum of known USD grossRevenue values converted to integer cents; missing values are excluded, not treated as zero.",
      averageTickets: "Arithmetic mean of ticketsSold per screening among screenings with a reported ticketsSold value.",
      averageOccupancy: "Weighted paid occupancy: sum of ticketsSold divided by sum of capacity across screenings where both values are known; complimentary tickets are excluded.",
      movieAverageOccupancy: "Weighted paid occupancy for that movie using paired known ticketsSold and capacity rows only.",
      revenuePerScreeningCents: "Known gross revenue divided by the number of screenings with reported gross revenue.",
      averageTicketPriceCents: "Admissions-weighted mean of ticketPriceCents, using only rows with both ticketsSold and ticketPriceCents known.",
      pairedCapacity: "Number of screenings with both ticketsSold and capacity known; only these rows contribute to weighted paid occupancy.",
      performanceIndex: "For sufficiently supported movies, target paid admissions divided by expected paid admissions from other-film screenings matched on exact capacity, ticket price, weekday, start time, calendar month, and screening type within the selected period and filters. Leave-one-film-out descriptive comparison only; not causal or predictive.",
    },
  };
}

function movieMetrics(movieId, records, allRecords) {
  const revenueRows = records.filter((record) => Number.isInteger(record.grossRevenueCents));
  const paidRows = records.filter((record) => Number.isInteger(record.ticketsSold));
  const pairedRows = records.filter((record) => Number.isInteger(record.ticketsSold) && Number.isInteger(record.capacity));
  const pricedRows = records.filter((record) => Number.isInteger(record.ticketsSold)
    && Number.isInteger(record.ticketPriceCents) && record.ticketsSold > 0);
  const admissions = paidRows.reduce((sum, record) => sum + record.ticketsSold, 0);
  const revenue = revenueRows.reduce((sum, record) => sum + record.grossRevenueCents, 0);
  const pairedCapacity = pairedRows.reduce((sum, record) => sum + record.capacity, 0);
  const pairedAdmissions = pairedRows.reduce((sum, record) => sum + record.ticketsSold, 0);
  const weightedPriceAdmissions = pricedRows.reduce((sum, record) => sum + record.ticketsSold, 0);
  const weightedPrice = pricedRows.reduce((sum, record) => sum + record.ticketPriceCents * record.ticketsSold, 0);
  const first = records.find((record) => record.releaseYear !== null || record.genre || record.runtimeMinutes) || records[0];
  const index = calculatePerformanceIndex(movieId, records, allRecords);
  return {
    movieId,
    title: first.movieTitle,
    releaseYear: first.releaseYear ?? null,
    genre: first.genre ?? null,
    runtimeMinutes: first.runtimeMinutes ?? null,
    screenings: records.length,
    paidAdmissions: paidRows.length ? admissions : null,
    grossRevenueCents: revenueRows.length ? revenue : null,
    averageTickets: paidRows.length ? admissions / paidRows.length : null,
    averageOccupancy: pairedCapacity ? pairedAdmissions / pairedCapacity : null,
    revenuePerScreeningCents: revenueRows.length ? revenue / revenueRows.length : null,
    averageTicketPriceCents: weightedPriceAdmissions ? weightedPrice / weightedPriceAdmissions : null,
    performanceIndex: index.performanceIndex,
    baselineCount: index.baselineCount,
    baselineScreeningKeys: index.baselineScreeningKeys,
    expectedPaidAdmissions: index.expectedPaidAdmissions,
    indexReason: index.indexReason,
  };
}

function calculatePerformanceIndex(movieId, targetRecords, allRecords) {
  const empty = (reason) => ({
    performanceIndex: null,
    baselineCount: 0,
    baselineScreeningKeys: [],
    expectedPaidAdmissions: null,
    indexReason: reason,
  });
  if (targetRecords.length < 3) {
    return empty("Withheld: at least 3 target screenings are required.");
  }
  if (targetRecords.some((record) => !Number.isInteger(record.ticketsSold)
    || !Number.isInteger(record.capacity) || record.capacity <= 0
    || !Number.isInteger(record.ticketPriceCents) || record.ticketPriceCents <= 0)) {
    return empty("Withheld: every target screening must report paid admissions, positive capacity, and a positive ticket price.");
  }

  const baselineByKey = new Map();
  let expectedPaidAdmissions = 0;
  for (const target of targetRecords) {
    const weekday = new Date(`${target.screeningDate}T00:00:00Z`).getUTCDay();
    const comparables = allRecords.filter((peer) => peer.movieId !== movieId
      && Number.isInteger(peer.ticketsSold)
      && peer.capacity === target.capacity
      && peer.ticketPriceCents === target.ticketPriceCents
      && peer.startTime === target.startTime
      && peer.screeningDate.slice(0, 7) === target.screeningDate.slice(0, 7)
      && new Date(`${peer.screeningDate}T00:00:00Z`).getUTCDay() === weekday
      && peer.screeningType === target.screeningType);
    const peerMovies = new Set(comparables.map((peer) => peer.movieId));
    if (comparables.length < 5 || peerMovies.size < 2) {
      return empty("Withheld: each target screening requires at least 5 matched other-film screenings across at least 2 movies.");
    }
    expectedPaidAdmissions += comparables.reduce((sum, peer) => sum + peer.ticketsSold, 0) / comparables.length;
    for (const peer of comparables) {
      const key = screeningKey(peer);
      if (!baselineByKey.has(key)) baselineByKey.set(key, peer);
    }
  }
  const baselineScreeningKeys = [...baselineByKey.values()].map(screeningKey);
  if (expectedPaidAdmissions <= 0) {
    return {
      performanceIndex: null,
      baselineCount: baselineScreeningKeys.length,
      baselineScreeningKeys,
      expectedPaidAdmissions: 0,
      indexReason: "Withheld: matched comparable screenings have a zero expected paid-admissions baseline.",
    };
  }
  const actualPaidAdmissions = targetRecords.reduce((sum, record) => sum + record.ticketsSold, 0);
  return {
    performanceIndex: actualPaidAdmissions / expectedPaidAdmissions,
    baselineCount: baselineScreeningKeys.length,
    baselineScreeningKeys,
    expectedPaidAdmissions,
    indexReason: "Descriptive leave-one-film-out comparison using only exact matched screenings in this selected period and filter set; not a causal or predictive score.",
  };
}

function screeningKey(record) {
  return `${record.importBatchId}:${record.rowNumber}`;
}

function analyticsWarnings(records, coverage, pairedCount) {
  if (!records.length) return ["No confirmed screenings match this period and filter selection."];
  const warnings = [];
  if (coverage.paidAdmissions < records.length || coverage.revenue < records.length
    || coverage.capacity < records.length || pairedCount < records.length) {
    warnings.push(
      `Partial data coverage: paid admissions reported for ${coverage.paidAdmissions}/${records.length} screenings; `
      + `gross revenue for ${coverage.revenue}/${records.length}; capacity for ${coverage.capacity}/${records.length}. `
      + `Weighted paid occupancy uses ${pairedCount}/${records.length} screenings with both paid admissions and capacity.`,
    );
  }
  return warnings;
}

function sumKnown(records, field) {
  const known = records.filter((record) => Number.isFinite(record[field]));
  return known.length ? known.reduce((sum, record) => sum + record[field], 0) : null;
}

function toSalesRecord(record) {
  const fields = [
    "movieId", "movieTitle", "screeningDate", "startTime", "auditorium", "capacity", "ticketsSold",
    "complimentaryTickets", "grossRevenueCents", "ticketPriceCents", "screeningType", "genre",
    "releaseYear", "runtimeMinutes", "source", "importBatchId", "rowNumber",
  ];
  return Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));
}

function normalizeHeader(value) {
  return String(value).toLowerCase().replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function normalizeMovieTitle(value) {
  return String(value).normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function mappedText(raw, header) {
  const value = header ? raw[header] : null;
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeScreeningType(value) {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return /^[a-z][a-z0-9-]{0,39}$/.test(normalized) ? normalized : null;
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (value && typeof value.toDate === "function") return isoDate(value.toDate());
  if (typeof value === "string") return value;
  return null;
}

function defaultFail(code, message) {
  const error = new Error(message);
  error.name = "HttpsError";
  error.code = code;
  throw error;
}

module.exports = {
  createSalesApi,
  parseSalesFile,
  suggestMapping,
  validateMapping,
  normalizeSalesRow,
  screeningIdentity,
  validateMovieMatches,
  validateMapping,
  validateFilters,
  matchesFilters,
  calculateAnalytics,
  parseDate,
  parseTime,
  isIsoDate,
  MAX_FILE_BYTES,
  MAX_IMPORT_ROWS,
  MAX_ANALYTICS_ROWS,
};
