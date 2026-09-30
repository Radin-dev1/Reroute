import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.REROUTE_NO_NOTIFY = '1';
process.env.REROUTE_NO_UPDATE = '1';
process.env.REROUTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-engine-'));

const { createReroute } = await import('../src/server.js');
const { enginePageHtml } = await import('../src/engine.js');

// Plays the part of the engine page: listens for jobs over SSE and answers like a local model.
async function fakeEnginePage(base, seen) {
  const ac = new AbortController();
  const res = await fetch(base + '/reroute/engine/events', { signal: ac.signal });
  await fetch(base + '/reroute/engine/hello', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webgpu: true, gpu: 'Fake GPU', cached: ['onnx-community/Qwen3-4B-Instruct-2507-ONNX'] }),
  });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (\w+)/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev !== 'job') continue;
          const job = JSON.parse(data);
          seen.push(job);
          const say = (deltas) =>
            fetch(`${base}/reroute/engine/chunk/${job.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deltas }) });
          await say([{ choices: [{ delta: { content: 'Let me check. <tool' } }] }]);
          await say([{ choices: [{ delta: { content: '_call>{"name": "read", "arguments": {"file_path": "a.js"}}</tool_call>' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
          await fetch(`${base}/reroute/engine/done/${job.id}`, { method: 'POST' });
        }
      }
    } catch {}
  })();
  return () => ac.abort();
}

test('the engine page loads Transformers.js with WebGPU', () => {
  const html = enginePageHtml();
  assert.match(html, /@huggingface\/transformers@\d+\.\d+\.\d+/);
  assert.match(html, /device: 'webgpu'/);
});

test('local WebGPU model answers through the engine page, slimmed, with tool calls repaired', async () => {
  const app = createReroute({ quiet: true, notify: false, probe: false, updates: false });
  app.config.mode = 'fallback';
  app.config.fallbackModel = 'auto';
  app.config.localOnly = true;
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const seen = [];
  const stop = await fakeEnginePage(base, seen);

  const status = await (await fetch(base + '/reroute/api/status')).json();
  assert.equal(status.resolvedFallback.id, 'webgpu-qwen3-4b', 'the downloaded local model is picked');
  assert.ok(status.models.every((m) => m.usable === false || status.localOnly === false || !/openrouter|huggingface|groq/.test(m.provider)), 'no cloud model is usable in local-only mode');

  const bigTool = (name) => ({ name, description: 'x'.repeat(5000), input_schema: { type: 'object', properties: { a: { type: 'string', description: 'y'.repeat(900) } } } });
  const r = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      stream: true,
      max_tokens: 32000,
      system: 'You are Claude Code.',
      messages: [{ role: 'user', content: 'read a.js' }],
      tools: [bigTool('Read'), bigTool('Artifact'), bigTool('Workflow'), bigTool('Bash')],
    }),
  });
  const text = await r.text();
  stop();
  await app.close();

  assert.equal(seen.length, 1);
  const job = seen[0];
  assert.equal(job.model.repo, 'onnx-community/Qwen3-4B-Instruct-2507-ONNX');
  assert.deepEqual(job.tools.map((t) => t.function.name).sort(), ['Bash', 'Read'], 'small model gets only core tools');
  assert.ok(job.tools[0].function.description.length < 1000, 'descriptions shortened');
  assert.ok(job.max_tokens <= 24576 / 4 + 1, 'reply length fits the small context');

  const events = text.split('\n\n').filter(Boolean).map((b) => JSON.parse(b.split('\n')[1].slice(6)));
  const tool = events.find((e) => e.content_block?.type === 'tool_use');
  assert.equal(tool.content_block.name, 'Read');
  const args = events.find((e) => e.delta?.type === 'input_json_delta');
  assert.deepEqual(JSON.parse(args.delta.partial_json), { file_path: 'a.js' });
  const shown = events.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
  assert.equal(shown.trim(), 'Let me check.');
});

test('local-only mode refuses cloud models even when picked', async () => {
  const app = createReroute({ quiet: true, notify: false, probe: false, updates: false });
  app.config.mode = 'fallback';
  app.config.localOnly = true;
  app.config.fallbackModel = 'kimi-k3';
  app.config.apiKeys = { openrouter: 'sk-or-test' };
  const port = await app.listen(0);
  const s = await (await fetch(`http://127.0.0.1:${port}/reroute/api/status`)).json();
  await app.close();
  assert.notEqual(s.resolvedFallback?.provider, 'openrouter');
  assert.match(s.models.find((m) => m.id === 'kimi-k3').needs, /local-only/);
});
