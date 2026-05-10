/**
 * learn.js — Sistema de auto-aprendizaje.
 *
 * 1. Toma predicciones anteriores y las verifica contra partidos en vivo actuales
 * 2. Detecta aciertos/fallos comparando score actual vs score al momento del análisis
 * 3. Para cada fallo, genera un análisis explicando qué salió mal
 * 4. Ajusta los pesos dinámicamente para mejorar predicciones futuras
 */

const fs = require('fs');
const path = require('path');

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
  try { if (fs.existsSync(WEIGHTS_FILE)) return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8')); } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_WEIGHTS));
}
function saveWeights(w) { w.lastUpdated = new Date().toISOString(); fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2)); }
function loadPredictions() {
  try { if (fs.existsSync(PREDICTIONS_FILE)) return JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8')); } catch {}
  return [];
}
function savePredictions(p) { fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(p, null, 2)); }

function isFlashscoreId(id) {
  return typeof id === 'string' && id.startsWith('https://www.flashscore.com/');
}

function teamsMatch(predHome, predAway, liveHome, liveAway) {
  if (!predHome || !predAway || !liveHome || !liveAway) return false;
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ph = normalize(predHome), pa = normalize(predAway);
  const lh = normalize(liveHome), la = normalize(liveAway);
  // Both teams must match (home-home and away-away OR swapped)
  const match1 = (ph.includes(lh) || lh.includes(ph)) && (pa.includes(la) || la.includes(pa));
  const match2 = (ph.includes(la) || la.includes(ph)) && (pa.includes(lh) || lh.includes(pa));
  return match1 || match2;
}

/**
 * Verifica predicciones contra partidos en vivo actuales.
 * Retorna { verified: [...], insights: [...] }
 */
function verifyPredictions(predictions, liveMatches) {
  const verified = [];
  const insights = [];

  for (const pred of predictions) {
    if (pred.predictionCorrect !== null) continue;
    if (pred.finalScore !== null) continue;
    // Solo verificar predicciones de Flashscore (no las viejas de Sofascore)
    if (!isFlashscoreId(pred.id)) continue;
    // Solo verificar si pasaron al menos 10 min desde el analisis
    if (!pred.analysisMinute || pred.analysisMinute < 10) continue;

    const liveMatch = liveMatches.find(m =>
      teamsMatch(pred.teamHome, pred.teamAway, m.homeTeam, m.awayTeam)
    );

    if (!liveMatch) continue; // no está en vivo ahora, no podemos verificar

    const minutesElapsed = (liveMatch.minute || 0) - (pred.analysisMinute || 0);
    const scoreChanged =
      (liveMatch.scoreHome !== null && liveMatch.scoreAway !== null) &&
      (liveMatch.scoreHome !== (pred.scoreAtAnalysis?.home ?? liveMatch.scoreHome) ||
       liveMatch.scoreAway !== (pred.scoreAtAnalysis?.away ?? liveMatch.scoreAway));

    if (!scoreChanged && minutesElapsed < 10) continue; // muy pronto para evaluar

    // Determinar si la predicción fue correcta
    const goalHappened = scoreChanged;
    const prob = (pred.predictedProbability || 0) / 100;
    const predictedGoal = prob >= 0.7;
    const correct = (predictedGoal && goalHappened) || (!predictedGoal && !goalHappened);

    pred.finalScore = { home: liveMatch.scoreHome ?? 0, away: liveMatch.scoreAway ?? 0 };
    pred.goalAfterAnalysis = goalHappened;
    pred.predictionCorrect = correct;

    // Generar insight detallado si fue un error
    if (!correct && predictedGoal) {
      const s = pred.stats || {};
      const topFeatures = [];
      if (s.xgHome !== null && s.xgAway !== null) topFeatures.push({ name: 'xG', home: s.xgHome, away: s.xgAway, weight: 'xg' });
      if (s.sotHome !== null && s.sotAway !== null) topFeatures.push({ name: 'Shots on target', home: s.sotHome, away: s.sotAway, weight: 'shotsOnTarget' });
      if (s.totalShotsHome !== null && s.totalShotsAway !== null) topFeatures.push({ name: 'Total shots', home: s.totalShotsHome, away: s.totalShotsAway, weight: 'totalShots' });
      if (s.bigChancesHome !== null && s.bigChancesAway !== null) topFeatures.push({ name: 'Big chances', home: s.bigChancesHome, away: s.bigChancesAway, weight: 'bigChances' });
      if (s.cornersHome !== null && s.cornersAway !== null) topFeatures.push({ name: 'Corners', home: s.cornersHome, away: s.cornersAway, weight: 'corners' });
      if (s.possessionHome !== null && s.possessionAway !== null) topFeatures.push({ name: 'Possession', home: (s.possessionHome * 100).toFixed(0) + '%', away: (s.possessionAway * 100).toFixed(0) + '%', weight: 'possession' });

      let analysis = 'FALLO: Se predijo gol (≥70%) pero no ocurrió. ';
      if (s.bigChancesHome === 0 && s.bigChancesAway === 0 && (s.xgHome || 0) + (s.xgAway || 0) < 1) {
        analysis += 'El xG era bajo y no hubo ocasiones claras — el modelo sobrestimó tiros lejanos. ';
      } else if (s.shotsInsideBoxHome === 0 && s.shotsInsideBoxAway === 0 && (s.totalShotsHome || 0) + (s.totalShotsAway || 0) > 15) {
        analysis += 'Muchos tiros pero todos desde fuera del área — baja calidad de oportunidades. ';
      } else if ((s.savesHome || 0) + (s.savesAway || 0) > 8) {
        analysis += 'Porteros destacaron a pesar de la presión ofensiva. ';
      } else if (pred.analysisMinute >= 75 && !goalHappened) {
        analysis += 'Partido en fase final pero los equipos se conformaron con el resultado. ';
      } else if ((s.possessionHome || 0) > 0.6 || (s.possessionAway || 0) > 0.6) {
        analysis += 'Dominio de posesión pero sin profundidad ni remates de peligro. ';
      } else {
        analysis += 'Las estadísticas sugerían actividad pero los equipos no concretaron. ';
      }

      insights.push({
        match: pred.match || (pred.teamHome + ' vs ' + pred.teamAway),
        predicted: (pred.predictedProbability || 0) + '%',
        analysis,
        features: topFeatures,
        weightsToAdjust: topFeatures.map(f => f.weight)
      });
    }

    if (!correct && !predictedGoal && goalHappened) {
      const s = pred.stats || {};
      let analysis = 'FALLO: No se predijo gol pero sí ocurrió. ';
      if ((s.xgHome || 0) + (s.xgAway || 0) < 0.5) {
        analysis += 'xG muy bajo — el gol fue una jugada aislada o error defensivo. ';
      } else {
        analysis += 'El modelo fue conservador a pesar de indicios ofensivos. ';
      }
      insights.push({
        match: pred.match || (pred.teamHome + ' vs ' + pred.teamAway),
        predicted: (pred.predictedProbability || 0) + '%',
        analysis,
        features: [],
        weightsToAdjust: ['xg', 'shotsOnTarget', 'bigChances']
      });
    }

    verified.push(pred);
  }

  return { verified, insights };
}

/**
 * Ajusta los pesos basado en aciertos/fallos verificados.
 */
function adjustWeights(weights, verified) {
  const lr = weights.learningRate;
  let adjustments = 0;

  for (const pred of verified) {
    if (pred.predictionCorrect === null) continue;

    const prob = (pred.predictedProbability || 0) / 100;
    const goalHappened = pred.goalAfterAnalysis || false;
    const error = (goalHappened ? 1 : 0) - prob;

    if (Math.abs(error) < 0.15) continue; // error pequeño, no ajustar

    const w = weights.global;
    const keys = ['xg', 'shotsOnTarget', 'bigChances', 'totalShots', 'scoreNeeds', 'timePressure', 'corners', 'possession', 'saves', 'goalsScored'];

    // Si sobrestimamos (error negativo): reducir pesos
    // Si subestimamos (error positivo): aumentar pesos
    const direction = error > 0 ? 1 : -1;
    const adjust = lr * direction;

    for (const key of keys) {
      if (key === 'goalsScored') {
        const newVal = Math.max(-20, Math.min(0, w[key] * (1 + adjust)));
        if (Math.abs(newVal - w[key]) > 0.3) { w[key] = Math.round(newVal * 10) / 10; adjustments++; }
      } else {
        const newVal = Math.max(1, Math.min(60, w[key] * (1 + adjust)));
        if (Math.abs(newVal - w[key]) > 0.3) { w[key] = Math.round(newVal * 10) / 10; adjustments++; }
      }
    }

    // Actualizar stats
    if (goalHappened && prob >= 0.4) weights.stats.correctScore++;
    if (!goalHappened && prob < 0.4) weights.stats.correctScore++;
  }

  return adjustments;
}

/**
 * Imprime un reporte completo de aprendizaje.
 */
function printLearningReport(weights, predictions, insights) {
  const total = predictions.length;
  const verified = predictions.filter(p => p.predictionCorrect !== null || p.finalScore !== null);
  const correct = verified.filter(p => p.predictionCorrect === true || (p.finalScore && p.finalScore.home !== null && p.predictionCorrect === null && p.goalAfterAnalysis !== null));

  // Calcular precisión
  let correctCount = 0;
  let totalVerified = 0;
  for (const p of verified) {
    if (p.predictionCorrect === true) correctCount++;
    if (p.predictionCorrect === false) totalVerified++;
    if (p.predictionCorrect === true) totalVerified++;
  }
  const accuracy = totalVerified > 0 ? (correctCount / totalVerified * 100).toFixed(1) : '-';

  console.log('');
  console.log('='.repeat(58));
  console.log('  APRENDIZAJE — REPORTE');
  console.log('='.repeat(58));
  console.log('  Predicciones totales: ' + total);
  console.log('  Verificadas:          ' + totalVerified);
  console.log('  Precisi\u00f3n:             ' + accuracy + '%');
  console.log('  Aciertos:             ' + correctCount);
  console.log('  Fallos:               ' + (totalVerified - correctCount));

  // Insights de fallos
  if (insights.length > 0) {
    console.log('\n  --- AN\u00c1LISIS DE FALLOS ---');
    for (const ins of insights) {
      console.log('\n  Partido: ' + ins.match);
      console.log('  Predicci\u00f3n: ' + ins.predicted);
      console.log('  ' + ins.analysis);
      if (ins.features.length > 0) {
        const featStr = ins.features.map(f => f.name + '=' + f.home + '/' + f.away).join(', ');
        console.log('  Estad\u00edsticas: ' + featStr);
      }
    }
  }

  // Pesos actuales
  console.log('\n  --- PESOS ACTUALES ---');
  const sorted = Object.entries(weights.global).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    const arrow = k === 'goalsScored' ? '' : '\u2588'.repeat(Math.round(v / 3)) + ' '.repeat(20 - Math.round(v / 3));
    console.log('  ' + k.padEnd(16) + v.toString().padStart(5) + '  ' + arrow);
  }

  const adjCount = Object.keys(weights.byLeague).length;
  if (adjCount > 0) console.log('  Ligas con pesos personalizados: ' + adjCount);
  console.log('');
}

async function runLearning(liveMatches) {
  const weights = loadWeights();
  const predictions = loadPredictions();

  if (predictions.length === 0) {
    console.log('  Aprendizaje: sin predicciones previas');
    return { weights, adjustments: 0, insights: [] };
  }

  console.log('  Verificando ' + predictions.length + ' predicciones previas...');

  const { verified, insights } = verifyPredictions(predictions, liveMatches);
  console.log('  Verificadas ahora: ' + verified.length + ' (' + insights.length + ' fallos)');

  if (verified.length > 0) {
    const adjustments = adjustWeights(weights, verified);
    saveWeights(weights);
    savePredictions(predictions);
    console.log('  Pesos ajustados: ' + adjustments + ' cambios');

    printLearningReport(weights, predictions, insights);
    return { weights, adjustments, insights };
  }

  return { weights, adjustments: 0, insights: [] };
}

module.exports = { runLearning, loadWeights, loadPredictions };
