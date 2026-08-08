/**
 * _test_filtro.js — ¿un prompt mejor habría salvado las alertas?
 *
 * El filtro que corrio en produccion aprobo el 98.8% (85 de 86) y aporto 0.0
 * puntos sobre 54 apuestas resueltas. Dos fallos de diseño, los dos mios:
 *
 *   1. El prompt decia "aprueba salvo razon concreta en contra". Un filtro con
 *      esa instruccion aprueba casi todo por construccion.
 *   2. Se le daban xG, remates y ocasiones para juzgar — justo las variables
 *      que la ablacion midio que RESTAN (-0.014 a -0.019 AUC).
 *
 * Aqui se le vuelven a pasar las MISMAS 54 apuestas con un prompt distinto:
 * cuota obligatoria, sin las variables que no informan, y la pregunta invertida
 * (rechaza salvo razon concreta a favor). Se compara acierto con y sin filtro.
 *
 * Es una prueba honesta pero con un limite que hay que decir: la IA juzga
 * apuestas de partidos que ya ocurrieron y cuyos equipos puede conocer. No hay
 * fuga del resultado concreto, pero tampoco es un test en vivo.
 */
const fs = require('fs');
const { providers, postJson } = require('./ai_filter');

const SYSTEM = [
  'Eres el filtro final de un sistema de alertas de gol en vivo. Tu trabajo NO es',
  'aprobar: es RECHAZAR lo que no deberia mandarse. El sistema ya aprobo esta',
  'alerta; tu buscas el motivo por el que se equivoca.',
  '',
  'Contexto medido sobre 329 partidos de este mismo sistema:',
  '- Las estadisticas en vivo (xG, remates, posesion, ocasiones) NO predicen el',
  '  proximo gol. Se midio: restan precision. No las uses para justificar un si.',
  '- Lo unico que predice es la fuerza de los equipos y el tiempo que queda.',
  '- La tasa base de gol en 15 minutos es ~45%. Una alerta que diga 60% y no',
  '  tenga una razon de peso probablemente sea ruido.',
  '',
  'Aprueba SOLO si hay una razon concreta y verificable por la que ESTE',
  'emparejamiento produce goles: equipos ofensivos conocidos, liga de ritmo alto,',
  'diferencia de nivel clara. Si no conoces a los equipos, RECHAZA.',
  '',
  'Se exigente. Rechazar de mas cuesta una apuesta perdida; aprobar de mas cuesta',
  'dinero. Se espera que rechaces cerca de la mitad.',
  '',
  'Responde SOLO JSON: {"aprobar":true|false,"razon":"max 15 palabras"}',
].join('\n');

async function juzgar(a) {
  for (const p of providers()) {
    try {
      const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(a) }];
      let { status, json, raw } = await postJson(p.host, p.path, p.headers(p.key), p.body(p.model, msgs));
      let n = 0;
      while (status === 429 && n < 4) { n++; await new Promise(r => setTimeout(r, 4000 * n));
        ({ status, json, raw } = await postJson(p.host, p.path, p.headers(p.key), p.body(p.model, msgs))); }
      if (status < 200 || status >= 300) continue;
      const o = JSON.parse((p.parse(json) || '').replace(/```json|```/g, '').trim());
      if (typeof o.aprobar !== 'boolean') continue;
      return o;
    } catch {}
  }
  return null;
}

(async () => {
  const P = JSON.parse(fs.readFileSync('predictions.json', 'utf8'));
  const res = P.filter(a => a && a.bet && typeof a.bet.won === 'boolean');
  console.log('apuestas resueltas:', res.length);
  if (res.length < 20) { console.log('muestra insuficiente'); return; }
  const out = [];
  let i = 0;
  for (const a of res) {
    const j = await juzgar({
      local: a.teamHome, visitante: a.teamAway, liga: a.league,
      minuto: a.bet.minuteAtBet ?? a.analysisMinute,
      marcador: (a.scoreAtAnalysis?.home ?? 0) + '-' + (a.scoreAtAnalysis?.away ?? 0),
      apuesta: a.bet.bet,
      probabilidad_del_sistema: Math.round((a.bet.modelProb || a.bet.p || 0) * 100) + '%',
    });
    i++;
    if (j) out.push({ won: a.bet.won, ok: j.aprobar, razon: j.razon });
    if (i % 20 === 0) console.log('  ' + i + '/' + res.length + '  juzgadas=' + out.length);
    await new Promise(r => setTimeout(r, parseInt(process.env.PAUSA_MS || '6500', 10)));
  }
  console.log('juzgadas:', out.length, 'de', res.length);
  if (out.length < 20) { console.log('muestra insuficiente'); return; }
  const sinF = out.filter(o => o.won).length / out.length;
  const ap = out.filter(o => o.ok);
  const rc = out.filter(o => !o.ok);
  const wil = (h, N) => { if (!N) return 0; const z = 1.96, pr = h / N;
    return ((pr + z * z / (2 * N)) - z * Math.sqrt(pr * (1 - pr) / N + z * z / (4 * N * N))) / (1 + z * z / N); };
  console.log('');
  console.log('=== FILTRO IA CON PROMPT NUEVO ===');
  console.log('  SIN filtro (lo que paso) : ' + out.length + ' apuestas, ' + (sinF * 100).toFixed(1) + '% acierto');
  console.log('  aprobadas por la IA      : ' + ap.length + ' apuestas, ' +
    (ap.length ? (ap.filter(o => o.won).length / ap.length * 100).toFixed(1) : '-') + '% acierto' +
    (ap.length ? '  (IC inf ' + (wil(ap.filter(o => o.won).length, ap.length) * 100).toFixed(1) + '%)' : ''));
  console.log('  rechazadas por la IA     : ' + rc.length + ' apuestas, ' +
    (rc.length ? (rc.filter(o => o.won).length / rc.length * 100).toFixed(1) : '-') + '% acierto');
  console.log('  tasa de rechazo          : ' + (rc.length / out.length * 100).toFixed(1) + '%');
  const dif = ap.length ? (ap.filter(o => o.won).length / ap.length - sinF) * 100 : 0;
  console.log('');
  console.log('  APORTE: ' + (dif >= 0 ? '+' : '') + dif.toFixed(1) + ' puntos');
  console.log('  VEREDICTO: ' + (rc.length === 0 ? 'sigue aprobando todo — el prompt no cambio nada'
    : dif >= 8 ? 'APORTA con este prompt' : dif <= -3 ? 'EMPEORA — rechaza las buenas' : 'no aporta (dentro del ruido)'));
})();
