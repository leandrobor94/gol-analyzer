/**
 * backfill.js — recupera el minuto real de cada gol para el historico completo.
 *
 *   node backfill.js            recorre las predicciones sin timeline
 *   node backfill.js --limit 50 solo las primeras 50 (para probar)
 *
 * Por que existe: el sistema anterior nunca guardo el minuto en que se marcaba
 * (rellenaba con lastSeenMinute, el ultimo minuto OBSERVADO del partido). Sin eso
 * es imposible entrenar o evaluar un horizonte corto.
 *
 * Resulta que la API de 365scores sigue sirviendo game.events[] para partidos de
 * semanas atras, asi que el dato no habia que esperarlo: habia que ir a buscarlo.
 * Esto convierte ~550 partidos ya verificados en un dataset entrenable para la
 * etiqueta que de verdad importa ("gol en los proximos 15 minutos").
 */

const fs = require('fs');
const path = require('path');
const scores365 = require('./scores365');
const { label } = require('./verify');

const PREDICTIONS_FILE = path.join(__dirname, 'predictions.json');
const CONCURRENCY = 5;      // amable con la API publica
const PAUSE_MS = 150;

const argv = process.argv.slice(2);
const argVal = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = parseInt(argVal('--limit', '0'), 10);

async function run() {
  const preds = JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8').replace(/^﻿/, ''));

  // Solo las que ya estan resueltas pero sin timeline de goles.
  let todo = preds.filter(p =>
    p.goalAfterAnalysis != null &&
    !Array.isArray(p.goalMinutes) &&
    !Number.isNaN(parseInt(p.id, 10)));
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);

  console.log('='.repeat(64));
  console.log('  BACKFILL DE MINUTOS DE GOL');
  console.log('='.repeat(64));
  console.log('  predicciones totales     : ' + preds.length);
  console.log('  ya tenian timeline       : ' + preds.filter(p => Array.isArray(p.goalMinutes)).length);
  console.log('  a recuperar              : ' + todo.length);
  if (!todo.length) { console.log('\nNada que hacer.'); return; }

  const byId = new Map();
  for (const p of todo) {
    const k = String(p.id);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(p);
  }
  const ids = [...byId.keys()];
  console.log('  partidos distintos       : ' + ids.length + '\n');

  let done = 0, ok = 0, noData = 0, failed = 0, withGoals = 0;
  const queue = ids.slice();

  async function worker(n) {
    while (queue.length) {
      const id = queue.shift();
      let detail = null;
      try {
        detail = await scores365.fetchGameDetail(parseInt(id, 10));
      } catch (e) {
        failed++;
      }
      done++;
      if (detail && detail.finished) {
        for (const p of byId.get(id)) {
          // label() recalcula finalScore, goalAfterAnalysis, goalWithin15,
          // nextGoalMinute y timelineConsistent con la misma logica que produccion.
          label(p, detail);
        }
        ok++;
        if (detail.goals.length) withGoals++;
      } else {
        noData++;
      }
      if (done % 25 === 0 || !queue.length) {
        process.stdout.write('\r  progreso: ' + done + '/' + ids.length +
          '  ok=' + ok + '  sin datos=' + noData + '  errores=' + failed + '   ');
      }
      await new Promise(r => setTimeout(r, PAUSE_MS));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  console.log('\n');

  fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(preds, null, 2));

  const conTimeline = preds.filter(p => Array.isArray(p.goalMinutes));
  const con15 = preds.filter(p => p.goalWithin15 != null);
  const inconsistentes = conTimeline.filter(p => p.timelineConsistent === false);

  console.log('  partidos recuperados     : ' + ok + ' (' + withGoals + ' con goles en el timeline)');
  console.log('  sin datos en la API      : ' + noData);
  console.log('  errores de red           : ' + failed);
  console.log('');
  console.log('  con timeline de goles    : ' + conTimeline.length);
  console.log('  con etiqueta "gol en 15" : ' + con15.length);
  if (con15.length) {
    const base = con15.filter(p => p.goalWithin15).length / con15.length;
    console.log('  tasa base "gol en 15 min": ' + (base * 100).toFixed(1) + '%');
  }
  if (inconsistentes.length) {
    console.log('');
    console.log('  AVISO: ' + inconsistentes.length + ' partidos con timeline incompleto');
    console.log('  (el numero de goles posteriores no cuadra con el marcador final).');
    console.log('  Quedan marcados con timelineConsistent:false y train.js los excluye.');
  }
  console.log('\npredictions.json actualizado.');
}

run().catch(e => { console.error('Error:', e.message, '\n' + e.stack); process.exit(1); });
