# ReelSuccess – Step 4 (Similarity + Recommendations)

This step computes theater-to-theater similarity and generates movie recommendations.

## Inputs

- [reelsuccess/output/theater_feature_matrix_step3.json](reelsuccess/output/theater_feature_matrix_step3.json)
- [reelsuccess/output/theaters_step3.json](reelsuccess/output/theaters_step3.json)
- [reelsuccess/output/screenings_clean_step3.json](reelsuccess/output/screenings_clean_step3.json)
- [reelsuccess/output/movie_index_step3.json](reelsuccess/output/movie_index_step3.json)

## Outputs

- [reelsuccess/output/theater_similarity_topk_step4.json](reelsuccess/output/theater_similarity_topk_step4.json)
- [reelsuccess/output/theater_recommendations_step4.json](reelsuccess/output/theater_recommendations_step4.json)
- [reelsuccess/output/step4-summary.json](reelsuccess/output/step4-summary.json)

## Run it

```bash
node reelsuccess/scripts/build-similarity-and-recommendations.js \
  --matrix ./reelsuccess/output/theater_feature_matrix_step3.json \
  --theaters ./reelsuccess/output/theaters_step3.json \
  --screenings ./reelsuccess/output/screenings_clean_step3.json \
  --movieIndex ./reelsuccess/output/movie_index_step3.json \
  --outDir ./reelsuccess/output \
  --topKSimilar 15 \
  --topKRecMovies 15 \
  --neighborPool 30
```

## Method

Combined similarity score:

$$
S = w_m \cdot S_{movie} + w_d \cdot S_{demo} + w_o \cdot S_{ops}
$$

Default weights:
- $w_m = 0.60$ (movie overlap signal)
- $w_d = 0.25$ (demographic similarity)
- $w_o = 0.15$ (operational similarity)

Recommendations for each theater are movies from similar theaters that the target theater has not already played, ranked by weighted neighbor support.
