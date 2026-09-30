// Self-update from GitHub. Reroute is installed as a git clone (`git clone` + `npm link`), so updating
// is a fast-forward `git pull`. Local edits are never overwritten: a dirty checkout is left alone.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = 'Radin-dev1/Reroute';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
}

export function currentVersion() {
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {}
  let commit = null;
  try {
    commit = git(['rev-parse', '--short', 'HEAD']);
  } catch {}
  return { version, commit };
}

function isGitCheckout() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

function branch() {
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return 'main';
  }
}

// { available, behind, latest: { commit, subject, version }, reason? }
export async function checkForUpdate() {
  if (isGitCheckout()) {
    const b = branch();
    git(['fetch', '--quiet', 'origin', b]);
    const behind = Number(git(['rev-list', '--count', `HEAD..origin/${b}`]) || 0);
    if (!behind) return { available: false, behind: 0 };
    const [commit, subject] = git(['log', '-1', '--format=%h%x09%s', `origin/${b}`]).split('\t');
    let version = null;
    try {
      version = JSON.parse(git(['show', `origin/${b}:package.json`])).version;
    } catch {}
    return { available: true, behind, latest: { commit, subject, version } };
  }
  // Not a git checkout (installed some other way): compare versions with GitHub.
  const r = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { signal: AbortSignal.timeout(10_000) });
  const latest = (await r.json()).version;
  const newer = latest && latest !== currentVersion().version;
  return { available: Boolean(newer), latest: { version: latest }, reason: newer ? 'reinstall from GitHub to update' : undefined };
}

// Returns { updated, from, to } or throws with a reason a person can act on.
export function applyUpdate() {
  if (!isGitCheckout()) throw new Error(`Reroute isn't a git checkout, so it can't update itself. Reinstall from https://github.com/${REPO}.`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error(`you have local changes in ${ROOT}, so Reroute didn't overwrite them. Commit or stash them, then update.`);
  const from = currentVersion();
  git(['pull', '--ff-only', '--quiet']);
  const to = currentVersion();
  return { updated: from.commit !== to.commit, from, to };
}
