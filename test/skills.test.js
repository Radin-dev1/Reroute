import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resolve, PACKS } = await import('../src/skills.js');
const { compressSkillListing } = await import('../src/translate.js');

const plugins = [
  { name: 'engineering-skills', folder: 'engineering-team', hooks: false },
  { name: 'karpathy-coder', folder: 'engineering', hooks: false },
  { name: 'agent-memory', folder: 'engineering', hooks: true },
  { name: 'marketing-skills', folder: 'marketing-skill', hooks: false },
  { name: 'roast', folder: 'productivity', hooks: false },
];

test('packs resolve by folder, "all" takes everything, names work too', () => {
  assert.deepEqual(resolve(['engineering'], plugins).plugins.map((p) => p.name), ['engineering-skills', 'karpathy-coder', 'agent-memory']);
  assert.equal(resolve(['all'], plugins).plugins.length, plugins.length);
  assert.deepEqual(resolve(['coding'], plugins).plugins.map((p) => p.name), ['engineering-skills', 'karpathy-coder']);
  const mixed = resolve(['marketing', 'roast', 'nope'], plugins);
  assert.deepEqual(mixed.plugins.map((p) => p.name), ['marketing-skills', 'roast']);
  assert.deepEqual(mixed.unknown, ['nope']);
  assert.ok(PACKS.coding.plugins.length > 5);
});

test('skill list descriptions are shortened for open models, names kept', () => {
  const long = 'Audit datasets for completeness, consistency, accuracy, and validity across every column and table you point it at';
  const listing = [
    'The following skills are available for use with the Skill tool:',
    '',
    `- data-quality-auditor: ${long}`,
    '- claude-api: Reference for the Claude API.',
    'TRIGGER — a continuation line of the entry above',
    `- engineering-skills:senior-backend: Short one.`,
    '- init',
    '',
    "Today's date is 2026-09-29.",
  ].join('\n');
  const body = { system: 'You are Claude Code.', messages: [{ role: 'user', content: [{ type: 'text', text: listing }, { type: 'text', text: 'hi' }] }] };
  const { body: out, saved } = compressSkillListing(body);
  assert.ok(saved > 0);
  const text = out.messages[0].content[0].text;
  assert.match(text, /- data-quality-auditor: Audit datasets for completeness/);
  assert.ok(!text.includes('every column and table'));
  assert.match(text, /- engineering-skills:senior-backend: Short one\./);
  assert.match(text, /- init/);
  assert.match(text, /TRIGGER/);
  assert.match(text, /Today's date/);
  assert.equal(out.messages[0].content[1].text, 'hi');
  assert.equal(body.messages[0].content[0].text, listing, 'the original request is not modified');
  assert.equal(compressSkillListing({ messages: [{ role: 'user', content: 'plain' }] }).saved, 0);
});
