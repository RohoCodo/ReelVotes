#!/usr/bin/env node

/**
 * Step 3 for ReelSuccess:
 * Build a clean, model-ready theater dataset + feature matrix for similarity scoring.
 *
 * Inputs:
 * - screenings.json (Step 1)
 * - theater_profiles_step2.json (Step 2)
 *
 * Outputs:
 * - screenings_clean_step3.json
 * - theaters_step3.json
 * - movie_index_step3.json
 * - theater_feature_matrix_step3.json
 * - step3-summary.json
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    screenings: path.resolve(process.cwd(), "reelsuccess/output/screenings.json"),
    theaterProfiles: path.resolve(process.cwd(), "reelsuccess/output/theater_profiles_step2.json"),
    outDir: path.resolve(process.cwd(), "reelsuccess/output"),
    minMovieTheaters: 3,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--screenings") {
      args.screenings = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (token === "--theaterProfiles") {
      args.theaterProfiles = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (token === "--outDir") {
      args.outDir = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (token === "--minMovieTheaters") {
      args.minMovieTheaters = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

function normalizeMovieTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .replace(/[’]/g, "'")
    .trim();
}

function isNoiseMovieTitle(title) {
  const t = String(title || "").trim();
  if (!t) return true;
  if (/^[-+]?\d+%[,]?\d*$/i.test(t)) return true;
  if (/^[-+]?\d+[\d,]*(\.\d+)?$/.test(t)) return true;
  if (/^(total|gross)$/i.test(t)) return true;
  if (/^(data valid as of:|page\s+\d+\s+of\s+\d+)/i.test(t)) return true;
  if (/^# denotes/i.test(t) || /^\* denotes/i.test(t)) return true;
  if (/^[A-Za-z .'/&-]+,\s*[A-Z]{2}$/.test(t)) return true;
  if (/^[A-Za-z .'/&-]+\/[A-Za-z .'/&-]+,\s*[A-Z]{2}$/.test(t)) return true;
  if (/\bCounty\b/i.test(t)) return true;
  return false;
}

function keyForTheater(row) {
  return [row.theater_code, row.theater_name, row.theater_city_state].join("|");
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function zScore(value, mean, sd) {
  if (!Number.isFinite(value) || !Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) return 0;
  return (value - mean) / sd;
}

function stats(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return { mean: 0, sd: 1 };
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((acc, v) => acc + (v - mean) ** 2, 0) / clean.length;
  const sd = Math.sqrt(variance);
  return { mean, sd: sd || 1 };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.screenings)) {
    console.error(`Missing screenings file: ${args.screenings}`);
    process.exit(1);
  }
  if (!fs.existsSync(args.theaterProfiles)) {
    console.error(`Missing theater profiles file: ${args.theaterProfiles}`);
    process.exit(1);
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  const screenings = JSON.parse(fs.readFileSync(args.screenings, "utf8"));
  const theaterProfiles = JSON.parse(fs.readFileSync(args.theaterProfiles, "utf8"));

  const profileMap = new Map();
  for (const p of theaterProfiles) {
    profileMap.set([p.theater_code, p.theater_name, p.theater_city_state].join("|"), p);
  }

  const cleaned = [];
  let droppedNoiseTitles = 0;

  for (const row of screenings) {
    const movie = normalizeMovieTitle(row.movie_title);
    if (isNoiseMovieTitle(movie)) {
      droppedNoiseTitles += 1;
      continue;
    }

    cleaned.push({
      ...row,
      movie_title: movie,
      screen_count: toNumber(row.screen_count),
      non_friday_opening: row.non_friday_opening === true,
      theater_key: keyForTheater(row),
    });
  }

  const theaterAgg = new Map();
  const movieToTheaters = new Map();

  for (const row of cleaned) {
    if (!theaterAgg.has(row.theater_key)) {
      theaterAgg.set(row.theater_key, {
        theater_key: row.theater_key,
        theater_code: row.theater_code,
        theater_name: row.theater_name,
        theater_city_state: row.theater_city_state,
        total_rows: 0,
        total_screens: 0,
        non_friday_count: 0,
        movie_screen_counts: new Map(),
      });
    }

    const t = theaterAgg.get(row.theater_key);
    t.total_rows += 1;
    t.total_screens += toNumber(row.screen_count);
    if (row.non_friday_opening) t.non_friday_count += 1;

    t.movie_screen_counts.set(
      row.movie_title,
      (t.movie_screen_counts.get(row.movie_title) || 0) + toNumber(row.screen_count)
    );

    if (!movieToTheaters.has(row.movie_title)) movieToTheaters.set(row.movie_title, new Set());
    movieToTheaters.get(row.movie_title).add(row.theater_key);
  }

  const selectedMovies = Array.from(movieToTheaters.entries())
    .filter(([, theaterSet]) => theaterSet.size >= args.minMovieTheaters)
    .map(([title]) => title)
    .sort((a, b) => a.localeCompare(b));

  const movieIndex = selectedMovies.map((movie_title, idx) => ({
    feature_index: idx,
    movie_title,
    theater_count: movieToTheaters.get(movie_title)?.size || 0,
  }));

  const movieIndexMap = new Map(movieIndex.map((m) => [m.movie_title, m.feature_index]));

  const theaters = [];
  const matrixRows = [];

  const demoVectors = [];
  for (const [, t] of theaterAgg) {
    const profile = profileMap.get(t.theater_key) || null;
    const d = profile?.demographics || null;

    const theaterObj = {
      theater_key: t.theater_key,
      theater_code: t.theater_code,
      theater_name: t.theater_name,
      theater_city_state: t.theater_city_state,
      demographics_status: profile?.demographics_status || "missing-profile",
      demographics: d,
      total_rows: t.total_rows,
      total_screens: t.total_screens,
      unique_movies: t.movie_screen_counts.size,
      non_friday_rate: t.total_rows > 0 ? Number((t.non_friday_count / t.total_rows).toFixed(4)) : 0,
      top_movies: Array.from(t.movie_screen_counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([movie_title, screen_count]) => ({ movie_title, screen_count })),
    };

    theaters.push(theaterObj);

    demoVectors.push({
      theater_key: t.theater_key,
      population: d?.population ?? null,
      median_household_income: d?.median_household_income ?? null,
      median_age: d?.median_age ?? null,
      pct_white_alone: d?.pct_white_alone ?? null,
      pct_black_alone: d?.pct_black_alone ?? null,
      pct_asian_alone: d?.pct_asian_alone ?? null,
      pct_hispanic_latino: d?.pct_hispanic_latino ?? null,
      pct_bachelors_degree: d?.pct_bachelors_degree ?? null,
      pct_below_poverty: d?.pct_below_poverty ?? null,
    });
  }

  const demoFields = [
    "population",
    "median_household_income",
    "median_age",
    "pct_white_alone",
    "pct_black_alone",
    "pct_asian_alone",
    "pct_hispanic_latino",
    "pct_bachelors_degree",
    "pct_below_poverty",
  ];

  const demoStats = {};
  for (const field of demoFields) {
    demoStats[field] = stats(demoVectors.map((v) => v[field]).filter((v) => v !== null));
  }

  for (const [, t] of theaterAgg) {
    const profile = profileMap.get(t.theater_key) || null;
    const d = profile?.demographics || null;

    const movieFeatures = [];
    let movieWeightSum = 0;
    for (const [movie, screenCount] of t.movie_screen_counts.entries()) {
      const idx = movieIndexMap.get(movie);
      if (idx == null) continue;
      movieFeatures.push([idx, screenCount]);
      movieWeightSum += screenCount;
    }

    movieFeatures.sort((a, b) => a[0] - b[0]);

    const movieFeaturesNormalized = movieFeatures.map(([idx, weight]) => [idx, movieWeightSum > 0 ? Number((weight / movieWeightSum).toFixed(6)) : 0]);

    const demographicFeatures = {};
    for (const field of demoFields) {
      const raw = d?.[field];
      demographicFeatures[field] = Number(zScore(raw, demoStats[field].mean, demoStats[field].sd).toFixed(6));
    }

    matrixRows.push({
      theater_key: t.theater_key,
      movie_features_sparse: movieFeaturesNormalized,
      demographic_features_z: demographicFeatures,
      operational_features: {
        total_screens: t.total_screens,
        unique_movies: t.movie_screen_counts.size,
        non_friday_rate: t.total_rows > 0 ? Number((t.non_friday_count / t.total_rows).toFixed(6)) : 0,
      },
    });
  }

  const outClean = path.join(args.outDir, "screenings_clean_step3.json");
  const outTheaters = path.join(args.outDir, "theaters_step3.json");
  const outMovieIndex = path.join(args.outDir, "movie_index_step3.json");
  const outMatrix = path.join(args.outDir, "theater_feature_matrix_step3.json");
  const outSummary = path.join(args.outDir, "step3-summary.json");

  fs.writeFileSync(outClean, JSON.stringify(cleaned, null, 2), "utf8");
  fs.writeFileSync(outTheaters, JSON.stringify(theaters, null, 2), "utf8");
  fs.writeFileSync(outMovieIndex, JSON.stringify(movieIndex, null, 2), "utf8");
  fs.writeFileSync(outMatrix, JSON.stringify(matrixRows, null, 2), "utf8");

  const summary = {
    inputs: {
      screenings: args.screenings,
      theaterProfiles: args.theaterProfiles,
    },
    thresholds: {
      minMovieTheaters: args.minMovieTheaters,
    },
    counts: {
      screenings_raw: screenings.length,
      screenings_clean: cleaned.length,
      dropped_noise_titles: droppedNoiseTitles,
      unique_theaters: theaters.length,
      movie_features: movieIndex.length,
      matrix_rows: matrixRows.length,
    },
    outputs: {
      screenings_clean: outClean,
      theaters: outTheaters,
      movie_index: outMovieIndex,
      feature_matrix: outMatrix,
    },
  };

  fs.writeFileSync(outSummary, JSON.stringify(summary, null, 2), "utf8");

  console.log("Step 3 complete.");
  console.log(JSON.stringify(summary, null, 2));
}

main();
