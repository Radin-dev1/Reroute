// Points Claude Code (terminal CLI + the desktop app's Code tab, which both read ~/.claude/settings.json)
// at the local Reroute proxy, and registers Reroute to start on login.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PICKER_PREFIX } from './config.js';

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'reroute.js');
export const CLAUDE_SETTINGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Can't parse ${file}: ${e.message}. Fix it by hand, then retry.`);
  }
}

export function patchClaudeSettings(baseUrl) {
  const settings = readJson(CLAUDE_SETTINGS);
  if (fs.existsSync(CLAUDE_SETTINGS)) fs.copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + '.reroute-backup');
  settings.env = settings.env || {};
  const prev = settings.env.ANTHROPIC_BASE_URL;
  if (prev && prev !== baseUrl && !settings.env.REROUTE_PREVIOUS_BASE_URL) settings.env.REROUTE_PREVIOUS_BASE_URL = prev;
  settings.env.ANTHROPIC_BASE_URL = baseUrl;
  // Claude Code turns tool search off for any base URL that isn't Anthropic's, which puts every MCP tool
  // into every request (240k+ tokens with lots of MCP servers). Reroute forwards tool search as-is,
  // and handles it for open models, so it stays on.
  if (!('ENABLE_TOOL_SEARCH' in settings.env)) {
    settings.env.ENABLE_TOOL_SEARCH = 'true';
    settings.env.REROUTE_SET_TOOL_SEARCH = '1';
  }
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return { file: CLAUDE_SETTINGS, previous: prev || null };
}

// Rows in Claude Code's /model picker (terminal and desktop). Rows you added yourself are kept.
export function setPickerRows(rows) {
  const settings = readJson(CLAUDE_SETTINGS);
  const own = (settings.modelPicker?.options || []).filter((o) => !String(o?.model || '').startsWith(PICKER_PREFIX));
  const options = [...own, ...rows];
  if (options.length) settings.modelPicker = { ...(settings.modelPicker || {}), options };
  else delete settings.modelPicker;
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return rows.length;
}

// ---------------------------------------------------------------------------
// The Claude desktop app sets ANTHROPIC_BASE_URL itself for its Code sessions, which overrides the
// one in ~/.claude/settings.json. Claude Code's OS-level managed settings outrank that, so this is
// where the desktop app has to be pointed at Reroute. Writing there needs administrator rights.

export function managedSettingsPath() {
  if (process.platform === 'win32') return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

export function desktopRouting() {
  try {
    const j = JSON.parse(fs.readFileSync(managedSettingsPath(), 'utf8'));
    return { on: Boolean(j.env?.REROUTE_MANAGED), baseUrl: j.env?.ANTHROPIC_BASE_URL || null };
  } catch {
    return { on: false, baseUrl: null };
  }
}

// Returns { file } or throws with code 'EPERM' when not running as administrator.
export function setDesktopRouting(on, baseUrl) {
  const file = managedSettingsPath();
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const createdByUs = j.env?.REROUTE_MANAGED === 'created';
  j.env = j.env || {};
  if (on) {
    const fresh = !fs.existsSync(file);
    // "merge" keeps every other settings source working: only these env keys are enforced.
    if (fresh || !j.parentSettingsBehavior) j.parentSettingsBehavior = 'merge';
    j.env.ANTHROPIC_BASE_URL = baseUrl;
    j.env.ENABLE_TOOL_SEARCH = j.env.ENABLE_TOOL_SEARCH || 'true';
    j.env.REROUTE_MANAGED = fresh ? 'created' : j.env.REROUTE_MANAGED || 'added';
  } else {
    if (!j.env.REROUTE_MANAGED) return { file, changed: false };
    delete j.env.ANTHROPIC_BASE_URL;
    delete j.env.REROUTE_MANAGED;
    if (j.env.ENABLE_TOOL_SEARCH === 'true') delete j.env.ENABLE_TOOL_SEARCH;
    if (!Object.keys(j.env).length) delete j.env;
    if (createdByUs && Object.keys(j).every((k) => k === 'parentSettingsBehavior')) {
      fs.rmSync(file);
      return { file, changed: true, removed: true };
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  return { file, changed: true };
}

export function isInstalled() {
  const settings = readJson(CLAUDE_SETTINGS);
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(settings.env?.ANTHROPIC_BASE_URL || '');
}

// Commands Reroute puts in Claude Code's settings. Recognized by the " ensure" / " statusline" suffix on our script.
// Always quoted, forward slashes: works whether Claude Code runs it through cmd, PowerShell or Git Bash.
const q = (p) => `"${p.replace(/\\/g, '/')}"`;
export const ENSURE_COMMAND = `${q(process.execPath)} ${q(CLI_PATH)} ensure`;
export const STATUSLINE_COMMAND = `${q(process.execPath)} ${q(CLI_PATH)} statusline`;
const isOurs = (cmd, verb) => typeof cmd === 'string' && cmd.includes('reroute.js') && cmd.trim().endsWith(verb);

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

// A SessionStart hook: every time Claude Code (terminal or desktop) opens a session, it makes sure
// Reroute is running before the first request goes out.
export function setEnsureHook(on = true) {
  const settings = readJson(CLAUDE_SETTINGS);
  const groups = (settings.hooks?.SessionStart || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command, 'ensure')) }))
    .filter((g) => g.hooks.length);
  if (on) groups.push({ hooks: [{ type: 'command', command: ENSURE_COMMAND, timeout: 15 }] });
  settings.hooks = { ...(settings.hooks || {}), SessionStart: groups };
  if (!groups.length) delete settings.hooks.SessionStart;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeSettings(settings);
}

export function hasEnsureHook() {
  const settings = readJson(CLAUDE_SETTINGS);
  return (settings.hooks?.SessionStart || []).some((g) => (g.hooks || []).some((h) => isOurs(h.command, 'ensure')));
}

// The status line under Claude Code's prompt. Only set when you don't already have one.
// Returns 'set' | 'ours' | 'taken'.
export function setStatusLine(on = true) {
  const settings = readJson(CLAUDE_SETTINGS);
  const current = settings.statusLine?.command;
  const ours = isOurs(current, 'statusline');
  if (!on) {
    if (ours) {
      delete settings.statusLine;
      writeSettings(settings);
    }
    return ours ? 'removed' : 'kept';
  }
  if (current && !ours) return 'taken';
  settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND, padding: 0 };
  writeSettings(settings);
  return ours ? 'ours' : 'set';
}

export function statusLineState() {
  const current = readJson(CLAUDE_SETTINGS).statusLine?.command;
  return !current ? 'none' : isOurs(current, 'statusline') ? 'ours' : 'taken';
}

export function pickerRowCount() {
  return (readJson(CLAUDE_SETTINGS).modelPicker?.options || []).filter((o) => String(o?.model || '').startsWith(PICKER_PREFIX)).length;
}

export function toolSearchOn() {
  const v = readJson(CLAUDE_SETTINGS).env?.ENABLE_TOOL_SEARCH;
  return v != null && !/^(false|0|off)$/i.test(String(v));
}

export function claudeBaseUrl() {
  return readJson(CLAUDE_SETTINGS).env?.ANTHROPIC_BASE_URL || null;
}

export function autostartInstalled() {
  return fs.existsSync(autostartPaths().file);
}

export function unpatchClaudeSettings() {
  setPickerRows([]);
  setEnsureHook(false);
  setStatusLine(false);
  const settings = readJson(CLAUDE_SETTINGS);
  if (!settings.env) return false;
  const prev = settings.env.REROUTE_PREVIOUS_BASE_URL;
  delete settings.env.REROUTE_PREVIOUS_BASE_URL;
  if (settings.env.REROUTE_SET_TOOL_SEARCH) {
    delete settings.env.ENABLE_TOOL_SEARCH;
    delete settings.env.REROUTE_SET_TOOL_SEARCH;
  }
  if (prev) settings.env.ANTHROPIC_BASE_URL = prev;
  else delete settings.env.ANTHROPIC_BASE_URL;
  if (!Object.keys(settings.env).length) delete settings.env;
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

export function autostartPaths() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return { file: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'reroute.vbs') };
  }
  if (process.platform === 'darwin') return { file: path.join(home, 'Library', 'LaunchAgents', 'dev.reroute.proxy.plist') };
  return { file: path.join(home, '.config', 'autostart', 'reroute.desktop') };
}

export function installAutostart() {
  const { file } = autostartPaths();
  const node = process.execPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (process.platform === 'win32') {
    // A .vbs in the Startup folder runs node with no console window.
    const q = (s) => s.replace(/"/g, '""');
    fs.writeFileSync(file, `CreateObject("WScript.Shell").Run """${q(node)}"" ""${q(CLI_PATH)}"" daemon", 0, False\r\n`);
  } else if (process.platform === 'darwin') {
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.reroute.proxy</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${CLI_PATH}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`
    );
    try {
      execFileSync('launchctl', ['load', '-w', file], { stdio: 'ignore' });
    } catch {}
  } else {
    fs.writeFileSync(
      file,
      `[Desktop Entry]\nType=Application\nName=Reroute\nExec="${node}" "${CLI_PATH}" daemon\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`
    );
  }
  return file;
}

export function removeAutostart() {
  const { file } = autostartPaths();
  if (process.platform === 'darwin') {
    try {
      execFileSync('launchctl', ['unload', '-w', file], { stdio: 'ignore' });
    } catch {}
  }
  try {
    fs.unlinkSync(file);
    return file;
  } catch {
    return null;
  }
}

export { CLI_PATH };
