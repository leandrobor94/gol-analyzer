const fs = require('fs');
const path = require('path');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const WEIGHTS_FILE = path.join(__dirname, 'weights.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');

const DEFAULT_WEIGHTS = {
  version: 4, learningRate: 0.03,
  // Betas del modelo de intensidad lambda (v4)
  betas: {
    baseline: 0.030,        // λ base (goles/minuto). Backtest n=82: 0.022→0.030 baja Brier 0.36→0.33 sin perder hit-rate alertas
    xgWeight: 0.8,          // peso de xG por minuto sobre baseline
    bcWeight: 1.2,          // peso de Big Chances por minuto
    sotWeight: 0.4,         // peso de tiros al arco (señal débil)
    redCardMult: 1.5,       // multiplicador por roja
    urgency60: 1.30,        // urgencia al ir perdiendo min 60-74
    urgency75: 1.50,        // urgencia al ir perdiendo min 75+
    lead2Mult: 0.50,        // multiplicador ventaja ≥2 goles
    lead1LateMult: 0.70,    // multiplicador ventaja 1 gol min 75+
  },
  perLeagueBetas: {},       // overrides de betas por liga
  byLeague: {},
  stats: { predictionsCount: 0, correctScore: 0, correctScorer: 0, createdCount: 0, verifiedCount: 0, brierScore: null, brierCount: 0 }
};

function loadJSON(file, def) {
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    }
  } catch {}
  return def;
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function loadWeights() { return loadJSON(WEIGHTS_FILE, JSON.parse(JSON.stringify(DEFAULT_WEIGHTS))); }
function saveWeights(w) { w.lastUpdated = new Date().toISOString(); saveJSON(WEIGHTS_FILE, w); }
function loadPredictions() { return loadJSON(PREDICTIONS_FILE, []); }
function savePredictions(p) {
  // Limpiar predicciones verificadas > 30 dias para evitar bloat (balance entre datos de entrenamiento y tamaño)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const filtered = p.filter(pred => {
    if (pred.predictionCorrect === null) return true;
    if (pred.timestamp) { const t = new Date(pred.timestamp).getTime(); if (t > cutoff) return true; }
    return false;
  });
  saveJSON(PREDICTIONS_FILE, filtered);
}
function loadTeams() { return loadJSON(TEAMS_FILE, {}); }
function saveTeams(t) { saveJSON(TEAMS_FILE, t); }

function teamsMatch(predHome, predAway, liveHome, liveAway) {
  if (!predHome || !predAway || !liveHome || !liveAway) return false;
  const n = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ph = n(predHome), pa = n(predAway), lh = n(liveHome), la = n(liveAway);
  return (ph.includes(lh) || lh.includes(ph)) && (pa.includes(la) || la.includes(pa));
}

function extractLeague(match) {
  // Usar league guardada en la predicción (viene scrapeada del breadcrumb)
  if (match.league) return match.league;
  // Fallback: extraer de la URL (no incluye liga real, solo team+ID)
  const url = match.url || match.id || '';
  const parts = url.split('/');
  const leagueIdx = parts.indexOf('football');
  if (leagueIdx >= 0 && parts[leagueIdx + 1]) {
    return decodeURIComponent(parts[leagueIdx + 1].replace(/-/g, ' '));
  }
  return '';
}

/**
 * Actualiza estadísticas de equipos basado en una predicción verificada.
 */
function updateTeamStats(teams, pred, liveMatch) {
  const home = pred.teamHome;
  const away = pred.teamAway;
  const s = pred.stats || {};
  // Normalizar score: pred.finalScore usa {home,away}, liveMatch usa {scoreHome,scoreAway}
  const fs = pred.finalScore || {};
  const lm = liveMatch || {};
  const finalHome = fs.home ?? lm.scoreHome ?? 0;
  const finalAway = fs.away ?? lm.scoreAway ?? 0;
  const analysisHome = pred.scoreAtAnalysis?.home ?? 0;
  const analysisAway = pred.scoreAtAnalysis?.away ?? 0;

  const homeScored = finalHome > analysisHome;
  const awayScored = finalAway > analysisAway;

  for (const team of [home, away]) {
    if (!team) continue;
    if (!teams[team]) {
      teams[team] = { matchesTracked: 0, timesPredictedGoal: 0, goalsWhenPredicted: 0, timesPredictedNoGoal: 0, goalsWhenNotPredicted: 0, totalXgFor: 0, totalXgAgainst: 0, totalSotFor: 0, totalShotsInsideBoxFor: 0, goalsInLast15: 0, matchesOver70: 0, totalGoalsScored: 0, totalXgEfficiency: 0 };
    }
    const t = teams[team];
    const isHome = (team === home);
    t.matchesTracked++;
    t.totalXgFor += isHome ? (s.xgHome || 0) : (s.xgAway || 0);
    t.totalXgAgainst += isHome ? (s.xgAway || 0) : (s.xgHome || 0);
    t.totalSotFor += isHome ? (s.sotHome || 0) : (s.sotAway || 0);
    t.totalShotsInsideBoxFor += isHome ? (s.shotsInsideBoxHome || 0) : (s.shotsInsideBoxAway || 0);

    const teamScored = isHome ? homeScored : awayScored;
    const prob = (pred.predictedProbability || 0) / 100;

    if (teamScored) {
      t.totalGoalsScored++;
      // La eficiencia xG se calcula en analyzeGoal como totalGoalsScored/totalXgFor
      // (totalXgEfficiency con suma de 1/xG estaba mal planteada — ya no se acumula)
    }

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
 * Actualiza perfil de liga basado en datos verificados.
 */
function updateLeagueProfile(weights, pred, liveMatch, isFinal = true) {
  const league = extractLeague(pred);
  if (!league) return;

  if (!weights.byLeague[league]) {
    weights.byLeague[league] = { matchesTracked: 0, totalGoals: 0, totalXg: 0, totalSot: 0, totalShotsInsideBox: 0, totalPossessionDiff: 0, correctAt70: 0, falsePositives: 0, falseNegatives: 0 };
  }
  const lp = weights.byLeague[league];
  // matchesTracked y totalGoals solo con partidos TERMINADOS — un score parcial
  // de verificacion en vivo sesgaria el promedio de goles de la liga
  if (isFinal) {
    lp.matchesTracked++;
    lp.totalGoals += (liveMatch.scoreHome || 0) + (liveMatch.scoreAway || 0);
  }

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
 * Liga con muchos goles → pesos altos. Liga con pocos → pesos bajos.
 * Además ajusta por precisión: muchos FP → reduce pesos, muchos FN → aumenta.
 */
function adjustLeagueWeights(weights) {
  // Media global de goles por partido
  let totalGoals = 0, totalMatches = 0;
  for (const lp of Object.values(weights.byLeague)) {
    totalGoals += lp.totalGoals;
    totalMatches += lp.matchesTracked;
  }
  const globalAvgGoals = totalMatches > 0 ? totalGoals / totalMatches : 2.5;

  for (const [league, lp] of Object.entries(weights.byLeague)) {
    if (lp.matchesTracked < 5) continue;

    const avgGoals = lp.totalGoals / lp.matchesTracked;

    // Ratio de goles: cuantos más goles, más peso ofensivo necesita
    const goalRatio = Math.max(0.6, Math.min(1.5, avgGoals / globalAvgGoals));

    // Ajuste por precisión de la liga
    const total70 = lp.correctAt70 + lp.falsePositives;
    let accuracyFactor = 1.0;
    if (total70 >= 3) {
      const fpRate = lp.falsePositives / total70;
      // Muchos FP → el modelo sobreestima esta liga → reducir pesos
      // Pocos FP → el modelo subestima → aumentar
      accuracyFactor = fpRate > 0.5 ? (1 - (fpRate - 0.5)) : fpRate < 0.2 ? (1 + (0.2 - fpRate) * 0.5) : 1.0;
    }

    const multiplier = Math.max(0.5, Math.min(1.5, goalRatio * accuracyFactor));

    // Aplicar a todos los pesos de la liga
    const baseWeights = weights.globalFallback || weights.windows?.late || {};
    for (const [key, val] of Object.entries(baseWeights)) {
      if (key === 'goalsScored' || key === 'redCard' || key === 'teamHistory' || key === 'matchContext') continue;
      weights.byLeague[league][key] = Math.round(Math.max(1, Math.min(60, val * multiplier)) * 10) / 10;
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
    if (!pred.id) continue;
    if (!pred.analysisMinute) continue;
    // Si no han pasado 15 min reales, muy fresco para verificar
    if (pred.timestamp) {
      const elapsed = (Date.now() - new Date(pred.timestamp).getTime()) / 60000;
      if (elapsed < 15) continue;
    }

    let goalHappened, finalScore;
    const liveMatch = liveMatches.find(m =>
      teamsMatch(pred.teamHome, pred.teamAway, m.homeTeam, m.awayTeam)
    );

    if (liveMatch) {
      const scoreChanged =
        (liveMatch.scoreHome !== null && liveMatch.scoreAway !== null) &&
        (liveMatch.scoreHome !== (pred.scoreAtAnalysis?.home ?? liveMatch.scoreHome) ||
         liveMatch.scoreAway !== (pred.scoreAtAnalysis?.away ?? liveMatch.scoreAway));

      // BUG FIX: antes marcaba "sin gol" como fallo DEFINITIVO con el partido
      // aun en vivo (si pasaban 10 min sin gol) — falso negativo permanente que
      // el bloque [4/4] ya no podia corregir. En vivo SOLO verificamos cuando el
      // gol ya ocurrio (hecho irreversible). El "sin gol" definitivo lo determina
      // verifyFinishedMatch en run_flashscore.js con el partido TERMINADO.
      if (!scoreChanged) continue;

      goalHappened = true;
      finalScore = { home: liveMatch.scoreHome ?? 0, away: liveMatch.scoreAway ?? 0 };
      pred._verifiedLive = true; // score parcial — no usar para perfiles de liga
    } else if (pred.lastSeenMinute && pred.lastSeenScore) {
      // Partido desaparecido del feed live: solo aceptar como terminado si el
      // ultimo minuto visto es >=88 (un gol puede llegar en el 85-90+)
      if (pred.lastSeenMinute < 88) continue;
      const scoreChanged =
        (pred.lastSeenScore.home !== (pred.scoreAtAnalysis?.home ?? 0) ||
         pred.lastSeenScore.away !== (pred.scoreAtAnalysis?.away ?? 0));
      goalHappened = scoreChanged;
      finalScore = pred.lastSeenScore;
    } else {
      continue;
    }
    const prob = (pred.predictedProbability || 0) / 100;
    // Binario en 50% (calibracion general). Alertas: alertCorrect en umbral 80%.
    const correct = goalHappened ? (prob >= 0.5) : (prob < 0.5);

    pred.finalScore = finalScore;
    pred.goalAfterAnalysis = goalHappened;
    pred.predictionCorrect = correct;
    if ((pred.predictedProbability || 0) >= 80) {
      pred.alertCorrect = goalHappened;
      try {
        const ALERTAS_LOG_FILE = path.join(__dirname, 'alertas_log.json');
        let log = [];
        if (fs.existsSync(ALERTAS_LOG_FILE)) {
          log = JSON.parse(fs.readFileSync(ALERTAS_LOG_FILE, 'utf8').replace(/^\uFEFF/, ''));
        }
        log.push({
          match: pred.match || (pred.teamHome + ' vs ' + pred.teamAway),
          league: pred.league,
          probability: pred.predictedProbability,
          minute: pred.analysisMinute,
          scoreAtAlert: pred.scoreAtAnalysis ? (pred.scoreAtAnalysis.home + '-' + pred.scoreAtAnalysis.away) : null,
          finalScore: finalScore ? (finalScore.home + '-' + finalScore.away) : null,
          goalAfterAlert: goalHappened,
          correct: goalHappened,
          windowType: pred.windowType,
          timestamp: new Date().toISOString(),
          alertTimestamp: pred.timestamp
        });
        if (log.length > 500) log = log.slice(-500);
        fs.writeFileSync(ALERTAS_LOG_FILE, JSON.stringify(log, null, 2));
      } catch {}
    }

    // Determine actual scorer and approximate minute for training
    if (goalHappened) {
      const prevHome = pred.scoreAtAnalysis?.home ?? 0;
      const prevAway = pred.scoreAtAnalysis?.away ?? 0;
      if (finalScore.home > prevHome && finalScore.away > prevAway) {
        pred.actualScorer = null;
      } else if (finalScore.home > prevHome) {
        pred.actualScorer = 'home';
      } else if (finalScore.away > prevAway) {
        pred.actualScorer = 'away';
      } else {
        pred.actualScorer = null;
      }
      if (pred.lastSeenMinute && pred.lastSeenMinute > (pred.analysisMinute || 0)) {
        pred.actualGoalMinute = pred.lastSeenMinute;
      } else if (liveMatch && liveMatch.minute && liveMatch.minute > (pred.analysisMinute || 0)) {
        pred.actualGoalMinute = liveMatch.minute;
      } else {
        pred.actualGoalMinute = null;
      }
    } else {
      pred.actualScorer = null;
      pred.actualGoalMinute = null;
    }

    // Update stats counters

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

/**
 * Obtiene el set de pesos para una ventana específica — DEPRECATED para v4.
 * Mantenido por compatibilidad con getLeagueWeights en run_flashscore.js
 */
function getWindowWeights(weights, windowType) {
  if (windowType && weights.windows && weights.windows[windowType]) {
    return weights.windows[windowType];
  }
  return weights.globalFallback || {};
}

/**
 * Obtiene los betas del modelo lambda para una liga específica.
 * Si la liga tiene overrides en perLeagueBetas, los mergea sobre los defaults.
 */
function getBetas(weights, league) {
  const base = weights.betas || DEFAULT_WEIGHTS.betas;
  if (!league || !weights.perLeagueBetas || !weights.perLeagueBetas[league]) {
    return { ...base };
  }
  return { ...base, ...weights.perLeagueBetas[league] };
}

/**
 * Ajusta los betas del modelo lambda basado en predicciones verificadas.
 * Aprende: si lambda fue muy alto (falsos positivos) → reducir betas.
 *          Si lambda fue muy bajo (falsos negativos) → aumentar betas.
 * Learning rate bajo (0.03) para adaptación gradual sin oscillación.
 */
function adjustBetas(weights, verified) {
  if (!verified || verified.length === 0) return 0;
  
  // Inicializar betas y perLeagueBetas si no existen (compatibilidad con weights v3)
  if (!weights.betas) {
    weights.betas = JSON.parse(JSON.stringify(DEFAULT_WEIGHTS.betas));
  }
  if (!weights.perLeagueBetas) {
    weights.perLeagueBetas = {};
  }
  
  const betas = weights.betas;
  // Solo aprender de predicciones del modelo lambda actual (_lambda presente)
  // y con confianza minima (evitar que preds al 5% con gol-until-FT empujen betas al techo)
  const learnable = verified.filter(pred => {
    if (pred.predictionCorrect === null) return false;
    if (pred._lambda == null && pred.predictedProbability15 == null) return false;
    const prob = (pred.predictedProbability || 0) / 100;
    if (prob < 0.30 || prob > 0.95) return false;
    const error = (pred.goalAfterAnalysis ? 1 : 0) - prob;
    return Math.abs(error) >= 0.15;
  });
  // Cap por ciclo: max 5 de MAYOR error, lr bajo → no explotar betas
  learnable.sort((a, b) => {
    const ea = Math.abs((a.goalAfterAnalysis ? 1 : 0) - (a.predictedProbability || 0) / 100);
    const eb = Math.abs((b.goalAfterAnalysis ? 1 : 0) - (b.predictedProbability || 0) / 100);
    return eb - ea;
  });
  const batch = learnable.slice(0, 5);
  const lr = Math.min(0.02, (weights.learningRate || 0.03) / Math.max(batch.length, 1));
  let adjustments = 0;

  for (const pred of batch) {
    const prob = (pred.predictedProbability || 0) / 100;
    const goalHappened = pred.goalAfterAnalysis || false;
    const error = (goalHappened ? 1 : 0) - prob;
    const direction = error > 0 ? 1 : -1;
    const scale = lr * direction * Math.min(1, Math.abs(error));

    betas.baseline = Math.max(0.015, Math.min(0.038, betas.baseline * (1 + scale * 0.35)));
    betas.xgWeight = Math.max(0.4, Math.min(1.8, betas.xgWeight * (1 + scale * 0.6)));
    betas.bcWeight = Math.max(0.5, Math.min(2.5, betas.bcWeight * (1 + scale * 0.6)));
    betas.sotWeight = Math.max(0.1, Math.min(1.0, betas.sotWeight * (1 + scale * 0.5)));
    betas.urgency60 = Math.max(1.10, Math.min(1.70, betas.urgency60 * (1 + scale * 0.25)));
    betas.urgency75 = Math.max(1.15, Math.min(1.90, betas.urgency75 * (1 + scale * 0.25)));
    adjustments++;

    if (pred.league) {
      const league = pred.league;
      if (!weights.perLeagueBetas[league]) weights.perLeagueBetas[league] = {};
      const lb = weights.perLeagueBetas[league];
      const currentBl = lb.baseline || betas.baseline;
      lb.baseline = Math.max(0.015, Math.min(0.038, currentBl * (1 + scale * 0.25)));
    }
  }
  
  // Redondear betas a 3 decimales
  for (const k of Object.keys(betas)) {
    if (typeof betas[k] === 'number') betas[k] = Math.round(betas[k] * 1000) / 1000;
  }
  
  // Brier solo de preds del modelo actual (_lambda) — no contaminar con scores viejos
  if (verified.length > 0) {
    let batchSum = 0;
    let batchCount = 0;
    for (const pred of verified) {
      if (pred.predictionCorrect === null) continue;
      if (pred._lambda == null && pred.predictedProbability15 == null) continue;
      const p = (pred.predictedProbability || 0) / 100;
      const y = pred.goalAfterAnalysis ? 1 : 0;
      batchSum += Math.pow(p - y, 2);
      batchCount++;
      const alertP = pred.firstAlertProbability != null ? pred.firstAlertProbability : pred.predictedProbability;
      if ((alertP || 0) >= 80 && pred.alertCorrect !== undefined && pred.alertCorrect !== null) {
        weights.stats.alertCount = (weights.stats.alertCount || 0) + 1;
        if (pred.alertCorrect) weights.stats.alertHits = (weights.stats.alertHits || 0) + 1;
      }
    }
    if (batchCount > 0) {
      const prevN = weights.stats.brierCount || 0;
      const prevAvg = weights.stats.brierScore || 0;
      const totalN = prevN + batchCount;
      const newAvg = totalN > 0 ? ((prevAvg * prevN) + batchSum) / totalN : batchSum / batchCount;
      weights.stats.brierScore = Math.round(newAvg * 10000) / 10000;
      weights.stats.brierCount = totalN;
    }
  }
  
  return adjustments;
}

// ========== AJUSTE DE PESOS ==========

/**
 * Presencia de cada feature en las stats de una prediccion.
 * Se usa para escalar el ajuste de cada peso: si un partido no tenia corners,
 * el error de ese partido NO debe mover el peso de corners (antes TODOS los
 * pesos se movian igual con cada error — gradiente ciego).
 */
const FEATURE_PRESENCE = {
  xg: s => (s.xgHome || 0) + (s.xgAway || 0) > 0.3,
  shotsOnTarget: s => (s.sotHome || 0) + (s.sotAway || 0) >= 2,
  shotsInsideBox: s => (s.shotsInsideBoxHome || 0) + (s.shotsInsideBoxAway || 0) >= 2,
  bigChances: s => (s.bigChancesHome || 0) + (s.bigChancesAway || 0) >= 1,
  totalShots: s => (s.totalShotsHome || 0) + (s.totalShotsAway || 0) >= 6,
  xgot: s => (s.xgotHome || 0) + (s.xgotAway || 0) > 0.3,
  hitWoodwork: s => (s.hitWoodworkHome || 0) + (s.hitWoodworkAway || 0) >= 1,
  xA: s => (s.xgHomeA || 0) + (s.xgAwayA || 0) > 0.2,
  touchesOppBox: s => (s.touchesOppBoxHome || 0) + (s.touchesOppBoxAway || 0) >= 5,
  corners: s => (s.cornersHome || 0) + (s.cornersAway || 0) >= 3,
  saves: s => (s.savesHome || 0) + (s.savesAway || 0) >= 2,
  redCard: s => (s.redCardsHome || 0) + (s.redCardsAway || 0) >= 1,
  // Features contextuales siempre presentes (aplican a todo partido)
  scoreNeeds: () => true,
  timePressure: () => true,
  possession: s => (s.possessionHome || 0) > 0 || (s.possessionAway || 0) > 0,
  goalsScored: () => true,
  teamHistory: () => true,
  matchContext: () => true,
};

function adjustWeights(weights, verified, insights) {
  let adjustments = 0;

  // Filtrar predicciones utiles para aprender:
  // - error significativo (> 15pp)
  // - el modelo mostraba minima confianza (>= 20%)
  // Si no, es ruido (prediccion 5% donde hubo gol no dice nada util)
  const useful = verified.filter(pred => {
    if (pred.predictionCorrect === null) return false;
    const prob = (pred.predictedProbability || 0) / 100;
    if (prob < 0.20) return false;
    const goalHappened = pred.goalAfterAnalysis || false;
    const error = (goalHappened ? 1 : 0) - prob;
    return Math.abs(error) >= 0.15;
  });
  if (useful.length === 0) return 0;

  // Normalizar learning rate por lote: si hay muchas verificaciones juntas,
  // cada una aporta menos para evitar sobre-ajuste masivo
  const lr = weights.learningRate / Math.min(useful.length, 10);

  // Agrupar por ventana para ajustar pesos específicos
  const byWindow = {};
  for (const pred of useful) {
    const wt = pred.windowType || 'late';
    if (!byWindow[wt]) byWindow[wt] = [];
    byWindow[wt].push(pred);
  }

  const globalKeys = ['xg', 'shotsOnTarget', 'shotsInsideBox', 'bigChances', 'totalShots', 'xgot', 'hitWoodwork', 'xA', 'touchesOppBox', 'scoreNeeds', 'timePressure', 'corners', 'possession', 'saves', 'goalsScored', 'redCard', 'teamHistory', 'matchContext'];

  for (const [windowType, preds] of Object.entries(byWindow)) {
    const w = getWindowWeights(weights, windowType);
    const windowLr = lr / Math.min(preds.length, 5); // más datos por ventana = menos ajuste agresivo

    for (const pred of preds) {
      const prob = (pred.predictedProbability || 0) / 100;
      const goalHappened = pred.goalAfterAnalysis || false;
      const error = (goalHappened ? 1 : 0) - prob;
      const direction = error > 0 ? 1 : -1;
      const adjust = windowLr * direction;

      for (const key of globalKeys) {
        if (!(key in w)) continue;
        // Escalar por presencia de la feature: si el partido no tenia esa
        // estadistica, el ajuste se reduce al 30% (evita gradiente ciego)
        const presence = FEATURE_PRESENCE[key] ? FEATURE_PRESENCE[key](pred.stats || {}) : true;
        const scaledAdjust = adjust * (presence ? 1 : 0.3);
        if (key === 'goalsScored') {
          w[key] = Math.round(Math.max(-20, Math.min(0, w[key] * (1 + scaledAdjust))) * 10) / 10;
        } else {
          w[key] = Math.round(Math.max(1, Math.min(60, w[key] * (1 + scaledAdjust))) * 10) / 10;
        }
        adjustments++;
      }

      // NO incrementar verifiedCount aqui: lo hace el caller ([4/4] o runLearning)
      // para evitar doble conteo.

      // Ajuste por liga (isFinal=false si la verificacion fue en vivo con score parcial)
      updateLeagueProfile(weights, pred, pred.finalScore ? { scoreHome: pred.finalScore.home, scoreAway: pred.finalScore.away } : { scoreHome: 0, scoreAway: 0 }, !pred._verifiedLive);
    }
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

  // Pesos por ventana
  const windowLabels = { firstHalf: '1T (0-44\')', earlySecondHalf: '46-70\'', late: '71+\'' };
  for (const [wt, label] of Object.entries(windowLabels)) {
    const w = getWindowWeights(weights, wt);
    if (!w) continue;
    console.log('\n  --- PESOS ' + label + ' ---');
    const sorted = Object.entries(w).sort((a, b) => b[1] - a[1]);
    sorted.forEach(([k, v]) => {
      if (k === 'goalsScored') return;
      const bar = '\u2588'.repeat(Math.round(Math.abs(v) / 3)) + '\u2591'.repeat(20 - Math.round(Math.abs(v) / 3));
      console.log('  ' + k.padEnd(18) + v.toString().padStart(5) + '  ' + bar);
    });
  }

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
    // Contadores una sola vez por prediccion verificada en este path
    for (const pred of verified) {
      weights.stats.verifiedCount = (weights.stats.verifiedCount || 0) + 1;
      if (pred.predictionCorrect) weights.stats.correctScore = (weights.stats.correctScore || 0) + 1;
    }
    const adjustments = adjustWeights(weights, verified, insights);
    const betaAdj = adjustBetas(weights, verified);
    saveTeams(teams);
    saveWeights(weights);
    savePredictions(predictions);
    console.log('  Pesos ajustados: ' + adjustments + ' legacy + ' + betaAdj + ' betas');

    printLearningReport(weights, predictions, insights, teams);
    return { weights, adjustments: adjustments + betaAdj, insights, teams };
  }

  return { weights, adjustments: 0, insights: [], teams };
}

module.exports = { runLearning, loadTeams, adjustWeights, updateTeamStats, saveTeams, getWindowWeights, getBetas, adjustBetas };
