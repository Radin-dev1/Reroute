export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reroute</title>
<style>
  :root {
    --bg: #f6f5f1; --panel: #ffffff; --ink: #1d1c19; --muted: #6b6860; --line: #e4e1d8;
    --accent: #c2572b; --ok: #2f7d4f; --warn: #b7791f; --bad: #b3372b; --chip: #efece4; --bar: #e8e4da;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151412; --panel: #1e1d1a; --ink: #ecead3; --muted: #9a968a; --line: #2e2c28;
      --accent: #e0774a; --ok: #5cbf85; --warn: #e0a84a; --bad: #e0685a; --chip: #2a2824; --bar: #2e2c28; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 28px 16px 64px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
  h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); font-size: 14px; flex: 1; min-width: 180px; }
  nav { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--line); overflow-x: auto; }
  nav button { border: 0; background: none; color: var(--muted); font: inherit; padding: 8px 14px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; }
  nav button.on { color: var(--ink); border-color: var(--accent); font-weight: 600; }
  .tab { display: none; } .tab.on { display: block; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; margin-bottom: 16px; }
  .status { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--ok); flex: none; }
  .dot.fb { background: var(--warn); }
  .big { font-size: 18px; font-weight: 600; }
  .muted { color: var(--muted); font-size: 13px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  .seg { display: inline-flex; background: var(--chip); border-radius: 10px; padding: 3px; gap: 2px; flex-wrap: wrap; }
  .seg button { border: 0; background: transparent; color: var(--ink); padding: 7px 14px; border-radius: 8px; font: inherit; cursor: pointer; }
  .seg button.on { background: var(--panel); box-shadow: 0 1px 2px rgba(0,0,0,.12); font-weight: 600; }
  .models { display: grid; gap: 8px; }
  .model { display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; background: var(--panel); }
  .model:hover { border-color: var(--accent); }
  .model.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .model.off { opacity: .55; }
  .model input { accent-color: var(--accent); margin: 0; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); white-space: nowrap; }
  .tag.ok { color: var(--ok); } .tag.bad { color: var(--bad); } .tag.warn { color: var(--warn); }
  code { font: 12.5px ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--chip); padding: 1px 5px; border-radius: 5px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .btn { border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 7px 14px; border-radius: 9px; font: inherit; cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn:disabled { opacity: .5; cursor: default; }
  ul.log { list-style: none; padding: 0; margin: 0; font: 12.5px ui-monospace, Consolas, monospace; color: var(--muted); max-height: 260px; overflow: auto; }
  ul.log li { padding: 3px 0; border-bottom: 1px dashed var(--line); overflow-wrap: anywhere; }
  .meter { margin: 6px 0 12px; }
  .meter .top { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; flex-wrap: wrap; }
  .bar { height: 8px; border-radius: 999px; background: var(--bar); overflow: hidden; margin-top: 4px; }
  .bar i { display: block; height: 100%; background: var(--ok); border-radius: 999px; }
  .bar i.warn { background: var(--warn); } .bar i.bad { background: var(--bad); }
  .menu { display: grid; gap: 6px; }
  .mrow { display: grid; grid-template-columns: 20px 1fr auto; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .mrow.drag { opacity: .4; } .mrow.over { border-color: var(--accent); }
  .grip { cursor: grab; color: var(--muted); user-select: none; text-align: center; }
  .mrow.hidden .mname { text-decoration: line-through; color: var(--muted); }
  .switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  .switch:last-child { border-bottom: 0; }
  .switch input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--accent); flex: none; }
  textarea, input[type=text], select { width: 100%; font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; }
  textarea { min-height: 96px; resize: vertical; }
  .job { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-top: 8px; }
  .job .head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .job pre { white-space: pre-wrap; font: 12.5px ui-monospace, Consolas, monospace; background: var(--chip); padding: 8px; border-radius: 8px; max-height: 240px; overflow: auto; margin: 8px 0 0; }
  .banner { display: none; background: var(--accent); color: #fff; border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; align-items: center; gap: 12px; flex-wrap: wrap; }
  .banner.on { display: flex; }
  .banner .btn { background: #fff; color: var(--accent); border: 0; font-weight: 600; }
  label.lbl { font-size: 13px; color: var(--muted); display: block; margin: 10px 0 4px; }
  @media (max-width: 560px) { .model { grid-template-columns: 22px 1fr; } .model .tag { grid-column: 2; justify-self: start; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Re<span>route</span></h1>
    <div class="sub">Claude first, open source when you run dry.</div>
    <span class="muted" id="ver"></span>
    <button class="btn" id="checkUpdate">Check for updates</button>
  </header>

  <div class="banner" id="updateBanner"><div style="flex:1" id="updateText"></div><button class="btn" id="installUpdate">Update now</button></div>

  <nav id="tabs">
    <button data-t="status" class="on">Status</button>
    <button data-t="models">Models</button>
    <button data-t="agents">Agents</button>
    <button data-t="settings">Settings</button>
  </nav>

  <section class="tab on" id="t-status">
    <div class="card status" id="status"><div class="dot"></div><div><div class="big">Loading…</div></div></div>
    <div class="card"><h2>Claude usage</h2><div id="usage" class="muted">Shows up after your first Claude request through Reroute.</div></div>
    <div class="card">
      <h2>Mode</h2>
      <div class="seg" id="mode">
        <button data-v="auto">Auto</button>
        <button data-v="claude">Always Claude</button>
        <button data-v="fallback">Always open source</button>
      </div>
      <p class="muted" style="margin:10px 0 0">Auto uses Claude until it reports you're out of credits or at your usage limit, then switches until the limit resets.</p>
    </div>
    <div class="card"><h2>Activity</h2><ul class="log" id="log"></ul></div>
  </section>

  <section class="tab" id="t-models">
    <div class="card">
      <h2>Fallback model</h2>
      <p class="muted" style="margin-top:0" id="localNote"></p>
      <label class="row muted" style="margin-bottom:12px;cursor:pointer"><input type="checkbox" id="backups" style="accent-color:var(--accent)"> If my pick fails, try the other models as backups (best first)</label>
      <div class="models" id="models"></div>
    </div>
  </section>

  <section class="tab" id="t-agents">
    <div class="card">
      <h2>Run agents in parallel</h2>
      <p class="muted" style="margin-top:0">One task per line. Each runs as its own Claude Code session at the same time, in its own copy of the project (git worktree) so they don't overwrite each other.</p>
      <label class="lbl" for="tasks">Tasks</label>
      <textarea id="tasks" placeholder="Add input validation to the signup form&#10;Write tests for utils/date.ts&#10;Find why the build is slow"></textarea>
      <label class="lbl" for="jobCwd">Project folder</label>
      <input type="text" id="jobCwd" placeholder="C:\\Users\\you\\Projects\\my-app">
      <label class="lbl" for="jobModel">Model</label>
      <select id="jobModel"></select>
      <label class="row muted" style="margin:10px 0"><input type="checkbox" id="allowBash" style="accent-color:var(--accent)"> Let them run commands (tests, installs)</label>
      <button class="btn primary" id="startJobs">Start</button>
      <span class="muted" id="jobMsg"></span>
    </div>
    <div class="card"><h2>Jobs</h2><div id="jobs" class="muted">No jobs yet.</div></div>
  </section>

  <section class="tab" id="t-settings">
    <div class="card">
      <h2>Claude's model menu</h2>
      <p class="muted" style="margin-top:0">These are the Reroute models in <code>/model</code> and the desktop app's model picker. Drag to reorder, hide the ones you don't want. Restart Claude Code to see changes.</p>
      <div class="seg" id="picker" style="margin-bottom:12px">
        <button data-v="ready">Models I can use</button>
        <button data-v="all">All models</button>
        <button data-v="off">None</button>
      </div>
      <div class="menu" id="menu"></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="saveMenu">Save menu</button><span class="muted" id="menuMsg"></span></div>
    </div>
    <div class="card">
      <h2>Behavior</h2>
      <div class="switch"><div><div class="name">Local only</div><div class="muted">Only use models that run on this PC. Nothing is sent to cloud model providers.</div></div><input type="checkbox" data-k="localOnly"></div>
      <div class="switch"><div><div class="name">Notifications</div><div class="muted">When Reroute switches models, when Claude is back, when usage gets high, when a job finishes.</div></div><input type="checkbox" data-k="notify"></div>
      <div class="switch"><div><div class="name">Quota saver</div><div class="muted">Send Claude Code's small background calls (titles, summaries) to a free model so your Claude limit lasts longer.</div></div><input type="checkbox" data-k="saveQuota"></div>
      <div class="switch"><div><div class="name">Update automatically</div><div class="muted">Install new versions from GitHub on its own and restart quietly.</div></div><input type="checkbox" data-k="autoUpdate"></div>
      <div class="switch"><div><div class="name">Warn at</div><div class="muted">Notify when your 5-hour or weekly Claude usage passes this percentage.</div></div><select id="warnAt" style="width:auto"><option>50</option><option>70</option><option>80</option><option>90</option><option>95</option></select></div>
    </div>
    <div class="card">
      <h2>Status line</h2>
      <p class="muted" style="margin-top:0">The line under the Claude Code prompt. Choose what it shows.</p>
      <div class="switch"><div class="name">Claude usage (5h and week)</div><input type="checkbox" data-sl="usage"></div>
      <div class="switch"><div class="name">When Claude comes back</div><input type="checkbox" data-sl="reset"></div>
      <div class="switch"><div class="name">Update notice</div><input type="checkbox" data-sl="update"></div>
    </div>
  </section>
</main>
<script>
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let st = null;
let menuDraft = null; // { order: [...ids], hidden: Set, picker }
async function api(path, body) {
  const r = await fetch('/reroute/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function when(ms) { return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }

$$('#tabs button').forEach((b) => b.onclick = () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 't-' + b.dataset.t));
  try { localStorage.setItem('reroute-tab', b.dataset.t); } catch {}
});
try { const t = localStorage.getItem('reroute-tab'); if (t) $('#tabs button[data-t="' + t + '"]')?.click(); } catch {}

function meter(label, pct, reset) {
  if (pct == null) return '';
  const cls = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  return '<div class="meter"><div class="top"><span>' + label + '</span><span>' + Math.round(pct) + '% used' + (reset ? ' · resets ' + esc(when(reset)) : '') + '</span></div><div class="bar"><i class="' + cls + '" style="width:' + Math.min(100, pct) + '%"></i></div></div>';
}

function renderStatus() {
  const fb = st.active === 'fallback';
  const until = st.fallbackUntil ? ' until ' + new Date(st.fallbackUntil).toLocaleString() : '';
  const using = fb ? (st.resolvedFallback ? st.resolvedFallback.label : 'no usable fallback') : 'Claude';
  $('#status').innerHTML = '<div class="dot ' + (fb ? 'fb' : '') + '"></div><div style="flex:1;min-width:200px"><div class="big">Using ' + esc(using) + esc(until) + '</div>' +
    '<div class="muted">' + (st.fallbackReason ? esc(st.fallbackReason) : 'Claude requests: ' + st.requests.claude + ' · open-source requests: ' + st.requests.fallback + (st.savedByQuotaSaver ? ' · background calls moved off Claude: ' + st.savedByQuotaSaver : '')) + '</div></div>' +
    (st.fallbackUntil ? '<button class="btn" id="reset">Try Claude now</button>' : '');
  const r = $('#reset'); if (r) r.onclick = async () => { st = await api('reset', {}); render(); };
  const u = st.usage;
  if (u && (u.fiveHour != null || u.sevenDay != null)) {
    $('#usage').innerHTML = meter('5-hour limit', u.fiveHour, u.fiveHourReset) + meter('Weekly limit', u.sevenDay, u.sevenDayReset) + '<div class="muted">Updated ' + esc(new Date(u.at).toLocaleTimeString()) + ' from Anthropic\\'s reply headers.</div>';
  } else if (u && u.status) {
    $('#usage').textContent = 'Plan status: ' + u.status;
  }
  $$('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.mode));
  $('#log').innerHTML = st.events.length ? st.events.map((e) => '<li>' + new Date(e.t).toLocaleTimeString() + '  ' + esc(e.msg) + '</li>').join('') : '<li>No events yet.</li>';
  const v = st.version || {};
  $('#ver').textContent = 'v' + (v.version || '?') + (v.commit ? ' · ' + v.commit : '');
  const up = st.update || {};
  $('#updateBanner').classList.toggle('on', Boolean(up.available));
  if (up.available && !$('#installUpdate').disabled) $('#updateText').innerHTML = '<b>Update available.</b> ' + esc(up.latest?.subject || up.latest?.version || '') + (up.behind ? ' (' + up.behind + ' new commit' + (up.behind > 1 ? 's' : '') + ')' : '');
}

function renderModels() {
  const auto = { id: 'auto', label: 'Auto: best available', note: st.resolvedFallback && st.fallbackModel === 'auto' ? 'Currently ' + st.resolvedFallback.label : 'Picks the top model you have access to', usable: true };
  $('#models').innerHTML = [auto, ...st.models].map((m) => {
    const sel = st.fallbackModel === m.id;
    const engine = st.engine || {};
    const downloading = engine.loading === m.id;
    const tag = m.id === 'auto' ? '' : m.provider === 'webgpu' && !m.usable ? (downloading ? '<span class="tag warn">downloading ' + Math.round((engine.progress || 0) * 100) + '%</span>' : '<button class="btn" data-dl="' + esc(m.id) + '">Download ' + esc(m.sizeGb) + ' GB</button>') : m.notInPlan ? '<span class="tag">not in your Ollama plan</span>' : m.skippedUntil ? '<span class="tag warn">refused, skipping for now</span>' : m.usable ? '<span class="tag ok">' + esc(m.providerLabel) + '</span>' : '<span class="tag">needs <code>' + esc(m.needs) + '</code></span>';
    const ctx = m.context ? ' · ' + (m.context >= 1e6 ? Math.round(m.context / 1e5) / 10 + 'M' : Math.round(m.context / 1000) + 'k') + ' context' : '';
    return '<label class="model ' + (sel ? 'sel ' : '') + (m.usable ? '' : 'off') + '"><input type="radio" name="m" value="' + esc(m.id) + '"' + (sel ? ' checked' : '') + '>' +
      '<div><div class="name">' + esc(m.label) + '</div><div class="muted">' + esc(m.note || m.model || '') + esc(ctx) + (m.hf ? ' · <a href="https://huggingface.co/' + esc(m.hf) + '" target="_blank" rel="noopener" style="color:var(--accent)">model card</a>' : '') + '</div></div>' + tag + '</label>';
  }).join('');
  $('#models input').forEach((i) => i.onchange = async () => { st = await api('config', { fallbackModel: i.value }); render(); });
  $('#models [data-dl]').forEach((b) => b.onclick = async (ev) => { ev.preventDefault(); b.disabled = true; b.textContent = 'Starting…'; const r = await api('engine/download', { id: b.dataset.dl }); if (r.error) { b.textContent = r.error; } tick(); });
  $('#backups').checked = st.backups;
  const e = st.engine || {};
  $('#localNote').innerHTML = (st.localOnly ? '<b>Local only:</b> just models that run on this PC. ' : '') + 'Local engine: ' + (e.connected ? 'running' + (e.gpu ? ' on ' + esc(e.gpu) : '') : 'starts when needed') + (e.webgpu === false ? ' (no WebGPU in this browser)' : '') + '. <a href="#" id="openEngine" style="color:var(--accent)">Show engine window</a>';
  const oe = $('#openEngine'); if (oe) oe.onclick = async (ev) => { ev.preventDefault(); await api('engine/open', {}); };
}

function menuItems() {
  const s = st.settings;
  if (!menuDraft) menuDraft = { order: s.pickerOrder.slice(), hidden: new Set(s.pickerHidden), picker: s.picker };
  const shown = st.models.filter((m) => menuDraft.picker === 'all' ? (m.autoPick !== false || m.usable) : (m.usable && !m.notInPlan));
  const all = [{ id: 'auto', label: 'Open source: best available' }, ...shown];
  const rank = new Map(menuDraft.order.map((id, i) => [id, i]));
  return all.map((m, i) => ({ m, i })).sort((a, b) => (rank.has(a.m.id) ? rank.get(a.m.id) : 1e6 + a.i) - (rank.has(b.m.id) ? rank.get(b.m.id) : 1e6 + b.i)).map((x) => x.m);
}

function renderMenu() {
  if (!menuDraft) menuItems();
  $$('#picker button').forEach((b) => b.classList.toggle('on', b.dataset.v === menuDraft.picker));
  if (menuDraft.picker === 'off') { $('#menu').innerHTML = '<div class="muted">No Reroute models in the menu.</div>'; return; }
  const items = menuItems();
  $('#menu').innerHTML = items.map((m) => {
    const hid = menuDraft.hidden.has(m.id);
    return '<div class="mrow' + (hid ? ' hidden' : '') + '" draggable="true" data-id="' + esc(m.id) + '"><span class="grip" title="Drag to move">⋮⋮</span><span class="mname">' + esc(m.label) + '</span><button class="btn" data-eye="' + esc(m.id) + '">' + (hid ? 'Show' : 'Hide') + '</button></div>';
  }).join('');
  let dragId = null;
  $$('#menu .mrow').forEach((row) => {
    row.ondragstart = () => { dragId = row.dataset.id; row.classList.add('drag'); };
    row.ondragend = () => row.classList.remove('drag');
    row.ondragover = (e) => { e.preventDefault(); row.classList.add('over'); };
    row.ondragleave = () => row.classList.remove('over');
    row.ondrop = (e) => {
      e.preventDefault(); row.classList.remove('over');
      if (!dragId || dragId === row.dataset.id) return;
      const ids = items.map((m) => m.id).filter((x) => x !== dragId);
      ids.splice(ids.indexOf(row.dataset.id), 0, dragId);
      menuDraft.order = ids; renderMenu();
    };
  });
  $$('#menu [data-eye]').forEach((b) => b.onclick = () => {
    const id = b.dataset.eye; menuDraft.hidden.has(id) ? menuDraft.hidden.delete(id) : menuDraft.hidden.add(id); renderMenu();
  });
}
$$('#picker button').forEach((b) => b.onclick = () => { menuItems(); menuDraft.picker = b.dataset.v; renderMenu(); });
$('#saveMenu').onclick = async () => {
  $('#menuMsg').textContent = 'Saving…';
  await api('config', { picker: menuDraft.picker, pickerOrder: menuItems().map((m) => m.id), pickerHidden: [...menuDraft.hidden] });
  const r = await api('picker/sync', {});
  $('#menuMsg').textContent = 'Saved: ' + r.rows + ' models in the menu. Restart Claude Code to see them.';
};

function renderSettings() {
  const s = st.settings;
  $$('[data-k]').forEach((i) => { i.checked = Boolean(s[i.dataset.k]); });
  $$('[data-sl]').forEach((i) => { i.checked = s.statusLine[i.dataset.sl] !== false; });
  $('#warnAt').value = String(s.usageWarnPercent);
  const sel = $('#jobModel');
  if (!sel.dataset.filled) {
    sel.innerHTML = '<option value="claude">Claude (your plan)</option><option value="auto">Open source: best available</option>' + st.models.filter((m) => m.usable && !m.notInPlan).map((m) => '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>').join('');
    sel.dataset.filled = '1';
  }
}
$$('[data-k]').forEach((i) => i.onchange = async () => { st = await api('config', { [i.dataset.k]: i.checked }); render(); });
$$('[data-sl]').forEach((i) => i.onchange = async () => {
  const sl = {}; $$('[data-sl]').forEach((x) => sl[x.dataset.sl] = x.checked);
  st = await api('config', { statusLine: sl }); render();
});
$('#warnAt').onchange = async (e) => { st = await api('config', { usageWarnPercent: Number(e.target.value) }); render(); };

const openLogs = new Set();
function renderJobs() {
  const js = st.jobs || [];
  if (!js.length) { $('#jobs').innerHTML = 'No jobs yet.'; return; }
  $('#jobs').innerHTML = js.map((j) => {
    const cls = j.status === 'done' ? 'ok' : j.status === 'running' ? 'warn' : 'bad';
    const took = j.endedAt && j.startedAt ? ' · ' + Math.round((j.endedAt - j.startedAt) / 1000) + 's' : '';
    return '<div class="job"><div class="head"><span class="tag ' + cls + '">' + esc(j.status) + '</span><b style="flex:1">' + esc(j.task) + '</b>' +
      (j.status === 'running' ? '<button class="btn" data-stop="' + j.id + '">Stop</button>' : '') + '<button class="btn" data-log="' + j.id + '">Log</button></div>' +
      '<div class="muted">' + esc((j.model || 'Claude').replace('claude-reroute-', '')) + took + ' · ' + esc(j.workdir) + (j.branch ? ' (branch ' + esc(j.branch) + ')' : '') + '</div>' +
      (j.status === 'running' && j.progress ? '<div class="muted">Now: ' + esc(j.progress) + '</div>' : '') +
      (j.result ? '<pre>' + esc(j.result) + '</pre>' : '') + (j.error ? '<pre>' + esc(j.error) + '</pre>' : '') + '<pre id="log-' + j.id + '" style="display:none"></pre></div>';
  }).join('');
  $$('[data-stop]').forEach((b) => b.onclick = async () => { await api('jobs/' + b.dataset.stop + '/stop', {}); tick(); });
  $$('[data-log]').forEach((b) => b.onclick = () => { openLogs.has(b.dataset.log) ? openLogs.delete(b.dataset.log) : openLogs.add(b.dataset.log); showLogs(); });
  showLogs();
}
async function showLogs() {
  for (const id of openLogs) {
    const el = $('#log-' + id); if (!el) continue;
    const r = await api('jobs/' + id + '/log');
    const lines = [];
    for (const l of (r.log || '').split('\\n')) {
      try { const ev = JSON.parse(l);
        if (ev.type === 'assistant') for (const c of ev.message?.content || []) { if (c.type === 'text' && c.text.trim()) lines.push(c.text.trim()); if (c.type === 'tool_use') lines.push('→ ' + c.name + ' ' + JSON.stringify(c.input).slice(0, 140)); }
      } catch {}
    }
    el.textContent = lines.join('\\n') || '(nothing yet)'; el.style.display = 'block';
  }
}
$('#startJobs').onclick = async () => {
  const tasks = $('#tasks').value.split('\\n').map((t) => t.trim()).filter(Boolean);
  const cwd = $('#jobCwd').value.trim();
  if (!tasks.length || !cwd) { $('#jobMsg').textContent = 'Add at least one task and the project folder.'; return; }
  try { localStorage.setItem('reroute-cwd', cwd); } catch {}
  $('#jobMsg').textContent = 'Starting…';
  const r = await api('jobs', { tasks, cwd, model: $('#jobModel').value, allowBash: $('#allowBash').checked });
  $('#jobMsg').textContent = r.error ? r.error : 'Started ' + r.jobs.length + ' job' + (r.jobs.length > 1 ? 's' : '') + '.';
  if (!r.error) $('#tasks').value = '';
  tick();
};
try { const c = localStorage.getItem('reroute-cwd'); if (c) $('#jobCwd').value = c; } catch {}

$('#checkUpdate').onclick = async () => {
  $('#checkUpdate').disabled = true; $('#checkUpdate').textContent = 'Checking…';
  const r = await api('update/check', {});
  $('#checkUpdate').disabled = false;
  $('#checkUpdate').textContent = r.error ? "Couldn't check" : r.available ? 'Update available' : 'Up to date';
  tick();
};
$('#installUpdate').onclick = async () => {
  $('#installUpdate').disabled = true; $('#installUpdate').textContent = 'Updating…';
  const r = await api('update/install', {});
  if (r.error) { $('#updateText').textContent = r.error; $('#installUpdate').disabled = false; $('#installUpdate').textContent = 'Try again'; return; }
  $('#updateText').textContent = 'Updated to ' + (r.current?.version || '') + ' (' + (r.current?.commit || '') + '). Restarting…';
  setTimeout(() => location.reload(), 4000);
};

function render() { renderStatus(); renderModels(); renderMenu(); renderSettings(); renderJobs(); }
$$('#mode button').forEach((b) => b.onclick = async () => { st = await api('config', { mode: b.dataset.v }); render(); });
$('#backups').onchange = async (e) => { st = await api('config', { backups: e.target.checked }); render(); };
async function tick() { try { st = await api('status'); render(); } catch {} }
tick(); setInterval(tick, 4000);
</script>
</body>
</html>`;
}
