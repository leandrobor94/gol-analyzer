const fs = require('fs');
const https = require('https');
const cp = require('child_process');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.log('Sin token'); process.exit(0); }

const offsetFile = 'telegram-offset.txt';
let offset = 0;
try { offset = parseInt(fs.readFileSync(offsetFile, 'utf8')); } catch {}

https.get('https://api.telegram.org/bot' + token + '/getUpdates?offset=' + (offset + 1) + '&timeout=5', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const r = JSON.parse(d);
      if (!r.ok) { console.log('API error'); process.exit(0); }
      let changed = false;
      for (const u of r.result) {
        const text = u.message?.text || '';
        const chatId = u.message?.chat?.id;
        if (!chatId) continue;
        fs.writeFileSync(offsetFile, String(u.update_id));

        if (text === '/pause') {
          fs.writeFileSync('alertas.json', JSON.stringify({ enabled: false }));
          console.log('/pause recibido');
          changed = true;
          https.get('https://api.telegram.org/bot' + token + '/sendMessage?chat_id=' + chatId + '&text=Alertas APAGADAS');
        } else if (text === '/resume') {
          fs.writeFileSync('alertas.json', JSON.stringify({ enabled: true }));
          console.log('/resume recibido');
          changed = true;
          https.get('https://api.telegram.org/bot' + token + '/sendMessage?chat_id=' + chatId + '&text=Alertas ENCENDIDAS');
        } else if (text === '/status') {
          const s = fs.existsSync('alertas.json') ? JSON.parse(fs.readFileSync('alertas.json','utf8')) : {enabled:true};
          https.get('https://api.telegram.org/bot' + token + '/sendMessage?chat_id=' + chatId + '&text=Alertas: ' + (s.enabled ? 'ENCENDIDAS' : 'APAGADAS'));
        }
      }
      // Confirmar updates en Telegram para que no se re-procesen aunque falle el push
      if (r.result.length > 0) {
        const lastId = r.result[r.result.length - 1].update_id;
        https.get('https://api.telegram.org/bot' + token + '/getUpdates?offset=' + (lastId + 1) + '&timeout=1');
      }
      if (changed) {
        cp.execSync('git config user.email "bot@sofastats"', { stdio: 'ignore' });
        cp.execSync('git config user.name "sofastats-bot"', { stdio: 'ignore' });
        cp.execSync('git add -f alertas.json telegram-offset.txt', { stdio: 'ignore' });
        cp.execSync('git diff --cached --quiet || (git commit -m "telegram cmd [skip ci]" && git push)', { stdio: 'ignore', timeout: 30000 });
      }
    } catch(e) { console.log('Error: ' + e.message); }
  });
}).on('error', (e) => console.log('Error: ' + e.message));
