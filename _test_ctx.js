/**
 * _test_ctx.js — ¿puede la IA estimar el ritmo de goles de un emparejamiento?
 *
 * Prueba honesta: tenemos 191 partidos donde la fuerza real se conoce por la
 * tabla de posiciones. Se le pide a la IA que estime el total de goles esperado
 * SIN darle ese dato, y se mide la correlacion contra el valor real.
 *
 * Si correlaciona, sirve para los 142 partidos SIN tabla (copas, amistosos,
 * torneos entre ligas) donde el modelo hoy va ciego con el promedio global.
 * Si no correlaciona, se descarta la via de la IA con datos y no con opinion.
 */
const https = require('https');
const fs = require('fs');
const { estimarRitmo } = require('./ai_context');
const PA = 'appTypeId=5&langId=14&timezoneName=America/Bogota&userCountryId=109';
const get = u => new Promise(ok => { https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok(b)); }).on('error', () => ok('')); });

(async () => {
  const P = JSON.parse(fs.readFileSync('predictions.json', 'utf8'));
  const meta = JSON.parse(fs.readFileSync('meta_partidos.json', 'utf8'));
  const utiles = P.filter(x => meta[String(x.id)] && x.teamHome && x.teamAway);
  const T = {};
  for (const cid of [...new Set(utiles.map(x => meta[String(x.id)].cid))]) {
    try {
      const j = JSON.parse(await get('https://webws.365scores.com/web/standings/?' + PA + '&competitions=' + cid + '&live=false'));
      const st = (j.standings || [])[0];
      const rows = st ? (st.rows || []).filter(r => r.gamePlayed >= 2) : [];
      if (rows.length < 4) continue;
      const gf = rows.reduce((s, r) => s + r.for, 0), gp = rows.reduce((s, r) => s + r.gamePlayed, 0), med = gf / gp;
      for (const r of rows) T[r.competitor.id] = { atk: (r.for / r.gamePlayed) / med, def: (r.against / r.gamePlayed) / med, liga: med * 2 };
    } catch {}
    await new Promise(r => setTimeout(r, 90));
  }
  const casos = [];
  const vistos = new Set();
  for (const x of utiles) {
    const mt = meta[String(x.id)], H = T[mt.h], A = T[mt.a];
    if (!H || !A || vistos.has(x.id)) continue;
    vistos.add(x.id);
    casos.push({ id: x.id, teamHome: x.teamHome, teamAway: x.teamAway, league: x.league,
      real: (H.atk * A.def + A.atk * H.def) / 2 * (H.liga / 2) });
  }
  console.log('casos con fuerza real conocida:', casos.length);
  const N = Math.min(casos.length, parseInt(process.env.MAX_CASOS || '150', 10));
  // Gemini permite 15/min por clave; Groq se ahoga por TOKENS/min mucho antes.
  const PAUSA = parseInt(process.env.PAUSA_MS || '4200', 10);
  const muestra = casos.slice(0, N);
  const pares = [];
  const fallos = [];
  let i = 0;
  for (const c of muestra) {
    const r = await estimarRitmo(c);
    i++;
    if (r) pares.push({ real: c.real, ia: r.goles, conf: r.confianza, eq: c.teamHome + ' vs ' + c.teamAway });
    if (!r) fallos.push(estimarRitmo.ultimoFallo || 'sin motivo');
    if (i % 20 === 0) console.log('  ' + i + '/' + N + '  validas=' + pares.length);
    await new Promise(r2 => setTimeout(r2, PAUSA));
  }
  console.log('respuestas validas:', pares.length, 'de', N);
  if (fallos.length) {
    const c = {};
    for (const f of fallos) c[f] = (c[f] || 0) + 1;
    console.log('motivos de fallo:', JSON.stringify(c).slice(0, 300));
  }
  if (pares.length < 20) { console.log('muestra insuficiente'); return; }
  const mx = pares.reduce((s, p) => s + p.ia, 0) / pares.length;
  const my = pares.reduce((s, p) => s + p.real, 0) / pares.length;
  let sxy = 0, sx = 0, sy = 0;
  for (const p of pares) { const dx = p.ia - mx, dy = p.real - my; sxy += dx * dy; sx += dx * dx; sy += dy * dy; }
  const corr = sxy / Math.sqrt(sx * sy || 1);
  const maeIA = pares.reduce((s, p) => s + Math.abs(p.ia - p.real), 0) / pares.length;
  const maeCte = pares.reduce((s, p) => s + Math.abs(2.6 - p.real), 0) / pares.length;
  console.log('');
  console.log('=== RESULTADO ===');
  console.log('  media IA        :', mx.toFixed(2), 'goles/partido');
  console.log('  media real      :', my.toFixed(2));
  console.log('  desviacion IA   :', Math.sqrt(sx / pares.length).toFixed(3), '(si es ~0, contesta siempre lo mismo)');
  console.log('  desviacion real :', Math.sqrt(sy / pares.length).toFixed(3));
  console.log('');
  console.log('  CORRELACION IA vs REAL :', corr.toFixed(3));
  console.log('  MAE de la IA           :', maeIA.toFixed(3));
  console.log('  MAE de decir 2.6 siempre:', maeCte.toFixed(3));
  console.log('');
  console.log('  VEREDICTO:', corr >= 0.4 && maeIA < maeCte ? 'LA IA APORTA — sirve para los partidos sin tabla'
    : corr < 0.2 ? 'NO APORTA — descartar la via'
    : 'DUDOSO — correlacion debil, no usar todavia');
})();
