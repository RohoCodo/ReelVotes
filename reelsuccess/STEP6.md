# ReelSuccess – Step 6 (Dashboard UI)

Step 6 is now implemented.

## Added pages

- [public/reelsuccess.html](public/reelsuccess.html)
- [public/reelsuccess.js](public/reelsuccess.js)

Mirror files for local root testing:
- [reelsuccess.html](reelsuccess.html)
- [reelsuccess.js](reelsuccess.js)

## Added backend security

ReelSuccess callable functions now require an admin/programmer email:

- [functions/index.js](functions/index.js)
  - `reelSuccessListTheaters` requires `adminEmail`
  - `reelSuccessGetTheaterInsights` requires `adminEmail`

## Added navigation

- [public/index.html](public/index.html) now links to ReelSuccess.
- [index.html](index.html) mirror updated.

## Styling

- ReelSuccess-specific styles added to:
  - [public/styles.css](public/styles.css)
  - [styles.css](styles.css)

## How to use

1. Deploy functions:
```bash
firebase deploy --only functions
```

2. Deploy hosting:
```bash
firebase deploy --only hosting
```

3. Open:
- `/reelsuccess.html`

4. Enter an allowed admin/programmer email when prompted.
5. Search/select a theater.
6. View profile, similar theaters, and recommended movies.
