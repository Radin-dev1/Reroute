import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.REROUTE_NO_NOTIFY = '1';
process.env.REROUTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-picker-'));
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-claude-'));

const { setPickerRows, patchClaudeSettings, unpatchClaudeSettings, CLAUDE_SETTINGS } = await import('../src/install.js');
const { pickerId, modelFromPickerId, loadConfig } = await import('../src/config.js');
const { createReroute } = await import('../src/server.js');

test('picker IDs round-trip and contain "claude" so Claude Code accepts them', () => {
  const cfg = loadConfig();
  for (const m of cfg.models) {
    const id = pickerId(m);
    assert.match(id, /^claude-reroute-[a-z0-9-]+$/);
    assert.equal(modelFromPickerId(cfg, id), m);
  }
  assert.equal(modelFromPickerId(cfg, 'claude-reroute-auto'), 'auto');
  assert.equal(modelFromPickerId(cfg, 'claude-sonnet-5-5'), null);
  const ids = cfg.models.map(pickerId);
  assert.equal(new Set(ids).size, ids.length, 'picker IDs are unique');
});

test('picker rows keep your own rows and settings, and uninstall removes only ours', () => {
  fs.writeFileSync(
    CLAUDE_SETTINGS,
    JSON.stringify({ model: 'sonnet', modelPicker: { options: [{ model: 'claude-opus-5', label: 'Mine' }] }, env: { FOO: '1' } })
  );
  patchClaudeSettings('http://127.0.0.1:4747');
  setPickerRows([{ model: 'claude-reroute-glm-5-3', label: 'GLM-5.3' }]);
  setPickerRows([{ model: 'claude-reroute-kimi-k3', label: 'Kimi K3' }]);
  let s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  assert.deepEqual(s.modelPicker.options.map((o) => o.model), ['claude-opus-5', 'claude-reroute-kimi-k3']);
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4747');
  assert.equal(s.model, 'sonnet');

  unpatchClaudeSettings();
  s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  assert.deepEqual(s.modelPicker.options.map((o) => o.model), ['claude-opus-5']);
  assert.deepEqual(s.env, { FOO: '1' });
});

test('choosing a Reroute model in the picker skips Claude even when Claude works', async () => {
  let claudeHits = 0;
  let seenModel = null;
  const claude = http.createServer((req, res) => {
    claudeHits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const oss = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seenModel = JSON.parse(Buffer.concat(chunks)).model;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'picked' } }], usage: {} }));
  });
  await new Promise((r) => claude.listen(0, '127.0.0.1', r));
  await new Promise((r) => oss.listen(0, '127.0.0.1', r));
  const app = createReroute({
    quiet: true,
    overrides: {
      anthropicBaseUrl: `http://127.0.0.1:${claude.address().port}`,
      providers: { p: { type: 'openai', baseUrl: `http://127.0.0.1:${oss.address().port}/v1`, apiKey: 'k' } },
      models: [
        { id: 'first', label: 'First', provider: 'p', model: 'org/first' },
        { id: 'glm-5.3', label: 'GLM', provider: 'p', model: 'org/glm' },
      ],
      apiKeys: {},
      mode: 'auto',
      fallbackModel: 'auto',
    },
  });
  const port = await app.listen(0);
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-reroute-glm-5-3', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const j = await r.json();
  assert.equal(j.content[0].text, 'picked');
  assert.equal(j.model, 'claude-reroute-glm-5-3');
  assert.equal(seenModel, 'org/glm');
  assert.equal(claudeHits, 0);
  await app.close();
  claude.close();
  oss.close();
});
