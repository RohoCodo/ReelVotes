import { HowItWorksPage, FAQSection } from "/ui-components.js";

const mountEl = document.getElementById("howItWorksMount");
if (mountEl) {
  mountEl.innerHTML = `${HowItWorksPage()}${FAQSection()}`;
}
