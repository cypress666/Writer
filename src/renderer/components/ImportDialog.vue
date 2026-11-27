<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { PreviewManuscriptResult, Volume, VaultParseResult } from '../../shared/ipc-contract.js';
import { listSep, t } from '../i18n/index.js';

const props = defineProps<{
  bookId: string;
  volumes: Volume[];
  /** 拖拽导入时由父组件传入的文件路径，打开即自动解析 */
  initialPath?: string | null;
}>();

const emit = defineEmits<{
  close: [];
  imported: [];
  flash: [message: string];
}>();

const fileName = ref('');
const text = ref('');
const preview = ref<PreviewManuscriptResult | null>(null);
const volumeId = ref<string | null>(null);
const busy = ref(false);
/** Obsidian 仓库解析的附加信息，用于提示跳过了哪些目录 */
const vaultInfo = ref<{ fileCount: number; skippedDirs: string[] } | null>(null);

const totalWords = computed(() => preview.value?.totalWords ?? 0);
const PREVIEW_LIMIT = 40;
const visibleChapters = computed(() => preview.value?.chapters.slice(0, PREVIEW_LIMIT) ?? []);

async function pick(): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.pickManuscript();
    if (!res.ok || !res.data) throw new Error(res.error ?? t('选择文件失败'));
    fileName.value = res.data.fileName;
    text.value = res.data.text;
    await doPreview();
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  if (props.initialPath) void importPath(props.initialPath);
});

async function pickVault(): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.pickVault();
    if (!res.ok || !res.data) throw new Error(res.error ?? t('解析仓库失败'));
    applyVault(res.data);
    emit('flash', t('解析到 {n} 章，来自 {f} 个文件', { n: res.data.chapters.length, f: res.data.fileCount }));
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

function applyVault(result: VaultParseResult): void {
  vaultInfo.value = { fileCount: result.fileCount, skippedDirs: result.skippedDirs };
  preview.value = {
    fileName: t('Obsidian 仓库（{n} 个文件）', { n: result.fileCount }),
    chapters: result.chapters,
    totalWords: result.totalWords,
  };
}

async function importPath(filePath: string): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.importPath({ path: filePath });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('解析失败'));
    vaultInfo.value = null;
    fileName.value = res.data.fileName;
    text.value = '';
    preview.value = res.data;
    emit('flash', t('解析到 {n} 章，约 {w} 字', { n: res.data.chapters.length, w: res.data.totalWords }));
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function doPreview(): Promise<void> {
  vaultInfo.value = null;
  const res = await window.api.previewManuscript({ text: text.value, fileName: fileName.value || t('粘贴稿件') });
  if (!res.ok || !res.data) throw new Error(res.error ?? t('解析失败'));
  preview.value = res.data;
}

async function previewPasted(): Promise<void> {
  if (!text.value.trim()) return emit('flash', t('请先粘贴稿件内容'));
  busy.value = true;
  try {
    await doPreview();
    emit('flash', t('解析到 {n} 章', { n: preview.value?.chapters.length ?? 0 }));
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function commit(): Promise<void> {
  if (!preview.value) return;
  const ok = window.confirm(
    t('将导入 {n} 章、约 {w} 字，追加到作品末尾。\n\n不会自动反推角色/伏笔，事实源需后续手工补齐或使用 AI 反推。是否继续？', {
      n: preview.value.chapters.length,
      w: totalWords.value,
    }),
  );
  if (!ok) return;
  busy.value = true;
  try {
    const res = await window.api.commitManuscript({
      bookId: props.bookId,
      fileName: preview.value.fileName,
      chapters: preview.value.chapters,
      volumeId: volumeId.value,
    });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('导入失败'));
    emit('flash', t('已导入 {n} 章（第 {a}–{b} 章）', { n: res.data.created, a: res.data.firstOrdinal, b: res.data.lastOrdinal }));
    emit('imported');
    emit('close');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="dialog">
      <div class="dialog-head">
        <h3>{{ t('导入旧稿') }}</h3>
        <button @click="emit('close')">{{ t('关闭') }}</button>
      </div>
      <p class="hint">
        {{
          t(
            '支持 TXT / Markdown，按「第 N 章」「Chapter N」「# 标题」拆分。导入只追加正文，不覆盖现有章节。',
          )
        }}
      </p>

      <div class="pick-row">
        <button class="primary" :disabled="busy" @click="pick">{{ t('选择文件…') }}</button>
        <button :disabled="busy" @click="pickVault">{{ t('选 Obsidian 仓库…') }}</button>
        <span class="file-name">{{ fileName || t('未选择文件') }}</span>
      </div>
      <p v-if="vaultInfo" class="hint">
        {{
          t('已跳过目录：{dirs}。', {
            dirs: vaultInfo.skippedDirs.length ? vaultInfo.skippedDirs.join(listSep()) : t('无'),
          })
        }}
        {{ t('每个 .md 视为一章；文件内若已有「第 N 章 / # 标题」会继续拆分。') }}
      </p>

      <label>{{ t('或直接粘贴稿件') }}</label>
      <textarea v-model="text" rows="6" :placeholder="t('粘贴整本旧稿…')"></textarea>
      <div class="pick-row">
        <button :disabled="busy || !text.trim()" @click="previewPasted">{{ t('解析粘贴内容') }}</button>
        <select v-model="volumeId" class="volume-select">
          <option :value="null">{{ t('不归入卷') }}</option>
          <option v-for="volume in volumes" :key="volume.id" :value="volume.id">{{ volume.title }}</option>
        </select>
      </div>

      <template v-if="preview">
        <div class="summary">
          <span class="badge info">{{ t('{n} 章', { n: preview.chapters.length }) }}</span>
          <span class="badge muted">{{ t('约 {n} 字', { n: totalWords }) }}</span>
          <span class="file-name">{{ preview.fileName }}</span>
        </div>
        <div v-if="preview.chapters.length > PREVIEW_LIMIT" class="hint">
          {{
            t('仅显示前 {limit} 章，导入时会写入全部 {n} 章。', {
              limit: PREVIEW_LIMIT,
              n: preview.chapters.length,
            })
          }}
        </div>
        <div class="chapter-preview">
          <div v-for="(chapter, index) in visibleChapters" :key="index" class="preview-row">
            <span class="ordinal">{{ index + 1 }}</span>
            <span class="title">{{ chapter.title }}</span>
            <span class="words">{{ t('{n} 字', { n: chapter.wordCount }) }}</span>
          </div>
        </div>
      </template>

      <div class="dialog-actions">
        <div class="spacer"></div>
        <button @click="emit('close')">{{ t('取消') }}</button>
        <button class="primary" :disabled="busy || !preview" @click="commit">{{ t('确认导入') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop { position: fixed; inset: 0; background: rgba(16,24,40,.45); display: flex; align-items: center; justify-content: center; z-index: 120; }
.dialog { background: #fff; border-radius: 10px; padding: 22px; width: 720px; max-height: 88vh; display: flex; flex-direction: column; box-shadow: 0 20px 40px rgba(0,0,0,.18); }
.dialog-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.dialog-head h3 { margin: 0; font-size: 16px; }
.hint { font-size: 11px; color: var(--text-muted); line-height: 1.7; margin: 0 0 12px; }
.pick-row { display: flex; gap: 10px; align-items: center; margin: 10px 0; }
.file-name { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
label { display: block; font-size: 12px; color: var(--text-muted); margin: 10px 0 6px; }
textarea { width: 100%; resize: vertical; line-height: 1.7; }
.volume-select { margin-left: auto; min-width: 200px; }
.summary { display: flex; align-items: center; gap: 8px; margin: 12px 0 8px; }
.chapter-preview { flex: 1; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; min-height: 120px; max-height: 320px; }
.preview-row { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.preview-row:last-child { border-bottom: none; }
.ordinal { color: var(--text-muted); width: 36px; flex-shrink: 0; }
.title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.words { color: var(--text-muted); }
.dialog-actions { display: flex; gap: 8px; margin-top: 14px; align-items: center; }
.spacer { flex: 1; }
</style>
