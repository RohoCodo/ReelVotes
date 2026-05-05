#!/usr/bin/env node

/**
 * Step 5 prep for ReelSuccess:
 * Build compact JSON payloads for Cloud Functions API endpoints.
 *
 * Inputs:
 * - theaters_step3.json
 * - theater_similarity_topk_step4.json
 * - theater_recommendations_step4.json
 *
 * Outputs (inside functions/reelsuccess-data):
 * - theater_index.json
 * - theater_insights_by_key.json
 * - metadata.json
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    theaters: path.resolve(process.cwd(), "reelsuccess/output/theaters_step3.json"),
    similarity: path.resolve(process.cwd(), "reelsuccess/output/theater_similarity_topk_step4.json"),
    recommendations: path.resolve(process.cwd(), "reelsuccess/output/theater_recommendations_step4.json"),
    outDir: path.resolve(process.cwd(), "functions/reelsuccess-data"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--theaters") args.theaters = path.resolve(process.cwd(), argv[++i]);
    else if (t === "--similarity") args.similarity = path.resolve(process.cwd(), argv[++i]);
    else if (t === "--recommendations") args.recommendations = path.resolve(process.cwd(), argv[++i]);
    else if (t === "--outDir") args.outDir = path.resolve(process.cwd(), argv[++i]);
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  for (const inputPath of [args.theaters, args.similarity, args.recommendations]) {
    if (!fs.existsSync(inputPath)) {
      console.error(`Missing input: ${inputPath}`);
      process.exit(1);
    }
  }

  fs.mkdirSync(args.outDir, {recursive: true});

  const theaters = JSON.parse(fs.readFileSync(args.theaters, "utf8"));
  const similarity = JSON.parse(fs.readFileSync(args.similarity, "utf8"));
  const recommendations = JSON.parse(fs.readFileSync(args.recommendations, "utf8"));

  const theaterIndex = theaters
    .map((t) => ({
      theater_key: t.theater_key,
      theater_code: t.theater_code,
      theater_name: t.theater_name,
      theater_city_state: t.theater_city_state,
      demographics_status: t.demographics_status,
      city: t.demographics?.city || null,
      state_abbr: t.demographics?.state_abbr || null,
      population: t.demographics?.population || null,
      median_household_income: t.demographics?.median_household_income || null,
      median_age: t.demographics?.median_age || null,
      total_screens: t.total_screens || 0,
      unique_movies: t.unique_movies || 0,
      non_friday_rate: t.non_friday_rate || 0,
    }))
    .sort((a, b) => {
      const cityCmp = String(a.theater_city_state || "").localeCompare(String(b.theater_city_state || ""));
      if (cityCmp !== 0) return cityCmp;
      return String(a.theater_name || "").localeCompare(String(b.theater_name || ""));
    });

  const similarityByKey = similarity.theaters || {};
  const recommendationsByKey = recommendations.theaters || {};

  const theaterInsightsByKey = {};

  for (const t of theaterIndex) {
    const similarityRows = similarityByKey[t.theater_key] || [];
    const recBlock = recommendationsByKey[t.theater_key] || {recommendations: []};

    theaterInsightsByKey[t.theater_key] = {
      profile: t,
      similar_theaters: similarityRows,
      recommendations: recBlock.recommendations || [],
      based_on_similar_theaters: recBlock.based_on_similar_theaters || similarityRows.length || 0,
    };
  }

  const metadata = {
    created_at: new Date().toISOString(),
    source_files: {
      theaters: args.theaters,
      similarity: args.similarity,
      recommendations: args.recommendations,
    },
    theater_count: theaterIndex.length,
    has_similarity_for: Object.keys(similarityByKey).length,
    has_recommendations_for: Object.keys(recommendationsByKey).length,
  };

  const indexPath = path.join(args.outDir, "theater_index.json");
  const insightsPath = path.join(args.outDir, "theater_insights_by_key.json");
  const metadataPath = path.join(args.outDir, "metadata.json");

  fs.writeFileSync(indexPath, JSON.stringify(theaterIndex, null, 2), "utf8");
  fs.writeFileSync(insightsPath, JSON.stringify(theaterInsightsByKey, null, 2), "utf8");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  console.log("Step 5 data prepared for Cloud Functions.");
  console.log(`- ${indexPath}`);
  console.log(`- ${insightsPath}`);
  console.log(`- ${metadataPath}`);
}

main();
