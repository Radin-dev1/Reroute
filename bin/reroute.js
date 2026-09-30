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
  toolSearchOn,
  CLI_PATH,
  CLAUDE_SETTINGS,
} from '../src/install.js';
import { PICKER_PREFIX } from '../src/config.js';
import * as skills from '../src/skills.js';
import readline from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import * as jobs from '../src/jobs.js';
import * as tor from '../src/tor.js';
import { applyUpdate, checkForUpdate, currentVersion } from '../src/update.js';
import { notify } from '../src/notify.js';

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
  run "<task>" ["<task>"...] [--model <id|claude>] [--allow-bash] [--no-worktree]
                       Run tasks as parallel Claude Code agents in the background
  jobs [<id>]          List agent jobs, or show one (jobs log <id>, jobs stop <id>, jobs clean)
  agents <on|off|model <id>>
                       Open-model helper agents Claude can hand work to in parallel
  tor <on|off|status|check|open [url]>
                       Tor tools for Claude (fetch pages and .onion sites through Tor, open Tor Browser)
  update [--check]     Update Reroute from GitHub (it also updates itself unless autoUpdate is off)
  version              Show the installed version
  skills [list]        Skill packs from github.com/alirezarezvani/claude-skills (~380 skills)
  skills add <pack|plugin...> [--allow-hooks]
                       Install a pack (coding, engineering, product, research, productivity,
                       marketing, business, compliance, all) or single plugins
  skills remove <pack|plugin...|all>
  skills update        Get the latest skills from the collection
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
  let s = await running();
  if (!s) {
    if (!quiet) console.log('Reroute is not running, so the model picker was not updated.');
    return null;
  }
  // Wait (up to 30s) for the startup check of your Ollama plan, so refused models stay out of the menu.
  for (let i = 0; i < 60 && !s.planChecked; i++) {
    await new Promise((r) => setTimeout(r, 500));
    s = (await running()) || s;
  }
  try {
    const { rows: n } = await api('picker/sync', {});
    if (!quiet) console.log(n ? `Added ${n} Reroute models to the Claude Code /model menu. Restart Claude Code or the desktop app to see them.` : 'Removed Reroute models from the /model menu.');
    return n;
  } catch {}
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

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const UPDATE_COMMAND_FILE = path.join(CLAUDE_DIR, 'commands', 'reroute-update.md');
const fwd = (p) => `"${p.replace(/\\/g, '/')}"`;

// /reroute-update inside Claude Code: updates Reroute and reports the result.
function writeUpdateCommand() {
  fs.mkdirSync(path.dirname(UPDATE_COMMAND_FILE), { recursive: true });
  const cmd = `${fwd(process.execPath)} ${fwd(CLI_PATH)} update`;
  fs.writeFileSync(
    UPDATE_COMMAND_FILE,
    `---\ndescription: Update Reroute to the latest version from GitHub\nallowed-tools: Bash(${cmd})\n---\n\nReroute update output:\n\n!\`${cmd}\`\n\nTell me in one or two sentences what happened. (Installed by Reroute.)\n`
  );
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
    'Tool search',
    async () => (toolSearchOn() ? { level: 'ok', msg: 'on (MCP tools load only when needed)' } : { level: 'warn', msg: 'off: Claude Code sends every MCP tool with every request, which can be 200k+ tokens' }),
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
        if (code === 75) {
          appendLog('watchdog: restarting after an update');
          delay = 1000;
          return setTimeout(launch, 200);
        }
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
    const seg = { usage: true, reset: true, update: true, ...(s.settings?.statusLine || {}) };
    const extras = [];
    if (seg.usage && s.usage && (s.usage.fiveHour != null || s.usage.sevenDay != null)) {
      const parts = [];
      if (s.usage.fiveHour != null) parts.push(`5h ${Math.round(s.usage.fiveHour)}%`);
      if (s.usage.sevenDay != null) parts.push(`week ${Math.round(s.usage.sevenDay)}%`);
      extras.push(parts.join(' · '));
    }
    if (seg.update && s.update?.available) extras.push('⬆ update ready: /reroute-update');
    const tail = extras.length ? '  |  ' + extras.join('  |  ') : '';
    const picked = String(input.model?.id || '').toLowerCase();
    if (picked.startsWith(PICKER_PREFIX)) {
      const m = picked === PICKER_PREFIX + 'auto' ? s.resolvedFallback : s.models.find((x) => x.pickerId === picked);
      console.log(`⇄ ${m?.label || picked} · open source${tail}`);
    } else if (s.active === 'fallback') {
      const label = s.lastRoute?.to === 'fallback' ? s.lastRoute.label : s.resolvedFallback?.label;
      const back = seg.reset && s.fallbackUntil ? ` · Claude back ${shortTime(s.fallbackUntil)}` : s.mode === 'fallback' ? ' · mode: open source' : '';
      console.log(`⇄ ${label || 'no open model available'}${back}${tail}`);
    } else {
      console.log(`⇄ Claude${s.mode === 'claude' ? ' · fallback off' : ''}${tail}`);
    }
    break;
  }

  case 'doctor': {
    const ok = await doctor(args.includes('--fix'));
    // exitCode instead of exit(): exiting while sockets close trips a libuv assertion on Windows.
    process.exitCode = ok ? 0 : 1;
    break;
  }

  case 'skills': {
    const [sub = 'list', ...rest] = args;
    const allowHooks = rest.includes('--allow-hooks');
    const targets = rest.filter((a) => !a.startsWith('--'));
    const tracked = new Set(readRawConfig().skillPlugins || []);
    const saveTracked = () => saveConfig({ skillPlugins: [...tracked].sort() });
    try {
      if (sub === 'list') {
        let plugins = null;
        try {
          plugins = skills.readMarketplace();
        } catch {}
        const installed = plugins ? skills.installedNames() : new Set();
        console.log(`Skills from ${skills.SKILLS_HOME} (MIT, by Alireza Rezvani)\n`);
        for (const [id, pack] of Object.entries(skills.PACKS)) {
          const list = plugins ? skills.resolve([id], plugins).plugins : null;
          const have = list ? list.filter((p) => installed.has(p.name)).length : 0;
          const count = list ? ` ${have}/${list.length} plugins installed` : '';
          console.log(`  ${id.padEnd(13)} ${pack.label}${count}`);
        }
        console.log(`\nInstall with: reroute skills add coding   (or any pack, several packs, or plugin names)`);
        if (!plugins) console.log('The collection is downloaded the first time you add a pack.');
        break;
      }

      if (sub === 'update') {
        skills.ensureMarketplace({ refresh: true });
        const have = skills.installedNames();
        for (const name of tracked) if (have.has(name)) console.log(`  ${name}: ${skills.updatePlugin(name).ok ? 'updated' : 'update failed'}`);
        console.log('Updated. Restart Claude Code to load the new versions.');
        break;
      }

      if (sub === 'add') {
        if (!targets.length) throw new Error('Usage: reroute skills add <pack|plugin...> [--allow-hooks]   (see reroute skills)');
        console.log('Getting the skills collection…');
        const plugins = skills.ensureMarketplace();
        const { plugins: picked, unknown } = skills.resolve(targets, plugins);
        if (unknown.length) console.log(`Not found: ${unknown.join(', ')} (packs: ${Object.keys(skills.PACKS).join(', ')})`);
        let chosen = picked;
        const withHooks = picked.filter((p) => p.hooks);
        if (withHooks.length && !allowHooks) {
          console.log(`\n${withHooks.length} of these run hooks (code that runs automatically during your sessions): ${withHooks.map((p) => p.name).join(', ')}`);
          let yes = false;
          if (process.stdin.isTTY) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            yes = /^y/i.test(await rl.question('Install those too? [y/N] '));
            rl.close();
          } else console.log('Skipping them. Add --allow-hooks to include them.');
          if (!yes) chosen = picked.filter((p) => !p.hooks);
        }
        const have = skills.installedNames();
        let added = 0;
        const failed = [];
        for (const p of chosen) {
          if (have.has(p.name)) continue;
          process.stdout.write(`  installing ${p.name}… `);
          const r = skills.installPlugin(p.name);
          console.log(r.ok ? 'done' : 'failed');
          if (r.ok) {
            added++;
            tracked.add(p.name);
          } else failed.push(`${p.name}: ${r.out.split('\n').pop()}`);
        }
        saveTracked();
        const already = chosen.length - added - failed.length;
        console.log(`\nInstalled ${added} plugins${already ? ` (${already} were already installed)` : ''}.`);
        if (failed.length) console.log(`Failed:\n  ${failed.join('\n  ')}`);
        if (added && added <= 15) {
          const cost = chosen.filter((p) => tracked.has(p.name)).reduce((sum, p) => sum + skills.alwaysOnTokens(p.name), 0);
          console.log(`Claude Code estimates they add ~${cost.toLocaleString()} tokens to every session.`);
        } else if (added) {
          console.log('A big set adds a lot to every session (everything is ~25k tokens). Reroute shortens the skill list when an open model answers.');
        }
        console.log('Restart Claude Code (terminal and desktop app) to load them.');
        break;
      }

      if (sub === 'remove') {
        if (!targets.length) throw new Error('Usage: reroute skills remove <pack|plugin...|all>');
        const plugins = skills.readMarketplace();
        const { plugins: picked } = skills.resolve(targets, plugins);
        const have = skills.installedNames();
        let removed = 0;
        for (const p of picked) {
          // Packs only remove what Reroute installed; naming a plugin removes it either way.
          if (!have.has(p.name) || (!targets.includes(p.name) && !tracked.has(p.name))) continue;
          const r = skills.uninstallPlugin(p.name);
          if (r.ok) {
            removed++;
            tracked.delete(p.name);
          } else console.log(`  ${p.name}: ${r.out.split('\n').pop()}`);
        }
        saveTracked();
        console.log(`Removed ${removed} plugins. Restart Claude Code to unload them.`);
        break;
      }

      throw new Error(`Unknown: reroute skills ${sub}. Use list, add, remove or update.`);
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    }
    break;
  }

  case 'version': {
    const v = currentVersion();
    console.log(`Reroute ${v.version}${v.commit ? ` (${v.commit})` : ''}`);
    break;
  }

  case 'update': {
    const checkOnly = args.includes('--check');
    try {
      const u = await checkForUpdate();
      if (!u.available) {
        console.log(`Reroute is up to date (${currentVersion().version}, ${currentVersion().commit}).`);
        break;
      }
      console.log(`Update available: ${u.latest?.subject || u.latest?.version}${u.behind ? ` (${u.behind} new commit${u.behind > 1 ? 's' : ''})` : ''}`);
      if (checkOnly) break;
      if (await running()) {
        const r = await api('update/install', {});
        if (r.error) throw new Error(r.error);
        console.log(`Updated to ${r.current?.version} (${r.current?.commit}).${(await running())?.supervised ? ' Reroute restarts itself with it now.' : ' Restart Reroute to use it.'}`);
      } else {
        const r = applyUpdate();
        console.log(`Updated to ${r.to.version} (${r.to.commit}).`);
      }
    } catch (e) {
      console.error(`Couldn't update: ${e.message}`);
      process.exitCode = 1;
    }
    break;
  }

  case 'run': {
    const flags = new Set(args.filter((a) => a.startsWith('--')));
    const mi = args.indexOf('--model');
    const modelId = mi >= 0 ? args[mi + 1] : null;
    const tasks = args.filter((a, i) => !a.startsWith('--') && !(mi >= 0 && i === mi + 1));
    if (!tasks.length) {
      console.error('Usage: reroute run "<task>" ["<task>"...] [--model <id|claude>] [--allow-bash] [--no-worktree]');
      process.exitCode = 1;
      break;
    }
    const model = modelId && modelId !== 'claude' ? cfg.models.find((m) => m.id === modelId) : null;
    if (modelId && modelId !== 'claude' && !model) {
      console.error(`Unknown model "${modelId}". See reroute models.`);
      process.exitCode = 1;
      break;
    }
    if (!(await startDetached())) {
      console.error('Reroute failed to start. Run reroute doctor.');
      process.exitCode = 1;
      break;
    }
    const { pickerId } = await import('../src/config.js');
    try {
      for (const task of tasks) {
        const j = jobs.startJob({
          task,
          model: model ? pickerId(model) : null,
          cwd: process.cwd(),
          worktree: flags.has('--no-worktree') ? false : flags.has('--worktree') ? true : 'auto',
          allowBash: flags.has('--allow-bash'),
          cliPath: CLI_PATH,
          port: cfg.port,
          batchSize: tasks.length,
        });
        console.log(`Started job ${j.id} on ${model ? model.label : 'Claude'}${j.branch ? ` in ${j.workdir} (branch ${j.branch})` : ''}`);
      }
      console.log('\nThey run in the background. Follow them with: reroute jobs   (or in the dashboard)');
      if (!flags.has('--allow-bash')) console.log('Jobs can read and edit files. Add --allow-bash to let them run commands too.');
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    }
    break;
  }

  case '_job': {
    jobs.runJob(args[0], {
      onDone: (j) => {
        if (loadConfig().notify === false) return;
        notify(j.status === 'done' ? `Job ${j.id} finished` : `Job ${j.id} failed`, (j.status === 'done' ? j.result || 'Done.' : j.error || 'Failed.').slice(0, 180));
      },
    });
    break;
  }

  case 'jobs': {
    const [sub, id] = args;
    if (sub === 'stop') {
      const j = jobs.stopJob(id);
      console.log(j ? `Stopped job ${id}.` : `No job ${id}.`);
      break;
    }
    if (sub === 'log') {
      try {
        const lines = fs.readFileSync(jobs.logFile(id), 'utf8').trim().split('\n');
        for (const l of lines) {
          try {
            const ev = JSON.parse(l);
            if (ev.type === 'assistant') for (const b of ev.message?.content || []) {
              if (b.type === 'text' && b.text.trim()) console.log(b.text.trim());
              if (b.type === 'tool_use') console.log(`  → ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`);
            }
            if (ev.type === 'result') console.log(`\n[${ev.is_error ? 'failed' : 'done'}] ${ev.result || ''}`);
          } catch {}
        }
      } catch {
        console.log(`No log for job ${id}.`);
      }
      break;
    }
    if (sub === 'clean') {
      console.log(`Removed ${jobs.cleanJobs()} finished jobs (worktrees with uncommitted changes were kept).`);
      break;
    }
    const one = sub ? jobs.readJob(sub) : null;
    if (sub && !one) {
      console.log(`No job ${sub}.`);
      break;
    }
    const list = one ? [one] : jobs.listJobs();
    if (!list.length) console.log('No jobs yet. Start some with: reroute run "task one" "task two"');
    for (const j of list) {
      const took = j.endedAt && j.startedAt ? ` ${Math.round((j.endedAt - j.startedAt) / 1000)}s` : '';
      console.log(`${j.id}  ${j.status.padEnd(8)}${took.padEnd(7)} ${(j.model || 'Claude').replace('claude-reroute-', '').padEnd(24)} ${j.task.slice(0, 60)}`);
      if (one) {
        console.log(`  folder: ${j.workdir}${j.branch ? ` (branch ${j.branch})` : ''}`);
        if (j.progress && j.status === 'running') console.log(`  now: ${j.progress}`);
        if (j.result) console.log(`\n${j.result}`);
        if (j.error) console.log(`\nError: ${j.error}`);
      }
    }
    break;
  }

  case 'agents': {
    const [sub, id] = args;
    const { pickerId, PICKER_PREFIX: P } = await import('../src/config.js');
    if (sub === 'off') {
      console.log(`Removed ${jobs.removeHelpers(CLAUDE_DIR)} helper agents.`);
      break;
    }
    if (sub === 'on' || sub === 'model') {
      const m = id && id !== 'auto' ? cfg.models.find((x) => x.id === id) : null;
      if (id && id !== 'auto' && !m) {
        console.error(`Unknown model "${id}". See reroute models.`);
        process.exitCode = 1;
        break;
      }
      const model = m ? pickerId(m) : P + 'auto';
      const names = jobs.writeHelpers(CLAUDE_DIR, model);
      saveConfig({ helperModel: m ? m.id : 'auto' });
      console.log(`Installed ${names.join(', ')} on ${m ? m.label : 'the best available open model'}.`);
      console.log('Claude can now hand work to them, several at once, without using your Claude quota.');
      console.log('Ask for it directly ("use reroute-researcher agents to look into X and Y in parallel") or let Claude decide. Restart Claude Code to load them.');
      break;
    }
    const have = jobs.HELPERS.filter((h) => fs.existsSync(jobs.helperFile(CLAUDE_DIR, h.name)));
    console.log(have.length ? `Helper agents installed: ${have.map((h) => h.name).join(', ')} (model: ${readRawConfig().helperModel || 'auto'})` : 'No helper agents installed. Add them with: reroute agents on');
    break;
  }

  case 'tor-mcp': {
    tor.runMcpServer(currentVersion().version);
    break;
  }

  case 'tor': {
    const [sub = 'status', url] = args;
    if (sub === 'on') {
      skills.runClaude(['mcp', 'remove', '--scope', 'user', 'reroute-tor']);
      const r = skills.runClaude(['mcp', 'add', '--scope', 'user', 'reroute-tor', '--', process.execPath, CLI_PATH, 'tor-mcp']);
      if (!r.ok) {
        console.error(`Couldn't add the Tor tools to Claude Code:\n${r.out}`);
        process.exitCode = 1;
        break;
      }
      const tb = tor.torBrowserPaths();
      console.log('Added Tor tools to Claude Code: tor_fetch (pages and .onion sites through Tor), tor_check, tor_open_browser.');
      console.log(tb ? `Tor comes from your Tor Browser (${path.dirname(path.dirname(tb.browser))}). It doesn't need to be open.` : 'Tor Browser was not found. Install it from https://www.torproject.org so the tools can connect.');
      console.log('Restart Claude Code, then ask e.g. "open https://check.torproject.org over Tor".');
      break;
    }
    if (sub === 'off') {
      const r = skills.runClaude(['mcp', 'remove', '--scope', 'user', 'reroute-tor']);
      console.log(r.ok ? 'Removed the Tor tools from Claude Code.' : 'The Tor tools were not installed.');
      break;
    }
    if (sub === 'open') {
      try {
        tor.openInTorBrowser(url);
        console.log(`Opened ${url || 'Tor Browser'}.`);
      } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
      }
      break;
    }
    if (sub === 'check') {
      try {
        console.log('Connecting to Tor…');
        const r = await tor.torFetch('https://check.torproject.org/api/ip');
        const j = JSON.parse(r.body);
        console.log(j.IsTor ? `Working: traffic goes through Tor (exit IP ${j.IP}).` : `Not going through Tor (IP ${j.IP}).`);
      } catch (e) {
        console.error(e.message);
        process.exitCode = 1;
      }
      tor.stopOwnTor();
      break;
    }
    const listed = skills.runClaude(['mcp', 'list']).out.includes('reroute-tor');
    const tb = tor.torBrowserPaths();
    const port = await tor.ensureTor({ start: false });
    console.log(`Tor tools in Claude Code: ${listed ? 'on' : 'off (turn on with: reroute tor on)'}`);
    console.log(`Tor Browser: ${tb ? tb.browser : 'not found'}`);
    console.log(`Tor running: ${port ? `yes, port ${port}` : 'no (started automatically when a tool needs it)'}`);
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
    writeUpdateCommand();
    const pickerRows = await syncPicker(true);
    console.log(`Reroute is running on ${url}`);
    console.log(`Set ANTHROPIC_BASE_URL in ${file}${previous ? ` (previous value ${previous} saved)` : ''}`);
    console.log(`Starts on login: ${auto} (with a watchdog that restarts it if it stops)`);
    console.log('Claude Code will also start Reroute itself when a session opens, if it is not running.');
    console.log('Reroute updates itself from GitHub; you can also type /reroute-update in Claude Code.');
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
    fs.rmSync(UPDATE_COMMAND_FILE, { force: true });
    jobs.removeHelpers(CLAUDE_DIR);
    skills.runClaude(['mcp', 'remove', '--scope', 'user', 'reroute-tor']);
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
      env: { ENABLE_TOOL_SEARCH: 'true', ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.port}` },
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
