/**
 * ai_filter.js — segunda opinion de un LLM sobre alertas del tier VALOR.
 *
 * HONESTIDAD SOBRE SU APORTE (leer antes de confiar en esto):
 *
 * No hay evidencia todavia de que la IA mejore la precision. Al contrario: sobre
 * 548 partidos verificados, TODAS las estadisticas del partido (xG, remates,
 * ocasiones, posesion, ataques) tienen correlacion practicamente nula con "hubo
 * gol despues" cuando se controla el tiempo restante (|corr| < 0.06). Un LLM que
 * lee esas mismas estadisticas no puede extraer una señal que no esta ahi.
 *
 * Se mantiene por dos razones concretas:
 *   1. Puede aportar contexto que el pipeline NO tiene: conocimiento de la
 *      competicion, de que un marcador es atipico, de situaciones raras.
 *   2. Cada decision se guarda en la prediccion (aiDecision) y evaluate.js mide
 *      su aporte real: precision con IA vs sin IA sobre las mismas alertas.
 *
 * Si tras >=30 decisiones evaluate.js muestra que no aporta, quitarla.
 * Mientras tanto solo filtra el tier VALOR, nunca el de PRECISION.
 *
 * Providers, por prioridad:
 *   1. OPENAI_API_KEY     -> gpt-4o-mini
 *   2. GROQ_API_KEY       -> llama-3.3-70b (gratis)
 *   3. ANTHROPIC_API_KEY  -> claude haiku
 *
 * Keys: local en .env (ver .env.example) | nube en GitHub Secrets.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Cargar .env local sin dependencia externa
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
})();

function provider() {
  if (process.env.OPENAI_API_KEY) {
    return {
      name: 'openai',
      key: process.env.OPENAI_API_KEY,
      host: 'api.openai.com',
      path: '/v1/chat/completions',
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      headers: (key) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }),
      body: (model, messages) => JSON.stringify({
        model, messages, temperature: 0.05, max_tokens: 220,
        response_format: { type: 'json_object' },
      }),
      parse: (j) => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      name: 'groq',
      key: process.env.GROQ_API_KEY,
      host: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      model: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
      headers: (key) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }),
      body: (model, messages) => JSON.stringify({
        model, messages, temperature: 0.05, max_tokens: 220,
        response_format: { type: 'json_object' },
      }),
      parse: (j) => (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '',
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: 'anthropic',
      key: process.env.ANTHROPIC_API_KEY,
      host: 'api.anthropic.com',
      path: '/v1/messages',
      model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
      headers: (key) => ({ 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
      body: (model, messages) => {
        const sys = (messages.find(m => m.role === 'system') || {}).content || '';
        const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
        return JSON.stringify({ model, max_tokens: 220, system: sys, messages: [{ role: 'user', content: user }] });
      },
      parse: (j) => (j.content && j.content[0] && j.content[0].text) || '',
    };
  }
  return null;
}

function postJson(host, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: reqPath, method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(body) }),
      timeout: 25000,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d), raw: d }); }
        catch { reject(new Error('AI JSON parse: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('AI timeout')); });
    req.write(body);
    req.end();
  });
}

const SYSTEM_PROMPT = [
  'Eres un filtro anti falso-positivo de alertas de gol en futbol en vivo.',
  'Un modelo estadistico calibrado ya marco este partido. Tu unica tarea es decidir',
  'si existe una razon CONCRETA para no avisar.',
  '',
  'Contexto que debes tener en cuenta:',
  '- Si xgIsEstimated es true, el xG NO es real: esta estimado a partir de remates',
  '  y esta medido que no correlaciona con el resultado. No bases tu decision en el.',
  '- El modelo YA incorpora minutos restantes, marcador y ritmo de la liga.',
  '  No los penalices otra vez salvo que veas algo que el modelo no puede ver.',
  '',
  'RECHAZA (alert:false) solo si: el partido esta resuelto y sin urgencia, la',
  'competicion es de muy bajo scoring sin señal de ruptura, o el volumen de juego',
  'es claramente esteril (posesion sin llegada).',
  'APRUEBA (alert:true) si no hay una razon concreta en contra.',
  '',
  'Responde SOLO JSON valido: {"alert":true|false,"confidence":0-100,"reason":"max 20 palabras"}',
].join('\n');

function buildPrompt(r, gate) {
  const s = r.stats || {};
  const payload = {
    match: (r.teamHome || '') + ' vs ' + (r.teamAway || ''),
    league: r.league || '',
    leagueGoalsPerMatch: r.leagueGoalsPerMatch || null,
    minute: r.minute,
    minutesRemaining: r.minsLeft,
    scoreline: (r.scoreHome || 0) + '-' + (r.scoreAway || 0),
    goalDifference: gate.gd,
    modelProbUntilFT: Math.round((r.probability || 0) * 100),
    modelProbNext15min: Math.round((r.prob15 || 0) * 100),
    xgHome: s.xgHome, xgAway: s.xgAway,
    xgIsEstimated: s.xgSource !== 'flashscore',
    xgRemaining: gate.xgRemaining,
    bigChancesHome: s.bigChancesHome, bigChancesAway: s.bigChancesAway,
    sotHome: s.sotHome, sotAway: s.sotAway,
    boxHome: s.shotsInsideBoxHome, boxAway: s.shotsInsideBoxAway,
    redCards: (s.redCardsHome || 0) + (s.redCardsAway || 0),
  };
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

/**
 * @returns {Promise<{available:boolean, alert?:boolean, confidence?:number,
 *                    reason?:string, provider?:string, rawAlert?:boolean}>}
 */
async function reviewAlert(r, gate) {
  const p = provider();
  if (!p) return { available: false, alert: false, reason: 'sin API key' };

  try {
    const body = p.body(p.model, buildPrompt(r, gate));
    const { status, json, raw } = await postJson(p.host, p.path, p.headers(p.key), body);
    if (status < 200 || status >= 300) {
      const errMsg = (json && json.error && json.error.message) || (raw || '').slice(0, 120) || ('HTTP ' + status);
      // Si la IA falla NO se bloquea la alerta por un problema de infraestructura:
      // se deja pasar y se marca el fallo, para no perder avisos por una caida.
      return { available: true, alert: true, confidence: 0, reason: 'IA no disponible: ' + errMsg, provider: p.name, error: true };
    }
    const text = (p.parse(json) || '').replace(/```json|```/g, '').trim();
    const out = JSON.parse(text);
    const rawAlert = out.alert === true;
    const confidence = Math.max(0, Math.min(100, parseInt(out.confidence, 10) || 0));
    // Umbral de confianza. NO esta validado: su efecto real lo mide evaluate.js
    // comparando precision con IA vs sin IA sobre las mismas alertas.
    const MIN_CONF = parseInt(process.env.AI_MIN_CONFIDENCE || '60', 10);
    return {
      available: true,
      alert: rawAlert && confidence >= MIN_CONF,
      confidence,
      reason: String(out.reason || '').slice(0, 140),
      provider: p.name,
      model: p.model,
      rawAlert,
    };
  } catch (e) {
    return { available: true, alert: true, confidence: 0, reason: 'IA error: ' + String(e.message || e).slice(0, 100), provider: p.name, error: true };
  }
}

const isAvailable = () => !!provider();

function status() {
  const p = provider();
  if (!p) return { ok: false, message: 'Sin key. Crea .env con OPENAI_API_KEY o un secret en GitHub.' };
  return { ok: true, provider: p.name, model: p.model, keyLen: p.key.length };
}

/** Smoke test de la API (1 llamada barata) */
async function smokeTest() {
  const p = provider();
  if (!p) return { ok: false, error: 'sin key' };
  const fake = {
    teamHome: 'Test FC', teamAway: 'Sample United', league: 'Test League',
    minute: 55, minsLeft: 38, scoreHome: 0, scoreAway: 0,
    probability: 0.82, prob15: 0.41,
    stats: { xgHome: 1.4, xgAway: 0.9, bigChancesHome: 2, bigChancesAway: 1, sotHome: 5, sotAway: 3, shotsInsideBoxHome: 8, shotsInsideBoxAway: 4 },
  };
  const r = await reviewAlert(fake, { xgRemaining: 2.3, gd: 0, quality: 80 });
  return Object.assign({ ok: !r.error && r.available }, r);
}

module.exports = { reviewAlert, isAvailable, provider, status, smokeTest, buildPrompt };
