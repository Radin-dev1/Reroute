// Anthropic Messages API  <->  OpenAI Chat Completions translation.
// Covers what Claude Code uses: system prompts, text, images, tool_use/tool_result, streaming.

import crypto from 'node:crypto';

const STOP_REASONS = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

function newId(prefix) {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function imageToPart(block) {
  const src = block.source || {};
  if (src.type === 'base64') {
    return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  if (src.type === 'url') return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'text') return c.text;
        if (c?.type === 'image') return '[image]';
        // ToolSearch results: Anthropic expands these server-side; open models just need to know the tool is ready.
        if (c?.type === 'tool_reference') return `[Tool ${c.tool_name} is now loaded and can be called.]`;
        return JSON.stringify(c);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

function userBlocksToMessages(content) {
  if (typeof content === 'string') return [{ role: 'user', content }];
  const out = [];
  const parts = [];
  const trailingImages = [];
  for (const block of content || []) {
    if (!block) continue;
    switch (block.type) {
      case 'tool_result': {
        let text = toolResultText(block.content);
        if (block.is_error) text = `Error: ${text}`;
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: text || '(empty)' });
        // Tool messages can't carry images in the OpenAI format; forward them in the next user turn.
        if (Array.isArray(block.content)) {
          for (const c of block.content) if (c?.type === 'image') trailingImages.push(c);
        }
        break;
      }
      case 'text':
        if (block.text) parts.push({ type: 'text', text: block.text });
        break;
      case 'image': {
        const p = imageToPart(block);
        if (p) parts.push(p);
        break;
      }
      case 'document':
        parts.push({ type: 'text', text: block.source?.type === 'text' ? block.source.data : '[document omitted]' });
        break;
      default:
        break;
    }
  }
  for (const img of trailingImages) {
    const p = imageToPart(img);
    if (p) parts.push(p);
  }
  if (parts.length) {
    const textOnly = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: textOnly ? parts.map((p) => p.text).join('\n\n') : parts });
  }
  return out;
}

function assistantBlocksToMessage(content) {
  if (typeof content === 'string') return { role: 'assistant', content };
  const text = [];
  const toolCalls = [];
  for (const block of content || []) {
    if (block?.type === 'text' && block.text) text.push(block.text);
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
    // thinking / redacted_thinking blocks are Claude-specific; drop them.
  }
  const msg = { role: 'assistant', content: text.join('\n\n') || (toolCalls.length ? null : '') };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

export function anthropicToOpenAI(body, targetModel, opts = {}) {
  const messages = [];
  // Claude Code also puts system messages inside the conversation (environment, working directory,
  // reminders). Most OpenAI-style servers only accept a system message at the start, so they join it.
  const inline = (body.messages || []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : systemToText(m.content))).filter(Boolean);
  const sys = [systemToText(body.system), ...inline].filter(Boolean).join('\n\n');
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of body.messages || []) {
    if (m.role === 'user') messages.push(...userBlocksToMessages(m.content));
    else if (m.role === 'assistant') messages.push(assistantBlocksToMessage(m.content));
  }

  const req = { model: targetModel, messages };
  let maxTokens = body.max_tokens;
  if (opts.maxTokens && maxTokens) maxTokens = Math.min(maxTokens, opts.maxTokens);
  if (maxTokens) req.max_tokens = maxTokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences;

  // Only client tools translate; Anthropic server tools (web_search_*, etc.) have no input_schema.
  // Tools found through ToolSearch arrive with defer_loading and a full schema, so they are included;
  // the placeholder that stands in for the rest is not a real tool.
  const tools = (body.tools || []).filter((t) => t && t.input_schema && t.name !== 'DeferredToolPlaceholder');
  if (tools.length) {
    req.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema },
    }));
    const tc = body.tool_choice;
    if (tc?.type === 'any') req.tool_choice = 'required';
    else if (tc?.type === 'tool') req.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') req.tool_choice = 'none';
    else if (tc?.type === 'auto') req.tool_choice = 'auto';
    if (tc?.disable_parallel_tool_use) req.parallel_tool_calls = false;
  }

  if (body.stream) {
    req.stream = true;
    req.stream_options = { include_usage: true };
  }
  return req;
}

// ---------------------------------------------------------------------------
// Tool-call repair. Open models sometimes send tool arguments that aren't quite valid JSON,
// get a tool's name slightly wrong, or write the tool call as plain text. Claude Code rejects
// all of those, so Reroute fixes what it can before passing the call on.

// Returns a parsed object, or null if the text can't be turned into JSON.
export function repairJson(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  let s = String(raw).trim();
  if (!s) return {};
  const tryParse = (t) => {
    try {
      const v = JSON.parse(t);
      // Some models double-encode: "{\"a\":1}"
      if (typeof v === 'string' && /^\s*[{[]/.test(v)) return tryParse(v);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  };
  let v = tryParse(s);
  if (v) return v;

  // ```json ... ``` fences and text around the object
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.search(/[{[]/);
  if (start > 0) s = s.slice(start);
  v = tryParse(s);
  if (v) return v;

  // Trailing commas, then close whatever was left open (a cut-off stream).
  s = s.replace(/,\s*([}\]])/g, '$1');
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let fixed = s;
  if (inStr) fixed += '"';
  fixed = fixed.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  fixed += stack.reverse().join('');
  v = tryParse(fixed.replace(/,\s*([}\]])/g, '$1'));
  if (v) return v;

  // Python-style dicts: {'a': 'b', 'ok': True}
  v = tryParse(
    s
      .replace(/'/g, '"')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null')
  );
  return v;
}

// Maps a tool name the model produced onto one of the tools Claude Code actually offered.
export function fixToolName(name, toolNames) {
  if (!name || !toolNames?.length) return name || '';
  if (toolNames.includes(name)) return name;
  const bare = String(name).replace(/^(functions?|tools?)[.:]/i, '').trim();
  if (toolNames.includes(bare)) return bare;
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = toolNames.find((t) => norm(t) === norm(bare));
  return hit || name;
}

function toolInput(args) {
  const v = repairJson(args);
  if (v && !Array.isArray(v)) return v;
  return { _raw: typeof args === 'string' ? args : JSON.stringify(args) };
}

// Tool calls written into the text: <tool_call>{"name":..,"arguments":..}</tool_call> (Qwen/Hermes style),
// <function=Name>{...}</function>, or a bare {"name":..,"arguments":..} object that is the whole reply.
const TEXT_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>|<function=([\w.-]+)>\s*([\s\S]*?)\s*<\/function>/g;

export function extractTextToolCalls(text, toolNames) {
  if (!text || !toolNames?.length) return { text, calls: [] };
  const calls = [];
  let rest = text.replace(TEXT_CALL_RE, (whole, body, fnName, fnBody) => {
    const obj = fnName ? { name: fnName, arguments: repairJson(fnBody) } : repairJson(body);
    const name = fixToolName(obj?.name || obj?.function?.name, toolNames);
    if (!name || !toolNames.includes(name)) return whole;
    calls.push({ name, input: toolInput(obj.arguments ?? obj.parameters ?? obj.input ?? obj.function?.arguments ?? {}) });
    return '';
  });
  if (!calls.length) {
    const trimmed = rest.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    if (/^\{[\s\S]*\}$/.test(trimmed)) {
      const obj = repairJson(trimmed);
      const name = fixToolName(obj?.name, toolNames);
      if (name && toolNames.includes(name) && (obj.arguments || obj.parameters || obj.input)) {
        calls.push({ name, input: toolInput(obj.arguments ?? obj.parameters ?? obj.input) });
        rest = '';
      }
    }
  }
  return { text: rest.trim(), calls };
}

export function toolNamesOf(body) {
  return (body?.tools || []).filter((t) => t && t.input_schema && t.name !== 'DeferredToolPlaceholder').map((t) => t.name);
}

export function openAIToAnthropic(resp, requestedModel, toolNames = []) {
  const choice = resp.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) text = msg.content.filter((p) => p?.type === 'text').map((p) => p.text).join('');

  const nativeCalls = msg.tool_calls || [];
  if (!nativeCalls.length) {
    const found = extractTextToolCalls(text, toolNames);
    text = found.text;
    for (const c of found.calls) content.push({ type: 'tool_use', id: newId('toolu_'), name: c.name, input: c.input });
  }
  if (text) content.unshift({ type: 'text', text });
  for (const tc of nativeCalls) {
    content.push({
      type: 'tool_use',
      id: tc.id || newId('toolu_'),
      name: fixToolName(tc.function?.name, toolNames),
      input: toolInput(tc.function?.arguments),
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const hasTool = content.some((c) => c.type === 'tool_use');
  let stop = STOP_REASONS[choice.finish_reason] || 'end_turn';
  if (hasTool && stop === 'end_turn') stop = 'tool_use';
  return {
    id: resp.id ? `msg_${String(resp.id).replace(/[^a-zA-Z0-9]/g, '')}` : newId('msg_'),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  };
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* sseDataLines(stream) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  buf += decoder.decode();
  for (const line of buf.split('\n')) if (line.startsWith('data:')) yield line.slice(5).trim();
}

// Longest suffix of `s` that could be the start of a text tool call, so it isn't shown before we know.
const MARKERS = ['<tool_call>', '<function='];
function heldSuffix(s) {
  for (let n = Math.min(s.length, 11); n > 0; n--) {
    const tail = s.slice(-n);
    if (MARKERS.some((m) => m.startsWith(tail))) return n;
  }
  return 0;
}

/**
 * Turns an OpenAI chat.completion.chunk SSE stream into Anthropic Messages SSE events.
 * Text streams live. Tool arguments are collected and sent once complete, after repair,
 * so a cut-off or slightly broken JSON object doesn't make Claude Code reject the call.
 */
export async function* openAIStreamToAnthropic(stream, requestedModel, toolNames = []) {
  const msgId = newId('msg_');
  let index = -1;
  let textOpen = false;
  let pending = ''; // text we're holding back because it may be a text tool call
  let holding = false; // saw a tool-call marker: buffer the rest of the text
  const tools = new Map(); // openai tool index -> { id, name, args }
  let inputTokens = 0;
  let outputTokens = 0;
  let finish = null;

  yield sse('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  function* emitText(t) {
    if (!t) return;
    if (!textOpen) {
      index += 1;
      textOpen = true;
      yield sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    }
    yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } });
  }
  function* closeText() {
    if (textOpen) {
      yield sse('content_block_stop', { type: 'content_block_stop', index });
      textOpen = false;
    }
  }
  function* emitTool(id, name, input) {
    yield* closeText();
    index += 1;
    yield sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } });
    yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
    yield sse('content_block_stop', { type: 'content_block_stop', index });
  }

  for await (const data of sseDataLines(stream)) {
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      yield* closeText();
      yield sse('error', { type: 'error', error: { type: 'api_error', message: chunk.error.message || JSON.stringify(chunk.error) } });
      return;
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};

    if (typeof delta.content === 'string' && delta.content.length) {
      if (holding || !toolNames.length) {
        if (holding) pending += delta.content;
        else yield* emitText(delta.content);
      } else {
        pending += delta.content;
        const at = MARKERS.map((m) => pending.indexOf(m)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
        if (at !== undefined) {
          yield* emitText(pending.slice(0, at));
          pending = pending.slice(at);
          holding = true;
        } else {
          const keep = heldSuffix(pending);
          yield* emitText(pending.slice(0, pending.length - keep));
          pending = pending.slice(pending.length - keep);
        }
      }
    }

    for (const tc of delta.tool_calls || []) {
      const key = tc.index ?? 0;
      if (!tools.has(key)) tools.set(key, { id: tc.id || newId('toolu_'), name: '', args: '' });
      const t = tools.get(key);
      if (tc.id && !t.id) t.id = tc.id;
      // Most providers send the name once; some repeat it on every chunk, a few split it into pieces.
      const nm = tc.function?.name;
      if (nm && nm !== t.name) t.name = t.name && !nm.startsWith(t.name) ? t.name + nm : nm;
      if (tc.function?.arguments) t.args += tc.function.arguments;
    }

    if (choice.finish_reason) finish = choice.finish_reason;
  }

  // Whatever text was held back: either real tool calls written as text, or just text.
  let sawTool = false;
  if (pending) {
    const found = holding && !tools.size ? extractTextToolCalls(pending, toolNames) : { text: pending, calls: [] };
    yield* emitText(found.text);
    for (const c of found.calls) {
      sawTool = true;
      yield* emitTool(newId('toolu_'), c.name, c.input);
    }
  }
  for (const t of tools.values()) {
    sawTool = true;
    yield* emitTool(t.id, fixToolName(t.name, toolNames), toolInput(t.args));
  }

  if (index < 0) yield* emitText(' ');
  yield* closeText();

  let stop = STOP_REASONS[finish] || 'end_turn';
  if (sawTool && stop !== 'max_tokens') stop = 'tool_use';
  yield sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  yield sse('message_stop', { type: 'message_stop' });
}

// Rough token count (about 3.5 characters per token for code-heavy prompts).
export function estimateTokens(body) {
  const len = (v) => (v == null ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length);
  return Math.ceil((len(body?.messages) + len(body?.system) + len(body?.tools)) / 3.5);
}

// ---------------------------------------------------------------------------
// Context fitting. When a conversation is too long for every usable model, drop the oldest turns
// (keeping the first request and the most recent work) so it fits, and say so in the conversation.

function isToolResultOnly(msg) {
  return msg?.role === 'user' && Array.isArray(msg.content) && msg.content.length > 0 && msg.content.every((b) => b?.type === 'tool_result');
}

export function trimToFit(body, maxInputTokens) {
  if (estimateTokens(body) <= maxInputTokens) return { body, dropped: 0 };
  const msgs = body.messages || [];
  if (msgs.length < 4) return null;
  const head = msgs.slice(0, 1);
  for (let cut = 1; cut < msgs.length - 1; cut++) {
    // Keep tool_use/tool_result pairs intact: the kept part must start with a real user turn.
    const tail = msgs.slice(cut);
    if (tail[0].role !== 'user' || isToolResultOnly(tail[0])) continue;
    const note = {
      role: 'assistant',
      content: `[Reroute: ${cut - 1} earlier messages were left out so this conversation fits the open-source model's context window.]`,
    };
    const candidate = { ...body, messages: [...head, note, ...tail] };
    if (estimateTokens(candidate) <= maxInputTokens) return { body: candidate, dropped: cut - 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skill list shrinking. Claude Code lists every installed skill with its full description in each
// request ("The following skills are available for use with the Skill tool:" then "- name: description"
// lines). With big skill collections that is 20k+ tokens. Open models get each description cut to a
// short phrase; they still see every skill name, and the full skill loads when one is used.

const SKILL_HEADER = 'The following skills are available for use with the Skill tool:';

function shortenListing(text, maxDesc) {
  const at = text.indexOf(SKILL_HEADER);
  if (at < 0) return text;
  const lines = text.slice(at).split('\n');
  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    // A blank line ends the list; other non-dash lines are a multi-line description, left as they are.
    if (line.trim() === '') break;
    if (!line.startsWith('- ')) continue;
    // "- plugin:skill: description" — the description starts after the first ": " that follows the name.
    const m = line.match(/^- (\S+?): (.*)$/);
    if (!m || m[2].length <= maxDesc) continue;
    let d = m[2];
    const stop = d.search(/[.!?](\s|$)/);
    d = stop > 15 && stop < maxDesc ? d.slice(0, stop + 1) : d.slice(0, maxDesc).replace(/\s+\S*$/, '') + '…';
    lines[i] = `- ${m[1]}: ${d}`;
  }
  return text.slice(0, at) + lines.join('\n');
}

export function compressSkillListing(body, maxDesc = 70) {
  let saved = 0;
  const fix = (text) => {
    if (typeof text !== 'string' || !text.includes(SKILL_HEADER)) return text;
    const out = shortenListing(text, maxDesc);
    saved += text.length - out.length;
    return out;
  };
  const system = typeof body.system === 'string' ? fix(body.system) : Array.isArray(body.system) ? body.system.map((b) => (b?.type === 'text' ? { ...b, text: fix(b.text) } : b)) : body.system;
  const messages = (body.messages || []).map((m) => {
    if (typeof m.content === 'string') return { ...m, content: fix(m.content) };
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map((b) => (b?.type === 'text' ? { ...b, text: fix(b.text) } : b)) };
  });
  return saved > 0 ? { body: { ...body, system, messages }, saved } : { body, saved: 0 };
}

// ---------------------------------------------------------------------------
// Slimming for small local models. Claude Code sends ~20k tokens of tool definitions with every
// request (the Artifact tool alone is ~8k). A 4B model running on your GPU has a small context, and
// every token costs video memory, so it gets the core coding tools with shorter descriptions.

const CORE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'PowerShell', 'Glob', 'Grep', 'TodoWrite', 'WebFetch', 'WebSearch', 'NotebookEdit', 'ToolSearch']);

function shortText(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s;
  const para = s.split(/\n\s*\n/)[0];
  const cut = para.length <= n ? para : para.slice(0, n).replace(/\s+\S*$/, '') + '…';
  return cut;
}

function slimSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 6) return schema;
  if (Array.isArray(schema)) return schema.map((x) => slimSchema(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description') out[k] = shortText(v, 160);
    else if (k === '$schema') continue;
    else out[k] = typeof v === 'object' ? slimSchema(v, depth + 1) : v;
  }
  return out;
}

export function slimForSmallModel(body) {
  const used = new Set();
  for (const m of body.messages || []) if (Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_use') used.add(b.name);
  const tools = (body.tools || [])
    .filter((t) => t && t.input_schema && t.name !== 'DeferredToolPlaceholder')
    .filter((t) => CORE_TOOLS.has(t.name) || used.has(t.name) || (t.defer_loading && t.name.startsWith('mcp__')))
    .map((t) => ({ ...t, description: shortText(t.description, 700), input_schema: slimSchema(t.input_schema) }));
  return { ...body, tools };
}
