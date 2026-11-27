<script setup lang="ts">
import { ref } from 'vue';
import type { EmbeddingStatus, SearchHit, Volume } from '../../shared/ipc-contract.js';
import { t } from '../i18n/index.js';

const props = defineProps<{
  bookId: string;
  volumes: Volume[];
}>();

const emit = defineEmits<{
  openChapter: [chapterId: string];
  flash: [message: string];
}>();

const query = ref('');
const volumeId = ref<string | null>(null);
const useEmbedding = ref(true);
const hits = ref<SearchHit[]>([]);
const status = ref<EmbeddingStatus | null>(null);
const usedEmbedding = ref(false);
const searching = ref(false);
const indexing = ref(false);
const searched = ref(false);

async function search(): Promise<void> {
  const text = query.value.trim();
  if (!text) return;
  searching.value = true;
  try {
    const res = await window.api.searchChapters({
      bookId: props.bookId,
      query: text,
      volumeId: volumeId.value,
      limit: 30,
      useEmbedding: useEmbedding.value,
    });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('检索失败'));
    hits.value = res.data.hits;
    status.value = res.data.embeddingStatus;
    usedEmbedding.value = res.data.usedEmbedding;
    searched.value = true;
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    searching.value = false;
  }
}

async function buildIndex(): Promise<void> {
  indexing.value = true;
  try {
    const res = await window.api.indexEmbeddings({ bookId: props.bookId });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('重建向量索引失败'));
    const { indexed, failed, skipped, model } = res.data;
    emit('flash', t('向量索引完成：{model} 新索引 {a} 章，跳过 {b} 章，失败 {c} 章', { model, a: indexed, b: skipped, c: failed }));
    await search();
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    indexing.value = false;
  }
}

function scoreLabel(hit: SearchHit): string {
  const parts = [t('综合 {score}', { score: hit.score.toFixed(3) })];
  if (hit.bm25Score !== undefined) parts.push(`BM25 ${hit.bm25Score.toFixed(2)}`);
  if (hit.vectorScore !== undefined) parts.push(t('向量 {score}', { score: hit.vectorScore.toFixed(3) }));
  return parts.join(' · ');
}
</script>

<template>
  <div class="search-panel">
    <div class="search-bar card">
      <input
        v-model="query"
        :placeholder="t('检索正文：人名、地名、道具、情节片段…')"
        @keyup.enter="search"
      />
      <select v-model="volumeId">
        <option :value="null">{{ t('全部卷') }}</option>
        <option v-for="volume in volumes" :key="volume.id" :value="volume.id">
          {{ t('第 {n} 卷', { n: volume.ordinal }) }}
        </option>
      </select>
      <label class="checkbox">
        <input v-model="useEmbedding" type="checkbox" />
        {{ t('向量召回') }}
      </label>
      <button class="primary" :disabled="searching || !query.trim()" @click="search">
        {{ searching ? t('检索中…') : t('检索') }}
      </button>
      <button :disabled="indexing" @click="buildIndex">
        {{ indexing ? t('重建中…') : t('重建向量索引') }}
      </button>
    </div>

    <div v-if="status" class="embedding-status">
      <span class="badge muted">
        {{ t('向量：{a} / {b} 章已索引', { a: status.embeddedChapters, b: status.totalChapters }) }}
      </span>
      <span v-if="status.model" class="badge info">{{ status.model }}</span>
      <span v-else class="badge warning">{{ t('未配置 Embedding 模型，检索退化为 BM25') }}</span>
      <span v-if="searched" class="badge" :class="usedEmbedding ? 'success' : 'muted'">
        {{ usedEmbedding ? t('本次为混合检索') : t('本次为纯 BM25') }}
      </span>
    </div>

    <div class="hit-list">
      <button
        v-for="hit in hits"
        :key="hit.chapterId"
        class="hit card"
        @click="emit('openChapter', hit.chapterId)"
      >
        <div class="hit-head">
          <span class="badge muted">{{ t('第 {n} 章', { n: hit.ordinal }) }}</span>
          <strong>{{ hit.title }}</strong>
          <span class="hit-score">{{ scoreLabel(hit) }}</span>
        </div>
        <div class="hit-snippet">{{ hit.snippet }}</div>
      </button>
      <div v-if="searched && hits.length === 0" class="empty-hint">{{ t('没有匹配的章节') }}</div>
      <div v-if="!searched" class="empty-hint">
        {{ t('输入关键词开始检索。向量召回需要先在「AI 设置」里为') }}
        <code>embedding</code>
        {{ t('用途指定模型。') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-panel { display: flex; flex-direction: column; gap: 12px; flex: 1; min-height: 0; }
.search-bar { display: flex; gap: 8px; align-items: center; padding: 12px; flex-wrap: wrap; }
.search-bar input { flex: 1; min-width: 220px; }
.search-bar select { width: 120px; }
.checkbox { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.checkbox input { width: auto; }
.embedding-status { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.hit-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.hit { text-align: left; border: 1px solid var(--border); background: #fff; border-radius: 8px; padding: 12px 14px; cursor: pointer; }
.hit:hover { border-color: var(--accent); background: var(--accent-soft); }
.hit-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.hit-score { margin-left: auto; font-size: 11px; color: var(--text-muted); }
.hit-snippet { font-size: 12px; color: var(--text-muted); line-height: 1.75; }
.empty-hint { padding: 30px; text-align: center; color: var(--text-muted); font-size: 12px; line-height: 1.8; }
</style>
