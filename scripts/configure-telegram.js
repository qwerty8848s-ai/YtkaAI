const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const owner = Number(process.env.OWNER_ID);
if (!token || !/^[\w-]{1,256}$/.test(secret ?? '') || !Number.isSafeInteger(owner) || owner <= 0) {
  throw new Error('Задайте TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET и OWNER_ID.');
}
const origin = new URL(process.env.CLOUDFLARE_WORKER_URL);
if (origin.protocol !== 'https:') throw new Error('CLOUDFLARE_WORKER_URL должен использовать HTTPS.');
async function telegram(method, payload) {
  let response;
  try {
    response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Telegram API недоступен.');
  }
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(method + ' завершился с HTTP ' + response.status);
  return data.result;
}
await telegram('setWebhook', {
  url: new URL('/telegram', origin).href, secret_token: secret,
  allowed_updates: ['message', 'stopped_message_generation'],
});
await telegram('setChatMenuButton', {
  chat_id: owner, menu_button: { type: 'web_app', text: 'Пульт OpenClaw', web_app: { url: origin.origin + '/' } },
});
const info = await telegram('getWebhookInfo', {});
console.log('Webhook:', info.url, 'Типы:', info.allowed_updates.join(', '));
