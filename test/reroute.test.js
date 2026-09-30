import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.REROUTE_NO_NOTIFY = '1';
process.env.REROUTE_NO_UPDATE = '1';
process.env.REROUTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-test-'));

const { createReroute } = await import('../src/server.js');
const { anthropicToOpenAI } = await import('../src/translate.js');
const { classifyError } = await import('../src/detect.js');

let claudeMode = 'ok'; // ok | credits | limit | badreq
let claudeHits = 0;
let lastOpenAIReq = null;
let lastAnthropicFbReq = null;

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}
async function body(req) {
  const c = [];
  for await (const x of req) c.push(x);
  return JSON.parse(Buffer.concat(c).toString() || '{}');
}

const fakeClaude = http.createServer(async (req, res) => {
  claudeHits++;
  const b = await body(req);
  if (claudeMode === 'credits') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }));
  }
  if (claudeMode === 'limit') {
    res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 3600) });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit reached' } }));
  }
  if (claudeMode === 'badreq') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: field required' } }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: 'from claude' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, auth: req.headers.authorization || null }));
});

const fakeOpenAI = http.createServer(async (req, res) => {
  const b = await body(req);
  lastOpenAIReq = { body: b, headers: req.headers };
  if (b.model === 'org/bad') {
    res.writeHead(402, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'not included in your plan' } }));
  }
  const wantsTool = (b.tools || []).length > 0;
  if (b.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] });
    send({ choices: [{ index: 0, delta: { content: 'lo' } }] });
    if (wantsTool) {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_' } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a.txt"}' } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ index: 0, finish_reason: wantsTool ? 'tool_calls' : 'stop', message: { role: 'assistant', content: 'hi from open source', tool_calls: wantsTool ? [{ id: 'call_9', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] : undefined } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  }));
});

const fakeAnthropicFb = http.createServer(async (req, res) => {
  lastAnthropicFbReq = { body: await body(req), headers: req.headers, url: req.url };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: lastAnthropicFbReq.body.model, content: [{ type: 'text', text: 'from ollama' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
});

let app, base, openaiPort, anthFbPort;

before(async () => {
  const claudePort = await listen(fakeClaude);
  openaiPort = await listen(fakeOpenAI);
  anthFbPort = await listen(fakeAnthropicFb);
  app = createReroute({
    quiet: true,
    overrides: {
      anthropicBaseUrl: `http://127.0.0.1:${claudePort}`,
      providers: {
        fakeoai: { label: 'Fake OAI', type: 'openai', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, apiKey: 'test-key' },
        fakeanth: { label: 'Fake Anth', type: 'anthropic', baseUrl: `http://127.0.0.1:${anthFbPort}`, keyless: true, apiKey: 'x' },
      },
      models: [
        { id: 'bad', label: 'Refusing Model', provider: 'fakeoai', model: 'org/bad' },
        { id: 'oss', label: 'OSS Model', provider: 'fakeoai', model: 'org/oss-1' },
        { id: 'oll', label: 'Ollama Model', provider: 'fakeanth', model: 'oll:cloud' },
      ],
      apiKeys: {},
      fallbackModel: 'oss',
      mode: 'auto',
    },
  });
  const port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  fakeClaude.close();
  fakeOpenAI.close();
  fakeAnthropicFb.close();
});

function post(body, headers = {}) {
  return fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer user-oauth', ...headers },
    body: JSON.stringify(body),
  });
}

const simple = { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

test('passes through to Claude with the user auth header', async () => {
  claudeMode = 'ok';
  app.state.fallbackUntil = 0;
  const r = await post(simple);
  const j = await r.json();
  assert.equal(j.content[0].text, 'from claude');
  assert.equal(j.auth, 'Bearer user-oauth');
});

test('normal Claude errors are returned untouched', async () => {
  claudeMode = 'badreq';
  app.state.fallbackUntil = 0;
  const r = await post(simple);
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /max_tokens/);
});

test('out of credits switches to the fallback and stays there', async () => {
  claudeMode = 'credits';
  app.state.fallbackUntil = 0;
  const r = await post(simple);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.content[0].text, 'hi from open source');
  assert.equal(j.model, 'claude-sonnet-5-5');
  assert.equal(lastOpenAIReq.body.model, 'org/oss-1');
  assert.equal(lastOpenAIReq.headers.authorization, 'Bearer test-key');
  assert.ok(app.state.fallbackUntil > Date.now());

  const hits = claudeHits;
  claudeMode = 'ok';
  const r2 = await post(simple);
  assert.equal((await r2.json()).content[0].text, 'hi from open source');
  assert.equal(claudeHits, hits, 'Claude is not retried during cooldown');
});

test('429 usage limit uses the reset header for the cooldown', async () => {
  claudeMode = 'limit';
  app.state.fallbackUntil = 0;
  await (await post(simple)).json();
  const diff = app.state.fallbackUntil - Date.now();
  assert.ok(diff > 3500_000 && diff <= 3600_000, `cooldown ${diff}`);
});

test('streaming with tool calls is translated to Anthropic SSE', async () => {
  app.state.fallbackUntil = Date.now() + 60_000;
  const r = await post({
    ...simple,
    stream: true,
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
  });
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const text = await r.text();
  const events = text.split('\n\n').filter(Boolean).map((b) => {
    const [ev, data] = b.split('\n');
    return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
  });
  const names = events.map((e) => e.event);
  assert.deepEqual(names, [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    // Tool arguments are collected, repaired, then sent in one piece.
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  const toolStart = events[5].data;
  assert.equal(toolStart.index, 1);
  assert.equal(toolStart.content_block.type, 'tool_use');
  assert.equal(toolStart.content_block.name, 'Read');
  const json = events.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), { file_path: 'a.txt' });
  assert.equal(events[8].data.delta.stop_reason, 'tool_use');
  assert.equal(events[8].data.usage.output_tokens, 5);
});

test('anthropic-type providers get the request passed through with the model swapped', async () => {
  app.config.fallbackModel = 'oll';
  app.state.fallbackUntil = Date.now() + 60_000;
  const r = await post({ ...simple, context_management: { edits: [] } });
  const j = await r.json();
  assert.equal(j.content[0].text, 'from ollama');
  assert.equal(lastAnthropicFbReq.url, '/v1/messages');
  assert.equal(lastAnthropicFbReq.body.model, 'oll:cloud');
  assert.equal(lastAnthropicFbReq.body.context_management, undefined);
  assert.notEqual(lastAnthropicFbReq.headers.authorization, 'Bearer user-oauth', 'Claude credentials never leave to fallback providers');
  app.config.fallbackModel = 'oss';
});

test('auto pick skips a model that refuses and uses the next one', async () => {
  app.config.fallbackModel = 'auto';
  app.state.fallbackUntil = Date.now() + 60_000;
  const j = await (await post(simple)).json();
  assert.equal(j.content[0].text, 'hi from open source');
  assert.ok(app.state.badModels.has('bad'));
  assert.equal(lastOpenAIReq.body.model, 'org/oss-1');
  app.config.fallbackModel = 'oss';
});

test('count_tokens is estimated locally during fallback', async () => {
  app.state.fallbackUntil = Date.now() + 60_000;
  const r = await fetch(base + '/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(simple) });
  const j = await r.json();
  assert.ok(j.input_tokens > 0);
});

test('mode=claude never falls back', async () => {
  app.config.mode = 'claude';
  app.state.fallbackUntil = 0;
  claudeMode = 'credits';
  const r = await post(simple);
  assert.equal(r.status, 400);
  app.config.mode = 'auto';
});

test('dashboard and status API respond', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>Reroute<\/title>/);
  const s = await (await fetch(base + '/reroute/api/status')).json();
  assert.equal(s.name, 'reroute');
  assert.ok(Array.isArray(s.models));
});

test('request translation handles tool results, images and system blocks', () => {
  const out = anthropicToOpenAI(
    {
      system: [{ type: 'text', text: 'You are Claude Code.' }, { type: 'text', text: 'Be terse.' }],
      max_tokens: 64000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.txt' }] }, { type: 'text', text: 'next' }] },
      ],
      tools: [{ name: 'Bash', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'any' },
    },
    'm',
    { maxTokens: 16000 }
  );
  assert.equal(out.messages[0].content, 'You are Claude Code.\n\nBe terse.');
  assert.equal(out.messages[1].content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.equal(out.messages[2].content, 'ok');
  assert.equal(out.messages[2].tool_calls[0].function.arguments, '{"command":"ls"}');
  assert.deepEqual(out.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'a.txt' });
  assert.deepEqual(out.messages[4], { role: 'user', content: 'next' });
  assert.equal(out.tools.length, 1);
  assert.equal(out.tool_choice, 'required');
  assert.equal(out.max_tokens, 16000);
});

test('classifier ignores ordinary errors', () => {
  const cfg = { cooldownMinutes: 30, fallbackOnOverload: false };
  assert.equal(classifyError(401, '{"error":{"message":"invalid x-api-key"}}', {}, cfg).fallback, false);
  assert.equal(classifyError(500, 'oops', {}, cfg).fallback, false);
  assert.equal(classifyError(529, 'overloaded', {}, cfg).fallback, false);
  assert.equal(classifyError(429, '{}', { 'retry-after': '120' }, cfg).fallback, true);
});
