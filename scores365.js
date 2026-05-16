const https = require('https');
const API_BASE = 'https://webws.365scores.com/web';
const PARAMS = 'appTypeId=5&langId=14&timezoneName=America/Bogota&userCountryId=109';

function fetch(url) {
  return new Promise((ok, fail) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => ok(d));
    }).on('error', fail);
  });
}

/** Get all live matches from 365scores */
async function fetchLiveMatches() {
  let body, j;
  try { body = await fetch(`${API_BASE}/games/?${PARAMS}&sports=1`); j = JSON.parse(body); } catch { return []; }
  if (!j.games) return [];
  const live = j.games.filter(g => g.statusGroup === 3 && g.gameTime > 0 && g.gameTime < 90);
  
  return live.map(g => ({
    gameId: g.id,
    homeTeam: g.homeCompetitor?.name || '?',
    awayTeam: g.awayCompetitor?.name || '?',
    homeId: g.homeCompetitor?.id,
    awayId: g.awayCompetitor?.id,
    scoreHome: g.homeCompetitor?.score ?? 0,
    scoreAway: g.awayCompetitor?.score ?? 0,
    minute: g.gameTime || 0,
    league: g.competitionDisplayName || '',
    competitionId: g.competitionId,
    statusText: g.statusText || '',
    hasStats: g.hasStats,
    hasLineups: g.hasLineups,
  }));
}

/**
 * Get match statistics from 365scores
 * Returns object with home/away separated by competitorId.
 * @param {number} gameId - 365scores game ID
 * @param {number} homeId - home competitor ID (from fetchLiveMatches)
 * @param {number} awayId - away competitor ID (from fetchLiveMatches)
 */
async function fetchMatchStats(gameId, homeId, awayId) {
  let body, j;
  try { body = await fetch(`${API_BASE}/game/stats/?${PARAMS}&games=${gameId}`); j = JSON.parse(body); } catch { return null; }
  if (!j.statistics || j.statistics.length === 0) return null;
  
  const stats = { home: {}, away: {}, raw: j.statistics };
  
  for (const s of j.statistics) {
    let side;
    if (s.competitorId === homeId) side = 'home';
    else if (s.competitorId === awayId) side = 'away';
    else continue;
    
    const key = statNameToInternal(s.name);
    if (key) {
      const rawVal = parseFloat(s.value) || 0;
      const pctVal = s.valuePercentage !== undefined ? s.valuePercentage : null;
      // Store both raw value and percentage
      stats[side][key] = rawVal;
      stats[side][key + 'Pct'] = pctVal;
    }
  }
  
  return stats;
}

/** Map 365scores stat names to internal stat keys */
function statNameToInternal(name) {
  const map = {
    'Posesión': 'possession',
    'Total Remates': 'totalShots',
    'Remates a Puerta': 'shotsOnTarget',
    'Remates Fuera': 'shotsOffTarget',
    'Remates bloqueados': 'blockedShots',
    'Remates dentro del área': 'shotsInsideBox',
    'Remates fuera del área': 'shotsOutsideBox',
    'Grandes chances': 'bigChances',
    'Pelotas al poste': 'hitWoodwork',
    'Saques de Esquina': 'corners',
    'Fueras de Juego': 'offside',
    'Ataques': 'attacks',
    'Saques de falta': 'freeKicks',
    'Total de pases': 'totalPasses',
    'Pases completados': 'passesCompleted',
    'Centros': 'crosses',
    'Pases claves': 'keyPasses',
    'Pases en el último tercio': 'passesFinalThird',
    'Saques de banda': 'throwIns',
    'Saques de puerta': 'goalKicks',
    'Tarjetas Amarillas': 'yellowCards',
    'Tarjetas Rojas': 'redCards',
    'Faltas': 'fouls',
    'Faltas recibidas': 'foulsReceived',
    'Intercepciones': 'interceptions',
    'Despejes': 'clearances',
    'Barridas ganadas': 'tacklesWon',
    'Regates': 'dribbles',
    'Duelos ganados': 'duelsWon',
    'Duelos aéreos (ganados)': 'aerialDuelsWon',
    'Posesiones perdidas': 'possessionLost',
    'Posesiones ganadas en el último tercio': 'possessionWonFinalThird',
  };
  return map[name] || null;
}

/** Map internal stat keys back to 365scores names (for display) */
const internalToDisplay = {
  possession: 'Posesión', totalShots: 'Total Remates', shotsOnTarget: 'Remates a Puerta',
  shotsInsideBox: 'Remates dentro del área', bigChances: 'Grandes chances',
  corners: 'Saques de Esquina', attacks: 'Ataques',
  yellowCards: 'Tarjetas Amarillas', redCards: 'Tarjetas Rojas',
  fouls: 'Faltas', offside: 'Fueras de Juego',
};

/** Verify finished match result */
async function verifyFinishedMatch(gameId) {
  let body, j;
  try { body = await fetch(`${API_BASE}/game/?${PARAMS}&gameId=${gameId}`); j = JSON.parse(body); } catch { return null; }
  if (!j.game) return null;
  const g = j.game;
  if (g.statusGroup !== 4 && g.statusText !== 'Finalizado') return null;
  return {
    home: g.homeCompetitor?.score ?? 0,
    away: g.awayCompetitor?.score ?? 0,
    homeTeam: g.homeCompetitor?.name,
    awayTeam: g.awayCompetitor?.name,
  };
}

/** Fetch league context (averages for goals, corners, cards) */
async function fetchLeagueContext(competitionId) {
  if (!competitionId) return null;
  let body, j;
  try { body = await fetch(`${API_BASE}/stats/?${PARAMS}&competitions=${competitionId}&competitors=`); j = JSON.parse(body); } catch { return null; }
  const stats = j.stats?.competitorsStats;
  if (!stats) return null;

  const ctx = { competitionId, goalsPerMatch: null, cornersPerMatch: null, yellowCards: null, redCards: null };
  for (const s of stats) {
    const avg = s.averageStat?.value ? parseFloat(s.averageStat.value) : null;
    switch (s.name?.toLowerCase()) {
      case 'goles por partido': ctx.goalsPerMatch = avg ? avg * 2 : null; break;
      case 'cornes por partido': ctx.cornersPerMatch = avg ? avg * 2 : null; break;
      case 'tarjetas amarillas': ctx.yellowCards = avg ? avg * 2 : null; break;
      case 'tarjetas rojas': ctx.redCards = avg ? avg * 2 : null; break;
    }
  }
  // Team lookup
  ctx.teams = {};
  const competitors = j.competitors || [];
  for (const c of competitors) {
    if (c.sportId === 1 && c.name) ctx.teams[c.name.toLowerCase()] = c.id;
  }
  return ctx;
}

/** Estimate xG from available stats (365scores doesn't provide per-match xG) */
function estimateXg(stats) {
  // Rough estimation based on shot quality metrics
  // shotsInsideBox * 0.08 + shotsOnTarget * 0.15 + bigChances * 0.12
  const h = (k) => stats.home[k] !== undefined ? stats.home[k] : 0;
  const a = (k) => stats.away[k] !== undefined ? stats.away[k] : 0;
  const homeXg = h('shotsInsideBox') * 0.08 + h('shotsOnTarget') * 0.15 + h('bigChances') * 0.12;
  const awayXg = a('shotsInsideBox') * 0.08 + a('shotsOnTarget') * 0.15 + a('bigChances') * 0.12;
  return { home: Math.round(homeXg * 100) / 100, away: Math.round(awayXg * 100) / 100 };
}

/** Convert 365scores match stats to internal format (compatible with flashscore format) */
function toInternalFormat(stats, match) {
  const h = (key) => stats.home[key] !== undefined ? stats.home[key] : null;
  const a = (key) => stats.away[key] !== undefined ? stats.away[key] : null;
  
  // Convert percentages to 0-1 range for possession-like stats
  const hPct = (key) => {
    const v = stats.home[key];
    return v !== undefined ? (v > 1 ? v / 100 : v) : null;
  };
  const aPct = (key) => {
    const v = stats.away[key];
    return v !== undefined ? (v > 1 ? v / 100 : v) : null;
  };
  
  const estXg = estimateXg(stats);
  
  return {
    xgHome: estXg.home, xgAway: estXg.away,
    xgotHome: null, xgotAway: null,
    sotHome: h('shotsOnTarget'), sotAway: a('shotsOnTarget'),
    totalShotsHome: h('totalShots'), totalShotsAway: a('totalShots'),
    shotsInsideBoxHome: h('shotsInsideBox'), shotsInsideBoxAway: a('shotsInsideBox'),
    shotsOutsideBoxHome: h('shotsOutsideBox'), shotsOutsideBoxAway: a('shotsOutsideBox'),
    shotsOffTargetHome: h('shotsOffTarget'), shotsOffTargetAway: a('shotsOffTarget'),
    blockedShotsHome: h('blockedShots'), blockedShotsAway: a('blockedShots'),
    bigChancesHome: h('bigChances'), bigChancesAway: a('bigChances'),
    hitWoodworkHome: h('hitWoodwork'), hitWoodworkAway: a('hitWoodwork'),
    cornersHome: h('corners'), cornersAway: a('corners'),
    possessionHome: hPct('possession'), possessionAway: aPct('possession'),
    foulsHome: h('fouls'), foulsAway: a('fouls'),
    yellowCardsHome: h('yellowCards'), yellowCardsAway: a('yellowCards'),
    redCardsHome: h('redCards'), redCardsAway: a('redCards'),
    offsideHome: h('offside'), offsideAway: a('offside'),
    attacksHome: h('attacks'), attacksAway: a('attacks'),
    // Not available from 365:
    xgHomeA: null, xgAwayA: null,
    touchesOppBoxHome: null, touchesOppBoxAway: null,
    savesHome: null, savesAway: null,
    passesFinalThirdHome: null, passesFinalThirdAway: null,
    crossesHome: null, crossesAway: null,
    tacklesHome: null, tacklesAway: null,
    interceptionsHome: null, interceptionsAway: null,
    errorsLeadingToShotHome: null, errorsLeadingToShotAway: null,
    clearancesHome: null, clearancesAway: null,
  };
}

module.exports = {
  fetchLiveMatches, fetchMatchStats, verifyFinishedMatch,
  fetchLeagueContext, toInternalFormat, estimateXg,
  statNameToInternal, internalToDisplay
};
