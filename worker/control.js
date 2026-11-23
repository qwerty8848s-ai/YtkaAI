import { chunks, github, json, models, telegram } from './services.js';

const LEASE_MS = 90000;
const FRESH_MS = 25000;
const STARTUP_MS = 180000;
const isId = value => Number.isSafeInteger(value) && value > 0;

export class Control {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.serial = Promise.resolve();
    this.cloud = env.BACKEND === 'codespaces';
  }

  serially(operation) {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {});
    return next;
  }

  async state() {
    return await this.ctx.storage.get('lifecycle') ?? {
      phase: 'asleep', wanted: false, drain: false, manual: false,
      committed: false, parked: false, activity: 0, seen: 0, boot: '',
      sleepMinutes: 5, model: models(this.env)[0], nextGit: 0,
    };
  }

  save(state) { return this.ctx.storage.put('lifecycle', state); }
  query(sql, ...params) { return this.env.DB.prepare(sql).bind(...params); }
  async active() {
    return this.query("SELECT * FROM inbox WHERE state = 'running' ORDER BY id LIMIT 1").first();
  }

  async schedule(delay = 1) {
    const when = Date.now() + delay;
    const scheduled = await this.ctx.storage.getAlarm();
    if (scheduled === null || scheduled > when) await this.ctx.storage.setAlarm(when);
  }

  fetch(request) {
    return this.serially(async () => {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      const state = await this.state();
      switch (path) {
        case '/telegram': return this.onTelegram(state, body);
        case '/runner': return this.onRunner(state, body);
        case '/power': return this.power(state, body);
        case '/settings': return this.settings(state, body);
        case '/status': {
          const { phase, drain, sleepMinutes, model, error } = state;
          return json({ phase, drain, sleepMinutes, model, error, models: models(this.env), backend: this.env.BACKEND });
        }
        default: return json({ error: 'Маршрут не найден.' }, 404);
      }
    });
  }

  want(state) {
    state.wanted = true;
    state.activity = Date.now();
    if (state.drain && !state.manual && !state.committed) {
      state.drain = false;
      state.parked = false;
    }
    if (!state.drain && state.phase === 'asleep') {
      state.phase = 'starting';
      state.startedAt = Date.now();
      state.nextGit = 0;
    }
  }

  async onTelegram(state, update) {
    const stopped = update.stopped_message_generation;
    if (stopped?.chat?.type === 'private' && String(stopped.chat.id) === this.env.OWNER_ID && isId(stopped.draft_id)) {
      await this.query("UPDATE inbox SET cancelled = 1 WHERE id = ? AND chat_id = ? AND state = 'running'",
        stopped.draft_id, stopped.chat.id).run();
      return json({ ok: true });
    }

    const message = update.message;
    if (message?.chat?.type !== 'private' || String(message.from?.id) !== this.env.OWNER_ID ||
        typeof message.text !== 'string' || !message.text.trim() || !isId(update.update_id)) return json({ ok: true });

    if (message.text === '/stop') {
      await this.query("UPDATE inbox SET cancelled = 1 WHERE chat_id = ? AND state = 'running' AND created <= ?",
        message.chat.id, message.date * 1000 + 999).run();
      return json({ ok: true });
    }
    // Schedule before committing D1. If saving lifecycle then fails, the same
    // update is retried and the alarm can recover a newly queued row.
    await this.schedule();
    const result = await this.query(
      'INSERT OR IGNORE INTO inbox(update_id, chat_id, thread_id, prompt, created) VALUES(?, ?, ?, ?, ?)',
      update.update_id, message.chat.id, message.message_thread_id ?? null, message.text, Date.now()).run();
    const recovery = result.meta.changes ? null : await this.query(
      "SELECT id FROM inbox WHERE update_id = ? AND state = 'queued' AND created > ?",
      update.update_id, Math.max(state.pauseThrough ?? 0, state.activity)).first();
    if (result.meta.changes || recovery) {
      this.want(state);
      await this.save(state);
    }
    return json({ ok: true });
  }

  async power(state, { action }) {
    if (action === 'start') {
      this.want(state);
    } else if (action === 'stop') {
      state.wanted = false;
      state.manual = state.phase !== 'asleep';
      state.drain = state.manual;
      state.pauseThrough = Date.now();
    } else {
      return json({ error: 'Неизвестное действие.' }, 400);
    }
    await this.schedule();
    await this.save(state);
    return json({ ok: true });
  }

  async settings(state, { model, sleepMinutes }) {
    if (!models(this.env).includes(model) || !Number.isInteger(sleepMinutes) || sleepMinutes < 1 || sleepMinutes > 60) {
      return json({ error: 'Выберите модель и интервал от 1 до 60 минут.' }, 400);
    }
    state.model = model;
    state.sleepMinutes = sleepMinutes;
    await this.schedule();
    await this.save(state);
    return json({ ok: true });
  }

  async onRunner(state, input) {
    const { op, boot, lease, id } = input;
    if (typeof boot !== 'string' || !/^[0-9a-f-]{36}$/.test(boot)) return json({ error: 'Invalid runner ID' }, 400);
    if (op === 'poll') return this.poll(state, input);
    if (!isId(id) || typeof lease !== 'string' || lease.length > 100 || !lease.startsWith(boot + ':')) {
      return json({ error: 'Invalid lease' }, 400);
    }
    const job = await this.query('SELECT * FROM inbox WHERE id = ? AND lease = ?', id, lease).first();
    if (!job) return json({ lost: true });
    if (op === 'finish' && (job.state === 'outbox' || job.state === 'done')) return json({ ok: true });
    if (state.boot !== boot || job.state !== 'running' || job.expires <= Date.now()) return json({ lost: true });

    if (op === 'draft') {
      if (job.cancelled) return json({ cancelled: true });
      if (typeof input.text !== 'string') return json({ error: 'Invalid draft' }, 400);
      try {
        await telegram(this.env, 'sendMessageDraft', {
          chat_id: job.chat_id, message_thread_id: job.thread_id ?? undefined,
          draft_id: job.id, text: chunks(input.text)[0] || 'Готовлю ответ…', can_stop: true, keep_on_stop: false,
        });
      } catch (error) {
        return json({ retryAfter: error.retryAfter ?? 2 });
      }
      return json({ ok: true });
    }
    if (op !== 'finish' || typeof input.text !== 'string') return json({ error: 'Invalid result' }, 400);
    const answer = job.cancelled
      ? (input.text.trim() ? input.text.slice(0, 60000) + '\n\nОтвет остановлен.' : 'Ответ остановлен.')
      : input.text.slice(0, 60000).trim() || 'OpenClaw завершил запрос без текста.';
    await this.schedule();
    await this.query("UPDATE inbox SET answer = ?, state = 'outbox', expires = NULL WHERE id = ? AND lease = ?",
      answer, id, lease).run();
    return json({ ok: true });
  }

  async poll(state, { boot, ready, parked, id, lease, cliBusy }) {
    const now = Date.now();
    if (state.boot && state.boot !== boot && now - state.seen < FRESH_MS) return json({ mode: 'standby' });

    let active = await this.active();
    if (active && active.expires <= now) {
      await this.schedule();
      await this.query("UPDATE inbox SET state = 'outbox', answer = ?, expires = NULL WHERE id = ?",
        active.cancelled ? 'Ответ остановлен.' : 'OpenClaw прервался во время обработки. Отправьте запрос снова.', active.id).run();
      active = null;
    }
    if (active && !active.lease.startsWith(boot + ':')) return json({ mode: 'standby' });

    if (state.boot !== boot || now - state.seen >= 8000) {
      state.boot = boot;
      state.seen = now;
      await this.save(state);
    }
    if (cliBusy && !state.drain && now - state.activity >= 8000) {
      state.activity = now;
      await this.save(state);
    }
    if (active) {
      if (active.expires - now < LEASE_MS - 10000) {
        await this.query('UPDATE inbox SET expires = ? WHERE id = ?', now + LEASE_MS, active.id).run();
      }
      if (id === active.id && lease === active.lease) return json({ mode: 'active', cancelled: !!active.cancelled });
      if (id) return json({ mode: 'lost' });
      return json({ mode: 'job', job: active, model: active.model });
    }
    if (id) return json({ mode: 'lost' });

    if (state.drain) {
      if (parked && !state.parked) {
        state.parked = true;
        state.phase = 'stopping';
        if (!this.cloud) this.slept(state);
        await this.schedule();
        await this.save(state);
      }
      return json({ mode: state.drain ? 'park' : (state.wanted ? 'wake' : 'standby') });
    }
    if (!state.wanted) return json({ mode: 'standby' });
    if (!ready) return json({ mode: 'wake' });
    if (state.phase !== 'running') {
      state.phase = 'running';
      state.error = null;
      await this.schedule();
      await this.save(state);
    }
    const job = await this.query("SELECT * FROM inbox WHERE state = 'queued' ORDER BY id LIMIT 1").first();
    if (job) {
      job.lease = boot + ':' + crypto.randomUUID();
      job.model = models(this.env).includes(state.model) ? state.model : models(this.env)[0];
      await this.schedule();
      await this.query("UPDATE inbox SET state = 'running', lease = ?, expires = ?, model = ? WHERE id = ?",
        job.lease, now + LEASE_MS, job.model, job.id).run();
      return json({ mode: 'job', job, model: job.model });
    }
    return json({ mode: 'idle' });
  }

  slept(state) {
    state.phase = state.wanted ? 'starting' : 'asleep';
    state.startedAt = Date.now();
    state.drain = false;
    state.manual = false;
    state.parked = false;
    state.committed = false;
    state.boot = '';
    state.seen = 0;
    state.nextGit = 0;
    state.error = null;
  }

  async reconcileGit(state, active) {
    const now = Date.now();
    if ((!state.wanted && !state.drain) || now < state.nextGit) return;
    if (state.phase === 'running' && !state.drain && now - state.seen < FRESH_MS) return;
    state.nextGit = now + 15000;
    await this.save(state);
    const path = '/user/codespaces/' + encodeURIComponent(this.env.CODESPACE_NAME);
    try {
      const space = await github(this.env.GH_CODESPACES_TOKEN, path);
      const down = ['Shutdown', 'Archived'].includes(space.state);
      if (state.drain) {
        if (down && !active) {
          this.slept(state);
        } else if (!active && (state.parked || (state.manual && !state.boot && now - state.startedAt > STARTUP_MS)) &&
                   !['ShuttingDown', 'Starting', 'Provisioning', 'Rebuilding'].includes(space.state)) {
          state.committed = true;
          state.phase = 'stopping';
          await this.save(state);
          await github(this.env.GH_CODESPACES_TOKEN, path + '/stop', 'POST');
        }
      } else if (down) {
        state.phase = 'starting';
        state.startedAt = now;
        await this.save(state);
        await github(this.env.GH_CODESPACES_TOKEN, path + '/start', 'POST');
      } else if (state.phase === 'running' && now - state.seen >= FRESH_MS) {
        state.phase = 'starting';
        state.startedAt = now;
      }
      state.error = state.phase === 'starting' && now - state.startedAt > STARTUP_MS
        ? 'Хост запущен, но OpenClaw ещё не подключился. Проверьте журнал запуска.' : null;
    } catch (error) {
      state.nextGit = now + 30000;
      state.error = /^GitHub API \d+$/.test(error.message) ? error.message : 'GitHub Codespaces временно недоступен.';
    }
    await this.save(state);
  }

  async deliver(job) {
    const parts = chunks(job.answer);
    try {
      await telegram(this.env, 'sendMessage', {
        chat_id: job.chat_id, message_thread_id: job.thread_id ?? undefined, text: parts[job.sent],
      });
    } catch (error) {
      return Math.max(15000, (error.retryAfter ?? 0) * 1000);
    }
    const sent = job.sent + 1;
    if (sent >= parts.length) {
      await this.query("UPDATE inbox SET sent = ?, state = 'done', prompt = '', answer = NULL WHERE id = ?", sent, job.id).run();
    } else {
      await this.query('UPDATE inbox SET sent = ? WHERE id = ?', sent, job.id).run();
    }
    return 1100;
  }

  alarm() {
    return this.serially(async () => {
      const state = await this.state();
      const now = Date.now();
      let active = await this.active();
      if (active && active.expires <= now) {
        await this.query("UPDATE inbox SET state = 'outbox', answer = ?, expires = NULL WHERE id = ?",
          active.cancelled ? 'Ответ остановлен.' : 'OpenClaw прервался во время обработки. Отправьте запрос снова.', active.id).run();
        active = null;
      }
      if (!state.wanted && !state.drain) {
        const queued = await this.query("SELECT id FROM inbox WHERE state = 'queued' AND created > ? LIMIT 1",
          state.pauseThrough ?? state.activity).first();
        if (queued) {
          this.want(state);
          await this.save(state);
        }
      }
      if (state.phase === 'running' && !state.drain && !active && now >= state.activity + state.sleepMinutes * 60000) {
        const queued = await this.query("SELECT id FROM inbox WHERE state = 'queued' LIMIT 1").first();
        if (!queued) {
          state.wanted = false;
          state.drain = true;
          await this.save(state);
        }
      }
      if (this.cloud) {
        await this.reconcileGit(state, active);
      } else if (!active && state.drain && now - state.seen >= FRESH_MS) {
        this.slept(state);
        await this.save(state);
      } else if (!active && state.phase === 'running' && now - state.seen >= FRESH_MS) {
        state.phase = 'starting';
        state.startedAt = now;
        await this.save(state);
      } else if (state.phase === 'starting' && now - state.startedAt > STARTUP_MS && !state.error) {
        state.error = 'OpenClaw ещё не подключился. Проверьте службу на Linux.';
        await this.save(state);
      }
      const outgoing = now >= (state.nextDelivery ?? 0) && await this.query("SELECT id, chat_id, thread_id, answer, sent FROM inbox WHERE state = 'outbox' ORDER BY id LIMIT 1").first();
      const deliveryDelay = outgoing ? await this.deliver(outgoing) : Infinity;
      if (outgoing && deliveryDelay > 1100) {
        state.nextDelivery = Date.now() + deliveryDelay;
        await this.save(state);
      }
      if (state.wanted || state.drain || active || outgoing || state.nextDelivery > now) {
        const sleepDelay = state.phase === 'running' && !state.drain && !active
          ? state.activity + state.sleepMinutes * 60000 - Date.now() : Infinity;
        await this.schedule(Math.min(10000, deliveryDelay, sleepDelay > 0 ? sleepDelay : Infinity));
      }
    });
  }
}
