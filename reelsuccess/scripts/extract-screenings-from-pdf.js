#!/usr/bin/env node

/**
 * Step 1 for ReelSuccess:
 * Extract theater + movie screening rows from PDF text streams into JSON/CSV.
 *
 * Usage:
 *   node reelsuccess/scripts/extract-screenings-from-pdf.js \
 *     --outDir ./reelsuccess/output \
 *     /absolute/path/to/report1.pdf /absolute/path/to/report2.pdf
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    outDir: path.resolve(process.cwd(), "reelsuccess/output"),
    minScreenCount: 1,
    maxScreenCount: 40,
    strict: false,
    files: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--outDir") {
      args.outDir = path.resolve(process.cwd(), argv[i + 1] || "reelsuccess/output");
      i += 1;
      continue;
    }
    if (token === "--minScreenCount") {
      args.minScreenCount = Number(argv[i + 1] || 1);
      i += 1;
      continue;
    }
    if (token === "--maxScreenCount") {
      args.maxScreenCount = Number(argv[i + 1] || 40);
      i += 1;
      continue;
    }
    if (token === "--strict") {
      args.strict = true;
      continue;
    }

    args.files.push(path.resolve(process.cwd(), token));
  }

  return args;
}

function decodePdfLiteralString(s) {
  return s
    .replace(/\\\\/g, "\\")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

function extractPdfTextLiterals(fileBuffer) {
  const text = fileBuffer.toString("latin1");
  const lines = [];

  // Capture simple PDF text draw operations like: (Some Text) Tj
  const regex = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const literalWithParens = match[0].replace(/\s*Tj$/, "").trim();
    const literal = literalWithParens.slice(1, -1);
    const decoded = decodePdfLiteralString(literal).trim();
    if (decoded) lines.push(decoded);
  }

  return lines;
}

function looksLikeGrossOrNumber(line) {
  return /^[-\d,\.]+$/.test(line) || line === "-";
}

function incrementCounter(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function normalizeMovieTitle(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .replace(/[\u2019]/g, "'")
    .replace(/\s*[#*]+\s*$/g, "")
    .trim();
}

function classifyCandidateMovieTitle(line) {
  const raw = String(line || "").trim();
  const t = normalizeMovieTitle(raw);

  if (!t) return { ok: false, reason: "empty", keepWaiting: true };
  if (/^Page\s+\d+\s+of\s+\d+/i.test(t)) return { ok: false, reason: "page_footer", keepWaiting: true };
  if (/^Data valid as of:/i.test(t)) return { ok: false, reason: "data_valid_footer", keepWaiting: true };
  if (/^# denotes/i.test(t) || /^\* denotes/i.test(t)) return { ok: false, reason: "legend_footer", keepWaiting: true };
  if (/Calendar Week/i.test(t)) return { ok: false, reason: "calendar_week_header", keepWaiting: true };
  if (/^Total$/i.test(t)) return { ok: false, reason: "total_footer", keepWaiting: true };
  if (/^(W|CW|TR|ND|NE|NP|TC|N\/A|NA)$/i.test(t)) return { ok: false, reason: "column_or_code_token", keepWaiting: true };
  if (/^[-–—]$/.test(t)) return { ok: false, reason: "dash_token", keepWaiting: true };
  if (/^[-+]?\d{1,4}%$/.test(t)) return { ok: false, reason: "percent_token", keepWaiting: true };
  if (/\b(copyright|comscore)\b/i.test(t)) return { ok: false, reason: "copyright_footer", keepWaiting: true };
  if (/\b(gross|adms|screen|avg|change|weekend)\b/i.test(t) && t.length < 40 && t === t.toUpperCase()) {
    return { ok: false, reason: "table_header_token", keepWaiting: true };
  }
  if (looksLikeGrossOrNumber(t)) return { ok: false, reason: "numeric_token", keepWaiting: true };
  if (/^[A-Za-z .'/&-]+,\s*[A-Z]{2}$/.test(t)) return { ok: false, reason: "city_state_token", keepWaiting: true };
  if (/^[A-Za-z .'/&-]+\/[A-Za-z .'/&-]+,\s*[A-Z]{2}$/.test(t)) return { ok: false, reason: "city_state_combo_token", keepWaiting: true };
  if (!/[A-Za-z]/.test(t)) return { ok: false, reason: "no_letters", keepWaiting: true };

  return { ok: true, title: t, rawTitle: raw };
}

function parseReportLines(reportPath, lines, options = {}) {
  const minScreenCount = Number.isFinite(options.minScreenCount) ? options.minScreenCount : 1;
  const maxScreenCount = Number.isFinite(options.maxScreenCount) ? options.maxScreenCount : 40;
  const rows = [];
  const diagnostics = {
    screen_count_tokens: 0,
    screen_count_out_of_range: 0,
    orphaned_screen_count_tokens: 0,
    rows_parsed: 0,
    non_friday_opening_rows: 0,
    rejected_after_screen_count: {},
  };

  let weekStart = "";
  let weekEnd = "";
  let calendarWeek = "";

  let areaCityState = "";
  let areaName = "";

  let theaterCode = "";
  let theaterName = "";
  let theaterCityState = "";

  let pendingScreenCount = null;
  let pendingNonFriday = false;

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;

    const weekRangeMatch = line.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4}).*Week\s*#\s*(\d+)/i);
    if (weekRangeMatch) {
      weekStart = weekRangeMatch[1];
      weekEnd = weekRangeMatch[2];
      calendarWeek = weekRangeMatch[3];
      pendingScreenCount = null;
      pendingNonFriday = false;
      continue;
    }

    const areaMatch = line.match(/^([A-Za-z .'&-]+,\s*[A-Z]{2})\s*-\s*(.+)$/);
    if (areaMatch && !line.match(/^[A-Z0-9]{3,5}\s*-/)) {
      areaCityState = areaMatch[1].trim();
      areaName = areaMatch[2].replace(/\s+$/, "").trim();
      pendingScreenCount = null;
      pendingNonFriday = false;
      continue;
    }

    const theaterMatch = line.match(/^([A-Z0-9]{3,5})\s*-\s*(.+?)\s*-\s*([A-Za-z .'&-]+,\s*[A-Z]{2})(?:\s*\(continued\))?$/);
    if (theaterMatch) {
      theaterCode = theaterMatch[1].trim();
      theaterName = theaterMatch[2].trim();
      theaterCityState = theaterMatch[3].trim();
      pendingScreenCount = null;
      pendingNonFriday = false;
      continue;
    }

    const screenCountMatch = line.match(/^(\d{1,3})\*?$/);
    if (screenCountMatch) {
      const count = Number(screenCountMatch[1]);
      if (count < minScreenCount || count > maxScreenCount) {
        diagnostics.screen_count_out_of_range += 1;
        continue;
      }

      if (pendingScreenCount != null) {
        diagnostics.orphaned_screen_count_tokens += 1;
      }

      diagnostics.screen_count_tokens += 1;
      pendingScreenCount = count;
      continue;
    }

    if (line === "*") {
      pendingNonFriday = true;
      continue;
    }

    if (pendingScreenCount != null) {
      const titleResult = classifyCandidateMovieTitle(line);

      if (!titleResult.ok) {
        incrementCounter(diagnostics.rejected_after_screen_count, titleResult.reason);
        continue;
      }

      if (!theaterCode) {
        incrementCounter(diagnostics.rejected_after_screen_count, "missing_theater_context");
        continue;
      }

      rows.push({
        report_file: path.basename(reportPath),
        week_start: weekStart,
        week_end: weekEnd,
        calendar_week: calendarWeek,
        area_city_state: areaCityState,
        area_name: areaName,
        theater_code: theaterCode,
        theater_name: theaterName,
        theater_city_state: theaterCityState,
        movie_title: titleResult.title,
        screen_count: pendingScreenCount,
        non_friday_opening: pendingNonFriday,
      });

      diagnostics.rows_parsed += 1;
      if (pendingNonFriday) diagnostics.non_friday_opening_rows += 1;

      pendingScreenCount = null;
      pendingNonFriday = false;
    }
  }

  return { rows, diagnostics };
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(filePath, rows) {
  const headers = [
    "report_file",
    "week_start",
    "week_end",
    "calendar_week",
    "area_city_state",
    "area_name",
    "theater_code",
    "theater_name",
    "theater_city_state",
    "movie_title",
    "screen_count",
    "non_friday_opening",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.files.length) {
    console.error("No PDF files provided. Example:");
    console.error("node reelsuccess/scripts/extract-screenings-from-pdf.js --outDir ./reelsuccess/output /absolute/path/report.pdf");
    process.exit(1);
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  const allRows = [];
  const perFileSummary = [];
  const aggregateDiagnostics = {
    screen_count_tokens: 0,
    screen_count_out_of_range: 0,
    orphaned_screen_count_tokens: 0,
    rows_parsed: 0,
    non_friday_opening_rows: 0,
    rejected_after_screen_count: {},
  };

  for (const filePath of args.files) {
    if (!fs.existsSync(filePath)) {
      console.warn(`Skipping missing file: ${filePath}`);
      continue;
    }

    const buffer = fs.readFileSync(filePath);
    const lines = extractPdfTextLiterals(buffer);
    const parsed = parseReportLines(filePath, lines, {
      minScreenCount: args.minScreenCount,
      maxScreenCount: args.maxScreenCount,
    });

    allRows.push(...parsed.rows);
    perFileSummary.push({
      file: filePath,
      rows: parsed.rows.length,
      textLines: lines.length,
      diagnostics: parsed.diagnostics,
    });

    aggregateDiagnostics.screen_count_tokens += parsed.diagnostics.screen_count_tokens;
    aggregateDiagnostics.screen_count_out_of_range += parsed.diagnostics.screen_count_out_of_range;
    aggregateDiagnostics.orphaned_screen_count_tokens += parsed.diagnostics.orphaned_screen_count_tokens;
    aggregateDiagnostics.rows_parsed += parsed.diagnostics.rows_parsed;
    aggregateDiagnostics.non_friday_opening_rows += parsed.diagnostics.non_friday_opening_rows;

    for (const [reason, count] of Object.entries(parsed.diagnostics.rejected_after_screen_count)) {
      incrementCounter(aggregateDiagnostics.rejected_after_screen_count, reason, count);
    }
  }

  const jsonPath = path.join(args.outDir, "screenings.json");
  const csvPath = path.join(args.outDir, "screenings.csv");
  const summaryPath = path.join(args.outDir, "extract-summary.json");
  const anomaliesPath = path.join(args.outDir, "extract-anomalies.json");

  fs.writeFileSync(jsonPath, JSON.stringify(allRows, null, 2), "utf8");
  writeCsv(csvPath, allRows);

  const titleCounts = new Map();
  for (const row of allRows) {
    const title = String(row.movie_title || "").trim();
    titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
  }

  const suspiciousTitlePatterns = [
    { name: "percent_like", test: (t) => /^[-+]?\d{1,4}%$/.test(t) },
    { name: "single_letter", test: (t) => /^[A-Za-z]$/.test(t) },
    { name: "column_tokens", test: (t) => /^(W|CW|TR|ND|NE|NP|TC|N\/A|NA)$/i.test(t) },
    { name: "copyright_like", test: (t) => /\b(copyright|comscore)\b/i.test(t) },
    { name: "city_state_like", test: (t) => /^[A-Za-z .'/&-]+,\s*[A-Z]{2}$/.test(t) },
  ];

  const suspiciousTitleCounts = {};
  const suspiciousTitleExamples = {};

  for (const [title, count] of titleCounts.entries()) {
    for (const pattern of suspiciousTitlePatterns) {
      if (pattern.test(title)) {
        suspiciousTitleCounts[pattern.name] = (suspiciousTitleCounts[pattern.name] || 0) + count;
        if (!suspiciousTitleExamples[pattern.name]) suspiciousTitleExamples[pattern.name] = [];
        if (suspiciousTitleExamples[pattern.name].length < 15) {
          suspiciousTitleExamples[pattern.name].push({ title, count });
        }
      }
    }
  }

  const summary = {
    files: perFileSummary,
    totalRows: allRows.length,
    parser: {
      minScreenCount: args.minScreenCount,
      maxScreenCount: args.maxScreenCount,
      strict: args.strict,
    },
    diagnostics: {
      ...aggregateDiagnostics,
      suspicious_title_counts: suspiciousTitleCounts,
    },
  };

  const anomalies = {
    suspicious_title_examples: suspiciousTitleExamples,
    rejected_after_screen_count: Object.entries(aggregateDiagnostics.rejected_after_screen_count)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count })),
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(anomaliesPath, JSON.stringify(anomalies, null, 2), "utf8");

  if (args.strict) {
    const suspiciousTotal = Object.values(suspiciousTitleCounts).reduce((sum, n) => sum + n, 0);
    if (suspiciousTotal > 0) {
      console.error(`Strict mode failed: found ${suspiciousTotal} suspicious extracted title rows.`);
      console.error(`See: ${anomaliesPath}`);
      process.exit(2);
    }
  }

  console.log(`Wrote ${allRows.length} rows:`);
  console.log(`- ${jsonPath}`);
  console.log(`- ${csvPath}`);
  console.log(`- ${summaryPath}`);
  console.log(`- ${anomaliesPath}`);
}

main();
