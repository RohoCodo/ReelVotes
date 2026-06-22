/**
 * @typedef {"live" | "ended" | "not-started"} VoteStatus
 */

/**
 * @typedef {Object} ScreeningEvent
 * @property {string} id
 * @property {string} [firestoreEventId]
 * @property {string} [screeningLabel]
 * @property {string} [screeningDateTime]
 * @property {VoteStatus | string} [status]
 * @property {string} [theaterName]
 * @property {string} [theaterCity]
 */

const STATUS_META = {
  live: { label: "Voting live", badgeClass: "status-badge status-live" },
  ended: { label: "Voting ended", badgeClass: "status-badge status-ended" },
  "not-started": { label: "Voting upcoming", badgeClass: "status-badge status-upcoming" },
};

function toStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "live") return "live";
  if (normalized === "ended") return "ended";
  return "not-started";
}

function toDateKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "TBD";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    const parts = raw.split("T");
    return parts[1] ? parts[1].slice(0, 5) : "TBD";
  }
  return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * @param {ScreeningEvent} event
 */
export function ScreeningCard(event) {
  const status = toStatus(event?.status || event?.voteStatus);
  const statusMeta = STATUS_META[status];
  const theaterName = event?.theaterName || "The New Parkway Theater";
  const theaterCity = event?.theaterCity || "Oakland, CA";

  return `
    <article class="screening-card" data-event-id="${escapeHtml(event.id)}" role="button" tabindex="0" aria-label="Open ${escapeHtml(event.screeningLabel || event.id)}">
      <div class="screening-card-top">
        <p class="screening-time">🕒 ${escapeHtml(formatTime(event.screeningDateTime))}</p>
        <span class="${statusMeta.badgeClass}">${statusMeta.label}</span>
      </div>
      <h3>${escapeHtml(event.screeningLabel || event.id)}</h3>
      <p class="screening-theater">📍 ${escapeHtml(theaterName)} · ${escapeHtml(theaterCity)}</p>
    </article>
  `;
}

export class CalendarView {
  /**
   * @param {{
   *   mountEl: HTMLElement,
   *   events: ScreeningEvent[],
   *   onSelectDate?: (dateKey: string, events: ScreeningEvent[]) => void,
   *   onSelectScreening?: (event: ScreeningEvent) => void
   * }} options
   */
  constructor(options) {
    this.mountEl = options.mountEl;
    this.events = Array.isArray(options.events) ? options.events : [];
    this.onSelectDate = options.onSelectDate || (() => {});
    this.onSelectScreening = options.onSelectScreening || (() => {});
    this.viewMode = "calendar";

    const now = new Date();
    this.currentYear = now.getFullYear();
    this.currentMonth = now.getMonth();
    this.selectedDateKey = "";

    /** @type {Map<string, ScreeningEvent[]>} */
    this.eventsByDate = new Map();
    this.reindexEvents();
    this.render();
  }

  reindexEvents() {
    this.eventsByDate.clear();
    this.events.forEach((event) => {
      const dateKey = toDateKey(event?.screeningDateTime || event?.id);
      if (!dateKey) return;
      if (!this.eventsByDate.has(dateKey)) {
        this.eventsByDate.set(dateKey, []);
      }
      this.eventsByDate.get(dateKey).push(event);
    });
  }

  updateEvents(events) {
    this.events = Array.isArray(events) ? events : [];
    this.reindexEvents();
    this.render();
  }

  getMonthLabel() {
    return new Date(this.currentYear, this.currentMonth, 1).toLocaleDateString([], {
      month: "long",
      year: "numeric",
    });
  }

  moveMonth(delta) {
    const next = new Date(this.currentYear, this.currentMonth + delta, 1);
    this.currentYear = next.getFullYear();
    this.currentMonth = next.getMonth();
    this.render();
  }

  toggleView(mode) {
    this.viewMode = mode === "agenda" ? "agenda" : "calendar";
    this.render();
  }

  renderCalendarGrid() {
    const firstDay = new Date(this.currentYear, this.currentMonth, 1);
    const startWeekday = firstDay.getDay();
    const daysInMonth = new Date(this.currentYear, this.currentMonth + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < startWeekday; i++) {
      cells.push(`<button class="calendar-day empty" disabled aria-hidden="true"></button>`);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = `${this.currentYear}-${String(this.currentMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const hasEvents = this.eventsByDate.has(dateKey);
      const isSelected = this.selectedDateKey === dateKey;
      cells.push(`
        <button
          class="calendar-day ${hasEvents ? "has-events" : ""} ${isSelected ? "selected" : ""}"
          data-date-key="${dateKey}"
          aria-label="${dateKey}${hasEvents ? ", has screenings" : ""}"
          ${hasEvents ? "" : "disabled"}
        >
          <span>${day}</span>
          ${hasEvents ? '<em class="calendar-dot" aria-hidden="true"></em>' : ""}
        </button>
      `);
    }

    return cells.join("");
  }

  renderAgendaRows() {
    const rows = Array.from(this.eventsByDate.entries())
      .filter(([dateKey]) => {
        const [year, month] = dateKey.split("-").map(Number);
        return year === this.currentYear && month === this.currentMonth + 1;
      })
      .sort(([left], [right]) => left.localeCompare(right));

    if (!rows.length) {
      return `<p class="calendar-empty">No screenings this month yet.</p>`;
    }

    return rows.map(([dateKey, events]) => {
      const label = new Date(`${dateKey}T12:00:00`).toLocaleDateString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      return `
        <div class="agenda-row" data-date-key="${dateKey}">
          <div>
            <p class="agenda-date">${label}</p>
            <p class="agenda-count">${events.length} screening${events.length === 1 ? "" : "s"}</p>
          </div>
          <button type="button" class="agenda-open-btn">View</button>
        </div>
      `;
    }).join("");
  }

  renderSelectedScreenings() {
    const selectedEvents = this.eventsByDate.get(this.selectedDateKey) || [];
    if (!this.selectedDateKey) {
      return `<p class="calendar-empty">Select a highlighted day to view screenings.</p>`;
    }

    if (!selectedEvents.length) {
      return `<p class="calendar-empty">No screenings available on this day.</p>`;
    }

    const dateLabel = new Date(`${this.selectedDateKey}T12:00:00`).toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    return `
      <div class="day-screenings-header">
        <h3>${dateLabel}</h3>
        <p>${selectedEvents.length} screening${selectedEvents.length === 1 ? "" : "s"}</p>
      </div>
      <div class="screening-list ${selectedEvents.length === 1 ? "single-screening" : ""}">
        ${selectedEvents.map((event) => ScreeningCard(event)).join("")}
      </div>
    `;
  }

  selectDate(dateKey) {
    this.selectedDateKey = dateKey;
    this.onSelectDate(dateKey, this.eventsByDate.get(dateKey) || []);
    this.render();
  }

  wireEvents() {
    const prevBtn = this.mountEl.querySelector("[data-cal-nav='prev']");
    const nextBtn = this.mountEl.querySelector("[data-cal-nav='next']");
    const calendarToggle = this.mountEl.querySelector("[data-view='calendar']");
    const agendaToggle = this.mountEl.querySelector("[data-view='agenda']");

    prevBtn?.addEventListener("click", () => this.moveMonth(-1));
    nextBtn?.addEventListener("click", () => this.moveMonth(1));
    calendarToggle?.addEventListener("click", () => this.toggleView("calendar"));
    agendaToggle?.addEventListener("click", () => this.toggleView("agenda"));

    this.mountEl.querySelectorAll("[data-date-key]").forEach((dayButton) => {
      dayButton.addEventListener("click", () => {
        const dateKey = dayButton.getAttribute("data-date-key") || "";
        if (dateKey) this.selectDate(dateKey);
      });
    });

    this.mountEl.querySelectorAll(".screening-card").forEach((card) => {
      const eventId = card.getAttribute("data-event-id");
      card.addEventListener("click", () => {
        const event = this.events.find((item) => item.id === eventId);
        if (event) this.onSelectScreening(event);
      });
      card.addEventListener("keypress", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          const item = this.events.find((row) => row.id === eventId);
          if (item) this.onSelectScreening(item);
        }
      });
    });

    this.mountEl.querySelectorAll(".agenda-row").forEach((row) => {
      row.querySelector(".agenda-open-btn")?.addEventListener("click", () => {
        const dateKey = row.getAttribute("data-date-key") || "";
        if (dateKey) {
          this.viewMode = "calendar";
          this.selectDate(dateKey);
        }
      });
    });
  }

  render() {
    this.mountEl.innerHTML = `
      <section class="calendar-shell" aria-label="Monthly screening calendar">
        <div class="calendar-header">
          <button type="button" class="calendar-nav-btn" data-cal-nav="prev" aria-label="Previous month">←</button>
          <h2>${this.getMonthLabel()}</h2>
          <button type="button" class="calendar-nav-btn" data-cal-nav="next" aria-label="Next month">→</button>
        </div>

        <div class="calendar-view-toggle" role="tablist" aria-label="View mode">
          <button type="button" class="main-tab-btn ${this.viewMode === "calendar" ? "active" : ""}" data-view="calendar">Calendar</button>
          <button type="button" class="main-tab-btn ${this.viewMode === "agenda" ? "active" : ""}" data-view="agenda">Agenda</button>
        </div>

        ${this.viewMode === "calendar"
          ? `
            <div class="calendar-weekdays" aria-hidden="true">
              <span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>
            </div>
            <div class="calendar-grid">${this.renderCalendarGrid()}</div>
          `
          : `<div class="agenda-list">${this.renderAgendaRows()}</div>`
        }

        <div class="day-screenings">${this.renderSelectedScreenings()}</div>
      </section>
    `;

    this.wireEvents();
  }
}

export class TheaterSearch {
  /**
   * @param {{
   *   mountEl: HTMLElement,
   *   theaters: Array<{id: string, name: string, city: string, partnered: boolean}>,
   *   onSelect: (theater: any) => void,
   *   onQueryChange?: (query: string) => Promise<Array<{id: string, name: string, city: string, partnered: boolean}>>
   * }} options
   */
  constructor(options) {
    this.mountEl = options.mountEl;
    this.theaters = options.theaters || [];
    this.results = options.theaters || [];
    this.onSelect = options.onSelect;
    this.onQueryChange = typeof options.onQueryChange === "function" ? options.onQueryChange : null;
    this.query = "";
    this.selectedTheater = null;
    this.queryTimer = null;
    this.render();
  }

  getFiltered() {
    const q = this.query.trim().toLowerCase();
    const source = Array.isArray(this.results) ? this.results : this.theaters;
    if (!q) return source;
    return source.filter((theater) => {
      const haystack = `${theater.name} ${theater.city}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  renderResults() {
    const results = this.getFiltered();
    const resultsEl = this.mountEl.querySelector(".theater-results");
    if (!resultsEl) {
      return;
    }

    resultsEl.innerHTML = `
      ${results.length
        ? results.map((theater) => `
          <button type="button" class="theater-result-item" data-theater-id="${escapeHtml(theater.id)}">
            <div>
              <h3>${escapeHtml(theater.name)}</h3>
              <p>${escapeHtml(theater.city)}</p>
            </div>
            ${theater.partnered
              ? '<span class="partner-badge">Partner</span>'
              : '<span class="partner-badge not">Not partnered</span>'}
          </button>
        `).join("")
        : '<p class="calendar-empty">No theaters found. You can still send a petition below.</p>'}
      ${this.query.trim()
        ? `<button type="button" class="theater-result-item" data-theater-custom="1">
            <div>
              <h3>Request: ${escapeHtml(this.query.trim())}</h3>
              <p>Don\'t see your theater? Send a petition.</p>
            </div>
            <span class="partner-badge not">Request</span>
          </button>`
        : ""}
    `;

    resultsEl.querySelectorAll("[data-theater-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-theater-id") || "";
        const source = Array.isArray(this.results) && this.results.length ? this.results : this.theaters;
        const match = source.find((theater) => theater.id === id) || this.theaters.find((theater) => theater.id === id);
        if (!match) return;
        this.selectedTheater = match;
        this.onSelect(match);
        this.render();
      });
    });

    resultsEl.querySelectorAll("[data-theater-custom]").forEach((button) => {
      button.addEventListener("click", () => {
        const customTheater = {
          id: "custom-request",
          name: this.query.trim(),
          city: "",
          partnered: false,
        };
        this.selectedTheater = customTheater;
        this.onSelect(customTheater);
        this.render();
      });
    });
  }

  async refreshRemoteResults() {
    if (!this.onQueryChange) {
      this.results = this.theaters;
      this.renderResults();
      return;
    }

    try {
      const nextResults = await this.onQueryChange(this.query);
      if (Array.isArray(nextResults) && nextResults.length) {
        this.results = nextResults;
      } else {
        this.results = this.theaters;
      }
    } catch {
      this.results = this.theaters;
    }

    this.renderResults();
  }

  render() {
    if (this.selectedTheater) {
      const cityState = String(
        this.selectedTheater.city
          || this.selectedTheater.cityState
          || [this.selectedTheater.cityName, this.selectedTheater.stateCode].filter(Boolean).join(", ")
          || ""
      );

      this.mountEl.innerHTML = `
        <div class="theater-selected-shell" role="status" aria-live="polite" aria-current="true">
          <div class="theater-result-item theater-result-item-selected">
            <div>
              <h3>${escapeHtml(this.selectedTheater.name)}</h3>
              <p>${escapeHtml(cityState)}</p>
            </div>
            ${this.selectedTheater.partnered
              ? '<span class="partner-badge">Partner</span>'
              : '<span class="partner-badge not">Not partnered</span>'}
          </div>
          <button type="button" class="secondary-btn theater-change-btn">Change theater</button>
        </div>
      `;

      this.mountEl.querySelector(".theater-change-btn")?.addEventListener("click", () => {
        this.selectedTheater = null;
        this.query = "";
        this.results = this.theaters;
        this.render();
      });

      return;
    }

    this.mountEl.innerHTML = `
      <div class="theater-search-box">
        <input id="theaterSearchInput" type="search" class="search-input" placeholder="Find your local theater" value="${escapeHtml(this.query)}" />
      </div>
      <div class="theater-results" role="listbox"></div>
    `;

    const input = this.mountEl.querySelector("#theaterSearchInput");
    input?.addEventListener("input", (event) => {
      this.query = String(event.target?.value || "");
      clearTimeout(this.queryTimer);
      this.queryTimer = window.setTimeout(() => {
        this.refreshRemoteResults();
      }, 120);
    });

    this.renderResults();
  }
}

export class PetitionForm {
  constructor(options) {
    this.mountEl = options.mountEl;
    this.onSubmit = options.onSubmit;
    this.prefill = options.prefill || {};
    this.render();
  }

  render() {
    this.mountEl.innerHTML = `
      <section class="info-box petition-shell" aria-live="polite">
        <h2>2. Bring this theater to ReelVotes</h2>
        <p class="subtitle" style="margin:0 0 14px;">Want voting nights at your local theater? Send a request and we'll reach out.</p>
        <form id="petitionForm" class="stack-form">
          <input name="name" required type="text" placeholder="Your name" class="search-input" />
          <input name="email" required type="email" placeholder="Email" class="search-input" />
          <input name="theaterName" required type="text" placeholder="Theater name" value="${escapeHtml(this.prefill.theaterName || "")}" class="search-input" />
          <input name="city" required type="text" placeholder="City" value="${escapeHtml(this.prefill.city || "")}" class="search-input" />
          <textarea name="message" placeholder="Message" class="form-textarea"></textarea>
          <button type="submit" class="submit-btn">Send Petition</button>
          <p class="subtitle" id="petitionStatus" style="margin:0;"></p>
        </form>
      </section>
    `;

    const form = this.mountEl.querySelector("#petitionForm");
    const statusEl = this.mountEl.querySelector("#petitionStatus");

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitBtn = form.querySelector("button[type='submit']");
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());

      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
      statusEl.textContent = "";

      try {
        await this.onSubmit(payload);
        form.innerHTML = `
          <div class="success-shell">
            <h3>Thanks!</h3>
            <p>We'll contact the theater and let them know people want ReelVotes in their community.</p>
          </div>
        `;
      } catch (error) {
        statusEl.textContent = error?.message || "Could not send petition. Please try again.";
        statusEl.style.color = "#ff9c9c";
        submitBtn.disabled = false;
        submitBtn.textContent = "Send Petition";
      }
    });
  }
}

export class MovieSuggestionForm {
  constructor(options) {
    this.mountEl = options.mountEl;
    this.onSubmit = options.onSubmit;
    this.render();
  }

  render() {
    this.mountEl.innerHTML = `
      <section class="info-box suggestion-shell">
        <h1>Suggest a Movie</h1>
        <p class="subtitle" style="margin-bottom: 12px;">Help shape future movie nights.</p>
        <form id="movieSuggestionForm" class="stack-form">
          <input name="title" required type="text" placeholder="Movie title and year" class="search-input" />
          <textarea name="why" required class="form-textarea" placeholder="Why this movie?"></textarea>
          <button type="submit" class="submit-btn">Submit Suggestion</button>
          <p id="suggestionStatus" class="subtitle" style="margin:0;"></p>
        </form>
      </section>
    `;

    const form = this.mountEl.querySelector("#movieSuggestionForm");
    const statusEl = this.mountEl.querySelector("#suggestionStatus");

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submitBtn = form.querySelector("button[type='submit']");
      const data = Object.fromEntries(new FormData(form).entries());

      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";
      statusEl.textContent = "";

      try {
        await this.onSubmit(data);
        form.innerHTML = `
          <div class="success-shell">
            <h3>Thanks for your suggestion!</h3>
            <p>Our team reviews requests before adding them to a future vote.</p>
          </div>
        `;
      } catch (error) {
        statusEl.textContent = error?.message || "Could not submit suggestion. Please try again.";
        statusEl.style.color = "#ff9c9c";
        submitBtn.disabled = false;
        submitBtn.textContent = "Submit Suggestion";
      }
    });
  }
}

export class ShareVotePanel {
  constructor(options) {
    this.mountEl = options.mountEl;
    this.getShareUrl = options.getShareUrl;
    this.getShareText = options.getShareText;
    this.render();
  }

  async copyLink() {
    const url = await this.getShareUrl();
    await navigator.clipboard.writeText(url);
  }

  async nativeShare() {
    if (!navigator.share) return false;
    await navigator.share({
      title: "ReelVotes",
      text: await this.getShareText(),
      url: await this.getShareUrl(),
    });
    return true;
  }

  async openShare(type) {
    const text = encodeURIComponent(await this.getShareText());
    const url = encodeURIComponent(await this.getShareUrl());

    if (type === "x") {
      window.open(`https://x.com/intent/tweet?text=${text}&url=${url}`, "_blank", "noopener");
      return;
    }
    if (type === "facebook") {
      window.open(`https://www.facebook.com/sharer/sharer.php?u=${url}`, "_blank", "noopener");
      return;
    }
    if (type === "messages") {
      window.location.href = `sms:?&body=${text}%0A${url}`;
    }
  }

  render() {
    this.mountEl.innerHTML = `
      <div class="share-panel">
        <button type="button" data-share="copy" class="secondary-btn">Copy Link</button>
        <button type="button" data-share="x" class="secondary-btn">Share on X</button>
        <button type="button" data-share="facebook" class="secondary-btn">Share on Facebook</button>
        <button type="button" data-share="messages" class="secondary-btn">Share via Messages</button>
        <button type="button" data-share="native" class="submit-btn">Share</button>
      </div>
    `;

    this.mountEl.querySelectorAll("[data-share]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.getAttribute("data-share");
        try {
          if (action === "copy") {
            await this.copyLink();
            button.textContent = "Copied!";
            setTimeout(() => { button.textContent = "Copy Link"; }, 1200);
            return;
          }
          if (action === "native") {
            const didShare = await this.nativeShare();
            if (!didShare) {
              await this.copyLink();
              button.textContent = "Copied Link";
              setTimeout(() => { button.textContent = "Share"; }, 1200);
            }
            return;
          }
          await this.openShare(action);
        } catch (error) {
          console.error("Share failed", error);
        }
      });
    });
  }
}

export class ResultsLeaderboard {
  constructor(options) {
    this.mountEl = options.mountEl;
    this.movies = Array.isArray(options.movies) ? options.movies : [];
    this.title = options.title || "Live Results";
    this.render();
  }

  update(movies) {
    this.movies = Array.isArray(movies) ? movies : [];
    this.render();
  }

  render() {
    const rows = this.movies
      .slice()
      .sort((a, b) => Number(b.vote_count || 0) - Number(a.vote_count || 0));

    const total = rows.reduce((sum, item) => sum + Number(item.vote_count || 0), 0);

    this.mountEl.innerHTML = `
      <section class="results-leaderboard">
        <h2>${escapeHtml(this.title)}</h2>
        ${rows.length ? rows.map((item, index) => {
          const votes = Number(item.vote_count || 0);
          const percent = total > 0 ? Math.round((votes / total) * 100) : 0;
          const title = item?.title || item?.movie_title || item?.id || "Untitled";
          const poster = item?.poster || item?.posterUrl || item?.poster_url || null;
          return `
            <div class="leaderboard-row ${index === 0 ? "top" : ""}">
              <div class="leaderboard-head">
                <p class="rank">#${index + 1}</p>
                ${poster
                  ? `<img class="leaderboard-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(title)} poster" loading="lazy" />`
                  : '<div class="leaderboard-poster-fallback" aria-hidden="true"></div>'}
                <p class="movie">${escapeHtml(title)}</p>
                <p class="votes">${votes} · ${percent}%</p>
              </div>
              <div class="leaderboard-track">
                <span class="leaderboard-fill" style="width:${Math.min(percent, 100)}%"></span>
              </div>
            </div>
          `;
        }).join("") : '<p class="calendar-empty">No votes yet.</p>'}
      </section>
    `;
  }
}

export class ConfettiCelebration {
  constructor(options = {}) {
    this.key = options.key || "reelvotes_confetti_seen";
  }

  fireOnce() {
    try {
      if (window.sessionStorage.getItem(this.key) === "1") {
        return;
      }
      window.sessionStorage.setItem(this.key, "1");
    } catch {
      // no-op
    }

    const pieces = 90;
    const container = document.createElement("div");
    container.className = "confetti-container";

    for (let i = 0; i < pieces; i += 1) {
      const dot = document.createElement("span");
      dot.className = "confetti-piece";
      dot.style.left = `${Math.random() * 100}%`;
      dot.style.animationDelay = `${Math.random() * 0.6}s`;
      dot.style.background = i % 2 === 0 ? "#ff4f9a" : "#ffd166";
      container.appendChild(dot);
    }

    document.body.appendChild(container);
    setTimeout(() => container.remove(), 2400);
  }
}

export function FAQSection() {
  return `
    <section class="faq-grid info-box">
      <h2>FAQ</h2>
      <details open>
        <summary>Can I vote for multiple movies?</summary>
        <p>Yes. One ballot per person, and each ballot can include multiple movies.</p>
      </details>
      <details>
        <summary>Can I suggest a movie?</summary>
        <p>Yes. Use <a class="app-link" href="/suggest">Suggest a Movie</a> to submit ideas.</p>
      </details>
      <details>
        <summary>How are winners determined?</summary>
        <p>The movie with the highest vote count wins that screening.</p>
      </details>
      <details>
        <summary>What if my theater isn't partnered?</summary>
        <p>Use the petition flow on showtimes. The team follows up with demand from your city.</p>
      </details>
    </section>
  `;
}

export function HowItWorksPage() {
  return `
    <section class="info-box how-it-works-shell">
      <h1>How ReelVotes Works</h1>
      <p class="subtitle">Movie lovers decide what gets screened.</p>

      <section class="info-box" style="margin:10px 0 0;">
        <h2 style="margin-top:0;">Voting Rules</h2>
        <p>Public poll. One vote per person. You may vote for as many movies as you want on that single ballot.</p>
      </section>

      <section class="info-box" style="margin:10px 0 0;">
        <h2 style="margin-top:0;">How ReelVotes works</h2>
        <p>
          ReelVotes helps small theaters program movies you not only want to see, but that you will support by buying a ticket if your movie is chosen.
          When you vote, you are saying you'll show up. That is how votes become real screenings and how independent theaters you love can keep taking risks on great films.
        </p>
      </section>

      <div class="steps-grid">
        <article class="step-card"><span>📍</span><h3>Choose your theater</h3><p>Find your local participating theater.</p></article>
        <article class="step-card"><span>🗳️</span><h3>Vote</h3><p>Pick the movie you want to see.</p></article>
        <article class="step-card"><span>📲</span><h3>Invite friends</h3><p>Share the vote and help your favorite rise to the top.</p></article>
        <article class="step-card"><span>🍿</span><h3>Movie night happens</h3><p>The winning film gets screened.</p></article>
      </div>
    </section>
  `;
}
