<script setup lang="ts">
import { ref } from 'vue';
import type { SnapshotRestorePreview, WorkbenchData } from '../../shared/ipc-contract.js';
import FactsCharacters from './FactsCharacters.vue';
import FactsForeshadows from './FactsForeshadows.vue';
import FactsLore from './FactsLore.vue';
import FactsOutlines from './FactsOutlines.vue';
import FactsExtract from './FactsExtract.vue';
import { t } from '../i18n/index.js';

const props = defineProps<{ workbench: WorkbenchData; chapterId?: string | null }>();
const emit = defineEmits<{ flash: [message: string]; refresh: [] }>();

type SubTab = 'characters' | 'foreshadows' | 'lore' | 'outlines' | 'extract' | 'snapshots';

const subTab = ref<SubTab>('characters');
const showNewSnapshot = ref(false);
const snapshotLabel = ref('');
const busy = ref(false);
const restorePreview = ref<SnapshotRestorePreview | null>(null);
const previewBusy = ref(false);

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'characters', label: '角色' },
  { key: 'foreshadows', label: '伏笔' },
  { key: 'lore', label: '规则·时间线·资源' },
  { key: 'outlines', label: '大纲·分卷·收据' },
  { key: 'extract', label: 'AI 反推' },
  { key: 'snapshots', label: '状态快照' },
];

function forwardFlash(message: string): void {
  emit('flash', message);
}
function forwardRefresh(): void {
  emit('refresh');
}

async function createSnapshot(): Promise<void> {
  const res = await window.api.createSnapshot({
    bookId: props.workbench.book.id,
    label: snapshotLabel.value.trim() || t('第 {n} 章快照', { n: props.workbench.chapters.length }),
    chapterId: props.chapterId ?? props.workbench.chapters.at(-1)?.id ?? null,
  });
  if (!res.ok) return emit('flash', res.error ?? t('创建快照失败'));
  showNewSnapshot.value = false;
  snapshotLabel.value = '';
  emit('flash', t('快照已创建'));
  emit('refresh');
}

async function askRestore(id: string): Promise<void> {
  previewBusy.value = true;
  try {
    const res = await window.api.previewSnapshotRestore({
      snapshotId: id,
      chapterId: props.chapterId ?? props.workbench.chapters.at(-1)?.id ?? null,
    });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('生成回退预览失败'));
    restorePreview.value = res.data;
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    previewBusy.value = false;
  }
}

async function confirmRestore(): Promise<void> {
  const preview = restorePreview.value;
  if (!preview) return;
  const confirmed = window.confirm(
    t('⚠ 此操作只回退结构化事实源状态（角色状态、伏笔、规则等），正文不会改变。\n请人工处理弹窗中列出的冲突段落；已定稿正文需要手动修改并重新定稿。是否继续？'),
  );
  if (!confirmed) return;
  busy.value = true;
  try {
    const res = await window.api.restoreSnapshot({ snapshotId: preview.snapshotId });
    if (!res.ok) throw new Error(res.error ?? t('回退失败'));
    emit('flash', t('已回退，变更 {n} 处；正文未改动', { n: res.data?.changes ?? 0 }));
    restorePreview.value = null;
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

function formatValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value || '—';
  if (Array.isArray(value)) return value.map(formatValue).join('、') || '—';
  return JSON.stringify(value);
}
</script>

<template>
  <div class="facts-layout">
    <nav class="sub-tabs">
      <button
        v-for="tab in SUB_TABS"
        :key="tab.key"
        :class="{ active: subTab === tab.key }"
        @click="subTab = tab.key"
      >
        {{ t(tab.label) }}
      </button>
    </nav>

    <div class="sub-content">
      <FactsCharacters
        v-if="subTab === 'characters'"
        :workbench="workbench"
        :chapter-id="chapterId ?? null"
        @flash="forwardFlash"
        @refresh="forwardRefresh"
      />
      <FactsForeshadows
        v-else-if="subTab === 'foreshadows'"
        :workbench="workbench"
        :chapter-id="chapterId ?? null"
        @flash="forwardFlash"
        @refresh="forwardRefresh"
      />
      <FactsLore
        v-else-if="subTab === 'lore'"
        :workbench="workbench"
        @flash="forwardFlash"
        @refresh="forwardRefresh"
      />
      <FactsOutlines
        v-else-if="subTab === 'outlines'"
        :workbench="workbench"
        @flash="forwardFlash"
        @refresh="forwardRefresh"
      />

      <FactsExtract
        v-else-if="subTab === 'extract'"
        :workbench="workbench"
        @flash="forwardFlash"
        @refresh="forwardRefresh"
      />

      <template v-else>
        <div class="panel-head">
          <h3>{{ t('状态快照（只保存事实，不复制正文）') }}</h3>
          <button class="primary" @click="showNewSnapshot = true">{{ t('+ 创建快照') }}</button>
        </div>
        <div class="snapshot-list">
          <div v-for="s in workbench.snapshots" :key="s.id" class="snapshot-item card">
            <div class="snapshot-info">
              <strong>{{ s.label }}</strong>
              <div class="snapshot-meta">
                {{ new Date(s.createdAt).toLocaleString('zh-CN') }} ·
                {{ t('{a} 角色 · {b} 伏笔 · {c} 规则', { a: s.characterCount, b: s.foreshadowCount, c: s.worldRuleCount }) }}
              </div>
            </div>
            <button class="danger" :disabled="busy || previewBusy" @click="askRestore(s.id)">{{ t('回退到此快照') }}</button>
          </div>
          <div v-if="workbench.snapshots.length === 0" class="muted center" style="padding: 40px">{{ t('还没有快照') }}</div>
        </div>
        <div v-if="showNewSnapshot" class="inline-form card">
          <input v-model="snapshotLabel" :placeholder="t('快照标签（可选）')" @keyup.enter="createSnapshot" />
          <button class="primary" @click="createSnapshot">{{ t('创建') }}</button>
          <button @click="showNewSnapshot = false">{{ t('取消') }}</button>
        </div>
      </template>
    </div>

    <div v-if="restorePreview" class="modal-backdrop" @click.self="restorePreview = null">
      <div class="restore-modal">
        <h3>{{ t('回退预览：{label}', { label: restorePreview.label }) }}</h3>
        <p class="warning-line">{{ t('⚠ 只回退事实源状态，正文不会改变。请人工核对下列冲突段落。') }}</p>
        <div class="restore-section">
          <h4>{{ t('字段级状态差异（{n}）', { n: restorePreview.changes.length }) }}</h4>
          <div class="diff-list">
            <div v-for="(change, i) in restorePreview.changes" :key="i" class="diff-row">
              <span class="badge muted">{{ change.entity }}.{{ change.field }}</span>
              <span>{{ formatValue(change.before) }} → <strong>{{ formatValue(change.after) }}</strong></span>
            </div>
            <div v-if="!restorePreview.changes.length" class="muted">{{ t('无状态差异') }}</div>
          </div>
        </div>
        <div class="restore-section">
          <h4>{{ t('正文中可能冲突的段落（{n}）', { n: restorePreview.conflictParagraphs.length }) }}</h4>
          <div class="diff-list">
            <div v-for="para in restorePreview.conflictParagraphs" :key="para.paragraphIndex" class="conflict-row">
              <div class="conflict-meta">{{ t('第 {n} 段', { n: para.paragraphIndex + 1 }) }} · {{ para.reason }}</div>
              <div>{{ para.text }}</div>
            </div>
            <div v-if="!restorePreview.conflictParagraphs.length" class="muted">{{ t('未发现明显冲突段落') }}</div>
          </div>
        </div>
        <div class="modal-actions">
          <button @click="restorePreview = null">{{ t('取消') }}</button>
          <button class="danger" :disabled="busy" @click="confirmRestore">{{ t('确认只回退状态') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.facts-layout { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.sub-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; flex-shrink: 0; }
.sub-tabs button { border: none; border-bottom: 2px solid transparent; background: none; border-radius: 0; padding: 8px 14px; color: var(--text-muted); }
.sub-tabs button:hover { background: none; color: var(--accent); }
.sub-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.sub-content { flex: 1; overflow-y: auto; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.panel-head h3 { margin: 0; font-size: 14px; }
.muted { color: var(--text-muted); }
.center { text-align: center; padding: 30px; }
.inline-form { display: flex; gap: 8px; padding: 12px; margin-top: 12px; align-items: center; flex-wrap: wrap; }
.inline-form input { flex: 1; min-width: 140px; }
.snapshot-list { display: flex; flex-direction: column; gap: 8px; }
.snapshot-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; }
.snapshot-meta { font-size: 11px; color: var(--text-muted); margin-top: 5px; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(16,24,40,.45); display: flex; align-items: center; justify-content: center; z-index: 120; }
.restore-modal { background: #fff; border-radius: 10px; padding: 22px; width: 720px; max-height: 84vh; display: flex; flex-direction: column; box-shadow: 0 20px 40px rgba(0,0,0,.18); }
.restore-modal h3 { margin: 0 0 8px; font-size: 16px; }
.warning-line { color: var(--warning); font-size: 12px; margin: 0 0 14px; }
.restore-section { margin-bottom: 14px; min-height: 0; }
.restore-section h4 { margin: 0 0 8px; font-size: 12px; }
.diff-list { max-height: 220px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; font-size: 12px; line-height: 1.7; }
.diff-row { display: flex; gap: 10px; padding: 4px 0; border-bottom: 1px solid var(--border); }
.diff-row:last-child { border-bottom: none; }
.conflict-row { padding: 6px 0; border-bottom: 1px solid var(--border); }
.conflict-row:last-child { border-bottom: none; }
.conflict-meta { font-size: 11px; color: var(--warning); margin-bottom: 3px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
