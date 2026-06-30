import {
  getApps,
  initializeApp,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCazI868YUFSEMk-e4lis1m-NJxwRZwWyo",
  authDomain: "betvalue-analyzer.firebaseapp.com",
  projectId: "betvalue-analyzer",
  storageBucket: "betvalue-analyzer.firebasestorage.app",
  messagingSenderId: "1004749734997",
};

const STORAGE_KEY = "betvalue-web-state-v1";
const CACHE_KEY = "betvalue-web-cloud-cache-v1";
const REFRESH_MIN_MS = 45_000;
const MAX_DOCS_PER_COLLECTION = 1200;
const now = () => Date.now();

const appRoot = document.querySelector("#app");
let searchRenderTimer = 0;

const state = {
  tab: "home",
  loading: true,
  syncLabel: "Connexion au cloud…",
  error: "",
  query: "",
  category: "all",
  selectedSport: "all",
  selectedCompetition: "all",
  selectedId: "",
  installPrompt: null,
  cloud: {
    results: [],
    diagnostics: null,
    lastLoadedAt: 0,
    source: "firebase",
  },
  preferences: loadPreferences(),
};

boot();

function boot() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    render();
  });

  appRoot.addEventListener("click", handleClick);
  appRoot.addEventListener("input", handleInput);

  registerServiceWorker();
  loadCachedCloud();
  render();
  refreshCloud({ force: true });
}

async function refreshCloud({ force = false } = {}) {
  if (!force && now() - state.cloud.lastLoadedAt < REFRESH_MIN_MS) {
    toast("Données déjà fraîches");
    return;
  }

  state.loading = true;
  state.error = "";
  state.syncLabel = "Lecture Firebase…";
  render();

  try {
    const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
    const auth = getAuth(app);
    if (!auth.currentUser) await signInAnonymously(auth);
    const db = getFirestore(app);
    const currentTime = now();
    const [cloudResults, sharedResults, diagnostics] = await Promise.all([
      readCollection(db, "cloud_results", currentTime),
      readCollection(db, "shared_results", currentTime),
      readDiagnostics(db),
    ]);
    const merged = normalizeAndDedupe([...cloudResults, ...sharedResults], currentTime);
    if (merged.length === 0) throw new Error("Aucun résultat cloud exploitable pour le moment");
    state.cloud = {
      results: merged,
      diagnostics,
      lastLoadedAt: currentTime,
      source: "firebase",
    };
    state.syncLabel = `${merged.length} événements synchronisés`;
    saveCloudCache();
  } catch (error) {
    state.error = cleanText(error?.message || String(error));
    if (state.cloud.results.length === 0) {
      state.cloud = {
        results: sampleResults(),
        diagnostics: null,
        lastLoadedAt: now(),
        source: "demo",
      };
      state.syncLabel = "Mode aperçu local";
    } else {
      state.syncLabel = "Cloud indisponible, cache conservé";
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function readCollection(db, name, currentTime) {
  const snapshot = await getDocs(
    query(
      collection(db, name),
      where("expiresAt", ">", currentTime),
      limit(MAX_DOCS_PER_COLLECTION),
    ),
  );
  return snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data(), collectionName: name }));
}

async function readDiagnostics(db) {
  const snapshot = await getDoc(doc(db, "cloud_diagnostics", "current"));
  return snapshot.exists() ? snapshot.data() : null;
}

function normalizeAndDedupe(rawResults, currentTime) {
  const byEvent = new Map();
  rawResults
    .map(normalizeCloudResult)
    .filter((result) => result.expiresAt > currentTime && result.eventDate > currentTime - 48 * 60 * 60 * 1000)
    .forEach((result) => {
      const key = eventIdentity(result);
      const existing = byEvent.get(key);
      if (!existing || betterResult(result, existing)) byEvent.set(key, result);
    });
  return [...byEvent.values()].sort(resultSort);
}

function normalizeCloudResult(raw) {
  const documentType = cleanText(raw.documentType || "prediction");
  const homeTeam = cleanText(raw.homeTeam || raw.participantA || "");
  const awayTeam = cleanText(raw.awayTeam || raw.participantB || "");
  const eventName = cleanText(raw.eventName || [homeTeam, awayTeam].filter(Boolean).join(" — ") || raw.competition || "");
  const selection = cleanText(raw.selection || (documentType === "calendar_event" ? "Événement à suivre" : ""));
  const category = categoryKey(raw.category || (documentType === "calendar_event" ? "calendar" : ""));
  const consensusProbability = clampProbability(numberValue(raw.consensusProbability, raw.reliability / 100 || 0.5));
  const confidenceScore = clamp(numberValue(raw.confidenceScore, raw.reliability || 50), 0, 100);

  return {
    id: cleanText(raw.predictionId || raw.eventId || raw.id || randomId()),
    eventId: cleanText(raw.eventId || raw.id || ""),
    documentType,
    sport: cleanText(raw.sport || "sport"),
    sportTitle: cleanText(raw.sportTitle || raw.sport || "Sport"),
    competition: cleanText(raw.competition || "Compétition"),
    competitionKey: cleanText(raw.competitionKey || `${raw.sport || "sport"}:${raw.competition || "competition"}`),
    eventName,
    eventDate: numberValue(raw.eventDate, now()),
    updatedAt: numberValue(raw.updatedAt, 0),
    expiresAt: numberValue(raw.expiresAt, now() + 6 * 60 * 60 * 1000),
    homeTeam,
    awayTeam,
    market: cleanText(raw.market || "Analyse"),
    selection,
    impliedProbability: clampProbability(numberValue(raw.impliedProbability, 0)),
    consensusProbability,
    valueEdge: numberValue(raw.valueEdge, 0),
    expectedValue: numberValue(raw.expectedValue, 0),
    confidenceScore,
    reliability: clamp(numberValue(raw.reliability, confidenceScore), 0, 100),
    riskLevel: cleanText(raw.riskLevel || ""),
    category,
    categoryLabel: categoryLabel(category),
    sourceName: cleanText(raw.sourceName || raw.collectionName || "Cloud"),
    expectedScore: cleanText(raw.expectedScore || ""),
    calculatedResults: cleanText(raw.calculatedResults || ""),
    probabilities: cleanText(raw.probabilities || ""),
    scenarios: cleanText(raw.scenarios || ""),
    statSummary: cleanText(raw.statSummary || ""),
    positiveArguments: cleanText(raw.positiveArguments || ""),
    negativeArguments: cleanText(raw.negativeArguments || ""),
    homeLineupStatus: cleanText(raw.homeLineupStatus || ""),
    homeLineup: cleanText(raw.homeLineup || ""),
    awayLineupStatus: cleanText(raw.awayLineupStatus || ""),
    awayLineup: cleanText(raw.awayLineup || ""),
    playerScenarios: cleanText(raw.playerScenarios || ""),
    sourceDetails: cleanText(raw.sourceDetails || ""),
    contextInsights: cleanText(raw.contextInsights || ""),
    sourceAgreement: clamp(numberValue(raw.sourceAgreement, raw.reliability || confidenceScore), 0, 100),
    eventType: cleanText(raw.eventType || inferEventType(raw)),
  };
}

function render() {
  const results = filteredResults();
  const metrics = computeMetrics();
  const diagnostics = state.cloud.diagnostics;

  appRoot.innerHTML = `
    <main class="screen">
      ${renderHero(metrics, diagnostics)}
      ${renderToolbar()}
      ${renderActiveTab(results)}
    </main>
    ${renderBottomNav()}
    ${state.selectedId ? renderModal(findResult(state.selectedId)) : ""}
  `;
}

function renderHero(metrics, diagnostics) {
  const source = state.cloud.source === "demo" ? "aperçu local" : "Firebase";
  const freshness = state.cloud.lastLoadedAt ? `maj ${formatTime(state.cloud.lastLoadedAt)}` : "non chargé";
  return `
    <section class="hero">
      <div class="topline">
        <div>
          <div class="eyebrow">BETVALUE WEB</div>
          <h1>Analyse sportive</h1>
          <p class="muted">WebApp PWA · ${escapeHtml(source)} · ${escapeHtml(freshness)}</p>
        </div>
        <button class="refresh-button" data-action="refresh" ${state.loading ? "disabled" : ""}>
          ${state.loading ? "Recherche…" : "Actualiser"}
        </button>
      </div>
      <div class="metric-grid">
        <div class="metric"><strong>${metrics.total}</strong><span>événements</span></div>
        <div class="metric"><strong>${metrics.safe}</strong><span>safe</span></div>
        <div class="metric"><strong>${metrics.live}</strong><span>live/proches</span></div>
        <div class="metric"><strong>${metrics.nextStart}</strong><span>prochain départ</span></div>
      </div>
      <p class="${state.error ? "line" : "muted"}">${escapeHtml(state.syncLabel)}${state.error ? ` · ${escapeHtml(state.error)}` : ""}</p>
      ${
        diagnostics
          ? `<p class="mini">Cloud job : ${escapeHtml(String(diagnostics.resultsPrepared || 0))} résultats · ${escapeHtml(String(diagnostics.newsWithSignals || 0))} infos presse utiles · ${escapeHtml(formatTime(diagnostics.updatedAt || 0))}</p>`
          : ""
      }
    </section>
  `;
}

function renderToolbar() {
  const categories = [
    ["all", "Tous"],
    ["safe", "Safe"],
    ["mixed", "Mitigé"],
    ["exotic", "Exotique"],
    ["calendar", "Calendrier"],
  ];
  return `
    <section class="toolbar">
      <input
        class="search"
        data-action="search"
        value="${escapeHtml(state.query)}"
        placeholder="Rechercher sport, équipe, joueur, tournoi…"
      />
      <div class="tabs">
        ${categories
          .map(
            ([key, label]) =>
              `<button class="tab ${state.category === key ? "active" : ""}" data-action="category" data-value="${key}">${label}</button>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderActiveTab(results) {
  if (state.tab === "sports") return renderSports(results);
  if (state.tab === "live") return renderLive(results);
  if (state.tab === "settings") return renderSettings();
  return renderHome(results);
}

function renderHome(results) {
  const safe = results.filter((result) => result.category === "safe").slice(0, 8);
  const next = results.slice(0, 18);
  return `
    ${renderSection("Signaux safe", safe, "Aucun signal safe trouvé dans le cloud.")}
    ${renderSection("Prochains événements", next, "Aucun événement disponible.")}
  `;
}

function renderSports(results) {
  const sports = sportRows();
  const competitions = competitionRows(state.selectedSport);
  return `
    <section class="section-title">
      <h2>Sports</h2>
      <p class="muted">Favoris locaux : ils passent devant dans cette WebApp.</p>
    </section>
    <div class="chips">
      <button class="chip ${state.selectedSport === "all" ? "active" : ""}" data-action="sport" data-value="all">Tous</button>
      ${sports
        .map(
          (sport) => `
            <button class="chip ${state.selectedSport === sport.key ? "active" : ""}" data-action="sport" data-value="${escapeAttr(sport.key)}">
              ${escapeHtml(sport.label)} · ${sport.count}
              <span class="star" data-action="favorite-sport" data-value="${escapeAttr(sport.key)}">${state.preferences.favoriteSports.includes(sport.key) ? "★" : "☆"}</span>
            </button>
          `,
        )
        .join("")}
    </div>
    <section class="section-title">
      <h2>Ligues / tournois</h2>
    </section>
    <div class="chips">
      <button class="chip ${state.selectedCompetition === "all" ? "active" : ""}" data-action="competition" data-value="all">Toutes</button>
      ${competitions
        .slice(0, 42)
        .map(
          (competition) => `
            <button class="chip ${state.selectedCompetition === competition.key ? "active" : ""}" data-action="competition" data-value="${escapeAttr(competition.key)}">
              ${escapeHtml(competition.label)} · ${competition.count}
              <span class="star" data-action="favorite-competition" data-value="${escapeAttr(competition.key)}">${state.preferences.favoriteCompetitions.includes(competition.key) ? "★" : "☆"}</span>
            </button>
          `,
        )
        .join("")}
    </div>
    ${renderSection("Événements du sport sélectionné", results.slice(0, 60), "Aucun match/événement dans ce filtre.")}
  `;
}

function renderLive(results) {
  const live = liveLikeResults(results);
  return `
    <section class="section-title">
      <h2>Live / proches</h2>
      <p class="muted">La WebApp affiche les événements en cours, très proches ou récemment terminés si le cloud les a.</p>
    </section>
    ${renderSection("À surveiller maintenant", live, "Aucun live détecté dans les données cloud.")}
  `;
}

function renderSettings() {
  const diagnostics = state.cloud.diagnostics;
  return `
    <section class="panel settings-card" style="padding: 20px;">
      <div>
        <div class="eyebrow">Réglages Web</div>
        <h2>Cloud & installation</h2>
      </div>
      <div class="switch-row">
        <div>
          <strong>Source</strong>
          <p class="muted">${escapeHtml(state.cloud.source === "demo" ? "aperçu local" : "Firebase cloud")}</p>
        </div>
        <button class="ghost-button" data-action="refresh">Forcer synchro</button>
      </div>
      <div class="switch-row">
        <div>
          <strong>Favoris locaux</strong>
          <p class="muted">${state.preferences.favoriteSports.length} sports · ${state.preferences.favoriteCompetitions.length} compétitions</p>
        </div>
        <button class="ghost-button" data-action="reset-favorites">Réinitialiser</button>
      </div>
      <div class="switch-row">
        <div>
          <strong>Installer sur téléphone</strong>
          <p class="muted">Si ton navigateur propose l’installation PWA, ça mettra l’app sur l’écran d’accueil.</p>
        </div>
        <button class="primary-button" data-action="install" ${state.installPrompt ? "" : "disabled"}>Installer</button>
      </div>
      ${
        diagnostics
          ? `<div class="info-block">
              <h3>Diagnostic cloud</h3>
              <p class="line">Événements : ${escapeHtml(String(diagnostics.eventsFound || 0))}</p>
              <p class="line">Résultats préparés : ${escapeHtml(String(diagnostics.resultsPrepared || 0))}</p>
              <p class="line">Sports sans événement : ${escapeHtml((diagnostics.sportsWithoutEvents || []).join(", ") || "aucun")}</p>
            </div>`
          : `<p class="muted">Aucun diagnostic cloud chargé.</p>`
      }
    </section>
  `;
}

function renderSection(title, results, emptyText) {
  return `
    <section class="section-title">
      <h2>${escapeHtml(title)}</h2>
    </section>
    ${
      results.length
        ? `<div class="grid">${results.map(renderCard).join("")}</div>`
        : `<div class="empty">${escapeHtml(emptyText)}</div>`
    }
  `;
}

function renderCard(result) {
  const badge = result.documentType === "calendar_event" ? "calendar" : result.category;
  const chance = percent(result.consensusProbability);
  return `
    <article class="card" data-action="open" data-id="${escapeAttr(result.id)}">
      <div class="card-top">
        <span class="badge ${badge}">${escapeHtml(result.categoryLabel)}</span>
        <span class="mini">${escapeHtml(formatDate(result.eventDate))}</span>
      </div>
      <div class="league">${escapeHtml(result.sportTitle)} · ${escapeHtml(result.competition)}</div>
      <div class="match-name">${escapeHtml(displayMatchName(result))}</div>
      ${renderTeams(result)}
      <div class="prediction-box">
        <div class="prob-row">
          <div>
            <div class="mini">${escapeHtml(result.market || "Pronostic")}</div>
            <div class="selection">${escapeHtml(result.selection || "Événement à suivre")}</div>
          </div>
          <div class="chance">${chance}</div>
        </div>
        <div class="bar"><span style="width: ${Math.round(result.consensusProbability * 100)}%"></span></div>
        <div class="pill-row">
          <span class="pill">Fiabilité ${result.confidenceScore}/100</span>
          ${result.expectedScore ? `<span class="pill">${escapeHtml(result.expectedScore)}</span>` : ""}
          <span class="pill">${escapeHtml(result.sourceName)}</span>
        </div>
      </div>
    </article>
  `;
}

function renderTeams(result) {
  if (!result.homeTeam || !result.awayTeam) return "";
  return `
    <div class="teams">
      <div class="team-pill">${escapeHtml(result.homeTeam)}</div>
      <div class="vs">VS</div>
      <div class="team-pill">${escapeHtml(result.awayTeam)}</div>
    </div>
  `;
}

function renderModal(result) {
  if (!result) return "";
  return `
    <section class="modal" data-action="close">
      <article class="modal-card" data-stop-close>
        <div class="modal-header">
          <div>
            <div class="eyebrow">${escapeHtml(result.sportTitle)} · ${escapeHtml(result.competition)}</div>
            <h2>${escapeHtml(displayMatchName(result))}</h2>
            <p class="muted">${escapeHtml(formatDate(result.eventDate))}</p>
          </div>
          <button class="icon-button" data-action="close">✕</button>
        </div>
        <div class="detail-hero">
          <div class="badge ${result.category}">${escapeHtml(result.categoryLabel)}</div>
          <h1 style="margin-top: 12px;">${escapeHtml(result.selection || "Événement à suivre")}</h1>
          <div class="metric-grid" style="margin-top: 16px;">
            <div class="metric"><strong>${percent(result.consensusProbability)}</strong><span>chance</span></div>
            <div class="metric"><strong>${result.confidenceScore}/100</strong><span>fiabilité</span></div>
            <div class="metric"><strong>${result.sourceAgreement}/100</strong><span>accord source</span></div>
            <div class="metric"><strong>${escapeHtml(result.expectedScore || "—")}</strong><span>score / état</span></div>
          </div>
        </div>
        <div class="detail-list">
          ${renderTextBlock("Bilan statistiques", result.statSummary || result.calculatedResults)}
          ${renderTextBlock("Infos récentes", result.contextInsights || "Aucun fait relevé")}
          ${renderTextBlock("Joueurs / compositions", [result.homeLineup, result.awayLineup, result.playerScenarios].filter(Boolean).join("\n"))}
          ${renderTextBlock("Autres scénarios", result.scenarios)}
          ${renderTextBlock("Sources", result.sourceDetails)}
        </div>
      </article>
    </section>
  `;
}

function renderTextBlock(title, text) {
  const lines = splitUsefulLines(text);
  return `
    <div class="info-block">
      <h3>${escapeHtml(title)}</h3>
      ${
        lines.length
          ? lines.map((line) => `<p class="line">• ${escapeHtml(line)}</p>`).join("")
          : `<p class="line">• Aucun fait relevé</p>`
      }
    </div>
  `;
}

function renderBottomNav() {
  const tabs = [
    ["home", "Accueil"],
    ["live", "Live"],
    ["sports", "Sports"],
    ["settings", "Réglages"],
  ];
  return `
    <nav class="bottom-nav">
      ${tabs
        .map(
          ([key, label]) =>
            `<button class="nav-button ${state.tab === key ? "active" : ""}" data-action="tab" data-value="${key}">${label}</button>`,
        )
        .join("")}
    </nav>
  `;
}

function handleClick(event) {
  const stopClose = event.target.closest("[data-stop-close]");
  if (stopClose) event.stopPropagation();
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const value = target.dataset.value;

  if (action === "refresh") refreshCloud({ force: true });
  if (action === "tab") {
    state.tab = value;
    render();
  }
  if (action === "category") {
    state.category = value;
    render();
  }
  if (action === "sport") {
    state.selectedSport = value;
    state.selectedCompetition = "all";
    render();
  }
  if (action === "competition") {
    state.selectedCompetition = value;
    render();
  }
  if (action === "open") {
    state.selectedId = target.dataset.id;
    render();
  }
  if (action === "close") {
    state.selectedId = "";
    render();
  }
  if (action === "favorite-sport") {
    event.stopPropagation();
    toggleFavorite("favoriteSports", value);
  }
  if (action === "favorite-competition") {
    event.stopPropagation();
    toggleFavorite("favoriteCompetitions", value);
  }
  if (action === "reset-favorites") {
    state.preferences.favoriteSports = [];
    state.preferences.favoriteCompetitions = [];
    savePreferences();
    render();
  }
  if (action === "install") installPwa();
}

function handleInput(event) {
  if (event.target?.dataset?.action === "search") {
    state.query = event.target.value;
    window.clearTimeout(searchRenderTimer);
    searchRenderTimer = window.setTimeout(render, 130);
  }
}

function filteredResults() {
  const queryValue = normalizeSearch(state.query);
  return state.cloud.results
    .filter((result) => {
      if (state.category !== "all" && result.category !== state.category) return false;
      if (state.tab === "sports") {
        if (state.selectedSport !== "all" && result.sport !== state.selectedSport) return false;
        if (state.selectedCompetition !== "all" && result.competitionKey !== state.selectedCompetition) return false;
      }
      if (!queryValue) return true;
      return normalizeSearch(searchBlob(result)).includes(queryValue);
    })
    .sort(resultSort);
}

function liveLikeResults(results) {
  const currentTime = now();
  return results.filter((result) => {
    const before = result.eventDate <= currentTime + 30 * 60 * 1000;
    const stillRelevant = result.expiresAt > currentTime && result.eventDate > currentTime - 12 * 60 * 60 * 1000;
    return before && stillRelevant;
  });
}

function sportRows() {
  const rows = new Map();
  state.cloud.results.forEach((result) => {
    const existing = rows.get(result.sport) || { key: result.sport, label: result.sportTitle, count: 0 };
    existing.count += 1;
    rows.set(result.sport, existing);
  });
  return [...rows.values()].sort((a, b) => favoriteRank("favoriteSports", b.key) - favoriteRank("favoriteSports", a.key) || b.count - a.count || a.label.localeCompare(b.label));
}

function competitionRows(sport) {
  const rows = new Map();
  state.cloud.results
    .filter((result) => sport === "all" || result.sport === sport)
    .forEach((result) => {
      const key = result.competitionKey || `${result.sport}:${result.competition}`;
      const existing = rows.get(key) || { key, label: result.competition, count: 0 };
      existing.count += 1;
      rows.set(key, existing);
    });
  return [...rows.values()].sort((a, b) => favoriteRank("favoriteCompetitions", b.key) - favoriteRank("favoriteCompetitions", a.key) || b.count - a.count || a.label.localeCompare(b.label));
}

function computeMetrics() {
  const results = state.cloud.results;
  const currentTime = now();
  const upcoming = results.filter((result) => result.eventDate > currentTime);
  const next = upcoming[0]?.eventDate;
  return {
    total: results.length,
    safe: results.filter((result) => result.category === "safe").length,
    live: liveLikeResults(results).length,
    nextStart: next ? formatShortDate(next) : "—",
  };
}

function resultSort(a, b) {
  return (
    favoriteResultRank(b) - favoriteResultRank(a) ||
    categoryWeight(b.category) - categoryWeight(a.category) ||
    b.confidenceScore - a.confidenceScore ||
    a.eventDate - b.eventDate
  );
}

function favoriteResultRank(result) {
  return favoriteRank("favoriteSports", result.sport) + favoriteRank("favoriteCompetitions", result.competitionKey);
}

function favoriteRank(key, value) {
  return state.preferences[key].includes(value) ? 1 : 0;
}

function betterResult(nextResult, currentResult) {
  return (
    categoryWeight(nextResult.category) > categoryWeight(currentResult.category) ||
    nextResult.confidenceScore > currentResult.confidenceScore ||
    nextResult.updatedAt > currentResult.updatedAt
  );
}

function eventIdentity(result) {
  return [
    result.sport,
    normalizeSearch(result.competition),
    dayBucket(result.eventDate),
    normalizeSearch(result.homeTeam && result.awayTeam ? [result.homeTeam, result.awayTeam].sort().join("~") : result.eventName),
  ].join("|");
}

function displayMatchName(result) {
  if (result.homeTeam && result.awayTeam) return `${result.homeTeam} — ${result.awayTeam}`;
  return result.eventName || result.competition;
}

function splitUsefulLines(text) {
  return cleanText(text || "")
    .split(/\n|•|;|\|/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, lines) => lines.findIndex((candidate) => normalizeSearch(candidate) === normalizeSearch(line)) === index)
    .slice(0, 12);
}

function searchBlob(result) {
  return [
    result.sportTitle,
    result.sport,
    result.competition,
    result.eventName,
    result.homeTeam,
    result.awayTeam,
    result.selection,
    result.market,
    result.expectedScore,
    result.statSummary,
    result.contextInsights,
  ].join(" ");
}

function toggleFavorite(key, value) {
  const list = state.preferences[key];
  state.preferences[key] = list.includes(value) ? list.filter((entry) => entry !== value) : [value, ...list];
  savePreferences();
  render();
}

async function installPwa() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice.catch(() => null);
  state.installPrompt = null;
  render();
}

function loadPreferences() {
  return {
    favoriteSports: [],
    favoriteCompetitions: [],
    ...safeJson(localStorage.getItem(STORAGE_KEY), {}),
  };
}

function savePreferences() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.preferences));
}

function loadCachedCloud() {
  const cached = safeJson(localStorage.getItem(CACHE_KEY), null);
  if (!cached?.results?.length) return;
  state.cloud = cached;
  state.loading = false;
  state.syncLabel = `${cached.results.length} événements en cache`;
}

function saveCloudCache() {
  localStorage.setItem(CACHE_KEY, JSON.stringify(state.cloud));
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function categoryKey(value) {
  const clean = normalizeSearch(String(value || ""));
  if (clean.includes("safe") || clean.includes("fort")) return "safe";
  if (clean.includes("mitige") || clean.includes("mixed") || clean.includes("potentiel")) return "mixed";
  if (clean.includes("exotique") || clean.includes("prudent") || clean.includes("risque")) return "exotic";
  if (clean.includes("calendar") || clean.includes("calendrier")) return "calendar";
  return "mixed";
}

function categoryLabel(key) {
  return {
    safe: "Safe",
    mixed: "Mitigé",
    exotic: "Exotique",
    calendar: "Calendrier",
  }[key] || "Mitigé";
}

function categoryWeight(key) {
  return { safe: 4, mixed: 3, calendar: 2, exotic: 1 }[key] || 0;
}

function inferEventType(raw) {
  const sport = String(raw.sport || "").toLowerCase();
  if (sport === "racing") return "GP";
  if (sport === "cycling" || sport === "nascar") return "RACE";
  if (!raw.homeTeam && !raw.participantA) return "EVENT";
  return "MATCH";
}

function formatDate(timestamp) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatShortDate(timestamp) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatTime(timestamp) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function percent(value) {
  return `${Math.round(clampProbability(value) * 100)} %`;
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(value) {
  let result = String(value ?? "");
  const replacements = [
    ["Ã©", "é"],
    ["Ã¨", "è"],
    ["Ãª", "ê"],
    ["Ã«", "ë"],
    ["Ã ", "à"],
    ["Ã¢", "â"],
    ["Ã¹", "ù"],
    ["Ã»", "û"],
    ["Ã´", "ô"],
    ["Ã®", "î"],
    ["Ã§", "ç"],
    ["Ã‰", "É"],
    ["â€™", "’"],
    ["â€œ", "“"],
    ["â€", "”"],
    ["â€”", "—"],
    ["â€“", "–"],
    ["Â·", "·"],
    ["Â«", "«"],
    ["Â»", "»"],
    ["Â", ""],
  ];
  replacements.forEach(([bad, good]) => {
    result = result.split(bad).join(good);
  });
  return result.trim();
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampProbability(value) {
  return clamp(numberValue(value, 0), 0, 1);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dayBucket(timestamp) {
  return Math.floor((timestamp + 2 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000));
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function findResult(id) {
  return state.cloud.results.find((result) => result.id === id || result.eventId === id);
}

function toast(message) {
  const toastNode = document.createElement("div");
  toastNode.className = "toast";
  toastNode.textContent = message;
  document.body.appendChild(toastNode);
  setTimeout(() => toastNode.remove(), 1800);
}

function sampleResults() {
  const start = now() + 90 * 60 * 1000;
  return [
    normalizeCloudResult({
      eventId: "demo-football-1",
      documentType: "prediction",
      sport: "soccer",
      sportTitle: "Football",
      competition: "Coupe du monde FIFA",
      eventName: "Argentine — Canada",
      eventDate: start,
      expiresAt: start + 6 * 60 * 60 * 1000,
      updatedAt: now(),
      homeTeam: "Argentine",
      awayTeam: "Canada",
      market: "Résultat final",
      selection: "Argentine ou nul (1X)",
      consensusProbability: 0.76,
      confidenceScore: 78,
      reliability: 78,
      category: "safe",
      expectedScore: "1-0 / 2-1",
      statSummary: "Argentine : volume offensif supérieur\nCanada : transition rapide, défense à surveiller",
      contextInsights: "Aucun fait relevé",
      sourceName: "Aperçu web",
      sourceAgreement: 74,
    }),
    normalizeCloudResult({
      eventId: "demo-tennis-1",
      documentType: "prediction",
      sport: "tennis",
      sportTitle: "Tennis",
      competition: "ATP · Wimbledon",
      eventName: "Rafael Jodar — Felix Gill",
      eventDate: start + 4 * 60 * 60 * 1000,
      expiresAt: start + 10 * 60 * 60 * 1000,
      updatedAt: now(),
      homeTeam: "Rafael Jodar",
      awayTeam: "Felix Gill",
      market: "Vainqueur tennis",
      selection: "Rafael Jodar",
      consensusProbability: 0.54,
      confidenceScore: 63,
      reliability: 63,
      category: "mixed",
      expectedScore: "3-1 / 3-2",
      statSummary: "Service : avantage léger Jodar\nSurface : forme à confirmer",
      contextInsights: "Aucun fait relevé",
      sourceName: "Aperçu web",
      sourceAgreement: 60,
    }),
    normalizeCloudResult({
      eventId: "demo-f1-1",
      documentType: "calendar_event",
      sport: "racing",
      sportTitle: "Formule 1",
      competition: "Grand Prix",
      eventName: "Grand Prix · course",
      eventDate: start + 24 * 60 * 60 * 1000,
      expiresAt: start + 36 * 60 * 60 * 1000,
      updatedAt: now(),
      market: "Classement course",
      selection: "Top 3 à confirmer au live",
      consensusProbability: 0.5,
      confidenceScore: 46,
      reliability: 46,
      category: "calendar",
      expectedScore: "Top 3 live",
      sourceName: "Aperçu web",
      sourceAgreement: 45,
    }),
  ];
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch {
    // Le service worker est un bonus PWA : l'app doit rester utilisable sans lui.
  }
}
