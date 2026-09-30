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
  ollamaRoot,
  ollamaContextName,
  HOME_DIR,
  LOG_PATH,
} from './config.js';
import { classifyError } from './detect.js';
import { anthropicToOpenAI, openAIToAnthropic, openAIStreamToAnthropic, estimateTokens, trimToFit, toolNamesOf } from './translate.js';
import { notify as desktopNotify } from './notify.js';
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

export function createReroute(options = {}) {
  let cfg = loadConfig();
  let cfgMtime = configMtime();
  if (options.overrides) Object.assign(cfg, options.overrides);

  const state = {
    startedAt: Date.now(),
    fallbackUntil: 0,
    fallbackReason: '',
    requests: { claude: 0, fallback: 0 },
    lastRoute: null,
    events: [],
    ollamaModels: null,
    ollamaCheckedAt: 0,
    badModels: new Map(),
    planRefused: new Set(), // Ollama Cloud models your plan does not include (checked at startup)
    onFallback: false, // told the user we switched; tell them again when Claude is back
    lastNoFallbackNotice: 0,
  };

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
    if (refused.length) log(`Your Ollama plan doesn't include ${refused.length} cloud models; skipping them: ${refused.join(', ')}`);
  }

  async function candidates() {
    return fallbackCandidates(cfg, await ollamaInfo(), skipped());
  }

  async function currentFallback() {
    return (await candidates())[0] || null;
  }

  function inFallback() {
    if (cfg.mode === 'fallback') return true;
    if (cfg.mode === 'claude') return false;
    return Date.now() < state.fallbackUntil;
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
    const provider = cfg.providers[model.provider];
    if (!provider) return { failed: { status: 500, message: `unknown provider "${model.provider}"`, type: 'api_error' } };
    const key = providerKey(cfg, model.provider);
    const requestedModel = body.model;
    const toolNames = toolNamesOf(body);
    const upstreamModel = await upstreamModelName(model);
    // Leave room for the reply inside the model's context window.
    const room = Math.max(1024, (model.context || 131072) - estimateTokens(body) - 1024);
    const maxTokens = Math.min(model.maxTokens || Infinity, room);

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
  async function routeToFallback(res, body, signal, why, first = null) {
    const bad = skipped();
    // Anything that refused recently (including your pick) goes to the back of the line.
    let list = (await candidates()).sort((x, y) => (bad.has(x.id) ? 1 : 0) - (bad.has(y.id) ? 1 : 0));
    if (first) list = cfg.backups === false ? [first] : [first, ...list.filter((m) => m.id !== first.id)];

    // Only models whose context window holds this conversation (plus room to answer).
    const need = estimateTokens(body) + Math.min(body.max_tokens || 8192, 16384);
    const fits = list.filter((m) => (m.context || 131072) >= need);
    if (list.length && !fits.length) {
      // Too long for all of them: drop the oldest turns so it fits the biggest one.
      const biggest = list.reduce((a, b) => ((b.context || 0) > (a.context || 0) ? b : a));
      const budget = (biggest.context || 131072) - Math.min(body.max_tokens || 8192, 16384);
      const trimmed = trimToFit(body, budget);
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
        if (!state.onFallback && !first && cfg.mode === 'auto') {
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

  async function statusPayload() {
    const fb = await currentFallback();
    const oll = await ollamaInfo();
    const selfHosted = {};
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (name !== 'ollama' && p.keyless && !providerKey(cfg, name)) selfHosted[name] = await selfHostedUp(name);
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
      events: state.events.slice(0, 20),
      cooldownMinutes: cfg.cooldownMinutes,
      models: cfg.models.map((m) => {
        let usable = modelUsable(cfg, m, oll);
        if (m.provider in selfHosted && !selfHosted[m.provider]) usable = false;
        const keyless = Boolean(cfg.providers[m.provider]?.keyless);
        let needs = null;
        if (!usable) {
          if (!providerUsable(cfg, m.provider)) needs = cfg.providers[m.provider]?.apiKeyEnv || 'API key';
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
      // Only accept same-origin requests from the dashboard; block cross-site form posts.
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return sendJson(res, 403, { error: 'forbidden' });
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
      saveConfig(allowed);
      refreshConfig();
      if (allowed.mode) log(`Mode set to ${allowed.mode}`);
      if (allowed.fallbackModel) state.badModels.clear();
      if (allowed.fallbackModel) log(`Fallback model set to ${allowed.fallbackModel}`);
      return sendJson(res, 200, await statusPayload());
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
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/' || url.pathname === '/reroute' || url.pathname === '/reroute/') {
        if (req.method === 'GET' && !req.headers['x-api-key'] && !req.headers['anthropic-version']) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(dashboardHtml());
        }
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
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          log(`Reroute listening on http://${host}:${server.address().port} (mode: ${cfg.mode})`);
          if (options.probe !== false) {
            setTimeout(() => probeOllamaCloud().catch(() => {}), 500).unref();
            setInterval(() => probeOllamaCloud().catch(() => {}), 6 * 3600_000).unref();
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

