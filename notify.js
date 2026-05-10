/**
 * notify.js — Envía alertas por Telegram cuando se detecta alta probabilidad de gol.
 *
 * Configuración (variables de entorno):
 *   TELEGRAM_BOT_TOKEN = token de tu bot (de @BotFather)
 *   TELEGRAM_CHAT_ID   = tu ID de chat en Telegram
 *
 * Uso:
 *   const notify = require('./notify');
 *   await notify.sendAlert('📊 Partido: Barcelona vs Madrid ...');
 */

const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

function sendTelegram(message) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN || !CHAT_ID) {
      console.log('  ⚠️ Telegram no configurado. Define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID');
      console.log('  📖 Ver: TELEGRAM_SETUP.md');
      return resolve(false);
    }

    const text = encodeURIComponent(message.slice(0, 4000));
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${text}&parse_mode=HTML`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const ok = JSON.parse(data).ok;
        if (ok) console.log('  -> Alerta Telegram enviada');
        else console.log('  -> Error al enviar Telegram');
        resolve(ok);
      });
    }).on('error', (err) => {
      console.log(`  -> Error Telegram: ${err.message}`);
      resolve(false);
    });
  });
}

function buildMessage(ranked) {
  const top = ranked.filter(r => r.score >= 70);
  if (top.length === 0) return null;

  let msg = `<b>⚽ ALERTA GOL — ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</b>\n\n`;

  top.forEach((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
    msg += `${medal} <b>${r.teamHome} vs ${r.teamAway}</b>\n`;
    msg += `   🔥 ${r.score}% de probabilidad\n`;
    if (r.league) msg += `   🏆 ${r.league}\n`;
    if (r.minute) msg += `   ⏱ ${r.minute}' | ${r.scoreHome}-${r.scoreAway}\n`;
    msg += `   ${r.timeWindow}\n`;
    msg += `   ${r.verdict}\n`;
    if (r.whoText) {
      const who = r.whoText.replace('\n     ', '');
      msg += `   ${who}\n`;
    }
    msg += '\n';
  });

  msg += `<i>📊 sofastats (Flashscore)</i>`;
  return msg;
}

module.exports = {
  sendTelegram,
  buildMessage
};
