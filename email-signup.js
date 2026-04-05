import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-functions.js";

// Firebase Config (same project as main app)
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
const addEmailSignupCallable = httpsCallable(functions, "addEmailSignup");

const form = document.getElementById("emailForm");
const emailInput = document.getElementById("emailInput");
const submitBtn = document.getElementById("emailSubmitBtn");
const statusEl = document.getElementById("emailStatus");

const urlParams = new URLSearchParams(window.location.search);
const EVENT_ID = urlParams.get("event") || "newparkway1";

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ff6b6b" : "#ccc";
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = emailInput.value.trim();
    if (!email || !email.includes("@")) {
      setStatus("Please enter a valid email address.", true);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Joining...";
    setStatus("");

    try {
      await addEmailSignupCallable({ email, eventId: EVENT_ID });
      emailInput.value = "";
      emailInput.blur();
      setStatus("You're on the list! We'll email you when tickets drop.");
    } catch (error) {
      console.error("Email signup error:", error);
      setStatus("Could not save your email. Please try again.", true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Join the email list";
    }
  });
}
