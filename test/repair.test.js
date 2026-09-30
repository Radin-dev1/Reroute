import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.REROUTE_NO_NOTIFY = '1';
process.env.REROUTE_NO_UPDATE = '1';
process.env.REROUTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-repair-'));

const { repairJson, fixToolName, extractTextToolCalls, openAIStreamToAnthropic, openAIToAnthropic, trimToFit, estimateTokens } = await import(
  '../src/translate.js'
);
const { createReroute } = await import('../src/server.js');

const TOOLS = ['Read', 'Bash', 'Edit'];

test('repairJson fixes the usual ways models break tool arguments', () => {
  assert.deepEqual(repairJson('{"a": 1,}'), { a: 1 });
  assert.deepEqual(repairJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(repairJson('Sure! {"command": "ls"}'), { command: 'ls' });
  assert.deepEqual(repairJson('{"file_path": "a.txt", "content": "hel'), { file_path: 'a.txt', content: 'hel' });
  assert.deepEqual(repairJson('{"a": {"b": [1, 2'), { a: { b: [1, 2] } });
  assert.deepEqual(repairJson("{'command': 'ls', 'x': True}"), { command: 'ls', x: true });
  assert.deepEqual(repairJson('"{\\"a\\":1}"'), { a: 1 });
  assert.equal(repairJson('not json at all'), null);
});

test('fixToolName maps near-misses onto the real tool', () => {
  assert.equal(fixToolName('read', TOOLS), 'Read');
  assert.equal(fixToolName('functions.Bash', TOOLS), 'Bash');
  assert.equal(fixToolName('Bash', TOOLS), 'Bash');
  assert.equal(fixToolName('Unknown', TOOLS), 'Unknown');
});

test('tool calls written as text become real tool calls', () => {
  const a = extractTextToolCalls('Let me look.\n<tool_call>{"name": "read", "arguments": {"file_path": "x.js"}}</tool_call>', TOOLS);
  assert.equal(a.text, 'Let me look.');
  assert.deepEqual(a.calls, [{ name: 'Read', input: { file_path: 'x.js' } }]);
  const b = extractTextToolCalls('<function=Bash>{"command": "npm test"}</function>', TOOLS);
  assert.deepEqual(b.calls, [{ name: 'Bash', input: { command: 'npm test' } }]);
  const c = extractTextToolCalls('{"name": "Bash", "arguments": {"command": "ls"}}', TOOLS);
  assert.deepEqual(c.calls, [{ name: 'Bash', input: { command: 'ls' } }]);
  const d = extractTextToolCalls('Here is JSON: {"name": "Bob"}', TOOLS);
  assert.equal(d.calls.length, 0, 'ordinary JSON in a reply is left alone');
});

test('non-streaming replies get the same repair', () => {
  const out = openAIToAnthropic(
    { choices: [{ finish_reason: 'stop', message: { content: '<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>' } }] },
    'm',
    TOOLS
  );
  assert.equal(out.stop_reason, 'tool_use');
  assert.deepEqual(out.content, [{ type: 'tool_use', id: out.content[0].id, name: 'Bash', input: { command: 'ls' } }]);
  const broken = openAIToAnthropic(
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"file_path":"a",}' } }] } }] },
    'm',
    TOOLS
  );
  assert.deepEqual(broken.content[0], { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'a' } });
});

async function collect(chunks, toolNames) {
  async function* src() {
    for (const c of chunks) yield `data: ${JSON.stringify(c)}\n\n`;
    yield 'data: [DONE]\n\n';
  }
  const events = [];
  for await (const ev of openAIStreamToAnthropic(src(), 'm', toolNames)) {
    const [e, d] = ev.trim().split('\n');
    events.push({ event: e.slice(7), data: JSON.parse(d.slice(6)) });
  }
  return events;
}

test('streamed text tool calls are caught even when the marker is split across chunks', async () => {
  const pieces = ['Checking.', ' <tool', '_call>{"name": "Bash", ', '"arguments": {"command": "ls"}}</tool_call>'];
  const events = await collect(
    pieces.map((p) => ({ choices: [{ delta: { content: p } }] })).concat([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]),
    TOOLS
  );
  const text = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text.trim(), 'Checking.');
  assert.ok(!text.includes('<tool'), 'marker never shown to the user');
  const tool = events.find((e) => e.data.content_block?.type === 'tool_use');
  assert.equal(tool.data.content_block.name, 'Bash');
  const args = events.find((e) => e.data.delta?.type === 'input_json_delta').data.delta.partial_json;
  assert.deepEqual(JSON.parse(args), { command: 'ls' });
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
});

test('streamed tool arguments cut off mid-way are repaired', async () => {
  const events = await collect(
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'edit', arguments: '{"file_path": "a.js", ' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"new_string": "x"' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ],
    TOOLS
  );
  const tool = events.find((e) => e.data.content_block?.type === 'tool_use');
  assert.equal(tool.data.content_block.name, 'Edit');
  const args = events.find((e) => e.data.delta?.type === 'input_json_delta').data.delta.partial_json;
  assert.deepEqual(JSON.parse(args), { file_path: 'a.js', new_string: 'x' });
});

test('trimToFit keeps the first request and recent turns, and never splits a tool call from its result', () => {
  const big = 'x'.repeat(4000);
  const messages = [{ role: 'user', content: 'build me an app' }];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: big } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] });
    messages.push({ role: 'assistant', content: `step ${i} done` });
    messages.push({ role: 'user', content: `next ${i}` });
  }
  const body = { messages };
  const out = trimToFit(body, Math.floor(estimateTokens(body) / 3));
  assert.ok(out && out.dropped > 0);
  const kept = out.body.messages;
  assert.equal(kept[0].content, 'build me an app');
  assert.match(kept[1].content, /left out/);
  assert.equal(kept[2].role, 'user');
  assert.equal(typeof kept[2].content, 'string');
  assert.equal(kept.at(-1).content, 'next 19');
  const ids = new Set(kept.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.id) : [])));
  for (const m of kept) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') assert.ok(ids.has(b.tool_use_id));
  }
});

// A server-level check: small models are skipped for long conversations, and a stream that dies
// before sending anything moves on to the next model.
test('context fit and stream retry pick the model that can actually answer', async () => {
  const hits = [];
  const oss = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const b = JSON.parse(Buffer.concat(chunks));
    hits.push(b.model);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (b.model === 'org/flaky') {
      res.write(`data: ${JSON.stringify({ error: { message: 'upstream overloaded', code: 503 } })}\n\n`);
      return res.end();
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer from ' + b.model } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => oss.listen(0, '127.0.0.1', r));
  const app = createReroute({
    quiet: true,
    notify: false,
    overrides: {
      providers: { p: { type: 'openai', baseUrl: `http://127.0.0.1:${oss.address().port}/v1`, apiKey: 'k' } },
      models: [
        { id: 'tiny', label: 'Tiny', provider: 'p', model: 'org/tiny', context: 8000 },
        { id: 'flaky', label: 'Flaky', provider: 'p', model: 'org/flaky', context: 200000 },
        { id: 'big', label: 'Big', provider: 'p', model: 'org/big', context: 200000 },
      ],
      apiKeys: {},
      mode: 'fallback',
      fallbackModel: 'auto',
    },
  });
  const port = await app.listen(0);
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', stream: true, max_tokens: 1000, messages: [{ role: 'user', content: 'y'.repeat(60000) }] }),
  });
  const text = await r.text();
  assert.match(text, /answer from org\/big/);
  assert.deepEqual(hits, ['org/flaky', 'org/big'], 'tiny skipped for size, flaky retried on big');
  await app.close();
  oss.close();
});

test('relative paths in tool calls are completed with the project folder', async () => {
  const { absolutizePaths, projectDir } = await import('../src/translate.js');
  const W = 'C:\\work\\app';
  const body = { system: 'x', messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: [{ type: 'text', text: `# Environment\n - Primary working directory: ${W}\n` }] }] };
  assert.equal(projectDir(body), W);
  assert.deepEqual(absolutizePaths({ file_path: 'src/a.js' }, W), { file_path: 'C:\\work\\app\\src\\a.js' });
  assert.deepEqual(absolutizePaths({ file_path: 'C:\\other\\b.js' }, W), { file_path: 'C:\\other\\b.js' });
  const events = await collect([{ choices: [{ delta: { content: '<tool_call>{"name":"Read","arguments":{"file_path":"math.js"}}' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }], ['Read']);
  assert.equal(JSON.parse(events.find((e) => e.data.delta?.type === 'input_json_delta').data.delta.partial_json).file_path, 'math.js', 'without a folder nothing changes');
  async function* src() {
    yield `data: ${JSON.stringify({ choices: [{ delta: { content: '<tool_call>{"name":"Read","arguments":{"file_path":"math.js"}}' } }] })}\n\n`;
    yield 'data: [DONE]\n\n';
  }
  let args = null;
  for await (const ev of openAIStreamToAnthropic(src(), 'm', ['Read'], { cwd: W })) {
    const d = JSON.parse(ev.trim().split('\n')[1].slice(6));
    if (d.delta?.type === 'input_json_delta') args = JSON.parse(d.delta.partial_json);
  }
  assert.equal(args.file_path, 'C:\\work\\app\\math.js');
});
