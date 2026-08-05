/**
 * notify.js — envia alertas por Telegram.
 *
 * Configuracion (variables de entorno):
 *   TELEGRAM_BOT_TOKEN = token del bot (de @BotFather)
 *   TELEGRAM_CHAT_ID   = id del chat
 *
 * El mensaje incluye SIEMPRE la precision medida del tier y su intervalo de
 * confianza. Una alerta sin su tasa de acierto historica invita a confiar de mas;
 * el numero va al lado del aviso a proposito.
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

const TIER_LABEL = {
  PRECISION: '🎯 ALTA PRECISION',
  VALOR: '💰 VALOR',
};

function buildMessage(alerts, model) {
  if (!alerts || !alerts.length) return null;
  const when = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  let msg = '<b>⚽ ALERTA GOL</b>  <i>' + esc(when) + '</i>\n\n';

  alerts.slice(0, 5).forEach((a) => {
    const g = a.gate || {};
    const gateInfo = (model && model.gates || []).find(x => x.tier === g.tier);
    msg += (TIER_LABEL[g.tier] || g.tier) + '\n';
    msg += '<b>' + esc(a.teamHome) + ' vs ' + esc(a.teamAway) + '</b>\n';
    msg += '   ' + Math.round((a.probability || 0) * 100) + '% de gol antes del final\n';
    msg += '   ⏱ ' + a.minute + "'  |  " + a.scoreHome + '-' + a.scoreAway + '\n';
    if (a.league) msg += '   🏆 ' + esc(a.league) + '\n';
    if (gateInfo) {
      msg += '   📊 este tipo de aviso acierta <b>' + (gateInfo.measuredPrecision * 100).toFixed(0) + '%</b>' +
        ' (IC ' + (gateInfo.ci95[0] * 100).toFixed(0) + '-' + (gateInfo.ci95[1] * 100).toFixed(0) + '%, n=' + gateInfo.n + ')\n';
    }
    if (a.aiDecision && a.aiDecision.reason) {
      msg += '   🤖 ' + esc(a.aiDecision.reason).slice(0, 120) + '\n';
    }
    msg += '\n';
  });

  if (alerts.some(a => (a.gate || {}).tier === 'PRECISION')) {
    msg += '<i>ALTA PRECISION responde "este partido tendra gol", no "viene un gol ya". ' +
      'Se dispara temprano, cuando aun queda casi todo el partido.</i>\n';
  }
  return msg;
}

module.exports = { sendTelegram, buildMessage };
