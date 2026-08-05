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

  let hayBarato = false;

  alerts.slice(0, 5).forEach((a) => {
    const g = a.gate || {};

    // ── Aviso de VALOR: manda NUESTRO analisis, la cuota es solo el precio ──
    if (g.tier === 'VALOR' && g.best) {
      const b = g.best;
      msg += '💰 <b>VALOR</b>\n';
      msg += '<b>' + esc(a.teamHome) + ' vs ' + esc(a.teamAway) + '</b>\n';
      if (a.league) msg += '   ' + esc(a.league) + '\n';
      msg += '   ⏱ ' + a.minute + "'  ·  " + a.scoreHome + '-' + a.scoreAway + '\n';
      msg += '   🎯 Apuesta: <b>' + esc(b.pick) + '</b> goles (final del partido)\n';
      msg += '   ⚽ Hacen falta ' + g.goalsNeeded + ' gol(es) más en ' + a.minsLeft + ' min\n';
      msg += '\n';
      msg += '   📊 <b>Nuestro análisis: ' + Math.round(b.p * 100) + '%</b>  (justo ' + b.fair + ')\n';
      msg += '   🏦 La casa paga: <b>' + b.odds + '</b>  (implícita ' + Math.round(100 / b.odds) + '%)\n';
      msg += '   🟢 <b>Valor esperado ' + (b.ev >= 0 ? '+' : '') + (b.ev * 100).toFixed(1) + '%</b>' +
        '  ·  ventaja ' + (b.edge >= 0 ? '+' : '') + (b.edge * 100).toFixed(1) + ' pts\n';
      if (a.aiDecision && a.aiDecision.reason) {
        msg += '   🤖 ' + esc(a.aiDecision.reason).slice(0, 120) + '\n';
      }
      msg += '\n';
      return;
    }

    const gateInfo = (model && model.gates || []).find(x => x.tier === g.tier);
    const p = a.probability || 0;
    const goles = (a.scoreHome || 0) + (a.scoreAway || 0);
    // La prediccion es "al menos un gol MAS". Con `goles` ya marcados, eso es
    // exactamente el mercado Over (goles + 0.5) al final del partido. Decirlo
    // evita la duda razonable de "¿esto es del partido o del primer tiempo?".
    const linea = goles + 0.5;
    const cuotaJusta = p > 0 ? 1 / p : null;

    msg += (TIER_LABEL[g.tier] || g.tier) + '\n';
    msg += '<b>' + esc(a.teamHome) + ' vs ' + esc(a.teamAway) + '</b>\n';
    if (a.league) msg += '   ' + esc(a.league) + '\n';
    msg += '   ⏱ ' + a.minute + "'  ·  " + a.scoreHome + '-' + a.scoreAway + '\n';
    msg += '   ➡️ <b>Al menos 1 gol MÁS</b>, del minuto ' + a.minute + " al 90'\n";
    msg += '   🎰 Equivale a: <b>Over ' + linea.toFixed(1) + '</b> goles al final del partido\n';
    msg += '   📈 ' + Math.round(p * 100) + '%';
    if (cuotaJusta) msg += '  ·  cuota justa <b>' + cuotaJusta.toFixed(2) + '</b>';
    msg += '\n';
    // Con la cuota justa tan baja ninguna casa paga por encima una vez aplicado
    // su margen. Avisarlo es mas util que dejar creer que un 95% es una ocasion.
    if (cuotaJusta && cuotaJusta < 1.15) {
      hayBarato = true;
      msg += '   ⚠️ Solo hay valor si te pagan MÁS de ' + cuotaJusta.toFixed(2) + '\n';
    }
    if (gateInfo) {
      msg += '   📊 avisos así aciertan <b>' + (gateInfo.measuredPrecision * 100).toFixed(0) + '%</b>' +
        ' (IC ' + (gateInfo.ci95[0] * 100).toFixed(0) + '-' + (gateInfo.ci95[1] * 100).toFixed(0) + '%, n=' + gateInfo.n + ')\n';
    }
    if (a.aiDecision && a.aiDecision.reason) {
      msg += '   🤖 ' + esc(a.aiDecision.reason).slice(0, 120) + '\n';
    }
    msg += '\n';
  });

  if (alerts.some(a => (a.gate || {}).tier === 'PRECISION')) {
    msg += '<i>ALTA PRECISION = "este partido tendra otro gol", no "viene un gol ya". ' +
      'Salta temprano, con casi todo el partido por delante.</i>\n';
  }
  if (hayBarato) {
    msg += '<i>Compara siempre la cuota justa con la que te ofrecen. Si te pagan menos, ' +
      'el aviso es correcto pero la apuesta pierde dinero a la larga.</i>\n';
  }
  return msg;
}

module.exports = { sendTelegram, buildMessage };
