const https = require('https');
const API_BASE = 'https://webws.365scores.com/web';
const PARAMS = 'appTypeId=5&langId=14&timezoneName=America/Bogota&userCountryId=109';

function fetchOnce(url) {
  return new Promise((ok, fail) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => ok(d));
    });
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.on('error', fail);
  });
}

/** fetch con reintento (1 retry con backoff) — un fallo de red no debe matar el ciclo */
async function fetch(url) {
  try {
    return await fetchOnce(url);
  } catch (e) {
    await new Promise(r => setTimeout(r, 2000));
    return fetchOnce(url);
  }
}

function sanitizeLeague(league) {
  if (!league) return '';
  let clean = league.replace(/\s+[A-Z0-9]{6,}$/i, '').trim();
  return clean || league;
}

/** Get all live matches from 365scores */
async function fetchLiveMatches() {
  let body, j;
  // Usar la fecha de Colombia, no UTC — en GitHub Actions el runner esta en UTC
  // y pasada la medianoche UTC la fecha adelanta un dia mientras en Colombia
  // sigue siendo ayer, y la API de 365scores devuelve 0 partidos para fecha futura.
  const co = new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' });
  const d = new Date(co);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const dateStr = `${dd}/${mm}/${yyyy}`;
  try { body = await fetch(`${API_BASE}/games/allscores/?${PARAMS}&sports=1&startDate=${dateStr}&endDate=${dateStr}&showOdds=true&onlyLiveGames=true&withTop=true&topBookmaker=4`); j = JSON.parse(body); } catch { return []; }
  if (!j.games) return [];
  const now = new Date();
  const live = j.games.filter(g => {
    if (g.statusGroup !== 3 || !g.gameTime || g.gameTime <= 0) return false;
    // Calcular minuto real desde startTime para detectar datos stale
    if (g.startTime) {
      const start = new Date(g.startTime);
      const elapsedMin = (now - start) / 60000;
      // 1T: 0-47, descanso: 47-62, 2T: 62-110, terminado: >110
      let realMin;
      if (elapsedMin <= 47) realMin = elapsedMin;
      else if (elapsedMin <= 62) realMin = 45;
      else realMin = 45 + (elapsedMin - 62);
      // Si el minuto real calculado es >100, el partido ya deberia haber terminado
      if (realMin > 100) return false;
      // Si el minuto real es significativamente mayor que gameTime, el dato esta stale
      // Usar el minuto real calculado (mas confiable que gameTime congelado)
      if (realMin > g.gameTime + 5) {
        g.gameTime = Math.min(98, Math.round(realMin));
      }
    }
    // Incluir descuento (90-98): ahi se marcan muchos goles de alta conviccion
    return g.gameTime < 98;
  });
  
  return live.map(g => ({
    gameId: g.id,
    homeTeam: g.homeCompetitor?.name || '?',
    awayTeam: g.awayCompetitor?.name || '?',
    homeId: g.homeCompetitor?.id,
    awayId: g.awayCompetitor?.id,
    scoreHome: g.homeCompetitor?.score ?? 0,
    scoreAway: g.awayCompetitor?.score ?? 0,
    minute: g.gameTime || 0,
    league: sanitizeLeague(g.competitionDisplayName || ''),
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
  // Formula estable (backtest: variante "Opta-like" empeoro Brier 0.330→0.336 → revertida)
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
    // Ahora SI mapeadas desde 365scores:
    xgHomeA: null, xgAwayA: null, // xA no disponible directamente
    touchesOppBoxHome: null, touchesOppBoxAway: null, // No disponible en 365scores
    savesHome: null, savesAway: null, // 365scores no expone atajadas directamente
    passesFinalThirdHome: h('passesFinalThird'), passesFinalThirdAway: a('passesFinalThird'),
    crossesHome: h('crosses'), crossesAway: a('crosses'),
    keyPassesHome: h('keyPasses'), keyPassesAway: a('keyPasses'),
    tacklesHome: h('tacklesWon'), tacklesAway: a('tacklesWon'),
    interceptionsHome: h('interceptions'), interceptionsAway: a('interceptions'),
    errorsLeadingToShotHome: null, errorsLeadingToShotAway: null,
    clearancesHome: h('clearances'), clearancesAway: a('clearances'),
    possessionLostHome: h('possessionLost'), possessionLostAway: a('possessionLost'),
    possessionWonFinalThirdHome: h('possessionWonFinalThird'), possessionWonFinalThirdAway: a('possessionWonFinalThird'),
    dribblesHome: h('dribbles'), dribblesAway: a('dribbles'),
    duelsWonHome: h('duelsWon'), duelsWonAway: a('duelsWon'),
    aerialDuelsWonHome: h('aerialDuelsWon'), aerialDuelsWonAway: a('aerialDuelsWon'),
  };
}

/**
 * Template con TODAS las claves de stats en null.
 * Usar como base del objeto fallback para que los checks `!== null`
 * en analyzeGoal no pasen con `undefined` (undefined !== null === true).
 */
const NULL_STATS = {
  xgHome: null, xgAway: null, xgotHome: null, xgotAway: null,
  sotHome: null, sotAway: null, totalShotsHome: null, totalShotsAway: null,
  shotsInsideBoxHome: null, shotsInsideBoxAway: null,
  shotsOutsideBoxHome: null, shotsOutsideBoxAway: null,
  shotsOffTargetHome: null, shotsOffTargetAway: null,
  blockedShotsHome: null, blockedShotsAway: null,
  bigChancesHome: null, bigChancesAway: null,
  hitWoodworkHome: null, hitWoodworkAway: null,
  cornersHome: null, cornersAway: null,
  possessionHome: null, possessionAway: null,
  foulsHome: null, foulsAway: null,
  yellowCardsHome: null, yellowCardsAway: null,
  redCardsHome: null, redCardsAway: null,
  offsideHome: null, offsideAway: null,
  attacksHome: null, attacksAway: null,
  xgHomeA: null, xgAwayA: null,
  touchesOppBoxHome: null, touchesOppBoxAway: null,
  savesHome: null, savesAway: null,
  passesFinalThirdHome: null, passesFinalThirdAway: null,
  crossesHome: null, crossesAway: null,
  keyPassesHome: null, keyPassesAway: null,
  tacklesHome: null, tacklesAway: null,
  interceptionsHome: null, interceptionsAway: null,
  errorsLeadingToShotHome: null, errorsLeadingToShotAway: null,
  clearancesHome: null, clearancesAway: null,
  possessionLostHome: null, possessionLostAway: null,
  possessionWonFinalThirdHome: null, possessionWonFinalThirdAway: null,
  dribblesHome: null, dribblesAway: null,
  duelsWonHome: null, duelsWonAway: null,
  aerialDuelsWonHome: null, aerialDuelsWonAway: null,
};

module.exports = {
  fetchLiveMatches, fetchMatchStats, verifyFinishedMatch,
  fetchLeagueContext, toInternalFormat, estimateXg, NULL_STATS
};
