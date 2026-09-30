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
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
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
  { id: 'mimo-v2.6-pro', label: 'Xiaomi MiMo V2.6 Pro', provider: 'openrouter', model: 'xiaomi/mimo-v2.6-pro', note: '1M context' },
  { id: 'nemotron-3-ultra', label: 'Nemotron 3 Ultra 550B', provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b', note: 'NVIDIA flagship' },
  { id: 'longcat-2.0', label: 'LongCat 2.0 (Meituan)', provider: 'openrouter', model: 'meituan/longcat-2.0', note: '1M context' },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code', note: 'Coding-tuned' },
  { id: 'kat-coder-pro-v2.5', label: 'KAT-Coder Pro V2.5 (Kwaipilot)', provider: 'openrouter', model: 'kwaipilot/kat-coder-pro-v2.5', note: 'Coding-tuned' },
  { id: 'qwen3-coder-next', label: 'Qwen3-Coder Next', provider: 'openrouter', model: 'qwen/qwen3-coder-next', note: 'Coding-tuned' },
  { id: 'minimax-m3', label: 'MiniMax M3', provider: 'openrouter', model: 'minimax/minimax-m3' },
  { id: 'glm-5.2', label: 'GLM-5.2', provider: 'openrouter', model: 'z-ai/glm-5.2' },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', provider: 'openrouter', model: 'moonshotai/kimi-k2.6' },
  { id: 'hy3', label: 'Hunyuan 3 (Tencent)', provider: 'openrouter', model: 'tencent/hy3' },
  { id: 'qwen3.5-397b', label: 'Qwen3.5 397B-A17B', provider: 'openrouter', model: 'qwen/qwen3.5-397b-a17b' },
  { id: 'trinity-large', label: 'Arcee Trinity Large Thinking', provider: 'openrouter', model: 'arcee-ai/trinity-large-thinking' },
  { id: 'minimax-m2.7', label: 'MiniMax M2.7', provider: 'openrouter', model: 'minimax/minimax-m2.7' },
  // Fast / cheap on OpenRouter
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', provider: 'openrouter', model: 'z-ai/glm-5.3-flash', note: 'Fast' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', note: 'Fast and cheap' },
  { id: 'mimo-v2.6-flash', label: 'Xiaomi MiMo V2.6 Flash', provider: 'openrouter', model: 'xiaomi/mimo-v2.6-flash', note: 'Fast' },
  { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', provider: 'openrouter', model: 'qwen/qwen3.8-flash', note: 'Fast, 1M context' },
  { id: 'ling-3.0-flash', label: 'Ling 3.0 Flash (inclusionAI)', provider: 'openrouter', model: 'inclusionai/ling-3.0-flash', note: 'Fast' },
  { id: 'step-3.7-flash', label: 'Step 3.7 Flash (StepFun)', provider: 'openrouter', model: 'stepfun/step-3.7-flash', note: 'Fast' },
  { id: 'qwen3.6-35b', label: 'Qwen3.6 35B-A3B', provider: 'openrouter', model: 'qwen/qwen3.6-35b-a3b', note: 'Small and fast' },
  { id: 'qwen3.8-omni-flash', label: 'Qwen3.8 Omni Flash', provider: 'openrouter', model: 'qwen/qwen3.8-omni-flash', note: 'Text, image and audio input' },
  { id: 'gpt-oss-120b', label: 'gpt-oss 120B', provider: 'openrouter', model: 'openai/gpt-oss-120b' },
  { id: 'gemma-4-31b', label: 'Gemma 4 31B', provider: 'openrouter', model: 'google/gemma-4-31b-it' },
  { id: 'gemma-4-26b', label: 'Gemma 4 26B-A4B', provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it' },
  { id: 'mistral-small-2603', label: 'Mistral Small (2603)', provider: 'openrouter', model: 'mistralai/mistral-small-2603' },
  { id: 'granite-4.2-8b', label: 'IBM Granite 4.2 8B', provider: 'openrouter', model: 'ibm-granite/granite-4.2-8b', note: 'Small' },
  // Free tiers on OpenRouter (rate-limited)
  { id: 'nemotron-3-ultra-free', label: 'Nemotron 3 Ultra 550B (free)', provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', note: 'Free on OpenRouter' },
  { id: 'qwen3.8-27b-free', label: 'Qwen3.8 27B (free)', provider: 'openrouter', model: 'qwen/qwen3.8-27b:free', note: 'Free on OpenRouter' },
  { id: 'nemotron-3-super-free', label: 'Nemotron 3 Super 120B (free)', provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', note: 'Free on OpenRouter' },
  { id: 'north-mini-code-free', label: 'Cohere North Mini Code (free)', provider: 'openrouter', model: 'cohere/north-mini-code:free', note: 'Free coding model' },
  { id: 'gemma-4-31b-free', label: 'Gemma 4 31B (free)', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', note: 'Free on OpenRouter' },
  { id: 'gemma-4-26b-free', label: 'Gemma 4 26B-A4B (free)', provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free', note: 'Free on OpenRouter' },
  { id: 'nemotron-3.5-lightning-free', label: 'Nemotron 3.5 Lightning (free)', provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', note: 'Free on OpenRouter' },
  { id: 'nemotron-3-nano-omni-free', label: 'Nemotron 3 Nano Omni (free)', provider: 'openrouter', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', note: 'Free on OpenRouter' },

  // Hugging Face Inference Providers (one HF token)
  { id: 'hf-glm-5.3', label: 'GLM-5.3 via Hugging Face', provider: 'huggingface', model: 'zai-org/GLM-5.3', hf: 'zai-org/GLM-5.3' },
  { id: 'hf-kimi-k3', label: 'Kimi K3 via Hugging Face', provider: 'huggingface', model: 'moonshotai/Kimi-K3', hf: 'moonshotai/Kimi-K3' },
  { id: 'hf-deepseek-v4-pro', label: 'DeepSeek V4 Pro via Hugging Face', provider: 'huggingface', model: 'deepseek-ai/DeepSeek-V4-Pro-0813', hf: 'deepseek-ai/DeepSeek-V4-Pro-0813' },
  { id: 'hf-qwen3.8-2.4t', label: 'Qwen3.8 2.4T-A95B via Hugging Face', provider: 'huggingface', model: 'Qwen/Qwen3.8-2.4T-A95B', hf: 'Qwen/Qwen3.8-2.4T-A95B' },
  { id: 'hf-glm-5.2', label: 'GLM-5.2 via Hugging Face', provider: 'huggingface', model: 'zai-org/GLM-5.2', hf: 'zai-org/GLM-5.2' },
  { id: 'hf-qwen3-coder-480b', label: 'Qwen3-Coder 480B via Hugging Face', provider: 'huggingface', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', hf: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' },
  { id: 'hf-qwen3-coder-next', label: 'Qwen3-Coder Next via Hugging Face', provider: 'huggingface', model: 'Qwen/Qwen3-Coder-Next', hf: 'Qwen/Qwen3-Coder-Next' },
  { id: 'hf-glm-5.3-flash', label: 'GLM-5.3 Flash via Hugging Face', provider: 'huggingface', model: 'zai-org/GLM-5.3-Flash', hf: 'zai-org/GLM-5.3-Flash' },
  { id: 'hf-deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash via Hugging Face', provider: 'huggingface', model: 'deepseek-ai/DeepSeek-V4.1-Flash', hf: 'deepseek-ai/DeepSeek-V4.1-Flash' },
  { id: 'hf-qwen3.8-27b', label: 'Qwen3.8 27B via Hugging Face', provider: 'huggingface', model: 'Qwen/Qwen3.8-27B', hf: 'Qwen/Qwen3.8-27B' },
  { id: 'hf-gemma-4-31b', label: 'Gemma 4 31B via Hugging Face', provider: 'huggingface', model: 'google/gemma-4-31B-it', hf: 'google/gemma-4-31B-it' },
  { id: 'hf-gemma-4-26b', label: 'Gemma 4 26B-A4B via Hugging Face', provider: 'huggingface', model: 'google/gemma-4-26B-A4B-it', hf: 'google/gemma-4-26B-A4B-it' },
  { id: 'hf-gpt-oss-120b', label: 'gpt-oss 120B via Hugging Face', provider: 'huggingface', model: 'openai/gpt-oss-120b', hf: 'openai/gpt-oss-120b' },

  // Groq (very fast)
  { id: 'groq-gpt-oss-120b', label: 'gpt-oss 120B on Groq', provider: 'groq', model: 'openai/gpt-oss-120b', note: 'Very fast' },
  { id: 'groq-gpt-oss-20b', label: 'gpt-oss 20B on Groq', provider: 'groq', model: 'openai/gpt-oss-20b', note: 'Very fast' },

  // Ollama Cloud (runs through your local Ollama; needs `ollama signin`)
  { id: 'ollama-glm-5.3-cloud', label: 'GLM-5.3 via Ollama Cloud', provider: 'ollama', model: 'glm-5.3:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-kimi-k3-cloud', label: 'Kimi K3 via Ollama Cloud', provider: 'ollama', model: 'kimi-k3:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-deepseek-v4-pro-cloud', label: 'DeepSeek V4 Pro via Ollama Cloud', provider: 'ollama', model: 'deepseek-v4-pro:0813-cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-kimi-k2.7-code-cloud', label: 'Kimi K2.7 Code via Ollama Cloud', provider: 'ollama', model: 'kimi-k2.7-code:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-minimax-m3-cloud', label: 'MiniMax M3 via Ollama Cloud', provider: 'ollama', model: 'minimax-m3:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-mistral-large-3-cloud', label: 'Mistral Large 3 675B via Ollama Cloud', provider: 'ollama', model: 'mistral-large-3:675b-cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-glm-5.2-cloud', label: 'GLM-5.2 via Ollama Cloud', provider: 'ollama', model: 'glm-5.2:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-kimi-k2.6-cloud', label: 'Kimi K2.6 via Ollama Cloud', provider: 'ollama', model: 'kimi-k2.6:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-minimax-m2.7-cloud', label: 'MiniMax M2.7 via Ollama Cloud', provider: 'ollama', model: 'minimax-m2.7:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-glm-5.3-flash-cloud', label: 'GLM-5.3 Flash via Ollama Cloud', provider: 'ollama', model: 'glm-5.3-flash:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-deepseek-v4.1-flash-cloud', label: 'DeepSeek V4.1 Flash via Ollama Cloud', provider: 'ollama', model: 'deepseek-v4.1-flash:cloud', note: 'Paid Ollama plan' },
  { id: 'ollama-nemotron-3-ultra-cloud', label: 'Nemotron 3 Ultra via Ollama Cloud', provider: 'ollama', model: 'nemotron-3-ultra:cloud', note: 'Included in the Ollama free tier' },
  { id: 'ollama-gpt-oss-120b-cloud', label: 'gpt-oss 120B via Ollama Cloud', provider: 'ollama', model: 'gpt-oss:120b-cloud', note: 'Included in the Ollama free tier' },
  { id: 'ollama-nemotron-3-super-cloud', label: 'Nemotron 3 Super via Ollama Cloud', provider: 'ollama', model: 'nemotron-3-super:cloud', note: 'Included in the Ollama free tier' },
  { id: 'ollama-gemma4-31b-cloud', label: 'Gemma 4 31B via Ollama Cloud', provider: 'ollama', model: 'gemma4:31b-cloud', note: 'Included in the Ollama free tier' },
  { id: 'ollama-nemotron-3-nano-cloud', label: 'Nemotron 3 Nano 30B via Ollama Cloud', provider: 'ollama', model: 'nemotron-3-nano:30b-cloud', note: 'Included in the Ollama free tier' },

  // Fully local through Ollama (`reroute pull <id>` downloads them)
  { id: 'ollama-qwen3-coder-next', label: 'Qwen3-Coder Next (local)', provider: 'ollama', model: 'qwen3-coder-next', note: 'Big: needs a lot of RAM/VRAM', local: true },
  { id: 'ollama-qwen3-coder-30b', label: 'Qwen3-Coder 30B (local)', provider: 'ollama', model: 'qwen3-coder:30b', note: '~19 GB; wants a 24 GB GPU or lots of RAM', local: true },
  { id: 'ollama-qwen3-omni-30b', label: 'Qwen3-Omni 30B-A3B Instruct (local)', provider: 'ollama', model: 'hf.co/ggml-org/Qwen3-Omni-30B-A3B-Instruct-GGUF', hf: 'Qwen/Qwen3-Omni-30B-A3B-Instruct', note: 'GGUF from Hugging Face; text only through Reroute', local: true },
  { id: 'ollama-qwen3.8-27b', label: 'Qwen3.8 27B (local)', provider: 'ollama', model: 'qwen3.8:27b', hf: 'Qwen/Qwen3.8-27B', note: '~17 GB, newest Qwen', local: true },
  { id: 'ollama-qwen3.6-27b-coding', label: 'Qwen3.6 27B Coding (local)', provider: 'ollama', model: 'qwen3.6:27b-coding', note: '~17 GB, coding-tuned', local: true },
  { id: 'ollama-gemma4-26b', label: 'Gemma 4 26B-A4B (local)', provider: 'ollama', model: 'gemma4:26b', note: '~17 GB, fast MoE', local: true },
  { id: 'ollama-nemotron-3-nano-30b', label: 'Nemotron 3 Nano 30B (local)', provider: 'ollama', model: 'nemotron-3-nano:30b', note: '~20 GB, fast MoE', local: true },
  { id: 'ollama-devstral-24b', label: 'Devstral 24B (local)', provider: 'ollama', model: 'devstral:24b', note: '~14 GB, made for coding agents', local: true },
  { id: 'ollama-mistral-small-24b', label: 'Mistral Small 24B (local)', provider: 'ollama', model: 'mistral-small:24b', note: '~14 GB', local: true },
  { id: 'ollama-gpt-oss-20b', label: 'gpt-oss 20B (local)', provider: 'ollama', model: 'gpt-oss:20b', note: '~14 GB', local: true },
  { id: 'ollama-gemma4-12b', label: 'Gemma 4 12B (local)', provider: 'ollama', model: 'gemma4:12b', note: '~8 GB', local: true },
  { id: 'ollama-nemotron-3-nano-4b', label: 'Nemotron 3 Nano 4B (local)', provider: 'ollama', model: 'nemotron-3-nano:4b', note: 'Tiny, ~3 GB', local: true },
  { id: 'ollama-gemma4-e2b', label: 'Gemma 4 E2B (local)', provider: 'ollama', model: 'gemma4:e2b', hf: 'google/gemma-4-E2B-it', note: 'Tiny, runs on almost anything; weak at big coding tasks', local: true },

  // Self-hosted: your own OpenAI-compatible server (vLLM, SGLang, transformers serve) at localhost:8000. Hand-pick only.
  { id: 'local-realtime-venus', label: 'Realtime-Venus Omni 9B (self-hosted)', provider: 'selfhosted', model: 'inclusionAI/Realtime-Venus', hf: 'inclusionAI/Realtime-Venus', note: 'Full-duplex audio/video model; no hosted API, serve it yourself', autoPick: false },
  { id: 'local-janusflow-1.3b', label: 'JanusFlow 1.3B (self-hosted)', provider: 'selfhosted', model: 'deepseek-ai/JanusFlow-1.3B', hf: 'deepseek-ai/JanusFlow-1.3B', note: 'Image understanding/generation model; chat only, no tool calls', autoPick: false },
];

// Context windows in tokens, checked against OpenRouter, Hugging Face and Ollama (September 2026).
// Local Ollama models get `localContext` instead (see DEFAULTS). Unknown models count as DEFAULT_CONTEXT.
export const DEFAULT_CONTEXT = 131072;
export const MODEL_CONTEXT = {
  'glm-5.3': 1048576,
  'kimi-k3': 1048576,
  'deepseek-v4-pro': 1048576,
  'qwen3.8-max': 1000000,
  'qwen3.8-2.4t': 1048576,
  'mimo-v2.6-pro': 1050000,
  'nemotron-3-ultra': 262144,
  'longcat-2.0': 1048756,
  'kimi-k2.7-code': 262144,
  'kat-coder-pro-v2.5': 262144,
  'qwen3-coder-next': 262144,
  'minimax-m3': 1048576,
  'glm-5.2': 1048576,
  'kimi-k2.6': 262144,
  hy3: 262144,
  'qwen3.5-397b': 262144,
  'trinity-large': 262144,
  'minimax-m2.7': 204800,
  'glm-5.3-flash': 1048576,
  'deepseek-v4.1-flash': 1048576,
  'mimo-v2.6-flash': 1048576,
  'qwen3.8-flash': 1000000,
  'ling-3.0-flash': 262144,
  'step-3.7-flash': 262144,
  'qwen3.6-35b': 262144,
  'qwen3.8-omni-flash': 1000000,
  'gpt-oss-120b': 131072,
  'gemma-4-31b': 262144,
  'gemma-4-26b': 262144,
  'mistral-small-2603': 262144,
  'granite-4.2-8b': 131072,
  'nemotron-3-ultra-free': 1000000,
  'qwen3.8-27b-free': 262144,
  'nemotron-3-super-free': 262144,
  'north-mini-code-free': 256000,
  'gemma-4-31b-free': 262144,
  'gemma-4-26b-free': 262144,
  'nemotron-3.5-lightning-free': 1000000,
  'nemotron-3-nano-omni-free': 256000,
  'hf-glm-5.3': 1048576,
  'hf-kimi-k3': 1048576,
  'hf-deepseek-v4-pro': 1048576,
  'hf-qwen3.8-2.4t': 1010000,
  'hf-glm-5.2': 1048576,
  'hf-qwen3-coder-480b': 262144,
  'hf-qwen3-coder-next': 262144,
  'hf-glm-5.3-flash': 1048576,
  'hf-deepseek-v4.1-flash': 1048576,
  'hf-qwen3.8-27b': 1000000,
  'hf-gemma-4-31b': 262144,
  'hf-gemma-4-26b': 262144,
  'hf-gpt-oss-120b': 131072,
  'groq-gpt-oss-120b': 131072,
  'groq-gpt-oss-20b': 131072,
  'ollama-glm-5.3-cloud': 1048576,
  'ollama-kimi-k3-cloud': 1048576,
  'ollama-deepseek-v4-pro-cloud': 1048576,
  'ollama-kimi-k2.7-code-cloud': 262144,
  'ollama-minimax-m3-cloud': 512000,
  'ollama-mistral-large-3-cloud': 262144,
  'ollama-glm-5.2-cloud': 1048576,
  'ollama-kimi-k2.6-cloud': 262144,
  'ollama-minimax-m2.7-cloud': 196608,
  'ollama-glm-5.3-flash-cloud': 1048576,
  'ollama-deepseek-v4.1-flash-cloud': 1048576,
  'ollama-nemotron-3-ultra-cloud': 262144,
  'ollama-gpt-oss-120b-cloud': 131072,
  'ollama-nemotron-3-super-cloud': 262144,
  'ollama-gemma4-31b-cloud': 262144,
  'ollama-nemotron-3-nano-cloud': 262144,
  'local-realtime-venus': 32768,
  'local-janusflow-1.3b': 4096,
};

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
  // Context size Reroute gives local Ollama models (`reroute pull` creates a copy of the model with it).
  // Ollama's own default is only 4k-32k depending on your GPU, which is too small for Claude Code.
  localContext: 32768,
  // Desktop notifications when Reroute switches between Claude and open-source models.
  notify: true,
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
  cfg.models = [...custom, ...DEFAULT_MODELS.filter((m) => !customIds.has(m.id))].map((m) => ({
    ...m,
    context: m.context || MODEL_CONTEXT[m.id] || (m.local ? cfg.localContext : DEFAULT_CONTEXT),
  }));
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

// Model IDs Reroute adds to Claude Code's /model picker. Choosing one sends every request straight to that model.
export const PICKER_PREFIX = 'claude-reroute-';

export function pickerId(m) {
  return PICKER_PREFIX + String(m.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function modelFromPickerId(cfg, requested) {
  if (typeof requested !== 'string') return null;
  const id = requested.toLowerCase().replace(/\[1m\]$/, '');
  if (!id.startsWith(PICKER_PREFIX)) return null;
  if (id === PICKER_PREFIX + 'auto') return 'auto';
  return cfg.models.find((m) => pickerId(m) === id) || null;
}

// Ollama's native API root (the provider baseUrl points at its /v1 OpenAI endpoint).
export function ollamaRoot(cfg) {
  return (cfg.providers.ollama?.baseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

// Name of the larger-context copy `reroute pull` creates for a local Ollama model.
export function ollamaContextName(model) {
  return 'reroute/' + String(model).toLowerCase().replace(/^hf\.co\//, '').replace(/[^a-z0-9.-]+/g, '-');
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
