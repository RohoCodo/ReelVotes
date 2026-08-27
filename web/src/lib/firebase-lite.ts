import { getFirestore } from "firebase/firestore/lite";
import { firebaseApp } from "./firebase-core";

// Firestore's full SDK (firebase/firestore) ships its real-time WebChannel
// transport layer — ~450KB minified — needed only by components that use
// onSnapshot (VotePanel, ChatRoom, AdminDashboard, ReelSuccessDashboard).
// Everything else here only ever does one-time reads (getDocs,
// getCountFromServer), so it uses firebase/firestore/lite instead, which
// drops that transport layer entirely and is a fraction of the size —
// meaningful on mobile, since this is what the homepage and Showtimes
// picker load before a visitor sees anything interactive.
export const dbLite = getFirestore(firebaseApp);
