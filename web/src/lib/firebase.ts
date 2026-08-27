import { initializeApp, getApps, getApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getFirestore } from "firebase/firestore";

// Public client config — not a secret, access is governed by Firestore
// security rules, matching the pattern the previous vanilla-JS site used.
const firebaseConfig = {
  apiKey: "AIzaSyDMa_twNQAZVrnLHUNNNsxk6aTa-9FrnSc",
  authDomain: "reelconvo.firebaseapp.com",
  projectId: "reelconvo",
  storageBucket: "reelconvo.firebasestorage.app",
  messagingSenderId: "913820455359",
  appId: "1:913820455359:web:1c75954a231b921b55510a",
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);
export const functions = getFunctions(firebaseApp);

// Firebase Auth and Storage are intentionally NOT initialized here — only
// the Admin and ReelSuccess dashboards need them, and pulling those SDKs in
// eagerly would bloat every page (vote, chat, etc.) with ~500KB they never
// use. Import `auth`/`googleProvider` from `./firebase-auth` and `storage`
// from `./firebase-storage` instead, so only those two pages' bundles pay
// for it.

export const submitMovieSuggestion = httpsCallable(functions, "submitMovieSuggestion");
export const addEmailSignup = httpsCallable(functions, "addEmailSignup");
export const submitVote = httpsCallable(functions, "submitVote");
export const getVoteStatus = httpsCallable(functions, "getVoteStatus");
export const submitTheaterPetition = httpsCallable(functions, "submitTheaterPetition");
export const publicListTheaters = httpsCallable(functions, "publicListTheaters");
export const joinMovieChatRoom = httpsCallable(functions, "joinMovieChatRoom");
export const sendMovieChatMessage = httpsCallable(functions, "sendMovieChatMessage");

// --- ReelSuccess (internal theater-analytics dashboard) --------------------
export const reelSuccessSyncAccess = httpsCallable(functions, "reelSuccessSyncAccess");
export const reelSuccessListTheaters = httpsCallable(functions, "reelSuccessListTheaters");
export const reelSuccessGetMyTheater = httpsCallable(functions, "reelSuccessGetMyTheater");
export const reelSuccessGetTheaterInsights = httpsCallable(functions, "reelSuccessGetTheaterInsights");
export const reelSuccessCreateGrossUploadSession = httpsCallable(functions, "reelSuccessCreateGrossUploadSession");
export const reelSuccessFinalizeGrossUpload = httpsCallable(functions, "reelSuccessFinalizeGrossUpload");
export const reelSuccessDeleteGrossUpload = httpsCallable(functions, "reelSuccessDeleteGrossUpload");

// --- Admin dashboard (internal operator tool, /admin) -----------------------
export const getEventVoteStats = httpsCallable(functions, "getEventVoteStats");
export const setEventVoteStatus = httpsCallable(functions, "setEventVoteStatus");
export const saveEventAdminSettings = httpsCallable(functions, "saveEventAdminSettings");
export const createEventShowtime = httpsCallable(functions, "createEventShowtime");
export const deleteEventShowtime = httpsCallable(functions, "deleteEventShowtime");
export const runEliminationRound = httpsCallable(functions, "runEliminationRound");
export const revertLatestEliminationRound = httpsCallable(functions, "revertLatestEliminationRound");
export const rebuildEventMovieVoteCounts = httpsCallable(functions, "rebuildEventMovieVoteCounts");
export const reelSuccessSetAccess = httpsCallable(functions, "reelSuccessSetAccess");
export const reelSuccessListAccess = httpsCallable(functions, "reelSuccessListAccess");
export const reelSuccessSetUserClaims = httpsCallable(functions, "reelSuccessSetUserClaims");
