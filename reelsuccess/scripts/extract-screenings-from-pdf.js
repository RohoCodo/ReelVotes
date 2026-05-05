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
  const args = { outDir: path.resolve(process.cwd(), "reelsuccess/output"), files: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--outDir") {
      args.outDir = path.resolve(process.cwd(), argv[i + 1] || "reelsuccess/output");
      i += 1;
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

function isLikelyMovieTitle(line) {
  if (!line) return false;
  if (/^Page\s+\d+\s+of\s+\d+/i.test(line)) return false;
  if (/^Data valid as of:/i.test(line)) return false;
  if (/^# denotes/i.test(line)) return false;
  if (/^\* denotes/i.test(line)) return false;
  if (/^Total$/i.test(line)) return false;
  if (looksLikeGrossOrNumber(line)) return false;
  if (/Calendar Week/i.test(line)) return false;
  if (/\bGROSS\b/i.test(line)) return false;
  if (/\(continued\)$/i.test(line)) return false;
  return true;
}

function parseReportLines(reportPath, lines) {
  const rows = [];

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

    const weekMatch = line.match(/(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4}).*Week\s*#\s*(\d+)/i);
    if (weekMatch) {
      weekStart = weekMatch[1];
      weekEnd = weekMatch[2];
      calendarWeek = weekMatch[3];
      continue;
    }

    const areaMatch = line.match(/^([A-Za-z .'&-]+,\s*[A-Z]{2})\s*-\s*(.+)$/);
    if (areaMatch && !line.match(/^[A-Z0-9]{3,5}\s*-/)) {
      areaCityState = areaMatch[1].trim();
      areaName = areaMatch[2].replace(/\s+$/, "").trim();
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

    if (/^\d+$/.test(line)) {
      pendingScreenCount = Number(line);
      continue;
    }

    if (line === "*") {
      pendingNonFriday = true;
      continue;
    }

    if (pendingScreenCount != null && isLikelyMovieTitle(line) && theaterCode) {
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
        movie_title: line,
        screen_count: pendingScreenCount,
        non_friday_opening: pendingNonFriday,
      });

      pendingScreenCount = null;
      pendingNonFriday = false;
    }
  }

  return rows;
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

  for (const filePath of args.files) {
    if (!fs.existsSync(filePath)) {
      console.warn(`Skipping missing file: ${filePath}`);
      continue;
    }

    const buffer = fs.readFileSync(filePath);
    const lines = extractPdfTextLiterals(buffer);
    const rows = parseReportLines(filePath, lines);

    allRows.push(...rows);
    perFileSummary.push({ file: filePath, rows: rows.length, textLines: lines.length });
  }

  const jsonPath = path.join(args.outDir, "screenings.json");
  const csvPath = path.join(args.outDir, "screenings.csv");
  const summaryPath = path.join(args.outDir, "extract-summary.json");

  fs.writeFileSync(jsonPath, JSON.stringify(allRows, null, 2), "utf8");
  writeCsv(csvPath, allRows);
  fs.writeFileSync(summaryPath, JSON.stringify({ files: perFileSummary, totalRows: allRows.length }, null, 2), "utf8");

  console.log(`Wrote ${allRows.length} rows:`);
  console.log(`- ${jsonPath}`);
  console.log(`- ${csvPath}`);
  console.log(`- ${summaryPath}`);
}

main();
