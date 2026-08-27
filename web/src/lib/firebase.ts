import { getFirestore } from "firebase/firestore";
import { firebaseApp } from "./firebase-core";

// Full Firestore SDK (real-time onSnapshot support) — only VotePanel,
// ChatRoom, AdminDashboard, and ReelSuccessDashboard need this; everything
// else uses `dbLite` from firebase-lite.ts. Kept in its own file, separate
// from the callables in firebase-core.ts, so Rollup can chunk it
// independently — see the comment in firebase-core.ts for why that split
// matters.
export const db = getFirestore(firebaseApp);

export * from "./firebase-core";
