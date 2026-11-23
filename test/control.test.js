import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Control } from '../worker/control.js';
import { miniAppOwner, usageTotal } from '../worker/services.js';

function setup(backend = 'codespaces') {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_queue.sql', import.meta.url), 'utf8'));
  const data = new Map();
  const storage = {
    get: async key => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    getAlarm: async () => data.get('alarm') ?? null,
    setAlarm: async value => data.set('alarm', value),
  };
  const env = {
    BACKEND: backend, MODELS_JSON: '["alpha","beta"]', OWNER_ID: '123', TELEGRAM_BOT_TOKEN: 'bot',
    CODESPACE_NAME: 'test-space', GH_CODESPACES_TOKEN: 'test',
    DB: { prepare: sql => ({ bind: (...args) => ({
      first: async () => db.prepare(sql).get(...args),
      run: async () => ({ meta: db.prepare(sql).run(...args) }),
    }) }) },
  };
  const control = new Control({ storage }, env);
  const post = async (path, body = {}) => {
    const response = await control.fetch(new Request('https://internal/' + path, { method: 'POST', body: JSON.stringify(body) }));
    assert.equal(response.status, 200);
    return response.json();
  };
  const tick = async () => { data.delete('alarm'); await control.alarm(); };
  const message = (update_id, text) => post('telegram', {
    update_id, message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, text },
  });
  return { data, db, post, tick, message };
}
const runner = (post, boot) => data => post('runner', { op: 'poll', boot, ready: true, ...data });

test('Codespaces deduplicates boot, leases once, cancels by Telegram draft, drains and wakes for a new message', async t => {
  const { post, tick, message, db, data } = setup();
  let githubState = 'Shutdown';
  const actions = [];
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/start')) { actions.push('start'); githubState = 'Available'; }
    if (path.endsWith('/stop')) { actions.push('stop'); githubState = 'ShuttingDown'; }
    if (path.includes('/bot')) {
      sent.push({ path, body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: true });
    }
    return Response.json({ state: githubState });
  });
  const boot = randomUUID();
  const poll = runner(post, boot);
  await Promise.all([message(11, 'first'), message(11, 'first')]);
  await tick();
  await tick();
  assert.deepEqual(actions, ['start']);
  assert.equal((await post('status')).phase, 'starting');
  await post('settings', { model: 'beta', sleepMinutes: 5 });
  const { job, model } = await poll();
  assert.equal(job.prompt, 'first');
  assert.equal(model, 'beta');
  assert.equal((await poll()).job.lease, job.lease);
  assert.equal((await runner(post, randomUUID())()).mode, 'standby');
  const jobId = { id: job.id, lease: job.lease };
  await post('runner', { op: 'draft', boot, ...jobId, text: 'partial' });
  assert.equal(sent[0].body.can_stop, true);
  assert.equal(sent[0].body.draft_id, job.id);
  await post('telegram', { stopped_message_generation: { chat: { id: 123, type: 'private' }, draft_id: job.id } });
  assert.equal((await poll(jobId)).cancelled, true);
  await post('power', { action: 'stop' });
  await tick();
  assert.deepEqual(actions, ['start']);
  await post('runner', { op: 'finish', boot, ...jobId, text: 'partial' });
  assert.equal((await poll()).mode, 'park');
  await poll({ parked: true });
  const advanceGit = () => { data.get('lifecycle').nextGit = 0; };
  advanceGit();
  await tick();
  assert.equal(sent[1].body.text, 'partial\n\nОтвет остановлен.');
  assert.deepEqual(actions, ['start', 'stop']);
  await message(12, 'wake again');
  assert.equal((await poll({ parked: true })).mode, 'park');
  githubState = 'Shutdown';
  advanceGit();
  await tick();
  assert.equal((await post('status')).phase, 'starting');
  await tick();
  assert.deepEqual(actions, ['start', 'stop', 'start']);
  assert.equal((await runner(post, randomUUID())()).job.prompt, 'wake again');
  assert.equal(db.prepare('SELECT count(*) AS n FROM inbox').get().n, 2);
});

test('automatic sleep waits for a leased job and uses the last message timestamp', async t => {
  const { post, tick, message, data } = setup('standalone');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, result: true }));
  const boot = randomUUID();
  const poll = runner(post, boot);
  await message(21, 'work');
  const { job } = await poll();
  data.get('lifecycle').activity = Date.now() - 301000;
  await tick();
  assert.equal((await post('status')).drain, false);
  await post('runner', { op: 'finish', boot, id: job.id, lease: job.lease, text: 'done' });
  await message(22, 'next request');
  await tick();
  assert.equal((await post('status')).drain, false);
  const next = (await poll()).job;
  await post('runner', { op: 'finish', boot, id: next.id, lease: next.lease, text: 'done' });
  data.get('lifecycle').nextDelivery = Date.now() + 600000;
  data.get('lifecycle').activity = Date.now() - 301000;
  await tick();
  assert.equal((await poll()).mode, 'park');
  await poll({ parked: true });
  assert.equal((await post('status')).phase, 'asleep');
});

test('manual Codespace stop recovers from a missing runner with a stored boot ID', async t => {
  const { data, post, tick, message } = setup();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let githubState = 'Available';
  const actions = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const action = new URL(url).pathname.split('/').pop();
    if (action === 'stop' || action === 'start') {
      actions.push(action);
      githubState = action === 'stop' ? 'ShuttingDown' : 'Available';
    }
    return Response.json({ state: githubState });
  });
  await post('power', { action: 'start' });
  const boot = randomUUID();
  const poll = runner(post, boot);
  assert.equal((await poll()).mode, 'idle');
  data.get('lifecycle').error = 'Previous startup error';
  await post('power', { action: 'stop' });
  await message(31, 'resume after stop');
  assert.equal((await post('status')).phase, 'stopping');
  assert.equal((await post('status')).error, null);

  now += 179000;
  await tick();
  assert.deepEqual(actions, []);
  now += 16000;
  assert.equal((await poll()).mode, 'park');
  await tick();
  assert.deepEqual(actions, [], 'a healthy runner may still be draining');

  now += 180001;
  assert.equal(data.get('lifecycle').boot, boot);
  await tick();
  assert.deepEqual(actions, ['stop']);
  githubState = 'Shutdown';
  now += 15000;
  await tick();
  assert.equal((await post('status')).phase, 'starting');
  await tick();
  assert.deepEqual(actions, ['stop', 'start']);
  assert.equal((await runner(post, randomUUID())()).job.prompt, 'resume after stop');
});

test('Mini App validates Telegram signatures, expiry and the configured owner', async () => {
  const user = JSON.stringify({ id: 123, first_name: 'Тест' });
  const token = 'sample:token';
  const seconds = 1800000000;
  const raw = new URLSearchParams({ user, auth_date: String(seconds), query_id: 'abc' });
  raw.sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update([...raw].map(([k, v]) => k + '=' + v).join('\n')).digest('hex');
  raw.set('hash', hash);
  assert.equal(await miniAppOwner(raw.toString(), token, '123', seconds * 1000), true);
  assert.equal(await miniAppOwner(raw.toString(), token, '999', seconds * 1000), false);
  assert.equal(await miniAppOwner(raw.toString(), token, '123', (seconds + 3601) * 1000), false);
  raw.set('query_id', 'tampered');
  assert.equal(await miniAppOwner(raw.toString(), token, '123', seconds * 1000), false);
});

test('GitHub usage aggregates compute SKUs and excludes storage', () => {
  assert.equal(usageTotal([
    { product: 'Codespaces', sku: 'codespaces_compute_d2', grossQuantity: 5, unitType: 'hours' },
    { product: 'codespaces', sku: 'Codespaces compute (4-core)', grossQuantity: 30, unitType: 'minutes' },
    { product: 'codespaces', sku: 'codespaces_compute_d8', grossQuantity: 7, unitType: 'core-hours' },
    { product: 'codespaces', sku: 'codespaces_storage', grossQuantity: 100, unitType: 'GB-hours' },
  ]), 19);
});
