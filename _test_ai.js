/**
 * Prueba la API de IA. Uso:
 *   1. Copia .env.example → .env
 *   2. Pega OPENAI_API_KEY=sk-...
 *   3. node _test_ai.js
 */
const ai = require('./ai_filter');

(async () => {
  console.log('=== AI STATUS ===');
  console.log(ai.status());
  if (!ai.isAvailable()) {
    console.log('\nNO HAY KEY CONFIGURADA.\n');
    console.log('Opcion A (recomendado si pagas OpenAI):');
    console.log('  1. Entra a https://platform.openai.com/api-keys');
    console.log('  2. Create new secret key');
    console.log('  3. Copia .env.example a .env y pega:');
    console.log('     OPENAI_API_KEY=sk-proj-...');
    console.log('  4. En GitHub: Settings → Secrets → Actions → New secret');
    console.log('     Name: OPENAI_API_KEY  Value: (la misma key)');
    console.log('\nOpcion B (gratis):');
    console.log('  1. https://console.groq.com/keys');
    console.log('  2. GROQ_API_KEY=gsk_... en .env y en GitHub Secrets');
    console.log('\nIMPORTANTE: ChatGPT Plus != API. La API se paga aparte en platform.openai.com');
    process.exit(1);
  }
  console.log('\n=== SMOKE TEST (1 llamada) ===');
  const r = await ai.smokeTest();
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) {
    console.log('\nFALLO. Revisa billing/key en el provider.');
    process.exit(2);
  }
  console.log('\nOK — IA lista. Provider:', r.provider, 'model confiable para BORDERLINE.');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(2);
});
