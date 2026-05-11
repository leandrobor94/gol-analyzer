const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const WEIGHTS_FILE = path.join(__dirname, 'weights.json');
const TEAMS_FILE = path.join(__dirname, 'teams.json');

async function getScore(page) {
  // Estrategia 1: buscar en elementos con data-testid
  const el = await page.$('[data-testid="wcl-score"], [data-testid*="score"], .detailScore__wrapper, .scoreboard, [class*="score__"]');
  if (el) {
    const text = await el.textContent();
    const m = text.match(/(\d+)\s*[-:]\s*(\d+)/);
    if (m) return { home: parseInt(m[1]), away: parseInt(m[2]), source: 'element' };
  }

  // Estrategia 2: buscar en el titulo de la pagina
  const title = await page.title();
  // Ej: "Corinthians vs Sao Paulo 2-1 (1-1) - Flashscore.com"
  const titleMatch = title.match(/(\d+)\s*[-:]\s*(\d+)/);
  if (titleMatch) {
    const h = parseInt(titleMatch[1]), a = parseInt(titleMatch[2]);
    if (h < 50 && a < 50) return { home: h, away: a, source: 'title' };
  }

  // Estrategia 3: buscar en el body solo numeros pequenos con formato score
  const body = await page.evaluate(() => document.body.innerText);
  // Buscar lineas que contengan solo score: "2 - 1" que no sean horas
  const lines = body.split('\n');
  for (const line of lines) {
    const m = line.trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
    if (m) {
      const h = parseInt(m[1]), a = parseInt(m[2]);
      if (h < 50 && a < 50) return { home: h, away: a, source: 'bodyline' };
    }
  }
  // Mas flexible: buscar cualquier patron numero-numero donde ambos < 50
  const allMatches = body.matchAll(/(\d+)\s*[-:]\s*(\d+)/g);
  for (const m of allMatches) {
    const h = parseInt(m[1]), a = parseInt(m[2]);
    if (h < 50 && a < 50 && !(h === 0 && a === 0)) return { home: h, away: a, source: 'body' };
  }

  return null;
}

async function main() {
  const preds = JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8'));
  const unverified = preds.filter(p => p.predictionCorrect === null && p.id && p.id.startsWith('http'));
  console.log('Predicciones sin verificar: ' + unverified.length + ' de ' + preds.length);

  if (unverified.length === 0) { console.log('Todas verificadas'); return; }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    locale: 'en-US'
  });
  const page = await context.newPage();

  let verified = 0;
  for (const pred of unverified) {
    try {
      const url = pred.id;
      const displayName = pred.teamHome + ' vs ' + pred.teamAway;
      const predScore = pred.scoreAtAnalysis || {};
      console.log('\n' + displayName + ' (' + pred.analysisMinute + "') - " + (predScore.home ?? '?') + '-' + (predScore.away ?? '?'));

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(4000);

      const score = await getScore(page);

      if (score) {
        console.log('  Score: ' + score.home + '-' + score.away + ' (via ' + score.source + ')');
        const scoreChanged = score.home !== (predScore.home ?? score.home) ||
                             score.away !== (predScore.away ?? score.away);

        pred.finalScore = { home: score.home, away: score.away };
        pred.goalAfterAnalysis = scoreChanged;

        const prob = (pred.predictedProbability || 0) / 100;
        const predictedGoal = prob >= 0.7;
        pred.predictionCorrect = (predictedGoal && scoreChanged) || (!predictedGoal && !scoreChanged);

        console.log('  Cambio: ' + (scoreChanged ? 'SI' : 'NO') + ' | ' + (predictedGoal ? 'PRED GOL' : 'PRED NO GOL') + ' -> ' + (pred.predictionCorrect ? 'CORRECTO' : 'INCORRECTO'));
        verified++;
      } else {
        console.log('  No se pudo extraer score');
      }
    } catch (err) {
      console.log('  Error: ' + err.message);
    }
  }

  await browser.close();
  console.log('\nTotal verificados: ' + verified + ' de ' + unverified.length);

  fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(preds, null, 2));
  console.log('predictions.json guardado');

  // Ejecutar aprendizaje: ajustar pesos basado en las predicciones verificadas
  const learn = require('./learn');
  const weights = learn.loadWeights();
  const teams = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
  const { verified: v, insights } = learn.verifyPredictions(preds, [], teams);
  if (v.length > 0) {
    const adjustments = learn.adjustWeights(weights, v, insights);
    console.log('Ajustes de pesos: ' + adjustments);
  }
  learn.saveWeights(weights);
  console.log('Pesos guardados');
  fs.writeFileSync(TEAMS_FILE, JSON.stringify(teams, null, 2));
  console.log('teams.json guardado');
}

main().catch(err => { console.error(err); process.exit(1); });
