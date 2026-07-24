const fs = require('fs');
const path = require('path');
const { runLearning, updateTeamStats, adjustWeights, loadTeams, saveTeams, getWindowWeights } = require('./learn');
const notify = require('./notify');
const scores365 = require('./scores365');
const { fetchStatsBatch, extractMatchMomentum } = require('./flashscore_fetcher');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const WEIGHTS_FILE = path.join(__dirname, 'weights.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');
const ALERTAS_LOG_FILE = path.join(__dirname, 'alertas_log.json');

const DEFAULT_WEIGHTS = {
  version: 1, learningRate: 0.05,
  global: {
    xg: 30, shotsOnTarget: 25, shotsInsideBox: 18, bigChances: 15, totalShots: 10,
    xgot: 12, hitWoodwork: 10, xA: 8, touchesOppBox: 8,
    scoreNeeds: 10, timePressure: 8, corners: 5, possession: 5, saves: 5, goalsScored: -10,
    teamFactor: 8, leagueFactor: 5
  },
  byLeague: {},
  stats: { predictionsCount: 0, correctScore: 0, correctScorer: 0, createdCount: 0, verifiedCount: 0 }
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
function getLeagueWeights(weights, league, windowType) {
  const base = windowType ? getWindowWeights(weights, windowType) : (weights.globalFallback || weights.global || {});
  const w = { ...base };
  if (league && weights.byLeague && weights.byLeague[league]) Object.keys(w).forEach(k => { if (weights.byLeague[league][k] !== undefined) w[k] = weights.byLeague[league][k]; });
  return w;
}

/**
 * Ajustar pesos por tramo temporal segun analisis historico:
 * - 25-44 min: xG/SOT/Box inflan fallos. Fouls bajos y woodwork predicen aciertos.
 * - 61-75 min: TODAS las stats ofensivas inflan fallos (33% asertividad). Fouls ALTOS es la señal mas clara.
 * - 76+ min: xG/SOT/Box/BC SI predicen. goalsPenalty mal calibrado (castiga aciertos).
 */
function applyTramoMultipliers(w, minute) {
  const adjusted = { ...w };
  if (minute >= 25 && minute <= 44) {
    // 25-44: bajar ofensivos, subir woodwork, mantener fouls penalty
    if (adjusted.xg !== undefined) adjusted.xg *= 0.85;
    if (adjusted.shotsOnTarget !== undefined) adjusted.shotsOnTarget *= 0.85;
    if (adjusted.shotsInsideBox !== undefined) adjusted.shotsInsideBox *= 0.9;
  } else if (minute >= 61 && minute <= 75) {
    // 61-75: bajar TODO ofensivo (infla fallos), mantener defensivos
    if (adjusted.xg !== undefined) adjusted.xg *= 0.6;
    if (adjusted.shotsOnTarget !== undefined) adjusted.shotsOnTarget *= 0.65;
    if (adjusted.shotsInsideBox !== undefined) adjusted.shotsInsideBox *= 0.55;
    if (adjusted.bigChances !== undefined) adjusted.bigChances *= 0.5;
    if (adjusted.totalShots !== undefined) adjusted.totalShots *= 0.7;
    if (adjusted.hitWoodwork !== undefined) adjusted.hitWoodwork *= 0.9;
    if (adjusted.goalsScored !== undefined) adjusted.goalsScored *= 1.0;
  } else if (minute >= 76) {
    // 76+: mantener ofensivos (SI predicen), suavizar goalsPenalty (castiga aciertos)
    if (adjusted.goalsScored !== undefined) adjusted.goalsScored *= 0.6;
    if (adjusted.xg !== undefined) adjusted.xg *= 1.05;
    if (adjusted.shotsOnTarget !== undefined) adjusted.shotsOnTarget *= 1.05;
  }
  return adjusted;
}

/** Window-specific estimated odds */
const WINDOW_ODDS = {
  firstHalf: 3.0,
  earlySecondHalf: 2.5,
  late: 3.5,
};

/** Determine window type from minute */
function getWindowType(minute) {
  if (minute <= 44) return 'firstHalf';
  if (minute <= 65) return 'earlySecondHalf';
  return 'late';
}

/** Get fallback score when stats are mostly null */
function getFallbackScore(minute, scoreHome, scoreAway, league, match) {
  let base = 20;
  const gd = Math.abs(scoreHome - scoreAway);
  
  if (minute <= 44) {
    base = 30;
    if (gd === 0 && minute >= 25) base += 10;
    if (gd <= 1 && minute >= 30) base += 5;
    if (match.stats?.possessionHome !== null && match.stats?.possessionAway !== null) {
      const diff = Math.abs(match.stats.possessionHome - match.stats.possessionAway);
      if (diff > 15) base += 10;
    }
    if (match.stats?.attacksHome !== null || match.stats?.attacksAway !== null) {
      const total = (match.stats.attacksHome||0) + (match.stats.attacksAway||0);
      if (total > 60) base += 10;
    }
    if (match.stats?.cornersHome !== null || match.stats?.cornersAway !== null) {
      const total = (match.stats.cornersHome||0) + (match.stats.cornersAway||0);
      if (total >= 4) base += 10;
    }
  } else if (minute <= 70) {
    base = 25;
    if (gd === 0) base += 10;
  }
  
  // Cap 70: sin stats reales NUNCA debe acercarse al umbral de alerta (80%)
  return Math.min(70, base);
}

/** Check if match has meaningful stats for scoring */
function hasMeaningfulStats(stats) {
  if (!stats) return false;
  const xgTotal = (stats.xgHome||0) + (stats.xgAway||0);
  const sotTotal = (stats.sotHome||0) + (stats.sotAway||0);
  const shotsBoxTotal = (stats.shotsInsideBoxHome||0) + (stats.shotsInsideBoxAway||0);
  const bigChancesTotal = (stats.bigChancesHome||0) + (stats.bigChancesAway||0);
  const atkTotal = (stats.attacksHome||0) + (stats.attacksAway||0);
  return (xgTotal > 0.3 || sotTotal >= 3 || shotsBoxTotal >= 3 || bigChancesTotal >= 1 || atkTotal >= 50);
}

function analyzeGoal(match, w, teams, leagueContext, windowType) {
  let score = 0;
  let reasons = [];
  let predictedScorer = null;
  let scorerReasons = [];
  const s = match.stats;
  const goals = (match.scoreHome || 0) + (match.scoreAway || 0);
  const minute = match.minute || 0;
  // Ajustar pesos por tramo temporal (hallazgo: 61-75 min las stats ofensivas inflan fallos)
  w = applyTramoMultipliers(w, minute);
  const homeNeeds = match.scoreHome < match.scoreAway;
  const awayNeeds = match.scoreAway < match.scoreHome;
  const draw = match.scoreHome === match.scoreAway;
  let pressure = 0;

  // --- Match context detection (playoffs, derbys, cup finals) ---
  if (match.league) {
    const ctx = match.league.toLowerCase();
    const highStakes = /final|copa|playoff|play.off|derby|derbi|descenso|repechaje|promoci[oó]n|champions|eliminatoria|semifinal|cuartos/i.test(ctx);
    if (highStakes) {
      const ctxBonus = (w.matchContext || 5);
      if (/final/i.test(ctx) || /derby|derbi/i.test(ctx)) {
        score += ctxBonus * 1.5;
        pressure += 15;
        reasons.push('Partido de alta tension');
      } else {
        score += ctxBonus;
        pressure += 8;
        reasons.push('Partido decisivo');
      }
    }
  }

  // --- League context normalization ---
  if (leagueContext && leagueContext.goalsPerMatch) {
    const matchXg = (s.xgHome || 0) + (s.xgAway || 0);
    const xgVsAvg = matchXg > 0 && minute > 0 ? (matchXg / minute * 90) / leagueContext.goalsPerMatch : null;
    if (xgVsAvg !== null) {
      if (xgVsAvg > 1.5) {
        score += 10; pressure += 15;
        reasons.push('Partido muy superior a media liga (' + leagueContext.goalsPerMatch.toFixed(2) + ' g/p)');
      } else if (xgVsAvg > 1.0) {
        score += 5; pressure += 8;
        reasons.push('Por encima de media liga (' + leagueContext.goalsPerMatch.toFixed(2) + ' g/p)');
      }
    }
    // Corners context
    if (leagueContext.cornersPerMatch && s.cornersHome !== null && s.cornersAway !== null) {
      const cornersPerMin = (s.cornersHome + s.cornersAway) / minute * 90;
      if (cornersPerMin > leagueContext.cornersPerMatch * 1.3) {
        score += 5; pressure += 5;
        reasons.push('Corners sobre media liga');
      }
    }
  }
  if (leagueContext && leagueContext.name) {
    reasons.push(leagueContext.name);
  }

  // --- xG ---
  if (s.xgHome !== null && s.xgAway !== null) {
    const totalXG = s.xgHome + s.xgAway, remaining = totalXG - goals;
    if (remaining > 1.5) { score += w.xg * 1; pressure += 30; reasons.push('Alto xG restante (' + remaining.toFixed(2) + ')'); }
    else if (remaining > 0.8) { score += w.xg * 0.75; pressure += 20; reasons.push('xG restante ' + remaining.toFixed(2)); }
    else if (remaining > 0.3) { score += w.xg * 0.4; pressure += 10; }
    if (totalXG > 1.5 && goals === 0) { score += w.xg * 0.3; pressure += 10; reasons.push('0-0 con alto xG!'); }
    if (totalXG > 1.0 && goals <= 1) score += w.xg * 0.15;
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
    if (total >= 4 && goals === 0) { score += w.shotsOnTarget * 0.3; pressure += 5; reasons.push('Tiran a puerta pero no entran'); }
    if (total >= 6 && goals <= 1) score += w.shotsOnTarget * 0.2;
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
  // --- Goals scored penalty (escalado, no plano) ---
  if (goals > 0) {
    const gsPenalty = w.goalsScored || -4;
    score += gsPenalty * Math.min(goals, 4);
    if (goals >= 3 && minute >= 70) {
      score += gsPenalty * 0.5;
      reasons.push('Partido definido (' + goals + ' goles)');
    }
  }
  if (goals >= 2 && minute >= 80) {
    score -= 10;
    reasons.push('Ventaja doble, pocas opciones');
  }

  // --- Red card detection ---
  const redTotal = (s.redCardsHome || 0) + (s.redCardsAway || 0);
  if (redTotal > 0) {
    const rcWeight = w.redCard || 18;
    const rcBonus = rcWeight * redTotal * (minute >= 65 ? 1.5 : 1);
    score += rcBonus;
    pressure += 12 * redTotal;
    const which = (s.redCardsHome || 0) > 0 ? (s.redCardsAway || 0) > 0 ? 'ambos equipos' : 'el local' : 'el visitante';
    reasons.push(redTotal + ' roja(s) (' + which + ') — partido roto!');
  }

  // --- Time pressure ---
  if (minute >= 80 && pressure >= 20) { score += w.timePressure * 1; reasons.push('Min ' + minute + "' — presion final!"); }
  else if (minute >= 70 && pressure >= 25) { score += w.timePressure * 0.8; reasons.push('Min ' + minute + "' — definicion"); }
  else if (minute >= 60 && pressure >= 30) { score += w.timePressure * 0.5; }
  else if (minute < 20 && pressure >= 25) { score += w.timePressure * 0.5; reasons.push('Presion desde el inicio'); }

  // --- Minute decay (tiempo corriendo, gol no llega) ---
  // En descuento (90+) los goles son mas probables — reseteamos decay
  if (minute >= 90) {
    // No decay — stoppage time es cuando mas goles llegan
  } else if (minute >= 85 && score >= 60) {
    score -= 15;
    reasons.push('Agotando tiempo sin gol');
  } else if (minute >= 78 && score >= 75) {
    const decay = Math.min(25, (minute - 75) * 3);
    score -= decay;
    reasons.push('Gol no llega (min ' + minute + "')");
  }
  score = Math.max(0, score);

  // --- Blocked shots penalty (defensa bloqueando tiros) ---
  if (s.blockedShotsHome !== null && s.blockedShotsAway !== null && s.totalShotsHome !== null && s.totalShotsAway !== null) {
    const blocked = (s.blockedShotsHome||0) + (s.blockedShotsAway||0);
    const totalShots = (s.totalShotsHome||0) + (s.totalShotsAway||0);
    if (totalShots > 0 && blocked / totalShots > 0.25 && blocked >= 3) {
      const penalty = Math.min(15, (blocked / totalShots - 0.25) * 40);
      score -= penalty;
      if (penalty >= 8) reasons.push('Defensa bloqueando tiros (' + Math.round(blocked/totalShots*100) + '%)');
    }
  }

  // --- Off target penalty (tiros desviados, poca precision) ---
  if (s.shotsOffTargetHome !== null && s.shotsOffTargetAway !== null && s.totalShotsHome !== null && s.totalShotsAway !== null) {
    const offTarget = (s.shotsOffTargetHome||0) + (s.shotsOffTargetAway||0);
    const totalShots = (s.totalShotsHome||0) + (s.totalShotsAway||0);
    if (totalShots > 0 && offTarget / totalShots > 0.4 && offTarget >= 6) {
      const penalty = Math.min(10, (offTarget / totalShots - 0.4) * 25);
      score -= penalty;
    }
  }

  // --- Fouls penalty (partido trabado) ---
  if (s.foulsHome !== null && s.foulsAway !== null) {
    const fouls = (s.foulsHome||0) + (s.foulsAway||0);
    if (fouls >= 20) {
      score -= Math.min(8, (fouls - 20) * 0.5);
    }
  }

  // --- Progressive passes proxy (passesFinalThird + crosses + keyPasses) ---
  // Segun StatsBomb: posesiones con 2+ pases progresivos generan 36% prob de tiro vs 5.8% sin
  if (s.passesFinalThirdHome !== null && s.passesFinalThirdAway !== null) {
    const total = (s.passesFinalThirdHome||0) + (s.passesFinalThirdAway||0);
    if (total >= 60) { score += 6; pressure += 10; reasons.push('Flujo ofensivo (' + total + ' pases ult. tercio)'); }
    else if (total >= 35) { score += 4; pressure += 6; }
  }

  // --- Crosses (centros como proxy de penetracion ancha) ---
  if (s.crossesHome !== null && s.crossesAway !== null) {
    const total = (s.crossesHome||0) + (s.crossesAway||0);
    if (total >= 20) { score += 4; pressure += 5; reasons.push('Presion por bandas (' + total + ' centros)'); }
    else if (total >= 12) { score += 2; pressure += 2; }
  }

  // --- Key passes (pases claves = proxy de xA) ---
  if (s.keyPassesHome !== null && s.keyPassesAway !== null) {
    const total = (s.keyPassesHome||0) + (s.keyPassesAway||0);
    if (total >= 10) { score += 5; pressure += 8; reasons.push('Creacion peligrosa (' + total + ' pases clave)'); }
    else if (total >= 6) { score += 3; pressure += 4; }
  }

  // --- Interceptions (proxy de high turnover — recuperaciones en transicion) ---
  if (s.interceptionsHome !== null && s.interceptionsAway !== null) {
    const total = (s.interceptionsHome||0) + (s.interceptionsAway||0);
    if (total >= 15) { score += 4; pressure += 6; }
  }

  // --- Possession won in final third (recuperaciones altas = presion alta) ---
  if (s.possessionWonFinalThirdHome !== null && s.possessionWonFinalThirdAway !== null) {
    const total = (s.possessionWonFinalThirdHome||0) + (s.possessionWonFinalThirdAway||0);
    if (total >= 8) { score += 7; pressure += 12; reasons.push('Geggenpressing! (' + total + ' recuperaciones altas)'); }
    else if (total >= 4) { score += 3; pressure += 5; }
  }

  // --- Possession lost penalty (perdidas = Jugadas de riesgo defensivo) ---
  if (s.possessionLostHome !== null && s.possessionLostAway !== null) {
    const total = (s.possessionLostHome||0) + (s.possessionLostAway||0);
    // Perdidas altas indican juego vertical y riesgo (puede ir en ambos sentidos)
    if (total >= 80) { score += 3; pressure += 5; }
  }

  // --- Clearances penalty (Despejes defensivos = bloqueo del rival) ---
  if (s.clearancesHome !== null && s.clearancesAway !== null) {
    const total = (s.clearancesHome||0) + (s.clearancesAway||0);
    if (total >= 20) {
      score -= 4;
      if (total >= 30) reasons.push('Defensa despejando mucho (' + total + ' despejes)');
    }
  }

  // --- Dribbles (regates = proxy de abrir defensivas) ---
  if (s.dribblesHome !== null && s.dribblesAway !== null) {
    const total = (s.dribblesHome||0) + (s.dribblesAway||0);
    if (total >= 15) { score += 2; pressure += 3; }
  }

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

  // --- Team factor (historial del equipo + eficiencia xG) ---
  if (teams) {
    const teamNames = Object.keys(teams);
    if (teamNames.length > 0) {
      const normalize = (s) => s?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
      const h = normalize(match.teamHome), a = normalize(match.teamAway);
      let homeFactor = 1.0, awayFactor = 1.0;
      let homeReasons = [], awayReasons = [];
      for (const [name, data] of Object.entries(teams)) {
        const n = normalize(name);
        const isHome = h.includes(n) || n.includes(h);
        const isAway = a.includes(n) || n.includes(a);
        if (!isHome && !isAway) continue;
        // Factor por eficiencia xG: goles reales / xG acumulado.
        // BUG FIX: antes usaba totalXgEfficiency (suma de 1/xG por partido con gol)
        // que penalizaba a equipos goleadores (3 goles con xG 1.0 daba eff BAJA).
        // Ahora: eff = goles / xG — >1.3 rinde sobre lo esperado, <0.7 rinde bajo.
        if ((data.totalXgFor || 0) >= 1 && (data.totalGoalsScored || 0) >= 2) {
          const avgEff = data.totalGoalsScored / Math.max(0.1, data.totalXgFor);
          if (avgEff > 1.3) {
            const bonus = Math.min(0.15, (avgEff - 1.3) * 0.1);
            if (isHome) { homeFactor += bonus; homeReasons.push('+eficiente xG'); }
            if (isAway) { awayFactor += bonus; awayReasons.push('+eficiente xG'); }
          } else if (avgEff < 0.7) {
            const penalty = Math.min(0.15, (0.7 - avgEff) * 0.1);
            if (isHome) { homeFactor -= penalty; homeReasons.push('-eficiente xG'); }
            if (isAway) { awayFactor -= penalty; awayReasons.push('-eficiente xG'); }
          }
        }
        // Factor por conversion rate historico
        if (data.timesPredictedGoal >= 2) {
          const rate = data.goalsWhenPredicted / data.timesPredictedGoal;
          if (rate > 0.7) {
            const bonus = (rate - 0.7) * 0.5;
            if (isHome) { homeFactor += bonus; homeReasons.push('historial+' + Math.round((rate - 0.7) * 100) + '%'); }
            if (isAway) { awayFactor += bonus; awayReasons.push('historial+' + Math.round((rate - 0.7) * 100) + '%'); }
          } else if (rate < 0.3) {
            const penalty = (0.3 - rate) * 0.5;
            if (isHome) { homeFactor -= penalty; homeReasons.push('historial-' + Math.round((0.3 - rate) * 100) + '%'); }
            if (isAway) { awayFactor -= penalty; awayReasons.push('historial-' + Math.round((0.3 - rate) * 100) + '%'); }
          }
        }
      }
      const teamBonus = Math.max(homeFactor, awayFactor);
      if (teamBonus !== 1.0) {
        const adj = Math.round((teamBonus - 1) * 100);
        const extra = (w.teamHistory || 8) * (adj / 20);
        score += extra;
        const reasonsList = homeFactor > awayFactor ? homeReasons : awayReasons;
        reasons.push('Equipo ' + (adj > 0 ? 'rinde+' : 'rinde-') + '(' + reasonsList.join(',') + ')');
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

  // CORTAR primero, luego penalizar
  // --- MATRIZ DE PESOS POR TRAMO TEMPORAL ---
  // Hallazgo: 61-75 min tiene solo 33% asertividad (vs 75% en 25-44, 61% en 76+)
  // Las stats ofensivas INFLAN fallos en 61-75 (xG +10, Box +8.5, BC +6.3 vs aciertos)
  // Aplicamos multiplicador que reduce el influjo de stats ofensivas en 61-75
  if (minute >= 61 && minute <= 75) {
    // En 61-75, reducir el score base por 15% (stats son menos predictivas aqui)
    score = score * 0.85;
    reasons.push('Tramo 61-75\' (stats menos predictivas)');
  }
  
  let cappedScore = Math.min(Math.max(score, 0), 100);

  // --- INDICADORES ---
  const bcTotal = (s.bigChancesHome || 0) + (s.bigChancesAway || 0);
  const sotTotal = (s.sotHome || 0) + (s.sotAway || 0);
  const xgotTotal = (s.xgotHome || 0) + (s.xgotAway || 0);
  const gd = Math.abs(match.scoreHome - match.scoreAway);
  const totalShots = (s.totalShotsHome || 0) + (s.totalShotsAway || 0);
  const offTarget = (s.shotsOffTargetHome || 0) + (s.shotsOffTargetAway || 0);
  const blockedTotal = (s.blockedShotsHome || 0) + (s.blockedShotsAway || 0);
  const attTotal = (s.attacksHome || 0) + (s.attacksAway || 0);
  const woodTotal = (s.hitWoodworkHome || 0) + (s.hitWoodworkAway || 0);
  const blockRatio = totalShots > 0 ? blockedTotal / totalShots : 0;
  const xgTotal = (s.xgHome || 0) + (s.xgAway || 0);
  const xgPerShot = totalShots > 0 ? xgTotal / totalShots : 0;

  // --- R1: 1-0 min>=84 BC=0 (3 fallos, 0 aciertos) ---
  if (gd === 1 && minute >= 84 && bcTotal === 0) {
    cappedScore -= 50;
    reasons.push('1-0 final sin peligro');
  }

  // --- R2: 0-0 min>=70 BC=0 SOT>=3 xGOT=0 (2 fallos, 0 aciertos) ---
  if (goals === 0 && minute >= 70 && bcTotal === 0 && sotTotal >= 3 && xgotTotal < 0.5) {
    cappedScore = Math.min(cappedScore, 60);
    reasons.push('0-0 con tiros sin calidad (xGOT=0)');
  }

  // --- R3: 0-0 min>=85 BC<3 (1 fallo, 0 aciertos) ---
  if (goals === 0 && minute >= 85 && bcTotal < 3) {
    cappedScore -= 20;
    reasons.push('Ultimos minutos sin concretar');
  }

  // --- R4: BC>=5 min>=60 xG/BC < 0.4 (1 fallo, 0 aciertos) ---
  if (bcTotal >= 5 && minute >= 60) {
    if (xgTotal / bcTotal < 0.4) {
      cappedScore -= 25;
      reasons.push('Muchas ocasiones sin concretar (' + bcTotal + ' BC, ' + xgTotal.toFixed(2) + ' xG)');
    }
  }

  // --- R5: min<25 GD=1 BC<2 (1 fallo, 0 aciertos) ---
  if (minute < 25 && gd === 1 && bcTotal < 2) {
    cappedScore -= 35;
    reasons.push('Demasiado temprano, ventaja estrecha');
  }

  // --- R14: Att>=100 + SOT<5 + BC<2 (4 fallos, 0 aciertos) ---
  if (attTotal >= 100 && sotTotal < 5 && bcTotal < 2) {
    cappedScore -= 45;
    reasons.push('Muchos ataques sin concretar (' + attTotal + ' att, ' + sotTotal + ' SOT, ' + bcTotal + ' BC)');
  }

  // --- R15: BlockRatio>0.25 + offTarget>=5 + xgPerShot<0.1 (5 fallos, 2 aciertos) ---
  if (blockRatio > 0.25 && offTarget >= 5 && xgPerShot < 0.1 && woodTotal < 2) {
    cappedScore -= 35;
    reasons.push('Muchos bloqueos/tiros desviados de baja calidad');
  }

  // --- R16: Fouls>=12 + totalShots>=12 + xgPerShot<0.09 (7 fallos, 2 aciertos) ---
  const foulsTotal = (s.foulsHome || 0) + (s.foulsAway || 0);
  if (foulsTotal >= 12 && totalShots >= 12 && xgPerShot < 0.09) {
    cappedScore = Math.min(cappedScore, 65);
    reasons.push('Partido trabado con tiros de baja calidad');
  }

  // --- R17: min>=70 + BC=0 + totalShots>=10 (5 fallos, 2 aciertos) ---
  if (minute >= 70 && bcTotal === 0 && totalShots >= 10 && xgTotal < 1.0) {
    cappedScore -= 30;
    reasons.push('Segunda mitad sin ocasiones claras');
  }

  // --- R18: GD=1 min>=80 BC=0 Wood=0 (3 fallos, 1 acierto) ---
  if (gd === 1 && minute >= 80 && bcTotal === 0 && woodTotal === 0 && xgTotal < 1.0) {
    cappedScore -= 25;
    reasons.push('Ventaja minima sin peligro real');
  }

  // --- R19: 61-75 min con marcador 0-0, 1-0 o 1-1 (asertividad historica <25%) ---
  // Hallazgo: en 61-75, 0-0=25%, 1-0=20%, 1-1=0% asertividad
  if (minute >= 61 && minute <= 75 && (goals === 0 || (goals === 2 && gd === 0) || (gd === 1 && goals === 1))) {
    cappedScore = Math.min(cappedScore, 60);
    reasons.push('Tramo 61-75\' con marcador estrecho');
  }

  // --- R20: 76+ min con 1-0 (solo 22% asertividad historica) ---
  if (minute >= 76 && gd === 1 && goals === 1 && bcTotal === 0 && woodTotal === 0) {
    cappedScore = Math.min(cappedScore, 65);
    reasons.push('1-0 en finales sin peligro real');
  }

  // --- R21: Solo permitir alertas en ventanas 25-44, 60-75, 76+ ---
  // Fuera de esas ventanas el modelo no es predictivo o las cuotas son bajas
  if (minute < 25 || (minute >= 45 && minute <= 59)) {
    cappedScore = Math.min(cappedScore, 60);
  }

  cappedScore = Math.max(0, cappedScore);

  // Suppress firstHalf alerts unless the predicted team dominates AND needs a goal
  if (windowType === 'firstHalf' && predictedScorer) {
    const needsGoal = predictedScorer === 'home'
      ? match.scoreHome < match.scoreAway
      : match.scoreAway < match.scoreHome;
    const stats = match.stats || {};
    const dominates = predictedScorer === 'home'
      ? (stats.xgHome || 0) > (stats.xgAway || 0) + 0.3
        && (stats.sotHome || 0) >= (stats.sotAway || 0) + 2
        && (stats.possessionHome || 0) > 0.58
      : (stats.xgAway || 0) > (stats.xgHome || 0) + 0.3
        && (stats.sotAway || 0) >= (stats.sotHome || 0) + 2
        && (stats.possessionAway || 0) > 0.58;
    if (!needsGoal || !dominates) {
      cappedScore = Math.min(cappedScore, 74);
      reasons.push('1T: necesita dominar y estar abajo para alertar');
    }
  }

  // Early minutes: muy temprano para predecir con confianza
  if (minute < 25) {
    cappedScore = Math.min(cappedScore, 74);
    reasons.push('Demasiado temprano (< 25 min)');
  }

  // Low xG override: si el equipo pronosticado tiene xG bajo, baja la confianza
  if (predictedScorer) {
    const predXg = predictedScorer === 'home' ? (s.xgHome || 0) : (s.xgAway || 0);
    if (predXg < 0.5 && cappedScore >= 65) {
      const reduction = Math.min(25, (0.5 - predXg) * 40);
      cappedScore -= reduction;
      reasons.push('xG bajo (' + predXg.toFixed(2) + ') del equipo pronosticado');
    }
  }

  // Overconfidence damping: comprime scores altos para evitar falsos 100%.
  // CALIBRACION: con factor 0.45 el umbral de alerta (80) exigia score crudo ~92
  // — practicamente inalcanzable y el sistema quedaba mudo. Con 0.6 solo
  // partidos verdaderamente excepcionales (score crudo >= 87) superan el 80%.
  if (cappedScore > 70) {
    cappedScore = Math.round(70 + (cappedScore - 70) * 0.6);
    reasons.push('Ajuste de confianza aplicado');
  }

  // --- SISTEMA DE CONFLUENCIA (requiere minimas senales fuertes para alta confianza) ---
  // Contar senales fuertes positivas
  let strongSignals = 0;
  let negativeSignals = 0;
  const xgRestante = xgTotal - goals;
  if (xgRestante > 1.0) strongSignals++;
  if (sotTotal >= 6) strongSignals++;
  if (bcTotal >= 2) strongSignals++;
  if (woodTotal >= 1) strongSignals++;
  if (attTotal > 0 && attTotal < 100 && sotTotal >= 4) strongSignals++; // ataques moderados con tiros
  // Senales negativas (penalizan)
  if (blockRatio > 0.3) negativeSignals++;
  if (offTarget > 8) negativeSignals++;
  const foulsTotalCount = (s.foulsHome||0)+(s.foulsAway||0);
  if (foulsTotalCount >= 18) negativeSignals++;
  if (goals === 0 && minute >= 70 && bcTotal === 0) negativeSignals++;
  if (minute >= 61 && minute <= 75 && (goals === 0 || (gd === 1 && goals === 1))) negativeSignals++;

  // Cap duro: si hay senales negativas, no pasar de 78%
  if (negativeSignals >= 2 && cappedScore > 78) {
    cappedScore = 78;
    reasons.push('Senales negativas detectadas (' + negativeSignals + ')');
  }

  // Cap duro: si hay menos de 3 senales fuertes, no pasar de 78%
  if (strongSignals < 3 && cappedScore > 78) {
    cappedScore = 78;
    reasons.push('Confluencia insuficiente (' + strongSignals + '/3 senales)');
  }

  // Solo alertar con stats completas (no fallback)
  if (!hasMeaningfulStats(s) && cappedScore > 60) {
    cappedScore = Math.min(cappedScore, 60);
    reasons.push('Stats limitadas - confianza reducida');
  }

  let verdict = cappedScore >= 80 ? 'MUY PROBABLE — casi seguro proximo gol'
    : cappedScore >= 60 ? 'PROBABLE — buenos indicios'
    : cappedScore >= 45 ? 'POSIBLE — atentos'
    : cappedScore >= 30 ? 'DUDOSO — poca actividad'
    : cappedScore >= 15 ? 'POCO PROBABLE'
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

function logAlertVerification(pred, correct) {
  try {
    let log = [];
    if (fs.existsSync(ALERTAS_LOG_FILE)) {
      log = JSON.parse(fs.readFileSync(ALERTAS_LOG_FILE, 'utf8'));
    }
    log.push({
      match: pred.match || (pred.teamHome + ' vs ' + pred.teamAway),
      league: pred.league,
      probability: pred.predictedProbability,
      minute: pred.analysisMinute,
      scoreAtAlert: pred.scoreAtAnalysis ? (pred.scoreAtAnalysis.home + '-' + pred.scoreAtAnalysis.away) : null,
      finalScore: pred.finalScore ? (pred.finalScore.home + '-' + pred.finalScore.away) : null,
      goalAfterAlert: pred.goalAfterAnalysis,
      correct: correct,
      windowType: pred.windowType,
      timestamp: new Date().toISOString(),
      alertTimestamp: pred.timestamp
    });
    // Keep last 500 entries
    if (log.length > 500) log = log.slice(-500);
    fs.writeFileSync(ALERTAS_LOG_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.log('  (no se pudo guardar log de alerta: ' + (e.message || e) + ')');
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

function doSync() {
  if (process.env.NO_SYNC) return;
  const cp = require('child_process');
  try {
    // pull --rebase para auto-resolver divergencias; si falla, abortar rebase
    // para no dejar el repo en estado roto (antes: pull --ff-only fallaba para siempre)
    try {
      cp.execSync('git pull --rebase', { stdio: 'ignore', timeout: 20000 });
    } catch {
      try { cp.execSync('git rebase --abort', { stdio: 'ignore', timeout: 5000 }); } catch {}
    }
  } catch {}
  try {
    cp.execSync('git config user.email "sofastats-bot@users.noreply.github.com"', { stdio: 'ignore', timeout: 5000 });
    cp.execSync('git config user.name "sofastats-bot"', { stdio: 'ignore', timeout: 5000 });
    // Solo agregar archivos que existen (antes: git add de archivo inexistente
    // lanzaba error y el sync completo fallaba silenciosamente en local)
    const files = ['predictions.json', 'weights.json', 'teams.json', 'alertas.json', 'alertas_log.json', 'telegram-offset.txt', 'last-local-run.json']
      .filter(f => fs.existsSync(f));
    if (files.length > 0) {
      cp.execSync('git add ' + files.join(' '), { stdio: 'ignore', timeout: 5000 });
    }
    // Solo commit y push si hay algo que commitear
    const hasChanges = cp.execSync('git status --porcelain', { encoding: 'utf8', timeout: 5000 }).trim();
    if (hasChanges) {
      cp.execSync('git commit -m "sync: datos ronda [skip ci]"', { stdio: 'ignore', timeout: 5000 });
      cp.execSync('git push', { stdio: 'ignore', timeout: 15000 });
      console.log('  Sync: commit + push exitoso');
    } else {
      console.log('  Sync: sin cambios nuevos');
    }
  } catch (e) {
    console.log('  Sync: ' + (e.message || 'error').split('\n')[0]);
  }
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

  // Traer ultimos cambios de la nube
  try { require('child_process').execSync('git pull --ff-only', { stdio: 'ignore', timeout: 15000 }); } catch {}

  console.log('\n' + '='.repeat(64));
  console.log('  ANALISIS — ' + new Date().toISOString());
  console.log('='.repeat(64));

  // Validar horario Colombia (7am-10pm)
  const co = new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' });
  const coHour = new Date(co).getHours();
  if (coHour < 7 || coHour >= 22) {
    console.log('Fuera de horario Colombia (' + coHour + ':00).');
    writeSummary('## Skip ' + new Date().toISOString() + ' - fuera de horario (' + coHour + ':00 Colombia)');
    return;
  }

  // Flashscore enrichment solo cada 4 ciclos (cada ~20 min) — Playwright es caro
  // Cron */5 corre a :00 :05 :10 :15 :20... → :00, :20, :40 → minuto % 20 === 0
  const fsCycle = new Date().getUTCMinutes() % 20 === 0;

    let liveData = [];

    try {
    let weights = loadWeights();
    let predictions = loadPredictions();
    let teams = {};
    try { if (fs.existsSync(TEAMS_FILE)) teams = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8')); } catch {}
    const analyzed = [];

    console.log('[1/3] Obteniendo partidos en vivo desde 365scores...');
    liveData = await scores365.fetchLiveMatches();
    console.log('  -> ' + liveData.length + ' partidos en vivo\n');

    writeSummary('## Analisis 365scores ' + new Date().toISOString() + '\n- Partidos: ' + liveData.length);

    if (liveData.length > 0) {
      console.log('[2/3] Obteniendo stats y analizando ' + liveData.length + ' partidos...\n');

      for (let i = 0; i < liveData.length; i++) {
        const m = liveData[i];
        const displayName = m.homeTeam + ' vs ' + m.awayTeam;
        const league = m.league;
        console.log('  [' + (i + 1) + '/' + liveData.length + '] ' + displayName + (league ? ' (' + league + ')' : ''));

        // Fetch match stats from 365scores
        let rawStats;
        try {
          rawStats = await scores365.fetchMatchStats(m.gameId, m.homeId, m.awayId);
        } catch (e) {
          console.log('     -> Error al obtener stats: ' + (e.message || e) + '\n');
          continue;
        }
        let internalStats;
        let statsAvailable = false;
        if (rawStats) {
          internalStats = scores365.toInternalFormat(rawStats, m);
          statsAvailable = hasMeaningfulStats(internalStats);
        }
        if (!rawStats || !statsAvailable) {
          // NULL_STATS tiene TODAS las claves en null — evita que `undefined !== null`
          // pase como true en analyzeGoal (bug que dejaba entrar NaN a los calculos)
          internalStats = { ...scores365.NULL_STATS, ...(internalStats || {}) };
          console.log('     -> ' + m.minute + "' " + m.scoreHome + '-' + m.scoreAway + ' | Stats no disponibles, usando fallback');
        } else {
          const sotStr = internalStats.sotHome !== null ? internalStats.sotHome + '-' + internalStats.sotAway : '?-?';
          const boxStr = internalStats.shotsInsideBoxHome !== null ? 'Box:' + internalStats.shotsInsideBoxHome + '-' + internalStats.shotsInsideBoxAway : '';
          console.log('     -> ' + m.minute + "' " + m.scoreHome + '-' + m.scoreAway + ' | SOT:' + sotStr + (boxStr ? ' ' + boxStr : ''));
        }

        // Validar datos coherentes
        const totalGoals = (m.scoreHome ?? 0) + (m.scoreAway ?? 0);
        if (m.minute <= 10 && totalGoals >= 3) {
          console.log('  -> Score imposible: ' + m.scoreHome + '-' + m.scoreAway + ' en min ' + m.minute + ', saltando\n');
          continue;
        }
        if (m.minute <= 30 && totalGoals >= 6) {
          console.log('  -> Score imposible: ' + m.scoreHome + '-' + m.scoreAway + ' en min ' + m.minute + ', saltando\n');
          continue;
        }

        analyzed.push({
          rawName: displayName, teamHome: m.homeTeam, teamAway: m.awayTeam,
          league, matchId: String(m.gameId), minute: m.minute || 0,
          scoreHome: m.scoreHome ?? 0, scoreAway: m.scoreAway ?? 0,
          stats: internalStats,
          competitionId: m.competitionId
        });
      }

      // Flashscore: enriquecimiento solo en ciclos cada 20 min para ahorrar Playwright
      // (a) partidos sin stats de 365scores y (b) hasta 8 partidos en ventana de alerta
      const noStats = analyzed.filter(m => !hasMeaningfulStats(m.stats));
      const enrichable = analyzed.filter(m => hasMeaningfulStats(m.stats) && m.minute >= 25 && m.minute <= 70).slice(0, 8);
      const needFlashscore = fsCycle ? [...noStats, ...enrichable.filter(m => !noStats.includes(m))] : [];
      if (needFlashscore.length > 0) {
        console.log('\n  -> ' + needFlashscore.length + ' partidos a enriquecer en Flashscore (' + noStats.length + ' sin stats)...');
        const fsTargets = needFlashscore.map(m => ({ teamHome: m.teamHome, teamAway: m.teamAway, matchId: m.matchId, minute: m.minute }));
        try {
          const fsStats = await fetchStatsBatch(fsTargets);
          let merged = 0;
          for (const match of needFlashscore) {
            const key = match.matchId;
            const fs = fsStats[key];
            if (!fs || !fs.stats || Object.keys(fs.stats).length === 0) continue;
            const s = match.stats;
            // Map Flashscore stat names to internal format.
            // overwrite:true => el dato real de Flashscore REEMPLAZA el estimado de 365scores
            const fsm = {
              'Expected goals (xG)': { h: v => parseFloat(v), a: v => parseFloat(v), k: 'xg', overwrite: true },
              'Expected goals on target (xGOT)': { h: v => parseFloat(v), a: v => parseFloat(v), k: 'xgot', overwrite: true },
              'Expected assists (xA)': { h: v => parseFloat(v), a: v => parseFloat(v), kh: 'xgHomeA', ka: 'xgAwayA', overwrite: true },
              'Touches in opposition box': { h: parseInt, a: parseInt, k: 'touchesOppBox' },
              'Goalkeeper saves': { h: parseInt, a: parseInt, k: 'saves' },
              'Ball possession': { h: v => parseInt(v)/100, a: v => parseInt(v)/100, k: 'possession' },
              'Total shots': { h: parseInt, a: parseInt, k: 'totalShots' },
              'Shots on target': { h: parseInt, a: parseInt, k: 'shotsOnTarget' },
              'Big chances': { h: parseInt, a: parseInt, k: 'bigChances' },
              'Corner kicks': { h: parseInt, a: parseInt, k: 'corners' },
              'Fouls': { h: parseInt, a: parseInt, k: 'fouls' },
              'Yellow cards': { h: parseInt, a: parseInt, k: 'yellowCards' },
              'Red cards': { h: parseInt, a: parseInt, k: 'redCards' },
              'Shots off target': { h: parseInt, a: parseInt, k: 'shotsOffTarget' },
              'Shots inside box': { h: parseInt, a: parseInt, k: 'shotsInsideBox' },
              'Blocked shots': { h: parseInt, a: parseInt, k: 'blockedShots' },
              'Hit woodwork': { h: parseInt, a: parseInt, k: 'hitWoodwork' },
              'Saves': { h: parseInt, a: parseInt, k: 'saves' },
            };
            let anyNew = false;
            for (const [fsName, mapping] of Object.entries(fsm)) {
              if (fs.stats[fsName]) {
                const hVal = mapping.h(fs.stats[fsName].home);
                const aVal = mapping.a(fs.stats[fsName].away);
                if (isNaN(hVal) || isNaN(aVal)) continue;
                // Filtro de outliers: xG/xGOT/xA > 6 son datos corruptos
                if (/xG|xg|xA/.test(mapping.k || mapping.kh) && (hVal > 6 || aVal > 6)) continue;
                const kh = mapping.kh || (mapping.k + 'Home');
                const ka = mapping.ka || (mapping.k + 'Away');
                const existing = s[kh];
                if (mapping.overwrite || existing === null || existing === undefined) {
                  s[kh] = hVal;
                  s[ka] = aVal;
                  anyNew = true;
                }
              }
            }
            if (anyNew) {
              merged++;
              console.log('     -> Stats Flashscore mergeadas para ' + match.teamHome + ' vs ' + match.teamAway);
            }
          }
          console.log('  -> Flashscore: stats mergeadas para ' + merged + '/' + needFlashscore.length + ' partidos');
        } catch (e) {
          console.log('  -> Error Flashscore: ' + (e.message || e));
        }
      }

      // Fetch league context from 365scores
      const uniqueComps = [...new Set(analyzed.map(m => m.competitionId).filter(Boolean))];
      const leagueContextMap = {};
      for (const compId of uniqueComps) {
        try {
          const ctx = await scores365.fetchLeagueContext(compId);
          if (ctx) {
            const leagueName = analyzed.find(m => m.competitionId === compId)?.league || '';
            ctx.name = leagueName;
            leagueContextMap[compId] = ctx;
          }
        } catch (e) {
          console.log('     -> Error contexto liga ' + compId + ': ' + (e.message || e));
        }
      }
      if (Object.keys(leagueContextMap).length > 0) {
        console.log('  -> Contexto 365scores para ' + Object.keys(leagueContextMap).length + ' ligas');
      }

    const ranked = analyzed.map(m => {
      const compCtx = leagueContextMap[m.competitionId];
      const windowType = getWindowType(m.minute);
      const w = getLeagueWeights(weights, m.league, windowType);
      let result;

      if (hasMeaningfulStats(m.stats)) {
        result = analyzeGoal(m, w, teams, compCtx, windowType);
      } else {
        const fallbackScore = getFallbackScore(m.minute, m.scoreHome, m.scoreAway, m.league, m);
        result = {
          score: fallbackScore,
          timeWindow: windowType === 'firstHalf' ? 'Gol en 1T (fallback)' : windowType === 'earlySecondHalf' ? 'Gol 46-70 (fallback)' : 'Gol tarde (fallback)',
          verdict: fallbackScore >= 50 ? 'POSIBLE (stats insuficientes)' : 'DUDOSO (stats insuficientes)',
          whoText: '', reasons: ['Stats no disponibles, score basado en contexto'],
          teamHome: m.teamHome, teamAway: m.teamAway, league: m.league, matchId: m.matchId,
          minute: m.minute, scoreHome: m.scoreHome, scoreAway: m.scoreAway,
          stats: m.stats, predictedScorer: null, pressure: 0,
        };
      }

      // Save base score (pre-window) for training
      const baseScore = Math.min(100, Math.max(0, result.score));

      // Window classification (solo etiqueta, no modifica el score)
      if (windowType === 'firstHalf') {
        result.timeWindow = 'GOL 1T';
      } else if (windowType === 'earlySecondHalf') {
        result.timeWindow = 'GOL 46-70';
      } else {
        result.timeWindow = 'GOL TARDE';
      }

      result.score = baseScore;
      result.windowType = windowType;
      result.windowOdds = WINDOW_ODDS[windowType];
      result.ev = (baseScore / 100) * result.windowOdds - 1;
      result.competitionId = m.competitionId;

      return result;
    }).sort((a, b) => b.score - a.score);

    const now = new Date().toISOString();
    let newCount = 0;
    for (const r of ranked) {
      const existing = predictions.find(p => p.id === r.matchId && p.predictionCorrect === null);
      if (existing) {
        // Validar consistencia: el marcador no puede retroceder (goles no se borran)
        const prevGoals = (existing.lastSeenScore?.home || 0) + (existing.lastSeenScore?.away || 0);
        const newGoals = (r.scoreHome || 0) + (r.scoreAway || 0);
        const prevMin = existing.lastSeenMinute || 0;
        const newMin = r.minute || 0;
        // Si el minuto avanza pero el marcador retrocede, datos corruptos - no actualizar
        if (newMin > prevMin && newGoals < prevGoals) {
          console.log('  [SKIP] ' + r.match + ' - marcador inconsistente (prev=' + existing.lastSeenScore?.home + '-' + existing.lastSeenScore?.away + ' new=' + r.scoreHome + '-' + r.scoreAway + ')');
          continue;
        }
        // Si el minuto retrocede, datos stale - no actualizar
        if (newMin < prevMin - 2) {
          console.log('  [SKIP] ' + r.match + ' - minuto retrocede (prev=' + prevMin + ' new=' + newMin + ')');
          continue;
        }
        existing.lastSeenMinute = r.minute;
        existing.lastSeenScore = { home: r.scoreHome, away: r.scoreAway };
        const compScore = existing.predictedProbability;
        const diff = Math.abs(r.score - compScore);
        if (diff > 20 || (r.score >= 80) !== (compScore >= 80)) {
          existing.predictedProbability = r.score;
          existing.windowType = r.windowType;
          existing.predictedScorer = r.predictedScorer;
          existing.predictedTimeWindow = r.timeWindow;
          existing.stats = r.stats;
          existing.scoreAtAnalysis = { home: r.scoreHome, away: r.scoreAway };
          existing.analysisMinute = r.minute;
        }
      } else {
        // Solo guardar predicciones con potencial de alerta o stats completas
        const hasStats = r.stats && (hasMeaningfulStats(r.stats) || Object.keys(r.stats).filter(k => r.stats[k] !== null).length >= 15);
        const isAlertCandidate = r.score >= 60;
        if (hasStats || isAlertCandidate) {
          predictions.push({
            id: r.matchId, match: r.teamHome + ' vs ' + r.teamAway, league: r.league,
            teamHome: r.teamHome, teamAway: r.teamAway, timestamp: now,
            analysisMinute: r.minute, scoreAtAnalysis: { home: r.scoreHome, away: r.scoreAway }, stats: r.stats,
            predictedProbability: r.score, predictedScorer: r.predictedScorer, predictedTimeWindow: r.timeWindow,
            windowType: r.windowType,
            finalScore: null, goalAfterAnalysis: null, actualGoalMinute: null, actualScorer: null, predictionCorrect: null,
            lastSeenMinute: r.minute, lastSeenScore: { home: r.scoreHome, away: r.scoreAway }
          });
          newCount++;
        }
      }
    }
    savePredictions(predictions);
    weights.stats.createdCount = (weights.stats.createdCount || 0) + newCount;
    saveWeights(weights);
    console.log('  -> ' + newCount + ' predicciones nuevas\n');

    // Actualizar lastSeen de predicciones existentes con datos actuales
    // BUG FIX: liveData tiene gameId (no url) — antes nunca encontraba el partido
    // y lastSeenMinute jamas se actualizaba
    for (const pred of predictions) {
      if (pred.predictionCorrect !== null) continue;
      const lm = liveData.find(m => String(m.gameId) === String(pred.id));
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
        const xgS = r.stats.xgHome != null ? r.stats.xgHome.toFixed(2) + '-' + r.stats.xgAway.toFixed(2) : '?-?';
        const sotS = r.stats.sotHome != null ? r.stats.sotHome + '-' + r.stats.sotAway : '?-?';
        const bcS = r.stats.bigChancesHome != null ? r.stats.bigChancesHome + '-' + r.stats.bigChancesAway : '?-?';
        const boxS = r.stats.shotsInsideBoxHome != null ? r.stats.shotsInsideBoxHome + '-' + r.stats.shotsInsideBoxAway : '?-?';
        const woodS = r.stats.hitWoodworkHome != null ? r.stats.hitWoodworkHome + '-' + r.stats.hitWoodworkAway : '';
        const xgotS = r.stats.xgotHome != null ? r.stats.xgotHome.toFixed(2) + '-' + r.stats.xgotAway.toFixed(2) : '';
        const xaS = r.stats.xgHomeA != null ? 'xA:' + r.stats.xgHomeA.toFixed(2) + '-' + r.stats.xgAwayA.toFixed(2) : '';
        const touchesS = r.stats.touchesOppBoxHome != null ? 'Touches:' + r.stats.touchesOppBoxHome + '-' + r.stats.touchesOppBoxAway : '';
        const posS = r.stats.possessionHome != null ? Math.round(r.stats.possessionHome * 100) + '%-' + Math.round(r.stats.possessionAway * 100) + '%' : '?-?';
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

    // --- Fetch real xG from Flashscore for top matches (solo ciclos cada 20 min) ---
    const topForXg = fsCycle ? ranked.filter(r => r.score >= 50 && r.stats.xgHome !== null && r.stats.xgAway !== null).slice(0, 5) : [];
    if (topForXg.length > 0) {
      console.log('\n--- Buscando xG real en Flashscore para ' + topForXg.length + ' partidos ---');
      const { fetchXgBatch } = require('./flashscore_fetcher');
      const targets = topForXg.map(r => ({ teamHome: r.teamHome, teamAway: r.teamAway }));
      let xgResults = {};
      let xgFound = 0;
      try {
        xgResults = await fetchXgBatch(targets);
      } catch (e) {
        console.log('  -> Error xG Flashscore: ' + (e.message || e));
      }
      for (const r of ranked) {
        const key = r.teamHome + ' vs ' + r.teamAway;
        const xg = xgResults[key];
        if (xg && xg.home !== null && xg.away !== null) {
          // Filter outliers: Flashscore a veces devuelve xG > 5.0 (datos corruptos)
          if (xg.home > 5.0 || xg.away > 5.0) {
            console.log('  * xG outlier ignorado: ' + r.teamHome + ' vs ' + r.teamAway + ' = ' + xg.home + '-' + xg.away);
            continue;
          }
          const prevXgH = r.stats.xgHome;
          const prevXgA = r.stats.xgAway;
          if (Math.abs(xg.home - prevXgH) > 0.1 || Math.abs(xg.away - prevXgA) > 0.1) {
            xgFound++;
            r.stats.xgHome = xg.home;
            r.stats.xgAway = xg.away;
            console.log('  * xG actualizado: ' + r.teamHome + ' vs ' + r.teamAway + ' | estimado: ' + prevXgH.toFixed(2) + '-' + prevXgA.toFixed(2) + ' -> real: ' + xg.home.toFixed(2) + '-' + xg.away.toFixed(2));
          }
        }
      }
      if (xgFound > 0) {
        // BUG FIX: el re-analisis pasaba leagueContext=null, perdiendo la normalizacion
        // por liga y haciendo el score inconsistente con el analisis original
        ranked.forEach(r => {
          const wt = getWindowType(r.minute);
          const updated = analyzeGoal(r, getLeagueWeights(weights, r.league, wt), teams, leagueContextMap[r.competitionId] || null, wt);
          r.score = updated.score; r.verdict = updated.verdict; r.timeWindow = updated.timeWindow; r.reasons = updated.reasons;
        });
        ranked.sort((a, b) => b.score - a.score);
      }
      console.log('  xG real obtenido para ' + xgFound + ' partidos\n');
    }

    // --- Telegram alert (probabilidad > 80%, top 5) - UMBRAL SUBIDO A 80% ---
    const topByScore = ranked.filter(r => r.score >= 80);
    if (topByScore.length > 0) {
      if (!process.env.CI) {
        // Local: no mandar Telegram, ya ves la terminal
      } else if (!alertsEnabled()) {
        console.log('\nAlertas desactivadas (alertas.json). Analisis sigue corriendo.');
        writeSummary('- Alerta: Desactivada por usuario');
      } else {
        // Dedup: deducir partidos ya alertados en misma ventana
        const filtered = [];
        for (const r of topByScore) {
          // Validacion de frescura: si el minuto del partido no avanzo en los ultimos 10 min, skip (datos stale)
          const predEntry = predictions.find(p => p.id === r.matchId);
          if (predEntry) {
            const realMinSinceAnalysis = (Date.now() - new Date(predEntry.timestamp).getTime()) / 60000;
            const minuteAdvance = (r.minute || 0) - (predEntry.analysisMinute || 0);
            // Si pasaron mas de 10 min reales y el minuto del partido no avanza, datos stale
            if (realMinSinceAnalysis > 10 && minuteAdvance < 2) {
              console.log('\n  [SKIP] ' + r.match + ' - datos stale (min=' + r.minute + ', sin avance en ' + realMinSinceAnalysis.toFixed(0) + ' min reales)');
              continue;
            }
          }
          const key = r.matchId + '_' + r.windowType;
          const lastAlert = weights.alertedMatches?.[key];
          let skip = false;
          if (lastAlert) {
            const realMin = (Date.now() - lastAlert.timestamp) / 60000;
            const gameMinAdvance = (r.minute || 0) - (lastAlert.minute || 0);
            // Dedup mas estricto: no reenviar si menos de 45 min reales O menos de 25 min de partido
            if (realMin < 45 && gameMinAdvance < 25) skip = true;
          }
          if (!skip) filtered.push(r);
          if (filtered.length >= 5) break;
        }

        if (filtered.length === 0) {
          console.log('\nAlertas: todos los partidos ya alertados (dedup)');
          writeSummary('- Alerta: Todos dedup');
        } else {
          const msg = notify.buildMessage(filtered);
          if (msg) {
            console.log('\nEnviando alerta Telegram con ' + filtered.length + ' partidos (prob>80%)...');
            await notify.sendTelegram(msg);
            weights.alertedMatches = weights.alertedMatches || {};
            for (const r of filtered) {
              const key = r.matchId + '_' + r.windowType;
              weights.alertedMatches[key] = { timestamp: Date.now(), minute: r.minute || 0 };
            }
            // Limpiar entradas viejas (> 2h)
            const cutoff = Date.now() - 2 * 60 * 60 * 1000;
            for (const [k, v] of Object.entries(weights.alertedMatches)) {
              if (v.timestamp < cutoff) delete weights.alertedMatches[k];
            }
            saveWeights(weights);
            writeSummary('- Alerta: ENVIADA (' + filtered.length + ' partidos)');
          }
        }
      }
    } else if (ranked.length > 0) {
      console.log('\nMejor probabilidad: ' + ranked[0].score + '% (umbral: 80%)');
      writeSummary('- Alerta: No enviada (mejor prob=' + ranked[0].score + '%)');
    }
  } else {
    console.log('  Sin partidos en vivo.');
  }

  // --- APRENDIZAJE: verificar predicciones anteriores contra datos actuales ---
  console.log('\n[3/3] Aprendiendo de predicciones anteriores...');
  let learningResult = { weights: null, adjustments: 0, insights: [] };
  try {
    learningResult = await runLearning(liveData);
  } catch (e) {
    console.log('  Error en aprendizaje: ' + (e.message || e));
  }
  weights = learningResult.weights || weights;
  if (learningResult.adjustments > 0) {
    console.log('  Pesos ajustados. Se usaran en el proximo analisis.');
  }
  writeSummary('- Aprendizaje: ' + learningResult.insights.length + ' fallos analizados');

  // --- VERIFICAR PARTIDOS TERMINADOS ---
  // Recargar predictions por si learn.js las modificó
  predictions = loadPredictions();
  const pendingVerify = predictions.filter(p => {
    if (p.predictionCorrect !== null) return false;
    // BUG FIX: excluir partidos AUN EN VIVO (antes usaba m.url que no existe)
    if (liveData.find(m => String(m.gameId) === String(p.id))) return false;
    if (p.analysisMinute && p.analysisMinute >= 10) return true;
    // Si analysisMinute < 10 pero pasaron > 30 min reales, verificar igual
    if (p.timestamp) {
      const elapsed = (Date.now() - new Date(p.timestamp).getTime()) / 60000;
      return elapsed >= 30;
    }
    return false;
  });
  if (pendingVerify.length > 0) {
    console.log('\n[4/4] Verificando ' + pendingVerify.length + ' partidos terminados (365scores)...');
    let verifiedCount = 0;
    const newlyVerified = [];
    const teamsData = loadTeams();
    const currentWeights = loadWeights();
    for (const pred of pendingVerify) {
      const gameId = parseInt(pred.id);
      if (isNaN(gameId)) {
        console.log('  ? ' + pred.match + ' | ID invalido: ' + pred.id);
        continue;
      }
      let score;
      try {
        score = await scores365.verifyFinishedMatch(gameId);
      } catch (e) {
        console.log('  ? ' + pred.match + ' | error al verificar: ' + (e.message || e));
        continue;
      }
      if (score) {
        const scoreChanged = score.home !== (pred.scoreAtAnalysis?.home ?? 0) || score.away !== (pred.scoreAtAnalysis?.away ?? 0);
        pred.finalScore = score;
        pred.goalAfterAnalysis = scoreChanged;
        // Determine who scored (actual scorer for training)
        if (scoreChanged) {
          const prevHome = pred.scoreAtAnalysis?.home ?? 0;
          const prevAway = pred.scoreAtAnalysis?.away ?? 0;
          if (score.home > prevHome && score.away > prevAway) {
            pred.actualScorer = null; // ambos
          } else if (score.home > prevHome) {
            pred.actualScorer = 'home';
          } else if (score.away > prevAway) {
            pred.actualScorer = 'away';
          } else {
            pred.actualScorer = null;
          }
          // Use lastSeenMinute as rough goal minute if available
          if (pred.lastSeenMinute && pred.lastSeenMinute > (pred.analysisMinute || 0)) {
            pred.actualGoalMinute = pred.lastSeenMinute;
          } else {
            pred.actualGoalMinute = null;
          }
        } else {
          pred.actualScorer = null;
          pred.actualGoalMinute = null;
        }
        const prob = (pred.predictedProbability || 0) / 100;
        const predictedGoal = prob >= 0.7;
        pred.predictionCorrect = (predictedGoal && scoreChanged) || (!predictedGoal && !scoreChanged);
        // Update stats counters (verifiedCount = verificadas, correctScore = acertadas)
        if (pred.predictionCorrect !== null) {
          currentWeights.stats.verifiedCount = (currentWeights.stats.verifiedCount || 0) + 1;
          if (pred.predictionCorrect) currentWeights.stats.correctScore = (currentWeights.stats.correctScore || 0) + 1;
        }
        const icon = pred.predictionCorrect ? '\u2713' : '\u2717';
        console.log('  ' + icon + ' ' + pred.match + ' | final ' + score.home + '-' + score.away + ' | pred=' + pred.predictedProbability + '%');
        // Log alerta verificada si fue alerta (>=80%)
        if ((pred.predictedProbability || 0) >= 80) {
          logAlertVerification(pred, pred.predictionCorrect);
        }
        // Analisis de fallos en predicciones >=70%
        if (!pred.predictionCorrect && pred.predictedProbability >= 70) {
          const dif = Math.abs((score.home - (pred.scoreAtAnalysis?.home ?? 0)) + (score.away - (pred.scoreAtAnalysis?.away ?? 0)));
          const min = pred.analysisMinute || 0;
          const estXg = (pred.stats?.xgHome ?? 0) + (pred.stats?.xgAway ?? 0);
          const sot = (pred.stats?.sotHome ?? 0) + (pred.stats?.sotAway ?? 0);
          const reasons = [];
          if (min >= 75 && score.home !== undefined && score.away !== undefined) {
            const gd = Math.abs(score.home - score.away);
            if (gd >= 3) reasons.push('goleada ' + score.home + '-' + score.away + ', ritmo bajo');
            if (score.home + score.away === 0 && estXg > 0) reasons.push('0-0 estancado pese a xG=' + estXg.toFixed(2));
          }
          if (estXg < 1) reasons.push('bajo xG=' + estXg.toFixed(2));
          if (sot === 0) reasons.push('sin tiros a puerta');
          if (reasons.length > 0) console.log('     fallo: ' + reasons.join(' | '));
        }
        verifiedCount++;
        newlyVerified.push(pred);
        if (teamsData) updateTeamStats(teamsData, pred, { scoreHome: score.home, scoreAway: score.away });
      } else {
        console.log('  ? ' + pred.match + ' | aun no finalizado o no encontrado en 365scores');
      }
    }
    if (verifiedCount > 0) {
      const adj = adjustWeights(currentWeights, newlyVerified, []);
      if (adj > 0) {
        saveWeights(currentWeights);
        if (teamsData) saveTeams(teamsData);
        console.log('  Pesos ajustados: ' + adj + ' cambios');
      }
      savePredictions(predictions);
    }
    console.log('  Verificados: ' + verifiedCount);
  }

  } catch (e) {
    console.log('\n!!! Error: ' + (e.message || e));
    writeSummary('- Error: ' + (e.message || e).substring(0, 200));
  }

  doSync();

  // Guardar timestamp local DESPUES del sync
  if (!process.env.CI && !module.parent) {
    fs.writeFileSync('last-local-run.json', JSON.stringify({ lastRun: new Date().toISOString() }));
  }
}

module.exports = { analyzeGoal, getLeagueWeights, getWindowType };

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err.message, '\n' + err.stack);
    process.exit(1);
  });
}
