<script setup lang="ts">
import { ref } from 'vue';
import type { Chapter, Volume } from '../../shared/ipc-contract.js';
import { t } from '../i18n/index.js';

const props = defineProps<{
  chapter: Chapter;
  volumes: Volume[];
}>();

const emit = defineEmits<{
  close: [];
  saved: [];
  deleted: [];
  flash: [message: string];
}>();

const title = ref(props.chapter.title);
const volumeId = ref<string | null>(props.chapter.volumeId);
const outline = ref(props.chapter.outline);
const busy = ref(false);

async function save(): Promise<void> {
  if (!title.value.trim()) return emit('flash', t('章节标题不能为空'));
  busy.value = true;
  try {
    const res = await window.api.updateChapterSpec({
      chapterId: props.chapter.id,
      spec: {
        title: title.value.trim(),
        volumeId: volumeId.value,
        outline: outline.value,
      },
    });
    if (!res.ok) throw new Error(res.error ?? t('保存章节设置失败'));
    emit('flash', t('章节设置已保存'));
    emit('saved');
    emit('close');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  const confirmed = window.confirm(
    t('⚠ 即将删除《{title}》（第 {n} 章）。\n正文、门禁记录与该章的检索索引都会一并删除，且不可恢复（快照中的事实不受影响）。是否继续？', {
      title: props.chapter.title,
      n: props.chapter.ordinal,
    }),
  );
  if (!confirmed) return;
  busy.value = true;
  try {
    const res = await window.api.deleteChapter({ chapterId: props.chapter.id });
    if (!res.ok) throw new Error(res.error ?? t('删除章节失败'));
    emit('flash', t('章节已删除'));
    emit('deleted');
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
    <div class="modal">
      <h3>{{ t('章节设置') }}</h3>
      <div class="field">
        <label>{{ t('章节标题') }}</label>
        <input v-model="title" :placeholder="t('章节标题')" @keyup.enter="save" />
      </div>
      <div class="field">
        <label>{{ t('所属卷') }}</label>
        <select v-model="volumeId">
          <option :value="null">{{ t('未归卷') }}</option>
          <option v-for="volume in volumes" :key="volume.id" :value="volume.id">
            {{ t('第 {n} 卷 · {title}', { n: volume.ordinal, title: volume.title }) }}
          </option>
        </select>
      </div>
      <div class="field">
        <label>{{ t('章纲') }}</label>
        <textarea v-model="outline" rows="6" :placeholder="t('本章要写什么：出场人物、事件推进、伏笔动作、收尾钩子…')" />
      </div>
      <p class="hint">
        {{ t('目标字数、Strand、钩子类型与章纲声明（出场角色／情绪标签）在「正文与章纲」页调整。') }}
      </p>
      <div class="modal-actions">
        <button class="danger" :disabled="busy" @click="remove">{{ t('删除本章') }}</button>
        <span class="spacer" />
        <button @click="emit('close')">{{ t('取消') }}</button>
        <button class="primary" :disabled="busy" @click="save">{{ t('保存') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop { position: fixed; inset: 0; background: rgba(16,24,40,.45); display: flex; align-items: center; justify-content: center; z-index: 120; }
.modal { background: #fff; border-radius: 10px; padding: 24px; width: 520px; box-shadow: 0 20px 40px rgba(0,0,0,.18); }
.modal h3 { margin: 0 0 18px; font-size: 16px; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.field input, .field select, .field textarea { width: 100%; }
.hint { font-size: 11px; color: var(--text-muted); line-height: 1.7; margin: 0 0 16px; }
.modal-actions { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }
</style>
