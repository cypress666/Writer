<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { t } from '../i18n/index.js';
import type {
  AiConfiguration,
  CredentialMeta,
  ModelConfig,
  ModelPurpose,
} from '../../shared/ipc-contract.js';

const emit = defineEmits<{ flash: [message: string] }>();

const PURPOSES: Array<{ key: ModelPurpose; label: string }> = [
  { key: 'writing', label: '写作' },
  { key: 'audit', label: 'AI 审稿' },
  { key: 'outline', label: '大纲建议' },
  { key: 'embedding', label: 'Embedding' },
];

const config = ref<AiConfiguration>({
  defaults: {},
  models: [],
  requestTimeoutMs: 120_000,
  maxRetries: 2,
  retryBaseDelayMs: 600,
});
const credentials = ref<CredentialMeta[]>([]);
const encryptionAvailable = ref(true);
const busy = ref(false);
const testingId = ref('');

const form = ref({
  id: '',
  label: '',
  provider: 'openai-compatible' as ModelConfig['provider'],
  baseUrl: '',
  model: '',
  contextWindow: 8192,
  apiKey: '',
  temperature: 0.8,
  maxTokens: 4096,
});

const connectivity = ref<Record<string, string>>({});
const editing = computed(() => Boolean(form.value.id));

async function load(): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.getAiConfig();
    if (!res.ok || !res.data) throw new Error(res.error ?? t('加载 AI 配置失败'));
    config.value = res.data.config;
    credentials.value = res.data.credentials;
    encryptionAvailable.value = res.data.encryptionAvailable;
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

function editModel(model: ModelConfig): void {
  form.value = {
    id: model.id,
    label: model.label,
    provider: model.provider,
    baseUrl: model.baseUrl,
    model: model.model,
    contextWindow: model.contextWindow,
    apiKey: '',
    temperature: model.temperature ?? 0.8,
    maxTokens: model.maxTokens ?? 4096,
  };
}

function resetForm(): void {
  form.value = {
    id: '',
    label: '',
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    contextWindow: 8192,
    apiKey: '',
    temperature: 0.8,
    maxTokens: 4096,
  };
}

async function saveModel(): Promise<void> {
  const f = form.value;
  if (!f.label.trim() || !f.baseUrl.trim() || !f.model.trim()) {
    emit('flash', t('请填写名称、base_url 与模型名'));
    return;
  }
  if (f.apiKey.trim() && !encryptionAvailable.value) {
    emit('flash', t('系统加密不可用，拒绝保存密钥'));
    return;
  }
  const existing = config.value.models.find((item) => item.id === f.id);
  const model: ModelConfig = {
    id: f.id || `model-${Date.now().toString(36)}`,
    label: f.label.trim(),
    provider: f.provider,
    baseUrl: f.baseUrl.trim(),
    credentialId: existing?.credentialId ?? '',
    model: f.model.trim(),
    contextWindow: f.contextWindow,
    temperature: f.temperature,
    maxTokens: f.maxTokens,
    enabled: existing?.enabled ?? true,
  };
  busy.value = true;
  try {
    const res = await window.api.saveAiModel({ model, apiKey: f.apiKey.trim() || undefined });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('保存模型失败'));
    config.value = res.data;
    resetForm();
    await load();
    emit('flash', t('模型已保存，密钥已加密存储'));
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function removeModel(id: string): Promise<void> {
  if (!window.confirm(t('删除该模型？其加密密钥也会一并删除，无法恢复。'))) return;
  const res = await window.api.removeAiModel({ modelId: id });
  if (!res.ok || !res.data) return emit('flash', res.error ?? t('删除模型失败'));
  config.value = res.data;
  if (form.value.id === id) resetForm();
  emit('flash', t('模型已删除'));
}

async function setDefault(purpose: ModelPurpose, modelId: string): Promise<void> {
  const res = await window.api.setAiDefault({ purpose, modelId: modelId || null });
  if (!res.ok || !res.data) return emit('flash', res.error ?? t('设置默认模型失败'));
  config.value = res.data;
}

async function saveRuntime(): Promise<void> {
  const res = await window.api.updateAiRuntime({
    requestTimeoutMs: config.value.requestTimeoutMs,
    maxRetries: config.value.maxRetries,
    retryBaseDelayMs: config.value.retryBaseDelayMs,
  });
  if (!res.ok || !res.data) return emit('flash', res.error ?? t('保存运行参数失败'));
  config.value = res.data;
  emit('flash', t('运行参数已保存'));
}

async function testModel(id: string): Promise<void> {
  testingId.value = id;
  connectivity.value = { ...connectivity.value, [id]: t('测试中…') };
  try {
    const res = await window.api.testAiModel({ modelId: id });
    connectivity.value = {
      ...connectivity.value,
      [id]: res.ok && res.data
        ? `${res.data.ok ? '✓' : '✗'} ${res.data.message} · ${res.data.latencyMs}ms`
        : `✗ ${res.error ?? t('测试失败')}`,
    };
  } finally {
    testingId.value = '';
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="settings-layout">
    <section class="card block">
      <div class="block-head">
        <h3>{{ t('模型配置') }}</h3>
        <span class="badge" :class="encryptionAvailable ? 'success' : 'error'">
          {{ encryptionAvailable ? t('系统加密可用') : t('系统加密不可用（禁止保存密钥）') }}
        </span>
      </div>
      <p class="hint-text">
        {{
          t(
            '支持 OpenAI 兼容端点（Ollama / LM Studio / OpenAI）与 Anthropic Messages。密钥经系统加密后单独存放，配置文件只保存引用 id。',
          )
        }}
      </p>

      <div class="model-list">
        <div v-for="model in config.models" :key="model.id" class="model-row">
          <div class="model-info">
            <strong>{{ model.label }}</strong>
            <div class="model-meta">
              {{ model.provider }} · {{ model.model }} · {{ model.baseUrl }}
              <span v-if="credentials.some((c) => c.id === model.credentialId)" class="badge info">
                {{ t('已配置密钥') }}
              </span>
              <span v-else class="badge muted">{{ t('无密钥') }}</span>
            </div>
            <div v-if="connectivity[model.id]" class="connectivity">{{ connectivity[model.id] }}</div>
          </div>
          <div class="row-actions">
            <button :disabled="testingId === model.id" @click="testModel(model.id)">
              {{ t('测试连接') }}
            </button>
            <button @click="editModel(model)">{{ t('编辑') }}</button>
            <button class="danger" @click="removeModel(model.id)">{{ t('删除') }}</button>
          </div>
        </div>
        <div v-if="config.models.length === 0" class="empty-hint">{{ t('还没有配置模型') }}</div>
      </div>
    </section>

    <section class="card block">
      <h3>{{ editing ? t('编辑模型') : t('新增模型') }}</h3>
      <div class="form-grid">
        <label>{{ t('名称') }}<input v-model="form.label" :placeholder="t('例如：本地 Qwen')" /></label>
        <label>
          {{ t('协议') }}
          <select v-model="form.provider">
            <option value="openai-compatible">{{ t('OpenAI 兼容') }}</option>
            <option value="anthropic">Anthropic Messages</option>
            <option value="embedding">{{ t('Embedding（OpenAI 兼容）') }}</option>
          </select>
        </label>
        <label class="wide">base_url<input v-model="form.baseUrl" placeholder="http://localhost:11434/v1" /></label>
        <label>{{ t('模型名') }}<input v-model="form.model" placeholder="qwen2.5:14b" /></label>
        <label>
          {{ t('上下文窗口') }}
          <input v-model.number="form.contextWindow" type="number" min="1024" step="1024" />
          <small class="field-hint">
            {{ t('本地 Ollama 模型会作为 num_ctx 生效，太小会截断提示词') }}
          </small>
        </label>
        <label>
          {{ t('API Key（留空表示不修改）') }}
          <input v-model="form.apiKey" type="password" autocomplete="new-password" />
        </label>
        <label>Temperature<input v-model.number="form.temperature" type="number" min="0" max="2" step="0.1" /></label>
        <label>
          {{ t('最大输出 token') }}
          <input v-model.number="form.maxTokens" type="number" min="256" step="256" />
        </label>
      </div>
      <div class="form-actions">
        <button class="primary" :disabled="busy" @click="saveModel">
          {{ editing ? t('保存修改') : t('添加模型') }}
        </button>
        <button v-if="editing" @click="resetForm">{{ t('取消编辑') }}</button>
      </div>
    </section>

    <section class="card block">
      <h3>{{ t('用途分配') }}</h3>
      <p class="hint-text">
        {{ t('写作、审稿、大纲、Embedding 可分别指定模型；未指定时对应 AI 功能不可用。') }}
      </p>
      <div class="purpose-grid">
        <label v-for="purpose in PURPOSES" :key="purpose.key">
          {{ t(purpose.label) }}
          <select
            :value="config.defaults[purpose.key] ?? ''"
            @change="setDefault(purpose.key, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('未配置') }}</option>
            <option v-for="m in config.models" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </label>
      </div>
      <div class="purpose-grid compact">
        <label>
          {{ t('超时（ms）') }}
          <input v-model.number="config.requestTimeoutMs" type="number" min="5000" step="5000" />
        </label>
        <label>
          {{ t('非流式重试次数') }}
          <input v-model.number="config.maxRetries" type="number" min="0" max="5" />
        </label>
        <label>
          {{ t('重试间隔基数（ms）') }}
          <input v-model.number="config.retryBaseDelayMs" type="number" min="100" step="100" />
        </label>
      </div>
      <div class="form-actions">
        <button class="primary" @click="saveRuntime">{{ t('保存运行参数') }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-layout { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; flex: 1; padding-right: 4px; }
.block { padding: 18px 20px; }
.block h3 { margin: 0 0 12px; font-size: 15px; }
.block-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.block-head h3 { margin: 0; flex: 1; }
.hint-text { font-size: 12px; color: var(--text-muted); line-height: 1.7; margin: 6px 0 14px; }
.model-list { display: flex; flex-direction: column; gap: 8px; }
.model-row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 6px; }
.model-info { min-width: 0; }
.model-meta { font-size: 11px; color: var(--text-muted); margin-top: 5px; word-break: break-all; }
.connectivity { font-size: 11px; color: var(--info); margin-top: 5px; }
.row-actions { display: flex; gap: 6px; align-items: flex-start; flex-shrink: 0; }
.empty-hint { padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.form-grid label, .purpose-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-muted); }
.form-grid .wide { grid-column: 1 / -1; }
.field-hint { font-size: 11px; color: var(--text-muted); opacity: 0.85; line-height: 1.5; }
.form-actions { display: flex; gap: 8px; margin-top: 14px; }
.purpose-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin-bottom: 16px; }
.purpose-grid.compact { grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid var(--border); padding-top: 14px; }
</style>
