/**
 * _smoke.js — verificar que la IA CONTESTA antes de gastar 20 minutos midiendo.
 *
 * Dos veces en esta sesion un test devolvio "0 aporte" que en realidad era
 * "el modulo no llegaba a la red": una por un export que faltaba, otra por el
 * limite de tokens/minuto. Un resultado nulo es indistinguible de un fallo de
 * infraestructura si no se comprueba antes que el canal funciona.
 */
const { providers, postJson } = require('./ai_filter');

(async () => {
  const list = providers();
  console.log('secrets visibles:');
  for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY']) {
    const v = process.env[k];
    console.log('  ' + k.padEnd(16) + (v ? 'si (' + v.length + ' chars, ' + (v.split(',').length) + ' clave/s)' : 'NO'));
  }
  console.log('');
  console.log('providers en cascada: ' + (list.map(p => p.name).join(' -> ') || 'NINGUNO'));
  if (!list.length) { console.log('SIN PROVIDERS — el secret no llega al workflow'); process.exit(1); }

  const msgs = [
    { role: 'system', content: 'Estimas goles de futbol. Responde SOLO JSON: {"goles":2.6,"confianza":0-100,"razon":"breve"}' },
    { role: 'user', content: '{"local":"Bayern Munich","visitante":"Borussia Dortmund","competicion":"Bundesliga"}' },
  ];
  let vivos = 0;
  for (const p of list) {
    const t0 = Date.now();
    try {
      const { status, json, raw } = await postJson(p.host, p.path, p.headers(p.key), p.body(p.model, msgs));
      const ms = Date.now() - t0;
      if (status >= 200 && status < 300) {
        const txt = (p.parse(json) || '').replace(/```json|```/g, '').trim();
        // Un 200 NO basta. La familia 2.5 de Gemini puede devolver 200 con
        // texto vacio si el razonamiento se come el presupuesto de salida.
        // Lo que se verifica es que llega JSON parseable, no que hubo respuesta.
        let ok = false;
        try { ok = !!txt && typeof JSON.parse(txt) === 'object'; } catch {}
        if (ok) { console.log('  [OK]   ' + p.name.padEnd(10) + ms + 'ms  ' + txt.slice(0, 110).replace(/\s+/g, ' ')); vivos++; }
        else {
          const fr = (json.candidates && json.candidates[0] && json.candidates[0].finishReason) || '?';
          const um = (json.usageMetadata && JSON.stringify(json.usageMetadata)) || '';
          console.log('  [VACIO] ' + p.name.padEnd(9) + '200 pero sin JSON. finishReason=' + fr + ' ' + um.slice(0, 110));
        }
      } else {
        console.log('  [HTTP ' + status + '] ' + p.name.padEnd(10) + String(raw || '').slice(0, 200).replace(/\s+/g, ' '));
      }
    } catch (e) {
      console.log('  [EXC] ' + p.name.padEnd(10) + e.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log('');
  console.log(vivos ? 'CANAL VIVO — ' + vivos + ' provider(s) contestando. Se puede medir.'
                    : 'CANAL MUERTO — no medir nada hasta arreglarlo.');
  if (!vivos) process.exit(1);
})();
