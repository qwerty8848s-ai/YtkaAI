import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const stateDir = resolve(process.env.OPENCLAW_STATE_DIR || join(root, '.claw-state'));
export const configPath = join(stateDir, 'openclaw.json');
export const binary = join(root, '.claw-runtime/node_modules/.bin/openclaw');
export const lockPath = join(stateDir, 'cli.lock');

export function modelRef(id, provider = process.env.MODEL_PROVIDER || 'privateapi') {
  if (provider === 'codex') return 'openai/' + id;
  if (provider === 'privateapi') return 'privateapi/' + id;
  throw new Error('Invalid MODEL_PROVIDER');
}

export function gatewayEnv() {
  const { RUNNER_SECRET, CLOUDFLARE_WORKER_URL, CODESPACE_VSCODE_FOLDER, ...env } = process.env;
  return { ...env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };
}

export async function configure() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(configPath)) return;
  const ids = JSON.parse(process.env.MODELS_JSON);
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^[\w./:@+-]{1,160}$/.test(id))) {
    throw new Error('Invalid MODELS_JSON');
  }
  if (!process.env.OPENCLAW_GATEWAY_TOKEN) throw new Error('Missing OPENCLAW_GATEWAY_TOKEN');
  const provider = process.env.MODEL_PROVIDER || 'privateapi';
  const primary = modelRef(ids[0], provider);
  const codex = provider === 'codex';
  let models;
  if (!codex) {
    const baseUrl = new URL(process.env.MODEL_BASE_URL);
    if (!['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) throw new Error('Invalid MODEL_BASE_URL');
    if (!process.env.MODEL_API_KEY) throw new Error('Missing MODEL_API_KEY');
    models = { mode: 'merge', providers: { privateapi: {
      baseUrl: baseUrl.href.replace(/\/$/, ''), api: 'openai-completions', apiKey: '${MODEL_API_KEY}',
      models: ids.map(id => ({ id, name: id, input: ['text'] })),
    } } };
  }
  const workspace = join(stateDir, 'workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const config = {
    gateway: {
      mode: 'local', bind: 'loopback', port: 18789,
      auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' },
      controlUi: { enabled: false },
      http: { endpoints: { responses: { enabled: true } } },
    },
    agents: { defaults: {
      workspace, model: { primary },
      maxConcurrent: 1, timeoutSeconds: 600,
      models: Object.fromEntries(ids.map(id => [
        modelRef(id, provider), codex ? { agentRuntime: { id: 'codex' } } : {},
      ])),
    } },
    ...(models ? { models } : {}),
    session: { reset: { mode: 'idle', idleMinutes: 525600 } },
    tools: { profile: 'coding' },
    cron: { enabled: false },
  };
  const temporary = configPath + '.' + process.pid;
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, configPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await configure();
  await readFile(configPath);
}
