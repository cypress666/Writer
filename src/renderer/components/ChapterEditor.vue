<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  AiStreamEvent,
  Chapter,
  Character,
  ChapterTask,
  DiffResult,
  Foreshadow,
  HookType,
  Strand,
} from '../../shared/ipc-contract.js';
import { t } from '../i18n/index.js';

const props = defineProps<{
  chapter: Chapter;
  characters: Character[];
  foreshadows: Foreshadow[];
  chapterTasks: ChapterTask[];
}>();

const emit = defineEmits<{
  /** 回传最新正文，父组件据此更新缓存，避免重新拉取造成光标跳动 */
  saved: [content: string];
  /** 未保存状态变化，父组件据此在切章/返回时拦截 */
  dirty: [value: boolean];
  flash: [message: string];
}>();

const content = ref(props.chapter.content ?? '');
/** 与数据库中的正文比较，用于「未保存」提示与关章拦截 */
const dirty = computed(() => content.value !== (props.chapter.content ?? ''));
watch(dirty, (value) => emit('dirty', value), { immediate: true });
const targetWords = ref(props.chapter.targetWords ?? 3000);
const strand = ref<Strand | null>(props.chapter.strand);
const hookType = ref<HookType | null>(props.chapter.hookType);
const emotionTags = ref([...props.chapter.emotionTags]);
const declaredCharacters = ref([...props.chapter.declaredCharacters]);
const newTag = ref('');
const saving = ref(false);

// AI 起草：流式预览 → 段落差分 → 作者逐段裁决
const guidance = ref('');
const aiWorking = ref(false);
const aiStage = ref<'idle' | 'streaming' | 'review' | 'error' | 'canceled'>('idle');
const aiStatus = ref('');
const streamingText = ref('');
const generated = ref('');
const diff = ref<DiffResult | null>(null);
const accepted = ref<Set<number>>(new Set());
const showReview = ref(false);
const aiModelName = ref('');
const usage = ref({ promptTokens: 0, tokens: 0 });
let unsubscribeAi: (() => void) | null = null;

watch(
  () => props.chapter.id,
  () => {
    content.value = props.chapter.content ?? '';
    targetWords.value = props.chapter.targetWords ?? 3000;
    strand.value = props.chapter.strand;
    hookType.value = props.chapter.hookType;
    emotionTags.value = [...props.chapter.emotionTags];
    declaredCharacters.value = [...props.chapter.declaredCharacters];
    guidance.value = '';
    streamingText.value = '';
    generated.value = '';
    diff.value = null;
    showReview.value = false;
    aiStage.value = 'idle';
    aiStatus.value = '';
    accepted.value = new Set();
    emit('dirty', false);
  },
);

const charCount = computed(() => {
  const han = (content.value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (content.value.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  return han + latin;
});

async function persist(status?: Chapter['status']): Promise<Chapter> {
  const res = await window.api.saveChapter({
    chapterId: props.chapter.id,
    content: content.value,
    status,
    spec: {
      declaredCharacters: declaredCharacters.value,
      declaredLocations: props.chapter.declaredLocations,
      declaredForeshadows: props.chapter.declaredForeshadows,
      emotionTags: emotionTags.value,
      hookType: hookType.value,
      strand: strand.value,
      targetWords: targetWords.value,
    },
  });
  if (!res.ok || !res.data) throw new Error(res.error ?? t('保存失败'));
  return res.data;
}

async function save(status?: Chapter['status']): Promise<void> {
  saving.value = true;
  try {
    await persist(status);
    emit('flash', status === 'final' ? t('已定稿') : t('已保存'));
    emit('saved', content.value);
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}

function handleAiEvent(event: AiStreamEvent): void {
  if (event.chapterId !== props.chapter.id) return;
  if (event.phase === 'start') {
    aiWorking.value = true;
    aiStage.value = 'streaming';
    streamingText.value = '';
    aiStatus.value = t('{model} 正在生成…', { model: event.model });
  } else if (event.phase === 'token') {
    streamingText.value += event.token;
  } else if (event.phase === 'done') {
    aiStatus.value = t('生成完成，输出 {n} token；正在计算段落差分…', { n: event.tokens });
  } else if (event.phase === 'error') {
    aiWorking.value = false;
    aiStage.value = 'error';
    aiStatus.value = t('生成失败：{msg}', { msg: event.message });
  } else {
    aiWorking.value = false;
    aiStage.value = 'canceled';
    aiStatus.value = t('已取消生成');
  }
}

async function generate(): Promise<void> {
  if (aiWorking.value || saving.value) return;
  aiWorking.value = true;
  aiStage.value = 'streaming';
  streamingText.value = '';
  aiStatus.value = t('正在保存章纲并装配事实切片…');
  try {
    // 先落盘章纲声明，保证 AI 读到的是作者当前确认的切片
    await persist();
    const res = await window.api.generateWriting({
      chapterId: props.chapter.id,
      authorGuidance: guidance.value.trim() || undefined,
    });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('生成失败'));
    generated.value = res.data.content;
    aiModelName.value = res.data.model;
    usage.value = { promptTokens: res.data.promptTokens, tokens: res.data.tokens };

    const diffRes = await window.api.previewWritingDiff({
      chapterId: props.chapter.id,
      revised: generated.value,
    });
    if (!diffRes.ok || !diffRes.data) throw new Error(diffRes.error ?? t('差分计算失败'));
    diff.value = diffRes.data;
    // 默认接受 AI 的替换与新增，作者可逐条取消；删除默认拒绝，避免误删手写段落
    accepted.value = new Set(
      diffRes.data.changes
        .map((change, index) => (change.op === 'replace' || change.op === 'add' ? index : -1))
        .filter((index) => index >= 0),
    );
    showReview.value = true;
    aiStage.value = 'review';
    aiStatus.value = t('请逐段裁决');
  } catch (error) {
    aiStage.value = 'error';
    aiStatus.value = error instanceof Error ? error.message : String(error);
    emit('flash', aiStatus.value);
  } finally {
    aiWorking.value = false;
  }
}

async function cancelGeneration(): Promise<void> {
  await window.api.cancelWriting();
  aiWorking.value = false;
  aiStage.value = 'canceled';
  aiStatus.value = '已取消生成';
}

function toggle(index: number): void {
  const next = new Set(accepted.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  accepted.value = next;
}

async function applyReview(): Promise<void> {
  if (!diff.value || !generated.value) return;
  try {
    const res = await window.api.applyWritingDiff({
      chapterId: props.chapter.id,
      revised: generated.value,
      acceptedIndices: [...accepted.value],
    });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('应用裁决失败'));
    content.value = res.data.content ?? '';
    showReview.value = false;
    diff.value = null;
    streamingText.value = '';
    aiStage.value = 'idle';
    aiStatus.value = '';
    emit('flash', t('已按逐段裁决写入正文'));
    emit('saved', content.value);
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  }
}

function changeLabel(op: string): string {
  return t({ keep: '保留', replace: '替换', add: '新增', remove: '删除' }[op] ?? op);
}

function handleShortcut(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!saving.value) void save();
  }
}

onMounted(() => {
  unsubscribeAi = window.api.onAiEvent(handleAiEvent);
  window.addEventListener('keydown', handleShortcut);
});
onUnmounted(() => {
  unsubscribeAi?.();
  window.removeEventListener('keydown', handleShortcut);
  if (aiWorking.value) void window.api.cancelWriting();
});

async function exportCurrent(): Promise<void> {
  const res = await window.api.exportMarkdown({ bookId: props.chapter.bookId, chapterId: props.chapter.id });
  if (!res.ok || !res.data) return emit('flash', res.error ?? t('导出本章 Markdown 失败'));
  emit('flash', t('已导出本章：{path}', { path: res.data.files[0] ?? res.data.directory }));
}

function addTag(): void {
  const tag = newTag.value.trim();
  if (tag && !emotionTags.value.includes(tag)) emotionTags.value.push(tag);
  newTag.value = '';
}

function indentTab(event: KeyboardEvent): void {
  const el = event.target as HTMLTextAreaElement;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  content.value = content.value.slice(0, start) + '　　' + content.value.slice(end);
  requestAnimationFrame(() => {
    el.selectionStart = el.selectionEnd = start + 2;
  });
}
</script>

<template>
  <div class="editor-layout">
    <section class="editor-main card">
      <div class="editor-toolbar">
        <span class="count" :class="{ warn: charCount < targetWords * 0.9 }">
          {{ t('{a} / {b} 字', { a: charCount, b: targetWords }) }}
        </span>
        <span v-if="dirty" class="badge warning">{{ t('未保存') }}</span>
        <span class="shortcut-hint">{{ t('Ctrl / ⌘ + S 保存') }}</span>
        <div class="toolbar-actions">
          <button @click="exportCurrent">{{ t('导出本章 MD') }}</button>
          <button :disabled="saving" @click="save()">{{ t('保存草稿') }}</button>
          <button class="primary" :disabled="saving" @click="save('final')">{{ t('定稿') }}</button>
        </div>
      </div>
      <textarea
        v-model="content"
        class="content-input"
        :placeholder="t('在此撰写本章正文…\n\nTab 插入两个全角空格作为段首缩进。')"
        spellcheck="false"
        @keydown.tab.prevent="indentTab"
      ></textarea>
    </section>

    <aside class="editor-side">
      <div class="card side-card ai-card">
        <h4>{{ t('AI 起草') }}</h4>
        <textarea v-model="guidance" rows="2" :placeholder="t('额外指导（可选）：本章重点、叙事口吻…')" ></textarea>
        <div class="ai-actions">
          <button class="primary" :disabled="aiWorking || saving" @click="generate">{{ t('生成新稿') }}</button>
          <button v-if="aiWorking" @click="cancelGeneration">{{ t('取消') }}</button>
        </div>
        <div v-if="aiStatus" class="ai-status">{{ aiStatus }}</div>
      </div>

      <div v-if="chapterTasks.length > 0" class="card side-card">
        <h4>{{ t('本章线索任务') }}</h4>
        <div v-for="task in chapterTasks" :key="task.foreshadowId" class="task-item">
          <div class="task-head">
            <span class="badge" :class="task.source === 'overdue' ? 'error' : task.source === 'due' ? 'warning' : 'info'">
              {{ t(task.source === 'overdue' ? '逾期' : task.source === 'due' ? '到期' : '指派') }}
            </span>
            <strong>{{ task.title }}</strong>
          </div>
          <div class="task-meta">{{ t(task.action === 'resolve' ? '需回收' : '需推进') }} · {{ t('证据词：{markers}', { markers: task.markers.join(' / ') || t('未定义') }) }}</div>
        </div>
      </div>

      <div class="card side-card">
        <h4>{{ t('章纲声明') }}</h4>
        <label>{{ t('目标字数') }}</label>
        <input v-model.number="targetWords" type="number" min="100" step="100" />

        <label>{{ t('Strand 节奏') }}</label>
        <select v-model="strand">
          <option :value="null">{{ t('未标注') }}</option>
          <option value="quest">{{ t('主线 Quest') }}</option>
          <option value="fire">{{ t('感情线 Fire') }}</option>
          <option value="constellation">{{ t('世界观 Constellation') }}</option>
        </select>

        <label>{{ t('钩子类型') }}</label>
        <select v-model="hookType">
          <option :value="null">{{ t('未标注') }}</option>
          <option value="cliffhanger">{{ t('悬念断崖') }}</option>
          <option value="revelation">{{ t('揭示') }}</option>
          <option value="conflict">{{ t('冲突') }}</option>
          <option value="emotional">{{ t('情绪') }}</option>
          <option value="question">{{ t('疑问') }}</option>
          <option value="none">{{ t('无钩子') }}</option>
        </select>

        <label>{{ t('出场角色') }}</label>
        <div class="checkbox-group">
          <label v-for="c in characters" :key="c.id" class="checkbox-item">
            <input type="checkbox" :value="c.id" v-model="declaredCharacters" />
            {{ c.name }}
          </label>
          <div v-if="characters.length === 0" class="hint">{{ t('先在「事实源」页添加角色') }}</div>
        </div>

        <label>{{ t('情绪标签') }}</label>
        <div class="tag-row">
          <span v-for="tag in emotionTags" :key="tag" class="badge info tag">
            {{ tag }}
            <button class="tag-remove" @click="emotionTags = emotionTags.filter((t) => t !== tag)">×</button>
          </span>
        </div>
        <div class="tag-input-row">
          <input v-model="newTag" :placeholder="t('添加标签')" @keyup.enter="addTag" />
          <button @click="addTag">+</button>
        </div>
      </div>
    </aside>
  </div>

  <div v-if="aiWorking && aiStage === 'streaming'" class="modal-backdrop" @click.self="cancelGeneration">
    <div class="review-modal">
      <h3>{{ t('AI 正在起草') }}</h3>
      <div class="stream-preview">{{ streamingText || t('等待模型输出…') }}</div>
      <div class="modal-actions">
        <button @click="cancelGeneration">{{ t('取消生成') }}</button>
      </div>
    </div>
  </div>

  <div v-if="showReview && diff" class="modal-backdrop" @click.self="showReview = false">
    <div class="review-modal wide">
      <h3>{{ t('逐段裁决 AI 新稿') }}</h3>
      <div class="diff-stats">
        <span class="badge muted">{{ t('保留 {n}', { n: diff.stats.kept }) }}</span>
        <span class="badge info">{{ t('替换 {n}', { n: diff.stats.replaced }) }}</span>
        <span class="badge warning">{{ t('新增 {n}', { n: diff.stats.added }) }}</span>
        <span class="badge error">{{ t('删除 {n}', { n: diff.stats.removed }) }}</span>
        <span class="usage">{{ t('{model} · prompt {p} / 输出 {c} token', { model: aiModelName, p: usage.promptTokens, c: usage.tokens }) }}</span>
      </div>
      <p class="review-note">{{ t('勾选表示接受 AI 改动；未勾选则保留原稿。删除类改动默认不勾选，防止误删手写段落。') }}</p>
      <div class="review-scroll">
        <div v-for="(change, index) in diff.changes" :key="index" class="change-row" :class="change.op">
          <div class="change-head">
            <label class="decision">
              <input
                type="checkbox"
                :checked="accepted.has(index)"
                :disabled="change.op === 'keep'"
                @change="toggle(index)"
              />
              {{ t(change.op === 'keep' ? '原样保留' : '接受改动') }}
            </label>
            <span class="badge" :class="change.op === 'keep' ? 'muted' : change.op === 'add' ? 'info' : change.op === 'remove' ? 'error' : 'warning'">
              {{ changeLabel(change.op) }}
            </span>
          </div>
          <div v-if="change.original" class="paragraph original"><span>{{ t('原文') }}</span>{{ change.original }}</div>
          <div v-if="change.revised && change.op !== 'keep'" class="paragraph revised"><span>{{ t('新稿') }}</span>{{ change.revised }}</div>
        </div>
      </div>
      <div class="modal-actions">
        <button @click="showReview = false">{{ t('暂不应用') }}</button>
        <button class="primary" @click="applyReview">{{ t('应用裁决到正文') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-layout { display: flex; gap: 16px; flex: 1; min-height: 0; }
.editor-main { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.editor-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.count { font-size: 12px; color: var(--text-muted); }
.count.warn { color: var(--warning); }
.shortcut-hint { font-size: 11px; color: var(--text-muted); opacity: .75; }
.toolbar-actions { display: flex; gap: 6px; }
.content-input {
  flex: 1; border: none; border-radius: 0; resize: none; padding: 20px 24px;
  font-size: 15px; line-height: 2; outline: none; box-shadow: none;
}
.content-input:focus { box-shadow: none; border: none; }
.editor-side { width: 288px; flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.side-card { padding: 14px; }
.side-card h4 { margin: 0 0 12px; font-size: 13px; }
.side-card label { display: block; font-size: 12px; color: var(--text-muted); margin: 10px 0 5px; }
.side-card input[type='number'], .side-card select, .side-card input:not([type]) { width: 100%; }
.checkbox-group { max-height: 130px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 6px; }
.checkbox-item { display: flex; align-items: center; gap: 6px; margin: 0 !important; color: var(--text) !important; font-size: 12px !important; }
.checkbox-item input { width: auto; }
.hint { font-size: 11px; color: var(--text-muted); padding: 6px; }
.tag-row { display: flex; flex-wrap: wrap; gap: 4px; }
.tag { display: inline-flex; align-items: center; gap: 3px; }
.tag-remove { border: none; background: none; padding: 0 2px; color: inherit; font-size: 14px; }
.tag-input-row { display: flex; gap: 4px; margin-top: 6px; }
.tag-input-row input { flex: 1; }
.task-item { padding: 8px 0; border-bottom: 1px solid var(--border); }
.task-item:last-child { border-bottom: none; }
.task-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.task-meta { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

.ai-card textarea { min-height: 54px; resize: vertical; font-size: 12px; line-height: 1.6; }
.ai-actions { display: flex; gap: 6px; margin-top: 8px; }
.ai-actions button { flex: 1; }
.ai-status { font-size: 11px; color: var(--text-muted); margin-top: 8px; line-height: 1.5; }
.modal-backdrop { position: fixed; inset: 0; background: rgba(16,24,40,.45); display: flex; align-items: center; justify-content: center; z-index: 120; }
.review-modal { background: #fff; border-radius: 10px; padding: 22px; width: 620px; max-height: 84vh; display: flex; flex-direction: column; box-shadow: 0 20px 40px rgba(0,0,0,.18); }
.review-modal.wide { width: 900px; }
.review-modal h3 { margin: 0 0 14px; font-size: 16px; }
.stream-preview { flex: 1; min-height: 220px; max-height: 60vh; overflow-y: auto; white-space: pre-wrap; line-height: 1.9; font-size: 14px; background: #f7f8fa; border-radius: 6px; padding: 14px; }
.diff-stats { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.diff-stats .usage { margin-left: auto; font-size: 11px; color: var(--text-muted); }
.review-note { font-size: 11px; color: var(--text-muted); margin: 10px 0 12px; }
.review-scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
.change-row { border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
.change-row.replace { background: #fffbeb; }
.change-row.add { background: #f0f9ff; }
.change-row.remove { background: #fef2f2; }
.change-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.decision { display: flex; align-items: center; gap: 5px; font-size: 12px; }
.paragraph { font-size: 13px; line-height: 1.8; padding: 6px 0; white-space: pre-wrap; }
.paragraph span { display: inline-block; font-size: 10px; color: var(--text-muted); margin-right: 8px; }
.paragraph.original { color: var(--text-muted); }
.paragraph.revised { color: var(--text); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
