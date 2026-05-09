/**
 * learn.js — Sistema de auto-aprendizaje para el predictor de goles.
 *
 * ¿Qué hace?
 * 1. Carga todas las predicciones guardadas (predictions.json)
 * 2. Para cada partido que NO tiene resultado final, revisa en SofaScore
 *    si ya terminó y cuál fue el resultado
 * 3. Compara lo que predijimos con lo que realmente pasó
 * 4. Ajusta los pesos (weights.json) según la precisión histórica
 *
 * ¿Cómo se usa?
 *   node learn.js
 *
 * Se puede programar para correr automáticamente después de cada jornada.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const WEIGHTS_FILE = path.join(__dirname, 'weights.json');

const DEFAULT_WEIGHTS = {
  version: 1,
  learningRate: 0.05,
  global: {
    xg: 30, shotsOnTarget: 25, bigChances: 15, totalShots: 10,
    scoreNeeds: 10, timePressure: 8, corners: 5, possession: 5,
    saves: 5, goalsScored: -10
  },
  byLeague: {},
  stats: { predictionsCount: 0, correctScore: 0, correctScorer: 0 }
};

function loadWeights() {
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
    }
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_WEIGHTS));
}

function saveWeights(w) {
  w.lastUpdated = new Date().toISOString();
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(w, null, 2));
}

function loadPredictions() {
  try {
    if (fs.existsSync(PREDICTIONS_FILE)) {
      return JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function savePredictions(p) {
  fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(p, null, 2));
}

// ─── Determina si un resultado "acertó" ───
function evaluatePrediction(pred, finalHome, finalAway) {
  // ¿Hubo gol después de nuestro análisis?
  const goalsBefore = pred.scoreAtAnalysis.home + pred.scoreAtAnalysis.away;
  const goalsAfter = (finalHome + finalAway) - goalsBefore;
  const goalHappened = goalsAfter > 0;

  // ¿Acertamos quién metió el próximo gol?
  let scorerCorrect = null;
  if (goalHappened && pred.predictedScorer) {
    const homeScoredAfter = finalHome - pred.scoreAtAnalysis.home;
    const awayScoredAfter = finalAway - pred.scoreAtAnalysis.away;
    if (homeScoredAfter > 0 && pred.predictedScorer === 'home') scorerCorrect = true;
    else if (awayScoredAfter > 0 && pred.predictedScorer === 'away') scorerCorrect = true;
    else scorerCorrect = false;
  }

  return { goalHappened, scorerCorrect, goalsAfter };
}

// ─── Ajusta los pesos según acierto/fallo ───
function adjustWeights(weights, predictions, stats) {
  const lr = weights.learningRate;
  let adjusted = 0;

  for (const pred of predictions) {
    if (pred.finalScore === null) continue;
    
    const { goalHappened, scorerCorrect, goalsAfter } = evaluatePrediction(
      pred, pred.finalScore.home, pred.finalScore.away
    );

    const prob = pred.predictedProbability / 100;
    const actual = goalHappened ? 1 : 0;
    const error = actual - prob;

    // Solo ajustamos si el error es significativo (> 20%)
    if (Math.abs(error) < 0.2) continue;

    const w = weights.global;
    const keys = ['xg', 'shotsOnTarget', 'bigChances', 'totalShots', 'scoreNeeds',
                  'timePressure', 'corners', 'possession', 'saves', 'goalsScored'];

    // Si acertamos: reforzar los pesos que contribuyeron
    // Si fallamos: reducir los pesos que contribuyeron
    const direction = error > 0 ? 1 : -1; // positivo = subest. gol, negativo = sobrest.
    const adjust = lr * direction;

    for (const key of keys) {
      const oldVal = w[key];
      let newVal = oldVal * (1 + adjust);

      // Límites razonables
      if (key === 'goalsScored') {
        newVal = Math.max(-20, Math.min(0, newVal));
      } else {
        newVal = Math.max(1, Math.min(60, newVal));
      }

      if (Math.abs(newVal - oldVal) > 0.5) {
        w[key] = Math.round(newVal * 10) / 10;
        adjusted++;
      }
    }

    // También ajustar por liga si tenemos suficientes datos
    if (pred.league && pred.league !== 'Desconocida') {
      if (!weights.byLeague[pred.league]) {
        weights.byLeague[pred.league] = {};
      }
      const lw = weights.byLeague[pred.league];
      for (const key of keys) {
        const baseVal = w[key];
        const currentVal = lw[key] !== undefined ? lw[key] : baseVal;
        let newVal = currentVal * (1 + adjust * 0.5); // ajuste más conservador por liga
        if (key === 'goalsScored') newVal = Math.max(-20, Math.min(0, newVal));
        else newVal = Math.max(1, Math.min(60, newVal));
        if (Math.abs(newVal - currentVal) > 0.5) {
          lw[key] = Math.round(newVal * 10) / 10;
        }
      }
    }

    // Actualizar stats
    if (goalHappened && prob >= 0.4) stats.correctScore++;
    if (!goalHappened && prob < 0.4) stats.correctScore++;
    if (scorerCorrect === true) stats.correctScorer++;
  }

  return adjusted;
}

// ─── Revisa resultado real de un partido en SofaScore ───
async function checkMatchResult(page, matchId) {
  try {
    const url = `https://www.sofascore.com/es/football/match/_/id:${matchId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const text = document.body.innerText;
      // Buscar "Finalizado" o "FT" y el marcador
      const isFinished = /finalizado|partido\s*terminado|ft\b/i.test(text);

      // El marcador suele estar en un formato como "2 - 1"
      // Buscar el primer par de números cerca de "Finalizado" o al inicio del contenido
      const lines = text.split('\n').filter(l => l.trim());
      
      // Estrategia: encontrar la línea que contiene el score principal
      // Buscar líneas que tengan solo "N - N" o similar
      let home = null, away = null;
      for (const line of lines) {
        const m = line.match(/^(\d+)\s*[-–]\s*(\d+)$/);
        if (m) {
          home = parseInt(m[1]);
          away = parseInt(m[2]);
          break;
        }
      }
      // Fallback: buscar en todo el texto
      if (home === null) {
        const m2 = text.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (m2) {
          // Intentar no agarrar cualquier par de números
          const h = parseInt(m2[1]);
          const a = parseInt(m2[2]);
          if (h < 20 && a < 20) { home = h; away = a; }
        }
      }

      return { isFinished, home, away };
    });

    return result;
  } catch {
    return { isFinished: false, home: null, away: null };
  }
}

// ─── Genera estadísticas de precisión ───
function printStats(weights, predictions) {
  const total = predictions.length;
  const checked = predictions.filter(p => p.finalScore !== null).length;
  const unchecked = total - checked;

  let correctScore = 0, correctScorer = 0, totalWithScorer = 0;
  for (const p of predictions) {
    if (p.finalScore === null) continue;
    const { goalHappened, scorerCorrect } = evaluatePrediction(
      p, p.finalScore.home, p.finalScore.away
    );
    const prob = p.predictedProbability / 100;
    if ((goalHappened && prob >= 0.4) || (!goalHappened && prob < 0.4)) correctScore++;
    if (scorerCorrect === true) { correctScorer++; totalWithScorer++; }
    if (scorerCorrect === false) totalWithScorer++;
  }

  console.log('\n📊 ESTADÍSTICAS DE APRENDIZAJE');
  console.log('─'.repeat(40));
  console.log(`  Total predicciones:  ${total}`);
  console.log(`  Verificadas:         ${checked}`);
  console.log(`  Pendientes:          ${unchecked}`);
  console.log(`  Precisión (gol S/N): ${checked > 0 ? (correctScore/checked*100).toFixed(1) : '-'}%`);
  console.log(`  Precisión (equipo):  ${totalWithScorer > 0 ? (correctScorer/totalWithScorer*100).toFixed(1) : '-'}%`);

  // Por liga
  const byLeague = {};
  for (const p of predictions) {
    if (p.finalScore === null || !p.league) continue;
    if (!byLeague[p.league]) byLeague[p.league] = { total: 0, correct: 0 };
    byLeague[p.league].total++;
    const { goalHappened } = evaluatePrediction(p, p.finalScore.home, p.finalScore.away);
    const prob = p.predictedProbability / 100;
    if ((goalHappened && prob >= 0.4) || (!goalHappened && prob < 0.4)) {
      byLeague[p.league].correct++;
    }
  }

  console.log(`\n  Por liga:`);
  for (const [league, data] of Object.entries(byLeague)) {
    if (data.total >= 2) {
      console.log(`    ${league}: ${data.correct}/${data.total} (${(data.correct/data.total*100).toFixed(0)}%)`);
    }
  }

  console.log(`\n  Pesos globales actuales:`);
  const sorted = Object.entries(weights.global).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sorted) {
    console.log(`    ${k}: ${v}`);
  }

  const leaguesWithCustom = Object.entries(weights.byLeague).filter(([, v]) => Object.keys(v).length > 0);
  if (leaguesWithCustom.length > 0) {
    console.log(`\n  Ligas con pesos personalizados:`);
    for (const [league, w] of leaguesWithCustom) {
      console.log(`    ${league}: ${JSON.stringify(w)}`);
    }
  }
}

async function main() {
  const weights = loadWeights();
  const predictions = loadPredictions();

  console.log('🧠 SISTEMA DE APRENDIZAJE — SOFASCORE ANALYZER');
  console.log('='.repeat(48));

  if (predictions.length === 0) {
    console.log('\nNo hay predicciones guardadas. Ejecuta primero:');
    console.log('  node sofascore_analyzer.js');
    return;
  }

  // Separar las que ya tienen resultado y las que no
  const pending = predictions.filter(p => p.finalScore === null);
  const alreadyDone = predictions.filter(p => p.finalScore !== null);

  console.log(`\n📋 Predicciones totales: ${predictions.length}`);
  console.log(`✅ Ya verificadas:      ${alreadyDone.length}`);
  console.log(`⏳ Pendientes:           ${pending.length}`);

  if (pending.length === 0) {
    console.log('\nTodas las predicciones ya están verificadas.');
    console.log('Los pesos ya están ajustados.\n');
    printStats(weights, predictions);
    return;
  }

  // Verificar resultados pendientes
  console.log(`\n🔍 Verificando ${Math.min(pending.length, 10)} partidos pendientes...`);
  
  const proxyServer = process.env.PROXY_SERVER;
  if (proxyServer) console.log(`  Usando proxy: ${proxyServer}`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    proxy: proxyServer ? { server: proxyServer } : undefined
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, locale: 'es-CO', timezoneId: 'America/Bogota' });

  let checked = 0;
  for (let i = 0; i < Math.min(pending.length, 10); i++) {
    const pred = pending[i];
    console.log(`  [${i + 1}] ${pred.match} (ID: ${pred.id})...`);
    
    const result = await checkMatchResult(page, pred.id);
    if (result.isFinished && result.home !== null && result.away !== null) {
      pred.finalScore = { home: result.home, away: result.away };
      console.log(`     -> Finalizado: ${result.home} - ${result.away}`);
      checked++;
    } else if (result.isFinished) {
      console.log(`     -> Finalizado pero no se pudo leer el marcador`);
    } else {
      console.log(`     -> Aún en juego o no disponible`);
    }
  }

  await browser.close();

  if (checked === 0) {
    console.log('\nNo se pudieron verificar partidos nuevos.');
    console.log('Los partidos pueden seguir en curso. Vuelve a intentar más tarde.');
    savePredictions(predictions);
    return;
  }

  // Ajustar pesos
  console.log(`\n📈 Ajustando pesos con ${checked} nuevos resultados...`);
  const adjusted = adjustWeights(weights, predictions, weights.stats);
  saveWeights(weights);
  savePredictions(predictions);
  console.log(`  Pesos ajustados: ${adjusted} modificaciones`);
  printStats(weights, predictions);

  console.log('\n✅ Listo. Los nuevos pesos se usarán en el próximo análisis.');
  console.log('  (corre "node sofascore_analyzer.js" para ver el cambio)');
}

main();
