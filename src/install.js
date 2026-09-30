// Points Claude Code (terminal CLI + the desktop app's Code tab, which both read ~/.claude/settings.json)
// at the local Reroute proxy, and registers Reroute to start on login.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return { file: CLAUDE_SETTINGS, previous: prev || null };
}

export function unpatchClaudeSettings() {
  const settings = readJson(CLAUDE_SETTINGS);
  if (!settings.env) return false;
  const prev = settings.env.REROUTE_PREVIOUS_BASE_URL;
  delete settings.env.REROUTE_PREVIOUS_BASE_URL;
  if (prev) settings.env.ANTHROPIC_BASE_URL = prev;
  else delete settings.env.ANTHROPIC_BASE_URL;
  if (!Object.keys(settings.env).length) delete settings.env;
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

function autostartPaths() {
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
    fs.writeFileSync(file, `CreateObject("WScript.Shell").Run """${q(node)}"" ""${q(CLI_PATH)}"" start", 0, False\r\n`);
  } else if (process.platform === 'darwin') {
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.reroute.proxy</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${CLI_PATH}</string><string>start</string></array>
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
      `[Desktop Entry]\nType=Application\nName=Reroute\nExec="${node}" "${CLI_PATH}" start\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`
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
