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
    --accent: #c2572b; --ok: #2f7d4f; --warn: #b7791f; --chip: #efece4;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #151412; --panel: #1e1d1a; --ink: #ecead3; --muted: #9a968a; --line: #2e2c28;
      --accent: #e0774a; --ok: #5cbf85; --warn: #e0a84a; --chip: #2a2824; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 32px 16px 64px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 24px; }
  h1 { font-size: 26px; margin: 0; letter-spacing: -0.02em; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); font-size: 14px; }
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
  .model { display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
  .model:hover { border-color: var(--accent); }
  .model.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .model.off { opacity: .55; }
  .model input { accent-color: var(--accent); margin: 0; }
  .name { font-weight: 600; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); white-space: nowrap; }
  .tag.ok { color: var(--ok); }
  code { font: 12.5px ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--chip); padding: 1px 5px; border-radius: 5px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .btn { border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 7px 14px; border-radius: 9px; font: inherit; cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  ul.log { list-style: none; padding: 0; margin: 0; font: 12.5px ui-monospace, Consolas, monospace; color: var(--muted); max-height: 220px; overflow: auto; }
  ul.log li { padding: 3px 0; border-bottom: 1px dashed var(--line); overflow-wrap: anywhere; }
  @media (max-width: 560px) { .model { grid-template-columns: 22px 1fr; } .model .tag { grid-column: 2; justify-self: start; } }
</style>
</head>
<body>
<main>
  <header><h1>Re<span>route</span></h1><div class="sub">Claude first, open source when you run dry.</div></header>

  <section class="card status" id="status"><div class="dot"></div><div><div class="big">Loading…</div></div></section>

  <section class="card">
    <h2>Mode</h2>
    <div class="seg" id="mode">
      <button data-v="auto">Auto</button>
      <button data-v="claude">Always Claude</button>
      <button data-v="fallback">Always open source</button>
    </div>
    <p class="muted" style="margin:10px 0 0">Auto uses Claude until it reports you're out of credits or at your usage limit, then switches until the limit resets.</p>
  </section>

  <section class="card">
    <h2>Fallback model</h2>
    <label class="row muted" style="margin-bottom:12px;cursor:pointer"><input type="checkbox" id="backups" style="accent-color:var(--accent)"> If my pick fails, try the other models as backups (best first)</label>
    <div class="models" id="models"></div>
  </section>

  <section class="card">
    <h2>Activity</h2>
    <ul class="log" id="log"></ul>
  </section>
</main>
<script>
const $ = (s) => document.querySelector(s);
let st = null;
async function api(path, body) {
  const r = await fetch('/reroute/api/' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  return r.json();
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function render() {
  const fb = st.active === 'fallback';
  const until = st.fallbackUntil ? ' until ' + new Date(st.fallbackUntil).toLocaleString() : '';
  const using = fb ? (st.resolvedFallback ? st.resolvedFallback.label : 'no usable fallback') : 'Claude';
  $('#status').innerHTML = '<div class="dot ' + (fb ? 'fb' : '') + '"></div><div style="flex:1;min-width:200px"><div class="big">Using ' + esc(using) + esc(until) + '</div>' +
    '<div class="muted">' + (st.fallbackReason ? esc(st.fallbackReason) : 'Claude requests: ' + st.requests.claude + ' · fallback requests: ' + st.requests.fallback) + '</div></div>' +
    (st.fallbackUntil ? '<button class="btn" id="reset">Try Claude now</button>' : '');
  const r = $('#reset'); if (r) r.onclick = async () => { st = await api('reset', {}); render(); };
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.mode));
  const auto = { id: 'auto', label: 'Auto: best available', note: st.resolvedFallback && st.fallbackModel === 'auto' ? 'Currently ' + st.resolvedFallback.label : 'Picks the top model you have access to', usable: true, providerLabel: '' };
  $('#models').innerHTML = [auto, ...st.models].map((m) => {
    const sel = st.fallbackModel === m.id;
    const tag = m.id === 'auto' ? '' : m.notInPlan ? '<span class="tag">not in your Ollama plan</span>' : m.skippedUntil ? '<span class="tag">refused, skipping for now</span>' : m.usable ? '<span class="tag ok">' + esc(m.providerLabel) + '</span>' : '<span class="tag">needs <code>' + esc(m.needs) + '</code></span>';
    return '<label class="model ' + (sel ? 'sel ' : '') + (m.usable ? '' : 'off') + '"><input type="radio" name="m" value="' + esc(m.id) + '"' + (sel ? ' checked' : '') + '>' +
      '<div><div class="name">' + esc(m.label) + '</div><div class="muted">' + esc(m.note || m.model || '') + (m.hf ? ' · <a href="https://huggingface.co/' + esc(m.hf) + '" target="_blank" rel="noopener" style="color:var(--accent)">model card</a>' : '') + '</div></div>' + tag + '</label>';
  }).join('');
  document.querySelectorAll('#models input').forEach((i) => i.onchange = async () => { st = await api('config', { fallbackModel: i.value }); render(); });
  $('#backups').checked = st.backups;
  $('#log').innerHTML = st.events.length ? st.events.map((e) => '<li>' + new Date(e.t).toLocaleTimeString() + '  ' + esc(e.msg) + '</li>').join('') : '<li>No events yet.</li>';
}
$('#backups').onchange = async (e) => { st = await api('config', { backups: e.target.checked }); render(); };
document.querySelectorAll('#mode button').forEach((b) => b.onclick = async () => { st = await api('config', { mode: b.dataset.v }); render(); });
async function tick() { try { st = await api('status'); render(); } catch {} }
tick(); setInterval(tick, 4000);
</script>
</body>
</html>`;
}
