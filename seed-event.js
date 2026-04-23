/**
 * Seed script: creates events/np-2026-05-26-1830/movies documents in Firestore.
 * Run from the project root: node seed-event.js
 */

const admin = require("./functions/node_modules/firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "reelconvo"
});

const db = admin.firestore();

const EVENT_ID = "np-2026-05-26-1830";

const MOVIES = [
  "Back to the Future",
  "Jurassic Park",
  "Blade Runner",
  "In The Mood For Love",
  "Mean Girls",
  "Bring It On",
  "The Notebook",
  "Blade",
  "Battle Royale",
  "Mad Max: Fury Road"
];

function toDocId(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")   // strip special chars (colons, apostrophes, etc.)
    .trim()
    .replace(/\s+/g, "_");
}

const now = admin.firestore.Timestamp.now();

async function seed() {
  const batch = db.batch();

  for (const title of MOVIES) {
    const docId = toDocId(title);
    const ref = db.collection("events").doc(EVENT_ID).collection("movies").doc(docId);
    batch.set(ref, {
      created_at: now,
      event_id: EVENT_ID,
      movie_title: title,
      updated_at: now,
      vote_count: 0
    });
    console.log(`  Queued: ${docId} → "${title}"`);
  }

  await batch.commit();
  console.log(`\n✅ Seeded ${MOVIES.length} movies into events/${EVENT_ID}/movies`);
  process.exit(0);
}

seed().catch(err => {
  console.error("❌ Error seeding:", err);
  process.exit(1);
});
