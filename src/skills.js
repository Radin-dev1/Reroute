// Skills for Claude Code from alirezarezvani/claude-skills (MIT): ~99 plugins, ~380 skills.
// Installed through Claude Code's own plugin system (`claude plugin ...`), so they update
// with the upstream repo and stay credited to their author. Reroute only picks which ones.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const MARKETPLACE = 'claude-code-skills';
// HTTPS, not owner/repo: the shorthand clones over SSH, which fails without a GitHub SSH key.
export const MARKETPLACE_URL = 'https://github.com/alirezarezvani/claude-skills.git';
export const SKILLS_HOME = 'https://github.com/alirezarezvani/claude-skills';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CLONE_DIR = path.join(CLAUDE_DIR, 'plugins', 'marketplaces', MARKETPLACE);

// Packs group the marketplace by the folder each plugin lives in, so new upstream plugins land
// in the right pack automatically. "coding" is a hand-picked starter set.
export const PACKS = {
  coding: {
    label: 'Coding essentials (recommended)',
    plugins: [
      'engineering-skills',
      'karpathy-coder',
      'zero-hallucination-coder',
      'grill-me',
      'grill-with-docs',
      'handoff-engineering',
      'code-tour',
      'docker-development',
      'a11y-audit',
      'write-a-skill',
      'skill-doctor',
      'llm-cost-optimizer',
    ],
  },
  engineering: { label: 'All engineering (architecture, DevOps, security, data, agents...)', dirs: ['engineering', 'engineering-team', 'agent-launcher', 'markdown-html'] },
  product: { label: 'Product and project management', dirs: ['product-team', 'project-management'] },
  research: { label: 'Research (deep research, literature, patents, due diligence...)', dirs: ['research', 'research-ops'] },
  productivity: { label: 'Productivity (handoffs, weekly review, deep work, email...)', dirs: ['productivity'] },
  marketing: { label: 'Marketing (content, SEO, CRO, LinkedIn, landing pages...)', dirs: ['marketing', 'marketing-skill'] },
  business: { label: 'Business (C-level advisors, finance, sales, operations)', dirs: ['c-level-advisor', 'c-level-agents', 'business-growth', 'finance', 'commercial', 'business-operations'] },
  compliance: { label: 'Compliance (ISO, EU AI Act, MedTech QMS...)', dirs: ['ra-qm-team', 'compliance-os'] },
  all: { label: 'Everything in the collection', dirs: '*' },
};

function claude(args) {
  const opts = { encoding: 'utf8', windowsHide: true };
  let r = spawnSync('claude', args, opts);
  // npm installs Claude Code as claude.cmd on Windows, which only runs through a shell.
  // Every argument here is a fixed word, a plugin name or our URL, checked before it goes in.
  if (r.error?.code === 'ENOENT' && process.platform === 'win32') {
    if (!args.every((a) => /^[\w.@:/-]+$/.test(a))) throw new Error(`unsafe argument for claude: ${args.join(' ')}`);
    r = spawnSync(['claude', ...args].join(' '), { ...opts, shell: true });
  }
  if (r.error) throw new Error(`couldn't run \`claude\` (${r.error.code || r.error.message}). Is Claude Code installed and on your PATH?`);
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

// Adds (or refreshes) the marketplace in Claude Code and returns its plugin list.
export function ensureMarketplace({ refresh = false } = {}) {
  const manifest = path.join(CLONE_DIR, '.claude-plugin', 'marketplace.json');
  if (!fs.existsSync(manifest)) {
    const r = claude(['plugin', 'marketplace', 'add', MARKETPLACE_URL]);
    if (!r.ok && !fs.existsSync(manifest)) throw new Error(`couldn't add the skills marketplace:\n${r.out}`);
  } else if (refresh) {
    claude(['plugin', 'marketplace', 'update', MARKETPLACE]);
  }
  return readMarketplace();
}

export function readMarketplace() {
  const manifest = path.join(CLONE_DIR, '.claude-plugin', 'marketplace.json');
  const j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  return j.plugins.map((p) => {
    const src = typeof p.source === 'string' ? p.source.replace(/^\.\//, '') : '';
    const dir = path.join(CLONE_DIR, src);
    let hooks = fs.existsSync(path.join(dir, 'hooks', 'hooks.json'));
    try {
      if (/"hooks"\s*:/.test(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))) hooks = true;
    } catch {}
    return { name: p.name, description: p.description || '', folder: src.split('/')[0], hooks };
  });
}

export function resolve(targets, plugins) {
  const byName = new Map(plugins.map((p) => [p.name, p]));
  const out = new Map();
  const unknown = [];
  for (const t of targets) {
    const pack = PACKS[t];
    if (pack) {
      const list = pack.plugins
        ? pack.plugins.map((n) => byName.get(n)).filter(Boolean)
        : plugins.filter((p) => pack.dirs === '*' || pack.dirs.includes(p.folder));
      for (const p of list) out.set(p.name, p);
    } else if (byName.has(t)) out.set(t, byName.get(t));
    else unknown.push(t);
  }
  return { plugins: [...out.values()], unknown };
}

export function installPlugin(name) {
  return claude(['plugin', 'install', `${name}@${MARKETPLACE}`]);
}

export function updatePlugin(name) {
  return claude(['plugin', 'update', `${name}@${MARKETPLACE}`]);
}

export function uninstallPlugin(name) {
  return claude(['plugin', 'uninstall', `${name}@${MARKETPLACE}`]);
}

// Claude Code's own estimate of the tokens a plugin adds to every session.
export function alwaysOnTokens(name) {
  const r = claude(['plugin', 'details', `${name}@${MARKETPLACE}`]);
  const m = r.out.match(/Always-on:\s*~([\d.]+)(k?)\s*tok/i);
  return m ? Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1)) : 0;
}

export function installedNames() {
  const r = claude(['plugin', 'list']);
  const names = new Set();
  for (const m of r.out.matchAll(new RegExp(`([\\w.-]+)@${MARKETPLACE}`, 'g'))) names.add(m[1]);
  return names;
}
