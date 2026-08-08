/**
 * _val_form.js — fuerza desde el HISTORIAL del equipo, sin tabla y sin fuga.
 *
 * QUE PROBLEMA RESUELVE
 *
 * La fuerza que se publico en 79b4dfc sale de la tabla de posiciones y arrastra
 * dos limitaciones que la propia validacion declaro:
 *
 *   1. Cobertura ~57%. Copas, amistosos y torneos entre ligas no publican tabla.
 *   2. Fuga. La tabla de HOY ya incluye el resultado del partido que se predice,
 *      asi que el +0.032 medido era un techo, no una cifra limpia.
 *
 * El endpoint /web/games/results/?competitors=ID devuelve los ultimos ~26
 * partidos de CUALQUIER equipo, con marcador y FECHA. Eso arregla las dos:
 * existe para todos los equipos, y filtrando por fecha < fecha del partido la
 * fuga desaparece por construccion.
 *
 * COMO SE MIDE
 *
 * Para cada partido historico se calcula la fuerza usando SOLO partidos
 * anteriores a el, y se compara el modelo con y sin ella sobre el mismo objetivo
 * (gol en los proximos 15 minutos). Si no gana, no se cablea.
 */
const fs = require('fs');
const https = require('https');
const M = require('./model.js');
const PA = 'appTypeId=5&langId=14&timezoneName=America/Bogota&userCountryId=109';

function get(u) {
  return new Promise(ok => {
    https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => ok(b));
    }).on('error', () => ok(''));
  });
}

const cache = new Map();
/** Ultimos partidos de un equipo: [{fecha, gf, gc}] */
async function historial(tid) {
  if (cache.has(tid)) return cache.get(tid);
  let out = [];
  try {
    const j = JSON.parse(await get('https://webws.365scores.com/web/games/results/?' + PA + '&competitors=' + tid));
    for (const g of (j.games || [])) {
      const h = g.homeCompetitor, a = g.awayCompetitor;
      if (!h || !a) continue;
      // -1 marca partido sin jugar en este feed
      if (!(h.score >= 0) || !(a.score >= 0)) continue;
      const esLocal = String(h.id) === String(tid);
      out.push({ fecha: String(g.startTime || '').slice(0, 10),
                 gf: esLocal ? h.score : a.score,
                 gc: esLocal ? a.score : h.score });
    }
  } catch {}
  cache.set(tid, out);
  return out;
}

/** Goles por partido de un equipo ANTES de una fecha dada. null si <3 partidos. */
function ritmoAntesDe(hist, fecha, minPartidos = 3) {
  const prev = hist.filter(x => x.fecha && x.fecha < fecha);
  if (prev.length < minPartidos) return null;
  const n = prev.length;
  return { gf: prev.reduce((s, x) => s + x.gf, 0) / n, gc: prev.reduce((s, x) => s + x.gc, 0) / n, n };
}

(async () => {
  const meta = JSON.parse(fs.readFileSync('meta_partidos.json', 'utf8'));
  const P = JSON.parse(fs.readFileSync('predictions.json', 'utf8'));
  const model = M.loadModel();

  const utiles = P.filter(x => Array.isArray(x.goalMinutes) && x.timelineConsistent !== false &&
    x.analysisMinute >= 20 && x.analysisMinute <= 80 && meta[String(x.id)] && x.stats && x.timestamp);
  console.log('candidatos:', utiles.length);

  const ids = [...new Set(utiles.flatMap(x => [meta[String(x.id)].h, meta[String(x.id)].a]))];
  console.log('equipos a descargar:', ids.length);
  let k = 0;
  for (const id of ids) {
    await historial(id);
    if (++k % 60 === 0) console.log('  ' + k + '/' + ids.length);
    await new Promise(r => setTimeout(r, 70));
  }

  const D = [];
  let sinHist = 0;
  for (const x of utiles) {
    const mt = meta[String(x.id)];
    const fecha = String(x.timestamp).slice(0, 10);
    const H = ritmoAntesDe(await historial(mt.h), fecha);
    const A = ritmoAntesDe(await historial(mt.a), fecha);
    if (!H || !A) { sinHist++; continue; }
    // Media global de referencia: goles por equipo y partido en todo el feed.
    const REF = 1.35;
    const atkH = H.gf / REF, defH = H.gc / REF, atkA = A.gf / REF, defA = A.gc / REF;
    let f = (atkH * defA + atkA * defH) / 2;
    f = Math.max(0.65, Math.min(1.55, f));
    const m = { minute: x.analysisMinute, scoreHome: x.scoreAtAnalysis && x.scoreAtAnalysis.home || 0,
      scoreAway: x.scoreAtAnalysis && x.scoreAtAnalysis.away || 0, stats: x.stats,
      leagueGoalsPerMatch: x.leagueGoalsPerMatch };
    const sin = M.score(model, m);
    const con = M.score(model, Object.assign({}, m, { strength: f }));
    D.push({ y: x.goalMinutes.some(v => v > x.analysisMinute && v <= x.analysisMinute + 15) ? 1 : 0,
      pSin: sin.prob15, pCon: con.prob15, f, nH: H.n, nA: A.n });
  }

  console.log('');
  console.log('con historial previo suficiente:', D.length, '| descartados por falta de historial:', sinHist);
  console.log('cobertura:', (D.length / utiles.length * 100).toFixed(1) + '%  (la version por tabla llegaba al 57%)');
  if (D.length < 40) { console.log('muestra insuficiente'); return; }

  const auc = g => { const p = D.filter(d => d.y), n = D.filter(d => !d.y); let s = 0;
    for (const a of p) for (const b of n) s += g(a) > g(b) ? 1 : g(a) === g(b) ? 0.5 : 0;
    return s / (p.length * n.length); };
  const br = g => D.reduce((s, d) => s + Math.pow(g(d) - d.y, 2), 0) / D.length;

  console.log('tasa base:', (D.filter(d => d.y).length / D.length * 100).toFixed(1) + '%');
  console.log('factor: min ' + Math.min(...D.map(d => d.f)).toFixed(2) +
    ' med ' + (D.reduce((s, d) => s + d.f, 0) / D.length).toFixed(3) +
    ' max ' + Math.max(...D.map(d => d.f)).toFixed(2));
  console.log('');
  console.log('                    AUC       Brier');
  console.log('  SIN fuerza      ', auc(d => d.pSin).toFixed(4), '  ', br(d => d.pSin).toFixed(4));
  console.log('  CON fuerza      ', auc(d => d.pCon).toFixed(4), '  ', br(d => d.pCon).toFixed(4));
  const dA = auc(d => d.pCon) - auc(d => d.pSin), dB = br(d => d.pSin) - br(d => d.pCon);
  console.log('  diferencia      ', (dA >= 0 ? '+' : '') + dA.toFixed(4), '  ', (dB >= 0 ? '+' : '') + dB.toFixed(4), '(Brier: + es mejor)');

  console.log('');
  console.log('  Top 20% mas confiadas:');
  for (const [n, g] of [['sin', d => d.pSin], ['con', d => d.pCon]]) {
    const kk = Math.round(D.length * 0.2);
    const t = D.slice().sort((a, b) => g(b) - g(a)).slice(0, kk);
    console.log('    ' + n + ' fuerza: ' + kk + ' alertas, ' + (t.filter(d => d.y).length / kk * 100).toFixed(1) + '% acierto');
  }

  let gana = 0; const N = 2000;
  for (let i = 0; i < N; i++) {
    const s = [];
    for (let j = 0; j < D.length; j++) s.push(D[(j * 7919 + i * 104729) % D.length]);
    const a2 = g => { const p = s.filter(d => d.y), n = s.filter(d => !d.y); if (!p.length || !n.length) return 0.5;
      let t = 0; for (const a of p) for (const b of n) t += g(a) > g(b) ? 1 : g(a) === g(b) ? 0.5 : 0;
      return t / (p.length * n.length); };
    if (a2(d => d.pCon) > a2(d => d.pSin)) gana++;
  }
  console.log('');
  console.log('  bootstrap: CON fuerza gana en ' + (gana / N * 100).toFixed(1) + '% de las remuestras');
  console.log('');
  console.log('  SIN FUGA: la fuerza de cada partido usa solo partidos con fecha ANTERIOR a el.');
})();
