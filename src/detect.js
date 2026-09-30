// Decides whether an error from Anthropic means "you're out of credits / usage" (switch to fallback)
// or is a normal error that Claude Code should see as-is.

const CREDIT_PATTERNS = [
  /credit balance is too low/i,
  /insufficient (credit|balance|funds|quota)/i,
  /out of (credits|usage)/i,
  /usage limit/i,
  /(5-hour|weekly|monthly|session) limit/i,
  /limit (reached|exceeded|will reset)/i,
  /quota (exceeded|reached)/i,
  /billing/i,
  /spend(ing)? limit/i,
  /purchase (more )?credits/i,
];

function headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

// Returns the epoch ms at which Claude should be tried again, or null if unknown.
export function resetTimeFromHeaders(headers, now = Date.now()) {
  const unified = headerGet(headers, 'anthropic-ratelimit-unified-reset');
  if (unified) {
    const n = Number(unified);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    const d = Date.parse(unified);
    if (!Number.isNaN(d)) return d;
  }
  for (const h of ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset', 'anthropic-ratelimit-input-tokens-reset', 'anthropic-ratelimit-output-tokens-reset']) {
    const v = headerGet(headers, h);
    if (v) {
      const d = Date.parse(v);
      if (!Number.isNaN(d)) return d;
    }
  }
  const retryAfter = headerGet(headers, 'retry-after');
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) return now + n * 1000;
    const d = Date.parse(retryAfter);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

/**
 * @returns {{ fallback: boolean, reason?: string, until?: number }}
 */
export function classifyError(status, bodyText, headers, cfg, now = Date.now()) {
  let message = '';
  try {
    const j = JSON.parse(bodyText);
    message = j?.error?.message || j?.message || '';
  } catch {
    message = String(bodyText || '').slice(0, 500);
  }
  const defaultUntil = now + (cfg.cooldownMinutes ?? 30) * 60_000;

  if (status === 429) {
    const reset = resetTimeFromHeaders(headers, now);
    return {
      fallback: true,
      reason: `rate/usage limit (429)${message ? ': ' + message : ''}`,
      until: reset && reset > now ? reset : defaultUntil,
    };
  }

  if ((status === 400 || status === 402 || status === 403) && CREDIT_PATTERNS.some((re) => re.test(message))) {
    return { fallback: true, reason: `out of credits (${status}): ${message}`, until: defaultUntil };
  }

  if (status === 529 && cfg.fallbackOnOverload) {
    return {
      fallback: true,
      reason: 'Anthropic overloaded (529)',
      until: now + (cfg.overloadCooldownSeconds ?? 90) * 1000,
    };
  }

  return { fallback: false };
}
