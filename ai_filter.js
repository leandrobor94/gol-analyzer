/**
 * Filtro IA de segunda opinion para alertas BORDERLINE.
 *
 * No sustituye al modelo estadistico: solo veta/aprueba candidatos
 * que ya pasaron score>=80 y xgRem>=1.0.
 *
 * Providers (primera key encontrada):
 *   OPENAI_API_KEY  → api.openai.com  model gpt-4o-mini
 *   GROQ_API_KEY    → api.groq.com    model llama-3.3-70b
 *   ANTHROPIC_API_KEY → api.anthropic.com model claude-3-5-haiku
 *
 * Si no hay key: devuelve { available:false } y el pipeline
 * solo envia tier STRONG (medido >=90%).
 */

const https = require('https');

function provider() {
  if (process.env.OPENAI_API_KEY) {
    return {
      name: 'openai',
      key: process.env.OPENAI_API_KEY,
      host: 'api.openai.com',
      path: '/v1/chat/completions',
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      headers: (key) => ({
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      }),
      body: (model, messages) => JSON.stringify({
        model, messages, temperature: 0.1, max_tokens: 200,
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
        model, messages, temperature: 0.1, max_tokens: 200,
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
          model, max_tokens: 200, system: sys,
          messages: [{ role: 'user', content: user }]
        });
      },
      parse: (j) => j.content?.[0]?.text || ''
    };
  }
  return null;
}

function postJson(host, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
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
    score: (r.scoreHome || 0) + '-' + (r.scoreAway || 0),
    modelProbability: r.score,
    modelProb15min: r.score15,
    xg: [s.xgHome, s.xgAway],
    xgRemaining: gate.xgRemaining,
    bigChances: [s.bigChancesHome, s.bigChancesAway],
    shotsOnTarget: [s.sotHome, s.sotAway],
    shotsInsideBox: [s.shotsInsideBoxHome, s.shotsInsideBoxAway],
    reasons: r.reasons || []
  };

  return [
    {
      role: 'system',
      content:
        'Eres un analista de live football betting. Tu trabajo es VETAR falsos positivos. ' +
        'El modelo ya dice alta probabilidad de gol antes del final. Tu decides si hay ' +
        'peligro REAL de gol en los proximos 10-15 minutos. ' +
        'Rechaza si: marcador ya resuelto, liga muy defensiva sin ocasiones claras, ' +
        'xG inflado sin big chances, minuto muerto, o stats no respaldan urgencia. ' +
        'Responde SOLO JSON: {"alert":true|false,"confidence":0-100,"reason":"max 20 palabras"}'
    },
    {
      role: 'user',
      content: JSON.stringify(payload)
    }
  ];
}

/**
 * @returns {Promise<{available:boolean, alert?:boolean, confidence?:number, reason?:string, provider?:string}>}
 */
async function reviewAlert(r, gate) {
  const p = provider();
  if (!p) return { available: false, reason: 'sin API key (OPENAI/GROQ/ANTHROPIC)' };

  try {
    const messages = buildPrompt(r, gate);
    const body = p.body(p.model, messages);
    const { status, json } = await postJson(p.host, p.path, p.headers(p.key), body);
    if (status < 200 || status >= 300) {
      return { available: true, alert: false, confidence: 0, reason: 'AI HTTP ' + status, provider: p.name, error: true };
    }
    const text = p.parse(json);
    const cleaned = (text || '').replace(/```json|```/g, '').trim();
    const out = JSON.parse(cleaned);
    const alert = out.alert === true;
    const confidence = Math.max(0, Math.min(100, parseInt(out.confidence, 10) || 0));
    // Exigir confianza minima para aprobar
    const pass = alert && confidence >= 70;
    return {
      available: true,
      alert: pass,
      confidence,
      reason: String(out.reason || '').slice(0, 120),
      provider: p.name,
      rawAlert: alert
    };
  } catch (e) {
    return { available: true, alert: false, confidence: 0, reason: 'AI error: ' + (e.message || e).toString().slice(0, 80), provider: p.name, error: true };
  }
}

function isAvailable() {
  return !!provider();
}

module.exports = { reviewAlert, isAvailable, provider };
