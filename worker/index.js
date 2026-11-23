import { Control } from './control.js';
import { github, json, miniAppOwner, same, usageTotal } from './services.js';

export { Control };
let cachedUsage;
async function billing(env) {
  const limit = Number(env.GH_MONTHLY_CORE_HOURS || 120);
  if (!env.GH_LOGIN || !env.GH_BILLING_TOKEN) return { limit, used: null };
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  if (cachedUsage?.year === year && cachedUsage.month === month && cachedUsage.until > Date.now()) {
    return cachedUsage.value;
  }
  try {
    const path = '/users/' + encodeURIComponent(env.GH_LOGIN) + '/settings/billing/usage/summary';
    const report = await github(env.GH_BILLING_TOKEN, path + '?' + new URLSearchParams({ year, month, product: 'codespaces' }));
    if (!Array.isArray(report?.usageItems)) throw new Error('Unexpected GitHub Billing response');
    const value = { limit, used: usageTotal(report.usageItems), updatedAt: now.toISOString(), year, month };
    cachedUsage = { year, month, until: Date.now() + 300000, value };
    return value;
  } catch {
    return { limit, used: null, unavailable: true };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const controller = () => env.CONTROL.get(env.CONTROL.idFromName('primary'));
    const forward = (path, payload) => controller().fetch('https://control.internal/' + path, {
      method: 'POST', body: JSON.stringify(payload),
    });
    try {
      if (pathname === '/telegram' && request.method === 'POST') {
        if (!same(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET)) {
          return json({ error: 'Forbidden' }, 403);
        }
        return await forward('telegram', await request.json());
      }
      if (pathname === '/internal/runner' && request.method === 'POST') {
        if (!same(request.headers.get('authorization'), 'Bearer ' + (env.RUNNER_SECRET || '')) || !env.RUNNER_SECRET) {
          return json({ error: 'Forbidden' }, 403);
        }
        return await forward('runner', await request.json());
      }
      if (pathname.startsWith('/api/')) {
        if (!await miniAppOwner(request.headers.get('x-telegram-init-data'), env.TELEGRAM_BOT_TOKEN, env.OWNER_ID)) {
          return json({ error: 'Откройте панель из Telegram с аккаунта владельца.' }, 403);
        }
        if (pathname === '/api/usage' && request.method === 'GET') return json(await billing(env));
        if (pathname === '/api/status' && request.method === 'GET') return await forward('status', {});
        if (pathname === '/api/settings' && request.method === 'POST') return await forward('settings', await request.json());
        if (pathname === '/api/power' && request.method === 'POST') return await forward('power', await request.json());
        return json({ error: 'Маршрут не найден.' }, 404);
      }
      if (request.method === 'GET' || request.method === 'HEAD') return env.ASSETS.fetch(request);
      return json({ error: 'Маршрут не найден.' }, 404);
    } catch (error) {
      console.error('Worker request failed', pathname, error.name);
      return json({ error: 'Сервис временно недоступен.' }, 503);
    }
  },
};
