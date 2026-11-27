/**
 * AI 调用层类型契约。
 *
 * 职责边界（写死，不因后续迭代模糊）：
 * - 本地脚本负责：字数、伏笔执行率、钩子轮换、情绪节奏、Strand 节奏、重复用语、
 *   AI 痕迹规则、已故角色、状态漂移、能力越界、时间线冲突、伏笔矛盾、地点冲突。
 * - LLM 只负责判断性审稿：OOC、逻辑合理性、文风匹配、情感弧线自然度。
 *   LLM 不判定字数、不判定伏笔是否回收（有正文证据词即可脚本判定）、不推断角色状态。
 * - 所有 AI 调用只读 SQLite 结构化事实源。正文只作为语言材料传给 LLM，
 *   不作为状态判断依据——角色位置/能力/已知信息以 facts 为准。
 */

export type ModelPurpose = 'writing' | 'audit' | 'outline' | 'embedding';
export type ProviderKind = 'openai-compatible' | 'anthropic' | 'embedding';

export interface ModelConfig {
  id: string;
  label: string;
  provider: ProviderKind;
  baseUrl: string;
  /** 凭据引用 id，密钥本身不写进配置，也不进 SQLite */
  credentialId: string;
  model: string;
  /** 上下文窗口，用于装配预算 */
  contextWindow: number;
  temperature?: number;
  maxTokens?: number;
  enabled: boolean;
}

export interface AiConfiguration {
  defaults: Partial<Record<ModelPurpose, string>>;
  models: ModelConfig[];
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 流式 token 回调；不提供则一次性返回 */
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface EmbedRequest {
  modelId: string;
  inputs: string[];
  signal?: AbortSignal;
}

export interface EmbedResponse {
  vectors: number[][];
  model: string;
}

export interface ConnectivityResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  modelList?: string[];
}

/** LLM 审计输出的单条判断性观察，必须定位到正文段落 */
export interface LlmObservation {
  category: 'ooc' | 'logic' | 'style' | 'emotion';
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 正文段落序号（从 0 开始），用于逐段定位 */
  paragraphIndex: number | null;
  evidence: string;
  suggestion?: string;
}

export interface LlmAuditResult {
  observations: LlmObservation[];
  model: string;
  tokens: number;
  /** 本次审计 prompt 的 token（实际值或本地估算），用于规模验证 */
  promptTokens: number;
}
