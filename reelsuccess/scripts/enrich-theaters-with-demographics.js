#!/usr/bin/env node

/**
 * Step 2 for ReelSuccess:
 * Enrich unique theaters with open US Census ACS demographics by city/state.
 *
 * Usage:
 *   node reelsuccess/scripts/enrich-theaters-with-demographics.js \
 *     --input ./reelsuccess/output/screenings.json \
 *     --outDir ./reelsuccess/output \
 *     --year 2023
 */

const fs = require("fs");
const path = require("path");

const STATE_META = {
  AL: { fips: "01", name: "Alabama" }, AK: { fips: "02", name: "Alaska" }, AZ: { fips: "04", name: "Arizona" },
  AR: { fips: "05", name: "Arkansas" }, CA: { fips: "06", name: "California" }, CO: { fips: "08", name: "Colorado" },
  CT: { fips: "09", name: "Connecticut" }, DE: { fips: "10", name: "Delaware" }, DC: { fips: "11", name: "District of Columbia" },
  FL: { fips: "12", name: "Florida" }, GA: { fips: "13", name: "Georgia" }, HI: { fips: "15", name: "Hawaii" },
  ID: { fips: "16", name: "Idaho" }, IL: { fips: "17", name: "Illinois" }, IN: { fips: "18", name: "Indiana" },
  IA: { fips: "19", name: "Iowa" }, KS: { fips: "20", name: "Kansas" }, KY: { fips: "21", name: "Kentucky" },
  LA: { fips: "22", name: "Louisiana" }, ME: { fips: "23", name: "Maine" }, MD: { fips: "24", name: "Maryland" },
  MA: { fips: "25", name: "Massachusetts" }, MI: { fips: "26", name: "Michigan" }, MN: { fips: "27", name: "Minnesota" },
  MS: { fips: "28", name: "Mississippi" }, MO: { fips: "29", name: "Missouri" }, MT: { fips: "30", name: "Montana" },
  NE: { fips: "31", name: "Nebraska" }, NV: { fips: "32", name: "Nevada" }, NH: { fips: "33", name: "New Hampshire" },
  NJ: { fips: "34", name: "New Jersey" }, NM: { fips: "35", name: "New Mexico" }, NY: { fips: "36", name: "New York" },
  NC: { fips: "37", name: "North Carolina" }, ND: { fips: "38", name: "North Dakota" }, OH: { fips: "39", name: "Ohio" },
  OK: { fips: "40", name: "Oklahoma" }, OR: { fips: "41", name: "Oregon" }, PA: { fips: "42", name: "Pennsylvania" },
  RI: { fips: "44", name: "Rhode Island" }, SC: { fips: "45", name: "South Carolina" }, SD: { fips: "46", name: "South Dakota" },
  TN: { fips: "47", name: "Tennessee" }, TX: { fips: "48", name: "Texas" }, UT: { fips: "49", name: "Utah" },
  VT: { fips: "50", name: "Vermont" }, VA: { fips: "51", name: "Virginia" }, WA: { fips: "53", name: "Washington" },
  WV: { fips: "54", name: "West Virginia" }, WI: { fips: "55", name: "Wisconsin" }, WY: { fips: "56", name: "Wyoming" },
  GU: { fips: "66", name: "Guam" },
};

const ACS_VARIABLES = [
  "NAME",
  "B01003_001E", // total population
  "B19013_001E", // median household income
  "B01002_001E", // median age
  "B02001_002E", // white alone
  "B02001_003E", // black alone
  "B02001_005E", // asian alone
  "B03003_003E", // hispanic or latino
  "B15003_001E", // education population 25+
  "B15003_022E", // bachelor's degree
  "B17001_001E", // poverty universe
  "B17001_002E", // below poverty
];

const CITY_ALIASES = {
  "brooklyn,ny": "New York",
  "queens,ny": "New York",
  "bronx,ny": "New York",
  "staten island,ny": "New York",
  "manhattan,ny": "New York",
  "forest hills,ny": "New York",
  "astoria,ny": "New York",
  "flushing,ny": "New York",
  "bayside,ny": "New York",
  "fresh meadows,ny": "New York",
  "glendale,ny": "New York",
  "williamsburg - brooklyn,ny": "New York",
  "la jolla,ca": "San Diego",
  "north hollywood,ca": "Los Angeles",
};

function parseArgs(argv) {
  const args = {
    input: path.resolve(process.cwd(), "reelsuccess/output/screenings.json"),
    outDir: path.resolve(process.cwd(), "reelsuccess/output"),
    year: "2023",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") {
      args.input = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (token === "--outDir") {
      args.outDir = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    } else if (token === "--year") {
      args.year = String(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(city|town|village|cdp|municipality|borough)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCompact(s) {
  return normalizeText(s).replace(/\s+/g, "");
}

function tokenize(s) {
  return normalizeText(s).split(" ").filter(Boolean);
}

function tokenJaccard(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

function parseCityState(cityState) {
  const m = String(cityState || "").match(/^(.+?),\s*([A-Z]{2})$/);
  if (!m) return null;
  return { city: m[1].trim(), stateAbbr: m[2].trim() };
}

function resolveAliasedCity(city, stateAbbr) {
  const key = `${String(city || "").trim().toLowerCase()},${String(stateAbbr || "").trim().toLowerCase()}`;
  return CITY_ALIASES[key] || city;
}

function toNumber(value) {
  if (value == null || value === "" || value === "null") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Number(((part / whole) * 100).toFixed(2));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

async function getPlacesForState(stateAbbr, year, cache) {
  if (cache[stateAbbr]) return cache[stateAbbr];

  const meta = STATE_META[stateAbbr];
  if (!meta) {
    cache[stateAbbr] = [];
    return cache[stateAbbr];
  }

  const getFields = ACS_VARIABLES.join(",");
  const url = `https://api.census.gov/data/${year}/acs/acs5?get=${encodeURIComponent(getFields)}&for=place:*&in=state:${meta.fips}`;

  const data = await fetchJson(url);
  const [header, ...rows] = data;

  const places = rows.map((row) => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = row[idx]; });
    return obj;
  });

  cache[stateAbbr] = places;
  return places;
}

function pickBestPlaceMatch(city, stateAbbr, places) {
  const aliasCity = resolveAliasedCity(city, stateAbbr);
  const target = normalizeText(aliasCity);
  const targetCompact = normalizeCompact(aliasCity);
  if (!target) return null;

  const candidates = places
    .map((p) => {
      const name = String(p.NAME || "");
      const placeName = name.split(",")[0] || "";
      const normalized = normalizeText(placeName);
      const normalizedCompact = normalizeCompact(placeName);

      let score = 0;
      if (normalized === target) score = 100;
      else if (normalizedCompact === targetCompact) score = 95;
      else if (normalized.startsWith(target) || target.startsWith(normalized)) score = 80;
      else if (normalized.includes(target) || target.includes(normalized) || normalizedCompact.includes(targetCompact) || targetCompact.includes(normalizedCompact)) score = 60;
      else {
        const jacc = tokenJaccard(normalized, target);
        if (jacc >= 0.75) score = 55;
        else if (jacc >= 0.5) score = 45;
      }

      return { p, name, normalized, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return candidates.length ? candidates[0] : null;
}

function buildDemographicRecord(match, city, stateAbbr, year) {
  const p = match.p;

  const population = toNumber(p.B01003_001E);
  const medianHouseholdIncome = toNumber(p.B19013_001E);
  const medianAge = toNumber(p.B01002_001E);

  const whiteAlone = toNumber(p.B02001_002E);
  const blackAlone = toNumber(p.B02001_003E);
  const asianAlone = toNumber(p.B02001_005E);
  const hispanicLatino = toNumber(p.B03003_003E);

  const eduPop25Plus = toNumber(p.B15003_001E);
  const bachelors = toNumber(p.B15003_022E);

  const povertyUniverse = toNumber(p.B17001_001E);
  const povertyCount = toNumber(p.B17001_002E);

  return {
    source: `US Census ACS5 ${year}`,
    matched_place_name: p.NAME,
    match_score: match.score,
    city,
    state_abbr: stateAbbr,
    population,
    median_household_income: medianHouseholdIncome,
    median_age: medianAge,
    pct_white_alone: pct(whiteAlone, population),
    pct_black_alone: pct(blackAlone, population),
    pct_asian_alone: pct(asianAlone, population),
    pct_hispanic_latino: pct(hispanicLatino, population),
    pct_bachelors_degree: pct(bachelors, eduPop25Plus),
    pct_below_poverty: pct(povertyCount, povertyUniverse),
  };
}

function writeCsv(filePath, rows, headers) {
  const csvEscape = (value) => {
    const s = value == null ? "" : String(value);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.input)) {
    console.error(`Input not found: ${args.input}`);
    process.exit(1);
  }

  fs.mkdirSync(args.outDir, { recursive: true });

  const screenings = JSON.parse(fs.readFileSync(args.input, "utf8"));

  const theaterMap = new Map();
  for (const row of screenings) {
    const key = [row.theater_code, row.theater_name, row.theater_city_state].join("|");
    if (!theaterMap.has(key)) {
      theaterMap.set(key, {
        theater_code: row.theater_code,
        theater_name: row.theater_name,
        theater_city_state: row.theater_city_state,
      });
    }
  }

  const theaters = Array.from(theaterMap.values());
  const stateCache = {};
  const cityDemoCache = new Map();

  const enrichedTheaters = [];
  let matchedCount = 0;
  let unmatchedCount = 0;

  for (const theater of theaters) {
    const parsed = parseCityState(theater.theater_city_state);
    if (!parsed) {
      unmatchedCount += 1;
      enrichedTheaters.push({ ...theater, demographics: null, demographics_status: "invalid-city-state" });
      continue;
    }

    const cityStateKey = `${parsed.city}|${parsed.stateAbbr}`;

    if (!cityDemoCache.has(cityStateKey)) {
      try {
        const places = await getPlacesForState(parsed.stateAbbr, args.year, stateCache);
        const match = pickBestPlaceMatch(parsed.city, parsed.stateAbbr, places);
        if (!match) {
          cityDemoCache.set(cityStateKey, null);
        } else {
          cityDemoCache.set(cityStateKey, buildDemographicRecord(match, parsed.city, parsed.stateAbbr, args.year));
        }
      } catch (error) {
        cityDemoCache.set(cityStateKey, { error: String(error.message || error) });
      }
    }

    const demographics = cityDemoCache.get(cityStateKey);

    if (demographics && !demographics.error) {
      matchedCount += 1;
      enrichedTheaters.push({
        ...theater,
        city: parsed.city,
        state_abbr: parsed.stateAbbr,
        demographics,
        demographics_status: "matched",
      });
    } else {
      unmatchedCount += 1;
      enrichedTheaters.push({
        ...theater,
        city: parsed.city,
        state_abbr: parsed.stateAbbr,
        demographics: null,
        demographics_status: demographics?.error ? "api-error" : "no-match",
        demographics_error: demographics?.error || null,
      });
    }
  }

  const cityDemographics = Array.from(cityDemoCache.entries()).map(([key, value]) => {
    const [city, state_abbr] = key.split("|");
    return {
      city,
      state_abbr,
      demographics: value && !value.error ? value : null,
      status: !value ? "no-match" : value.error ? "api-error" : "matched",
      error: value && value.error ? value.error : null,
    };
  });

  const outProfilesJson = path.join(args.outDir, "theater_profiles_step2.json");
  const outCityJson = path.join(args.outDir, "city_demographics.json");
  const outProfilesCsv = path.join(args.outDir, "theater_profiles_step2.csv");
  const outSummary = path.join(args.outDir, "step2-summary.json");

  fs.writeFileSync(outProfilesJson, JSON.stringify(enrichedTheaters, null, 2), "utf8");
  fs.writeFileSync(outCityJson, JSON.stringify(cityDemographics, null, 2), "utf8");

  writeCsv(
    outProfilesCsv,
    enrichedTheaters.map((t) => ({
      theater_code: t.theater_code,
      theater_name: t.theater_name,
      theater_city_state: t.theater_city_state,
      city: t.city || "",
      state_abbr: t.state_abbr || "",
      demographics_status: t.demographics_status,
      population: t.demographics?.population ?? "",
      median_household_income: t.demographics?.median_household_income ?? "",
      median_age: t.demographics?.median_age ?? "",
      pct_white_alone: t.demographics?.pct_white_alone ?? "",
      pct_black_alone: t.demographics?.pct_black_alone ?? "",
      pct_asian_alone: t.demographics?.pct_asian_alone ?? "",
      pct_hispanic_latino: t.demographics?.pct_hispanic_latino ?? "",
      pct_bachelors_degree: t.demographics?.pct_bachelors_degree ?? "",
      pct_below_poverty: t.demographics?.pct_below_poverty ?? "",
      matched_place_name: t.demographics?.matched_place_name ?? "",
      source: t.demographics?.source ?? "",
    })),
    [
      "theater_code",
      "theater_name",
      "theater_city_state",
      "city",
      "state_abbr",
      "demographics_status",
      "population",
      "median_household_income",
      "median_age",
      "pct_white_alone",
      "pct_black_alone",
      "pct_asian_alone",
      "pct_hispanic_latino",
      "pct_bachelors_degree",
      "pct_below_poverty",
      "matched_place_name",
      "source",
    ]
  );

  const summary = {
    input: args.input,
    year: args.year,
    unique_theaters: theaters.length,
    unique_city_state_pairs: cityDemoCache.size,
    matched_theaters: matchedCount,
    unmatched_theaters: unmatchedCount,
    outputs: {
      theater_profiles_json: outProfilesJson,
      theater_profiles_csv: outProfilesCsv,
      city_demographics_json: outCityJson,
    },
  };

  fs.writeFileSync(outSummary, JSON.stringify(summary, null, 2), "utf8");

  console.log(`Step 2 complete. Enriched ${matchedCount}/${theaters.length} theaters.`);
  console.log(`- ${outProfilesJson}`);
  console.log(`- ${outProfilesCsv}`);
  console.log(`- ${outCityJson}`);
  console.log(`- ${outSummary}`);
}

main().catch((error) => {
  console.error("Step 2 failed:", error);
  process.exit(1);
});
