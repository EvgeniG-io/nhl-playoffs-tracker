const API_BASE = "https://api-web.nhle.com/v1";
const NHL_WEB = "https://www.nhl.com";

/** @type {{ date: string, rows: any[] }} */
let cachedStandings = { date: "", rows: [] };
/** @type {{ abbrev: string, name: string, logo?: string }[]} */
let teamsCatalog = [];
/** @type {{ abbrev: string, games: any[] } | null} */
let scheduleCache = null;
let lastRefreshMs = 0;

function getTodayDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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

async function fetchTeamSchedule(teamAbbrev) {
  const season = getSeason();
  const url = `${API_BASE}/club-schedule-season/${encodeURIComponent(teamAbbrev)}/${season}`;
  const data = await fetchJson(url);
  const games = Array.isArray(data?.games) ? data.games : [];
  return { season, games };
}

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

function findNextPlayoffGame(games, teamAbbrev) {
  const now = Date.now();
  const upper = teamAbbrev.toUpperCase();
  const candidates = games.filter((g) => {
    if (!g || isCancelledGame(g)) return false;
    if (g.gameType !== 3) return false;
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

function findLatestCompletedPlayoffGame(games, teamAbbrev) {
  const now = Date.now();
  const upper = teamAbbrev.toUpperCase();
  const candidates = games.filter((g) => {
    if (!g || isCancelledGame(g)) return false;
    if (g.gameType !== 3) return false;
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

function toNhlAbsoluteUrl(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== "string") return "";
  const trimmed = pathOrUrl.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (trimmed.startsWith("/")) return `${NHL_WEB}${trimmed}`;
  return `${NHL_WEB}/${trimmed}`;
}

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

function formatBroadcasts(game) {
  const list = game?.tvBroadcasts;
  if (!Array.isArray(list) || !list.length) return "Check local listings";
  const names = list
    .map((b) => b?.network || b?.name)
    .filter(Boolean)
    .slice(0, 4);
  return names.length ? names.join(", ") : "Check local listings";
}

function formatEtDateTime(iso) {
  const ms = parseUtc(iso);
  if (ms == null) return { line: "—", venueLine: "" };
  const d = new Date(ms);
  const datePart = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(d);
  const timePart = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "shortGeneric",
  }).format(d);
  return { line: `${datePart.toUpperCase()} | ${timePart}`.replace(" AM", " AM").replace(" PM", " PM"), venueLine: "" };
}

function roundGameTitle(game) {
  const s = game?.seriesStatus;
  const r = s?.round;
  const gn = s?.gameNumberOfSeries ?? s?.seriesGameNumber;
  const title = (s?.seriesTitle || "Playoffs").toString().toUpperCase();
  if (typeof r === "number" && gn != null) {
    return `ROUND ${r} — GAME ${gn}`;
  }
  if (gn != null) {
    return `${title} — GAME ${gn}`;
  }
  return title;
}

function seriesLeadBlurb(game, selfAbbr) {
  const s = game?.seriesStatus;
  if (!s || game?.gameType !== 3) return "";
  const top = s.topSeedTeamAbbrev;
  const bot = s.bottomSeedTeamAbbrev;
  const tw = s.topSeedWins;
  const bw = s.bottomSeedWins;
  if (typeof tw !== "number" || typeof bw !== "number" || !top || !bot) return "";
  const u = selfAbbr.toUpperCase();
  const selfTop = top.toUpperCase() === u;
  const selfW = selfTop ? tw : bw;
  const oppW = selfTop ? bw : tw;
  if (selfW === oppW) return `Series tied ${selfW}–${oppW}`;
  if (selfW > oppW) return `${selfW}–${oppW} series lead`;
  return `${oppW}–${selfW} in series`;
}

/**
 * One skew cell per possible series game. Every **completed** game (both teams’ wins)
 * is highlighted in yellow; only not-yet-played slots stay neutral — no “gray for played”.
 */
function buildSeriesSkew(game) {
  const s = game?.seriesStatus;
  if (!s || game?.gameType !== 3) return "";
  const needed = s.neededToWin;
  const maxGames =
    typeof needed === "number" && Number.isFinite(needed) && needed > 0 ? needed * 2 - 1 : 7;
  const topW = typeof s.topSeedWins === "number" ? s.topSeedWins : 0;
  const botW = typeof s.bottomSeedWins === "number" ? s.bottomSeedWins : 0;
  const played = topW + botW;

  const cells = [];
  for (let i = 0; i < maxGames; i += 1) {
    const cls =
      i < played ? "series-skew__cell series-skew__cell--played" : "series-skew__cell series-skew__cell--future";
    cells.push(`<div class="${cls}" role="presentation"></div>`);
  }
  return `<div class="series-skew">${cells.join("")}</div>`;
}

function seriesLineSentence(game) {
  const s = game?.seriesStatus;
  if (!s || game?.gameType !== 3) return "";
  const top = s.topSeedTeamAbbrev;
  const bot = s.bottomSeedTeamAbbrev;
  const tw = s.topSeedWins;
  const bw = s.bottomSeedWins;
  const needed = s.neededToWin;
  const maxG = typeof needed === "number" ? needed * 2 - 1 : 7;
  if (!top || !bot || typeof tw !== "number" || typeof bw !== "number") return "";
  if (tw === bw) return `Series tied ${tw}–${bw} (best-of-${maxG})`;
  const leader = tw > bw ? top : bot;
  const lW = Math.max(tw, bw);
  const tW = Math.min(tw, bw);
  return `${leader} leads ${lW}–${tW} (best-of-${maxG})`;
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

function getActiveTab() {
  const t = document.querySelector(".segmented__tab.is-active");
  return t?.dataset.panelTab || "next";
}

function setActiveTab(tab) {
  for (const btn of document.querySelectorAll(".segmented__tab")) {
    const on = btn.dataset.panelTab === tab;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
}

function updateTeamPreview() {
  const abbr = $("team-select").value;
  const wrap = $("team-preview");
  if (!abbr) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }
  const t = teamsCatalog.find((x) => x.abbrev === abbr);
  if (t?.logo) {
    wrap.innerHTML = `<img src="${escapeHtml(t.logo)}" alt="" />`;
    wrap.classList.remove("hidden");
  } else {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
  }
}

function setLoading(isLoading) {
  $("loading").classList.toggle("hidden", !isLoading);
  $("team-select").disabled = isLoading;
  for (const b of document.querySelectorAll(".segmented__tab")) {
    b.disabled = isLoading;
  }
}

function setScheduleFetching(isFetching) {
  $("team-select").disabled = isFetching;
  for (const b of document.querySelectorAll(".segmented__tab")) {
    b.disabled = isFetching;
  }
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

function showPanel(html) {
  const el = $("panel");
  el.innerHTML = html;
  el.classList.remove("hidden");
}

function hidePanel() {
  $("panel").classList.add("hidden");
  $("panel").innerHTML = "";
}

function updateFooterTimestamp() {
  const el = $("updated-at");
  if (!lastRefreshMs) {
    el.textContent = "";
    return;
  }
  const sec = Math.max(0, Math.floor((Date.now() - lastRefreshMs) / 1000));
  const label = sec < 60 ? `Updated ${sec}s ago` : `Updated ${Math.floor(sec / 60)}m ago`;
  el.textContent = label;
}

function renderNextGameCard(game, teamAbbrev) {
  const abbr = teamAbbrev.toUpperCase();
  const isHome = game.homeTeam?.abbrev?.toUpperCase() === abbr;
  const self = isHome ? game.homeTeam : game.awayTeam;
  const opp = isHome ? game.awayTeam : game.homeTeam;

  const selfName = (self?.commonName?.default || self?.abbrev || abbr).toUpperCase();
  const oppName = (opp?.commonName?.default || opp?.abbrev || "OPP").toUpperCase();

  const selfLogo = self?.logo ? `<img class="matchup__logo" src="${escapeHtml(self.logo)}" alt="" />` : "";
  const oppLogo = opp?.logo ? `<img class="matchup__logo" src="${escapeHtml(opp.logo)}" alt="" />` : "";

  const { line: whenLine } = formatEtDateTime(game.startTimeUTC);
  const venue = game?.venue?.default || game?.venue;
  const venueText = venue ? `Venue: ${venue}` : "";

  const roundTitle = game.gameType === 3 ? roundGameTitle(game) : "NEXT GAME";
  const kicker = game.gameType === 3 ? "Next game details" : "Regular season / preseason";

  const subSelf = game.gameType === 3 ? seriesLeadBlurb(game, abbr) : isHome ? "Home" : "Away";
  const oppAbbr = (opp?.abbrev || "OPP").toUpperCase();
  const subOpp = game.gameType === 3 ? seriesLeadBlurb(game, oppAbbr) : isHome ? "Away" : "Home";

  const skew = game.gameType === 3 ? buildSeriesSkew(game) : "";
  const lineLbl = game.gameType === 3 ? escapeHtml(seriesLineSentence(game)) : "";
  const seriesBlock =
    game.gameType === 3 && skew
      ? `<div class="series-line-label">${lineLbl}</div>${skew}`
      : "";

  const nets = escapeHtml(formatBroadcasts(game));

  return `
    <div class="card-head">
      <p class="card-head__kicker">${escapeHtml(kicker)}</p>
      <h2 class="card-head__title">${escapeHtml(roundTitle)}</h2>
    </div>
    <div class="matchup">
      <div class="matchup__team matchup__team--left">
        ${selfLogo}
        <span class="matchup__abbr">${escapeHtml(selfName)}</span>
        <span class="matchup__sub">${escapeHtml(subSelf)}</span>
      </div>
      <div class="matchup__center">
        <div class="matchup__when">${escapeHtml(whenLine)}</div>
        <div class="matchup__venue">${escapeHtml(venueText)}</div>
      </div>
      <div class="matchup__team matchup__team--right">
        ${oppLogo}
        <span class="matchup__abbr">${escapeHtml(oppName)}</span>
        <span class="matchup__sub">${escapeHtml(subOpp)}</span>
      </div>
    </div>
    ${seriesBlock}
    <div class="broadcast">
      <p class="broadcast__label">Tonight</p>
      <p class="broadcast__nets">${nets}</p>
    </div>
  `;
}

function renderSeriesTab(game, teamAbbrev, lastGame) {
  if (!game || game.gameType !== 3) {
    const last = lastGame && lastGame.gameType === 3 ? lastGame : null;
    const links = last ? mediaLinksHtml(last) : "";
    return `
      <div class="card-head series-body">
        <p class="card-head__kicker">Series overview</p>
        <h2 class="card-head__title">No upcoming playoff game</h2>
        <p class="empty-state" style="margin-top:10px">When the club lines up a postseason game, series status and a win tracker will show here.</p>
        ${links ? `<div style="margin-top:14px"><p class="card-head__kicker">Latest playoff result</p>${links}</div>` : ""}
      </div>
    `;
  }

  const abbr = teamAbbrev.toUpperCase();
  const line = seriesLineSentence(game);
  const skew = buildSeriesSkew(game);
  const last = lastGame && lastGame.gameType === 3 ? lastGame : null;

  return `
    <div class="card-head">
      <p class="card-head__kicker">Series overview</p>
      <h2 class="card-head__title">${escapeHtml(roundGameTitle(game))}</h2>
    </div>
    <p class="series-line-label">${escapeHtml(line)}</p>
    ${skew}
    ${last ? `<div style="margin-top:14px"><p class="card-head__kicker">Last playoff game</p>${mediaLinksHtml(last)}</div>` : ""}
  `;
}

function mediaLinksHtml(game) {
  const m = pickMediaLinks(game);
  const parts = [];
  if (m.highlights) {
    parts.push(
      `<a class="link-pill" href="${escapeHtml(m.highlights)}" target="_blank" rel="noopener noreferrer">Highlights</a>`,
    );
  }
  if (m.gameCenter) {
    parts.push(
      `<a class="link-pill" href="${escapeHtml(m.gameCenter)}" target="_blank" rel="noopener noreferrer">GameCenter</a>`,
    );
  }
  return parts.length ? `<div class="links-inline">${parts.join("")}</div>` : "";
}

function renderStandingsTab() {
  const rows = cachedStandings.rows;
  if (!rows.length) {
    return `<p class="empty-state">Standings are not available.</p>`;
  }
  const byConf = new Map();
  for (const row of rows) {
    const c = row.conferenceAbbrev || "?";
    if (!byConf.has(c)) byConf.set(c, []);
    byConf.get(c).push(row);
  }

  const parts = [];
  parts.push(
    `<p class="card-head__kicker">Playoff picture</p><h2 class="card-head__title">Standings snapshot</h2>`,
  );
  parts.push(`<p class="st-note">As of <strong>${escapeHtml(cachedStandings.date)}</strong> · top 8 per conference by API order</p>`);

  for (const [conf, group] of [...byConf.entries()].sort()) {
    const sorted = group.slice().sort((a, b) => (a.conferenceSequence ?? 999) - (b.conferenceSequence ?? 999));
    const top8 = sorted.slice(0, 8);
    const label = conf === "E" ? "Eastern" : conf === "W" ? "Western" : `Conference ${conf}`;
    parts.push(`<div class="st-conf">${escapeHtml(label)}</div>`);
    parts.push('<div class="st-table-wrap"><table class="st-table"><thead><tr><th>#</th><th>Team</th><th>PTS</th></tr></thead><tbody>');
    top8.forEach((row, idx) => {
      const abbr = escapeHtml(teamAbbrevFromRow(row));
      const pts = row.points ?? "—";
      parts.push(`<tr><td>${idx + 1}</td><td>${abbr}</td><td>${escapeHtml(String(pts))}</td></tr>`);
    });
    parts.push("</tbody></table></div>");
  }

  return parts.join("");
}

async function ensureSchedule(teamAbbrev) {
  if (!teamAbbrev) return null;
  if (scheduleCache && scheduleCache.abbrev === teamAbbrev) {
    return scheduleCache.games;
  }
  const { games } = await fetchTeamSchedule(teamAbbrev);
  scheduleCache = { abbrev: teamAbbrev, games };
  lastRefreshMs = Date.now();
  return games;
}

async function renderPanel() {
  const tab = getActiveTab();
  const team = $("team-select").value;
  setError("");

  if (!team) {
    hidePanel();
    return;
  }

  if (tab === "standings") {
    showPanel(renderStandingsTab());
    updateFooterTimestamp();
    return;
  }

  $("panel").classList.remove("hidden");
  $("panel").innerHTML = `<div class="loading schedule-loading"><span class="spinner" aria-hidden="true"></span><span class="loading-text">Loading schedule…</span></div>`;

  setScheduleFetching(true);
  try {
    const games = await ensureSchedule(team);
    if (!games) return;

    if (tab === "next") {
      const next = findNextGame(games, team);
      if (!next) {
        showPanel(`<p class="empty-state">No upcoming games for ${escapeHtml(team)} in the current season window.</p>`);
        return;
      }
      const enriched = await mergePlayoffSeriesFromScoreboard(next);
      showPanel(renderNextGameCard(enriched, team));
    } else {
      const nextP = findNextPlayoffGame(games, team);
      const lastP = findLatestCompletedPlayoffGame(games, team);
      const lastAny = findLastCompletedGame(games, team);
      const focus = nextP || lastP;
      const enriched = focus ? await mergePlayoffSeriesFromScoreboard(focus) : null;
      const enrichedLast = lastAny && lastAny.gameType === 3 ? await mergePlayoffSeriesFromScoreboard(lastAny) : lastAny;
      showPanel(renderSeriesTab(enriched, team, enrichedLast));
    }
  } catch (err) {
    console.error(err);
    hidePanel();
    setError(err?.message || "Failed to load schedule.");
  } finally {
    setScheduleFetching(false);
    updateFooterTimestamp();
  }
}

async function refreshStandingsAndPanel() {
  try {
    setScheduleFetching(true);
    const { date, rows } = await fetchStandingsWithFallback();
    cachedStandings = { date, rows };
    const playoffRows = pickPlayoffTeams(rows);
    if (!playoffRows.length) throw new Error("Could not determine playoff teams.");
    teamsCatalog = sortTeamsForUi(playoffRows).map((row) => ({
      abbrev: teamAbbrevFromRow(row),
      name: teamDisplayName(row),
      logo: typeof row.teamLogo === "string" ? row.teamLogo : undefined,
    }));
    const sel = $("team-select");
    const prev = sel.value;
    sel.innerHTML =
      `<option value="">Select a team…</option>` +
      teamsCatalog.map((t) => `<option value="${escapeHtml(t.abbrev)}">${escapeHtml(t.name)}</option>`).join("");
    if (prev && teamsCatalog.some((t) => t.abbrev === prev)) {
      sel.value = prev;
    } else if (teamsCatalog.length) {
      sel.value = teamsCatalog[0].abbrev;
    }
    updateTeamPreview();
    scheduleCache = null;
    lastRefreshMs = Date.now();
    await renderPanel();
  } catch (err) {
    console.error(err);
    setError(err?.message || "Refresh failed.");
  } finally {
    setScheduleFetching(false);
    updateFooterTimestamp();
  }
}

async function init() {
  setLoading(true);
  setError("");
  hidePanel();

  try {
    const { date, rows } = await fetchStandingsWithFallback();
    cachedStandings = { date, rows };
    const playoffRows = pickPlayoffTeams(rows);
    if (!playoffRows.length) {
      throw new Error("Could not determine playoff teams from standings.");
    }
    teamsCatalog = sortTeamsForUi(playoffRows).map((row) => ({
      abbrev: teamAbbrevFromRow(row),
      name: teamDisplayName(row),
      logo: typeof row.teamLogo === "string" ? row.teamLogo : undefined,
    }));

    const sel = $("team-select");
    sel.innerHTML =
      `<option value="">Select a team…</option>` +
      teamsCatalog.map((t) => `<option value="${escapeHtml(t.abbrev)}">${escapeHtml(t.name)}</option>`).join("");

    if (teamsCatalog.length) {
      sel.selectedIndex = 1;
      updateTeamPreview();
    }
    lastRefreshMs = Date.now();
    await renderPanel();
  } catch (err) {
    console.error(err);
    setError(err?.message || "Failed to load playoff teams.");
    $("team-select").innerHTML = `<option value="">Unavailable</option>`;
  } finally {
    setLoading(false);
    updateFooterTimestamp();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void init();

  $("team-select").addEventListener("change", () => {
    updateTeamPreview();
    scheduleCache = null;
    void renderPanel();
  });

  for (const btn of document.querySelectorAll(".segmented__tab")) {
    btn.addEventListener("click", () => {
      setActiveTab(btn.dataset.panelTab || "next");
      void renderPanel();
    });
  }

  $("btn-refresh").addEventListener("click", () => {
    void refreshStandingsAndPanel();
  });

  $("btn-settings").addEventListener("click", () => {
    const v = chrome.runtime.getManifest().version;
    window.alert(
      `NHL Playoff Tracker\nVersion ${v}\n\nNo syncable settings yet. Data loads fresh from the NHL API when you open or refresh the popup.`,
    );
  });

  $("btn-help").addEventListener("click", () => {
    window.alert(
      "Pick a playoff-position team, then use the tabs:\n\n• Next game — upcoming opponent, time (ET), venue, TV, and playoff series tracker when applicable.\n\n• Series overview — playoff series context; links to the last playoff recap when available.\n\n• Standings — top eight per conference from the latest standings snapshot.\n\nUse Refresh to pull the latest API data.",
    );
  });

  setInterval(updateFooterTimestamp, 15000);
});
