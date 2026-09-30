import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = process.env.REROUTE_HOME || path.join(os.homedir(), '.reroute');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
export const LOG_PATH = path.join(HOME_DIR, 'reroute.log');

// Providers the fallback models run on.
//   type "openai"    -> OpenAI-compatible /chat/completions (Reroute translates to/from the Anthropic format)
//   type "anthropic" -> Anthropic-compatible /v1/messages (passed through with the model swapped)
export const DEFAULT_PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    headers: { 'HTTP-Referer': 'https://github.com/Radin-dev1/Reroute', 'X-Title': 'Reroute' },
  },
  ollama: {
    label: 'Ollama (local, or :cloud models)',
    type: 'anthropic',
    baseUrl: 'http://localhost:11434',
    apiKeyEnv: 'OLLAMA_API_KEY',
    keyless: true,
  },
  deepseek: {
    label: 'DeepSeek API',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  zai: {
    label: 'Z.ai (GLM) API',
    type: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKeyEnv: 'ZAI_API_KEY',
  },
  moonshot: {
    label: 'Moonshot (Kimi) API',
    type: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
  },
  huggingface: {
    label: 'Hugging Face Inference',
    type: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    apiKeyEnv: 'HF_TOKEN',
  },
  selfhosted: {
    label: 'Self-hosted (localhost:8000)',
    type: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    apiKeyEnv: 'SELFHOSTED_API_KEY',
    keyless: true,
  },
  groq: {
    label: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
  },
};

// Ordered best-first. The model you pick runs first; the rest are backups tried in this order.
// "autoPick: false" models are never chosen automatically (they can't drive Claude Code's tools well),
// but you can still select them by hand. Lineup as of September 2026.
// Add your own with `reroute add` or under "customModels" in ~/.reroute/config.json.
export const DEFAULT_MODELS = [
  // Flagships on OpenRouter (one key, every model)
  { id: 'glm-5.3', label: 'GLM-5.3 (Z.ai)', provider: 'openrouter', model: 'z-ai/glm-5.3', note: 'Strong agentic coder, 1M context' },
  { id: 'kimi-k3', label: 'Kimi K3 (Moonshot)', provider: 'openrouter', model: 'moonshotai/kimi-k3', note: 'Top open model for long tool-use sessions' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813', note: 'Big reasoning model' },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max', provider: 'openrouter', model: 'qwen/qwen3.8-max-0902' },
  { id: 'qwen3.8-2.4t', label: 'Qwen3.8 2.4T-A95B', provider: 'openrouter', model: 'qwen/qwen3.8-2.4t-a95b', note: 'Largest open-weight Qwen' },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code', note: 'Coding-tuned' },
  { id: 'qwen3-coder-next', label: 'Qwen3-Coder Next', provider: 'openrouter', model: 'qwen/qwen3-coder-next', note: 'Coding-tuned' },
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', provider: 'openrouter', model: 'z-ai/glm-5.3-flash', note: 'Fast' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', note: 'Fast and cheap' },
  { id: 'minimax-m3', label: 'MiniMax M3', provider: 'openrouter', model: 'minimax/minimax-m3' },
  { id: 'qwen3.8-omni-flash', label: 'Qwen3.8 Omni Flash', provider: 'openrouter', model: 'qwen/qwen3.8-omni-flash', note: 'Text, image and audio input' },
  { id: 'gpt-oss-120b', label: 'gpt-oss 120B', provider: 'openrouter', model: 'openai/gpt-oss-120b' },
  // Free tiers on OpenRouter (rate-limited)
  { id: 'qwen3.8-27b-free', label: 'Qwen3.8 27B (free)', provider: 'openrouter', model: 'qwen/qwen3.8-27b:free', note: 'Free on OpenRouter' },
  { id: 'gemma-4-31b-free', label: 'Gemma 4 31B (free)', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', note: 'Free on OpenRouter' },
  { id: 'nemotron-3-nano-omni-free', label: 'Nemotron 3 Nano Omni (free)', provider: 'openrouter', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', note: 'Free on OpenRouter' },

  // Hugging Face Inference Providers (one HF token)
  { id: 'hf-glm-5.3', label: 'GLM-5.3 via Hugging Face', provider: 'huggingface', model: 'zai-org/GLM-5.3', hf: 'zai-org/GLM-5.3' },
  { id: 'hf-kimi-k3', label: 'Kimi K3 via Hugging Face', provider: 'huggingface', model: 'moonshotai/Kimi-K3', hf: 'moonshotai/Kimi-K3' },
  { id: 'hf-deepseek-v4-pro', label: 'DeepSeek V4 Pro via Hugging Face', provider: 'huggingface', model: 'deepseek-ai/DeepSeek-V4-Pro-0813', hf: 'deepseek-ai/DeepSeek-V4-Pro-0813' },
  { id: 'hf-qwen3.8-27b', label: 'Qwen3.8 27B via Hugging Face', provider: 'huggingface', model: 'Qwen/Qwen3.8-27B', hf: 'Qwen/Qwen3.8-27B' },
  { id: 'hf-gpt-oss-120b', label: 'gpt-oss 120B via Hugging Face', provider: 'huggingface', model: 'openai/gpt-oss-120b', hf: 'openai/gpt-oss-120b' },

  // Groq (very fast)
  { id: 'groq-gpt-oss-120b', label: 'gpt-oss 120B on Groq', provider: 'groq', model: 'openai/gpt-oss-120b', note: 'Very fast' },

  // Ollama Cloud (runs through your local Ollama; needs `ollama signin`)
  { id: 'ollama-glm-5.3-cloud', label: 'GLM-5.3 via Ollama Cloud', provider: 'ollama', model: 'glm-5.3:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-kimi-k3-cloud', label: 'Kimi K3 via Ollama Cloud', provider: 'ollama', model: 'kimi-k3:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-deepseek-v4.1-flash-cloud', label: 'DeepSeek V4.1 Flash via Ollama Cloud', provider: 'ollama', model: 'deepseek-v4.1-flash:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-gpt-oss-120b-cloud', label: 'gpt-oss 120B via Ollama Cloud', provider: 'ollama', model: 'gpt-oss:120b-cloud', note: 'Included in the Ollama free tier' },
  { id: 'ollama-nemotron-3-super-cloud', label: 'Nemotron 3 Super via Ollama Cloud', provider: 'ollama', model: 'nemotron-3-super:cloud', note: 'Included in the Ollama free tier' },

  // Fully local through Ollama (`reroute pull <id>` downloads them)
  { id: 'ollama-qwen3-coder-30b', label: 'Qwen3-Coder 30B (local)', provider: 'ollama', model: 'qwen3-coder:30b', note: '~19 GB; wants a 24 GB GPU or lots of RAM', local: true },
  { id: 'ollama-qwen3-omni-30b', label: 'Qwen3-Omni 30B-A3B Instruct (local)', provider: 'ollama', model: 'hf.co/ggml-org/Qwen3-Omni-30B-A3B-Instruct-GGUF', hf: 'Qwen/Qwen3-Omni-30B-A3B-Instruct', note: 'GGUF from Hugging Face; text only through Reroute', local: true },
  { id: 'ollama-gemma4-26b', label: 'Gemma 4 26B-A4B (local)', provider: 'ollama', model: 'gemma4:26b', note: '~17 GB, fast MoE', local: true },
  { id: 'ollama-gpt-oss-20b', label: 'gpt-oss 20B (local)', provider: 'ollama', model: 'gpt-oss:20b', note: '~14 GB', local: true },
  { id: 'ollama-gemma4-12b', label: 'Gemma 4 12B (local)', provider: 'ollama', model: 'gemma4:12b', note: '~8 GB', local: true },
  { id: 'ollama-gemma4-e2b', label: 'Gemma 4 E2B (local)', provider: 'ollama', model: 'gemma4:e2b', hf: 'google/gemma-4-E2B-it', note: 'Tiny, runs on almost anything; weak at big coding tasks', local: true },

  // Self-hosted: your own OpenAI-compatible server (vLLM, SGLang, transformers serve) at localhost:8000. Hand-pick only.
  { id: 'local-realtime-venus', label: 'Realtime-Venus Omni 9B (self-hosted)', provider: 'selfhosted', model: 'inclusionAI/Realtime-Venus', hf: 'inclusionAI/Realtime-Venus', note: 'Full-duplex audio/video model; no hosted API, serve it yourself', autoPick: false },
  { id: 'local-janusflow-1.3b', label: 'JanusFlow 1.3B (self-hosted)', provider: 'selfhosted', model: 'deepseek-ai/JanusFlow-1.3B', hf: 'deepseek-ai/JanusFlow-1.3B', note: 'Image understanding/generation model; chat only, no tool calls', autoPick: false },
];

export const DEFAULTS = {
  port: 4747,
  host: '127.0.0.1',
  // auto     = use Claude, switch to fallback when credits/usage run out
  // claude   = always Claude (Reroute is a plain pass-through)
  // fallback = always the open-source model
  mode: 'auto',
  fallbackModel: 'auto',
  // When your picked model fails (refused, out of quota, offline), try the other models as backups.
  backups: true,
  // How long to stay on the fallback when Claude doesn't say when the limit resets.
  cooldownMinutes: 30,
  // Also fall back when Anthropic is overloaded (HTTP 529), for a short time.
  fallbackOnOverload: true,
  overloadCooldownSeconds: 90,
  anthropicBaseUrl: 'https://api.anthropic.com',
  providers: {},
  apiKeys: {},
  customModels: [],
};

export function readRawConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig() {
  const raw = readRawConfig();
  const cfg = { ...DEFAULTS, ...raw };
  cfg.providers = {};
  for (const [name, p] of Object.entries({ ...DEFAULT_PROVIDERS, ...(raw.providers || {}) })) {
    cfg.providers[name] = { ...(DEFAULT_PROVIDERS[name] || {}), ...p };
  }
  const custom = Array.isArray(raw.customModels) ? raw.customModels : [];
  const customIds = new Set(custom.map((m) => m.id));
  cfg.models = [...custom, ...DEFAULT_MODELS.filter((m) => !customIds.has(m.id))];
  cfg.apiKeys = raw.apiKeys || {};
  return cfg;
}

export function saveConfig(patch) {
  const next = { ...readRawConfig(), ...patch };
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

export function configMtime() {
  try {
    return fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

export function providerKey(cfg, providerName) {
  const p = cfg.providers[providerName];
  if (!p) return '';
  return cfg.apiKeys[providerName] || (p.apiKeyEnv && process.env[p.apiKeyEnv]) || p.apiKey || '';
}

// A provider is usable when it has a key, or it is keyless (Ollama).
export function providerUsable(cfg, providerName) {
  const p = cfg.providers[providerName];
  if (!p) return false;
  return Boolean(p.keyless || providerKey(cfg, providerName));
}

export function isCloudModel(name) {
  return /(:|-)cloud$/.test(name);
}

// ollama: { reachable: boolean, models: Set<string> } | null
export function modelUsable(cfg, m, ollama = null) {
  if (!providerUsable(cfg, m.provider)) return false;
  if (m.provider === 'ollama' && !providerKey(cfg, m.provider)) {
    // Keyless Ollama: cloud models just need Ollama running (and `ollama signin`); local ones must be pulled.
    if (!ollama?.reachable) return false;
    return isCloudModel(m.model) || ollama.models.has(m.model);
  }
  return true;
}

// Models in the order they should be tried: your pick first, then (if "backups" is on) every other
// usable model, best first. Models that refused recently (skip) are left out of the backups.
export function fallbackCandidates(cfg, ollama = null, skip = new Set()) {
  const picked = cfg.fallbackModel && cfg.fallbackModel !== 'auto' ? cfg.models.find((x) => x.id === cfg.fallbackModel) : null;
  if (picked && cfg.backups === false) return [picked];
  const list = [];
  for (const m of cfg.models) {
    if (m === picked || m.autoPick === false || skip.has(m.id)) continue;
    if (modelUsable(cfg, m, ollama)) list.push(m);
  }
  if (picked) {
    // Your pick goes first when it's ready; if it isn't (not pulled, no key) it's tried last.
    if (modelUsable(cfg, picked, ollama)) list.unshift(picked);
    else list.push(picked);
  }
  return list;
}

export function resolveFallbackModel(cfg, ollama = null, skip = new Set()) {
  return fallbackCandidates(cfg, ollama, skip)[0] || null;
}
