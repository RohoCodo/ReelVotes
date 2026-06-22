import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-functions.js";
import { MovieSuggestionForm } from "/ui-components.js";

const firebaseConfig = {
  apiKey: "AIzaSyDMa_twNQAZVrnLHUNNNsxk6aTa-9FrnSc",
  authDomain: "reelconvo.firebaseapp.com",
  projectId: "reelconvo",
  storageBucket: "reelconvo.firebasestorage.app",
  messagingSenderId: "913820455359",
  appId: "1:913820455359:web:1c75954a231b921b55510a"
};

const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);
const submitMovieSuggestionCallable = httpsCallable(functions, "submitMovieSuggestion");

const mountEl = document.getElementById("movieSuggestionMount");

new MovieSuggestionForm({
  mountEl,
  onSubmit: async (payload) => {
    await submitMovieSuggestionCallable(payload);
  },
});
