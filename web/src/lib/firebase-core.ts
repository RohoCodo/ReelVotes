import { initializeApp, getApps, getApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";

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
export const functions = getFunctions(firebaseApp);

// Deliberately kept in a separate file from `db` (full Firestore, see
// firebase.ts): both files import from a shared module, and if a callable
// and `db` lived in the same source file, Rollup would bundle them into
// one physical chunk — meaning any page using only a callable (Showtimes,
// Suggest, Email Signup) would transitively download the ~450KB full
// Firestore SDK it never touches, just because some *other* page's
// component (Vote, Chat) also imports from that same file.

export const submitMovieSuggestion = httpsCallable(functions, "submitMovieSuggestion");
export const addEmailSignup = httpsCallable(functions, "addEmailSignup");
export const submitVote = httpsCallable(functions, "submitVote");
export const getVoteStatus = httpsCallable(functions, "getVoteStatus");
export const submitTheaterPetition = httpsCallable(functions, "submitTheaterPetition");
export const submitTheaterRegistration = httpsCallable(functions, "submitTheaterRegistration");
export const createCampaign = httpsCallable(functions, "createCampaign");
export const publicListCampaigns = httpsCallable(functions, "publicListCampaigns");
export const publicListDeadTimeSlots = httpsCallable(functions, "publicListDeadTimeSlots");
export const upsertCampaignSupport = httpsCallable(functions, "upsertCampaignSupport");
export const upsertCampaignMovieVote = httpsCallable(functions, "upsertCampaignMovieVote");
export const adminSetCampaignStatus = httpsCallable(functions, "adminSetCampaignStatus");
export const publicListTheaters = httpsCallable(functions, "publicListTheaters");
export const joinMovieChatRoom = httpsCallable(functions, "joinMovieChatRoom");
export const sendMovieChatMessage = httpsCallable(functions, "sendMovieChatMessage");
export const joinCampaignDiscussion = httpsCallable(functions, "joinCampaignDiscussion");
export const sendCampaignDiscussionMessage = httpsCallable(functions, "sendCampaignDiscussionMessage");

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
