import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs } from "firebase/firestore";

const cfg = {
  apiKey: "AIzaSyDMa_twNQAZVrnLHUNNNsxk6aTa-9FrnSc",
  authDomain: "reelconvo.firebaseapp.com",
  projectId: "reelconvo",
  storageBucket: "reelconvo.firebasestorage.app",
  messagingSenderId: "913820455359",
  appId: "1:913820455359:web:1c75954a231b921b55510a",
};

const db = getFirestore(initializeApp(cfg));
const snap = await getDocs(collection(db, "events"));
const rows = [];
snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));

const staticFallbackByEventId = {
  newparkway1: "2026-04-27T18:30:00",
};

function parseFromId(id) {
  const m = String(id || "").match(/^np-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
}

function parseFromLabel(label, id) {
  const m = String(label || "").match(/(\d{1,2})\/(\d{1,2})\s*@\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (!m) return null;
  const idMatch = String(id || "").match(/^np-(\d{4})-/);
  const year = idMatch ? idMatch[1] : "2026";
  let hour = Number(m[3]);
  const ampm = String(m[5] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  const month = String(Number(m[1])).padStart(2, "0");
  const day = String(Number(m[2])).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mm = String(m[4]).padStart(2, "0");
  return `${year}-${month}-${day}T${hh}:${mm}:00`;
}

function normalizeDateTime(value) {
  const s = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return `${s}:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  return null;
}

function isNewParkwayEvent(row) {
  const id = String(row.id || "").toLowerCase();
  const name = String(row.theaterName || "").toLowerCase();
  return id === "newparkway1" || id.startsWith("np-") || name.includes("new parkway");
}

const records = [];
for (const row of rows.filter(isNewParkwayEvent)) {
  const resolvedDateTime =
    normalizeDateTime(row.screeningDateTime) ||
    parseFromLabel(row.screeningLabel, row.id) ||
    parseFromId(row.id) ||
    staticFallbackByEventId[row.id] ||
    null;

  if (!resolvedDateTime) continue;

  const parsed = new Date(resolvedDateTime);
  if (Number.isNaN(parsed.getTime())) continue;

  records.push({
    id: row.id,
    screeningDateTime: resolvedDateTime,
    dayOfWeek: parsed.toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "America/Los_Angeles",
    }),
    localTime: parsed.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Los_Angeles",
    }),
  });
}

records.sort((a, b) => a.screeningDateTime.localeCompare(b.screeningDateTime));

const byDay = {};
const byTime = {};
for (const r of records) {
  byDay[r.dayOfWeek] = (byDay[r.dayOfWeek] || 0) + 1;
  byTime[r.localTime] = (byTime[r.localTime] || 0) + 1;
}

console.log(JSON.stringify({ count: records.length, records, byDay, byTime }, null, 2));
