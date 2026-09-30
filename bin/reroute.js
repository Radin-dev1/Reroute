#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, saveConfig, readRawConfig, providerKey, ollamaRoot, ollamaContextName, CONFIG_PATH, LOG_PATH, HOME_DIR } from '../src/config.js';
import { createReroute } from '../src/server.js';
import {
  patchClaudeSettings,
  unpatchClaudeSettings,
  setPickerRows,
  isInstalled,
  installAutostart,
  removeAutostart,
  setEnsureHook,
  hasEnsureHook,
  setStatusLine,
  statusLineState,
  pickerRowCount,
  claudeBaseUrl,
  autostartInstalled,
  CLI_PATH,
  CLAUDE_SETTINGS,
} from '../src/install.js';
import { PICKER_PREFIX } from '../src/config.js';

const HELP = `Reroute: use Claude until you run out, then switch to the best open-source model.

Usage: reroute <command>

  install              Point Claude Code (terminal + desktop app) at Reroute, start it now and on login
  uninstall            Undo install (restores your Claude Code settings)
  claude [args...]     Run the \`claude\` CLI through Reroute without changing any settings
  start [--port N]     Run the proxy in the foreground
  daemon               Run the proxy under a watchdog that restarts it if it stops (used on login)
  stop                 Stop the running proxy
  doctor [--fix]       Check the whole setup and fix what's wrong
  status               Show whether you're on Claude or the fallback
  open                 Open the dashboard in your browser
  models               List fallback models and which ones you can use
  use <model|auto>     Choose the fallback model ("auto" = best available)
  backups <on|off>     If your chosen model fails, try the others (default on)
  picker <ready|all|off>
                       Which Reroute models appear in Claude Code's /model menu (default: ready)
  sync                 Refresh the /model menu (after adding keys or pulling models)
  add <id> <provider> <model-name> [label]
                       Add any model, e.g. reroute add my-qwen openrouter qwen/qwen3.8-flash
  remove <id>          Remove a model you added
  pull <id>            Download a local Ollama model and give it a bigger context (e.g. reroute pull ollama-gemma4-e2b)
  notify <on|off>      Desktop notifications when Reroute switches models (default on)
  mode <auto|claude|fallback>
                       auto: switch when credits run out (default)
                       claude: never switch; fallback: always use the open-source model
  key <provider> <key> Save an API key (openrouter, deepseek, zai, moonshot, groq, ollama)
  reset                Leave the fallback now and retry Claude
  logs                 Print the log file

Config: ${CONFIG_PATH}`;

const cfg = loadConfig();
const base = () => `http://127.0.0.1:${loadConfig().port}`;

async function api(path, body) {
  const r = await fetch(base() + '/reroute/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  return r.json();
}

async function running() {
  try {
    const s = await api('status');
    return s?.name === 'reroute' ? s : null;
  } catch {
    return null;
  }
}

async function startDetached() {
  if (await running()) return true;
  const child = spawn(process.execPath, [CLI_PATH, 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await running()) return true;
  }
  return false;
}

// Puts Reroute's models in Claude Code's /model picker (terminal + desktop app).
// picker: "ready" (default) = only models you can use right now, "all" = every model, "off" = none.
// Claude Code handles these rows like this known model (prompt style, effort defaults) instead of warning
// about an unrecognized model. The model ID it sends is still the Reroute one.
const BEHAVES_AS = 'claude-sonnet-4-6';

async function syncPicker(quiet = false) {
  const s = await running();
  if (!s) {
    if (!quiet) console.log('Reroute is not running, so the model picker was not updated.');
    return null;
  }
  const which = loadConfig().picker || 'ready';
  const refused = which === 'ready' ? await refusedOllamaCloud(s.models) : new Set();
  const rows = [];
  if (which !== 'off') {
    rows.push({ model: PICKER_PREFIX + 'auto', label: 'Open source: best available', description: 'Reroute picks the best open model you can use', behavesAs: BEHAVES_AS });
    for (const m of s.models) {
      if (which !== 'all' && (!m.usable || m.notInPlan || refused.has(m.id))) continue;
      if (which === 'all' && m.autoPick === false && !m.usable) continue;
      rows.push({ model: m.pickerId, label: m.label, description: ['Via Reroute', m.providerLabel, m.note].filter(Boolean).join(' · '), behavesAs: BEHAVES_AS });
    }
  }
  const n = setPickerRows(rows);
  if (!quiet) {
    console.log(
      n
        ? `Added ${n} Reroute models to the Claude Code /model menu. Restart Claude Code or the desktop app to see them.`
        : 'Removed Reroute models from the /model menu.'
    );
  }
  return n;
}

// Ollama Cloud models your plan doesn't include answer 402 right away, and a refusal costs nothing.
// A 1-token test call tells which ones to leave out of the menu.
async function refusedOllamaCloud(models) {
  const c = loadConfig();
  const base = ollamaRoot(c);
  const cloud = models.filter((m) => m.provider === 'ollama' && m.usable && /(:|-)cloud$/.test(m.model));
  const refused = new Set();
  // Two at a time: Ollama answers bursts of parallel calls with errors that don't say whether the model is included.
  const queue = [...cloud];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      try {
        const r = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: AbortSignal.timeout(20_000),
        });
        if ([401, 402, 403, 404].includes(r.status)) refused.add(m.id);
        await r.body?.cancel();
      } catch {}
    }
  };
  await Promise.all([worker(), worker()]);
  return refused;
}

async function syncIfInstalled() {
  if (isInstalled()) await syncPicker();
}

function appendLog(msg) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// Local Ollama models: make a copy with a context big enough for Claude Code (Ollama's default is 4k-32k).
async function createContextCopy(m) {
  const c = loadConfig();
  const r = await fetch(`${ollamaRoot(c)}/api/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: ollamaContextName(m.model), from: m.model, parameters: { num_ctx: c.localContext }, stream: false }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return ollamaContextName(m.model);
}

function readStdin(ms) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => resolve(data);
    setTimeout(done, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function shortTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function doctor(fix) {
  const results = [];
  const check = async (name, fn, fixer) => {
    let r;
    try {
      r = await fn();
    } catch (e) {
      r = { level: 'bad', msg: e.message };
    }
    if (r.level !== 'ok' && fix && fixer) {
      try {
        await fixer();
        const again = await fn();
        r = again.level === 'ok' ? { level: 'fixed', msg: again.msg } : { ...again, msg: again.msg + ' (fix did not help)' };
      } catch (e) {
        r = { level: 'bad', msg: `${r.msg} (fix failed: ${e.message})` };
      }
    }
    results.push({ name, ...r });
    const icon = { ok: '✓', fixed: '✓', warn: '!', bad: '✗' }[r.level];
    console.log(`${icon} ${name.padEnd(22)} ${r.level === 'fixed' ? 'fixed: ' : ''}${r.msg}`);
  };
  const url = `http://127.0.0.1:${cfg.port}`;

  await check('Node.js', async () => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    return maj > 18 || (maj === 18 && min >= 17) ? { level: 'ok', msg: process.version } : { level: 'bad', msg: `${process.version}; Reroute needs 18.17 or newer` };
  });

  await check(
    'Proxy running',
    async () => {
      const s = await running();
      if (!s) return { level: 'bad', msg: `nothing answering on ${url}` };
      return s.supervised ? { level: 'ok', msg: `${url}, watched by the watchdog` } : { level: 'warn', msg: `${url}, but without the watchdog (it won't restart if it stops)` };
    },
    async () => {
      if (await running()) {
        await api('shutdown', {}).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!(await startDetached())) throw new Error('could not start it; run `reroute start` to see why');
    }
  );

  await check(
    'Claude Code settings',
    async () => {
      const b = claudeBaseUrl();
      if (!b) return { level: 'bad', msg: `ANTHROPIC_BASE_URL not set in ${CLAUDE_SETTINGS} (run reroute install)` };
      return b.replace(/\/$/, '') === url ? { level: 'ok', msg: `ANTHROPIC_BASE_URL = ${b}` } : { level: 'bad', msg: `ANTHROPIC_BASE_URL is ${b}, expected ${url}` };
    },
    async () => patchClaudeSettings(url)
  );

  await check(
    'Session-start hook',
    async () => (hasEnsureHook() ? { level: 'ok', msg: 'Claude Code starts Reroute if it is not running' } : { level: 'warn', msg: 'missing' }),
    async () => setEnsureHook(true)
  );

  await check(
    'Starts on login',
    async () => (autostartInstalled() ? { level: 'ok', msg: 'yes' } : { level: 'warn', msg: 'no' }),
    async () => installAutostart()
  );

  await check('Anthropic reachable', async () => {
    try {
      const r = await fetch(cfg.anthropicBaseUrl, { signal: AbortSignal.timeout(6000) });
      await r.body?.cancel();
      return { level: 'ok', msg: cfg.anthropicBaseUrl };
    } catch (e) {
      return { level: 'warn', msg: `can't reach ${cfg.anthropicBaseUrl} (${e.cause?.code || e.message}); Reroute will use open-source models` };
    }
  });

  const s = await running();
  await check('Fallback models', async () => {
    if (!s) return { level: 'warn', msg: 'unknown (proxy not running)' };
    const n = s.models.filter((m) => m.usable).length;
    if (!n) return { level: 'bad', msg: 'none usable: add a key (reroute key openrouter ...) or run ollama signin' };
    return { level: 'ok', msg: `${n} usable; first choice ${s.resolvedFallback?.label}` };
  });

  if (s) {
    const locals = s.models.filter((m) => m.usable && m.local && m.provider === 'ollama');
    if (locals.length) {
      let tags = new Set();
      try {
        const j = await (await fetch(`${ollamaRoot(cfg)}/api/tags`)).json();
        tags = new Set((j.models || []).map((x) => x.name.replace(/:latest$/, '')));
      } catch {}
      const missing = locals.filter((m) => !tags.has(ollamaContextName(m.model)));
      await check(
        'Local model context',
        async () => {
          let t = new Set();
          try {
            const j = await (await fetch(`${ollamaRoot(cfg)}/api/tags`)).json();
            t = new Set((j.models || []).map((x) => x.name.replace(/:latest$/, '')));
          } catch {}
          const still = locals.filter((m) => !t.has(ollamaContextName(m.model)));
          return still.length
            ? { level: 'warn', msg: `${still.map((m) => m.label).join(', ')} still use Ollama's small default context` }
            : { level: 'ok', msg: `${locals.length} local models set to ${cfg.localContext} tokens` };
        },
        async () => {
          for (const m of missing) await createContextCopy(m);
        }
      );
    }
  }

  await check(
    'Model menu',
    async () => {
      const n = pickerRowCount();
      return n ? { level: 'ok', msg: `${n} Reroute models in /model` } : { level: 'warn', msg: 'no Reroute models in /model' };
    },
    async () => syncPicker(true)
  );

  await check(
    'Status line',
    async () => {
      const st = statusLineState();
      if (st === 'ours') return { level: 'ok', msg: 'shows which model is answering' };
      if (st === 'taken') return { level: 'ok', msg: 'you have your own status line (add `reroute statusline` to it to see Reroute there)' };
      return { level: 'warn', msg: 'not set' };
    },
    async () => setStatusLine(true)
  );

  const bad = results.filter((r) => r.level === 'bad').length;
  const warn = results.filter((r) => r.level === 'warn').length;
  console.log(bad || warn ? `\n${bad} problems, ${warn} warnings.${fix ? '' : ' Run `reroute doctor --fix` to fix them.'}` : '\nEverything looks good.');
  return bad === 0;
}

function fmtUntil(ms) {
  return ms ? new Date(ms).toLocaleString() : '';
}

function printStatus(s) {
  const using = s.active === 'fallback' ? (s.resolvedFallback ? s.resolvedFallback.label : 'NO USABLE FALLBACK') : 'Claude';
  console.log(`Reroute on ${base()}  (mode: ${s.mode})`);
  console.log(`Now using: ${using}${s.fallbackUntil ? `  until ${fmtUntil(s.fallbackUntil)}` : ''}`);
  if (s.fallbackReason) console.log(`Why: ${s.fallbackReason}`);
  console.log(`Fallback pick: ${s.fallbackModel}${s.resolvedFallback ? ` -> ${s.resolvedFallback.label} (${s.resolvedFallback.provider}: ${s.resolvedFallback.model})` : ' -> none usable yet'}`);
  console.log(`Requests: Claude ${s.requests.claude}, fallback ${s.requests.fallback}`);
  console.log(`Dashboard: ${base()}/`);
}

function openUrl(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'start': {
    const pi = args.indexOf('--port');
    const port = pi >= 0 ? Number(args[pi + 1]) : cfg.port;
    const quiet = args.includes('--quiet');
    if (await running()) {
      console.log(`Reroute is already running on ${base()}`);
      break;
    }
    process.on('uncaughtException', (e) => appendLog(`uncaught: ${e.stack || e.message}`));
    process.on('unhandledRejection', (e) => appendLog(`unhandled: ${e?.stack || e}`));
    const app = createReroute({ quiet });
    try {
      await app.listen(port);
    } catch (e) {
      console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Change "port" in ${CONFIG_PATH}.` : e.message);
      process.exit(1);
    }
    if (!quiet) console.log(`Dashboard: http://127.0.0.1:${port}/`);
    break;
  }

  case 'daemon': {
    // Watchdog: runs the proxy as a child and restarts it if it exits unexpectedly.
    // Exits when the proxy stops cleanly (reroute stop / uninstall) or another copy already runs.
    if (await running()) break;
    let delay = 1000;
    const launch = () => {
      const startedAt = Date.now();
      const child = spawn(process.execPath, [CLI_PATH, 'start', '--quiet'], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, REROUTE_SUPERVISED: '1' },
      });
      child.on('exit', (code, signal) => {
        if (code === 0) process.exit(0);
        delay = Date.now() - startedAt > 60_000 ? 1000 : Math.min(delay * 2, 30_000);
        appendLog(`watchdog: proxy exited (${signal || code}); restarting in ${delay / 1000}s`);
        setTimeout(launch, delay);
      });
    };
    launch();
    break;
  }

  case 'ensure': {
    // Called by Claude Code's SessionStart hook. Must be quick and never fail the session.
    try {
      if (!(await running())) {
        appendLog('ensure: Reroute was not running; starting it for Claude Code');
        await startDetached();
      }
    } catch {}
    process.exitCode = 0;
    break;
  }

  case 'statusline': {
    // Claude Code runs this and shows the first line under the prompt. It passes session info as JSON on stdin.
    let input = {};
    try {
      input = JSON.parse((await readStdin(300)) || '{}');
    } catch {}
    let s = null;
    try {
      const r = await fetch(base() + '/reroute/api/status', { signal: AbortSignal.timeout(700) });
      s = await r.json();
    } catch {}
    if (!s) {
      console.log('⇄ Reroute is off · run: reroute doctor --fix');
      break;
    }
    const picked = String(input.model?.id || '').toLowerCase();
    if (picked.startsWith(PICKER_PREFIX)) {
      const m = picked === PICKER_PREFIX + 'auto' ? s.resolvedFallback : s.models.find((x) => x.pickerId === picked);
      console.log(`⇄ ${m?.label || picked} · open source`);
    } else if (s.active === 'fallback') {
      const label = s.lastRoute?.to === 'fallback' ? s.lastRoute.label : s.resolvedFallback?.label;
      const back = s.fallbackUntil ? ` · Claude back ${shortTime(s.fallbackUntil)}` : s.mode === 'fallback' ? ' · mode: open source' : '';
      console.log(`⇄ ${label || 'no open model available'}${back}`);
    } else {
      console.log(`⇄ Claude${s.mode === 'claude' ? ' · fallback off' : ''}`);
    }
    break;
  }

  case 'doctor': {
    const ok = await doctor(args.includes('--fix'));
    // exitCode instead of exit(): exiting while sockets close trips a libuv assertion on Windows.
    process.exitCode = ok ? 0 : 1;
    break;
  }

  case 'notify': {
    const v = args[0];
    if (!['on', 'off'].includes(v)) {
      console.error('Usage: reroute notify <on|off>');
      process.exit(1);
    }
    saveConfig({ notify: v === 'on' });
    console.log(`Notifications ${v}`);
    break;
  }

  case 'install': {
    const url = `http://127.0.0.1:${cfg.port}`;
    const ok = await startDetached();
    if (!ok) {
      console.error('Reroute failed to start, so Claude Code settings were not changed. Try `reroute start` to see the error.');
      process.exit(1);
    }
    const { file, previous } = patchClaudeSettings(url);
    const auto = installAutostart();
    setEnsureHook(true);
    const line = setStatusLine(true);
    const pickerRows = await syncPicker(true);
    console.log(`Reroute is running on ${url}`);
    console.log(`Set ANTHROPIC_BASE_URL in ${file}${previous ? ` (previous value ${previous} saved)` : ''}`);
    console.log(`Starts on login: ${auto} (with a watchdog that restarts it if it stops)`);
    console.log('Claude Code will also start Reroute itself when a session opens, if it is not running.');
    if (line === 'taken') console.log('You already have a status line, so it was left alone. Add `reroute statusline` to it to see which model is answering.');
    else console.log('Status line: shows which model is answering, under the Claude Code prompt.');
    if (pickerRows) console.log(`Added ${pickerRows} open-source models to the /model menu in Claude Code (terminal and desktop).`);
    console.log('\nRestart Claude Code (terminal) and the Claude desktop app so they pick up the change.');
    const s = await running();
    if (s && !s.resolvedFallback) {
      console.log('\nNo fallback model is usable yet. Do one of these:');
      console.log('  reroute key openrouter sk-or-...   (then any OpenRouter model works)');
      console.log('  ollama signin                      (Ollama :cloud models)');
      console.log('  ollama pull qwen3-coder:30b        (fully local)');
    }
    break;
  }

  case 'uninstall': {
    unpatchClaudeSettings();
    const f = removeAutostart();
    try {
      await api('shutdown', {});
    } catch {}
    console.log(`Removed Reroute from ${CLAUDE_SETTINGS}${f ? ` and ${f}` : ''}. Restart Claude Code / the desktop app.`);
    break;
  }

  case 'claude': {
    if (!(await startDetached())) {
      console.error('Reroute failed to start. Run `reroute start` to see why.');
      process.exit(1);
    }
    const child = spawn('claude', args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.port}` },
    });
    child.on('exit', (code) => process.exit(code ?? 0));
    break;
  }

  case 'stop': {
    try {
      await api('shutdown', {});
      console.log('Stopped.');
    } catch {
      console.log('Reroute is not running.');
    }
    break;
  }

  case 'status': {
    const s = await running();
    if (!s) {
      console.log('Reroute is not running. Start it with `reroute start` or `reroute install`.');
      process.exit(1);
    }
    printStatus(s);
    break;
  }

  case 'open':
    await startDetached();
    openUrl(base() + '/');
    break;

  case 'models': {
    const s = await running();
    const models = s ? s.models : cfg.models.map((m) => ({ ...m, usable: Boolean(providerKey(cfg, m.provider)) }));
    const pick = s ? s.fallbackModel : cfg.fallbackModel;
    console.log(`${pick === 'auto' ? '*' : ' '} auto                              best available${s?.resolvedFallback && pick === 'auto' ? ` (now: ${s.resolvedFallback.label})` : ''}`);
    for (const m of models) {
      const mark = pick === m.id ? '*' : ' ';
      const avail = m.usable ? 'ready' : `needs ${m.needs || 'key'}`;
      console.log(`${mark} ${m.id.padEnd(33)} ${m.label.padEnd(38)} ${avail}`);
    }
    if (!s) console.log('\n(Reroute is not running; Ollama availability not checked.)');
    break;
  }

  case 'use': {
    const id = args[0];
    if (!id) {
      console.error('Usage: reroute use <model-id|auto>   (see `reroute models`)');
      process.exit(1);
    }
    if (id !== 'auto' && !cfg.models.some((m) => m.id === id)) {
      console.error(`Unknown model "${id}". See \`reroute models\`, or add it under "customModels" in ${CONFIG_PATH}.`);
      process.exit(1);
    }
    saveConfig({ fallbackModel: id });
    console.log(`Fallback model: ${id}`);
    break;
  }

  case 'sync':
    await syncPicker();
    break;

  case 'picker': {
    const v = args[0];
    if (!['ready', 'all', 'off'].includes(v)) {
      console.error('Usage: reroute picker <ready|all|off>   (which Reroute models show in the Claude Code /model menu)');
      process.exit(1);
    }
    saveConfig({ picker: v });
    await syncPicker();
    break;
  }

  case 'backups': {
    const v = args[0];
    if (!['on', 'off'].includes(v)) {
      console.error('Usage: reroute backups <on|off>');
      process.exit(1);
    }
    saveConfig({ backups: v === 'on' });
    console.log(`Backups ${v}`);
    break;
  }

  case 'add': {
    const [id, provider, model, ...labelParts] = args;
    if (!id || !provider || !model) {
      console.error('Usage: reroute add <id> <provider> <model-name> [label]');
      console.error(`Providers: ${Object.keys(cfg.providers).join(', ')}`);
      process.exit(1);
    }
    if (!cfg.providers[provider]) {
      console.error(`Unknown provider "${provider}". Providers: ${Object.keys(cfg.providers).join(', ')}`);
      process.exit(1);
    }
    const raw = readRawConfig();
    const custom = (raw.customModels || []).filter((m) => m.id !== id);
    custom.push({ id, label: labelParts.join(' ') || `${model} (${provider})`, provider, model });
    saveConfig({ customModels: custom });
    console.log(`Added ${id}. Choose it with: reroute use ${id}`);
    await syncIfInstalled();
    break;
  }

  case 'remove': {
    const raw = readRawConfig();
    const before = (raw.customModels || []).length;
    const custom = (raw.customModels || []).filter((m) => m.id !== args[0]);
    if (custom.length === before) {
      console.error(`No added model "${args[0]}". Built-in models can't be removed.`);
      process.exit(1);
    }
    saveConfig({ customModels: custom, ...(raw.fallbackModel === args[0] ? { fallbackModel: 'auto' } : {}) });
    console.log(`Removed ${args[0]}`);
    await syncIfInstalled();
    break;
  }

  case 'pull': {
    const m = cfg.models.find((x) => x.id === args[0]);
    if (!m || m.provider !== 'ollama') {
      console.error('Usage: reroute pull <ollama model id>   (see `reroute models`)');
      process.exit(1);
    }
    const child = spawn('ollama', ['pull', m.model], { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => {
      if (code !== 0) process.exit(code ?? 1);
      createContextCopy(m)
        .then((name) => console.log(`\nMade ${name} with a ${cfg.localContext}-token context (Ollama's default is too small for Claude Code).`))
        .catch((e) => console.log(`\nCouldn't give it a bigger context (${e.message}); it will use Ollama's default.`))
        .then(() => {
          console.log(`Ready. Choose it with: reroute use ${m.id}`);
          return syncIfInstalled();
        })
        .then(() => process.exit(0));
    });
    break;
  }

  case 'mode': {
    const m = args[0];
    if (!['auto', 'claude', 'fallback'].includes(m)) {
      console.error('Usage: reroute mode <auto|claude|fallback>');
      process.exit(1);
    }
    saveConfig({ mode: m });
    console.log(`Mode: ${m}`);
    break;
  }

  case 'key': {
    const [provider, key] = args;
    if (!provider || !key || !cfg.providers[provider]) {
      console.error(`Usage: reroute key <${Object.keys(cfg.providers).join('|')}> <api-key>`);
      process.exit(1);
    }
    const raw = JSON.parse(fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '{}');
    saveConfig({ apiKeys: { ...(raw.apiKeys || {}), [provider]: key } });
    console.log(`Saved ${provider} key to ${CONFIG_PATH}`);
    await syncIfInstalled();
    break;
  }

  case 'reset': {
    try {
      printStatus(await api('reset', {}));
    } catch {
      console.log('Reroute is not running.');
    }
    break;
  }

  case 'logs':
    try {
      process.stdout.write(fs.readFileSync(LOG_PATH, 'utf8').split('\n').slice(-100).join('\n'));
    } catch {
      console.log('No logs yet.');
    }
    break;

  default:
    console.log(HELP);
}
