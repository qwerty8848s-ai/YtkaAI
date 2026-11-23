import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { modelRef } from '../runner/config.js';

function makeConfig(t, overrides) {
  const state = mkdtempSync(join(tmpdir(), 'openclaw-config-test-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../runner/config.js', import.meta.url));
  execFileSync(process.execPath, [script], {
    env: { ...process.env,
      OPENCLAW_STATE_DIR: state, OPENCLAW_GATEWAY_TOKEN: 'unit-test-token',
      MODEL_BASE_URL: '', MODEL_API_KEY: '', ...overrides },
  });
  return JSON.parse(readFileSync(join(state, 'openclaw.json'), 'utf8'));
}

test('Codex config uses the OpenAI model route without API credentials', t => {
  const config = makeConfig(t, { MODEL_PROVIDER: 'codex', MODELS_JSON: '["gpt-5.6-luna"]' });
  const ref = modelRef('gpt-5.6-luna', 'codex');
  assert.equal(config.agents.defaults.model.primary, ref);
  assert.deepEqual(config.agents.defaults.models[ref], { agentRuntime: { id: 'codex' } });
  assert.equal(config.models, undefined);
  assert.equal(config.gateway.bind, 'loopback');
});

test('Private API config keeps its namespace and uses an environment reference for the key', t => {
  const config = makeConfig(t, {
    MODEL_PROVIDER: 'privateapi', MODELS_JSON: '["alpha"]',
    MODEL_BASE_URL: 'https://api.example.com/v1/', MODEL_API_KEY: 'unit-test-key',
  });
  assert.equal(config.agents.defaults.model.primary, 'privateapi/alpha');
  assert.equal(config.models.providers.privateapi.baseUrl, 'https://api.example.com/v1');
  assert.equal(config.models.providers.privateapi.apiKey, '${MODEL_API_KEY}');
});
