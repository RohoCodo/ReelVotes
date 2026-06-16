#!/usr/bin/env node

/**
 * End-to-end ReelSuccess pipeline runner.
 *
 * Runs:
 * 1) Step 1 extraction
 * 2) Extraction quality validation
 * 3) Step 3 feature matrix
 * 4) Step 4 similarity + recommendations
 * 5) Step 5 function payload prep
 * 6) Optional functions deploy
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseArgs(argv) {
  const args = {
    outDir: path.resolve(process.cwd(), "reelsuccess/output"),
    pdfGlobDir: path.resolve(process.cwd(), "reelsuccess/input-pdfs"),
    theaterProfiles: path.resolve(process.cwd(), "reelsuccess/output/theater_profiles_step2.json"),
    functionsDataDir: path.resolve(process.cwd(), "functions/reelsuccess-data"),
    maxScreenCount: 40,
    minScreenMatchRate: 0.75,
    maxOrphanedScreenRate: 0.2,
    minRows: 50000,
    deployFunctions: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--outDir") {
      args.outDir = path.resolve(process.cwd(), argv[++i]);
    } else if (t === "--pdfDir") {
      args.pdfGlobDir = path.resolve(process.cwd(), argv[++i]);
    } else if (t === "--theaterProfiles") {
      args.theaterProfiles = path.resolve(process.cwd(), argv[++i]);
    } else if (t === "--functionsDataDir") {
      args.functionsDataDir = path.resolve(process.cwd(), argv[++i]);
    } else if (t === "--maxScreenCount") {
      args.maxScreenCount = Number(argv[++i]);
    } else if (t === "--minScreenMatchRate") {
      args.minScreenMatchRate = Number(argv[++i]);
    } else if (t === "--maxOrphanedScreenRate") {
      args.maxOrphanedScreenRate = Number(argv[++i]);
    } else if (t === "--minRows") {
      args.minRows = Number(argv[++i]);
    } else if (t === "--deployFunctions") {
      args.deployFunctions = true;
    }
  }

  return args;
}

function runCommand(label, command, commandArgs) {
  console.log(`\n▶ ${label}`);
  console.log(`$ ${command} ${commandArgs.join(" ")}`);

  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
    shell: false,
  });

  if (result.status !== 0) {
    console.error(`\n✖ ${label} failed with exit code ${result.status}`);
    process.exit(result.status || 1);
  }

  console.log(`✔ ${label} complete`);
}

function getPdfFiles(pdfDir) {
  if (!fs.existsSync(pdfDir)) return [];
  return fs
    .readdirSync(pdfDir)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .map((name) => path.join(pdfDir, name))
    .sort((a, b) => a.localeCompare(b));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const pdfFiles = getPdfFiles(args.pdfGlobDir);
  if (!pdfFiles.length) {
    console.error(`No PDF files found in: ${args.pdfGlobDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(args.theaterProfiles)) {
    console.error(`Missing theater profiles input: ${args.theaterProfiles}`);
    process.exit(1);
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  fs.mkdirSync(args.functionsDataDir, { recursive: true });

  runCommand("Step 1 extract", "node", [
    "reelsuccess/scripts/extract-screenings-from-pdf.js",
    "--outDir",
    args.outDir,
    "--maxScreenCount",
    String(args.maxScreenCount),
    ...pdfFiles,
  ]);

  runCommand("Step 1 quality validate", "node", [
    "reelsuccess/scripts/validate-extraction-quality.js",
    "--summary",
    path.join(args.outDir, "extract-summary.json"),
    "--screenings",
    path.join(args.outDir, "screenings.json"),
    "--minRows",
    String(args.minRows),
    "--minScreenMatchRate",
    String(args.minScreenMatchRate),
    "--maxOrphanedScreenRate",
    String(args.maxOrphanedScreenRate),
  ]);

  runCommand("Step 3 feature matrix", "node", [
    "reelsuccess/scripts/build-theater-feature-matrix.js",
    "--screenings",
    path.join(args.outDir, "screenings.json"),
    "--theaterProfiles",
    args.theaterProfiles,
    "--outDir",
    args.outDir,
  ]);

  runCommand("Step 4 similarity + recommendations", "node", [
    "reelsuccess/scripts/build-similarity-and-recommendations.js",
    "--matrix",
    path.join(args.outDir, "theater_feature_matrix_step3.json"),
    "--theaters",
    path.join(args.outDir, "theaters_step3.json"),
    "--screenings",
    path.join(args.outDir, "screenings_clean_step3.json"),
    "--movieIndex",
    path.join(args.outDir, "movie_index_step3.json"),
    "--outDir",
    args.outDir,
  ]);

  runCommand("Step 5 function payload prep", "node", [
    "reelsuccess/scripts/build-step5-function-data.js",
    "--theaters",
    path.join(args.outDir, "theaters_step3.json"),
    "--similarity",
    path.join(args.outDir, "theater_similarity_topk_step4.json"),
    "--recommendations",
    path.join(args.outDir, "theater_recommendations_step4.json"),
    "--outDir",
    args.functionsDataDir,
  ]);

  if (args.deployFunctions) {
    runCommand("Deploy functions", "firebase", ["deploy", "--only", "functions"]);
  }

  console.log("\n✅ ReelSuccess pipeline completed end-to-end.");
}

main();
