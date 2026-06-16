#!/usr/bin/env node

/**
 * Validate Step 1 extraction quality and optionally fail CI/pipeline.
 *
 * Usage:
 *   node reelsuccess/scripts/validate-extraction-quality.js \
 *     --summary ./reelsuccess/output/extract-summary.json \
 *     --screenings ./reelsuccess/output/screenings.json \
 *     --maxSuspiciousRate 0.003 \
 *     --minScreenMatchRate 0.75 \
 *     --maxOrphanedScreenRate 0.2
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    summary: path.resolve(process.cwd(), "reelsuccess/output/extract-summary.json"),
    screenings: path.resolve(process.cwd(), "reelsuccess/output/screenings.json"),
    maxSuspiciousRate: 0.003,
    minScreenMatchRate: 0.75,
    maxOrphanedScreenRate: 0.2,
    minRows: 50000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--summary") {
      args.summary = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (token === "--screenings") {
      args.screenings = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (token === "--maxSuspiciousRate") {
      args.maxSuspiciousRate = Number(argv[i + 1]);
      i += 1;
    } else if (token === "--minScreenMatchRate") {
      args.minScreenMatchRate = Number(argv[i + 1]);
      i += 1;
    } else if (token === "--maxOrphanedScreenRate") {
      args.maxOrphanedScreenRate = Number(argv[i + 1]);
      i += 1;
    } else if (token === "--minRows") {
      args.minRows = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

function classifySuspiciousTitle(title) {
  const t = String(title || "").trim();
  if (!t) return "empty";
  if (/^[-+]?\d{1,4}%$/.test(t)) return "percent_like";
  if (/^[A-Za-z]$/.test(t)) return "single_letter";
  if (/^(W|CW|TR|ND|NE|NP|TC|N\/A|NA)$/i.test(t)) return "column_tokens";
  if (/\b(copyright|comscore)\b/i.test(t)) return "copyright_like";
  if (/^[A-Za-z .'/&-]+,\s*[A-Z]{2}$/.test(t)) return "city_state_like";
  return null;
}

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.summary)) fail(`Missing summary file: ${args.summary}`);
  if (!fs.existsSync(args.screenings)) fail(`Missing screenings file: ${args.screenings}`);

  const summary = JSON.parse(fs.readFileSync(args.summary, "utf8"));
  const rows = JSON.parse(fs.readFileSync(args.screenings, "utf8"));

  if (!Array.isArray(rows) || rows.length < args.minRows) {
    fail(`Extracted rows too low. got=${Array.isArray(rows) ? rows.length : "invalid"}, min=${args.minRows}`);
  }

  const suspiciousCounts = {};
  for (const row of rows) {
    const reason = classifySuspiciousTitle(row.movie_title);
    if (reason) suspiciousCounts[reason] = (suspiciousCounts[reason] || 0) + 1;
  }

  const suspiciousTotal = Object.values(suspiciousCounts).reduce((a, b) => a + b, 0);
  const suspiciousRate = rows.length > 0 ? suspiciousTotal / rows.length : 1;

  const diagnostics = summary?.diagnostics || {};
  const rejectedAfterScreen = Object.values(diagnostics.rejected_after_screen_count || {}).reduce((a, b) => a + b, 0);
  const screenCountTokens = Number(diagnostics.screen_count_tokens || 0);
  const rowsParsed = Number(diagnostics.rows_parsed || rows.length || 0);
  const screenMatchRate = screenCountTokens > 0 ? rowsParsed / screenCountTokens : 0;
  const orphanedScreenCountTokens = Number(diagnostics.orphaned_screen_count_tokens || 0);
  const orphanedScreenRate = screenCountTokens > 0 ? orphanedScreenCountTokens / screenCountTokens : 1;

  const fileRows = Array.isArray(summary.files)
    ? summary.files.map((f) => Number(f?.rows || 0)).filter((n) => Number.isFinite(n))
    : [];
  const minPerFileRows = fileRows.length ? Math.min(...fileRows) : 0;

  const failures = [];

  if (suspiciousRate > args.maxSuspiciousRate) {
    failures.push(`suspiciousRate ${suspiciousRate.toFixed(6)} > ${args.maxSuspiciousRate}`);
  }
  if (screenMatchRate < args.minScreenMatchRate) {
    failures.push(`screenMatchRate ${screenMatchRate.toFixed(6)} < ${args.minScreenMatchRate}`);
  }
  if (orphanedScreenRate > args.maxOrphanedScreenRate) {
    failures.push(`orphanedScreenRate ${orphanedScreenRate.toFixed(6)} > ${args.maxOrphanedScreenRate}`);
  }
  if (minPerFileRows <= 0) {
    failures.push("at least one input file produced zero rows");
  }

  const report = {
    rows: rows.length,
    suspiciousTotal,
    suspiciousRate: Number(suspiciousRate.toFixed(6)),
    suspiciousCounts,
    screenCountTokens,
    rowsParsed,
    screenMatchRate: Number(screenMatchRate.toFixed(6)),
    orphanedScreenCountTokens,
    orphanedScreenRate: Number(orphanedScreenRate.toFixed(6)),
    rejectedAfterScreen,
    fileCount: fileRows.length,
    minPerFileRows,
    maxPerFileRows: fileRows.length ? Math.max(...fileRows) : 0,
    thresholds: {
      minRows: args.minRows,
      maxSuspiciousRate: args.maxSuspiciousRate,
      minScreenMatchRate: args.minScreenMatchRate,
      maxOrphanedScreenRate: args.maxOrphanedScreenRate,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (failures.length) {
    console.error("\nQuality gate failed:");
    for (const f of failures) console.error(`- ${f}`);
    process.exit(2);
  }

  console.log("\n✅ Extraction quality gates passed.");
}

main();
