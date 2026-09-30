// Built-in local engine: open models run on your own GPU through WebGPU, inside a Reroute page.
//
// Reroute serves /reroute/engine, a page that loads Transformers.js and the model, then waits for work.
// Reroute opens that page in a hidden Edge/Chrome window (its own profile, so downloaded models stay
// cached there). Requests go page-ward over Server-Sent Events; tokens come back with small POSTs.
// Once a model is downloaded, nothing leaves your machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HOME_DIR } from './config.js';

export const TRANSFORMERS_VERSION = '4.3.0';

export function findBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// The bridge between Reroute and the engine page.
export function createEngineBridge(opts) {
  const log = opts.log || (() => {});
  const pages = new Set(); // SSE responses of connected engine pages
  const pending = new Map(); // job id -> { push, end, fail }
  // Which models are downloaded is only known once the engine page reports it, and the page only opens
  // when a model is needed. So the last report is kept on disk and read back when Reroute starts.
  const stateFile = path.join(HOME_DIR, 'engine-state.json');
  let remembered = {};
  try {
    remembered = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  let info = { connected: false, webgpu: remembered.webgpu ?? null, gpu: remembered.gpu ?? null, cached: remembered.cached || [], loaded: null, loading: null, progress: null };
  function remember() {
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ webgpu: info.webgpu, gpu: info.gpu, cached: info.cached }));
    } catch {}
  }
  let launched = null;
  let lastLaunch = 0;
  // Exactly one engine page does the work. Every page loads its own copy of the model into video
  // memory, so two pages running the same job doubles memory and halves speed. When a new page
  // connects (e.g. an old window reconnecting after Reroute restarted), the others are retired.
  let active = null;

  function write(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function send(event, data) {
    if (active) write(active, event, data);
  }

  function launch({ visible = false } = {}) {
    const exe = findBrowser();
    if (!exe) throw new Error('No Edge or Chrome found for the local engine. Install Microsoft Edge or Google Chrome.');
    if (launched && !launched.killed && Date.now() - lastLaunch < 60_000) return;
    lastLaunch = Date.now();
    const profile = path.join(HOME_DIR, 'engine-profile');
    fs.mkdirSync(profile, { recursive: true });
    const args = [
      `--user-data-dir=${profile}`,
      `--app=http://127.0.0.1:${opts.port}/reroute/engine`,
      '--no-first-run',
      '--no-default-browser-check',
      // Keep generating at full speed while the window is hidden or in the background.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--enable-unsafe-webgpu',
      visible ? '--window-size=560,420' : '--window-position=-32000,-32000',
      visible ? '' : '--window-size=320,240',
    ].filter(Boolean);
    launched = spawn(exe, args, { detached: true, stdio: 'ignore' });
    launched.on('error', (e) => log(`engine browser failed to start: ${e.message}`));
    launched.unref();
    log(`Started the local engine window (${path.basename(exe)})`);
  }

  async function waitForPage(ms = 30_000) {
    const until = Date.now() + ms;
    while (!active && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    return Boolean(active);
  }

  // Runs a chat on the engine. Returns an async iterable of OpenAI-style SSE text ("data: {...}\n\n"),
  // so the regular OpenAI -> Anthropic stream translation (and tool-call repair) applies as-is.
  async function chat(request, signal) {
    if (!active) {
      // An engine window that's already open reconnects by itself within a few seconds of Reroute
      // starting; wait for it before opening another one.
      if (!(await waitForPage(5000))) {
        launch();
        if (!(await waitForPage())) throw Object.assign(new Error('the local engine window did not start'), { status: 503 });
      }
    }
    const id = crypto.randomBytes(6).toString('hex');
    const page = active;
    const queue = [];
    let wake = null;
    let done = false;
    let error = null;
    pending.set(id, {
      page,
      push: (s) => {
        queue.push(s);
        wake?.();
      },
      end: () => {
        done = true;
        wake?.();
      },
      fail: (e) => {
        error = e;
        done = true;
        wake?.();
      },
    });
    signal?.addEventListener('abort', () => !page.writableEnded && write(page, 'cancel', { id }));
    write(page, 'job', { id, ...request });
    return (async function* () {
      try {
        for (;;) {
          if (queue.length) {
            yield queue.shift();
            continue;
          }
          if (error) throw Object.assign(new Error(error), { status: 502 });
          if (done) return;
          await new Promise((r) => (wake = r));
          wake = null;
        }
      } finally {
        pending.delete(id);
      }
    })();
  }

  // HTTP handler for /reroute/engine/*. Returns true when it handled the request.
  async function handle(req, res, url, readBody) {
    if (url.pathname === '/reroute/engine/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      // The newest page takes over; older ones are told to free their model and close.
      for (const old of pages) write(old, 'retire', {});
      pages.add(res);
      active = res;
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        pages.delete(res);
        if (active === res) {
          active = [...pages].pop() || null;
          info = { ...info, connected: Boolean(active), loaded: null, loading: null };
        }
        // Jobs that page was running can't finish: fail them so Reroute moves on to another model.
        for (const job of pending.values()) if (job.page === res) job.fail('the local engine window closed');
      });
      return true;
    }
    if (req.method !== 'POST') return false;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch {}
    if (url.pathname === '/reroute/engine/hello' || url.pathname === '/reroute/engine/state') {
      info = { ...info, ...body, connected: true };
      if (body.cached || body.webgpu !== undefined) remember();
      res.writeHead(204).end();
      return true;
    }
    const m = url.pathname.match(/^\/reroute\/engine\/(chunk|done|error)\/([a-f0-9]{12})$/);
    if (m) {
      const job = pending.get(m[2]);
      if (job) {
        if (m[1] === 'chunk') for (const d of body.deltas || []) job.push(`data: ${JSON.stringify(d)}\n\n`);
        else if (m[1] === 'done') job.end();
        else job.fail(body.message || 'the local engine failed');
      }
      res.writeHead(204).end();
      return true;
    }
    return false;
  }

  return {
    handle,
    chat,
    launch,
    waitForPage,
    // Ask the page to download (and load) a model, showing progress in the window.
    download(model) {
      const go = () => send('download', { model });
      if (active) return go();
      // Give an open window a moment to reconnect before opening one.
      waitForPage(5000).then((ok) => {
        if (ok) return go();
        launch({ visible: true });
        waitForPage().then((ok2) => ok2 && go());
      });
    },
    get info() {
      return { ...info, connected: Boolean(active), browser: findBrowser() };
    },
    // Ends the engine page's event streams (it reconnects by itself, e.g. to a restarted Reroute).
    closePages() {
      for (const res of pages) res.end();
    },
  };
}

// ---------------------------------------------------------------------------
// The engine page itself.

export function enginePageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reroute engine</title>
<style>
  :root { --bg: #151412; --ink: #ecead3; --muted: #9a968a; --accent: #e0774a; --bar: #2e2c28; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, "Segoe UI", sans-serif; padding: 16px; }
  h1 { font-size: 16px; margin: 0 0 8px; } h1 span { color: var(--accent); }
  .muted { color: var(--muted); font-size: 12.5px; }
  .bar { height: 8px; background: var(--bar); border-radius: 99px; overflow: hidden; margin: 8px 0; }
  .bar i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .2s; }
  #log { font: 12px ui-monospace, Consolas, monospace; color: var(--muted); white-space: pre-wrap; max-height: 180px; overflow: auto; }
</style>
</head>
<body>
<h1>Re<span>route</span> local engine</h1>
<div id="state">Starting…</div>
<div class="bar"><i id="bar"></i></div>
<div class="muted" id="detail">Runs open models on this computer's GPU. You can minimize this window.</div>
<div id="log"></div>
<script type="module">
const $ = (s) => document.querySelector(s);
const logEl = $('#log');
const log = (m) => { logEl.textContent = (new Date().toLocaleTimeString() + '  ' + m + '\\n' + logEl.textContent).slice(0, 4000); };
const post = (p, b) => fetch('/reroute/engine/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).catch(() => {});

let T = null; // transformers module
let loaded = null; // { key, tokenizer, model, processor }
const cancels = new Map();
let busy = Promise.resolve();

async function gpuInfo() {
  if (!navigator.gpu) return { webgpu: false };
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return { webgpu: false };
    const i = a.info || {};
    return { webgpu: true, gpu: [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' ') || 'WebGPU adapter', f16: a.features.has('shader-f16') };
  } catch (e) { return { webgpu: false, error: String(e) }; }
}

async function cachedModels() {
  try {
    const c = await caches.open('transformers-cache');
    const keys = await c.keys();
    const ids = new Set();
    for (const k of keys) { const m = k.url.match(/huggingface\\.co\\/([^/]+\\/[^/]+)\\/resolve/); if (m) ids.add(m[1]); }
    return [...ids];
  } catch { return []; }
}

async function report(extra = {}) {
  post('state', { cached: await cachedModels(), loaded: loaded ? loaded.key : null, ...extra });
}

async function lib() {
  if (!T) {
    $('#state').textContent = 'Loading Transformers.js…';
    T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}');
  }
  return T;
}

async function load(model) {
  const key = model.repo + ':' + model.dtype;
  if (loaded && loaded.key === key) return loaded;
  const t = await lib();
  if (loaded) { try { await loaded.model.dispose(); } catch {} loaded = null; }
  $('#state').textContent = 'Loading ' + model.label + '…';
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let got = 0, total = 0; for (const [l, tt] of files.values()) { got += l; total += tt; }
      $('#bar').style.width = (100 * got / total).toFixed(1) + '%';
      $('#detail').textContent = 'Downloading ' + model.label + ': ' + (got / 1e9).toFixed(2) + ' / ' + (total / 1e9).toFixed(2) + ' GB';
      post('state', { loading: model.id, progress: got / total });
    }
  };
  const opts = { dtype: model.dtype, device: 'webgpu', progress_callback };
  let tokenizer, mdl, processor = null;
  if (model.kind === 'multimodal') {
    processor = await t.AutoProcessor.from_pretrained(model.repo, { progress_callback });
    tokenizer = processor.tokenizer;
    mdl = await t.AutoModelForImageTextToText.from_pretrained(model.repo, opts);
  } else {
    tokenizer = await t.AutoTokenizer.from_pretrained(model.repo, { progress_callback });
    mdl = await t.AutoModelForCausalLM.from_pretrained(model.repo, opts);
  }
  loaded = { key, tokenizer, model: mdl, processor };
  $('#bar').style.width = '100%';
  $('#state').textContent = 'Ready: ' + model.label;
  $('#detail').textContent = 'Runs on this computer. You can minimize this window.';
  log('loaded ' + model.label);
  await report({ loading: null, progress: null });
  return loaded;
}

// OpenAI-style messages -> what chat templates expect (tool call arguments as objects).
function templateMessages(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\\n') : (m.content ?? '') };
    if (m.tool_calls) out.tool_calls = m.tool_calls.map((c) => ({ type: 'function', id: c.id, function: { name: c.function.name, arguments: (() => { try { return JSON.parse(c.function.arguments || '{}'); } catch { return {}; } })() } }));
    if (m.role === 'tool') { out.tool_call_id = m.tool_call_id; }
    return out;
  });
}

async function run(job) {
  const deltas = [];
  let timer = null;
  const flush = () => { timer = null; if (deltas.length) post('chunk/' + job.id, { deltas: deltas.splice(0) }); };
  const push = (d) => { deltas.push(d); if (!timer) timer = setTimeout(flush, 40); };
  try {
    const { tokenizer, model } = await load(job.model);
    const t = await lib();
    const stop = new t.InterruptableStoppingCriteria();
    cancels.set(job.id, stop);
    const inputs = tokenizer.apply_chat_template(templateMessages(job.messages), {
      tools: job.tools && job.tools.length ? job.tools : undefined,
      add_generation_prompt: true,
      return_dict: true,
      enable_thinking: false,
    });
    const promptTokens = inputs.input_ids.dims.at(-1);
    $('#state').textContent = 'Working (' + promptTokens.toLocaleString() + ' tokens in)…';
    let outTokens = 0;
    const streamer = new t.TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => { if (text) push({ choices: [{ index: 0, delta: { content: text } }] }); },
      token_callback_function: () => { outTokens++; },
    });
    // Read long prompts in chunks. All at once needs memory for every pair of tokens: on a 4B model
    // that is ~2 GB at 4k tokens, which overflows ONNX Runtime's buffers or crawls on an 8 GB GPU.
    // Chunks keep it to a few hundred MB at any length, reusing the cache between them.
    const CHUNK = 512;
    let past = null;
    if (promptTokens > CHUNK) {
      const ids = inputs.input_ids;
      for (let s = 0; s < promptTokens - 1 && !stop.interrupted; s += CHUNK) {
        const end = Math.min(s + CHUNK, promptTokens - 1);
        $('#state').textContent = 'Reading the prompt: ' + end.toLocaleString() + ' / ' + promptTokens.toLocaleString() + ' tokens…';
        const out = await model({ input_ids: ids.slice(null, [s, end]), attention_mask: t.ones([1, end]), past_key_values: past || undefined });
        // The model returns its cache as present.* tensors; generate() expects them in a DynamicCache
        // as past_key_values.* (the same renaming Transformers.js does inside generate).
        const entries = {};
        for (const name in out) {
          if (name.startsWith('present')) entries[name.replace('present', 'past_key_values')] = out[name];
          else if (out[name] && out[name].location === 'gpu-buffer') out[name].dispose();
        }
        if (past) past.update(entries);
        else past = new t.DynamicCache(entries);
      }
      $('#state').textContent = 'Writing…';
    }
    try {
      await model.generate({ ...inputs, past_key_values: past || undefined, max_new_tokens: Math.max(16, Math.min(job.max_tokens || 2048, 8192)), do_sample: job.temperature > 0, temperature: job.temperature || undefined, streamer, stopping_criteria: stop });
    } finally {
      // generate() keeps a cache it was handed; free its GPU memory ourselves.
      if (past) await past.dispose();
    }
    push({ choices: [{ index: 0, delta: {}, finish_reason: stop.interrupted ? 'stop' : outTokens >= (job.max_tokens || 2048) ? 'length' : 'stop' }] });
    push({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: outTokens } });
    flush();
    await post('done/' + job.id);
    $('#state').textContent = 'Ready: ' + job.model.label;
  } catch (e) {
    flush();
    log('error: ' + (e && e.message || e));
    await post('error/' + job.id, { message: String(e && e.message || e) });
    $('#state').textContent = 'Error: ' + (e && e.message || e);
    // A GPU runtime error leaves ONNX Runtime's WebGPU state broken for every later request, even on
    // other models. Reloading the page gives a fresh GPU device; the model reloads from the cache.
    if (/OrtRun|WebGPU|GPUDevice|device (was )?lost|out of memory/i.test(String(e && e.message || e))) {
      log('resetting the GPU engine after this error');
      setTimeout(() => location.reload(), 300);
    }
  } finally {
    cancels.delete(job.id);
  }
}

const events = new EventSource('/reroute/engine/events');
events.addEventListener('job', (e) => { const job = JSON.parse(e.data); busy = busy.then(() => run(job)); });
events.addEventListener('retire', async () => {
  // Another engine window took over: free this one's video memory and close.
  events.close();
  for (const c of cancels.values()) c.interrupt();
  if (loaded) { try { await loaded.model.dispose(); } catch {} loaded = null; }
  $('#state').textContent = 'Another Reroute engine window took over. You can close this one.';
  window.close();
});
events.addEventListener('cancel', (e) => { const { id } = JSON.parse(e.data); cancels.get(id)?.interrupt(); });
events.addEventListener('download', (e) => {
  const { model } = JSON.parse(e.data);
  busy = busy.then(() => load(model).catch((err) => { log('download failed: ' + err.message); $('#state').textContent = 'Download failed: ' + err.message; report({ loading: null, error: err.message }); }));
});
events.onopen = async () => { const g = await gpuInfo(); $('#state').textContent = g.webgpu ? 'Ready (' + g.gpu + ')' : 'This browser has no WebGPU: local models cannot run here.'; post('hello', { ...g, cached: await cachedModels(), loaded: loaded ? loaded.key : null }); };
</script>
</body>
</html>`;
}
