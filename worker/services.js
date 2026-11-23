const encoder = new TextEncoder();
const headers = { 'cache-control': 'no-store' };
export const json = (value, status = 200) => Response.json(value, { status, headers });

export function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)));
}

export async function miniAppOwner(raw, botToken, owner, now = Date.now()) {
  if (!raw || !botToken || !owner || raw.length > 12000) return false;
  const fields = new URLSearchParams(raw);
  if (new Set(fields.keys()).size !== Array.from(fields.keys()).length) return false;
  const hash = fields.get('hash');
  const authDate = Number(fields.get('auth_date'));
  const age = now - authDate * 1000;
  if (!/^[a-f0-9]{64}$/.test(hash ?? '') || !Number.isSafeInteger(authDate) || age < -30000 || age > 3600000) return false;
  fields.delete('hash');
  fields.sort();
  const body = Array.from(fields, ([key, value]) => key + '=' + value).join('\n');
  const secret = await hmac(encoder.encode('WebAppData'), botToken);
  const signature = Array.from(await hmac(secret, body), byte => byte.toString(16).padStart(2, '0')).join('');
  if (!same(signature, hash)) return false;
  try {
    return String(JSON.parse(fields.get('user')).id) === owner;
  } catch {
    return false;
  }
}

export function models(env) {
  const list = JSON.parse(env.MODELS_JSON);
  if (!Array.isArray(list) || !list.length || list.some(id => typeof id !== 'string' || !/^[\w./:@+-]{1,160}$/.test(id))) {
    throw new Error('Некорректный MODELS_JSON');
  }
  return [...new Set(list)];
}

export async function telegram(env, method, data) {
  const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    const error = new Error('Telegram ' + method + ' ' + response.status);
    error.retryAfter = result.parameters?.retry_after;
    throw error;
  }
  return result.result;
}

export async function github(token, path, method = 'GET') {
  if (!token) throw new Error('Токен GitHub не настроен');
  const response = await fetch('https://api.github.com' + path, {
    method, headers: {
      authorization: 'Bearer ' + token, accept: 'application/vnd.github+json',
      'user-agent': 'openclaw-telegram-worker', 'x-github-api-version': '2026-03-10',
    }, signal: AbortSignal.timeout(6500),
  });
  if (!response.ok) throw new Error('GitHub API ' + response.status);
  return response.status === 204 ? null : response.json();
}

export function usageTotal(items) {
  let total = 0;
  for (const item of items) {
    if (!/^codespaces$/i.test(item.product ?? '')) continue;
    const sku = String(item.sku);
    const machine = /^codespaces_compute_d(\d+)$/i.exec(sku) ??
      /^codespaces compute \((\d+)-core\)$/i.exec(sku);
    if (!machine) {
      if (/storage/i.test(sku)) continue;
      throw new Error('Неизвестная позиция GitHub Billing');
    }
    const unit = String(item.unitType).toLowerCase().replaceAll('-', ' ');
    const quantity = Number(item.grossQuantity ?? item.quantity);
    if (!/^(?:core )?(?:hours?|minutes?)$/.test(unit) || !Number.isFinite(quantity) || quantity < 0) {
      throw new Error('Неизвестная единица GitHub Billing');
    }
    const scale = unit.startsWith('core ') ? 1 : Number(machine[1]);
    total += quantity * scale / (unit.includes('minute') ? 60 : 1);
  }
  return total;
}

export function chunks(text, size = 3900) {
  const points = Array.from(text);
  const result = [];
  for (let offset = 0; offset < points.length; offset += size) {
    result.push(points.slice(offset, offset + size).join(''));
  }
  return result;
}
