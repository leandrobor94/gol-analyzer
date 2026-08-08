/**
 * _careo.js — las tres versiones sobre EXACTAMENTE los mismos partidos.
 *
 * La fuerza por tabla midio +0.032 de AUC sobre 141 partidos. La fuerza por
 * historial, sin fuga, midio -0.008 sobre 302. Los dos numeros no se pueden
 * comparar: distinto subconjunto y distinta fuente.
 *
 * Aqui se comparan las TRES sobre el mismo conjunto —solo los partidos donde
 * las dos fuerzas se pueden calcular— para separar dos explicaciones:
 *
 *   (a) la fuerza no sirve, y el +0.032 era la fuga de las tablas de hoy
 *   (b) la fuerza si sirve, y la que falla es la medida por historial
 *
 * La diferencia entre las dos columnas de fuerza sobre las MISMAS filas es la
 * respuesta. No hay forma de saberlo mirando los dos numeros por separado.
 */
const fs = require('fs');
const https = require('https');
const M = require('./model.js');
const S = require('./scores365.js');
const PA = 'appTypeId=5&langId=14&timezoneName=America/Bogota&userCountryId=109';

function get(u) {
  return new Promise(ok => {
    https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => ok(b));
    }).on('error', () => ok(''));
  });
}

const cache = new Map();
async function historial(tid) {
  if (cache.has(tid)) return cache.get(tid);
  let out = [];
  try {
    const j = JSON.parse(await get('https://webws.365scores.com/web/games/results/?' + PA + '&competitors=' + tid));
    for (const g of (j.games || [])) {
      const h = g.homeCompetitor, a = g.awayCompetitor;
      if (!h || !a || !(h.score >= 0) || !(a.score >= 0)) continue;
      const local = String(h.id) === String(tid);
      out.push({ fecha: String(g.startTime || '').slice(0, 10),
        gf: local ? h.score : a.score, gc: local ? a.score : h.score });
    }
  } catch {}
  cache.set(tid, out);
  return out;
}

function ritmoAntesDe(hist, fecha, min = 3) {
  const prev = hist.filter(x => x.fecha && x.fecha < fecha);
  if (prev.length < min) return null;
  const n = prev.length;
  return { gf: prev.reduce((s, x) => s + x.gf, 0) / n, gc: prev.reduce((s, x) => s + x.gc, 0) / n };
}

const clamp = f => Math.max(0.65, Math.min(1.55, f));

(async () => {
  const meta = JSON.parse(fs.readFileSync('meta_partidos.json', 'utf8'));
  const P = JSON.parse(fs.readFileSync('predictions.json', 'utf8'));
  const model = M.loadModel();
  const utiles = P.filter(x => Array.isArray(x.goalMinutes) && x.timelineConsistent !== false &&
    x.analysisMinute >= 20 && x.analysisMinute <= 80 && meta[String(x.id)] && x.stats && x.timestamp);

  for (const cid of [...new Set(utiles.map(x => meta[String(x.id)].cid))]) {
    await S.fetchStandings(cid);
    await new Promise(r => setTimeout(r, 70));
  }
  const ids = [...new Set(utiles.flatMap(x => [meta[String(x.id)].h, meta[String(x.id)].a]))];
  let k = 0;
  for (const id of ids) { await historial(id); if (++k % 100 === 0) console.log('  ' + k + '/' + ids.length); await new Promise(r => setTimeout(r, 70)); }

  const D = [];
  for (const x of utiles) {
    const mt = meta[String(x.id)];
    const fTabla = S.strengthFactor(await S.fetchStandings(mt.cid), mt.h, mt.a);
    if (fTabla == null) continue;
    const fecha = String(x.timestamp).slice(0, 10);
    const H = ritmoAntesDe(await historial(mt.h), fecha);
    const A = ritmoAntesDe(await historial(mt.a), fecha);
    if (!H || !A) continue;
    const REF = 1.35;
    const fForma = clamp(((H.gf / REF) * (A.gc / REF) + (A.gf / REF) * (H.gc / REF)) / 2);
    const m = { minute: x.analysisMinute, scoreHome: (x.scoreAtAnalysis && x.scoreAtAnalysis.home) || 0,
      scoreAway: (x.scoreAtAnalysis && x.scoreAtAnalysis.away) || 0, stats: x.stats,
      leagueGoalsPerMatch: x.leagueGoalsPerMatch };
    D.push({
      y: x.goalMinutes.some(v => v > x.analysisMinute && v <= x.analysisMinute + 15) ? 1 : 0,
      pSin: M.score(model, m).prob15,
      pTabla: M.score(model, Object.assign({}, m, { strength: fTabla })).prob15,
      pForma: M.score(model, Object.assign({}, m, { strength: fForma })).prob15,
      fTabla, fForma,
    });
  }

  console.log('');
  console.log('partidos donde AMBAS fuerzas se pueden calcular:', D.length);
  if (D.length < 40) { console.log('muestra insuficiente'); return; }
  console.log('tasa base:', (D.filter(d => d.y).length / D.length * 100).toFixed(1) + '%');

  // Correlacion entre las dos medidas de fuerza: si miden lo mismo, deberia ser alta.
  const mt2 = D.reduce((s, d) => s + d.fTabla, 0) / D.length, mf = D.reduce((s, d) => s + d.fForma, 0) / D.length;
  let sxy = 0, sx = 0, sy = 0;
  for (const d of D) { const a = d.fTabla - mt2, b = d.fForma - mf; sxy += a * b; sx += a * a; sy += b * b; }
  console.log('correlacion entre fuerza-por-tabla y fuerza-por-historial:', (sxy / Math.sqrt(sx * sy || 1)).toFixed(3));

  const auc = g => { const p = D.filter(d => d.y), n = D.filter(d => !d.y); let s = 0;
    for (const a of p) for (const b of n) s += g(a) > g(b) ? 1 : g(a) === g(b) ? 0.5 : 0;
    return s / (p.length * n.length); };
  const br = g => D.reduce((s, d) => s + Math.pow(g(d) - d.y, 2), 0) / D.length;
  const top = g => { const kk = Math.round(D.length * 0.2);
    const t = D.slice().sort((a, b) => g(b) - g(a)).slice(0, kk);
    return t.filter(d => d.y).length / kk * 100; };

  console.log('');
  console.log('  version                          AUC      Brier    top 20%');
  const filas = [
    ['sin fuerza', d => d.pSin],
    ['fuerza por TABLA (con fuga)', d => d.pTabla],
    ['fuerza por HISTORIAL (limpia)', d => d.pForma],
  ];
  for (const [n, g] of filas) {
    console.log('  ' + n.padEnd(32) + auc(g).toFixed(4) + '   ' + br(g).toFixed(4) + '   ' + top(g).toFixed(1) + '%');
  }
  console.log('');
  console.log('  tabla   vs sin:  ' + ((auc(d => d.pTabla) - auc(d => d.pSin)) >= 0 ? '+' : '') + (auc(d => d.pTabla) - auc(d => d.pSin)).toFixed(4) + ' AUC');
  console.log('  historial vs sin: ' + ((auc(d => d.pForma) - auc(d => d.pSin)) >= 0 ? '+' : '') + (auc(d => d.pForma) - auc(d => d.pSin)).toFixed(4) + ' AUC');
})();
