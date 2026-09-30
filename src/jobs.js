// Parallel agents: run several Claude Code tasks at once, each as its own headless `claude -p` session.
// Each job gets its own git worktree (when the folder is a git repo) so jobs can't overwrite each other.
// Jobs run in the background; state lives in ~/.reroute/jobs/<id>.json and the output in <id>.log.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { HOME_DIR } from './config.js';

export const JOBS_DIR = path.join(HOME_DIR, 'jobs');

export function jobFile(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}
export function logFile(id) {
  return path.join(JOBS_DIR, `${id}.log`);
}

export function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export function writeJob(job) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listJobs() {
  let files = [];
  try {
    files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'));
  } catch {}
  return files
    .map((f) => readJob(f.slice(0, -5)))
    .filter(Boolean)
    .map((j) => (j.status === 'running' && !alive(j.runnerPid) ? { ...j, status: 'failed', error: j.error || 'the job stopped unexpectedly' } : j))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return null;
  }
}

// Creates a job and starts its runner in the background. Returns the job.
export function startJob({ task, model = null, cwd = process.cwd(), worktree = 'auto', allowBash = false, cliPath, port, batchSize = 1 }) {
  const id = crypto.randomBytes(3).toString('hex');
  let workdir = cwd;
  let branch = null;
  const root = gitRoot(cwd);
  const useWorktree = worktree === true || (worktree === 'auto' && root && batchSize > 1);
  if (useWorktree) {
    if (!root) throw new Error(`${cwd} is not a git repository, so jobs can't get their own worktree. Run without --worktree.`);
    branch = `reroute/job-${id}`;
    workdir = path.join(path.dirname(root), `${path.basename(root)}-job-${id}`);
    execFileSync('git', ['worktree', 'add', '-q', '-b', branch, workdir], { cwd: root, stdio: 'ignore', windowsHide: true });
  }
  const job = { id, task, model, cwd, workdir, branch, allowBash, port, status: 'running', createdAt: Date.now(), startedAt: null, endedAt: null, result: null, error: null, costUsd: null };
  writeJob(job);
  const runner = spawn(process.execPath, [cliPath, '_job', id], { detached: true, stdio: 'ignore', windowsHide: true });
  runner.unref();
  job.runnerPid = runner.pid;
  writeJob(job);
  return job;
}

// Runs inside the detached runner process: drives `claude -p` and records the outcome.
export function runJob(id, { onDone } = {}) {
  const job = readJob(id);
  if (!job) process.exit(1);
  // Say where to work: models otherwise sometimes guess paths outside the job's folder.
  const task = `${job.task}

(Work only in ${job.workdir}. Use paths inside that folder.)`;
  const args = ['-p', task, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
  if (job.model) args.push('--model', job.model);
  if (job.allowBash) args.push('--allowedTools', 'Bash');
  const out = fs.openSync(logFile(id), 'a');
  const env = { ENABLE_TOOL_SEARCH: 'true', ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${job.port}` };
  let child;
  try {
    child = spawn('claude', args, { cwd: job.workdir, env, stdio: ['ignore', 'pipe', out], windowsHide: true });
  } catch (e) {
    Object.assign(job, { status: 'failed', error: e.message, endedAt: Date.now() });
    writeJob(job);
    return;
  }
  job.startedAt = Date.now();
  job.claudePid = child.pid;
  writeJob(job);
  let buf = '';
  child.stdout.on('data', (d) => {
    fs.writeSync(out, d);
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant') {
          const text = (ev.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
          const tool = (ev.message?.content || []).find((b) => b.type === 'tool_use');
          const latest = tool ? `using ${tool.name}` : text.slice(0, 140);
          if (latest) {
            job.progress = latest;
            job.turns = (job.turns || 0) + 1;
            writeJob(job);
          }
        } else if (ev.type === 'result') {
          job.result = ev.result ?? null;
          job.costUsd = ev.total_cost_usd ?? null;
          job.error = ev.is_error ? String(ev.result || ev.subtype || 'error') : null;
        }
      } catch {}
    }
  });
  child.on('error', (e) => {
    Object.assign(job, { status: 'failed', error: `couldn't start claude: ${e.message}`, endedAt: Date.now() });
    writeJob(job);
    onDone?.(job);
  });
  child.on('exit', (code) => {
    const fresh = readJob(id) || job;
    if (fresh.status === 'stopped') return;
    Object.assign(job, { status: code === 0 && !job.error ? 'done' : 'failed', endedAt: Date.now(), exitCode: code });
    if (job.status === 'failed' && !job.error) job.error = `claude exited with code ${code}`;
    writeJob(job);
    onDone?.(job);
  });
}

export function stopJob(id) {
  const job = readJob(id);
  if (!job) return null;
  for (const pid of [job.claudePid, job.runnerPid]) {
    try {
      if (process.platform === 'win32' && pid) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else if (pid) process.kill(pid);
    } catch {}
  }
  Object.assign(job, { status: 'stopped', endedAt: Date.now() });
  writeJob(job);
  return job;
}

// Removes finished jobs' records (and their worktrees, if the branch has no unmerged work you'd lose).
export function cleanJobs() {
  let n = 0;
  for (const j of listJobs()) {
    if (j.status === 'running') continue;
    if (j.branch && j.workdir && fs.existsSync(j.workdir)) {
      try {
        execFileSync('git', ['worktree', 'remove', j.workdir], { cwd: j.cwd, stdio: 'ignore', windowsHide: true });
      } catch {
        continue; // has uncommitted changes: keep it
      }
    }
    for (const f of [jobFile(j.id), logFile(j.id)]) fs.rmSync(f, { force: true });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Open-model helper agents Claude can hand work to (Claude Code runs several at once).
// Files go in ~/.claude/agents/reroute-*.md; the model is a Reroute picker ID, so they cost no Claude quota.

export const HELPERS = [
  {
    name: 'reroute-researcher',
    description:
      'Open-source helper for reading and searching: explores the codebase, finds where things are, reads docs, and reports back. Runs on a free open model, so it saves Claude quota. Use several in parallel for independent questions.',
    tools: 'Read, Grep, Glob, WebFetch, WebSearch',
    prompt:
      'You are a research helper. Find the answer to the question you were given by reading and searching; do not edit files. Report concrete findings with file paths and line numbers, and say clearly when you could not find something.',
  },
  {
    name: 'reroute-coder',
    description:
      'Open-source helper for well-defined coding tasks: implements a clearly specified change in the files it is pointed at. Runs on a free open model. Use for independent pieces of work that can run in parallel.',
    tools: 'Read, Grep, Glob, Edit, Write, Bash',
    prompt:
      'You are a coding helper. Make exactly the change you were asked for, following the style of the surrounding code. Keep changes small, run the relevant tests if there are any, and report what you changed and anything you were unsure about.',
  },
  {
    name: 'reroute-reviewer',
    description:
      'Open-source second opinion: reviews a diff, plan or answer for bugs, missed cases and risks. Runs on a free open model. Use before finishing important work.',
    tools: 'Read, Grep, Glob, Bash',
    prompt:
      'You are a reviewer. Look for real problems: bugs, unhandled cases, security issues, and places the work does not match what was asked. Rank findings by severity and be specific. If it looks correct, say so briefly; do not invent issues.',
  },
];

export function helperFile(claudeDir, name) {
  return path.join(claudeDir, 'agents', `${name}.md`);
}

export function writeHelpers(claudeDir, model) {
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
  for (const h of HELPERS) {
    const body = `---\nname: ${h.name}\ndescription: ${h.description}\ntools: ${h.tools}\nmodel: ${model}\n---\n\n${h.prompt}\n\n(Installed by Reroute. Change the model with \`reroute agents model <id>\`.)\n`;
    fs.writeFileSync(helperFile(claudeDir, h.name), body);
  }
  return HELPERS.map((h) => h.name);
}

export function removeHelpers(claudeDir) {
  let n = 0;
  for (const h of HELPERS) {
    const f = helperFile(claudeDir, h.name);
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('Installed by Reroute')) {
      fs.rmSync(f);
      n++;
    }
  }
  return n;
}
