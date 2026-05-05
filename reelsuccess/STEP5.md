# ReelSuccess – Step 5 (API Endpoints)

This step creates deployable Cloud Functions endpoints for ReelSuccess.

## What was added

- Data-prep script:
  - [reelsuccess/scripts/build-step5-function-data.js](reelsuccess/scripts/build-step5-function-data.js)
- Function-ready data files:
  - [functions/reelsuccess-data/theater_index.json](functions/reelsuccess-data/theater_index.json)
  - [functions/reelsuccess-data/theater_insights_by_key.json](functions/reelsuccess-data/theater_insights_by_key.json)
  - [functions/reelsuccess-data/metadata.json](functions/reelsuccess-data/metadata.json)
- New callable endpoints in [functions/index.js](functions/index.js):
  - `reelSuccessListTheaters`
  - `reelSuccessGetTheaterInsights`

## Build function data

```bash
node reelsuccess/scripts/build-step5-function-data.js \
  --theaters ./reelsuccess/output/theaters_step3.json \
  --similarity ./reelsuccess/output/theater_similarity_topk_step4.json \
  --recommendations ./reelsuccess/output/theater_recommendations_step4.json \
  --outDir ./functions/reelsuccess-data
```

## Deploy

```bash
firebase deploy --only functions
```

## Endpoint contracts (callable)

### `reelSuccessListTheaters`
Input:
```json
{ "query": "san francisco", "limit": 25 }
```

Output:
```json
{
  "ok": true,
  "total": 42,
  "limit": 25,
  "dataVersion": "2026-05-02T...Z",
  "theaters": [ ... ]
}
```

### `reelSuccessGetTheaterInsights`
Input:
```json
{ "theaterKey": "AMC|AMC Metreon 16 with IMAX, Dolby|San Francisco, CA" }
```

Output:
```json
{
  "ok": true,
  "dataVersion": "2026-05-02T...Z",
  "profile": { ... },
  "similar_theaters": [ ... ],
  "recommendations": [ ... ],
  "based_on_similar_theaters": 15
}
```

## Important

Whenever Step 4 outputs are regenerated, re-run the Step 5 data-prep script before deploying functions again, so API data stays in sync.
