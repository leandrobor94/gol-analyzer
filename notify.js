/**
 * notify.js — envia alertas por Telegram.
 *
 *   TELEGRAM_BOT_TOKEN = token del bot (de @BotFather)
 *   TELEGRAM_CHAT_ID   = id del chat
 *
 * El mensaje lleva SIEMPRE nuestra probabilidad y el precio minimo al que la
 * apuesta compensa. Un aviso sin precio invita a apostar a cualquier cuota, y
 * ahi es donde se pierde el dinero aunque el aviso sea correcto.
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

function sendTelegram(message) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN || !CHAT_ID) {
      console.log('  Telegram no configurado (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
      return resolve(false);
    }
    const body = new URLSearchParams({
      chat_id: CHAT_ID,
      text: message.slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: 'true',
    }).toString();

    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let ok = false;
        try { ok = JSON.parse(d).ok === true; } catch {}
        console.log(ok ? '  -> Alerta Telegram enviada' : '  -> Telegram rechazo el envio: ' + d.slice(0, 160));
        resolve(ok);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => { console.log('  -> Error Telegram: ' + e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const FASE = {
  '1T': '⏱ PRIMER TIEMPO',
  '2T': '⚡ SEGUNDA PARTE',
  'FINAL': '🔥 TRAMO FINAL',
};

function buildMessage(alerts) {
  if (!alerts || !alerts.length) return null;
  const when = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  const L = [];
  L.push('<b>⚽ ALERTA GOL</b>  <i>' + esc(when) + '</i>');
  L.push('');

  let enviadas = 0;
  for (const a of alerts.slice(0, 5)) {
    const g = a.gate || {};
    if (!g.bet) continue;
    enviadas++;

    L.push(FASE[g.phase] || g.phase);
    L.push('<b>' + esc(a.teamHome) + ' vs ' + esc(a.teamAway) + '</b>');
    if (a.league) L.push('   ' + esc(a.league));
    L.push('   ' + a.minute + "'  ·  " + a.scoreHome + '-' + a.scoreAway + '  ·  quedan ~' + g.horizon + ' min');
    L.push('');
    L.push('   🎯 <b>' + esc(g.bet) + '</b>');
    L.push('   📊 Nuestro análisis: <b>' + Math.round(g.p * 100) + '%</b>');

    if (g.hasOdds && g.odds) {
      L.push('   🏦 ' + esc(g.bookmaker || 'la casa') + ' paga <b>' + g.odds + '</b>  (justa ' + g.fair + ')');
      L.push('   🟢 <b>Valor esperado ' + (g.ev >= 0 ? '+' : '') + (g.ev * 100).toFixed(1) + '%</b>');
      if (g.revisar) {
        L.push('   ⚠️ <b>Ventaja muy grande</b> — comprueba la cuota y el marcador antes de entrar');
      }
      L.push('   <i>Verifica el precio antes de apostar: vale desde ' + g.target + '</i>');
    } else {
      // Sin cuota publicada la alerta se manda IGUAL. Lo que no se hace es
      // estimar lo que paga la casa: seria comparar el modelo consigo mismo.
      L.push('   💵 <b>Apuesta solo desde cuota ' + g.target + '</b>  (justa ' + g.fair + ')');
      L.push('   <i>Sin cuota publicada para este partido: búscala tú.</i>');
    }
    if (a.aiDecision && a.aiDecision.reason) {
      L.push('   🤖 ' + esc(a.aiDecision.reason).slice(0, 120));
    }
    L.push('');
  }
  if (!enviadas) return null;

  L.push('<i>La apuesta cambia con el momento: en el 1T se busca gol antes del ' +
    'descanso; del 45 al 70, gol de un equipo concreto; del 70 en adelante, gol ' +
    'de cualquiera. Así la cuota se mantiene en un rango que compensa el riesgo.</i>');
  return L.join('\n');
}

module.exports = { sendTelegram, buildMessage };
