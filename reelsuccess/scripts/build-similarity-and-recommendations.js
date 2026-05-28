#!/usr/bin/env node

/**
 * Step 4 for ReelSuccess:
 * Build theater-to-theater similarity and movie recommendations.
 *
 * Inputs:
 * - theater_feature_matrix_step3.json
 * - theaters_step3.json
 * - screenings_clean_step3.json
 * - movie_index_step3.json
 *
 * Outputs:
 * - theater_similarity_topk_step4.json
 * - theater_recommendations_step4.json
 * - step4-summary.json
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    matrix: path.resolve(process.cwd(), "reelsuccess/output/theater_feature_matrix_step3.json"),
    theaters: path.resolve(process.cwd(), "reelsuccess/output/theaters_step3.json"),
    screenings: path.resolve(process.cwd(), "reelsuccess/output/screenings_clean_step3.json"),
    movieIndex: path.resolve(process.cwd(), "reelsuccess/output/movie_index_step3.json"),
    outDir: path.resolve(process.cwd(), "reelsuccess/output"),
    topKSimilar: 15,
    topKRecMovies: 15,
    neighborPool: 30,
    wHistory: 0.7,
    wMovie: 0.2,
    wDemo: 0.07,
    wOps: 0.03,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--matrix") { args.matrix = path.resolve(process.cwd(), argv[++i]); }
    else if (t === "--theaters") { args.theaters = path.resolve(process.cwd(), argv[++i]); }
    else if (t === "--screenings") { args.screenings = path.resolve(process.cwd(), argv[++i]); }
    else if (t === "--movieIndex") { args.movieIndex = path.resolve(process.cwd(), argv[++i]); }
    else if (t === "--outDir") { args.outDir = path.resolve(process.cwd(), argv[++i]); }
    else if (t === "--topKSimilar") { args.topKSimilar = Number(argv[++i]); }
    else if (t === "--topKRecMovies") { args.topKRecMovies = Number(argv[++i]); }
    else if (t === "--neighborPool") { args.neighborPool = Number(argv[++i]); }
    else if (t === "--wHistory") { args.wHistory = Number(argv[++i]); }
    else if (t === "--wMovie") { args.wMovie = Number(argv[++i]); }
    else if (t === "--wDemo") { args.wDemo = Number(argv[++i]); }
    else if (t === "--wOps") { args.wOps = Number(argv[++i]); }
  }

  return args;
}

function dotSparse(a, b) {
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i][0];
    const bi = b[j][0];
    if (ai === bi) {
      sum += a[i][1] * b[j][1];
      i += 1;
      j += 1;
    } else if (ai < bi) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return sum;
}

function normSparse(a) {
  let s = 0;
  for (const [, v] of a) s += v * v;
  return Math.sqrt(s);
}

function cosineSparse(a, b) {
  const na = normSparse(a);
  const nb = normSparse(b);
  if (na === 0 || nb === 0) return 0;
  return dotSparse(a, b) / (na * nb);
}

function dotDense(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

function normDense(a) {
  return Math.sqrt(dotDense(a, a));
}

function cosineDense(a, b) {
  const na = normDense(a);
  const nb = normDense(b);
  if (na === 0 || nb === 0) return 0;
  return dotDense(a, b) / (na * nb);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function toUnitIntervalFromCosine(v) {
  if (!Number.isFinite(v)) return 0.5;
  return clamp((v + 1) / 2, 0, 1);
}

function similarityConfidence(commonMovieCount, overlapWeight) {
  const common = Math.max(0, Number(commonMovieCount || 0));
  const overlap = Math.max(0, Number(overlapWeight || 0));

  const commonTerm = common / (common + 8);
  const overlapTerm = Math.min(1, Math.sqrt(overlap) / Math.sqrt(26));

  return clamp(Math.sqrt(commonTerm * overlapTerm), 0, 1);
}

function normalizeOp(x, min, max) {
  if (!Number.isFinite(x) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  return (x - min) / (max - min);
}

function performanceCloseness(a, b) {
  const x = Number(a || 0);
  const y = Number(b || 0);
  const denom = Math.max(1, x, y);
  return clamp(1 - (Math.abs(x - y) / denom), 0, 1);
}

function buildMovieHistoryByTheater(screenings) {
  const perTheaterMovie = new Map();

  for (const row of screenings) {
    const theaterKey = row.theater_key;
    const movie = row.movie_title;
    const screens = Number(row.screen_count || 0);

    if (!theaterKey || !movie) continue;

    if (!perTheaterMovie.has(theaterKey)) {
      perTheaterMovie.set(theaterKey, new Map());
    }
    const byMovie = perTheaterMovie.get(theaterKey);

    if (!byMovie.has(movie)) {
      byMovie.set(movie, {
        total_screens: 0,
        week_keys: new Set(),
        non_friday_openings: 0,
      });
    }

    const agg = byMovie.get(movie);
    agg.total_screens += screens;
    agg.week_keys.add(String(row.week_end || row.week_start || ""));
    if (row.non_friday_opening === true) {
      agg.non_friday_openings += 1;
    }
  }

  const finalized = new Map();
  for (const [theaterKey, movieMap] of perTheaterMovie.entries()) {
    const out = new Map();
    for (const [movie, agg] of movieMap.entries()) {
      const weeks = agg.week_keys.size;
      const avgScreensPerWeek = weeks > 0 ? agg.total_screens / weeks : 0;
      out.set(movie, {
        total_screens: agg.total_screens,
        weeks,
        avg_screens_per_week: avgScreensPerWeek,
        non_friday_openings: agg.non_friday_openings,
      });
    }
    finalized.set(theaterKey, out);
  }

  return finalized;
}

function movieHistorySimilarity(aHistory, bHistory) {
  if (!aHistory || !bHistory || aHistory.size === 0 || bHistory.size === 0) {
    return {
      score: 0,
      overlap_score: 0,
      overlap_weight: 0,
      common_movie_count: 0,
      weighted_closeness: 0,
    };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  let common = 0;

  for (const [movie, a] of aHistory.entries()) {
    const b = bHistory.get(movie);
    if (!b) continue;

    common += 1;

    const totalCloseness = performanceCloseness(a.total_screens, b.total_screens);
    const weeklyCloseness = performanceCloseness(a.avg_screens_per_week, b.avg_screens_per_week);
    const runLengthCloseness = performanceCloseness(a.weeks, b.weeks);
    const nonFridayCloseness = performanceCloseness(a.non_friday_openings, b.non_friday_openings);

    const closeness =
      (0.5 * totalCloseness) +
      (0.3 * weeklyCloseness) +
      (0.15 * runLengthCloseness) +
      (0.05 * nonFridayCloseness);

    const importance = Math.log1p(Math.max(1, a.total_screens) + Math.max(1, b.total_screens));
    weightedSum += closeness * importance;
    weightTotal += importance;
  }

  if (common === 0 || weightTotal === 0) {
    return {
      score: 0,
      overlap_score: 0,
      overlap_weight: 0,
      common_movie_count: 0,
      weighted_closeness: 0,
    };
  }

  const weightedCloseness = weightedSum / weightTotal;
  const overlap = common / Math.sqrt(aHistory.size * bHistory.size);
  const overlapScore = clamp(overlap, 0, 1);

  // Strongly favor theater pairs where the same movies historically perform similarly.
  const score = (0.75 * weightedCloseness) + (0.25 * overlapScore);

  return {
    score: clamp(score, 0, 1),
    overlap_score: overlapScore,
    overlap_weight: weightTotal,
    common_movie_count: common,
    weighted_closeness: weightedCloseness,
  };
}

function isLikelyBadMovieTitle(title) {
  const t = String(title || "").trim();
  const tUpper = t.toUpperCase();
  const knownNonMovie = new Set(["W", "CW", "TR", "ND", "NE", "NP", "TC", "N/A", "NA"]);
  if (!t) return true;
  if (knownNonMovie.has(tUpper)) return true;
  if (/^[A-Z]{1,2}$/.test(t)) return true;
  if (/^[A-Z]{1,3}\s*-\s*/.test(t)) return true;
  if (/\b(theatre rented|theater rented|weather|no engagement|not engaged)\b/i.test(t)) return true;
  if (/^[A-Za-z .'/&-]+,\s*[A-Z]{2}$/.test(t)) return true; // city/state-like rows
  if (/^[A-Za-z .'/&-]+\/[A-Za-z .'/&-]+,\s*[A-Z]{2}$/.test(t)) return true; // market rows like Monterey/Salinas, CA
  if (/\bCounty\b/i.test(t)) return true;
  if (/^[A-Za-z .'-]+\s+-\s+[A-Za-z .'-]+$/.test(t)) return true;
  return false;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const req = [args.matrix, args.theaters, args.screenings, args.movieIndex];
  for (const file of req) {
    if (!fs.existsSync(file)) {
      console.error(`Missing file: ${file}`);
      process.exit(1);
    }
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  const matrix = JSON.parse(fs.readFileSync(args.matrix, "utf8"));
  const theaters = JSON.parse(fs.readFileSync(args.theaters, "utf8"));
  const screenings = JSON.parse(fs.readFileSync(args.screenings, "utf8"));
  const movieIndex = JSON.parse(fs.readFileSync(args.movieIndex, "utf8"));

  const theaterByKey = new Map(theaters.map((t) => [t.theater_key, t]));

  const moviesByIdx = new Map(movieIndex.map((m) => [m.feature_index, m.movie_title]));

  const movieHistoryByTheater = buildMovieHistoryByTheater(screenings);

  const playedMoviesByTheater = new Map();
  for (const s of screenings) {
    if (!playedMoviesByTheater.has(s.theater_key)) playedMoviesByTheater.set(s.theater_key, new Set());
    playedMoviesByTheater.get(s.theater_key).add(s.movie_title);
  }

  const opRows = matrix.map((r) => r.operational_features || {});
  const minTotalScreens = Math.min(...opRows.map((r) => Number(r.total_screens || 0)));
  const maxTotalScreens = Math.max(...opRows.map((r) => Number(r.total_screens || 0)));
  const minUniqueMovies = Math.min(...opRows.map((r) => Number(r.unique_movies || 0)));
  const maxUniqueMovies = Math.max(...opRows.map((r) => Number(r.unique_movies || 0)));

  const vectorMap = new Map();
  for (const row of matrix) {
    const demo = row.demographic_features_z || {};
    const demoVector = [
      demo.population || 0,
      demo.median_household_income || 0,
      demo.median_age || 0,
      demo.pct_white_alone || 0,
      demo.pct_black_alone || 0,
      demo.pct_asian_alone || 0,
      demo.pct_hispanic_latino || 0,
      demo.pct_bachelors_degree || 0,
      demo.pct_below_poverty || 0,
    ];

    const ops = row.operational_features || {};
    const opVector = [
      normalizeOp(Number(ops.total_screens || 0), minTotalScreens, maxTotalScreens),
      normalizeOp(Number(ops.unique_movies || 0), minUniqueMovies, maxUniqueMovies),
      clamp(Number(ops.non_friday_rate || 0), 0, 1),
    ];

    vectorMap.set(row.theater_key, {
      movieSparse: row.movie_features_sparse || [],
      demoVector,
      opVector,
    });
  }

  const keys = Array.from(vectorMap.keys());
  const similarityByTheater = {};

  for (let i = 0; i < keys.length; i += 1) {
    const aKey = keys[i];
    const a = vectorMap.get(aKey);
    const sims = [];

    for (let j = 0; j < keys.length; j += 1) {
      if (i === j) continue;
      const bKey = keys[j];
      const b = vectorMap.get(bKey);

      const movieSim = cosineSparse(a.movieSparse, b.movieSparse);
      const demoSim = cosineDense(a.demoVector, b.demoVector);
      const opSim = cosineDense(a.opVector, b.opVector);

      const movieSim01 = toUnitIntervalFromCosine(movieSim);
      const demoSim01 = toUnitIntervalFromCosine(demoSim);
      const opSim01 = toUnitIntervalFromCosine(opSim);

      const historyStats = movieHistorySimilarity(movieHistoryByTheater.get(aKey), movieHistoryByTheater.get(bKey));

      // Weights: 75% movie history (primary driver), 15% demographics, 5% feature, 5% ops
      const rawCombined =
        0.75 * historyStats.score +
        0.15 * demoSim01 +
        0.05 * movieSim01 +
        0.05 * opSim01;

      const confidence = similarityConfidence(
        historyStats.common_movie_count,
        historyStats.overlap_weight,
      );

      const combined = (confidence * rawCombined) + ((1 - confidence) * 0.5);

      if (historyStats.common_movie_count < 5) continue;
      if (historyStats.overlap_score < 0.08) continue;

      sims.push({
        theater_key: bKey,
        score: Number(combined.toFixed(6)),
        raw_score: Number(rawCombined.toFixed(6)),
        confidence: Number(confidence.toFixed(6)),
        historical_similarity: Number(historyStats.score.toFixed(6)),
        historical_overlap_score: Number(historyStats.overlap_score.toFixed(6)),
        historical_overlap_weight: Number(historyStats.overlap_weight.toFixed(6)),
        historical_common_movies: historyStats.common_movie_count,
        historical_weighted_closeness: Number(historyStats.weighted_closeness.toFixed(6)),
        movie_similarity: Number(movieSim01.toFixed(6)),
        demographic_similarity: Number(demoSim01.toFixed(6)),
        operational_similarity: Number(opSim01.toFixed(6)),
      });
    }

    sims.sort((x, y) => y.score - x.score);

    similarityByTheater[aKey] = sims.slice(0, args.topKSimilar).map((s) => ({
      ...s,
      theater_name: theaterByKey.get(s.theater_key)?.theater_name || "",
      theater_city_state: theaterByKey.get(s.theater_key)?.theater_city_state || "",
    }));
  }

  const recsByTheater = {};
  let recRowCount = 0;

  for (const aKey of keys) {
    const neighbors = (similarityByTheater[aKey] || []).slice(0, args.neighborPool);
    const played = playedMoviesByTheater.get(aKey) || new Set();

    const candidate = new Map();

    for (const n of neighbors) {
      const nKey = n.theater_key;
      const nVec = vectorMap.get(nKey);
      if (!nVec) continue;

      for (const [movieIdx, weight] of nVec.movieSparse) {
        const movieTitle = moviesByIdx.get(movieIdx);
        if (!movieTitle) continue;
        if (isLikelyBadMovieTitle(movieTitle)) continue;
        if (played.has(movieTitle)) continue;

        const prev = candidate.get(movieTitle) || {
          movie_title: movieTitle,
          recommendation_score: 0,
          support_theater_count: 0,
          weighted_movie_signal: 0,
          similar_theaters: [],
        };

        const contrib = n.score * weight;
        prev.recommendation_score += contrib;
        prev.weighted_movie_signal += contrib;
        prev.support_theater_count += 1;

        if (prev.similar_theaters.length < 5) {
          prev.similar_theaters.push({
            theater_key: nKey,
            theater_name: theaterByKey.get(nKey)?.theater_name || "",
            theater_city_state: theaterByKey.get(nKey)?.theater_city_state || "",
            similarity_score: n.score,
            movie_weight_at_neighbor: Number(weight.toFixed(6)),
          });
        }

        candidate.set(movieTitle, prev);
      }
    }

    const ranked = Array.from(candidate.values())
      .map((r) => ({
        ...r,
        recommendation_score: Number(r.recommendation_score.toFixed(6)),
        weighted_movie_signal: Number(r.weighted_movie_signal.toFixed(6)),
      }))
      .sort((x, y) => y.recommendation_score - x.recommendation_score)
      .slice(0, args.topKRecMovies);

    recsByTheater[aKey] = {
      theater_key: aKey,
      theater_name: theaterByKey.get(aKey)?.theater_name || "",
      theater_city_state: theaterByKey.get(aKey)?.theater_city_state || "",
      based_on_similar_theaters: neighbors.length,
      recommendations: ranked,
    };

    recRowCount += ranked.length;
  }

  const similarityOutput = {
    created_at: new Date().toISOString(),
    params: {
      topKSimilar: args.topKSimilar,
      weights: { history: 0.65, movie: 0.20, demographics: 0.10, operations: 0.05 },
      confidence: {
        common_movie_k: 8,
        overlap_weight_target: 26,
        prior_similarity: 0.5,
      },
      neighbor_floor: {
        min_common_movies: 5,
        min_overlap_score: 0.08,
      },
    },
    theaters: similarityByTheater,
  };

  const recommendationOutput = {
    created_at: new Date().toISOString(),
    params: {
      topKRecMovies: args.topKRecMovies,
      neighborPool: args.neighborPool,
      similarityWeights: { history: args.wHistory, movie: args.wMovie, demographics: args.wDemo, operations: args.wOps },
    },
    theaters: recsByTheater,
  };

  const outSimilarity = path.join(args.outDir, "theater_similarity_topk_step4.json");
  const outRecs = path.join(args.outDir, "theater_recommendations_step4.json");
  const outSummary = path.join(args.outDir, "step4-summary.json");

  fs.writeFileSync(outSimilarity, JSON.stringify(similarityOutput, null, 2), "utf8");
  fs.writeFileSync(outRecs, JSON.stringify(recommendationOutput, null, 2), "utf8");

  const summary = {
    inputs: {
      matrix: args.matrix,
      theaters: args.theaters,
      screenings: args.screenings,
      movieIndex: args.movieIndex,
    },
    params: {
      topKSimilar: args.topKSimilar,
      topKRecMovies: args.topKRecMovies,
      neighborPool: args.neighborPool,
      weights: { history: args.wHistory, movie: args.wMovie, demographics: args.wDemo, operations: args.wOps },
    },
    counts: {
      theaters: keys.length,
      recommendation_rows_total: recRowCount,
      avg_recommendations_per_theater: Number((recRowCount / Math.max(1, keys.length)).toFixed(2)),
    },
    outputs: {
      similarity: outSimilarity,
      recommendations: outRecs,
    },
  };

  fs.writeFileSync(outSummary, JSON.stringify(summary, null, 2), "utf8");

  console.log("Step 4 complete.");
  console.log(JSON.stringify(summary, null, 2));
}

main();
