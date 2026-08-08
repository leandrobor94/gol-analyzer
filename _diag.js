const { providers, postJson } = require('./ai_filter');
(async () => {
  const list = providers();
  console.log('proveedores configurados:', list.length, list.map(p => p.name + '/' + p.model).join(', '));
  console.log('keys presentes:', ['GROQ_API_KEY','NVIDIA_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY']
    .map(k => k + '=' + (process.env[k] ? 'si(' + process.env[k].length + ')' : 'NO')).join(' '));
  const msgs = [{ role: 'system', content: 'Responde SOLO JSON: {"goles":2.6,"confianza":50,"razon":"x"}' },
                { role: 'user', content: '{"local":"Bayern","visitante":"Dortmund","competicion":"Bundesliga"}' }];
  for (const p of list) {
    try {
      let r = await postJson(p.host, p.path, p.headers(p.key), p.body(p.model, msgs));
      console.log('--- ' + p.name + ' status=' + r.status);
      console.log('    raw: ' + String(r.raw || '').slice(0, 400).replace(/\n/g, ' '));
      if (r.status >= 200 && r.status < 300) console.log('    parse(): ' + String(p.parse(r.json)).slice(0, 200));
    } catch (e) { console.log('--- ' + p.name + ' EXCEPCION ' + e.message); }
  }
})();
