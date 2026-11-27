/**
 * 统一 AI 客户端：按用途路由到配置的不同模型，带超时与指数退避重试。
 *
 * 密钥由调用方注入（从 Electron safeStorage 解密），客户端本身不存储任何凭据。
 */

import type {
  AiConfiguration,
  ChatRequest,
  ChatResponse,
  ConnectivityResult,
  EmbedRequest,
  EmbedResponse,
  ModelConfig,
  ModelPurpose,
} from './types.js';
import { estimateTokens } from '../assembly/assembler.js';
import { embeddingProviderFor, providerFor } from './providers.js';

export interface AiClientOptions {
  config: AiConfiguration;
  /** credentialId → 明文密钥 */
  resolveKey: (credentialId: string) => string;
}

export class AiClient {
  constructor(private readonly options: AiClientOptions) {}

  resolveFor(purpose: ModelPurpose): ModelConfig {
    const config = this.options.config;
    const id = config.defaults[purpose];
    const model = id ? config.models.find((item) => item.id === id) : undefined;
    if (!model || !model.enabled) {
      throw new Error(`用途 ${purpose} 未配置可用模型，请在设置页指定`);
    }
    return model;
  }

  listModels(): ModelConfig[] {
    return this.options.config.models;
  }

  async chat(purpose: ModelPurpose, request: Omit<ChatRequest, 'modelId'>): Promise<ChatResponse> {
    const model = this.resolveFor(purpose);
    return this.chatWithModel(model, { ...request, modelId: model.id });
  }

  async chatWithModel(model: ModelConfig, request: ChatRequest): Promise<ChatResponse> {
    const provider = providerFor(model);
    const apiKey = this.options.resolveKey(model.credentialId);
    const streaming = typeof request.onToken === 'function';
    // 流式输出一旦失败，前面已推送的 token 无法撤回；重试会造成正文重复。
    // 因此流式请求只做超时与取消，不自动重试；非流式请求才启用指数退避重试。
    const maxRetries = streaming ? 0 : this.options.config.maxRetries;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const external = request.signal;
      const onExternalAbort = (): void => controller.abort(external?.reason);
      if (external?.aborted) onExternalAbort();
      else external?.addEventListener('abort', onExternalAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(`模型请求超时（${this.options.config.requestTimeoutMs}ms）`)),
        this.options.config.requestTimeoutMs,
      );
      try {
        return await provider.chat({ ...request, signal: controller.signal }, model, apiKey);
      } catch (error) {
        lastError = error;
        // 取消和超时都不重试：作者主动取消必须立即停，超时重试容易重复扣费
        if (controller.signal.aborted) throw error;
        if (attempt === maxRetries) break;
        const delay = this.options.config.retryBaseDelayMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onExternalAbort);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async embed(purpose: 'embedding', request: Omit<EmbedRequest, 'modelId'>): Promise<EmbedResponse> {
    const model = this.resolveFor(purpose);
    const provider = embeddingProviderFor(model);
    const apiKey = this.options.resolveKey(model.credentialId);
    const controller = new AbortController();
    const external = request.signal;
    const onExternalAbort = (): void => controller.abort(external?.reason);
    if (external?.aborted) onExternalAbort();
    else external?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error(`Embedding 请求超时（${this.options.config.requestTimeoutMs}ms）`)),
      this.options.config.requestTimeoutMs,
    );
    try {
      return await provider.embed({ ...request, modelId: model.id, signal: controller.signal }, model, apiKey);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  async connectivity(model: ModelConfig): Promise<ConnectivityResult> {
    // 走和 chat 同一套路由，保证 Ollama 用的是原生端点探测
    const provider = providerFor(model);
    const apiKey = this.options.resolveKey(model.credentialId);
    try {
      return await provider.connectivity(model, apiKey);
    } catch (error) {
      return {
        ok: false,
        latencyMs: 0,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 与装配层共用同一套估算函数，避免两处口径漂移 */
  estimateTokens(text: string): number {
    return estimateTokens(text);
  }
}
