// "Teach Claude": turn a link into a Claude Code skill.
//
//   GitHub repo with a plugin marketplace   -> added as a marketplace (install its plugins as usual)
//   GitHub repo/folder with SKILL.md files  -> those skills, copied into ~/.claude/skills
//   Any other GitHub repo                   -> a knowledge skill from its README and docs
//   Hugging Face dataset                    -> card, columns, sample rows, and how to load it
//   Hugging Face model                      -> model card and usage
//   Any web page                            -> its text as a reference
//   A local folder or file                  -> its docs/text as a reference
//
// Skills land in ~/.claude/skills/<name>/ (Claude Code's personal skills folder) and load next session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { htmlToText } from './tor.js';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const MARKER = '.reroute-source.json';
const execFileAsync = promisify(execFile);

const MAX_FILE = 400_000; // characters per reference file
const MAX_TOTAL = 3_000_000; // characters per skill
const TEXT_EXT = /\.(md|mdx|markdown|txt|rst|adoc|html?|json|ya?ml|toml|ipynb|py|js|ts|tsx|jsx|lua|luau|go|rs|java|kt|cs|cpp|c|h|rb|php|sh|ps1|sql)$/i;

export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'skill';
}

// Lines every card has that say nothing about the thing itself.
const BOILERPLATE = /^(table of contents|for more (details|information)|please (refer|see|check|cite|note)|check out|visit |see (our|the) |if you (find|use)|copyright|this (model|dataset) card|we (thank|would like))/i;

// The best short summary in a README or model/dataset card: the paragraph under a "Summary" /
// "Description" / "Overview" heading if there is one, else the first real paragraph. Tables of
// contents, badge rows and bullet lists are skipped.
function firstParagraph(md) {
  const text = String(md || '')
    .replace(/^---[\s\S]*?\n---\s*/m, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const isProse = (block) => {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) return false;
    const listy = lines.filter((l) => /^\s*([-*+]|\d+\.|\|)/.test(l) || /^#+\s/.test(l)).length;
    return listy / lines.length < 0.5;
  };
  const clean = (block) => block.replace(/^#+\s.*$/gm, '').replace(/[`*_>|]/g, '').replace(/\s+/g, ' ').trim();
  const blocks = text.split(/\n\s*\n/);
  const heading = blocks.findIndex((b) => /^#+\s*(dataset\s+)?(summary|description|overview|about|introduction|model\s+(summary|description|overview))\b/im.test(b.trim()));
  for (const start of heading >= 0 ? [heading, 0] : [0]) {
    for (let i = start; i < blocks.length; i++) {
      const b = blocks[i];
      if (!isProse(b)) continue;
      const t = clean(b);
      if (t.length > 40 && !/^(\[|!|<|\()/.test(t) && !BOILERPLATE.test(t)) return t.slice(0, 400);
    }
  }
  return '';
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', ndash: '–', mdash: '—', hellip: '…', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', reg: '®', trade: '™' };
  return String(s || '')
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

function sentence(s, n = 220) {
  const t = String(s || '').trim();
  const stop = t.search(/[.!?](\s|$)/);
  const one = stop > 20 && stop < n ? t.slice(0, stop + 1) : t.slice(0, n);
  return one.replace(/\s+/g, ' ').trim();
}

function yamlQuote(s) {
  return JSON.stringify(String(s).replace(/\s+/g, ' ').trim());
}

async function get(url, { json = false, token = null, timeout = 30_000 } = {}) {
  const headers = { 'user-agent': 'Reroute (https://github.com/Radin-dev1/Reroute)' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!r.ok) throw Object.assign(new Error(`${url} answered ${r.status}`), { status: r.status });
  return json ? r.json() : r.text();
}

// ---------------------------------------------------------------------------
// Link parsing

export function parseSource(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('paste a link or a path');
  if (fs.existsSync(s)) return { kind: 'local', path: path.resolve(s) };
  let u;
  try {
    u = new URL(/^[\w.-]+\.[a-z]{2,}\//i.test(s) ? `https://${s}` : s);
  } catch {
    // owner/repo shorthand
    if (/^[\w.-]+\/[\w.-]+$/.test(s)) return { kind: 'github', owner: s.split('/')[0], repo: s.split('/')[1], ref: null, sub: '' };
    throw new Error(`"${s}" isn't a link or an existing path`);
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)github\.com$/.test(u.hostname) && parts.length >= 2) {
    const [owner, repo, kind, ref, ...rest] = parts;
    return { kind: 'github', owner, repo: repo.replace(/\.git$/, ''), ref: kind === 'tree' || kind === 'blob' ? ref : null, sub: kind === 'tree' || kind === 'blob' ? rest.join('/') : '', blob: kind === 'blob' };
  }
  if (/(^|\.)huggingface\.co$/.test(u.hostname) || u.hostname === 'hf.co') {
    if (parts[0] === 'datasets' && parts.length >= 3) return { kind: 'hf-dataset', id: `${parts[1]}/${parts[2]}` };
    if (parts[0] === 'spaces' && parts.length >= 3) return { kind: 'web', url: u.toString() };
    if (parts.length >= 2 && parts[0] !== 'docs' && parts[0] !== 'blog') return { kind: 'hf-model', id: `${parts[0]}/${parts[1]}` };
  }
  return { kind: 'web', url: u.toString() };
}

// ---------------------------------------------------------------------------
// Writing skills

// A folder name that won't clobber anything: re-teaching the same source replaces Reroute's own copy,
// but a skill you made or installed some other way is never touched (the new one gets "-2", "-3"...).
function freeName(name, source) {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${name}-${i}`;
    const dir = path.join(SKILLS_DIR, candidate);
    if (!fs.existsSync(dir)) return candidate;
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')).source === source) return candidate;
    } catch {}
  }
}

function writeSkill({ name: wanted, description, body, references = [], source, type, copyDir = null }) {
  const name = freeName(wanted, source);
  const dir = path.join(SKILLS_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (copyDir) {
    fs.cpSync(copyDir, dir, { recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) });
  } else {
    const refs = references.length ? `\n\n## Reference files\n\nRead these when you need details (paths relative to this skill's folder):\n\n${references.map((r) => `- \`references/${r.file}\`${r.about ? ` — ${r.about}` : ''}`).join('\n')}\n` : '';
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${yamlQuote(description)}\n---\n\n${body.trim()}${refs}`);
    if (references.length) {
      fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
      for (const r of references) {
        const p = path.join(dir, 'references', r.file);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, r.content);
      }
    }
  }
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ source, type, addedAt: Date.now() }, null, 2));
  return { name, dir, type, source };
}

function scriptsIn(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(py|js|mjs|cjs|ts|sh|ps1|bat|cmd|exe)$/i.test(e.name)) out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

function findSkillDirs(root) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      out.push(d);
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(d, e.name), depth + 1);
  };
  walk(root, 0);
  return out;
}

function skillNameFrom(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^name:\s*["']?([^\n"']+)/m);
    if (m) return slug(m[1]);
  } catch {}
  return slug(path.basename(dir));
}

// Collects docs from a folder: README first, then docs/ and other text files, within size limits.
function collectDocs(root, { preferDocs = true } = {}) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'vendor', '__pycache__', 'venv', '.venv'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (TEXT_EXT.test(e.name)) files.push(p);
    }
  };
  if (fs.statSync(root).isFile()) files.push(root);
  else walk(root, 0);
  const rank = (p) => {
    const r = path.relative(root, p).replace(/\\/g, '/').toLowerCase();
    if (/^readme\.(md|mdx|txt|rst)$/.test(r)) return 0;
    if (/(^|\/)(docs?|documentation|guide|guides|wiki)\//.test(r) && /\.(md|mdx|rst|txt)$/.test(r)) return 1;
    if (/\.(md|mdx|rst)$/.test(r)) return 2;
    if (/(^|\/)(examples?|samples?)\//.test(r)) return 3;
    return preferDocs ? 5 : 4;
  };
  files.sort((a, b) => rank(a) - rank(b) || a.length - b.length);
  const refs = [];
  let total = 0;
  for (const f of files) {
    if (preferDocs && rank(f) >= 5 && refs.length >= 8) continue;
    let content;
    try {
      content = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (/\u0000/.test(content)) continue;
    if (/\.html?$/i.test(f)) content = htmlToText(content);
    if (content.length > MAX_FILE) content = content.slice(0, MAX_FILE) + '\n\n[cut: file too long]';
    if (total + content.length > MAX_TOTAL) break;
    total += content.length;
    const rel = fs.statSync(root).isFile() ? path.basename(f) : path.relative(root, f);
    refs.push({ file: rel.replace(/\\/g, '/').replace(/\.(html?)$/i, '.txt'), content });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Handlers

async function fromGithub(src, opts, runClaude) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-teach-'));
  const url = `https://github.com/${src.owner}/${src.repo}.git`;
  try {
    const args = ['clone', '-q', '--depth', '1'];
    if (src.ref) args.push('--branch', src.ref);
    // Async: this runs inside the proxy too, which must keep serving Claude Code while a big repo clones.
    await execFileAsync('git', [...args, url, tmp], { windowsHide: true, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`couldn't download ${url}: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
  try {
    let root = path.join(tmp, src.sub || '');
    if (src.blob && fs.existsSync(root) && fs.statSync(root).isFile()) root = path.basename(root) === 'SKILL.md' ? path.dirname(root) : root;
    if (!fs.existsSync(root)) throw new Error(`${src.sub} doesn't exist in ${src.owner}/${src.repo}`);
    const source = `https://github.com/${src.owner}/${src.repo}${src.sub ? `/tree/${src.ref || 'HEAD'}/${src.sub}` : ''}`;

    // 1. A plugin marketplace: add it to Claude Code the proper way.
    const mk = path.join(tmp, '.claude-plugin', 'marketplace.json');
    if (!src.sub && fs.existsSync(mk) && runClaude) {
      const j = JSON.parse(fs.readFileSync(mk, 'utf8'));
      const r = await runClaude(['plugin', 'marketplace', 'add', url]);
      if (!r.ok && !/already/i.test(r.out)) throw new Error(`couldn't add the marketplace: ${r.out.split('\n').pop()}`);
      return { type: 'marketplace', marketplace: j.name, plugins: (j.plugins || []).map((p) => ({ name: p.name, description: p.description || '' })), source };
    }

    // 2. Skills already written as SKILL.md: install them as they are.
    const dirs = fs.statSync(root).isDirectory() ? findSkillDirs(root) : [];
    if (dirs.length) {
      const installed = [];
      for (const d of dirs) {
        const name = opts.name && dirs.length === 1 ? slug(opts.name) : skillNameFrom(d);
        installed.push({ ...writeSkill({ name, source, type: 'skill', copyDir: d }), scripts: scriptsIn(d) });
      }
      return { type: 'skills', skills: installed, source };
    }

    // 3. Anything else: a knowledge skill from the repo's docs.
    const refs = collectDocs(root);
    if (!refs.length) throw new Error('found no README or docs to learn from in that repo');
    const readme = refs.find((r) => /^readme\./i.test(r.file))?.content || refs[0].content;
    let about = firstParagraph(readme);
    try {
      const meta = await get(`https://api.github.com/repos/${src.owner}/${src.repo}`, { json: true, timeout: 10_000 });
      if (meta.description) about = meta.description + (about ? ` ${about}` : '');
    } catch {}
    const name = slug(opts.name || (src.sub ? path.basename(src.sub) : src.repo));
    const title = opts.name || (src.sub ? path.basename(src.sub) : `${src.owner}/${src.repo}`);
    const description =
      opts.description ||
      `Knowledge about ${title} (${source}): ${sentence(about) || 'its README and documentation'} Use when the user works with, asks about, or builds with ${title}.`;
    const body = `# ${title}\n\n${about || ''}\n\nSource: ${source}\n\nThis skill holds ${title}'s README and documentation. When a task involves ${title}, read the relevant reference file below before answering or writing code, and follow what the docs say over general assumptions.`;
    return { type: 'knowledge', skills: [writeSkill({ name, description, body, references: refs.map((r) => ({ ...r, about: r.file.toLowerCase().startsWith('readme') ? 'overview' : '' })), source, type: 'github-docs' })], source };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const DS = 'https://datasets-server.huggingface.co';

function toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r.row ?? r)).join('\n') + '\n';
}

function fieldList(features) {
  if (!features) return '';
  if (Array.isArray(features)) return features.map((f) => `- \`${f.name}\`: ${typeText(f.type)}`).join('\n');
  return Object.entries(features).map(([k, v]) => `- \`${k}\`: ${typeText(v)}`).join('\n');
}

function typeText(t) {
  if (!t) return 'unknown';
  if (t.dtype) return t.dtype;
  if (t._type === 'ClassLabel' && t.names) return `label (${t.names.slice(0, 12).join(', ')}${t.names.length > 12 ? ', …' : ''})`;
  if (t._type === 'Sequence' || Array.isArray(t)) return 'list';
  if (t._type) return t._type;
  if (typeof t === 'object') return `{${Object.keys(t).join(', ')}}`;
  return String(t);
}

async function fromHfDataset(src, opts, token) {
  const id = src.id;
  const card = await get(`https://huggingface.co/datasets/${id}/raw/main/README.md`, { token }).catch(() => '');
  let splits = [];
  try {
    splits = (await get(`${DS}/splits?dataset=${encodeURIComponent(id)}`, { json: true, token })).splits || [];
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw new Error(`${id} is gated or private. Accept its terms on Hugging Face, then save a token: reroute key huggingface hf_...`);
  }
  const rowsWanted = Math.max(5, Math.min(Number(opts.rows) || 50, 1000));
  const refs = [];
  const sections = [];
  let total = 0;
  for (const sp of splits.slice(0, 6)) {
    let rows = [];
    let features = null;
    try {
      for (let offset = 0; offset < rowsWanted; offset += 100) {
        const r = await get(`${DS}/rows?dataset=${encodeURIComponent(id)}&config=${encodeURIComponent(sp.config)}&split=${encodeURIComponent(sp.split)}&offset=${offset}&length=${Math.min(100, rowsWanted - offset)}`, { json: true, token });
        features = features || r.features;
        rows.push(...(r.rows || []));
        if (!r.rows?.length) break;
      }
    } catch {
      try {
        const r = await get(`${DS}/first-rows?dataset=${encodeURIComponent(id)}&config=${encodeURIComponent(sp.config)}&split=${encodeURIComponent(sp.split)}`, { json: true, token });
        features = r.features;
        rows = (r.rows || []).slice(0, rowsWanted);
      } catch {}
    }
    let size = '';
    try {
      const info = await get(`${DS}/size?dataset=${encodeURIComponent(id)}&config=${encodeURIComponent(sp.config)}`, { json: true, token });
      const s = (info.size?.splits || []).find((x) => x.split === sp.split);
      if (s?.num_rows != null) size = `${s.num_rows.toLocaleString()} rows`;
    } catch {}
    let text = toJsonl(rows);
    if (total + text.length > MAX_TOTAL) text = text.slice(0, Math.max(0, MAX_TOTAL - total));
    total += text.length;
    const file = `samples/${slug(sp.config)}-${slug(sp.split)}.jsonl`;
    if (rows.length) refs.push({ file, content: text, about: `${rows.length} example rows from ${sp.config}/${sp.split}` });
    sections.push(`### ${sp.config} / ${sp.split}${size ? ` (${size})` : ''}\n\n${fieldList(features) || '(columns not available)'}`);
  }
  if (card) refs.unshift({ file: 'dataset-card.md', content: card.slice(0, MAX_FILE), about: 'the dataset card from Hugging Face' });
  if (!card && !splits.length) throw new Error(`couldn't read ${id} from Hugging Face (does it exist?)`);
  const about = firstParagraph(card);
  const name = slug(opts.name || `dataset-${id.split('/')[1]}`);
  const description =
    opts.description || `The Hugging Face dataset ${id}: ${sentence(about) || 'its card, columns and sample rows'} Use when the user asks about this data, wants examples like it, or writes code that loads or processes it.`;
  const firstSplit = splits[0];
  const body = `# Dataset: ${id}

${about}

Source: https://huggingface.co/datasets/${id}

## Columns

${sections.join('\n\n') || '(no split information)'}

## Loading it

\`\`\`python
from datasets import load_dataset
ds = load_dataset("${id}"${firstSplit && firstSplit.config !== 'default' ? `, "${firstSplit.config}"` : ''})
\`\`\`

The sample files below are real rows (JSON Lines). Use them to understand the format, as examples to follow, or to answer questions about typical entries. They are a sample, not the whole dataset: for statistics over all rows, load the full dataset.`;
  return { type: 'dataset', skills: [writeSkill({ name, description, body, references: refs, source: `https://huggingface.co/datasets/${id}`, type: 'hf-dataset' })] };
}

async function fromHfModel(src, opts, token) {
  const card = await get(`https://huggingface.co/${src.id}/raw/main/README.md`, { token }).catch(() => '');
  let meta = {};
  try {
    meta = await get(`https://huggingface.co/api/models/${src.id}`, { json: true, token });
  } catch {}
  if (!card && !meta.id) throw new Error(`couldn't read ${src.id} from Hugging Face`);
  const about = firstParagraph(card);
  const name = slug(opts.name || `model-${src.id.split('/')[1]}`);
  const task = meta.pipeline_tag ? ` (${meta.pipeline_tag})` : '';
  // Facts from the Hub read better than a card's first paragraph, which is often install advice.
  const params = meta.safetensors?.total ? `${meta.safetensors.total >= 1e9 ? (meta.safetensors.total / 1e9).toFixed(1) + 'B' : Math.round(meta.safetensors.total / 1e6) + 'M'} parameters` : '';
  const license = (meta.tags || []).find((t) => t.startsWith('license:'))?.slice(8);
  const facts = [meta.pipeline_tag && `a ${meta.pipeline_tag} model`, params, license && `${license} license`].filter(Boolean).join(', ');
  const description =
    opts.description || `The Hugging Face model ${src.id}${facts ? ` (${facts})` : ''}: its model card, how to run it and its limits. Use when the user wants to use, run, fine-tune or compare this model.`;
  const body = `# Model: ${src.id}${task}\n\n${about}\n\nSource: https://huggingface.co/${src.id}\n\nThe model card below explains what it does, how to run it and its limits. Follow its usage examples when writing code for it.`;
  return { type: 'model', skills: [writeSkill({ name, description, body, references: card ? [{ file: 'model-card.md', content: card.slice(0, MAX_FILE), about: 'the model card' }] : [], source: `https://huggingface.co/${src.id}`, type: 'hf-model' })] };
}

async function fromWeb(src, opts) {
  const html = await get(src.url);
  const text = decodeEntities(/<html|<body|<div/i.test(html) ? htmlToText(html) : html);
  const meta = decodeEntities(
    (html.match(/<meta[^>]+name=["'](?:description|og:description)["'][^>]*content=["']([^"']+)/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description/i) ||
      [])[1] || ''
  );
  if (text.length < 80) throw new Error('that page has almost no text to learn from');
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/\s+/g, ' ').trim() || new URL(src.url).hostname;
  const name = slug(opts.name || title);
  const summary = meta || firstParagraph(text.replace(/^Title:.*\n+/, '').replace(/\(https?:[^)]*\)/g, ''));
  const description = opts.description || `Reference: ${decodeEntities(title)} (${src.url}).${summary ? ' ' + sentence(summary) : ''} Use when the user works on something this page covers.`;
  const body = `# ${title}\n\nSource: ${src.url}\n\nThe page's text is saved below. Read it when a task relates to it.`;
  return { type: 'web', skills: [writeSkill({ name, description, body, references: [{ file: 'page.txt', content: text.slice(0, MAX_FILE), about: 'the page text' }], source: src.url, type: 'web' })] };
}

function fromLocal(src, opts) {
  const dirs = fs.statSync(src.path).isDirectory() ? findSkillDirs(src.path) : [];
  if (dirs.length) return { type: 'skills', skills: dirs.map((d) => ({ ...writeSkill({ name: opts.name && dirs.length === 1 ? slug(opts.name) : skillNameFrom(d), source: src.path, type: 'skill', copyDir: d }), scripts: scriptsIn(d) })) };
  const refs = collectDocs(src.path);
  if (!refs.length) throw new Error('found no text files to learn from there');
  const base = path.basename(src.path).replace(/\.[^.]+$/, '');
  const name = slug(opts.name || base);
  const about = firstParagraph(refs[0].content);
  const description = opts.description || `Knowledge from ${base}: ${sentence(about) || 'local notes and documents'} Use when the user works on or asks about ${base}.`;
  const body = `# ${base}\n\n${about}\n\nSource: ${src.path}\n\nRead the reference files below when a task relates to ${base}.`;
  return { type: 'local', skills: [writeSkill({ name, description, body, references: refs, source: src.path, type: 'local' })] };
}

// opts: { name, description, rows, token, runClaude }
export async function teach(input, opts = {}) {
  const src = parseSource(input);
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  if (src.kind === 'github') return fromGithub(src, opts, opts.runClaude);
  if (src.kind === 'hf-dataset') return fromHfDataset(src, opts, opts.token);
  if (src.kind === 'hf-model') return fromHfModel(src, opts, opts.token);
  if (src.kind === 'local') return fromLocal(src, opts);
  return fromWeb(src, opts);
}

// Skills Reroute added (they carry a marker file), newest first.
export function listTaught() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {}
  return dirs
    .map((e) => {
      const dir = path.join(SKILLS_DIR, e.name);
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
      } catch {
        return null;
      }
      let description = '';
      try {
        description = (fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^description:\s*(.+)$/m) || [])[1] || '';
        description = description.replace(/^"|"$/g, '').replace(/\\"/g, '"');
      } catch {}
      return { name: e.name, dir, description, ...meta };
    })
    .filter(Boolean)
    .sort((a, b) => b.addedAt - a.addedAt);
}

export function forget(name) {
  const dir = path.join(SKILLS_DIR, slug(name));
  if (!fs.existsSync(path.join(dir, MARKER))) return false; // only remove skills Reroute added
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
