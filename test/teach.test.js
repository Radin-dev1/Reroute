import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-teach-claude-'));

const { parseSource, teach, listTaught, forget, SKILLS_DIR } = await import('../src/teach.js');

test('links are recognized', () => {
  assert.deepEqual(parseSource('https://github.com/anthropics/skills'), { kind: 'github', owner: 'anthropics', repo: 'skills', ref: null, sub: '', blob: false });
  assert.deepEqual(parseSource('https://github.com/anthropics/skills/tree/main/skills/pdf'), { kind: 'github', owner: 'anthropics', repo: 'skills', ref: 'main', sub: 'skills/pdf', blob: false });
  assert.equal(parseSource('github.com/owner/repo.git').repo, 'repo');
  assert.equal(parseSource('owner/repo').kind, 'github');
  assert.deepEqual(parseSource('https://huggingface.co/datasets/openai/gsm8k'), { kind: 'hf-dataset', id: 'openai/gsm8k' });
  assert.deepEqual(parseSource('https://huggingface.co/datasets/openai/gsm8k/viewer/main/train'), { kind: 'hf-dataset', id: 'openai/gsm8k' });
  assert.deepEqual(parseSource('https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507'), { kind: 'hf-model', id: 'Qwen/Qwen3-4B-Instruct-2507' });
  assert.equal(parseSource('https://www.lua.org/manual/5.4/').kind, 'web');
  assert.equal(parseSource(os.tmpdir()).kind, 'local');
  assert.throws(() => parseSource(''), /paste a link/);
  assert.throws(() => parseSource('not a thing at all'), /isn't a link/);
});

test('a local folder with SKILL.md files is installed as-is; plain docs become a knowledge skill', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-teach-src-'));
  fs.mkdirSync(path.join(src, 'my-skill', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: Does a thing.\n---\n\nSteps.');
  fs.writeFileSync(path.join(src, 'my-skill', 'scripts', 'run.py'), 'print(1)');
  const a = await teach(src);
  assert.equal(a.type, 'skills');
  assert.equal(a.skills[0].name, 'my-skill');
  assert.deepEqual(a.skills[0].scripts, [path.join('scripts', 'run.py')]);
  assert.ok(fs.existsSync(path.join(SKILLS_DIR, 'my-skill', 'scripts', 'run.py')));

  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'reroute-teach-docs-'));
  fs.writeFileSync(path.join(docs, 'README.md'), '# Widget\n\n- [Install](#install)\n- [Usage](#usage)\n\n## Overview\n\nWidget is a tiny library for drawing charts in the terminal with no dependencies.\n');
  fs.mkdirSync(path.join(docs, 'docs'));
  fs.writeFileSync(path.join(docs, 'docs', 'api.md'), '# API\n\nchart(data)');
  fs.writeFileSync(path.join(docs, 'logo.png'), Buffer.from([0, 1, 2, 0]));
  const b = await teach(docs, { name: 'Widget' });
  assert.equal(b.type, 'local');
  const md = fs.readFileSync(path.join(SKILLS_DIR, 'widget', 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: widget\ndescription: ".*tiny library for drawing charts/m);
  assert.ok(fs.existsSync(path.join(SKILLS_DIR, 'widget', 'references', 'README.md')));
  assert.ok(fs.existsSync(path.join(SKILLS_DIR, 'widget', 'references', 'docs', 'api.md')));
  assert.ok(!fs.existsSync(path.join(SKILLS_DIR, 'widget', 'references', 'logo.png')), 'binary files are skipped');

  assert.deepEqual(listTaught().map((s) => s.name).sort(), ['my-skill', 'widget']);
  assert.equal(forget('widget'), true);
  fs.mkdirSync(path.join(SKILLS_DIR, 'handmade'));
  fs.writeFileSync(path.join(SKILLS_DIR, 'handmade', 'SKILL.md'), '---\nname: handmade\n---\n');
  assert.equal(forget('handmade'), false, "skills Reroute didn't add are never removed");
  assert.deepEqual(listTaught().map((s) => s.name), ['my-skill']);
});
