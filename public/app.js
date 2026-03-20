let step = 1;
let selectedTheme = null;
let selectedMovie = null;

const stepTitle = document.getElementById("step-title");
const optionsDiv = document.getElementById("options");
const nextBtn = document.getElementById("nextBtn");
const resultsDiv = document.getElementById("results");

const themes = [
  "🔥 Revenge Films",
  "🧠 Psychological Thrillers",
  "👽 Sci-Fi Horror"
];

const moviesByTheme = {
  "🔥 Revenge Films": ["Oldboy", "Kill Bill", "Lady Snowblood"],
  "🧠 Psychological Thrillers": ["Parasite", "Black Swan", "Se7en"],
  "👽 Sci-Fi Horror": ["The Thing", "Alien", "Annihilation"]
};

function renderOptions(list) {
  optionsDiv.innerHTML = "";
  nextBtn.disabled = true;

  list.forEach(item => {
    const div = document.createElement("div");
    div.className = "option";
    div.innerText = item;

    div.onclick = () => {
      document.querySelectorAll(".option").forEach(o => o.classList.remove("selected"));
      div.classList.add("selected");

      if (step === 1) selectedTheme = item;
      if (step === 2) selectedMovie = item;

      nextBtn.disabled = false;
    };

    optionsDiv.appendChild(div);
  });
}

function loadStep() {
  if (step === 1) {
    stepTitle.innerText = "Step 1: Choose a theme";
    nextBtn.innerText = "Next";
    renderOptions(themes);
  } else if (step === 2) {
    stepTitle.innerText = "Step 2: Choose a movie";
    nextBtn.innerText = "Submit Vote";
    renderOptions(moviesByTheme[selectedTheme]);
  }
}

nextBtn.onclick = () => {
  if (step === 1) {
    step = 2;
    loadStep();
  } else {
    showResults();
  }
};

function showResults() {
  optionsDiv.classList.add("hidden");
  nextBtn.classList.add("hidden");

  resultsDiv.classList.remove("hidden");

  resultsDiv.innerHTML = `
    <h2>You're in 🎉</h2>
    <p>Your vote: <b>${selectedMovie}</b></p>
    <p>Invite friends to make this screening happen</p>

    <div class="bar">
      <div class="fill" style="width: 60%"></div>
    </div>
    <p>60 / 100 people backing</p>
  `;
}

loadStep();