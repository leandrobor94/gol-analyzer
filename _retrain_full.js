// Re-aprendizaje completo con TODAS las predicciones verificadas
const fs = require('fs');
const path = require('path');
const learn = require('./learn');

const WEIGHTS_FILE = path.join(__dirname, 'weights.json');

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

// Reset weights a valores por defecto
fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)), null, 2));
const weights = learn.loadWeights();
const predictions = learn.loadPredictions();

const verified = predictions.filter(p => p.predictionCorrect !== null);
console.log('Predicciones: ' + predictions.length + ' | Verificadas: ' + verified.length);

// Ajustar pesos con TODAS las verificadas
const adjustments = learn.adjustWeights(weights, verified, []);
learn.saveWeights(weights);
console.log('Pesos ajustados: ' + adjustments + ' cambios');

// Mostrar pesos finales
const sorted = Object.entries(weights.global).sort((a, b) => b[1] - a[1]);
console.log('\nPesos finales:');
sorted.forEach(([k, v]) => {
  if (k === 'goalsScored' || k === 'teamFactor' || k === 'leagueFactor') return;
  console.log('  ' + k.padEnd(18) + v.toString().padStart(5));
});

// Resumen
let correctCount = 0, totalVerified = 0, above70 = 0, correctAbove70 = 0;
for (const p of predictions) {
  if (p.predictionCorrect === true) { correctCount++; totalVerified++; }
  else if (p.predictionCorrect === false) totalVerified++;
  if ((p.predictedProbability || 0) >= 70) {
    above70++;
    if (p.predictionCorrect === true) correctAbove70++;
  }
}
console.log('\nResumen: ' + predictions.length + ' total | ' + totalVerified + ' verificadas | ' + correctCount + ' correctas (' + (totalVerified > 0 ? (correctCount/totalVerified*100).toFixed(1) : '-') + '%)');
console.log('>=70%: ' + above70 + ' | Correctas >=70%: ' + correctAbove70 + ' (' + (above70 > 0 ? (correctAbove70/above70*100).toFixed(1) : '-') + '%)');
