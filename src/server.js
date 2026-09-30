import http from 'node:http';
import fs from 'node:fs';
import {
  loadConfig,
  saveConfig,
  configMtime,
  providerKey,
  providerUsable,
  fallbackCandidates,
  modelUsable,
  modelFromPickerId,
  pickerId,
  isCloudModel,
  isLocalModel,
  ollamaRoot,
  ollamaContextName,
  HOME_DIR,
  LOG_PATH,
} from './config.js';
import { classifyError } from './detect.js';
import { anthropicToOpenAI, openAIToAnthropic, openAIStreamToAnthropic, estimateTokens, trimToFit, toolNamesOf, compressSkillListing, slimForSmallModel } from './translate.js';
import { notify as desktopNotify } from './notify.js';
import { createEngineBridge, enginePageHtml } from './engine.js';
import { teach, listTaught, forget } from './teach.js';
import { runClaudeAsync } from './skills.js';
import { checkForUpdate, applyUpdate, currentVersion } from './update.js';
import { pickerRows } from './picker.js';
import { setPickerRows } from './install.js';
import { listJobs, startJob, stopJob, readJob, logFile } from './jobs.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'reroute.js');
import { dashboardHtml } from './dashboard.js';

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-length',
  'accept-encoding',
]);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function createReroute(options = {}) {
  let cfg = loadConfig();
  let cfgMtime = configMtime();
  if (options.overrides) Object.assign(cfg, options.overrides);

  const state = {
    startedAt: Date.now(),
    fallbackUntil: 0,
    fallbackReason: '',
    requests: { claude: 0, fallback: 0 },
    skillCharsSaved: 0,
    lastRoute: null,
    events: [],
    ollamaModels: null,
    ollamaCheckedAt: 0,
    badModels: new Map(),
    planRefused: new Set(), // Ollama Cloud models your plan does not include (checked at startup)
    usage: null, // latest Claude plan usage from Anthropic's rate-limit headers
    usageWarned: 0,
    update: { available: false, checkedAt: 0 },
    savedByQuotaSaver: 0,
    onFallback: false, // told the user we switched; tell them again when Claude is back
    lastNoFallbackNotice: 0,
  };

  let enginePort = cfg.port;
  const engine = createEngineBridge({ get port() { return enginePort; }, log: (m) => log(m) });

  // What's usable right now: Ollama's models plus what the WebGPU engine has downloaded.
  async function usableEnv() {
    const oll = await ollamaInfo();
    const e = engine.info;
    return { ...oll, engine: { webgpu: e.webgpu, cached: new Set(e.cached || []) } };
  }

  // Small local models get the slimmed request (core tools, short descriptions).
  const isSmall = (m) => (m.context || 131072) <= 65536;
  const bodyFor = (m, body) => (isSmall(m) ? slimForSmallModel(body) : body);

  function notify(title, message) {
    if (cfg.notify === false || options.notify === false) return;
    (options.notifier || desktopNotify)(title, message);
  }

  function refreshConfig() {
    const m = configMtime();
    if (m !== cfgMtime) {
      cfgMtime = m;
      cfg = loadConfig();
      if (options.overrides) Object.assign(cfg, options.overrides);
    }
  }

  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    state.events.unshift({ t: Date.now(), msg });
    state.events.length = Math.min(state.events.length, 50);
    if (!options.quiet) console.log(line);
    try {
      fs.mkdirSync(HOME_DIR, { recursive: true });
      fs.appendFileSync(LOG_PATH, line + '\n');
    } catch {}
  }

  async function ollamaInfo() {
    if (state.ollamaModels && Date.now() - state.ollamaCheckedAt < 60_000) return state.ollamaModels;
    const info = { reachable: false, models: new Set() };
    try {
      const r = await fetch(`${ollamaRoot(cfg)}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      info.reachable = true;
      for (const m of j.models || []) {
        info.models.add(m.name);
        info.models.add(m.name.replace(/:latest$/, ''));
      }
    } catch {}
    state.ollamaModels = info;
    state.ollamaCheckedAt = Date.now();
    return info;
  }

  // Keyless OpenAI-style servers you run yourself (vLLM etc.): check they answer before calling them ready.
  const probes = new Map();
  async function selfHostedUp(name) {
    const hit = probes.get(name);
    if (hit && Date.now() - hit.at < 30_000) return hit.up;
    let up = false;
    try {
      const r = await fetch(cfg.providers[name].baseUrl.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(1000) });
      up = r.status < 500;
    } catch {}
    probes.set(name, { up, at: Date.now() });
    return up;
  }

  // Models that recently refused us (not in your plan, bad key, retired...). Skipped in auto mode for a while.
  function skipped() {
    const now = Date.now();
    for (const [id, until] of state.badModels) if (until < now) state.badModels.delete(id);
    return new Set([...state.badModels.keys(), ...state.planRefused]);
  }

  // Checks GitHub for a newer Reroute. With autoUpdate on (default) it installs it and restarts:
  // the watchdog starts the new version right away. Without the watchdog it just says an update is ready.
  let updating = false;
  async function updateCheck({ install = cfg.autoUpdate !== false } = {}) {
    if (updating) return state.update;
    try {
      const r = await checkForUpdate();
      state.update = { ...r, checkedAt: Date.now(), current: currentVersion() };
      if (r.available && install) return await installUpdate();
      if (r.available && !state.update.told) {
        state.update.told = true;
        notify('Reroute update available', `${r.latest?.subject || 'A new version is on GitHub'}. Update from the dashboard or run: reroute update`);
      }
    } catch (e) {
      state.update = { ...state.update, checkedAt: Date.now(), error: e.message };
    }
    return state.update;
  }

  async function installUpdate() {
    updating = true;
    try {
      const r = await applyUpdate();
      log(`Updated Reroute ${r.from.commit} -> ${r.to.commit}`);
      state.update = { available: false, checkedAt: Date.now(), current: r.to, justUpdated: r };
      if (process.env.REROUTE_SUPERVISED) {
        notify('Reroute updated', `Now on ${r.to.version} (${r.to.commit}). Restarting in the background.`);
        // Stop taking new connections and drop idle ones (and the engine page's event stream, which
        // reconnects to the new version by itself); exit with 75 once in-flight replies finish, so the
        // watchdog starts the new code right away. Give up waiting after 30 s.
        setTimeout(() => {
          server.close(() => process.exit(75));
          server.closeIdleConnections?.();
          engine.closePages();
        }, 300).unref();
        setTimeout(() => process.exit(75), 30_000).unref();
      } else {
        notify('Reroute updated', `Now on ${r.to.version} (${r.to.commit}). Restart Reroute to use it: reroute stop, then reroute start.`);
      }
      return state.update;
    } catch (e) {
      state.update = { ...state.update, error: e.message };
      log(`update failed: ${e.message}`);
      throw e;
    } finally {
      updating = false;
    }
  }

  // Ollama Cloud models your plan doesn't include answer 402 at once, and a refusal costs nothing.
  // Checking at startup keeps the model order right without wasting a real request on them.
  async function probeOllamaCloud() {
    const oll = await ollamaInfo();
    if (!oll.reachable || providerKey(cfg, 'ollama')) return;
    const queue = cfg.models.filter((m) => m.provider === 'ollama' && isCloudModel(m.model));
    const refused = [];
    const worker = async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        try {
          const r = await fetch(`${ollamaRoot(cfg)}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: m.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
            signal: AbortSignal.timeout(20_000),
          });
          await r.body?.cancel();
          if ([401, 402, 403, 404].includes(r.status)) {
            state.planRefused.add(m.id);
            refused.push(m.label);
          } else if (r.ok) {
            state.planRefused.delete(m.id);
          }
        } catch {}
      }
    };
    // Two at a time: bursts of parallel calls get errors that don't say whether a model is included.
    await Promise.all([worker(), worker()]);
    state.planChecked = true;
    if (refused.length) log(`Your Ollama plan doesn't include ${refused.length} cloud models; skipping them: ${refused.join(', ')}`);
  }

  async function candidates() {
    return fallbackCandidates(cfg, await usableEnv(), skipped());
  }

  async function currentFallback() {
    return (await candidates())[0] || null;
  }

  function inFallback() {
    if (cfg.mode === 'fallback') return true;
    if (cfg.mode === 'claude') return false;
    return Date.now() < state.fallbackUntil;
  }

  // Anthropic reports your plan usage on every reply: 5-hour and weekly utilization and when each resets.
  function recordUsage(headers) {
    const h = (k) => headers.get(`anthropic-ratelimit-unified-${k}`);
    const pct = (v) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
    };
    const when = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
    };
    const u = {
      fiveHour: pct(h('5h-utilization')),
      sevenDay: pct(h('7d-utilization')),
      fiveHourReset: when(h('5h-reset')),
      sevenDayReset: when(h('7d-reset')),
      status: h('status'),
      at: Date.now(),
    };
    if (u.fiveHour == null && u.sevenDay == null && !u.status) return;
    state.usage = u;
    const top = Math.max(u.fiveHour ?? 0, u.sevenDay ?? 0);
    const warnAt = cfg.usageWarnPercent ?? 80;
    if (top >= warnAt && Date.now() - state.usageWarned > 60 * 60_000) {
      state.usageWarned = Date.now();
      const which = (u.fiveHour ?? 0) >= (u.sevenDay ?? 0) ? '5-hour' : 'weekly';
      const reset = which === '5-hour' ? u.fiveHourReset : u.sevenDayReset;
      notify(`Claude ${which} limit at ${Math.round(top)}%`, `Reroute will switch to open-source models when it runs out${reset ? `; resets ${new Date(reset).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}.`);
    }
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  function sendJson(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extraHeaders });
    res.end(body);
  }

  function anthropicError(res, status, message, type = 'api_error') {
    sendJson(res, status, { type: 'error', error: { type, message } });
  }

  async function pipeResponse(upstream, res, extraHeaders = {}) {
    const headers = {};
    upstream.headers.forEach((v, k) => {
      // fetch() already decoded the body, so the length/encoding headers no longer apply.
      if (!HOP_BY_HOP.has(k) && k !== 'content-encoding') headers[k] = v;
    });
    res.writeHead(upstream.status, { ...headers, ...extraHeaders });
    if (!upstream.body) return res.end();
    try {
      for await (const chunk of upstream.body) res.write(chunk);
    } catch (e) {
      if (!res.destroyed) log(`stream error: ${e.message}`);
    }
    res.end();
  }

  function forwardHeaders(req) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) h[k] = v;
    }
    h['accept-encoding'] = 'identity';
    return h;
  }

  async function callClaude(req, bodyBuf, signal) {
    const url = cfg.anthropicBaseUrl.replace(/\/$/, '') + req.url;
    return fetch(url, {
      method: req.method,
      headers: forwardHeaders(req),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
      signal,
      redirect: 'manual',
    });
  }

  async function readFailure(upstream) {
    const text = await upstream.text();
    let message = text;
    try {
      const j = JSON.parse(text);
      message = j.error?.message || j.message || text;
    } catch {}
    const type = upstream.status === 429 ? 'rate_limit_error' : upstream.status === 401 ? 'authentication_error' : 'api_error';
    return { status: upstream.status, message: String(message).slice(0, 1000), type };
  }

  // Reads a streaming response up to its first event. If the provider fails before sending anything
  // useful (an error event, or an empty stream), we can still try the next model: nothing has reached
  // Claude Code yet. Returns { failed } or { stream } with the bytes read so far put back in front.
  async function peekStream(upstreamBody) {
    const it = upstreamBody[Symbol.asyncIterator]();
    const seen = [];
    const dec = new TextDecoder();
    let text = '';
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      seen.push(r.value);
      text += dec.decode(r.value, { stream: true });
      if (/^data:\s*\S/m.test(text)) break;
    }
    const first = text.split('\n').find((l) => l.startsWith('data:'));
    if (!first) return { failed: { status: 502, message: 'the model sent an empty response', type: 'api_error' } };
    try {
      const j = JSON.parse(first.slice(5).trim());
      if (j.error || j.type === 'error') {
        const e = j.error || {};
        return { failed: { status: Number(e.code) >= 400 ? Number(e.code) : 502, message: e.message || JSON.stringify(e), type: 'api_error' } };
      }
    } catch {}
    return {
      stream: (async function* () {
        for (const c of seen) yield c;
        for (;;) {
          const r = await it.next();
          if (r.done) return;
          yield r.value;
        }
      })(),
    };
  }

  // Local Ollama models use the larger-context copy `reroute pull` made, when it exists.
  async function upstreamModelName(model) {
    if (model.provider !== 'ollama' || isCloudModel(model.model)) return model.model;
    const big = ollamaContextName(model.model);
    return (await ollamaInfo()).models.has(big) ? big : model.model;
  }

  // Responds to the client on success. Returns { failed } without responding when the provider refused,
  // so the caller can try the next model.
  async function callFallback(res, body, signal, model) {
    body = bodyFor(model, body);
    const provider = cfg.providers[model.provider];
    if (!provider) return { failed: { status: 500, message: `unknown provider "${model.provider}"`, type: 'api_error' } };
    const key = providerKey(cfg, model.provider);
    const requestedModel = body.model;
    const toolNames = toolNamesOf(body);
    const upstreamModel = await upstreamModelName(model);
    // Leave room for the reply inside the model's context window.
    const room = Math.max(1024, (model.context || 131072) - estimateTokens(body) - 1024);
    // Small local models also keep replies to a quarter of their window, leaving room for the conversation.
    const maxTokens = Math.min(model.maxTokens || Infinity, room, isSmall(model) ? Math.floor((model.context || 131072) / 4) : Infinity);

    if (provider.type === 'anthropic') {
      const out = { ...body, model: upstreamModel };
      delete out.context_management;
      delete out.mcp_servers;
      delete out.container;
      if (out.max_tokens) out.max_tokens = Math.min(out.max_tokens, maxTokens);
      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(provider.headers || {}) };
      if (key) {
        headers['x-api-key'] = key;
        headers.authorization = `Bearer ${key}`;
      }
      const upstream = await fetch(provider.baseUrl.replace(/\/$/, '') + '/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(out),
        signal,
      });
      if (!upstream.ok) return { failed: await readFailure(upstream) };
      if (body.stream && upstream.body) {
        const peeked = await peekStream(upstream.body);
        if (peeked.failed) return peeked;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-reroute-model': model.id });
        markServed(model);
        try {
          for await (const chunk of peeked.stream) res.write(chunk);
        } catch (e) {
          if (!res.destroyed) log(`fallback stream error: ${e.message}`);
        }
        return res.end();
      }
      markServed(model);
      return pipeResponse(upstream, res, { 'x-reroute-model': model.id });
    }

    const oreq = anthropicToOpenAI(body, upstreamModel, { maxTokens });

    if (provider.type === 'webgpu') {
      // Downloads are gigabytes: only ever start one when asked (reroute local download / dashboard).
      if (!(engine.info.cached || []).includes(model.model)) {
        return { failed: { status: 404, message: `${model.label} isn't downloaded yet (${model.sizeGb} GB). Download it with: reroute local download ${model.id}`, type: 'not_found_error' } };
      }
      let stream;
      try {
        stream = await engine.chat(
          {
            model: { id: model.id, repo: model.model, dtype: model.dtype || 'q4f16', kind: model.kind || 'text', label: model.label },
            messages: oreq.messages,
            tools: oreq.tools || [],
            max_tokens: oreq.max_tokens,
            temperature: oreq.temperature,
          },
          signal
        );
      } catch (e) {
        return { failed: { status: e.status || 503, message: e.message, type: 'api_error' } };
      }
      const bytes = (async function* () {
        for await (const s of stream) yield Buffer.from(s);
      })();
      const peeked = await peekStream(bytes);
      if (peeked.failed) return peeked;
      markServed(model);
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-reroute-model': model.id });
        try {
          for await (const ev of openAIStreamToAnthropic(peeked.stream, requestedModel, toolNames)) res.write(ev);
        } catch (e) {
          if (!res.destroyed) res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } })}\n\n`);
        }
        return res.end();
      }
      // Non-streaming: collect the stream into one reply.
      const content = [];
      let stop = 'end_turn';
      let usage = { input_tokens: 0, output_tokens: 0 };
      for await (const ev of openAIStreamToAnthropic(peeked.stream, requestedModel, toolNames)) {
        const data = JSON.parse(ev.split('\ndata: ')[1]);
        if (data.type === 'content_block_start') content[data.index] = { ...data.content_block, ...(data.content_block.type === 'tool_use' ? { input: {} } : {}) };
        if (data.type === 'content_block_delta' && data.delta.type === 'text_delta') content[data.index].text += data.delta.text;
        if (data.type === 'content_block_delta' && data.delta.type === 'input_json_delta') content[data.index].input = JSON.parse(data.delta.partial_json || '{}');
        if (data.type === 'message_delta') {
          stop = data.delta.stop_reason;
          usage = data.usage || usage;
        }
      }
      return sendJson(res, 200, { id: 'msg_local', type: 'message', role: 'assistant', model: requestedModel, content, stop_reason: stop, stop_sequence: null, usage }, { 'x-reroute-model': model.id });
    }
    const headers = { 'content-type': 'application/json', ...(provider.headers || {}) };
    if (key) headers.authorization = `Bearer ${key}`;
    const upstream = await fetch(provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(oreq),
      signal,
    });

    if (!upstream.ok) return { failed: await readFailure(upstream) };

    if (body.stream) {
      const peeked = await peekStream(upstream.body);
      if (peeked.failed) return peeked;
      markServed(model);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-reroute-model': model.id,
      });
      try {
        for await (const ev of openAIStreamToAnthropic(peeked.stream, requestedModel, toolNames)) res.write(ev);
      } catch (e) {
        if (!res.destroyed) {
          log(`fallback stream error: ${e.message}`);
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } })}\n\n`);
        }
      }
      return res.end();
    }
    const json = await upstream.json();
    if (json.error) return { failed: { status: 502, message: json.error.message || JSON.stringify(json.error), type: 'api_error' } };
    markServed(model);
    return sendJson(res, 200, openAIToAnthropic(json, requestedModel, toolNames), { 'x-reroute-model': model.id });
  }

  function markServed(model) {
    state.requests.fallback += 1;
    state.lastRoute = { to: 'fallback', model: model.id, label: model.label, at: Date.now() };
  }

  // first: a model chosen in Claude Code's /model picker; it goes ahead of everything else.
  async function routeToFallback(res, body, signal, why, first = null, { quiet = false } = {}) {
    // Shorter skill descriptions for open models (Claude still gets the full list).
    const shrunk = compressSkillListing(body);
    body = shrunk.body;
    state.skillCharsSaved += shrunk.saved;
    const bad = skipped();
    // Anything that refused recently (including your pick) goes to the back of the line.
    let list = (await candidates()).sort((x, y) => (bad.has(x.id) ? 1 : 0) - (bad.has(y.id) ? 1 : 0));
    if (first) list = cfg.backups === false ? [first] : [first, ...list.filter((m) => m.id !== first.id)];

    // Only models whose context window holds this conversation (plus room to answer).
    const reserve = (m) => Math.min(body.max_tokens || 8192, 16384, Math.floor((m.context || 131072) / 4));
    const needFor = (m) => estimateTokens(bodyFor(m, body)) + reserve(m);
    const need = estimateTokens(body) + Math.min(body.max_tokens || 8192, 16384);
    const fits = list.filter((m) => (m.context || 131072) >= needFor(m));
    if (list.length && !fits.length) {
      // Too long for all of them: drop the oldest turns so it fits the biggest one.
      const biggest = list.reduce((a, b) => ((b.context || 0) > (a.context || 0) ? b : a));
      const budget = (biggest.context || 131072) - reserve(biggest);
      const trimmed = trimToFit(bodyFor(biggest, body), budget);
      if (!trimmed) {
        return anthropicError(
          res,
          400,
          `prompt is too long: ${estimateTokens(body)} tokens > ${budget} maximum (largest open-source model available: ${biggest.label})`,
          'invalid_request_error'
        );
      }
      log(`Conversation too long for every usable model; left out ${trimmed.dropped} old messages to fit ${biggest.label}`);
      body = trimmed.body;
      list = [biggest];
    } else if (fits.length < list.length) {
      const skippedIds = list.filter((m) => !fits.includes(m)).map((m) => m.id);
      if (first && !fits.includes(first)) log(`${first.label} can't hold this conversation (~${need} tokens); using a bigger model`);
      else if (skippedIds.length) log(`Skipping ${skippedIds.length} models too small for this conversation (~${need} tokens)`);
      list = fits;
    }

    if (!list.length) {
      return anthropicError(
        res,
        503,
        `Reroute: Claude is unavailable (${why}) and no fallback model is usable. Set a key with \`reroute key openrouter <key>\`, or start Ollama, then \`reroute use <model>\`.`,
        'overloaded_error'
      );
    }
    let last = null;
    for (const model of list) {
      let result;
      try {
        result = await callFallback(res, body, signal, model);
      } catch (e) {
        if (signal.aborted) return;
        result = { failed: { status: 502, message: e.message, type: 'api_error' } };
      }
      if (!result?.failed) {
        if (!state.onFallback && !first && !quiet && cfg.mode === 'auto') {
          state.onFallback = true;
          const until = state.fallbackUntil ? new Date(state.fallbackUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
          notify(`Switched to ${model.label}`, `Claude is unavailable (${why.slice(0, 80)}).${until ? ` Back to Claude around ${until}.` : ''}`);
        }
        return;
      }
      last = { model, ...result.failed };
      log(`fallback ${model.id} failed (${last.status}): ${last.message.slice(0, 200)}`);
      // A 400 is about the request itself; another model won't fix it, and neither will a fixed pick.
      if (last.status === 400 || cfg.backups === false) break;
      state.badModels.set(model.id, Date.now() + (last.status === 429 ? 2 : 30) * 60_000);
    }
    if (Date.now() - state.lastNoFallbackNotice > 10 * 60_000) {
      state.lastNoFallbackNotice = Date.now();
      notify('Reroute: no model answered', `Claude is unavailable and every open-source model failed. Last error: ${last.message.slice(0, 100)}`);
    }
    return anthropicError(res, last.status, `Reroute fallback (${last.model.label}): ${last.message}`, last.type);
  }

  async function handleMessages(req, res, bodyBuf, signal) {
    let body;
    try {
      body = JSON.parse(bodyBuf.toString('utf8') || '{}');
    } catch {
      return anthropicError(res, 400, 'Reroute: invalid JSON body', 'invalid_request_error');
    }

    // Picked a Reroute model in Claude Code's /model menu: skip Claude entirely.
    const direct = modelFromPickerId(cfg, body.model);
    if (direct) return routeToFallback(res, body, signal, 'chosen in Claude Code', direct === 'auto' ? null : direct);

    if (inFallback()) return routeToFallback(res, body, signal, state.fallbackReason || `mode=${cfg.mode}`);

    // Quota saver: Claude Code's small background calls (titles, summaries, quick checks) use Haiku.
    // Sending those to a free open model makes your Claude limit last longer.
    if (cfg.saveQuota && /haiku/i.test(String(body.model || '')) && (await currentFallback())) {
      state.savedByQuotaSaver += 1;
      return routeToFallback(res, body, signal, 'quota saver', null, { quiet: true });
    }

    let upstream;
    try {
      upstream = await callClaude(req, bodyBuf, signal);
    } catch (e) {
      if (signal.aborted) return;
      log(`Claude unreachable: ${e.message}`);
      if (cfg.mode === 'auto') {
        state.fallbackUntil = Date.now() + 60_000;
        state.fallbackReason = `Claude unreachable: ${e.message}`;
        return routeToFallback(res, body, signal, state.fallbackReason);
      }
      return anthropicError(res, 502, `Reroute: can't reach Claude: ${e.message}`);
    }

    recordUsage(upstream.headers);
    if (upstream.ok || cfg.mode === 'claude') {
      state.requests.claude += 1;
      state.lastRoute = { to: 'claude', at: Date.now() };
      if (upstream.ok && state.onFallback) {
        state.onFallback = false;
        log('Claude is answering again');
        notify('Back on Claude', 'Your Claude limit has reset. Reroute switched back from the open-source model.');
      }
      return pipeResponse(upstream, res);
    }

    const text = await upstream.text();
    const verdict = classifyError(upstream.status, text, upstream.headers, cfg);
    if (!verdict.fallback) {
      const headers = {};
      upstream.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k) && k !== 'content-encoding') headers[k] = v;
      });
      res.writeHead(upstream.status, headers);
      return res.end(text);
    }

    state.fallbackUntil = verdict.until;
    state.fallbackReason = verdict.reason;
    const fb = await currentFallback();
    log(`Switching to fallback ${fb ? fb.label : '(none available)'} until ${new Date(verdict.until).toLocaleString()} — ${verdict.reason}`);
    return routeToFallback(res, body, signal, verdict.reason);
  }

  // The job list reads a file per job; the dashboard and status line poll often, so reuse it briefly.
  let jobsCache = { at: 0, list: [] };
  function recentJobs() {
    if (Date.now() - jobsCache.at > 3000) jobsCache = { at: Date.now(), list: listJobs().slice(0, 30) };
    return jobsCache.list;
  }

  async function statusPayload() {
    const fb = await currentFallback();
    const oll = await usableEnv();
    const selfHosted = {};
    for (const [name, p] of Object.entries(cfg.providers)) {
      // Only servers you run yourself; the WebGPU engine has no URL and reports its own state.
      if (name !== 'ollama' && p.type === 'openai' && p.baseUrl && p.keyless && !providerKey(cfg, name)) selfHosted[name] = await selfHostedUp(name);
    }
    return {
      name: 'reroute',
      mode: cfg.mode,
      port: cfg.port,
      active: inFallback() ? 'fallback' : 'claude',
      fallbackUntil: cfg.mode === 'auto' && state.fallbackUntil > Date.now() ? state.fallbackUntil : null,
      fallbackReason: inFallback() ? state.fallbackReason || `mode=${cfg.mode}` : null,
      fallbackModel: cfg.fallbackModel,
      backups: cfg.backups !== false,
      resolvedFallback: fb ? { id: fb.id, label: fb.label, provider: fb.provider, model: fb.model } : null,
      requests: state.requests,
      lastRoute: state.lastRoute,
      startedAt: state.startedAt,
      supervised: Boolean(process.env.REROUTE_SUPERVISED),
      planChecked: Boolean(state.planChecked),
      skillTokensSaved: Math.round(state.skillCharsSaved / 3.5),
      localOnly: cfg.localOnly !== false,
      engine: engine.info,
      version: currentVersion(),
      usage: state.usage,
      update: state.update,
      saveQuota: Boolean(cfg.saveQuota),
      savedByQuotaSaver: state.savedByQuotaSaver,
      settings: {
        notify: cfg.notify !== false,
        autoUpdate: cfg.autoUpdate !== false,
        saveQuota: Boolean(cfg.saveQuota),
        localOnly: cfg.localOnly !== false,
        picker: cfg.picker || 'ready',
        pickerOrder: cfg.pickerOrder || [],
        pickerHidden: cfg.pickerHidden || [],
        statusLine: { usage: true, reset: true, update: true, ...(cfg.statusLine || {}) },
        usageWarnPercent: cfg.usageWarnPercent ?? 80,
      },
      jobs: recentJobs(),
      events: state.events.slice(0, 20),
      cooldownMinutes: cfg.cooldownMinutes,
      models: cfg.models.map((m) => {
        let usable = modelUsable(cfg, m, oll);
        if (m.provider in selfHosted && !selfHosted[m.provider]) usable = false;
        const keyless = Boolean(cfg.providers[m.provider]?.keyless);
        let needs = null;
        if (!usable) {
          if (cfg.localOnly !== false && !isLocalModel(cfg, m)) needs = 'cloud models on (local-only mode is on)';
          else if (m.provider === 'webgpu') needs = oll.engine?.webgpu === false ? 'a browser with WebGPU' : `download (${m.sizeGb} GB)`;
          else if (!providerUsable(cfg, m.provider)) needs = cfg.providers[m.provider]?.apiKeyEnv || 'API key';
          else if (m.provider in selfHosted) needs = `a server at ${cfg.providers[m.provider].baseUrl}`;
          else if (keyless && !oll.reachable) needs = 'Ollama running';
          else if (keyless && !isCloudModel(m.model)) needs = `ollama pull ${m.model}`;
        }
        const skippedUntil = state.badModels.get(m.id);
        return {
          ...m,
          providerLabel: cfg.providers[m.provider]?.label || m.provider,
          pickerId: pickerId(m),
          usable,
          needs,
          skippedUntil: skippedUntil && skippedUntil > Date.now() ? skippedUntil : null,
          notInPlan: state.planRefused.has(m.id),
        };
      }),
      providers: Object.fromEntries(
        Object.entries(cfg.providers).map(([k, p]) => [k, { label: p.label, type: p.type, baseUrl: p.baseUrl, hasKey: Boolean(providerKey(cfg, k)), keyless: Boolean(p.keyless), apiKeyEnv: p.apiKeyEnv }])
      ),
    };
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/reroute/api/status') return sendJson(res, 200, await statusPayload());
    if (url.pathname === '/reroute/api/config' && req.method === 'POST') {
      let patch;
      try {
        patch = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      const allowed = {};
      if (['auto', 'claude', 'fallback'].includes(patch.mode)) allowed.mode = patch.mode;
      if (typeof patch.fallbackModel === 'string') allowed.fallbackModel = patch.fallbackModel;
      if (typeof patch.backups === 'boolean') allowed.backups = patch.backups;
      if (Number.isFinite(patch.cooldownMinutes) && patch.cooldownMinutes > 0) allowed.cooldownMinutes = patch.cooldownMinutes;
      for (const k of ['notify', 'autoUpdate', 'saveQuota', 'localOnly']) if (typeof patch[k] === 'boolean') allowed[k] = patch[k];
      if (['ready', 'all', 'off'].includes(patch.picker)) allowed.picker = patch.picker;
      const ids = new Set(['auto', ...cfg.models.map((m) => m.id)]);
      if (Array.isArray(patch.pickerOrder)) allowed.pickerOrder = patch.pickerOrder.filter((x) => ids.has(x));
      if (Array.isArray(patch.pickerHidden)) allowed.pickerHidden = patch.pickerHidden.filter((x) => ids.has(x));
      if (patch.statusLine && typeof patch.statusLine === 'object') {
        allowed.statusLine = Object.fromEntries(['usage', 'reset', 'update'].filter((k) => typeof patch.statusLine[k] === 'boolean').map((k) => [k, patch.statusLine[k]]));
      }
      if (Number.isFinite(patch.usageWarnPercent) && patch.usageWarnPercent >= 10 && patch.usageWarnPercent <= 100) allowed.usageWarnPercent = patch.usageWarnPercent;
      saveConfig(allowed);
      refreshConfig();
      if (allowed.mode) log(`Mode set to ${allowed.mode}`);
      if (allowed.fallbackModel) state.badModels.clear();
      if (allowed.fallbackModel) log(`Fallback model set to ${allowed.fallbackModel}`);
      return sendJson(res, 200, await statusPayload());
    }
    if (url.pathname === '/reroute/api/taught') return sendJson(res, 200, { skills: listTaught() });
    if (url.pathname === '/reroute/api/teach' && req.method === 'POST') {
      let b = {};
      try {
        b = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {}
      try {
        const r = await teach(b.source, { name: b.name || undefined, description: b.description || undefined, rows: b.rows, token: providerKey(cfg, 'huggingface'), runClaude: runClaudeAsync });
        if (r.type === 'marketplace' && b.install) {
          const pick = b.install === 'all' ? r.plugins : r.plugins.filter((p) => String(b.install).split(',').includes(p.name));
          r.installed = [];
          for (const p of pick) r.installed.push({ name: p.name, ok: (await runClaudeAsync(['plugin', 'install', `${p.name}@${r.marketplace}`])).ok });
        }
        log(`Taught Claude from ${b.source}: ${r.type}${r.skills ? ' (' + r.skills.map((x) => x.name).join(', ') + ')' : ''}`);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/reroute/api/forget' && req.method === 'POST') {
      let b = {};
      try {
        b = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {}
      return sendJson(res, 200, { removed: forget(b.name || '') });
    }

    if (url.pathname === '/reroute/api/engine/download' && req.method === 'POST') {
      let b = {};
      try {
        b = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {}
      const m = cfg.models.find((x) => x.id === b.id && x.provider === 'webgpu');
      if (!m) return sendJson(res, 404, { error: 'not a local WebGPU model' });
      try {
        engine.download({ id: m.id, repo: m.model, dtype: m.dtype || 'q4f16', kind: m.kind || 'text', label: m.label });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      log(`Downloading ${m.label} (${m.sizeGb} GB) to the local engine`);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/reroute/api/engine/open' && req.method === 'POST') {
      try {
        engine.launch({ visible: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === '/reroute/api/picker/sync' && req.method === 'POST') {
      const status = await statusPayload();
      const n = setPickerRows(pickerRows(status.models, cfg));
      log(`Model menu updated: ${n} Reroute models`);
      return sendJson(res, 200, { rows: n });
    }
    if (url.pathname === '/reroute/api/update/check' && req.method === 'POST') {
      return sendJson(res, 200, await updateCheck({ install: false }));
    }
    if (url.pathname === '/reroute/api/update/install' && req.method === 'POST') {
      try {
        return sendJson(res, 200, await installUpdate());
      } catch (e) {
        return sendJson(res, 409, { error: e.message });
      }
    }
    if (url.pathname === '/reroute/api/jobs' && req.method === 'POST') {
      let b;
      try {
        b = JSON.parse((await readBody(req)).toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      const tasks = (Array.isArray(b.tasks) ? b.tasks : [b.task]).map((t) => String(t || '').trim()).filter(Boolean);
      if (!tasks.length) return sendJson(res, 400, { error: 'no task' });
      if (!b.cwd || !fs.existsSync(b.cwd)) return sendJson(res, 400, { error: 'folder not found' });
      const m = b.model && b.model !== 'claude' ? cfg.models.find((x) => x.id === b.model) : null;
      try {
        const jobs = tasks.map((task) =>
          startJob({ task, model: b.model === 'auto' ? 'claude-reroute-auto' : m ? pickerId(m) : null, cwd: b.cwd, worktree: 'auto', allowBash: Boolean(b.allowBash), cliPath: CLI_PATH, port: cfg.port, batchSize: tasks.length })
        );
        log(`Started ${jobs.length} agent job(s)`);
        return sendJson(res, 200, { jobs });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    const jobMatch = url.pathname.match(/^\/reroute\/api\/jobs\/([a-f0-9]{6})(\/stop|\/log)?$/);
    if (jobMatch) {
      const [, id, action] = jobMatch;
      if (action === '/stop' && req.method === 'POST') return sendJson(res, 200, stopJob(id) || { error: 'not found' });
      if (action === '/log') {
        let text = '';
        try {
          text = fs.readFileSync(logFile(id), 'utf8').slice(-200_000);
        } catch {}
        return sendJson(res, 200, { log: text });
      }
      return sendJson(res, 200, readJob(id) || { error: 'not found' });
    }

    if (url.pathname === '/reroute/api/reset' && req.method === 'POST') {
      state.fallbackUntil = 0;
      state.fallbackReason = '';
      state.badModels.clear();
      log('Fallback cleared, back to Claude');
      return sendJson(res, 200, await statusPayload());
    }
    if (url.pathname === '/reroute/api/shutdown' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => server.close(() => process.exit(0)), 50);
      return;
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    refreshConfig();
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    try {
      // Only this machine may use Reroute. A Host check stops DNS-rebinding pages (evil.com resolving
      // to 127.0.0.1); an Origin check stops other websites from sending requests through it.
      // Claude Code sends no Origin; the dashboard and engine page send a local one.
      const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      const origin = req.headers.origin;
      if (!LOCAL_HOSTS.has(host) || (origin && !LOCAL_ORIGIN.test(origin))) return sendJson(res, 403, { error: 'Reroute only accepts requests from this computer' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/reroute' || url.pathname === '/reroute/') {
        if (req.method === 'GET' && !req.headers['x-api-key'] && !req.headers['anthropic-version']) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(dashboardHtml());
        }
      }
      if (url.pathname === '/reroute/engine' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(enginePageHtml());
      }
      if (url.pathname.startsWith('/reroute/engine/')) {
        if (await engine.handle(req, res, url, readBody)) return;
        return sendJson(res, 404, { error: 'not found' });
      }
      if (url.pathname.startsWith('/reroute/api/')) return await handleApi(req, res, url);

      const bodyBuf = ['GET', 'HEAD'].includes(req.method) ? Buffer.alloc(0) : await readBody(req);

      if (req.method === 'POST' && url.pathname === '/v1/messages') return await handleMessages(req, res, bodyBuf, ac.signal);

      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        let body = {};
        try {
          body = JSON.parse(bodyBuf.toString('utf8'));
        } catch {}
        if (inFallback() || modelFromPickerId(cfg, body.model)) return sendJson(res, 200, { input_tokens: estimateTokens(body) });
      }

      // Everything else (models list, count_tokens, OAuth endpoints...) goes straight to Anthropic.
      const upstream = await callClaude(req, bodyBuf, ac.signal);
      return await pipeResponse(upstream, res);
    } catch (e) {
      if (ac.signal.aborted) return;
      log(`error: ${e.stack || e.message}`);
      if (!res.headersSent) anthropicError(res, 500, `Reroute internal error: ${e.message}`);
      else res.end();
    }
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  return {
    server,
    state,
    get config() {
      return cfg;
    },
    engine,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          enginePort = server.address().port;
          log(`Reroute listening on http://${host}:${server.address().port} (mode: ${cfg.mode})`);
          if (options.probe !== false) {
            setTimeout(() => probeOllamaCloud().catch(() => {}), 500).unref();
            setInterval(() => probeOllamaCloud().catch(() => {}), 6 * 3600_000).unref();
          }
          if (options.updates !== false && !process.env.REROUTE_NO_UPDATE) {
            setTimeout(() => updateCheck().catch(() => {}), 20_000).unref();
            setInterval(() => updateCheck().catch(() => {}), (cfg.updateCheckHours || 6) * 3600_000).unref();
          }
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((r) => server.close(r));
    },
  };
}

