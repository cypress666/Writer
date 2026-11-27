/**
 * 模型适配器。统一聊天/嵌入接口，屏蔽 OpenAI 兼容与 Anthropic 的协议差异。
 *
 * 流式实现用 fetch + ReadableStream 手工解析 SSE，不引入 SDK 依赖：
 * 这样 Ollama / LM Studio / 任意兼容端点都能用同一套代码。
 */

import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ConnectivityResult,
  EmbedRequest,
  EmbedResponse,
  ModelConfig,
} from './types.js';

export interface ChatProvider {
  readonly kind: ModelConfig['provider'];
  chat(request: ChatRequest, config: ModelConfig, apiKey: string): Promise<ChatResponse>;
  connectivity(config: ModelConfig, apiKey: string): Promise<ConnectivityResult>;
}

export interface EmbeddingProvider {
  embed(request: EmbedRequest, config: ModelConfig, apiKey: string): Promise<EmbedResponse>;
}

function normalizedBase(url: string): string {
  return url.replace(/\/+$/, '');
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** 通用 SSE 流式读取：按 data: 行分割，兼容 [DONE] 与 Anthropic 事件 */
async function readSse(
  response: Response,
  extract: (payload: Record<string, unknown>) => string | null,
  onToken?: (token: string) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data) as Record<string, unknown>;
        const token = extract(payload);
        if (token) {
          full += token;
          onToken?.(token);
        }
      } catch {
        // 忽略非 JSON 的 SSE 行（心跳注释等）
      }
    }
  }
  return full;
}

/**
 * Ollama 原生流是 NDJSON（每行一个完整 JSON），不是 SSE。
 * 单独实现，别和 readSse 混用。
 */
async function readNdjson(
  response: Response,
  extract: (payload: Record<string, unknown>) => string | null,
  onToken?: (token: string) => void,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const token = extract(JSON.parse(trimmed) as Record<string, unknown>);
        if (token) {
          full += token;
          onToken?.(token);
        }
      } catch (error) {
        // 流中途的 error 必须抛出去，否则会被当成正常空返回
        if (error instanceof Error && error.message.startsWith('Ollama')) throw error;
      }
    }
  }
  return full;
}

/** 判断 baseUrl 是否指向 Ollama：端口 11434 或主机/路径里带 ollama */
export function isOllamaEndpoint(config: ModelConfig): boolean {
  if (config.provider !== 'openai-compatible') return false;
  try {
    const url = new URL(config.baseUrl);
    if (url.port === '11434') return true;
    return /ollama/i.test(url.hostname) || /ollama/i.test(url.pathname);
  } catch {
    return /ollama/i.test(config.baseUrl);
  }
}

export class OpenAiCompatibleProvider implements ChatProvider, EmbeddingProvider {
  readonly kind = 'openai-compatible' as const;

  async chat(request: ChatRequest, config: ModelConfig, apiKey: string): Promise<ChatResponse> {
    const body = {
      model: config.model,
      messages: request.messages,
      temperature: request.temperature ?? config.temperature ?? 0.8,
      max_tokens: request.maxTokens ?? config.maxTokens ?? 4096,
      stream: typeof request.onToken === 'function',
    };
    const response = await fetch(`${normalizedBase(config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`模型请求失败 ${response.status}: ${await response.text()}`);

    if (body.stream) {
      const content = await readSse(
        response,
        (payload) => {
          const choices = payload.choices as Array<{ delta?: { content?: string } }> | undefined;
          return choices?.[0]?.delta?.content ?? null;
        },
        request.onToken,
      );
      return { content, model: config.model };
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: ChatResponse['usage'];
    };
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      model: config.model,
      usage: data.usage,
    };
  }

  async embed(request: EmbedRequest, config: ModelConfig, apiKey: string): Promise<EmbedResponse> {
    const response = await fetch(`${normalizedBase(config.baseUrl)}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ model: config.model, input: request.inputs }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Embedding 请求失败 ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    return {
      vectors: (data.data ?? []).map((item) => item.embedding),
      model: config.model,
    };
  }

  async connectivity(config: ModelConfig, apiKey: string): Promise<ConnectivityResult> {
    const started = Date.now();
    try {
      const response = await fetch(`${normalizedBase(config.baseUrl)}/models`, {
        headers: authHeaders(apiKey),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        return { ok: false, latencyMs: Date.now() - started, message: `HTTP ${response.status}` };
      }
      const data = (await response.json()) as { data?: Array<{ id: string }> };
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: '连接正常',
        modelList: (data.data ?? []).map((item) => item.id),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/**
 * Ollama 原生适配器。
 *
 * 为什么不用 OpenAI 兼容端点：`/v1/chat/completions` **会忽略 num_ctx**，
 * 走 Ollama 的默认上下文（实测约 2048），超出部分从**开头**截断——
 * 也就是 system 指令先被扔掉，模型看到半截正文就自由发挥。
 * 表现是「提示词明明写了 JSON schema，模型却在续写小说」。
 * 原生 `/api/chat` 才接受 `options.num_ctx`，所以本地模型必须走这里。
 */
export class OllamaProvider implements ChatProvider, EmbeddingProvider {
  readonly kind = 'openai-compatible' as const;

  /** 把 `http://host:11434/v1` 还原成原生根 `http://host:11434` */
  private static root(baseUrl: string): string {
    return normalizedBase(baseUrl).replace(/\/v1$/, '');
  }

  /** 上下文窗口至少要能装下 system + 一章正文，太小等于没设 */
  private static numCtx(config: ModelConfig): number {
    const raw = Number(config.contextWindow) || 8192;
    return Math.min(Math.max(Math.round(raw), 2048), 131072);
  }

  async chat(request: ChatRequest, config: ModelConfig, apiKey: string): Promise<ChatResponse> {
    const streaming = typeof request.onToken === 'function';
    const body = {
      model: config.model,
      messages: request.messages,
      stream: streaming,
      options: {
        temperature: request.temperature ?? config.temperature ?? 0.8,
        num_predict: request.maxTokens ?? config.maxTokens ?? 4096,
        num_ctx: OllamaProvider.numCtx(config),
      },
    };
    const response = await fetch(`${OllamaProvider.root(config.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Ollama 请求失败 ${response.status}: ${await response.text()}`);

    if (streaming) {
      const content = await readNdjson(
        response,
        (payload) => {
          if (payload.error) throw new Error(`Ollama 返回错误: ${String(payload.error)}`);
          const message = payload.message as { content?: string } | undefined;
          return message?.content ?? null;
        },
        request.onToken,
      );
      return { content, model: config.model };
    }

    const data = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
      error?: string;
    };
    if (data.error) throw new Error(`Ollama 返回错误: ${data.error}`);
    return {
      content: data.message?.content ?? '',
      model: config.model,
      usage: {
        promptTokens: data.prompt_eval_count,
        completionTokens: data.eval_count,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
    };
  }

  async embed(request: EmbedRequest, config: ModelConfig, apiKey: string): Promise<EmbedResponse> {
    const response = await fetch(`${OllamaProvider.root(config.baseUrl)}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model: config.model,
        input: request.inputs,
        options: { num_ctx: OllamaProvider.numCtx(config) },
      }),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Ollama Embedding 请求失败 ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as { embeddings?: number[][]; error?: string };
    if (data.error) throw new Error(`Ollama 返回错误: ${data.error}`);
    return { vectors: data.embeddings ?? [], model: config.model };
  }

  async connectivity(config: ModelConfig, apiKey: string): Promise<ConnectivityResult> {
    const started = Date.now();
    try {
      const response = await fetch(`${OllamaProvider.root(config.baseUrl)}/api/tags`, {
        headers: authHeaders(apiKey),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        return { ok: false, latencyMs: Date.now() - started, message: `HTTP ${response.status}` };
      }
      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      const modelList = (data.models ?? []).map((item) => item.name ?? '').filter(Boolean);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        message: `连接正常 · 本地 ${modelList.length} 个模型 · 上下文 ${OllamaProvider.numCtx(config)}`,
        modelList,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic' as const;

  async chat(request: ChatRequest, config: ModelConfig, apiKey: string): Promise<ChatResponse> {
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body = {
      model: config.model,
      messages,
      ...(system ? { system } : {}),
      temperature: request.temperature ?? config.temperature ?? 0.8,
      max_tokens: request.maxTokens ?? config.maxTokens ?? 4096,
      stream: typeof request.onToken === 'function',
    };
    const response = await fetch(`${normalizedBase(config.baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!response.ok) throw new Error(`Claude 请求失败 ${response.status}: ${await response.text()}`);

    if (body.stream) {
      const content = await readSse(
        response,
        (payload) => {
          if (payload.type !== 'content_block_delta') return null;
          const delta = payload.delta as { type?: string; text?: string } | undefined;
          return delta?.type === 'text_delta' ? (delta.text ?? null) : null;
        },
        request.onToken,
      );
      return { content, model: config.model };
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      content: (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(''),
      model: config.model,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }

  async connectivity(config: ModelConfig, apiKey: string): Promise<ConnectivityResult> {
    const started = Date.now();
    try {
      // Anthropic 没有 /models 端点，用最小请求探活
      await this.chat(
        {
          modelId: config.id,
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 1,
        },
        config,
        apiKey,
      );
      return { ok: true, latencyMs: Date.now() - started, message: '连接正常' };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function providerFor(config: ModelConfig): ChatProvider {
  if (config.provider === 'anthropic') return new AnthropicProvider();
  // Ollama 必须走原生端点，否则 num_ctx 被忽略、system 指令会被截断
  if (isOllamaEndpoint(config)) return new OllamaProvider();
  return new OpenAiCompatibleProvider();
}

export function embeddingProviderFor(config: ModelConfig): EmbeddingProvider {
  if (isOllamaEndpoint(config)) return new OllamaProvider();
  return new OpenAiCompatibleProvider();
}
