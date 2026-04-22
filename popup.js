const API_BASE = "https://api-web.nhle.com/v1";
const NHL_WEB = "https://www.nhl.com";

/** @returns {string} Local calendar date YYYY-MM-DD */
function getTodayDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * NHL season id used by api-web (e.g. 20252026).
 * Regular season spans roughly Oct–Jun; preseason in Sep uses the upcoming season id.
 */
function getSeason(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const startYear = month >= 8 ? year : year - 1;
  const endYear = startYear + 1;
  return `${startYear}${endYear}`;
}

function addDaysYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Standings for a single date can be empty during parts of the playoffs/off-season.
 * Walk backward a few weeks to find the latest snapshot with 32 teams.
 */
async function fetchStandingsWithFallback(maxBackDays = 45) {
  let probe = getTodayDate();
  for (let i = 0; i <= maxBackDays; i += 1) {
    const url = `${API_BASE}/standings/${probe}`;
    const data = await fetchJson(url);
    const rows = Array.isArray(data?.standings) ? data.standings : [];
    if (rows.length > 0) {
      return { date: probe, rows };
    }
    probe = addDaysYmd(probe, -1);
  }
  throw new Error("No standings data available for recent dates.");
}

function teamAbbrevFromRow(row) {
  return row?.teamAbbrev?.default ?? row?.teamAbbrev ?? "";
}

function teamDisplayName(row) {
  const common = row?.teamCommonName?.default;
  const place = row?.placeName?.default;
  const full = row?.teamName?.default;
  if (full) return full;
  if (place && common) return `${place} ${common}`;
  return teamAbbrevFromRow(row) || "Unknown team";
}

function hasExplicitPlayoffFlag(row) {
  const candidates = [
    row?.playoffTeam,
    row?.isPlayoffTeam,
    row?.playoffQualification,
    row?.qualifiedForPlayoffs,
    row?.playoffs,
  ];
  return candidates.some((v) => v === true || v === 1 || v === "Y" || v === "y");
}

/**
 * Prefer explicit playoff flags when present; otherwise top 8 per conference by `conferenceSequence`.
 */
function pickPlayoffTeams(rows) {
  if (!rows.length) return [];

  const explicit = dedupeTeams(rows.filter(hasExplicitPlayoffFlag));
  if (explicit.length === 16) {
    return explicit;
  }

  const byConf = new Map();
  for (const row of rows) {
    const conf = row.conferenceAbbrev || "UNK";
    if (!byConf.has(conf)) byConf.set(conf, []);
    byConf.get(conf).push(row);
  }

  const chosen = [];
  for (const group of byConf.values()) {
    const sorted = group
      .slice()
      .sort((a, b) => (a.conferenceSequence ?? 999) - (b.conferenceSequence ?? 999));
    chosen.push(...sorted.slice(0, 8));
  }

  return dedupeTeams(chosen);
}

function dedupeTeams(rows) {
  const map = new Map();
  for (const row of rows) {
    const abbr = teamAbbrevFromRow(row);
    if (!abbr) continue;
    if (!map.has(abbr)) map.set(abbr, row);
  }
  return Array.from(map.values());
}

function sortTeamsForUi(rows) {
  return rows
    .slice()
    .sort((a, b) => teamDisplayName(a).localeCompare(teamDisplayName(b), undefined, { sensitivity: "base" }));
}

/** @returns {Promise<{ asOfDate: string, teams: { abbrev: string, name: string, logo?: string }[] }>} */
async function fetchPlayoffTeams() {
  const { date, rows } = await fetchStandingsWithFallback();
  const playoffRows = pickPlayoffTeams(rows);

  if (!playoffRows.length) {
    throw new Error("Could not determine playoff teams from standings.");
  }

  const teams = sortTeamsForUi(playoffRows).map((row) => ({
    abbrev: teamAbbrevFromRow(row),
    name: teamDisplayName(row),
    logo: typeof row.teamLogo === "string" ? row.teamLogo : undefined,
  }));

  return { asOfDate: date, teams };
}

function isCancelledGame(game) {
  const state = game?.gameScheduleState;
  return state === "CNCL" || state === "PPD";
}

function isCompletedState(gameState) {
  return gameState === "FINAL" || gameState === "OFF";
}

function parseUtc(iso) {
  if (!iso || typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** @param {string} teamAbbrev */
async function fetchTeamSchedule(teamAbbrev) {
  const season = getSeason();
  const url = `${API_BASE}/club-schedule-season/${encodeURIComponent(teamAbbrev)}/${season}`;
  const data = await fetchJson(url);
  const games = Array.isArray(data?.games) ? data.games : [];
  return { season, games };
}

/**
 * @param {any[]} games
 * @param {string} teamAbbrev
 */
function findNextGame(games, teamAbbrev) {
  const now = Date.now();
  const upper = teamAbbrev.toUpperCase();

  const candidates = games.filter((g) => {
    if (!g || isCancelledGame(g)) return false;
    const away = g.awayTeam?.abbrev;
    const home = g.homeTeam?.abbrev;
    if (!away || !home) return false;
    if (away.toUpperCase() !== upper && home.toUpperCase() !== upper) return false;
    const t = parseUtc(g.startTimeUTC);
    if (t == null) return false;
    if (t <= now) return false;
    if (isCompletedState(g.gameState)) return false;
    return true;
  });

  candidates.sort((a, b) => parseUtc(a.startTimeUTC) - parseUtc(b.startTimeUTC));
  return candidates[0] ?? null;
}

/**
 * @param {any[]} games
 * @param {string} teamAbbrev
 */
function findLastCompletedGame(games, teamAbbrev) {
  const now = Date.now();
  const upper = teamAbbrev.toUpperCase();

  const candidates = games.filter((g) => {
    if (!g || isCancelledGame(g)) return false;
    const away = g.awayTeam?.abbrev;
    const home = g.homeTeam?.abbrev;
    if (!away || !home) return false;
    if (away.toUpperCase() !== upper && home.toUpperCase() !== upper) return false;
    if (!isCompletedState(g.gameState)) return false;
    const t = parseUtc(g.startTimeUTC);
    if (t != null && t > now) return false;
    return true;
  });

  candidates.sort((a, b) => (parseUtc(b.startTimeUTC) ?? 0) - (parseUtc(a.startTimeUTC) ?? 0));
  return candidates[0] ?? null;
}

/** @param {string} [pathOrUrl] */
function toNhlAbsoluteUrl(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== "string") return "";
  const trimmed = pathOrUrl.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("/")) return `${NHL_WEB}${trimmed}`;
  return `${NHL_WEB}/${trimmed}`;
}

/** Prefer 3-minute recap URL; fall back to condensed; expose game center separately. */
function pickMediaLinks(game) {
  const recap =
    toNhlAbsoluteUrl(game?.threeMinRecap) ||
    toNhlAbsoluteUrl(game?.threeMinRecapFr) ||
    "";
  const condensed = toNhlAbsoluteUrl(game?.condensedGame) || toNhlAbsoluteUrl(game?.condensedGameFr) || "";
  const gameCenter = toNhlAbsoluteUrl(game?.gameCenterLink) || "";
  const highlights = recap || condensed;
  return { recap, condensed, gameCenter, highlights };
}

function formatFinalScoreLine(game) {
  const away = game?.awayTeam;
  const home = game?.homeTeam;
  const as = away?.score;
  const hs = home?.score;
  const awayAbbr = away?.abbrev ?? "—";
  const homeAbbr = home?.abbrev ?? "—";
  if (typeof as === "number" && typeof hs === "number") {
    return `${awayAbbr} ${as} — ${homeAbbr} ${hs}`;
  }
  return "Final (score unavailable)";
}

function findGameOnScoreboard(boardPayload, gameId) {
  const days = Array.isArray(boardPayload?.gamesByDate) ? boardPayload.gamesByDate : [];
  for (const day of days) {
    const games = Array.isArray(day?.games) ? day.games : [];
    for (const g of games) {
      if (g?.id === gameId) return g;
    }
  }
  return null;
}

/**
 * Club schedule playoff rows omit `topSeedTeamAbbrev` / `bottomSeedTeamAbbrev`; the same game on
 * `/v1/scoreboard/{date}` includes them so we can label the series score.
 */
async function mergePlayoffSeriesFromScoreboard(game) {
  if (game?.gameType !== 3) return game;
  const existing = game.seriesStatus;
  if (existing?.topSeedTeamAbbrev && existing?.bottomSeedTeamAbbrev) {
    return game;
  }
  const gameDate = game.gameDate;
  const gameId = game.id;
  if (!gameDate || gameId == null) return game;

  try {
    const board = await fetchJson(`${API_BASE}/scoreboard/${gameDate}`);
    const match = findGameOnScoreboard(board, gameId);
    const bSeries = match?.seriesStatus;
    if (!bSeries || typeof bSeries !== "object") return game;

    return {
      ...game,
      seriesStatus: {
        ...existing,
        topSeedTeamAbbrev: bSeries.topSeedTeamAbbrev ?? existing?.topSeedTeamAbbrev,
        bottomSeedTeamAbbrev: bSeries.bottomSeedTeamAbbrev ?? existing?.bottomSeedTeamAbbrev,
        topSeedWins: typeof bSeries.topSeedWins === "number" ? bSeries.topSeedWins : existing?.topSeedWins,
        bottomSeedWins:
          typeof bSeries.bottomSeedWins === "number" ? bSeries.bottomSeedWins : existing?.bottomSeedWins,
      },
    };
  } catch (err) {
    console.warn("Scoreboard merge skipped:", err);
    return game;
  }
}

function teamDisplayLabelFromSide(team) {
  if (!team) return "";
  return (
    team.teamName?.default ||
    [team.placeName?.default, team.commonName?.default].filter(Boolean).join(" ") ||
    team.abbrev ||
    ""
  );
}

function teamLabelForAbbrev(game, abbrev) {
  const up = abbrev?.toUpperCase();
  if (!up) return "";
  for (const side of [game.homeTeam, game.awayTeam]) {
    if (side?.abbrev?.toUpperCase() === up) {
      return teamDisplayLabelFromSide(side) || abbrev;
    }
  }
  return abbrev;
}

/** e.g. "Dallas Stars vs. Minnesota Wild · 1–1" (top seed listed first). */
function formatSeriesScoreLine(game) {
  if (game?.gameType !== 3) return "";
  const s = game?.seriesStatus;
  if (!s || typeof s !== "object") return "";

  const topAbbr = s.topSeedTeamAbbrev;
  const bottomAbbr = s.bottomSeedTeamAbbrev;
  const topW = s.topSeedWins;
  const bottomW = s.bottomSeedWins;

  if (!topAbbr || !bottomAbbr) return "";
  if (typeof topW !== "number" || typeof bottomW !== "number") return "";

  const topName = teamLabelForAbbrev(game, topAbbr);
  const bottomName = teamLabelForAbbrev(game, bottomAbbr);
  if (!topName || !bottomName) return "";

  return `${topName} vs. ${bottomName} · ${topW}–${bottomW}`;
}

/**
 * NHL api-web schedule `gameType`: 1 = preseason, 2 = regular season, 3 = playoffs.
 * Playoff `seriesStatus` uses `seriesTitle`, `gameNumberOfSeries`, `neededToWin` (first to N wins).
 */
function formatSeriesLine(game) {
  const gt = game?.gameType;
  const series = game?.seriesStatus;

  if (gt === 3) {
    if (series && typeof series === "object") {
      const title =
        series.seriesTitle ||
        series.roundName?.default ||
        series.roundName ||
        series.seriesAbbrev ||
        "Playoffs";
      const gameNum = series.gameNumberOfSeries ?? series.seriesGameNumber;
      const needed = series.neededToWin;
      const maxGames =
        typeof needed === "number" && Number.isFinite(needed) && needed > 0
          ? needed * 2 - 1
          : series.maxGames;

      if (gameNum != null && maxGames != null) {
        return `Playoffs · ${title} · Game ${gameNum} of ${maxGames}`;
      }
      if (gameNum != null) {
        return `Playoffs · ${title} · Game ${gameNum}`;
      }
      return `Playoffs · ${title}`;
    }
    return "Playoffs";
  }

  if (gt === 1) {
    return "Preseason";
  }

  return "";
}

/**
 * @param {any} game
 * @param {string} teamAbbrev
 */
function renderGame(game, teamAbbrev) {
  const abbr = teamAbbrev.toUpperCase();
  const isHome = game.homeTeam?.abbrev?.toUpperCase() === abbr;
  const self = isHome ? game.homeTeam : game.awayTeam;
  const opp = isHome ? game.awayTeam : game.homeTeam;

  const oppName =
    opp?.teamName?.default ||
    [opp?.placeName?.default, opp?.commonName?.default].filter(Boolean).join(" ") ||
    opp?.abbrev ||
    "Opponent";

  const start = parseUtc(game.startTimeUTC);
  const when = start != null ? new Date(start) : null;

  const dateStr =
    when?.toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }) ?? "—";

  const timeStr =
    when?.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }) ?? "—";

  const seriesLine = formatSeriesLine(game);
  const seriesScoreLine = formatSeriesScoreLine(game);

  const logo = typeof self?.logo === "string" ? self.logo : "";
  const oppLogo = typeof opp?.logo === "string" ? opp.logo : "";

  return `
    <div class="results-header">
      ${logo ? `<img class="team-logo" src="${escapeHtml(logo)}" alt="" />` : `<div class="team-logo" aria-hidden="true"></div>`}
      <div>
        <h2 class="results-title">${escapeHtml(self?.commonName?.default || self?.abbrev || abbr)}</h2>
        <p class="results-meta">Next matchup</p>
      </div>
    </div>
    <span class="pill ${isHome ? "" : "pill--away"}">${isHome ? "Home" : "Away"}</span>
    <dl class="kv" style="margin-top:12px">
      <dt>Opponent</dt><dd class="opp-cell">${oppLogo ? `<img class="opp-logo" src="${escapeHtml(oppLogo)}" alt="" />` : ""}<span>${escapeHtml(oppName)}</span></dd>
      <dt>Date</dt><dd>${escapeHtml(dateStr)}</dd>
      <dt>Local time</dt><dd>${escapeHtml(timeStr)}</dd>
      ${seriesLine ? `<dt>Series</dt><dd>${escapeHtml(seriesLine)}</dd>` : ""}
      ${seriesScoreLine ? `<dt>Series score</dt><dd>${escapeHtml(seriesScoreLine)}</dd>` : ""}
    </dl>
  `;
}

/**
 * @param {any} game
 * @param {string} teamAbbrev
 */
function renderCompletedGame(game, teamAbbrev) {
  const abbr = teamAbbrev.toUpperCase();
  const isHome = game.homeTeam?.abbrev?.toUpperCase() === abbr;
  const self = isHome ? game.homeTeam : game.awayTeam;
  const opp = isHome ? game.awayTeam : game.homeTeam;

  const oppName =
    opp?.teamName?.default ||
    [opp?.placeName?.default, opp?.commonName?.default].filter(Boolean).join(" ") ||
    opp?.abbrev ||
    "Opponent";

  const start = parseUtc(game.startTimeUTC);
  const when = start != null ? new Date(start) : null;

  const dateStr =
    when?.toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }) ?? "—";

  const timeStr =
    when?.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }) ?? "—";

  const seriesLine = formatSeriesLine(game);
  const seriesScoreLine = formatSeriesScoreLine(game);
  const scoreLine = formatFinalScoreLine(game);
  const media = pickMediaLinks(game);

  const logo = typeof self?.logo === "string" ? self.logo : "";
  const oppLogo = typeof opp?.logo === "string" ? opp.logo : "";

  const highlightLabel = media.recap
    ? "Watch highlights (3 min)"
    : media.condensed
      ? "Watch condensed game"
      : "Watch video";

  const highlightLink = media.highlights
    ? `<a class="external-link" href="${escapeHtml(media.highlights)}" target="_blank" rel="noopener noreferrer">${highlightLabel}</a>`
    : "";

  const gameCenterLink = media.gameCenter
    ? `<a class="external-link external-link--muted" href="${escapeHtml(media.gameCenter)}" target="_blank" rel="noopener noreferrer">Open NHL GameCenter</a>`
    : "";

  const linksBlock =
    highlightLink || gameCenterLink
      ? `<div class="links-row">${highlightLink}${gameCenterLink}</div>`
      : `<p class="muted-note">No highlight or recap link is available for this game yet.</p>`;

  return `
    <div class="results-header">
      ${logo ? `<img class="team-logo" src="${escapeHtml(logo)}" alt="" />` : `<div class="team-logo" aria-hidden="true"></div>`}
      <div>
        <h2 class="results-title">${escapeHtml(self?.commonName?.default || self?.abbrev || abbr)}</h2>
        <p class="results-meta">Last game</p>
      </div>
    </div>
    <span class="pill pill--final">Final</span>
    <dl class="kv" style="margin-top:12px">
      <dt>Opponent</dt><dd class="opp-cell">${oppLogo ? `<img class="opp-logo" src="${escapeHtml(oppLogo)}" alt="" />` : ""}<span>${escapeHtml(oppName)}</span></dd>
      <dt>Date</dt><dd>${escapeHtml(dateStr)}</dd>
      <dt>Local time</dt><dd>${escapeHtml(timeStr)}</dd>
      <dt>Result</dt><dd>${escapeHtml(scoreLine)}</dd>
      ${seriesLine ? `<dt>Series</dt><dd>${escapeHtml(seriesLine)}</dd>` : ""}
      ${seriesScoreLine ? `<dt>Series score</dt><dd>${escapeHtml(seriesScoreLine)}</dd>` : ""}
      <dt>Media</dt><dd>${linksBlock}</dd>
    </dl>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function setLoading(isLoading) {
  $("loading").classList.toggle("hidden", !isLoading);
  $("team-select").disabled = isLoading;
  $("view-mode").disabled = isLoading;
}

function setScheduleFetching(isFetching) {
  $("team-select").disabled = isFetching;
  $("view-mode").disabled = isFetching;
}

function setError(message) {
  const box = $("error");
  if (!message) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.textContent = message;
  box.classList.remove("hidden");
}

function setResultsHtml(html) {
  const el = $("results");
  el.innerHTML = html;
  el.classList.remove("hidden");
}

function hideResults() {
  const el = $("results");
  el.classList.add("hidden");
  el.innerHTML = "";
}

async function init() {
  const select = $("team-select");
  setLoading(true);
  setError("");
  hideResults();

  try {
    const { asOfDate, teams } = await fetchPlayoffTeams();
    select.innerHTML =
      `<option value="">Select a team…</option>` +
      teams.map((t) => `<option value="${escapeHtml(t.abbrev)}">${escapeHtml(t.name)}</option>`).join("");

    const subtitle = document.querySelector(".subtitle");
    if (subtitle) {
      subtitle.textContent =
        teams.length && asOfDate !== getTodayDate()
          ? `Standings as of ${asOfDate} (latest available)`
          : "Playoff picture and next game";
    }
  } catch (err) {
    console.error(err);
    setError(err?.message || "Failed to load playoff teams.");
    select.innerHTML = `<option value="">Unavailable</option>`;
  } finally {
    setLoading(false);
    select.disabled = false;
  }
}

function getViewMode() {
  const el = document.getElementById("view-mode");
  return el?.value === "last" ? "last" : "next";
}

async function refreshTeamPanel() {
  const teamAbbrev = $("team-select").value;
  setError("");

  if (!teamAbbrev) {
    hideResults();
    return;
  }

  setResultsHtml(
    `<div class="loading schedule-loading"><span class="spinner" aria-hidden="true"></span><span class="loading-text">Loading schedule…</span></div>`,
  );
  setScheduleFetching(true);
  try {
    const { games } = await fetchTeamSchedule(teamAbbrev);
    const mode = getViewMode();

    if (mode === "last") {
      const last = findLastCompletedGame(games, teamAbbrev);
      if (!last) {
        setResultsHtml(
          `<p class="empty-state">No completed games found for ${escapeHtml(teamAbbrev)} in the current season window.</p>`,
        );
        return;
      }
      const enriched = await mergePlayoffSeriesFromScoreboard(last);
      setResultsHtml(renderCompletedGame(enriched, teamAbbrev));
      return;
    }

    const next = findNextGame(games, teamAbbrev);
    if (!next) {
      setResultsHtml(
        `<p class="empty-state">No upcoming games found for ${escapeHtml(teamAbbrev)} in the current season window.</p>`,
      );
      return;
    }
    const enriched = await mergePlayoffSeriesFromScoreboard(next);
    setResultsHtml(renderGame(enriched, teamAbbrev));
  } catch (err) {
    console.error(err);
    hideResults();
    setError(err?.message || "Failed to load schedule.");
  } finally {
    setScheduleFetching(false);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init();

  $("team-select").addEventListener("change", () => {
    void refreshTeamPanel();
  });

  $("view-mode").addEventListener("change", () => {
    void refreshTeamPanel();
  });
});
