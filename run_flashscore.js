const fs = require('fs');
const path = require('path');
const { fetchAllLiveMatches, verifyFinishedMatch } = require('./flashscore_fetcher');
const { runLearning } = require('./learn');
const notify = require('./notify');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const WEIGHTS_FILE = path.join(__dirname, 'weights.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');

const DEFAULT_WEIGHTS = {
  version: 1, learningRate: 0.05,
  global: {
    xg: 30, shotsOnTarget: 25, shotsInsideBox: 18, bigChances: 15, totalShots: 10,
    xgot: 12, hitWoodwork: 10, xA: 8, touchesOppBox: 8,
    scoreNeeds: 10, timePressure: 8, corners: 5, possession: 5, saves: 5, goalsScored: -10,
    teamFactor: 8, leagueFactor: 5
  },
  byLeague: {},
  stats: { predictionsCount: 0, correctScore: 0, correctScorer: 0 }
};

function deepMerge(defaults, loaded) {
  const result = { ...defaults };
  for (const key of Object.keys(loaded)) {
    if (typeof defaults[key] === 'object' && defaults[key] !== null && !Array.isArray(defaults[key])) {
      result[key] = deepMerge(defaults[key], loaded[key]);
    } else if (loaded[key] !== undefined) {
      result[key] = loaded[key];
    }
  }
  return result;
}

function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
      const merged = deepMerge(DEFAULT_WEIGHTS, loaded);
      // Ensure all global keys exist
      for (const k of Object.keys(DEFAULT_WEIGHTS.global)) {
        if (merged.global[k] === undefined) merged.global[k] = DEFAULT_WEIGHTS.global[k];
      }
      return merged;
    }
  } catch {}
  return { ...DEFAULT_WEIGHTS, global: { ...DEFAULT_WEIGHTS.global } };
}
function saveWeights(w) { w.lastUpdated = new Date().toISOString(); fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2)); }
function loadPredictions() {
  try { if (fs.existsSync(PREDICTIONS_FILE)) return JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8')); } catch {}
  return [];
}
function savePredictions(p) { fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(p, null, 2)); }
function getLeagueWeights(weights, league) {
  const w = { ...weights.global };
  if (league && weights.byLeague[league]) Object.keys(w).forEach(k => { if (weights.byLeague[league][k] !== undefined) w[k] = weights.byLeague[league][k]; });
  return w;
}
function parseNum(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function parsePct(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return s.includes('%') ? (parseFloat(s.replace('%', '')) / 100) : parseNum(v);
}

function flashscoreStatsToInternal(flashStats) {
  const get = (name) => flashStats[name] || {};
  const h = (name) => parseNum(get(name).home);
  const a = (name) => parseNum(get(name).away);
  const hPct = (name) => parsePct(get(name).home);
  const aPct = (name) => parsePct(get(name).away);

  return {
      xgHome: h('Expected goals (xG)'), xgAway: a('Expected goals (xG)'),
    xgotHome: h('xG on target (xGOT)'), xgotAway: a('xG on target (xGOT)'),
    sotHome: h('Shots on target'), sotAway: a('Shots on target'),
    totalShotsHome: h('Total shots'), totalShotsAway: a('Total shots'),
    shotsInsideBoxHome: h('Shots inside the box'), shotsInsideBoxAway: a('Shots inside the box'),
    shotsOutsideBoxHome: h('Shots outside the box'), shotsOutsideBoxAway: a('Shots outside the box'),
    shotsOffTargetHome: h('Shots off target'), shotsOffTargetAway: a('Shots off target'),
    blockedShotsHome: h('Blocked shots'), blockedShotsAway: a('Blocked shots'),
    bigChancesHome: h('Big chances'), bigChancesAway: a('Big chances'),
    hitWoodworkHome: h('Hit the woodwork'), hitWoodworkAway: a('Hit the woodwork'),
    cornersHome: h('Corner kicks'), cornersAway: a('Corner kicks'),
    possessionHome: hPct('Ball possession'), possessionAway: aPct('Ball possession'),
    touchesOppBoxHome: h('Touches in opposition box'), touchesOppBoxAway: a('Touches in opposition box'),
    savesHome: h('Goalkeeper saves'), savesAway: a('Goalkeeper saves'),
    foulsHome: h('Fouls'), foulsAway: a('Fouls'),
    yellowCardsHome: h('Yellow cards'), yellowCardsAway: a('Yellow cards'),
    xgHomeA: h('Expected assists (xA)'), xgAwayA: a('Expected assists (xA)'),
    passesFinalThirdHome: hPct('Passes in final third'), passesFinalThirdAway: aPct('Passes in final third'),
    crossesHome: h('Crosses'), crossesAway: a('Crosses'),
    tacklesHome: h('Tackles'), tacklesAway: a('Tackles'),
    interceptionsHome: h('Interceptions'), interceptionsAway: a('Interceptions'),
    errorsLeadingToShotHome: h('Errors leading to shot'), errorsLeadingToShotAway: a('Errors leading to shot'),
    clearancesHome: h('Clearances'), clearancesAway: a('Clearances')
  };
}

function analyzeGoal(match, w, teams) {
  let score = 0;
  let reasons = [];
  let predictedScorer = null;
  let scorerReasons = [];
  const s = match.stats;
  const goals = (match.scoreHome || 0) + (match.scoreAway || 0);
  const minute = match.minute || 0;
  const homeNeeds = match.scoreHome < match.scoreAway;
  const awayNeeds = match.scoreAway < match.scoreHome;
  const draw = match.scoreHome === match.scoreAway;
  let pressure = 0;

  // --- xG ---
  if (s.xgHome !== null && s.xgAway !== null) {
    const totalXG = s.xgHome + s.xgAway, remaining = totalXG - goals;
    if (remaining > 1.5) { score += w.xg * 1; pressure += 30; reasons.push('Alto xG restante (' + remaining.toFixed(2) + ')'); }
    else if (remaining > 0.8) { score += w.xg * 0.75; pressure += 20; reasons.push('xG restante ' + remaining.toFixed(2)); }
    else if (remaining > 0.3) { score += w.xg * 0.4; pressure += 10; }
    if (totalXG > 1.5 && goals === 0) { score += w.xg * 0.5; pressure += 15; reasons.push('0-0 con alto xG!'); }
    if (totalXG > 1.0 && goals <= 1) score += w.xg * 0.25;
    if (s.xgHome > s.xgAway + 0.5) { predictedScorer = 'home'; scorerReasons.push('xG superior'); }
    else if (s.xgAway > s.xgHome + 0.5) { predictedScorer = 'away'; scorerReasons.push('xG superior'); }
  }

  // --- xGOT (calidad real de tiros) ---
  if (s.xgotHome !== null && s.xgotAway !== null) {
    const total = s.xgotHome + s.xgotAway;
    if (total > 2) { score += w.xgot * 1; pressure += 15; reasons.push('Alta calidad de tiro (xGOT ' + total.toFixed(2) + ')'); }
    else if (total > 1) { score += w.xgot * 0.6; pressure += 8; }
    if (s.xgotHome > s.xgotAway + 0.5 && !predictedScorer) { predictedScorer = 'home'; scorerReasons.push('mejores tiros'); }
    else if (s.xgotAway > s.xgotHome + 0.5 && !predictedScorer) { predictedScorer = 'away'; scorerReasons.push('mejores tiros'); }
  }

  // --- Shots on target ---
  if (s.sotHome !== null && s.sotAway !== null) {
    const total = s.sotHome + s.sotAway;
    if (total >= 8) { score += w.shotsOnTarget * 1; pressure += 20; reasons.push(total + ' tiros a puerta!'); }
    else if (total >= 5) { score += w.shotsOnTarget * 0.7; pressure += 15; reasons.push(total + ' a puerta'); }
    else if (total >= 3) { score += w.shotsOnTarget * 0.4; pressure += 8; }
    if (total >= 4 && goals === 0) { score += w.shotsOnTarget * 0.6; pressure += 10; reasons.push('Tiran a puerta pero no entran'); }
    if (total >= 6 && goals <= 1) score += w.shotsOnTarget * 0.4;
    if (!predictedScorer) {
      if (s.sotHome >= s.sotAway + 3) { predictedScorer = 'home'; scorerReasons.push('domina tiros a puerta'); }
      else if (s.sotAway >= s.sotHome + 3) { predictedScorer = 'away'; scorerReasons.push('domina tiros a puerta'); }
    }
  }

  // --- Shots inside box (mucho mas peligrosos que fuera) ---
  if (s.shotsInsideBoxHome !== null && s.shotsInsideBoxAway !== null) {
    const total = s.shotsInsideBoxHome + s.shotsInsideBoxAway;
    if (total >= 8) { score += w.shotsInsideBox * 1; pressure += 20; reasons.push(total + ' tiros dentro del area!'); }
    else if (total >= 4) { score += w.shotsInsideBox * 0.7; pressure += 12; reasons.push(total + ' tiros dentro area'); }
    else if (total >= 2) { score += w.shotsInsideBox * 0.4; pressure += 6; }

    // Ratio inside/total: si la mayoria son dentro, mas peligro
    if (s.totalShotsHome !== null && s.totalShotsAway !== null) {
      const totalShots = s.totalShotsHome + s.totalShotsAway;
      if (totalShots > 0 && total / totalShots > 0.5 && total >= 3) {
        score += w.shotsInsideBox * 0.5;
        reasons.push('Ataques penetrantes (' + Math.round(total / totalShots * 100) + '% dentro area)');
      }
    }
    if (!predictedScorer) {
      if (s.shotsInsideBoxHome >= s.shotsInsideBoxAway + 4) { predictedScorer = 'home'; scorerReasons.push('penetra el area'); }
      else if (s.shotsInsideBoxAway >= s.shotsInsideBoxHome + 4) { predictedScorer = 'away'; scorerReasons.push('penetra el area'); }
    }
  }

  // --- Hit the woodwork (casi-goles) ---
  if (s.hitWoodworkHome !== null && s.hitWoodworkAway !== null) {
    const total = s.hitWoodworkHome + s.hitWoodworkAway;
    if (total >= 1) { score += w.hitWoodwork * total; pressure += 5 * total; reasons.push(total + ' palos!'); }
  }

  // --- xA (expected assists) ---
  if (s.xgHomeA !== null && s.xgAwayA !== null) {
    const total = s.xgHomeA + s.xgAwayA;
    if (total > 0.8) { score += w.xA * 1; pressure += 10; reasons.push('Creacion de calidad (xA ' + total.toFixed(2) + ')'); }
    else if (total > 0.4) { score += w.xA * 0.5; pressure += 5; }
  }

  // --- Touches in opposition box ---
  if (s.touchesOppBoxHome !== null && s.touchesOppBoxAway !== null) {
    const total = s.touchesOppBoxHome + s.touchesOppBoxAway;
    if (total >= 20) { score += w.touchesOppBox * 1; pressure += 10; reasons.push('Constante presion (' + total + ' toques area rival)'); }
    else if (total >= 10) { score += w.touchesOppBox * 0.5; pressure += 5; }
  }

  // --- Total shots ---
  if (s.totalShotsHome !== null && s.totalShotsAway !== null) {
    const total = s.totalShotsHome + s.totalShotsAway;
    if (total >= 25) { score += w.totalShots * 1; pressure += 10; reasons.push('Alta frecuencia (' + total + ')'); }
    else if (total >= 15) { score += w.totalShots * 0.5; pressure += 5; }
    if (!predictedScorer) {
      if (s.totalShotsHome >= s.totalShotsAway + 8) { predictedScorer = 'home'; scorerReasons.push('domina tiros'); }
      else if (s.totalShotsAway >= s.totalShotsHome + 8) { predictedScorer = 'away'; scorerReasons.push('domina tiros'); }
    }
  }

  // --- Big chances ---
  if (s.bigChancesHome !== null && s.bigChancesAway !== null) {
    const total = s.bigChancesHome + s.bigChancesAway;
    if (total >= 5) { score += w.bigChances * 1; pressure += 15; reasons.push(total + ' ocasiones claras!'); }
    else if (total >= 2) { score += w.bigChances * 0.5; pressure += 8; }
    if (!predictedScorer) {
      if (s.bigChancesHome > s.bigChancesAway) { predictedScorer = 'home'; scorerReasons.push('mas ocasiones claras'); }
      else if (s.bigChancesAway > s.bigChancesHome) { predictedScorer = 'away'; scorerReasons.push('mas ocasiones claras'); }
    }
  }

  // --- Score needs ---
  if (draw && goals > 0) { score += w.scoreNeeds * 0.5; reasons.push('Empate, ambos buscan el gol'); }
  if (draw && goals === 0) { score += w.scoreNeeds * 0.8; pressure += 5; reasons.push('0-0, cualquiera lo rompe'); }
  if (homeNeeds) { score += w.scoreNeeds * 0.8; pressure += 5; reasons.push('Local necesita el gol'); if (!predictedScorer) { predictedScorer = 'home'; scorerReasons.push('necesita el gol'); } }
  if (awayNeeds) { score += w.scoreNeeds * 0.8; pressure += 5; reasons.push('Visitante necesita el gol'); if (!predictedScorer) { predictedScorer = 'away'; scorerReasons.push('necesita el gol'); } }
  if (goals >= 4) { score += w.goalsScored; reasons.push('Goleada, el ritmo baja'); }

  // --- Time pressure ---
  if (minute >= 80 && pressure >= 20) { score += w.timePressure * 1; reasons.push('Min ' + minute + "' — presion final!"); }
  else if (minute >= 70 && pressure >= 25) { score += w.timePressure * 0.8; reasons.push('Min ' + minute + "' — definicion"); }
  else if (minute >= 60 && pressure >= 30) { score += w.timePressure * 0.5; }
  else if (minute < 20 && pressure >= 25) { score += w.timePressure * 0.5; reasons.push('Presion desde el inicio'); }

  // --- Corners ---
  if (s.cornersHome !== null && s.cornersAway !== null) {
    const total = s.cornersHome + s.cornersAway;
    if (total >= 12) { score += w.corners * 1; pressure += 5; reasons.push('Presion constante (' + total + ' corners)'); }
    else if (total >= 8) score += w.corners * 0.6;
  }

  // --- Possession + need ---
  if (s.possessionHome !== null && s.possessionAway !== null) {
    if (s.possessionAway > 0.58 && awayNeeds) { score += w.possession * 1; pressure += 5; reasons.push('Visitante domina y necesita'); if (!predictedScorer) { predictedScorer = 'away'; scorerReasons.push('domina y necesita'); } }
    if (s.possessionHome > 0.58 && homeNeeds) { score += w.possession * 1; pressure += 5; reasons.push('Local domina y necesita'); if (!predictedScorer) { predictedScorer = 'home'; scorerReasons.push('domina y necesita'); } }
    if (Math.abs(s.possessionHome - s.possessionAway) > 0.20 && goals === 0) { score += w.possession * 1; pressure += 5; reasons.push('Un equipo domina pero no concreta'); }
  }

  // --- Saves ---
  if (s.savesHome !== null && s.savesAway !== null) {
    const total = s.savesHome + s.savesAway;
    if (total >= 8) { score += w.saves * 1; reasons.push('Porteros muy exigidos'); }
    else if (total >= 5) score += w.saves * 0.6;
  }

  // --- Team factor (historial del equipo) ---
  if (teams) {
    const teamNames = Object.keys(teams);
    if (teamNames.length > 0) {
      // Buscar si tenemos datos de estos equipos (normalizado)
      const normalize = (s) => s?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
      const h = normalize(match.teamHome), a = normalize(match.teamAway);
      let homeFactor = 1.0, awayFactor = 1.0;
      for (const [name, data] of Object.entries(teams)) {
        const n = normalize(name);
        if (h.includes(n) || n.includes(h)) {
          if (data.timesPredictedGoal >= 2) {
            const rate = data.goalsWhenPredicted / data.timesPredictedGoal;
            homeFactor = rate > 0.7 ? 1 + (rate - 0.7) * 0.5 : rate < 0.3 ? 1 - (0.3 - rate) * 0.5 : 1.0;
          }
        }
        if (a.includes(n) || n.includes(a)) {
          if (data.timesPredictedGoal >= 2) {
            const rate = data.goalsWhenPredicted / data.timesPredictedGoal;
            awayFactor = rate > 0.7 ? 1 + (rate - 0.7) * 0.5 : rate < 0.3 ? 1 - (0.3 - rate) * 0.5 : 1.0;
          }
        }
      }
      const teamBonus = Math.max(homeFactor, awayFactor);
      if (teamBonus !== 1.0) {
        const adj = Math.round((teamBonus - 1) * 100);
        if (adj > 0) { score += (w.teamFactor || 8) * (adj / 20); reasons.push('Equipo con historial de gol (' + (adj > 0 ? '+' : '') + adj + '%)'); }
        else { score += (w.teamFactor || 8) * (adj / 20); reasons.push('Equipo suele no concretar (' + adj + '%)'); }
      }
    }
  }

  // --- Time window ---
  let timeWindow = '';
  if (minute < 25) { timeWindow = pressure >= 40 ? 'Gol inminente — antes del descanso' : pressure >= 25 ? 'Probable gol antes del descanso' : 'Temprano, revaluar en 15-20 min'; }
  else if (minute < 40) { timeWindow = pressure >= 40 ? 'Gol antes del descanso (30-45)!' : pressure >= 25 ? 'Posible gol en minutos finales del 1T' : '1T tranquilo, probable gol en 2T'; }
  else if (minute < 50) { timeWindow = pressure >= 40 ? 'Gol al inicio del 2T (45-60)' : pressure >= 25 ? 'Posible gol al inicio del 2T' : 'Descanso sin mucha accion'; }
  else if (minute < 65) { timeWindow = pressure >= 40 ? 'Gol en proximos 15 min!' : pressure >= 25 ? 'Posible gol en recta final (70-85)' : 'Partido tacticamente cerrado'; }
  else if (minute < 80) { timeWindow = pressure >= 40 ? 'Gol inminente — ultimos 15 minutos!' : pressure >= 25 ? 'Posible gol en tramo final (75-90)' : 'Partido que se apaga'; }
  else { timeWindow = pressure >= 25 ? 'Gol en cualquier momento — descuento!' : 'Partido practicamente definido'; }

  const cappedScore = Math.min(Math.max(score, 0), 100);
  let verdict = cappedScore >= 60 ? 'MUY PROBABLE — casi seguro proximo gol'
    : cappedScore >= 45 ? 'PROBABLE — buenos indicios'
    : cappedScore >= 30 ? 'POSIBLE — atentos'
    : cappedScore >= 15 ? 'DUDOSO — poca actividad'
    : 'IMPROBABLE — muy pocas ocasiones';

  let whoText = '';
  if (predictedScorer && scorerReasons.length > 0 && cappedScore >= 30) {
    whoText = '\n     Proximo gol: ' + (predictedScorer === 'home' ? (match.teamHome || 'Local') : (match.teamAway || 'Visitante')) + ' (' + scorerReasons.join(', ') + ')';
  } else if (predictedScorer && cappedScore >= 45) {
    whoText = '\n     Proximo gol: ' + (predictedScorer === 'home' ? (match.teamHome || 'Local') : (match.teamAway || 'Visitante'));
  }

  return {
    match: match.rawName, teamHome: match.teamHome, teamAway: match.teamAway,
    league: match.league, matchId: match.matchId,
    score: cappedScore, verdict, timeWindow, whoText, reasons,
    minute, scoreHome: match.scoreHome, scoreAway: match.scoreAway,
    predictedScorer: predictedScorer && cappedScore >= 25 ? predictedScorer : null,
    stats: s, pressure
  };
}

function writeSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); } catch {}
  }
}

function alertsEnabled() {
  if (process.env.CI) {
    // Nube: consultar GitHub directo (evita checkout desactualizado)
    try {
      const raw = require('child_process').execSync('curl -s https://raw.githubusercontent.com/leandrobor94/gol-analyzer/main/alertas.json', { timeout: 5000, stdio: 'pipe' }).toString();
      const { enabled } = JSON.parse(raw);
      return enabled !== false;
    } catch {}
    return true;
  }
  // Local: archivo
  try {
    if (fs.existsSync('alertas.json')) {
      const { enabled } = JSON.parse(fs.readFileSync('alertas.json', 'utf8'));
      return enabled !== false;
    }
  } catch {}
  return true;
}

async function main() {

  // Si es nube y hubo ejecución local hace < 10 min, saltar
  if (process.env.CI) {
    try {
      if (fs.existsSync('last-local-run.json')) {
        const { lastRun } = JSON.parse(fs.readFileSync('last-local-run.json', 'utf8'));
        const minSince = (Date.now() - new Date(lastRun).getTime()) / 60000;
        if (minSince < 10) {
          console.log(`Ejecucion local hace ${Math.round(minSince)} min. Saltando ciclo en la nube.`);
          writeSummary('## Skip ' + new Date().toISOString() + ' - ejecucion local reciente');
          return;
        }
      }
    } catch {}
  }

  const MAX_LOOPS = 4;
  const SLEEP_MS = 12 * 60 * 1000;

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    // En la nube: traer ultimos cambios (alertas.json, pesos)
    if (process.env.CI) {
      try { require('child_process').execSync('git pull --ff-only', { stdio: 'ignore', timeout: 10000 }); } catch {}
    }

    console.log('\n' + '='.repeat(64));
    console.log('  CICLO ' + (loop + 1) + '/' + MAX_LOOPS + ' — ' + new Date().toISOString());
    console.log('='.repeat(64));

    // Validar horario Colombia (7am-10pm)
    const co = new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' });
    const coHour = new Date(co).getHours();
    if (coHour < 7 || coHour >= 22) {
      console.log('Fuera de horario Colombia (' + coHour + ':00).');
      writeSummary('## Skip ' + new Date().toISOString() + ' - fuera de horario (' + coHour + ':00 Colombia)');
      if (loop < MAX_LOOPS - 1) {
        console.log('Esperando ' + (SLEEP_MS / 60000) + ' min hasta el proximo ciclo...');
        await new Promise(r => setTimeout(r, SLEEP_MS));
      }
      continue;
    }

    let weights = loadWeights();
    let predictions = loadPredictions();
    let teams = {};
    try { if (fs.existsSync(TEAMS_FILE)) teams = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8')); } catch {}
    const analyzed = [];

    console.log('[1/3] Obteniendo partidos en vivo desde Flashscore...');
  const liveData = await fetchAllLiveMatches();
  console.log('  -> ' + liveData.length + ' partidos en vivo\n');

  writeSummary('## Analisis Flashscore ' + new Date().toISOString() + '\n- Partidos: ' + liveData.length);

  if (liveData.length > 0) {
    console.log('[2/3] Analizando ' + liveData.length + ' partidos...\n');

    for (let i = 0; i < liveData.length; i++) {
      const m = liveData[i];
      const displayName = m.homeTeam + ' vs ' + m.awayTeam;
      const league = (() => {
        try { const parts = m.url.split('/'); const idx = parts.indexOf('football'); return idx >= 0 && parts[idx + 1] ? decodeURIComponent(parts[idx + 1].replace(/-/g, ' ')) : ''; } catch { return ''; }
      })();
      console.log('  [' + (i + 1) + '/' + liveData.length + '] ' + displayName + (league ? ' (' + league + ')' : ''));

      const internalStats = flashscoreStatsToInternal(m.stats);
      const xgStr = internalStats.xgHome !== null ? internalStats.xgHome.toFixed(2) + '-' + internalStats.xgAway.toFixed(2) : '?-?';
      const sotStr = internalStats.sotHome !== null ? internalStats.sotHome + '-' + internalStats.sotAway : '?-?';
      const boxStr = internalStats.shotsInsideBoxHome !== null ? 'Box:' + internalStats.shotsInsideBoxHome + '-' + internalStats.shotsInsideBoxAway : '';
      const woodStr = internalStats.hitWoodworkHome ? ' (!)' : '';
      console.log('     -> ' + (m.status || m.minute + "'") + ' ' + (m.scoreHome ?? '?') + '-' + (m.scoreAway ?? '?') + ' | xG:' + xgStr + ' SOT:' + sotStr + (boxStr ? ' ' + boxStr : '') + woodStr);

      if ((m.minute <= 5 || (!internalStats.totalShotsHome && !internalStats.totalShotsAway)) && internalStats.totalShotsHome === null && internalStats.totalShotsAway === null) {
        console.log('  -> Recien iniciado, sin datos aun\n');
        continue;
      }

      analyzed.push({
        rawName: displayName, teamHome: m.homeTeam, teamAway: m.awayTeam,
        league, matchId: m.url, minute: m.minute || 0,
        scoreHome: m.scoreHome ?? 0, scoreAway: m.scoreAway ?? 0,
        stats: internalStats
      });
    }

    const ranked = analyzed.map(m => analyzeGoal(m, getLeagueWeights(weights, m.league), teams)).sort((a, b) => b.score - a.score);

    const now = new Date().toISOString();
    let newCount = 0;
    for (const r of ranked) {
      const existing = predictions.find(p => p.id === r.matchId && p.predictionCorrect === null);
      if (existing) {
        existing.lastSeenMinute = r.minute;
        existing.lastSeenScore = { home: r.scoreHome, away: r.scoreAway };
      } else {
        predictions.push({
          id: r.matchId, match: r.teamHome + ' vs ' + r.teamAway, league: r.league,
          teamHome: r.teamHome, teamAway: r.teamAway, timestamp: now,
          analysisMinute: r.minute, scoreAtAnalysis: { home: r.scoreHome, away: r.scoreAway }, stats: r.stats,
          predictedProbability: r.score, predictedScorer: r.predictedScorer, predictedTimeWindow: r.timeWindow,
          finalScore: null, goalAfterAnalysis: null, actualGoalMinute: null, actualScorer: null, predictionCorrect: null,
          lastSeenMinute: r.minute, lastSeenScore: { home: r.scoreHome, away: r.scoreAway }
        });
        newCount++;
      }
    }
    savePredictions(predictions);
    weights.stats.predictionsCount += newCount;
    saveWeights(weights);
    console.log('  -> ' + newCount + ' predicciones nuevas\n');

    // Actualizar lastSeen de predicciones existentes con datos actuales
    for (const pred of predictions) {
      if (pred.predictionCorrect !== null) continue;
      const lm = liveData.find(m => m.url === pred.id);
      if (lm) {
        pred.lastSeenMinute = lm.minute;
        pred.lastSeenScore = { home: lm.scoreHome ?? 0, away: lm.scoreAway ?? 0 };
      }
    }

    console.log('='.repeat(64));
    console.log('  PROXIMO GOL — ANALISIS EN VIVO (Flashscore)');
    console.log('='.repeat(64) + '\n');

    if (ranked.length > 0) {
      ranked.forEach((r, i) => {
        const medal = i === 0 ? '1.' : i === 1 ? '2.' : i === 2 ? '3.' : '  ' + (i + 1) + '.';
        const bar = '#'.repeat(Math.round(r.score / 5)) + '-'.repeat(20 - Math.round(r.score / 5));
        console.log('  ' + medal + ' [' + r.score + '%] ' + bar);
        console.log('     ' + r.teamHome + ' vs ' + r.teamAway + ' | ' + (r.minute ? r.minute + "'" : '') + ' ' + r.scoreHome + '-' + r.scoreAway);
        console.log('     ' + r.timeWindow);
        console.log('     ' + r.verdict + r.whoText);
        const xgS = r.stats.xgHome !== null ? r.stats.xgHome.toFixed(2) + '-' + r.stats.xgAway.toFixed(2) : '?-?';
        const sotS = r.stats.sotHome !== null ? r.stats.sotHome + '-' + r.stats.sotAway : '?-?';
        const bcS = r.stats.bigChancesHome !== null ? r.stats.bigChancesHome + '-' + r.stats.bigChancesAway : '?-?';
        const boxS = r.stats.shotsInsideBoxHome !== null ? r.stats.shotsInsideBoxHome + '-' + r.stats.shotsInsideBoxAway : '?-?';
        const woodS = r.stats.hitWoodworkHome !== null ? r.stats.hitWoodworkHome + '-' + r.stats.hitWoodworkAway : '';
        const xgotS = r.stats.xgotHome !== null ? r.stats.xgotHome.toFixed(2) + '-' + r.stats.xgotAway.toFixed(2) : '';
        const xaS = r.stats.xgHomeA !== null ? 'xA:' + r.stats.xgHomeA.toFixed(2) + '-' + r.stats.xgAwayA.toFixed(2) : '';
        const touchesS = r.stats.touchesOppBoxHome !== null ? 'Touches:' + r.stats.touchesOppBoxHome + '-' + r.stats.touchesOppBoxAway : '';
        const posS = r.stats.possessionHome !== null ? Math.round(r.stats.possessionHome * 100) + '%-' + Math.round(r.stats.possessionAway * 100) + '%' : '?-?';
        console.log('     xG:' + xgS + ' SOT:' + sotS + ' OC:' + bcS + ' Box:' + boxS + (woodS ? ' Palo:' + woodS : '') + (xgotS ? ' xGOT:' + xgotS : '') + ' Pos:' + posS);
        if (xaS || touchesS) console.log('     ' + [xaS, touchesS].filter(Boolean).join(' '));
        if (r.reasons.length > 0) console.log('     ' + r.reasons.join(' | '));
      });

      const top = ranked[0];
      if (top.score >= 40) {
        console.log('\n  RECOMENDACION PRINCIPAL:');
        console.log('     ' + top.teamHome + ' vs ' + top.teamAway);
        console.log('     Confianza: ' + top.score + '% — ' + top.timeWindow);
        console.log('     ' + top.verdict);
        if (top.whoText) console.log('     ' + top.whoText.trim());
      } else {
        console.log('\n  Sin recomendaciones solidas ahora.');
      }
    }

    // --- Telegram alert (solo en la nube) ---
    if (ranked.length > 0 && ranked[0].score >= 70) {
      if (!process.env.CI) {
        // Local: no mandar Telegram, ya ves la terminal
      } else if (!alertsEnabled()) {
        console.log('\nAlertas desactivadas (alertas.json). Analisis sigue corriendo.');
        writeSummary('- Alerta: Desactivada por usuario');
      } else {
        const alertKey = ranked[0].matchId;
        const lastAlert = weights.alertedMatches?.[alertKey];
        let shouldAlert = true;
        if (lastAlert) {
          const realMin = (Date.now() - lastAlert.timestamp) / 60000;
          const gameMinAdvance = (ranked[0].minute || 0) - (lastAlert.minute || 0);
          if (realMin < 30 && gameMinAdvance < 20) shouldAlert = false;
        }

        if (!shouldAlert) {
          console.log('\nAlerta omitida: mismo partido hace ' + Math.round((Date.now() - lastAlert.timestamp) / 60000) + ' min reales, ' + (ranked[0].minute - lastAlert.minute) + ' min de juego.');
          writeSummary('- Alerta: Omitida (dedup)');
        } else {
          const msg = notify.buildMessage(ranked);
          if (msg) {
            console.log('\nEnviando alerta Telegram...');
            await notify.sendTelegram(msg);
            weights.alertedMatches = weights.alertedMatches || {};
            weights.alertedMatches[alertKey] = { timestamp: Date.now(), minute: ranked[0].minute || 0 };
            // Limpiar entradas viejas (> 2h)
            const cutoff = Date.now() - 2 * 60 * 60 * 1000;
            for (const [k, v] of Object.entries(weights.alertedMatches)) {
              if (v.timestamp < cutoff) delete weights.alertedMatches[k];
            }
            saveWeights(weights);
            writeSummary('- Alerta: ENVIADA');
          }
        }
      }
    } else if (ranked.length > 0) {
      console.log('\nMejor score: ' + ranked[0].score + '% (umbral: 70%)');
      writeSummary('- Alerta: No enviada (umbral no alcanzado)');
    }
  } else {
    console.log('  Sin partidos en vivo.');
  }

  // --- APRENDIZAJE: verificar predicciones anteriores contra datos actuales ---
  console.log('\n[3/3] Aprendiendo de predicciones anteriores...');
  const learningResult = await runLearning(liveData);
  weights = learningResult.weights;
  if (learningResult.adjustments > 0) {
    console.log('  Pesos ajustados. Se usaran en el proximo analisis.');
  }
  writeSummary('- Aprendizaje: ' + learningResult.insights.length + ' fallos analizados');

  // --- VERIFICAR PARTIDOS TERMINADOS ---
  const pendingVerify = predictions.filter(p => {
    if (p.predictionCorrect !== null) return false;
    if (liveData.find(m => m.url === p.id)) return false;
    if (p.analysisMinute && p.analysisMinute >= 10) return true;
    // Si analysisMinute < 10 pero pasaron > 30 min reales, verificar igual
    if (p.timestamp) {
      const elapsed = (Date.now() - new Date(p.timestamp).getTime()) / 60000;
      return elapsed >= 30;
    }
    return false;
  });
  if (pendingVerify.length > 0) {
    console.log('\n[4/4] Verificando ' + pendingVerify.length + ' partidos terminados...');
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({ locale: 'es-CO' });
    const page = await context.newPage();
    let verifiedCount = 0;
    for (const pred of pendingVerify) {
      const score = await verifyFinishedMatch(page, pred.id);
      if (score) {
        const scoreChanged = score.home !== (pred.scoreAtAnalysis?.home ?? 0) || score.away !== (pred.scoreAtAnalysis?.away ?? 0);
        pred.finalScore = score;
        pred.goalAfterAnalysis = scoreChanged;
        const prob = (pred.predictedProbability || 0) / 100;
        const predictedGoal = prob >= 0.7;
        pred.predictionCorrect = (predictedGoal && scoreChanged) || (!predictedGoal && !scoreChanged);
        console.log('  ' + (pred.predictionCorrect ? '✓' : '✗') + ' ' + pred.match + ' | final ' + score.home + '-' + score.away + ' | pred=' + pred.predictedProbability + '%');
        verifiedCount++;
      } else {
        console.log('  ? ' + pred.match + ' | no se pudo obtener resultado');
      }
    }
    await browser.close();
    if (verifiedCount > 0) savePredictions(predictions);
    console.log('  Verificados: ' + verifiedCount);
  }

  if (liveData.length === 0) {
    console.log('  Sin partidos — no se necesita seguir. Saliendo del self-loop.');
    break;
  }

  if (loop < MAX_LOOPS - 1) {
    console.log('\nEsperando ' + (SLEEP_MS / 60000) + ' min hasta el proximo ciclo...');
    await new Promise(r => setTimeout(r, SLEEP_MS));
  }
  }
  // Marcar ejecución local para que la nube la respete
  if (!process.env.CI) {
    fs.writeFileSync('last-local-run.json', JSON.stringify({ lastRun: new Date().toISOString() }));
    console.log('\nEjecucion local registrada. La nube respetara los proximos 10 min.');
  } else {
    // En la nube: subir pesos para que la próxima ejecución recuerde qué ya alertó
    try {
      const cp = require('child_process');
      cp.execSync('git config user.email "bot@sofastats"', { stdio: 'ignore', timeout: 5000 });
      cp.execSync('git config user.name "sofastats-bot"', { stdio: 'ignore', timeout: 5000 });
      cp.execSync('git add weights.json predictions.json teams.json', { stdio: 'ignore', timeout: 5000 });
      cp.execSync('git diff --cached --quiet || (git commit -m "sync pesos [skip ci]" && git push)', { stdio: 'ignore', timeout: 15000 });
    } catch {}
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
