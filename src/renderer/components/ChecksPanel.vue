<script setup lang="ts">
import { computed } from 'vue';
import type { GateReport, AuditReport, LlmAuditResult } from '../../shared/ipc-contract.js';
import { t } from '../i18n/index.js';

const props = defineProps<{
  gate: GateReport | null;
  audit: AuditReport | null;
  llmAudit: LlmAuditResult | null;
  llmBusy?: boolean;
}>();

const emit = defineEmits<{ flash: [message: string]; runLlm: [] }>();

const blockers = computed(() =>
  props.gate?.results.flatMap((r) => r.findings.filter((f) => f.blocking)) ?? [],
);
const observations = computed(() =>
  props.gate?.results.flatMap((r) => r.findings.filter((f) => !f.blocking)) ?? [],
);
const auditErrors = computed(() => props.audit?.issues.filter((i) => i.severity === 'error') ?? []);
const auditWarnings = computed(() => props.audit?.issues.filter((i) => i.severity === 'warning') ?? []);
const auditInfos = computed(() => props.audit?.issues.filter((i) => i.severity === 'info') ?? []);
const llmErrors = computed(() => props.llmAudit?.observations.filter((o) => o.severity === 'error') ?? []);
const llmWarnings = computed(() => props.llmAudit?.observations.filter((o) => o.severity === 'warning') ?? []);
const llmInfos = computed(() => props.llmAudit?.observations.filter((o) => o.severity === 'info') ?? []);

const CATEGORY_LABEL: Record<string, string> = {
  ooc: '人物一致性',
  logic: '逻辑合理性',
  style: '文风自然度',
  emotion: '情感弧线',
};

function ruleName(name: string): string {
  const map: Record<string, string> = {
    'word-count': '字数实测',
    'foreshadow-execution': '伏笔执行率',
    'hook-rotation': '钩子轮换',
    'emotion-rhythm': '情绪节奏',
    'strand-rhythm': 'Strand 节奏',
    repetition: '重复用语',
    'ai-trace': 'AI 痕迹',
  };
  return t(map[name] ?? name);
}
</script>

<template>
  <div v-if="!gate && !audit" class="empty-state">
    <div class="icon">🔍</div>
    <h3>{{ t('尚未运行检查') }}</h3>
    <p>{{ t('点击「检查本章」运行确定性门禁与事实源审计。') }}</p>
  </div>

  <div v-else class="checks-layout">
    <section class="check-section card">
      <div class="section-head">
        <h3>{{ t('确定性门禁') }}</h3>
        <span class="badge" :class="gate?.passed ? 'success' : 'error'">
          {{ gate?.passed ? t('通过') : t('{n} 项阻断', { n: blockers.length }) }}
        </span>
        <span v-if="gate" class="duration">{{ gate.durationMs }}ms</span>
      </div>

      <div v-if="blockers.length" class="finding-group">
        <h4 class="group-title error">{{ t('阻断项') }}</h4>
        <div v-for="(item, i) in blockers" :key="i" class="finding blocker">
          <span class="badge error">{{ t('阻断') }}</span>
          <div>
            <div class="finding-rule">{{ ruleName(item.rule) }}</div>
            <div class="finding-message">{{ item.message }}</div>
          </div>
        </div>
      </div>

      <div v-if="observations.length" class="finding-group">
        <h4 class="group-title warning">{{ t('观察项（不阻断，由你裁决）') }}</h4>
        <div v-for="(item, i) in observations" :key="i" class="finding">
          <span class="badge" :class="item.severity">{{ t(item.severity === 'info' ? '提示' : '观察') }}</span>
          <div>
            <div class="finding-rule">{{ ruleName(item.rule) }}</div>
            <div class="finding-message">{{ item.message }}</div>
          </div>
        </div>
      </div>

      <div v-if="!blockers.length && !observations.length" class="all-clear">{{ t('✓ 所有门禁项通过') }}</div>
    </section>

    <section class="check-section card">
      <div class="section-head">
        <h3>{{ t('事实源审计') }}</h3>
        <span class="badge" :class="audit?.passed ? 'success' : 'error'">
          {{ audit?.passed ? t('通过') : t('{n} 项冲突', { n: auditErrors.length }) }}
        </span>
      </div>

      <div v-if="auditErrors.length" class="finding-group">
        <h4 class="group-title error">{{ t('设定冲突（需处理）') }}</h4>
        <div v-for="item in auditErrors" :key="item.id" class="finding blocker">
          <span class="badge error">{{ t('冲突') }}</span>
          <div>
            <div class="finding-rule">{{ item.category }}</div>
            <div class="finding-message">{{ item.message }}</div>
            <div v-if="item.evidence" class="evidence">{{ t('原文：{text}', { text: item.evidence }) }}</div>
            <div v-if="item.suggestion" class="suggestion">{{ t('建议：{text}', { text: item.suggestion }) }}</div>
          </div>
        </div>
      </div>

      <div v-if="auditWarnings.length" class="finding-group">
        <h4 class="group-title warning">{{ t('状态漂移（需确认）') }}</h4>
        <div v-for="item in auditWarnings" :key="item.id" class="finding">
          <span class="badge warning">{{ t('确认') }}</span>
          <div>
            <div class="finding-rule">{{ item.category }}</div>
            <div class="finding-message">{{ item.message }}</div>
            <div v-if="item.evidence" class="evidence">{{ t('原文：{text}', { text: item.evidence }) }}</div>
            <div v-if="item.suggestion" class="suggestion">{{ t('建议：{text}', { text: item.suggestion }) }}</div>
          </div>
        </div>
      </div>

      <div v-if="auditInfos.length" class="finding-group">
        <h4 class="group-title info">{{ t('提示') }}</h4>
        <div v-for="item in auditInfos" :key="item.id" class="finding">
          <span class="badge info">{{ t('提示') }}</span>
          <div>
            <div class="finding-rule">{{ item.category }}</div>
            <div class="finding-message">{{ item.message }}</div>
          </div>
        </div>
      </div>

      <div v-if="!audit?.issues.length" class="all-clear">{{ t('✓ 未发现事实源冲突') }}</div>
    </section>

    <section class="check-section card">
      <div class="section-head">
        <h3>{{ t('AI 判断性审稿') }}</h3>
        <span class="badge muted">{{ t('仅 OOC / 逻辑 / 文风 / 情感弧线') }}</span>
        <button class="primary" :disabled="llmBusy" @click="emit('runLlm')">
          {{ llmBusy ? t('审稿中…') : t('运行 AI 审稿') }}
        </button>
      </div>
      <p class="scope-note">{{ t('字数、伏笔证据词、钩子轮换、重复用语仍由本地脚本判定；AI 结论不参与门禁阻断。') }}</p>

      <template v-if="llmAudit">
        <div v-for="group in [
          { title: t('需处理'), items: llmErrors, cls: 'error' },
          { title: t('建议确认'), items: llmWarnings, cls: 'warning' },
          { title: t('提示'), items: llmInfos, cls: 'info' },
        ]" :key="group.title" class="finding-group">
          <h4 v-if="group.items.length" class="group-title" :class="group.cls">{{ group.title }}</h4>
          <div v-for="(item, i) in group.items" :key="`${group.title}-${i}`" class="finding">
            <span class="badge" :class="item.severity">{{ t(CATEGORY_LABEL[item.category] ?? item.category) }}</span>
            <div>
              <div class="finding-message">{{ item.message }}</div>
              <div v-if="item.paragraphIndex !== null" class="finding-rule">{{ t('第 {n} 段', { n: item.paragraphIndex + 1 }) }}</div>
              <div class="evidence">{{ t('原文：{text}', { text: item.evidence }) }}</div>
              <div v-if="item.suggestion" class="suggestion">{{ t('建议：{text}', { text: item.suggestion }) }}</div>
            </div>
          </div>
        </div>
        <div v-if="!llmAudit.observations.length" class="all-clear">{{ t('✓ AI 未发现判断性问题') }}</div>
        <div class="usage">{{ t('{model} · prompt {p} token · 输出 {c} token', { model: llmAudit.model, p: llmAudit.promptTokens, c: llmAudit.tokens }) }}</div>
      </template>
      <div v-else class="empty-hint">{{ t('尚未运行 AI 审稿。首次使用请先在「AI 设置」中配置 audit 模型。') }}</div>
    </section>
  </div>
</template>

<style scoped>
.checks-layout { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; flex: 1; }
.check-section { padding: 18px 20px; }
.section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.section-head h3 { margin: 0; font-size: 15px; flex: 1; }
.duration { font-size: 11px; color: var(--text-muted); }
.finding-group { margin-bottom: 16px; }
.group-title { font-size: 12px; margin: 0 0 8px; font-weight: 600; }
.group-title.error { color: var(--error); }
.group-title.warning { color: var(--warning); }
.group-title.info { color: var(--info); }
.finding {
  display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 6px; margin-bottom: 6px; background: #fff;
}
.finding.blocker { background: var(--error-soft); border-color: #fecdca; }
.finding-rule { font-size: 11px; color: var(--text-muted); margin-bottom: 3px; }
.finding-message { font-size: 13px; line-height: 1.6; }
.evidence { font-size: 11px; color: var(--text-muted); margin-top: 6px; padding: 4px 8px; background: #f7f8fa; border-radius: 4px; }
.suggestion { font-size: 11px; color: var(--info); margin-top: 5px; }
.all-clear { padding: 24px; text-align: center; color: var(--success); font-size: 13px; }
.scope-note { font-size: 11px; color: var(--text-muted); margin: -6px 0 14px; line-height: 1.6; }
.usage { font-size: 11px; color: var(--text-muted); text-align: right; margin-top: 10px; }
.empty-hint { padding: 18px; text-align: center; color: var(--text-muted); font-size: 12px; }
</style>
