const fs = require('fs');
const path = require('path');
const { fetchAllLiveMatches } = require('./flashscore_fetcher');
const notify = require('./notify');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const WEIGHTS_FILE = path.join(__dirname, 'weights.json');

const DEFAULT_WEIGHTS = {
  version: 1, learningRate: 0.05,
  global: {
    xg: 30, shotsOnTarget: 25, bigChances: 15, totalShots: 10,
    scoreNeeds: 10, timePressure: 8, corners: 5, possession: 5, saves: 5, goalsScored: -10
  },
  byLeague: {},
  stats: { predictionsCount: 0, correctScore: 0, correctScorer: 0 }
};

function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
      return { ...DEFAULT_WEIGHTS, ...data };
    }
  } catch {}
  return { ...DEFAULT_WEIGHTS };
}

function saveWeights(weights) {
  weights.lastUpdated = new Date().toISOString();
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(weights, null, 2));
}

function loadPredictions() {
  try {
    if (fs.existsSync(PREDICTIONS_FILE)) { return JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8')); }
  } catch {}
  return [];
}

function savePredictions(predictions) {
  fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(predictions, null, 2));
}

function getLeagueWeights(weights, league) {
  const w = { ...weights.global };
  if (league && weights.byLeague[league]) {
    for (const key of Object.keys(w)) {
      if (weights.byLeague[league][key] !== undefined) w[key] = weights.byLeague[league][key];
    }
  }
  return w;
}

function parseNum(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parsePct(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  if (s.includes('%')) {
    const n = parseFloat(s.replace('%', ''));
    return isNaN(n) ? null : n / 100;
  }
  const n = parseNum(v);
  return n !== null ? n : null;
}

function flashscoreStatsToInternal(flashStats) {
  const get = (name) => flashStats[name] || {};
  const home = (name) => parseNum(get(name).home);
  const away = (name) => parseNum(get(name).away);
  const homePct = (name) => parsePct(get(name).home);
  const awayPct = (name) => parsePct(get(name).away);

  return {
    xgHome: home('Expected goals (xG)'),
    xgAway: away('Expected goals (xG)'),
    sotHome: home('Shots on target'),
    sotAway: away('Shots on target'),
    totalShotsHome: home('Total shots'),
    totalShotsAway: away('Total shots'),
    bigChancesHome: home('Big chances'),
    bigChancesAway: away('Big chances'),
    cornersHome: home('Corner kicks'),
    cornersAway: away('Corner kicks'),
    possessionHome: homePct('Ball possession'),
    possessionAway: awayPct('Ball possession'),
    savesHome: home('Goalkeeper saves'),
    savesAway: away('Goalkeeper saves'),
    foulsHome: home('Fouls'),
    foulsAway: away('Fouls'),
    yellowCardsHome: home('Yellow cards'),
    yellowCardsAway: away('Yellow cards'),
    shotsInsideBoxHome: home('Shots inside the box'),
    shotsInsideBoxAway: away('Shots inside the box')
  };
}

function analyzeGoal(match, w) {
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

  const wXG = w.xg, wSOT = w.shotsOnTarget, wShots = w.totalShots, wBC = w.bigChances;
  const wNeed = w.scoreNeeds, wTime = w.timePressure, wCorners = w.corners;
  const wPoss = w.possession, wSaves = w.saves, wGoalsPenalty = w.goalsScored;

  if (s.xgHome !== null && s.xgAway !== null) {
    const totalXG = s.xgHome + s.xgAway;
    const xgRemaining = totalXG - goals;
    if (xgRemaining > 1.5) { score += wXG * 1; pressure += 30; reasons.push('Alto xG restante (' + xgRemaining.toFixed(2) + ')'); }
    else if (xgRemaining > 0.8) { score += wXG * 0.75; pressure += 20; reasons.push('xG restante ' + xgRemaining.toFixed(2)); }
    else if (xgRemaining > 0.3) { score += wXG * 0.4; pressure += 10; }
    if (totalXG > 1.5 && goals === 0) { score += wXG * 0.5; pressure += 15; reasons.push('0-0 con alto xG!'); }
    if (totalXG > 1.0 && goals <= 1) { score += wXG * 0.25; }
    if (s.xgHome > s.xgAway + 0.5) { predictedScorer = 'home'; scorerReasons.push('xG superior'); }
    else if (s.xgAway > s.xgHome + 0.5) { predictedScorer = 'away'; scorerReasons.push('xG superior'); }
  }

  if (s.sotHome !== null && s.sotAway !== null) {
    const totalSOT = s.sotHome + s.sotAway;
    if (totalSOT >= 8) { score += wSOT * 1; pressure += 20; reasons.push(totalSOT + ' tiros a puerta!'); }
    else if (totalSOT >= 5) { score += wSOT * 0.7; pressure += 15; reasons.push(totalSOT + ' a puerta'); }
    else if (totalSOT >= 3) { score += wSOT * 0.4; pressure += 8; }
    if (totalSOT >= 4 && goals === 0) { score += wSOT * 0.6; pressure += 10; reasons.push('Tiran a puerta pero no entran'); }
    if (totalSOT >= 6 && goals <= 1) { score += wSOT * 0.4; }
    if (!predictedScorer) {
      if (s.sotHome >= s.sotAway + 3) { predictedScorer = 'home'; scorerReasons.push('domina tiros a puerta'); }
      else if (s.sotAway >= s.sotHome + 3) { predictedScorer = 'away'; scorerReasons.push('domina tiros a puerta'); }
    }
  }

  if (s.totalShotsHome !== null && s.totalShotsAway !== null) {
    const totalShots = s.totalShotsHome + s.totalShotsAway;
    if (totalShots >= 25) { score += wShots * 1; pressure += 10; reasons.push('Alta frecuencia (' + totalShots + ')'); }
    else if (totalShots >= 15) { score += wShots * 0.5; pressure += 5; }
    if (!predictedScorer) {
      if (s.totalShotsHome >= s.totalShotsAway + 8) { predictedScorer = 'home'; scorerReasons.push('domina tiros'); }
      else if (s.totalShotsAway >= s.totalShotsHome + 8) { predictedScorer = 'away'; scorerReasons.push('domina tiros'); }
    }
  }

  if (s.bigChancesHome !== null && s.bigChancesAway !== null) {
    const totalBC = s.bigChancesHome + s.bigChancesAway;
    if (totalBC >= 5) { score += wBC * 1; pressure += 15; reasons.push(totalBC + ' ocasiones claras!'); }
    else if (totalBC >= 2) { score += wBC * 0.5; pressure += 8; }
    if (!predictedScorer) {
      if (s.bigChancesHome > s.bigChancesAway) { predictedScorer = 'home'; scorerReasons.push('m\u00e1s ocasiones claras'); }
      else if (s.bigChancesAway > s.bigChancesHome) { predictedScorer = 'away'; scorerReasons.push('m\u00e1s ocasiones claras'); }
    }
  }

  if (draw && goals > 0) { score += wNeed * 0.5; reasons.push('Empate, ambos buscan el gol'); }
  if (draw && goals === 0) { score += wNeed * 0.8; pressure += 5; reasons.push('0-0, cualquiera lo rompe'); }
  if (homeNeeds) { score += wNeed * 0.8; pressure += 5; reasons.push('Local necesita el gol'); if (!predictedScorer) { predictedScorer = 'home'; scorerReasons.push('necesita el gol'); } }
  if (awayNeeds) { score += wNeed * 0.8; pressure += 5; reasons.push('Visitante necesita el gol'); if (!predictedScorer) { predictedScorer = 'away'; scorerReasons.push('necesita el gol'); } }
  if (goals >= 4) { score += wGoalsPenalty; reasons.push('Goleada, el ritmo baja'); }

  if (minute >= 80 && pressure >= 20) { score += wTime * 1; reasons.push('Min ' + minute + "' — presi\u00f3n final!"); }
  else if (minute >= 70 && pressure >= 25) { score += wTime * 0.8; reasons.push('Min ' + minute + "' — definici\u00f3n"); }
  else if (minute >= 60 && pressure >= 30) { score += wTime * 0.5; }
  else if (minute < 20 && pressure >= 25) { score += wTime * 0.5; reasons.push('Presi\u00f3n desde el inicio'); }

  if (s.cornersHome !== null && s.cornersAway !== null) {
    const total = s.cornersHome + s.cornersAway;
    if (total >= 12) { score += wCorners * 1; pressure += 5; reasons.push('Presi\u00f3n constante (' + total + ' corners)'); }
    else if (total >= 8) { score += wCorners * 0.6; }
  }

  if (s.possessionHome !== null && s.possessionAway !== null) {
    if (s.possessionAway > 0.58 && awayNeeds) { score += wPoss * 1; pressure += 5; reasons.push('Visitante domina y necesita'); }
    if (s.possessionHome > 0.58 && homeNeeds) { score += wPoss * 1; pressure += 5; reasons.push('Local domina y necesita'); }
    if (Math.abs(s.possessionHome - s.possessionAway) > 0.20 && goals === 0) { score += wPoss * 1; pressure += 5; reasons.push('Un equipo domina pero no concreta'); }
  }

  if (s.savesHome !== null && s.savesAway !== null) {
    const total = s.savesHome + s.savesAway;
    if (total >= 8) { score += wSaves * 1; reasons.push('Porteros muy exigidos'); }
    else if (total >= 5) { score += wSaves * 0.6; }
  }

  let timeWindow = '';
  if (minute < 25) { timeWindow = pressure >= 40 ? 'Gol inminente — antes del descanso' : pressure >= 25 ? 'Probable gol antes del descanso' : 'Temprano, revaluar en 15-20 min'; }
  else if (minute < 40) { timeWindow = pressure >= 40 ? 'Gol antes del descanso (30-45)!' : pressure >= 25 ? 'Posible gol en minutos finales del 1T' : '1T tranquilo, probable gol en 2T'; }
  else if (minute < 50) { timeWindow = pressure >= 40 ? 'Gol al inicio del 2T (45-60)' : pressure >= 25 ? 'Posible gol al inicio del 2T' : 'Descanso sin mucha acci\u00f3n'; }
  else if (minute < 65) { timeWindow = pressure >= 40 ? 'Gol en pr\u00f3ximos 15 min!' : pressure >= 25 ? 'Posible gol en recta final (70-85)' : 'Partido t\u00e1cticamente cerrado'; }
  else if (minute < 80) { timeWindow = pressure >= 40 ? 'Gol inminente — \u00faltimos 15 minutos!' : pressure >= 25 ? 'Posible gol en tramo final (75-90)' : 'Partido que se apaga'; }
  else { timeWindow = pressure >= 25 ? 'Gol en cualquier momento — descuento!' : 'Partido pr\u00e1cticamente definido'; }

  const cappedScore = Math.min(Math.max(score, 0), 100);
  let verdict = cappedScore >= 60 ? 'MUY PROBABLE — casi seguro pr\u00f3ximo gol'
    : cappedScore >= 45 ? 'PROBABLE — buenos indicios'
    : cappedScore >= 30 ? 'POSIBLE — atentos'
    : cappedScore >= 15 ? 'DUDOSO — poca actividad'
    : 'IMPROBABLE — muy pocas ocasiones';

  let whoText = '';
  if (predictedScorer && scorerReasons.length > 0 && cappedScore >= 30) {
    const name = predictedScorer === 'home' ? (match.teamHome || 'Local') : (match.teamAway || 'Visitante');
    whoText = '\n     Pr\u00f3ximo gol: ' + name + ' (' + scorerReasons.join(', ') + ')';
  } else if (predictedScorer && cappedScore >= 45) {
    const name = predictedScorer === 'home' ? (match.teamHome || 'Local') : (match.teamAway || 'Visitante');
    whoText = '\n     Pr\u00f3ximo gol: ' + name;
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

async function main() {
  const weights = loadWeights();
  const predictions = loadPredictions();
  const analyzed = [];

  console.log('[1/2] Obteniendo partidos en vivo desde Flashscore...');
  const liveData = await fetchAllLiveMatches();
  console.log('  -> ' + liveData.length + ' partidos en vivo\n');

  writeSummary('## An\u00e1lisis Flashscore ' + new Date().toISOString() + '\n- Partidos: ' + liveData.length);

  if (liveData.length === 0) {
    writeSummary('- Estado: sin partidos en vivo');
    return;
  }

  console.log('[2/2] Analizando ' + liveData.length + ' partidos...\n');

  for (let i = 0; i < liveData.length; i++) {
    const m = liveData[i];
    const displayName = m.homeTeam + ' vs ' + m.awayTeam;
    console.log('  [' + (i + 1) + '/' + liveData.length + '] ' + displayName);

    const internalStats = flashscoreStatsToInternal(m.stats);
    const xgStr = internalStats.xgHome !== null ? internalStats.xgHome.toFixed(2) + '-' + internalStats.xgAway.toFixed(2) : '?-?';
    const sotStr = internalStats.sotHome !== null ? internalStats.sotHome + '-' + internalStats.sotAway : '?-?';
    console.log('     -> ' + (m.status || m.minute + "'") + ' ' + (m.scoreHome ?? '?') + '-' + (m.scoreAway ?? '?') + ' | xG:' + xgStr + ' SOT:' + sotStr);

    const justStarted = m.minute <= 5 || (!internalStats.totalShotsHome && !internalStats.totalShotsAway);
    if (justStarted && internalStats.totalShotsHome === null && internalStats.totalShotsAway === null) {
      console.log('  -> Reci\u00e9n iniciado, sin datos a\u00fan\n');
      continue;
    }

    analyzed.push({
      rawName: displayName,
      teamHome: m.homeTeam,
      teamAway: m.awayTeam,
      league: '',
      matchId: m.url,
      minute: m.minute || 0,
      scoreHome: m.scoreHome ?? 0,
      scoreAway: m.scoreAway ?? 0,
      stats: internalStats
    });
  }

  const ranked = analyzed.map(m => analyzeGoal(m, getLeagueWeights(weights, m.league))).sort((a, b) => b.score - a.score);

  const now = new Date().toISOString();
  const newPredictions = ranked.map(r => ({
    id: r.matchId, match: r.teamHome + ' vs ' + r.teamAway, league: r.league, timestamp: now,
    analysisMinute: r.minute, scoreAtAnalysis: { home: r.scoreHome, away: r.scoreAway }, stats: r.stats,
    predictedProbability: r.score, predictedScorer: r.predictedScorer, predictedTimeWindow: r.timeWindow,
    finalScore: null, goalAfterAnalysis: null, actualGoalMinute: null, actualScorer: null, predictionCorrect: null
  }));
  predictions.push(...newPredictions);
  savePredictions(predictions);
  weights.stats.predictionsCount += newPredictions.length;
  saveWeights(weights);
  console.log('  -> ' + newPredictions.length + ' predicciones guardadas\n');

  console.log('='.repeat(64));
  console.log('  PR\u00d3XIMO GOL — AN\u00c1LISIS EN VIVO (Flashscore)');
  console.log('='.repeat(64) + '\n');

  if (ranked.length === 0) {
    console.log('  No se pudieron analizar partidos.\n');
  } else {
    ranked.forEach((r, i) => {
      const medal = i === 0 ? '1.' : i === 1 ? '2.' : i === 2 ? '3.' : '  ' + (i + 1) + '.';
      const barLen = Math.round(r.score / 5);
      const bar = '#'.repeat(barLen) + '-'.repeat(20 - barLen);
      console.log('  ' + medal + ' [' + r.score + '%] ' + bar);
      console.log('     ' + r.teamHome + ' vs ' + r.teamAway);
      console.log('     ' + (r.minute ? r.minute + "'" : '') + ' | ' + r.scoreHome + ' - ' + r.scoreAway);
      console.log('     ' + r.timeWindow);
      console.log('     ' + r.verdict + r.whoText);
      const xgS = r.stats.xgHome !== null ? r.stats.xgHome.toFixed(2) + '-' + r.stats.xgAway.toFixed(2) : '?-?';
      const sotS = r.stats.sotHome !== null ? r.stats.sotHome + '-' + r.stats.sotAway : '?-?';
      const bcS = r.stats.bigChancesHome !== null ? r.stats.bigChancesHome + '-' + r.stats.bigChancesAway : '?-?';
      const corS = r.stats.cornersHome !== null ? r.stats.cornersHome + '-' + r.stats.cornersAway : '?-?';
      const posS = r.stats.possessionHome !== null ? Math.round(r.stats.possessionHome * 100) + '%-' + Math.round(r.stats.possessionAway * 100) + '%' : '?-?';
      console.log('     xG:' + xgS + ' SOT:' + sotS + ' OC:' + bcS + ' Esq:' + corS + ' Pos:' + posS);
      if (r.reasons.length > 0) console.log('     ' + r.reasons.join(' | '));
    });

    const top = ranked[0];
    if (top.score >= 40) {
      console.log('\n  RECOMENDACI\u00d3N PRINCIPAL:');
      console.log('     ' + top.teamHome + ' vs ' + top.teamAway);
      console.log('     Confianza: ' + top.score + '% — ' + top.timeWindow);
      console.log('     ' + top.verdict);
      if (top.whoText) console.log('     ' + top.whoText.trim());
    } else {
      console.log('\n  Sin recomendaciones s\u00f3lidas ahora.');
    }
  }

  writeSummary('- Mejor score: ' + (ranked.length > 0 ? ranked[0].score + '%' : 'N/A'));
  if (ranked.length > 0) writeSummary('- Top: ' + ranked[0].teamHome + ' vs ' + ranked[0].teamAway);

  if (ranked.length > 0 && ranked[0].score >= 70) {
    const msg = notify.buildMessage(ranked);
    if (msg) {
      console.log('\nEnviando alerta Telegram...');
      await notify.sendTelegram(msg);
      writeSummary('- Alerta: ENVIADA');
    } else {
      writeSummary('- Alerta: buildMessage null');
    }
  } else if (ranked.length > 0) {
    console.log('\nMejor score: ' + ranked[0].score + '% (umbral: 70%)');
    writeSummary('- Alerta: No enviada (umbral no alcanzado)');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
