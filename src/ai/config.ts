/** AI 配置持久化。配置文件只存模型元数据与凭据 id，不含任何密钥。 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AiConfiguration, ModelConfig, ModelPurpose } from './types.js';

export const DEFAULT_AI_CONFIG: AiConfiguration = {
  defaults: {},
  models: [],
  requestTimeoutMs: 120_000,
  maxRetries: 2,
  retryBaseDelayMs: 600,
};

export const PURPOSES: ModelPurpose[] = ['writing', 'audit', 'outline', 'embedding'];

export class AiConfigStore {
  constructor(private readonly filePath: string) {}

  load(): AiConfiguration {
    if (!existsSync(this.filePath)) return structuredClone(DEFAULT_AI_CONFIG);
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AiConfiguration>;
      return {
        ...structuredClone(DEFAULT_AI_CONFIG),
        ...parsed,
        defaults: { ...parsed.defaults },
        models: parsed.models ?? [],
      };
    } catch {
      return structuredClone(DEFAULT_AI_CONFIG);
    }
  }

  save(config: AiConfiguration): void {
    // 防御性检查：即使调用方误传了 key 字段也不落盘
    const safeModels = config.models.map(({ id, label, provider, baseUrl, credentialId, model, contextWindow, temperature, maxTokens, enabled }) => ({
      id, label, provider, baseUrl, credentialId, model, contextWindow, temperature, maxTokens, enabled,
    }));
    writeFileSync(
      this.filePath,
      JSON.stringify({ ...config, models: safeModels }, null, 2),
      { mode: 0o600 },
    );
  }

  addOrUpdateModel(model: ModelConfig): AiConfiguration {
    const config = this.load();
    const index = config.models.findIndex((item) => item.id === model.id);
    if (index >= 0) config.models[index] = model;
    else config.models.push(model);
    this.save(config);
    return config;
  }

  setDefault(purpose: ModelPurpose, modelId: string | null): AiConfiguration {
    const config = this.load();
    if (modelId === null) delete config.defaults[purpose];
    else config.defaults[purpose] = modelId;
    this.save(config);
    return config;
  }
}
