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
    wMovie: 0.6,
    wDemo: 0.25,
    wOps: 0.15,
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

function normalizeOp(x, min, max) {
  if (!Number.isFinite(x) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  return (x - min) / (max - min);
}

function isLikelyBadMovieTitle(title) {
  const t = String(title || "").trim();
  if (!t) return true;
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

      const combined =
        args.wMovie * movieSim +
        args.wDemo * demoSim +
        args.wOps * opSim;

      sims.push({
        theater_key: bKey,
        score: Number(combined.toFixed(6)),
        movie_similarity: Number(movieSim.toFixed(6)),
        demographic_similarity: Number(demoSim.toFixed(6)),
        operational_similarity: Number(opSim.toFixed(6)),
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
      weights: { movie: args.wMovie, demographics: args.wDemo, operations: args.wOps },
    },
    theaters: similarityByTheater,
  };

  const recommendationOutput = {
    created_at: new Date().toISOString(),
    params: {
      topKRecMovies: args.topKRecMovies,
      neighborPool: args.neighborPool,
      similarityWeights: { movie: args.wMovie, demographics: args.wDemo, operations: args.wOps },
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
      weights: { movie: args.wMovie, demographics: args.wDemo, operations: args.wOps },
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
