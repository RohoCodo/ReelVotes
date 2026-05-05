# ReelSuccess – Step 2 (Demographic Enrichment)

This step enriches unique theaters with open US Census demographics based on `theater_city_state`.

## Input

- [reelsuccess/output/screenings.json](reelsuccess/output/screenings.json)

## Output

- [reelsuccess/output/theater_profiles_step2.json](reelsuccess/output/theater_profiles_step2.json)
- [reelsuccess/output/theater_profiles_step2.csv](reelsuccess/output/theater_profiles_step2.csv)
- [reelsuccess/output/city_demographics.json](reelsuccess/output/city_demographics.json)
- [reelsuccess/output/step2-summary.json](reelsuccess/output/step2-summary.json)

## Run it

```bash
node reelsuccess/scripts/enrich-theaters-with-demographics.js \
  --input ./reelsuccess/output/screenings.json \
  --outDir ./reelsuccess/output \
  --year 2023
```

## Demographics added

- total population
- median household income
- median age
- % white, % black, % asian, % hispanic/latino
- % bachelor's degree (25+)
- % below poverty line

## Notes

- Source: US Census ACS 5-year API.
- Matching is by city/state with fuzzy normalization against Census place names.
- If no city match is found, row is marked `demographics_status: no-match`.
- If API fails for a state, row is marked `demographics_status: api-error`.
