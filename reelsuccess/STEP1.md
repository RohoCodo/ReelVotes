# ReelSuccess – Step 1 (Data Extraction)

This step extracts raw theater/movie rows from your weekly branch-area PDFs into structured files.

## What this produces

After running the extractor, you get:
- [reelsuccess/output/screenings.json](reelsuccess/output/screenings.json)
- [reelsuccess/output/screenings.csv](reelsuccess/output/screenings.csv)
- [reelsuccess/output/extract-summary.json](reelsuccess/output/extract-summary.json)

## Run it

From the project root, run:

```bash
node reelsuccess/scripts/extract-screenings-from-pdf.js \
  --outDir ./reelsuccess/output \
  /Users/rohantyagi/Downloads/branch_area_20260410_SF.pdf \
  /Users/rohantyagi/Downloads/branch_area_20260410_NY.pdf \
  /Users/rohantyagi/Downloads/branch_area_20260410_LA.pdf
```

## Notes

- The parser pulls PDF text draw commands (`(...) Tj`) and reconstructs rows.
- It captures:
  - week range and calendar week
  - area
  - theater code/name/location
  - movie title
  - screen count
  - non-Friday opening marker (`*`)
- If a PDF format changes, we can tune regexes in [reelsuccess/scripts/extract-screenings-from-pdf.js](reelsuccess/scripts/extract-screenings-from-pdf.js).

## Validation checklist

1. Open [reelsuccess/output/extract-summary.json](reelsuccess/output/extract-summary.json) and confirm rows > 0 for each report.
2. Open [reelsuccess/output/screenings.csv](reelsuccess/output/screenings.csv) and verify samples:
   - theater names look correct
   - movie titles look correct
   - screen counts are numeric
3. If needed, I can add a quality-check script next (duplicates, malformed titles, missing theaters).
