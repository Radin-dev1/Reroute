// Rows Reroute adds to Claude Code's /model menu (terminal and desktop app).
//   picker: "ready" (default) = models you can use right now, "all" = every model, "off" = none
//   pickerOrder: model ids in the order you arranged them in the dashboard (the rest follow)
//   pickerHidden: model ids you hid

import { PICKER_PREFIX } from './config.js';

// Claude Code handles these rows like this model (prompt style, effort defaults) instead of warning
// about an unrecognized model. The model ID it sends is still the Reroute one.
export const BEHAVES_AS = 'claude-sonnet-4-6';

export function orderModels(models, cfg) {
  const order = cfg.pickerOrder || [];
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...models].sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e6 + models.indexOf(a)) - (rank.has(b.id) ? rank.get(b.id) : 1e6 + models.indexOf(b)));
}

// models: the status payload's models (with usable / notInPlan / pickerId)
export function pickerRows(models, cfg) {
  const which = cfg.picker || 'ready';
  if (which === 'off') return [];
  const hidden = new Set(cfg.pickerHidden || []);
  const rows = [];
  if (!hidden.has('auto')) {
    rows.push({ model: PICKER_PREFIX + 'auto', label: 'Open source: best available', description: 'Reroute picks the best open model you can use', behavesAs: BEHAVES_AS });
  }
  for (const m of orderModels(models, cfg)) {
    if (hidden.has(m.id)) continue;
    if (which !== 'all' && (!m.usable || m.notInPlan)) continue;
    if (which === 'all' && m.autoPick === false && !m.usable) continue;
    rows.push({ model: m.pickerId, label: m.label, description: ['Via Reroute', m.providerLabel, m.note].filter(Boolean).join(' · '), behavesAs: BEHAVES_AS });
  }
  return rows;
}
