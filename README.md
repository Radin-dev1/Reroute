# Reroute

**Use Claude until you run out, then keep working on the best open-source model, automatically.**

Reroute is a tiny local proxy for **Claude Code**: the terminal CLI and the Code tab in the Claude desktop app. Every request goes to Claude as normal, using your own login (Pro/Max subscription or API key). When Claude answers that you're **out of credits** or have **hit your usage limit**, Reroute switches that request, and the ones after it, to an open-source model you choose. When the limit resets, it goes back to Claude on its own.

- No dependencies. Node 18+ and one folder.
- Your Claude login is only ever sent to Anthropic, never to a fallback provider.
- You pick the model. The rest act as **backups** if your pick fails.
- Handles tool calls, streaming, images and system prompts, so Claude Code keeps editing files and running commands on the fallback model.
- Dashboard at `http://127.0.0.1:4747/` to switch models and modes.

```
Claude Code ──► Reroute (localhost:4747) ──► Claude (your login)
                        │  out of credits / usage limit?
                        └──────────────► your pick ─► backup ─► backup …
```

## Install

```bash
git clone https://github.com/Radin-dev1/Reroute.git
cd Reroute
npm link
reroute install
```

`reroute install`:
1. starts Reroute in the background,
2. sets `ANTHROPIC_BASE_URL=http://127.0.0.1:4747` in `~/.claude/settings.json` (it backs up the file first). The Claude Code CLI and the desktop app's Code tab both read this file,
3. makes Reroute start when you log in (Windows Startup folder, macOS LaunchAgent, or Linux autostart).

Restart Claude Code and the desktop app afterwards. To undo everything, run `reroute uninstall`.

Want it in the terminal only, with no settings changed? Run `reroute claude` instead of `claude`.

> Reroute works with **Claude Code** (terminal and the desktop app's Code tab). Regular chats on claude.ai or in the desktop app's chat tab talk to Anthropic's servers directly, so they can't be rerouted.

## Give it at least one fallback

Pick whichever is easiest:

| Option | What to do | Cost |
|---|---|---|
| **Ollama Cloud** | Install [Ollama](https://ollama.com), run `ollama signin` | Free tier includes gpt-oss 120B and Nemotron 3 Super |
| **OpenRouter** | `reroute key openrouter sk-or-...` | Pay per token; some `:free` models |
| **Hugging Face** | `reroute key huggingface hf_...` | HF Inference Providers credits |
| **Fully local** | `reroute pull ollama-gemma4-e2b` (or any local model below) | Free, runs on your machine |
| Groq / DeepSeek / Z.ai / Moonshot | `reroute key groq ...` etc. | Their pricing |

Keys can also come from environment variables: `OPENROUTER_API_KEY`, `HF_TOKEN`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_API_KEY`.

## Choosing a model

```bash
reroute models                 # list every model and whether it's ready
reroute use kimi-k3            # pick one
reroute use auto               # let Reroute pick the best one you can use
reroute backups off            # only ever use your pick
reroute add my-model openrouter qwen/qwen3.8-flash "Qwen3.8 Flash"   # add any model
```

Or open the dashboard (`reroute open`) and click one.

**How the order works:** your pick goes first. If it refuses (not in your plan, quota used up, offline, not downloaded), Reroute moves to the next model on the list below and skips the one that refused for a while. With `auto`, it starts at the top.

## Built-in models (September 2026)

Listed in the order Reroute tries them.

**OpenRouter**: GLM-5.3 · Kimi K3 · DeepSeek V4 Pro · Qwen3.8 Max · Qwen3.8 2.4T-A95B · Kimi K2.7 Code · Qwen3-Coder Next · GLM-5.3 Flash · DeepSeek V4.1 Flash · MiniMax M3 · Qwen3.8 Omni Flash · gpt-oss 120B · *free:* Qwen3.8 27B, Gemma 4 31B, Nemotron 3 Nano Omni

**Hugging Face Inference**: GLM-5.3 · Kimi K3 · DeepSeek V4 Pro · Qwen3.8 27B · gpt-oss 120B

**Groq**: gpt-oss 120B

**Ollama Cloud**: GLM-5.3 · Kimi K3 · DeepSeek V4.1 Flash · gpt-oss 120B *(free tier)* · Nemotron 3 Super *(free tier)*

**Local via Ollama**: Qwen3-Coder 30B · [Qwen3-Omni 30B-A3B Instruct](https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct) · Gemma 4 26B-A4B · gpt-oss 20B · Gemma 4 12B · [Gemma 4 E2B](https://huggingface.co/google/gemma-4-E2B-it)

**Self-hosted, hand-pick only**: [Realtime-Venus](https://huggingface.co/inclusionAI/Realtime-Venus) · [JanusFlow 1.3B](https://huggingface.co/deepseek-ai/JanusFlow-1.3B)

Notes on some of these:
- **Qwen3-Omni** is pulled as a GGUF from Hugging Face (`hf.co/ggml-org/Qwen3-Omni-30B-A3B-Instruct-GGUF`). Through Reroute it's used for text; its audio and video features aren't wired up.
- **Gemma 4 E2B** is tiny and runs almost anywhere, but it struggles with big multi-step coding tasks.
- **Realtime-Venus** (a full-duplex audio/video model) and **JanusFlow** (an image understanding/generation model) have no hosted API or GGUF. Serve them yourself on an OpenAI-compatible server at `http://localhost:8000/v1` (vLLM, SGLang, `transformers serve`...). JanusFlow can't call tools, so it can chat but can't edit files. `auto` never picks either of these.

## When does it switch?

| Claude replies with | Reroute does |
|---|---|
| `429` rate/usage limit | Switches until the time Anthropic says the limit resets (from the `anthropic-ratelimit-unified-reset` / `retry-after` headers), or 30 minutes if it doesn't say |
| "credit balance is too low" / billing / quota errors | Switches for `cooldownMinutes` (30 by default) |
| `529` overloaded | Switches for 90 seconds (turn off with `"fallbackOnOverload": false`) |
| Any other error (bad request, auth…) | Passes it to Claude Code unchanged |

`reroute reset` (or "Try Claude now" in the dashboard) goes back to Claude immediately.

## Modes

```bash
reroute mode auto       # default: Claude first, open source when you run out
reroute mode claude     # never switch (plain pass-through)
reroute mode fallback   # always use the open-source model
```

## All commands

```
reroute install | uninstall | claude [args] | start | stop | status | open | logs
reroute models | use <id|auto> | backups <on|off> | add | remove | pull <id>
reroute mode <auto|claude|fallback> | key <provider> <key> | reset
```

## Config

`~/.reroute/config.json` (you can change the location with `REROUTE_HOME`):

```json
{
  "port": 4747,
  "mode": "auto",
  "fallbackModel": "auto",
  "backups": true,
  "cooldownMinutes": 30,
  "fallbackOnOverload": true,
  "apiKeys": { "openrouter": "sk-or-..." },
  "providers": {
    "mybox": { "label": "My GPU box", "type": "openai", "baseUrl": "http://192.168.1.50:8000/v1", "keyless": true }
  },
  "customModels": [
    { "id": "my-model", "label": "My model", "provider": "mybox", "model": "Qwen/Qwen3.8-27B", "maxTokens": 16000 }
  ]
}
```

Provider `type` is `openai` (any `/chat/completions` API; Reroute translates to and from Anthropic's format) or `anthropic` (any `/v1/messages` API, like Ollama's, passed through with the model name swapped).

## Development

```bash
npm test
```

The tests start fake Claude and fake open-source servers and check the switch-over, the cooldowns, backups, and translating streaming tool calls.

## License

MIT
