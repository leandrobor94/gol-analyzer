/**
 * _gemini_diag.js — que modelos acepta ESTA clave.
 *
 * El 429 llego en la PRIMERA llamada con el mensaje de plan/facturacion, no el
 * de peticiones por minuto. Eso no es saturacion: es que la clave no tiene
 * cuota gratuita para el modelo pedido. Antes de cambiar nada hay que saber
 * cual si tiene.
 */
const { postJson } = require('./ai_filter');
const https = require('https');

// postJson solo hace POST. Para listar modelos hace falta GET.
function getJson(path, key) {
  return new Promise((resolve) => {
    const req = https.request({ hostname: HOST, path, method: 'GET',
      headers: { 'x-goog-api-key': key }, timeout: 20000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {}
        resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    req.on('error', e => resolve({ status: 0, json: null, raw: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: 'timeout' }); });
    req.end();
  });
}
const HOST = 'generativelanguage.googleapis.com';

const CANDIDATOS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
];

async function probar(key, model) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'Responde solo: {"ok":true}' }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 40, responseMimeType: 'application/json' },
  });
  const h = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  try {
    const { status, json, raw } = await postJson(HOST, '/v1beta/models/' + model + ':generateContent', h, body);
    if (status >= 200 && status < 300) {
      const c = json && json.candidates && json.candidates[0];
      const t = (c && c.content && c.content.parts || []).map(x => x.text || '').join('');
      return '[OK]   ' + t.slice(0, 60).replace(/\s+/g, ' ');
    }
    let msg = '';
    try { msg = JSON.parse(raw).error.message; } catch { msg = String(raw || '').slice(0, 150); }
    return '[' + status + '] ' + msg.slice(0, 150).replace(/\s+/g, ' ');
  } catch (e) { return '[EXC] ' + e.message; }
}

(async () => {
  const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map(k => k.trim()).filter(Boolean);
  console.log('claves:', keys.length);
  for (const k of keys) {
    // El prefijo de una API key de Google es publico ("AIza"); no revela nada.
    console.log('  formato: ' + k.slice(0, 4) + '... (' + k.length + ' chars, esperado 39)');
  }
  if (!keys.length) { console.log('sin claves'); process.exit(1); }

  console.log('');
  console.log('=== modelos que la clave puede LISTAR ===');
  try {
    const { status, json, raw } = await getJson('/v1beta/models?pageSize=200', keys[0]);
    if (status === 200 && json && json.models) {
      const gen = json.models
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace('models/', ''))
        .filter(n => /^gemini/.test(n));
      console.log('  ' + gen.length + ' modelos gemini con generateContent');
      console.log('  ' + gen.slice(0, 25).join(', '));
    } else {
      let msg = ''; try { msg = JSON.parse(raw).error.message; } catch { msg = String(raw || '').slice(0, 200); }
      console.log('  [' + status + '] ' + msg.slice(0, 200));
    }
  } catch (e) { console.log('  EXC ' + e.message); }

  console.log('');
  console.log('=== llamada real a cada candidato ===');
  for (const m of CANDIDATOS) {
    console.log('  ' + m.padEnd(24) + await probar(keys[0], m));
    await new Promise(r => setTimeout(r, 1200));
  }
})();
