/**
 * Filtro IA de segunda opinion para alertas BORDERLINE.
 *
 * Prioridad de providers:
 *   1. OPENAI_API_KEY  → gpt-4o-mini (barato, JSON fiable)  ← recomendado si pagas OpenAI
 *   2. GROQ_API_KEY    → llama-3.3-70b (gratis, rapido)
 *   3. ANTHROPIC_API_KEY → claude haiku
 *
 * Keys:
 *   - Local: archivo .env (ver .env.example)
 *   - GitHub Actions: Settings → Secrets → OPENAI_API_KEY
 *
 * Nota: ChatGPT Plus NO incluye API automaticamente.
 * Hay que crear key en https://platform.openai.com/api-keys
 * (billing de API es aparte del Plus).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Cargar .env local sin dependencia externa
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
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
      // gpt-4o-mini: barato, rapido, excelente en JSON estructurado
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      headers: (key) => ({
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      }),
      body: (model, messages) => JSON.stringify({
        model, messages, temperature: 0.05, max_tokens: 220,
        response_format: { type: 'json_object' }
      }),
      parse: (j) => j.choices?.[0]?.message?.content || ''
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      name: 'groq',
      key: process.env.GROQ_API_KEY,
      host: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      model: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
      headers: (key) => ({
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      }),
      body: (model, messages) => JSON.stringify({
        model, messages, temperature: 0.05, max_tokens: 220,
        response_format: { type: 'json_object' }
      }),
      parse: (j) => j.choices?.[0]?.message?.content || ''
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: 'anthropic',
      key: process.env.ANTHROPIC_API_KEY,
      host: 'api.anthropic.com',
      path: '/v1/messages',
      model: process.env.AI_MODEL || 'claude-3-5-haiku-20241022',
      headers: (key) => ({
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      }),
      body: (model, messages) => {
        const sys = messages.find(m => m.role === 'system')?.content || '';
        const user = messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
        return JSON.stringify({
          model, max_tokens: 220, system: sys,
          messages: [{ role: 'user', content: user }]
        });
      },
      parse: (j) => j.content?.[0]?.text || ''
    };
  }
  return null;
}

function postJson(host, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path: reqPath, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 25000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d), raw: d }); }
        catch (e) { reject(new Error('AI JSON parse: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('AI timeout')); });
    req.write(body);
    req.end();
  });
}

function buildPrompt(r, gate) {
  const s = r.stats || {};
  const payload = {
    match: (r.teamHome || '') + ' vs ' + (r.teamAway || ''),
    league: r.league || '',
    minute: r.minute,
    scoreline: (r.scoreHome || 0) + '-' + (r.scoreAway || 0),
    modelProbUntilFT: r.score,
    modelProbNext15min: r.score15,
    xgHome: s.xgHome, xgAway: s.xgAway,
    xgRemaining: gate.xgRemaining,
    bigChancesHome: s.bigChancesHome, bigChancesAway: s.bigChancesAway,
    sotHome: s.sotHome, sotAway: s.sotAway,
    boxHome: s.shotsInsideBoxHome, boxAway: s.shotsInsideBoxAway,
    gd: gate.gd,
    quality: gate.quality,
    reasons: r.reasons || []
  };

  return [
    {
      role: 'system',
      content:
        'Eres un filtro anti falso-positivo de alertas de gol en vivo. ' +
        'El modelo estadistico ya marco alta probabilidad. Tu SOLO apruebas si hay ' +
        'peligro REAL de gol en los proximos 10-15 minutos.\n' +
        'RECHAZA (alert:false) si:\n' +
        '- Ventaja comoda / partido resuelto\n' +
        '- xG restante flojo sin big chances recientes\n' +
        '- Liga/contexto de bajo scoring sin evidencia de ruptura\n' +
        '- Minuto muy tarde con poco tiempo y sin oleada clara\n' +
        '- Stats infladas pero sin peligro (posesion vacia)\n' +
        'APRUEBA (alert:true) solo con confluencia: xG residual alto + ocasiones + urgencia.\n' +
        'Se conservador: ante duda, alert:false.\n' +
        'Responde SOLO JSON valido: {"alert":true|false,"confidence":0-100,"reason":"max 25 palabras"}'
    },
    { role: 'user', content: JSON.stringify(payload) }
  ];
}

/**
 * @returns {Promise<{available:boolean, alert?:boolean, confidence?:number, reason?:string, provider?:string}>}
 */
async function reviewAlert(r, gate) {
  const p = provider();
  if (!p) return { available: false, reason: 'sin API key — pon OPENAI_API_KEY en .env o GitHub Secrets' };

  try {
    const messages = buildPrompt(r, gate);
    const body = p.body(p.model, messages);
    const { status, json, raw } = await postJson(p.host, p.path, p.headers(p.key), body);
    if (status < 200 || status >= 300) {
      const errMsg = json?.error?.message || raw?.slice(0, 120) || ('HTTP ' + status);
      return { available: true, alert: false, confidence: 0, reason: 'AI error: ' + errMsg, provider: p.name, error: true };
    }
    const text = p.parse(json);
    const cleaned = (text || '').replace(/```json|```/g, '').trim();
    const out = JSON.parse(cleaned);
    const rawAlert = out.alert === true;
    const confidence = Math.max(0, Math.min(100, parseInt(out.confidence, 10) || 0));
    // Conservador: hace falta alert:true Y confidence>=75
    const pass = rawAlert && confidence >= 75;
    return {
      available: true,
      alert: pass,
      confidence,
      reason: String(out.reason || '').slice(0, 140),
      provider: p.name,
      model: p.model,
      rawAlert
    };
  } catch (e) {
    return {
      available: true,
      alert: false,
      confidence: 0,
      reason: 'AI error: ' + (e.message || e).toString().slice(0, 100),
      provider: p.name,
      error: true
    };
  }
}

function isAvailable() {
  return !!provider();
}

function status() {
  const p = provider();
  if (!p) return { ok: false, message: 'Sin key. Crea .env con OPENAI_API_KEY o secret en GitHub.' };
  return { ok: true, provider: p.name, model: p.model, keyLen: p.key.length };
}

/** Smoke test de la API (1 llamada barata) */
async function smokeTest() {
  const p = provider();
  if (!p) return { ok: false, error: 'sin key' };
  const fake = {
    teamHome: 'Test FC', teamAway: 'Sample United', league: 'Test League',
    minute: 72, scoreHome: 0, scoreAway: 0, score: 88, score15: 70,
    stats: {
      xgHome: 1.4, xgAway: 0.9, bigChancesHome: 2, bigChancesAway: 1,
      sotHome: 5, sotAway: 3, shotsInsideBoxHome: 8, shotsInsideBoxAway: 4
    },
    reasons: ['test smoke']
  };
  const gate = { xgRemaining: 2.3, gd: 0, quality: 80 };
  const r = await reviewAlert(fake, gate);
  return { ok: !r.error && r.available, ...r };
}

module.exports = { reviewAlert, isAvailable, provider, status, smokeTest };
