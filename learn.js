const fs = require('fs');
const path = require('path');

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

function loadJSON(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return def;
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function loadWeights() { return loadJSON(WEIGHTS_FILE, JSON.parse(JSON.stringify(DEFAULT_WEIGHTS))); }
function saveWeights(w) { w.lastUpdated = new Date().toISOString(); saveJSON(WEIGHTS_FILE, w); }
function loadPredictions() { return loadJSON(PREDICTIONS_FILE, []); }
function savePredictions(p) { saveJSON(PREDICTIONS_FILE, p); }
function loadTeams() { return loadJSON(TEAMS_FILE, {}); }
function saveTeams(t) { saveJSON(TEAMS_FILE, t); }

function isFlashscoreId(id) { return typeof id === 'string' && id.startsWith('https://www.flashscore.com/'); }

function teamsMatch(predHome, predAway, liveHome, liveAway) {
  if (!predHome || !predAway || !liveHome || !liveAway) return false;
  const n = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ph = n(predHome), pa = n(predAway), lh = n(liveHome), la = n(liveAway);
  return (ph.includes(lh) || lh.includes(ph)) && (pa.includes(la) || la.includes(pa));
}

function extractLeague(match) {
  // Try to extract from match URL: flashscore.com/match/football/league-name/...
  const url = match.url || match.id || '';
  const parts = url.split('/');
  // URL pattern: .../football/league-name/team1-vs-team2/
  const leagueIdx = parts.indexOf('football');
  if (leagueIdx >= 0 && parts[leagueIdx + 1]) {
    return decodeURIComponent(parts[leagueIdx + 1].replace(/-/g, ' '));
  }
  return match.league || '';
}

/**
 * Actualiza estadísticas de equipos basado en una predicción verificada.
 */
function updateTeamStats(teams, pred, liveMatch) {
  const home = pred.teamHome;
  const away = pred.teamAway;
  const goalHappened = pred.goalAfterAnalysis || false;
  const s = pred.stats || {};

  for (const team of [home, away]) {
    if (!team) continue;
    if (!teams[team]) {
      teams[team] = { matchesTracked: 0, timesPredictedGoal: 0, goalsWhenPredicted: 0, timesPredictedNoGoal: 0, goalsWhenNotPredicted: 0, totalXgFor: 0, totalXgAgainst: 0, totalSotFor: 0, totalShotsInsideBoxFor: 0, goalsInLast15: 0, matchesOver70: 0, totalGoalsScored: 0 };
    }
    const t = teams[team];
    t.matchesTracked++;
    t.totalXgFor += (s.xgHome || 0);
    t.totalXgAgainst += (s.xgAway || 0);
    t.totalSotFor += (s.sotHome || 0);
    t.totalShotsInsideBoxFor += (s.shotsInsideBoxHome || 0);

    const prob = (pred.predictedProbability || 0) / 100;
    const isHome = (team === home);
    const teamScored = isHome ? goalHappened : goalHappened;

    if (prob >= 0.7) {
      t.timesPredictedGoal++;
      if (teamScored) t.goalsWhenPredicted++;
    } else {
      t.timesPredictedNoGoal++;
      if (teamScored) t.goalsWhenNotPredicted++;
    }

    if (pred.analysisMinute >= 70 && teamScored) t.goalsInLast15++;
    if (pred.analysisMinute >= 70) t.matchesOver70++;
  }
}

/**
 * Obtiene factor de ajuste por equipo.
 * Retorna un multiplicador (ej: 1.1 = +10% a la probabilidad)
 */
function getTeamFactor(teams, teamName, isHome) {
  if (!teamName || !teams[teamName]) return 1.0;
  const t = teams[teamName];
  if (t.timesPredictedGoal < 2) return 1.0; // pocos datos

  const conversionRate = t.goalsWhenPredicted / t.timesPredictedGoal;
  // Si conversionRate > 0.7, el equipo suele cumplir cuando lo predecimos → bonificar
  // Si conversionRate < 0.3, el equipo suele fallar cuando lo predecimos → castigar
  let factor = 1.0;
  if (conversionRate > 0.7) factor = 1.0 + (conversionRate - 0.7) * 0.5;
  else if (conversionRate < 0.3) factor = 1.0 - (0.3 - conversionRate) * 0.5;

  return Math.max(0.8, Math.min(1.2, factor));
}

/**
 * Actualiza perfil de liga basado en datos verificados.
 */
function updateLeagueProfile(weights, pred, liveMatch) {
  const league = extractLeague(pred);
  if (!league) return;

  if (!weights.byLeague[league]) {
    weights.byLeague[league] = { matchesTracked: 0, totalGoals: 0, totalXg: 0, totalSot: 0, totalShotsInsideBox: 0, totalPossessionDiff: 0, correctAt70: 0, falsePositives: 0, falseNegatives: 0 };
  }
  const lp = weights.byLeague[league];
  lp.matchesTracked++;
  lp.totalGoals += (liveMatch.scoreHome || 0) + (liveMatch.scoreAway || 0);

  const s = pred.stats || {};
  if (s.xgHome !== null && s.xgAway !== null) lp.totalXg += s.xgHome + s.xgAway;
  if (s.sotHome !== null && s.sotAway !== null) lp.totalSot += s.sotHome + s.sotAway;
  if (s.shotsInsideBoxHome !== null && s.shotsInsideBoxAway !== null) lp.totalShotsInsideBox += s.shotsInsideBoxHome + s.shotsInsideBoxAway;
  if (s.possessionHome !== null && s.possessionAway !== null) lp.totalPossessionDiff += Math.abs(s.possessionHome - s.possessionAway);

  if ((pred.predictedProbability || 0) >= 70) {
    if (pred.goalAfterAnalysis) lp.correctAt70++;
    else lp.falsePositives++;
  } else if ((pred.predictedProbability || 0) < 30) {
    if (pred.goalAfterAnalysis) lp.falseNegatives++;
  }
}

/**
 * Ajusta los pesos por liga basado en estadísticas acumuladas.
 */
function adjustLeagueWeights(weights) {
  for (const [league, lp] of Object.entries(weights.byLeague)) {
    if (lp.matchesTracked < 5) continue;

    const avgGoals = lp.totalGoals / lp.matchesTracked;
    const avgXg = lp.totalXg / lp.matchesTracked;
    const avgSot = lp.totalSot / lp.matchesTracked;
    const avgBox = lp.totalShotsInsideBox / lp.matchesTracked;
    const totalPreds = lp.correctAt70 + lp.falsePositives + lp.falseNegatives;

    // Calcular precisión de la liga
    if (totalPreds > 0) {
      const accuracy = (lp.correctAt70 + (lp.falseNegatives > 0 ? 0 : 0)) / totalPreds;
      // Si la liga tiene más goles de lo normal, aumentar pesos ofensivos
      if (avgGoals > 3.0) {
        if (!weights.byLeague[league].xg) weights.byLeague[league].xg = weights.global.xg;
        weights.byLeague[league].xg = Math.min(60, (weights.byLeague[league].xg || weights.global.xg) * 1.02);
      }
      if (avgGoals < 1.5) {
        weights.byLeague[league].xg = Math.max(5, (weights.byLeague[league].xg || weights.global.xg) * 0.98);
      }
    }
  }
}

// ========== VERIFICACIÓN ==========

function verifyPredictions(predictions, liveMatches, teams) {
  const verified = [];
  const insights = [];

  for (const pred of predictions) {
    if (pred.predictionCorrect !== null) continue;
    if (pred.finalScore !== null) continue;
    if (!isFlashscoreId(pred.id)) continue;
    if (!pred.analysisMinute || pred.analysisMinute < 10) continue;

    let goalHappened, finalScore;
    const liveMatch = liveMatches.find(m =>
      teamsMatch(pred.teamHome, pred.teamAway, m.homeTeam, m.awayTeam)
    );

    if (liveMatch) {
      const minutesElapsed = (liveMatch.minute || 0) - (pred.analysisMinute || 0);
      const scoreChanged =
        (liveMatch.scoreHome !== null && liveMatch.scoreAway !== null) &&
        (liveMatch.scoreHome !== (pred.scoreAtAnalysis?.home ?? liveMatch.scoreHome) ||
         liveMatch.scoreAway !== (pred.scoreAtAnalysis?.away ?? liveMatch.scoreAway));

      if (!scoreChanged && minutesElapsed < 10) continue;

      goalHappened = scoreChanged;
      finalScore = { home: liveMatch.scoreHome ?? 0, away: liveMatch.scoreAway ?? 0 };
    } else if (pred.lastSeenMinute && pred.lastSeenScore) {
      // Partido ya terminó: usar último estado conocido
      if (pred.lastSeenMinute < 80) continue; // muy temprano para saber si terminó
      const scoreChanged =
        (pred.lastSeenScore.home !== (pred.scoreAtAnalysis?.home ?? 0) ||
         pred.lastSeenScore.away !== (pred.scoreAtAnalysis?.away ?? 0));
      goalHappened = scoreChanged;
      finalScore = pred.lastSeenScore;
    } else {
      continue;
    }
    const prob = (pred.predictedProbability || 0) / 100;
    const predictedGoal = prob >= 0.7;
    const correct = (predictedGoal && goalHappened) || (!predictedGoal && !goalHappened);

    pred.finalScore = finalScore;
    pred.goalAfterAnalysis = goalHappened;
    pred.predictionCorrect = correct;

    // Actualizar stats de equipos
    updateTeamStats(teams, pred, liveMatch || { scoreHome: 0, scoreAway: 0 });
    // Actualizar perfil de liga (cargado desde weights)
    // Esto se hace fuera porque necesitamos los weights

    // Insights para falsos positivos (predijimos gol pero no hubo)
    if (!correct && predictedGoal) {
      const s = pred.stats || {};
      let analysis = 'Se predijo gol pero no ocurrió. ';
      if ((s.bigChancesHome || 0) + (s.bigChancesAway || 0) === 0 && (s.xgHome || 0) + (s.xgAway || 0) < 1) {
        analysis += 'El xG era bajo sin ocasiones claras — el modelo sobrestimó. ';
      } else if ((s.shotsInsideBoxHome || 0) + (s.shotsInsideBoxAway || 0) === 0 && (s.totalShotsHome || 0) + (s.totalShotsAway || 0) > 15) {
        analysis += 'Muchos tiros pero todos desde fuera. Pesos de tiros lejanos muy altos. ';
      } else if ((s.savesHome || 0) + (s.savesAway || 0) > 8) {
        analysis += 'Porteros destacaron. ';
      } else if (pred.analysisMinute >= 75) {
        analysis += 'Los equipos se conformaron con el resultado. ';
      } else {
        analysis += 'Las estadísticas sugerían gol pero no se concretó. ';
      }

      const features = [];
      if (s.xgHome !== null) features.push({ name: 'xG', home: s.xgHome, away: s.xgAway });
      if (s.sotHome !== null) features.push({ name: 'SOT', home: s.sotHome, away: s.sotAway });
      if (s.shotsInsideBoxHome !== null) features.push({ name: 'Box', home: s.shotsInsideBoxHome, away: s.shotsInsideBoxAway });

      insights.push({
        match: pred.teamHome + ' vs ' + pred.teamAway,
        predicted: (pred.predictedProbability || 0) + '%',
        analysis,
        features,
        type: 'false_positive'
      });
    }

    // Insights para falsos negativos (no predijimos gol pero sí hubo)
    if (!correct && !predictedGoal && goalHappened) {
      let analysis = 'Gol no predicho. ';
      if ((pred.stats?.xgHome || 0) + (pred.stats?.xgAway || 0) < 0.3) {
        analysis += 'xG muy bajo — gol fue jugada aislada o error. ';
      } else {
        analysis += 'El modelo fue conservador. ';
      }
      insights.push({
        match: pred.teamHome + ' vs ' + pred.teamAway,
        predicted: (pred.predictedProbability || 0) + '%',
        analysis,
        features: [],
        type: 'false_negative'
      });
    }

    verified.push(pred);
  }

  return { verified, insights };
}

// ========== AJUSTE DE PESOS ==========

function adjustWeights(weights, verified, insights) {
  const lr = weights.learningRate;
  let adjustments = 0;

  for (const pred of verified) {
    if (pred.predictionCorrect === null) continue;
    const prob = (pred.predictedProbability || 0) / 100;
    const goalHappened = pred.goalAfterAnalysis || false;
    const error = (goalHappened ? 1 : 0) - prob;
    if (Math.abs(error) < 0.15) continue;

    const direction = error > 0 ? 1 : -1;
    const adjust = lr * direction;

    const globalKeys = ['xg', 'shotsOnTarget', 'shotsInsideBox', 'bigChances', 'totalShots', 'xgot', 'hitWoodwork', 'xA', 'touchesOppBox', 'scoreNeeds', 'timePressure', 'corners', 'possession', 'saves', 'goalsScored'];
    for (const key of globalKeys) {
      if (key === 'goalsScored') {
        weights.global[key] = Math.round(Math.max(-20, Math.min(0, weights.global[key] * (1 + adjust))) * 10) / 10;
      } else {
        weights.global[key] = Math.round(Math.max(1, Math.min(60, weights.global[key] * (1 + adjust))) * 10) / 10;
      }
      adjustments++;
    }

    if (goalHappened && prob >= 0.4) weights.stats.correctScore++;
    else if (!goalHappened && prob < 0.4) weights.stats.correctScore++;

    // Ajuste por liga
    updateLeagueProfile(weights, pred, pred.finalScore ? { scoreHome: pred.finalScore.home, scoreAway: pred.finalScore.away } : { scoreHome: 0, scoreAway: 0 });
  }

  // Ajustar pesos de liga basado en estadísticas
  adjustLeagueWeights(weights);

  return adjustments;
}

// ========== REPORTE ==========

function printLearningReport(weights, predictions, insights, teams) {
  const total = predictions.length;
  let correctCount = 0, totalVerified = 0;
  for (const p of predictions) {
    if (p.predictionCorrect === true) { correctCount++; totalVerified++; }
    else if (p.predictionCorrect === false) totalVerified++;
  }
  const accuracy = totalVerified > 0 ? (correctCount / totalVerified * 100).toFixed(1) : '-';

  console.log('');
  console.log('='.repeat(60));
  console.log('  APRENDIZAJE — REPORTE COMPLETO');
  console.log('='.repeat(60));
  console.log('  Predicciones: ' + total + ' | Verificadas: ' + totalVerified + ' | Precision: ' + accuracy + '%');
  console.log('  Aciertos: ' + correctCount + ' | Fallos: ' + (totalVerified - correctCount));

  // Fallos del día
  const fp = insights.filter(i => i.type === 'false_positive');
  const fn = insights.filter(i => i.type === 'false_negative');
  if (fp.length > 0) {
    console.log('\n  --- FALSOS POSITIVOS (predijimos gol y no hubo) ---');
    fp.slice(0, 5).forEach(i => {
      console.log('  ' + i.match + ' (' + i.predicted + ')');
      console.log('    -> ' + i.analysis);
      if (i.features.length > 0) console.log('    Datos: ' + i.features.map(f => f.name + ' ' + f.home + '-' + f.away).join(' | '));
    });
    if (fp.length > 5) console.log('  ... y ' + (fp.length - 5) + ' mas');
  }
  if (fn.length > 0) {
    console.log('\n  --- FALSOS NEGATIVOS (gol no predicho) ---');
    fn.slice(0, 5).forEach(i => {
      console.log('  ' + i.match + ' (' + i.predicted + ')');
      console.log('    -> ' + i.analysis);
    });
    if (fn.length > 5) console.log('  ... y ' + (fn.length - 5) + ' mas');
  }

  // Pesos globales
  console.log('\n  --- PESOS GLOBALES ---');
  const sorted = Object.entries(weights.global).sort((a, b) => b[1] - a[1]);
  sorted.forEach(([k, v]) => {
    if (k === 'goalsScored' || k === 'teamFactor' || k === 'leagueFactor') return;
    const bar = '\u2588'.repeat(Math.round(v / 3)) + '\u2591'.repeat(20 - Math.round(v / 3));
    console.log('  ' + k.padEnd(18) + v.toString().padStart(5) + '  ' + bar);
  });

  // Ligas con datos
  const leagues = Object.entries(weights.byLeague).filter(([, v]) => v.matchesTracked > 0);
  if (leagues.length > 0) {
    console.log('\n  --- PERFILES DE LIGA ---');
    leagues.sort((a, b) => b[1].matchesTracked - a[1].matchesTracked).slice(0, 5).forEach(([name, lp]) => {
      const avgG = (lp.totalGoals / lp.matchesTracked).toFixed(1);
      const avgX = lp.totalXg > 0 ? (lp.totalXg / lp.matchesTracked).toFixed(2) : '-';
      const fpRate = lp.falsePositives > 0 ? (lp.falsePositives / (lp.correctAt70 + lp.falsePositives) * 100).toFixed(0) : '-';
      console.log('  ' + name.slice(0, 28).padEnd(28) + ' ' + lp.matchesTracked + ' part Media ' + avgG + ' goles xG:' + avgX + ' FP:' + fpRate + '%');
    });
  }

  // Equipos destacados
  const teamEntries = Object.entries(teams).filter(([, t]) => t.timesPredictedGoal >= 2);
  if (teamEntries.length > 0) {
    console.log('\n  --- COMPORTAMIENTO DE EQUIPOS ---');
    teamEntries.sort((a, b) => b[1].timesPredictedGoal + b[1].timesPredictedNoGoal - a[1].timesPredictedGoal - a[1].timesPredictedNoGoal).slice(0, 8).forEach(([name, t]) => {
      const convRate = t.timesPredictedGoal > 0 ? (t.goalsWhenPredicted / t.timesPredictedGoal * 100).toFixed(0) : '-';
      const total = t.timesPredictedGoal + t.timesPredictedNoGoal;
      const avgXg = (t.totalXgFor / t.matchesTracked).toFixed(2);
      console.log('  ' + name.slice(0, 28).padEnd(28) + ' ' + total + ' veces  acierto: ' + convRate + '%  xG: ' + avgXg);
    });
  }

  console.log('');
}

// ========== MAIN ==========

async function runLearning(liveMatches) {
  const weights = loadWeights();
  const predictions = loadPredictions();
  const teams = loadTeams();

  if (predictions.length === 0) {
    console.log('  Aprendizaje: sin predicciones previas');
    return { weights, adjustments: 0, insights: [] };
  }

  console.log('  Verificando ' + predictions.length + ' predicciones...');

  const { verified, insights } = verifyPredictions(predictions, liveMatches, teams);
  console.log('  Verificadas: ' + verified.length + ' (' + insights.length + ' fallos)');

  if (verified.length > 0) {
    const adjustments = adjustWeights(weights, verified, insights);
    saveTeams(teams);
    saveWeights(weights);
    savePredictions(predictions);
    console.log('  Pesos ajustados: ' + adjustments + ' cambios');

    printLearningReport(weights, predictions, insights, teams);
    return { weights, adjustments, insights, teams };
  }

  return { weights, adjustments: 0, insights: [], teams };
}

module.exports = { runLearning, loadWeights, loadPredictions };
