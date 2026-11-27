/**
 * Ollama 原生端点回归测试。
 *
 * 背景：Ollama 的 OpenAI 兼容端点 /v1/chat/completions **不认 num_ctx**，
 * 走默认上下文时超出部分从开头截断 —— system 指令先被丢弃，
 * 模型会把「抽取设定」的任务当成「续写正文」。
 * 所以本地模型必须走原生 /api/chat，这里锁死这个行为。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OllamaProvider,
  embeddingProviderFor,
  isOllamaEndpoint,
  providerFor,
} from '../src/ai/providers.js';
import type { ModelConfig } from '../src/ai/types.js';

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'ollama',
    label: '本地千问',
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    credentialId: '',
    model: 'qwen2.5:7b',
    contextWindow: 8192,
    enabled: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ollama 端点识别', () => {
  it('识别默认端口 11434', () => {
    expect(isOllamaEndpoint(model())).toBe(true);
  });

  it('识别主机名/路径里带 ollama 的地址', () => {
    expect(isOllamaEndpoint(model({ baseUrl: 'http://ollama.lan/v1' }))).toBe(true);
    expect(isOllamaEndpoint(model({ baseUrl: 'http://10.0.0.5:8080/ollama/v1' }))).toBe(true);
  });

  it('不把 DeepSeek 之类云服务误判成 Ollama', () => {
    expect(isOllamaEndpoint(model({ baseUrl: 'https://api.deepseek.com/v1' }))).toBe(false);
    expect(isOllamaEndpoint(model({ baseUrl: 'https://api.openai.com/v1' }))).toBe(false);
  });

  it('anthropic 协议永远不当作 Ollama', () => {
    expect(isOllamaEndpoint(model({ provider: 'anthropic', baseUrl: 'http://127.0.0.1:11434' }))).toBe(
      false,
    );
  });

  it('providerFor 为 Ollama 返回原生适配器', () => {
    expect(providerFor(model())).toBeInstanceOf(OllamaProvider);
    expect(embeddingProviderFor(model())).toBeInstanceOf(OllamaProvider);
    expect(providerFor(model({ baseUrl: 'https://api.deepseek.com/v1' }))).not.toBeInstanceOf(
      OllamaProvider,
    );
  });
});

describe('Ollama 原生请求体', () => {
  it('打到 /api/chat 并携带 num_ctx（而不是 /v1/chat/completions）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: { content: 'ok' }, prompt_eval_count: 12, eval_count: 3 }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OllamaProvider().chat(
      { modelId: 'ollama', messages: [{ role: 'user', content: 'hi' }] },
      model({ contextWindow: 16384, model: 'qwen2.5:7b' }),
      '',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://127.0.0.1:11434/api/chat');
    expect(url).not.toContain('/v1/');
    const body = JSON.parse(init.body) as {
      model: string;
      options: { num_ctx: number; num_predict: number };
    };
    // num_ctx 是本修复的核心：没有它，长提示词会被静默截断
    expect(body.options.num_ctx).toBe(16384);
    expect(body.options.num_predict).toBe(4096);
    expect(body.model).toBe('qwen2.5:7b');
    expect(result.content).toBe('ok');
    expect(result.usage?.promptTokens).toBe(12);
  });

  it('上下文窗口过小时抬到 2048 下限，过大时夹到上限', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: { content: '' } }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider();
    await provider.chat(
      { modelId: 'ollama', messages: [{ role: 'user', content: 'a' }] },
      model({ contextWindow: 256 }),
      '',
    );
    await provider.chat(
      { modelId: 'ollama', messages: [{ role: 'user', content: 'b' }] },
      model({ contextWindow: 999999 }),
      '',
    );

    const first = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      options: { num_ctx: number };
    };
    const second = JSON.parse((fetchMock.mock.calls[1]?.[1] as { body: string }).body) as {
      options: { num_ctx: number };
    };
    expect(first.options.num_ctx).toBe(2048);
    expect(second.options.num_ctx).toBe(131072);
  });

  it('流式按 NDJSON 逐行解析', async () => {
    const chunks = [
      '{"message":{"content":"你"}}\n',
      '{"message":{"content":"好"}}\n',
      '{"done":true}\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const tokens: string[] = [];
    const result = await new OllamaProvider().chat(
      {
        modelId: 'ollama',
        messages: [{ role: 'user', content: 'hi' }],
        onToken: (token) => tokens.push(token),
      },
      model(),
      '',
    );
    expect(result.content).toBe('你好');
    expect(tokens).toEqual(['你', '好']);
  });

  it('原生错误返回体要抛出可读错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'model "nope" not found' }), { status: 200 }),
      ),
    );
    await expect(
      new OllamaProvider().chat(
        { modelId: 'ollama', messages: [{ role: 'user', content: 'hi' }] },
        model(),
        '',
      ),
    ).rejects.toThrow(/model "nope" not found/);
  });

  it('embedding 走 /api/embed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OllamaProvider().embed(
      { modelId: 'ollama', inputs: ['文本'] },
      model({ model: 'nomic-embed-text' }),
      '',
    );
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('http://127.0.0.1:11434/api/embed');
    expect(result.vectors).toEqual([[0.1, 0.2]]);
  });

  it('连通性探测走 /api/tags 并回报可用模型与上下文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3:8b' }] }), {
          status: 200,
        }),
      ),
    );
    const result = await new OllamaProvider().connectivity(model({ contextWindow: 8192 }), '');
    expect(result.ok).toBe(true);
    expect(result.modelList).toEqual(['qwen2.5:7b', 'llama3:8b']);
    expect(result.message).toContain('8192');
  });
});
