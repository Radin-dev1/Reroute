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
  const sys = systemToText(body.system);
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
  const tools = (body.tools || []).filter((t) => t && t.input_schema);
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

function safeParseJson(s) {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

export function openAIToAnthropic(resp, requestedModel) {
  const choice = resp.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === 'string' && msg.content) content.push({ type: 'text', text: msg.content });
  else if (Array.isArray(msg.content)) {
    for (const p of msg.content) if (p?.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
  }
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: tc.id || newId('toolu_'),
      name: tc.function?.name || '',
      input: safeParseJson(tc.function?.arguments),
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

/**
 * Turns an OpenAI chat.completion.chunk SSE stream into Anthropic Messages SSE events.
 * Yields strings ready to write to the response.
 */
export async function* openAIStreamToAnthropic(stream, requestedModel) {
  const msgId = newId('msg_');
  let index = -1;
  let openType = null; // 'text' | 'tool' | null
  const toolBlocks = new Map(); // openai tool index -> our block index
  let inputTokens = 0;
  let outputTokens = 0;
  let finish = null;
  let sawTool = false;

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

  const close = function* () {
    if (openType) {
      yield sse('content_block_stop', { type: 'content_block_stop', index });
      openType = null;
    }
  };

  for await (const data of sseDataLines(stream)) {
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      yield* close();
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
      if (openType !== 'text') {
        yield* close();
        index += 1;
        openType = 'text';
        yield sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      }
      yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta.content } });
    }

    for (const tc of delta.tool_calls || []) {
      const key = tc.index ?? 0;
      if (!toolBlocks.has(key)) {
        yield* close();
        index += 1;
        openType = 'tool';
        sawTool = true;
        toolBlocks.set(key, index);
        yield sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: tc.id || newId('toolu_'), name: tc.function?.name || '', input: {} },
        });
      }
      const args = tc.function?.arguments;
      // Providers stream tool calls one after another, so deltas belong to the open block.
      if (args && toolBlocks.get(key) === index && openType === 'tool') {
        yield sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args } });
      }
    }

    if (choice.finish_reason) finish = choice.finish_reason;
  }

  if (index < 0) {
    index = 0;
    openType = 'text';
    yield sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  }
  yield* close();

  let stop = STOP_REASONS[finish] || 'end_turn';
  if (sawTool && stop === 'end_turn') stop = 'tool_use';
  yield sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  });
  yield sse('message_stop', { type: 'message_stop' });
}

export function estimateTokens(body) {
  return Math.ceil(JSON.stringify(body?.messages ?? '').length / 3.5 + JSON.stringify(body?.system ?? '').length / 3.5 + JSON.stringify(body?.tools ?? '').length / 3.5);
}
