import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { binary, configure, gatewayEnv, lockPath } from './config.js';
import { generate } from './protocol.js';

const boot = randomUUID();
const worker = new URL('/internal/runner', process.env.CLOUDFLARE_WORKER_URL);
const gateway = 'http://127.0.0.1:18789';
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const runnerSecret = process.env.RUNNER_SECRET;
const backend = process.env.CODESPACES === 'true' ? 'codespaces' : process.env.BACKEND || 'standalone';
if (!token || !runnerSecret) throw new Error('Missing OPENCLAW_GATEWAY_TOKEN or RUNNER_SECRET');
await configure();

let child;
let hold;
let parkRetryAt = 0;
const runFile = promisify(execFile);
let active;
let ending = false;

function startGateway() {
  if (child) return;
  const instance = spawn(binary, ['gateway', 'run'], { env: gatewayEnv(), stdio: 'inherit' });
  child = instance;
  instance.on('error', error => console.error('Gateway spawn:', error.code));
  instance.on('close', () => { if (child === instance) child = undefined; });
}

async function stopGateway() {
  if (!child) return;
  const instance = child;
  const closed = new Promise(resolve => instance.once('close', resolve));
  instance.kill('SIGTERM');
  const force = setTimeout(() => instance.kill('SIGKILL'), 15000);
  try { await closed; } finally { clearTimeout(force); }
}

async function ready() {
  if (!child) return false;
  try {
    const response = await fetch(gateway + '/readyz', { signal: AbortSignal.timeout(1500) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

async function call(op, data) {
  const response = await fetch(worker, {
    method: 'POST', signal: AbortSignal.timeout(16000),
    headers: { authorization: 'Bearer ' + runnerSecret, 'content-type': 'application/json' },
    body: JSON.stringify({ op, boot, ...data }),
  });
  if (!response.ok) throw new Error('Worker HTTP ' + response.status);
  return response.json();
}

async function probeLock() {
  const probe = spawn('flock', ['-xn', lockPath, 'true'], { stdio: 'ignore' });
  return (await once(probe, 'close'))[0] === 0;
}

async function canStopGateway(pid) {
  try {
    let offset = 0;
    do {
      const { stdout } = await runFile(binary, [
        'gateway', 'call', 'sessions.list', '--params', JSON.stringify({ limit: 100, offset }),
        '--json', '--timeout', '5000',
      ], { env: gatewayEnv(), timeout: 10000, maxBuffer: 8_000_000 });
      const { sessions, nextOffset, hasMore } = JSON.parse(stdout);
      if (!Array.isArray(sessions) || sessions.some(session => session.hasActiveRun || session.status === 'running' ||
          session.status === 'queued')) return false;
      if (hasMore && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset)) return false;
      offset = hasMore ? nextOffset : 0;
    } while (offset > 0);

    // The Gateway's process broker can keep tool subprocesses alive after the
    // turn ends. Ignore the broker and read-only DB helper, but inspect descendants.
    const { stdout } = await runFile('ps', ['-eo', 'pid=,ppid='], { timeout: 2500, maxBuffer: 4_000_000 });
    const children = new Map();
    for (const line of stdout.split('\n')) {
      const fields = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!fields) continue;
      const parent = Number(fields[2]);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(Number(fields[1]));
    }
    const isHelper = /[/]openclaw[/]dist[/](?:process[/]spawn-broker[/]worker\.js|infra[/]sqlite-readonly-location\.worker\.js)(?: |$)/;
    const descendants = [...(children.get(pid) ?? [])];
    while (descendants.length) {
      const descendant = descendants.pop();
      const args = await readFile('/proc/' + descendant + '/cmdline', 'utf8');
      if (!isHelper.test(args.replaceAll('\0', ' '))) return false;
      descendants.push(...(children.get(descendant) ?? []));
    }
    return true;
  } catch {
    return false;
  }
}

async function park() {
  if (hold || Date.now() < parkRetryAt) return;
  parkRetryAt = Date.now() + 8000;
  const candidate = spawn('flock', ['-xn', lockPath, 'sh', '-c', 'printf locked; cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  candidate.stdin.on('error', () => {});
  const acquired = await new Promise(resolve => {
    candidate.stdout.once('data', () => resolve(true));
    candidate.once('error', () => resolve(false));
    candidate.once('close', () => resolve(false));
  });
  if (!acquired) return;
  hold = candidate;
  if (child && !await canStopGateway(child.pid)) {
    unpark();
    return;
  }
  if (backend === 'standalone') await stopGateway();
}

function unpark() {
  hold?.stdin.end();
  hold = undefined;
}

function cancel(job, reason) {
  if (!job.controller.signal.aborted) {
    job.reason = reason;
    job.controller.abort();
  }
}

async function stream(job, model) {
  const identity = { id: job.id, lease: job.lease };
  const controller = job.controller;
  let text = '';
  let done = false;
  const draft = async () => {
    let lastText;
    let lastSent = 0;
    while (!done && !controller.signal.aborted) {
      if (text !== lastText || Date.now() - lastSent >= 20000) {
        try {
          const snapshot = text;
          const result = await call('draft', { ...identity, text: Array.from(snapshot).slice(0, 3900).join('') });
          if (result.cancelled || result.lost) cancel(job, result.lost ? 'lost' : 'user');
          if (result.retryAfter) {
            await sleep(result.retryAfter * 1000, undefined, { signal: controller.signal });
            continue;
          }
          lastText = snapshot;
          lastSent = Date.now();
        } catch {
          if (controller.signal.aborted) break;
        }
      }
      await sleep(1250, undefined, { signal: controller.signal }).catch(() => {});
    }
  };
  const draftTask = draft();
  try {
    await generate(gateway, token, job, model, controller.signal, delta => {
      if (text.length < 60000) text += delta;
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error.message);
      text += (text ? '\n\n' : '') + 'OpenClaw не смог завершить ответ. Проверьте подключение к модели и журнал шлюза.';
    }
  } finally {
    done = true;
    await draftTask;
  }
  while (!ending && job.reason !== 'lost') {
    try {
      await call('finish', { ...identity, text });
      return;
    } catch {
      await sleep(1500);
    }
  }
}

process.on('SIGTERM', () => { ending = true; if (active) cancel(active, 'lost'); });
process.on('SIGINT', () => { ending = true; if (active) cancel(active, 'lost'); });

let lastContact = Date.now();
try {
  while (!ending) {
    let delay = 3000;
    try {
      const result = await call('poll', {
        ...(active ? { id: active.id, lease: active.lease } : {}),
        ready: await ready(), parked: !!hold, cliBusy: hold ? false : !await probeLock(),
      });
      lastContact = Date.now();
      switch (result.mode) {
        case 'wake':
          unpark();
          startGateway();
          break;
        case 'park':
          if (!active) await park();
          break;
        case 'standby':
          if (backend === 'standalone' && hold) unpark();
          delay = hold ? 3000 : 10000;
          break;
        case 'idle':
          unpark();
          break;
        case 'job':
          unpark();
          if (!active) {
            const job = { ...result.job, controller: new AbortController() };
            active = job;
            if (job.cancelled) cancel(job, 'user');
            void stream(job, result.model).catch(() => console.error('Runner job failed')).finally(() => { active = undefined; });
          }
          delay = 1000;
          break;
        case 'active':
          if (result.cancelled && active) cancel(active, 'user');
          delay = 1000;
          break;
        case 'lost':
          if (active) cancel(active, 'lost');
          break;
      }
    } catch {
      if (active && Date.now() - lastContact > 40000) cancel(active, 'lost');
      delay = 3000;
    }
    await sleep(delay);
  }
} finally {
  unpark();
  await stopGateway();
}
