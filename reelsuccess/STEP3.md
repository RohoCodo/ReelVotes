# ReelSuccess – Step 3 (Model-Ready Theater Features)

This step converts raw screening + demographic outputs into a clean feature dataset for similarity scoring.

## Inputs

- [reelsuccess/output/screenings.json](reelsuccess/output/screenings.json)
- [reelsuccess/output/theater_profiles_step2.json](reelsuccess/output/theater_profiles_step2.json)

## Outputs

- [reelsuccess/output/screenings_clean_step3.json](reelsuccess/output/screenings_clean_step3.json)
- [reelsuccess/output/theaters_step3.json](reelsuccess/output/theaters_step3.json)
- [reelsuccess/output/movie_index_step3.json](reelsuccess/output/movie_index_step3.json)
- [reelsuccess/output/theater_feature_matrix_step3.json](reelsuccess/output/theater_feature_matrix_step3.json)
- [reelsuccess/output/step3-summary.json](reelsuccess/output/step3-summary.json)

## Run it

```bash
node reelsuccess/scripts/build-theater-feature-matrix.js \
  --screenings ./reelsuccess/output/screenings.json \
  --theaterProfiles ./reelsuccess/output/theater_profiles_step2.json \
  --outDir ./reelsuccess/output \
  --minMovieTheaters 3
```

## What this does

- Cleans extracted screening rows and removes obvious noise rows from PDF parsing.
- Aggregates performance by theater.
- Builds a shared movie feature index (only movies seen in at least `minMovieTheaters` theaters).
- Produces a sparse movie feature vector per theater.
- Adds normalized (z-score) demographic features per theater.

This is the direct input for Step 4 (similarity scoring and recommendation engine).
