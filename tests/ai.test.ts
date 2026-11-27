import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiClient } from '../src/ai/client.js';
import { AiConfigStore, DEFAULT_AI_CONFIG } from '../src/ai/config.js';
import { applyDecisions, diffParagraphs } from '../src/ai/diff.js';
import { parseLlmObservations } from '../src/ai/prompts.js';
import { AnthropicProvider, OpenAiCompatibleProvider } from '../src/ai/providers.js';
import { SecretStore, type SafeStorageLike } from '../src/ai/secret-store.js';
import type { AiConfiguration, ModelConfig } from '../src/ai/types.js';

function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: 'm1',
    label: '测试模型',
    provider: 'openai-compatible',
    baseUrl: 'http://api.example.com/v1',
    credentialId: 'cred-1',
    model: 'test-model',
    contextWindow: 8192,
    enabled: true,
    ...overrides,
  };
}

function config(overrides: Partial<AiConfiguration> = {}): AiConfiguration {
  return {
    ...structuredClone(DEFAULT_AI_CONFIG),
    defaults: { writing: 'm1', audit: 'm1' },
    models: [model()],
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('模型协议适配', () => {
  it('OpenAI 兼容端点解析流式 delta 并回调 token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '你' } }] }),
        JSON.stringify({ choices: [{ delta: { content: '好' } }] }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tokens: string[] = [];
    const result = await new OpenAiCompatibleProvider().chat(
      { modelId: 'm1', messages: [{ role: 'user', content: '写' }], onToken: (t) => tokens.push(t) },
      model(),
      '',
    );
    expect(result.content).toBe('你好');
    expect(tokens).toEqual(['你', '好']);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { stream: boolean };
    expect(body.stream).toBe(true);
  });

  it('Anthropic 适配器把 system 消息抽出并映射 text_delta', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '甲' } }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tokens: string[] = [];
    const result = await new AnthropicProvider().chat(
      {
        modelId: 'm1',
        messages: [
          { role: 'system', content: '你是编辑' },
          { role: 'user', content: '审稿' },
        ],
        onToken: (t) => tokens.push(t),
      },
      model({ provider: 'anthropic', baseUrl: 'http://localhost:9999' }),
      'sk-ant',
    );
    expect(result.content).toBe('甲');
    expect(tokens).toEqual(['甲']);
    const init = fetchMock.mock.calls[0]?.[1] as { body: string; headers: Record<string, string> };
    const body = JSON.parse(init.body) as { system: string; messages: Array<{ role: string }> };
    expect(body.system).toBe('你是编辑');
    expect(body.messages).toEqual([{ role: 'user', content: '审稿' }]);
    expect(init.headers['x-api-key']).toBe('sk-ant');
  });
});

describe('统一客户端', () => {
  it('非流式请求失败后按指数退避重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '完成' } }], usage: { completionTokens: 7 } }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new AiClient({ config: config(), resolveKey: () => 'sk' });
    const result = await client.chat('writing', { messages: [{ role: 'user', content: '写' }] });
    expect(result.content).toBe('完成');
    expect(result.usage?.completionTokens).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('流式请求不重试，避免已推送 token 重复', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('网络中断'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new AiClient({ config: config(), resolveKey: () => '' });
    await expect(
      client.chat('writing', {
        messages: [{ role: 'user', content: '写' }],
        onToken: () => undefined,
      }),
    ).rejects.toThrow('网络中断');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('按用途解析模型，未配置时给出明确错误', () => {
    const client = new AiClient({
      config: config({ defaults: { writing: 'm1' } }),
      resolveKey: () => '',
    });
    expect(client.resolveFor('writing').id).toBe('m1');
    expect(() => client.resolveFor('embedding')).toThrow('未配置可用模型');
  });
});

describe('配置与密钥安全', () => {
  it('配置文件不落盘任何 key 字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkforge-config-'));
    tempDirs.push(dir);
    const store = new AiConfigStore(join(dir, 'ai.json'));
    store.save({
      ...config(),
      models: [{ ...model(), key: 'sk-leak' } as unknown as ModelConfig],
    });
    const raw = readFileSync(join(dir, 'ai.json'), 'utf8');
    expect(raw).not.toContain('sk-leak');
    expect(store.load().models[0]?.credentialId).toBe('cred-1');
  });

  it('密钥经加密后写入独立文件，列表接口不返回密文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkforge-secret-'));
    tempDirs.push(dir);
    const file = join(dir, 'credentials.json');
    const reversible: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain.split('').reverse().join('')),
      decryptString: (cipher) => cipher.toString().split('').reverse().join(''),
    };
    const store = new SecretStore({ filePath: file, storage: reversible });
    store.save('cred-1', '本地模型', 'sk-abcdef');
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('sk-abcdef');
    expect(store.reveal('cred-1')).toBe('sk-abcdef');
    expect(store.list()[0]).toEqual({
      id: 'cred-1',
      label: '本地模型',
      createdAt: expect.any(String),
    });
  });

  it('系统加密不可用时拒绝保存密钥', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inkforge-secret-'));
    tempDirs.push(dir);
    const store = new SecretStore({
      filePath: join(dir, 'credentials.json'),
      storage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from(''),
        decryptString: () => '',
      },
    });
    expect(() => store.save('c', 'x', 'sk')).toThrow('拒绝以明文保存密钥');
  });
});

describe('段落级差分裁决', () => {
  it('新增段落必须被显式接受，否则不进入正文', () => {
    const diff = diffParagraphs('甲\n\n乙', '甲\n\n乙\n\n丙');
    expect(diff.stats).toEqual({ kept: 2, replaced: 0, added: 1, removed: 0 });
    const addIndex = diff.changes.findIndex((c) => c.op === 'add');
    expect(applyDecisions(diff.changes, new Set())).toBe('甲\n\n乙');
    expect(applyDecisions(diff.changes, new Set([addIndex]))).toBe('甲\n\n乙\n\n丙');
  });

  it('替换与删除按接受/拒绝分别还原', () => {
    const diff = diffParagraphs('甲\n\n乙', '甲\n\n丙');
    const replaceIndex = diff.changes.findIndex((c) => c.op === 'replace');
    expect(applyDecisions(diff.changes, new Set([replaceIndex]))).toBe('甲\n\n丙');
    expect(applyDecisions(diff.changes, new Set())).toBe('甲\n\n乙');

    const removal = diffParagraphs('甲\n\n乙', '甲');
    const removeIndex = removal.changes.findIndex((c) => c.op === 'remove');
    expect(applyDecisions(removal.changes, new Set([removeIndex]))).toBe('甲');
    expect(applyDecisions(removal.changes, new Set())).toBe('甲\n\n乙');
  });
});

describe('LLM 观察结果解析', () => {
  it('容忍代码围栏并过滤非法条目，规范化 severity 与段落序号', () => {
    const raw = [
      '```json',
      JSON.stringify([
        { category: 'ooc', severity: 'error', paragraphIndex: 2, message: '角色违背设定', evidence: '他说' },
        { category: 'word-count', severity: 'error', message: '字数不足', evidence: '' },
        { category: 'logic', severity: 'unknown', paragraphIndex: -1, message: '因果跳跃', evidence: '因此' },
      ]),
      '```',
    ].join('\n');
    const result = parseLlmObservations(raw);
    expect(result).toHaveLength(2);
    expect(result[0]?.category).toBe('ooc');
    expect(result[1]?.severity).toBe('info');
    expect(result[1]?.paragraphIndex).toBeNull();
  });

  it('非 JSON 输出返回空数组而不是污染报告', () => {
    expect(parseLlmObservations('抱歉，我无法完成')).toEqual([]);
  });
});
