<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { WorkbenchData } from '../../shared/ipc-contract.js';
import { t } from '../i18n/index.js';

const props = defineProps<{ workbench: WorkbenchData }>();
const emit = defineEmits<{ flash: [message: string]; refresh: [] }>();

const bookOutline = ref(props.workbench.book.outline);
const volumeDrafts = reactive<Record<string, string>>(
  Object.fromEntries(props.workbench.volumes.map((volume) => [volume.id, volume.outline])),
);
const newVolumeTitle = ref('');
const newVolumeOutline = ref('');
const busy = ref(false);

async function saveBookOutline(): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.updateBook({ bookId: props.workbench.book.id, outline: bookOutline.value });
    if (!res.ok) throw new Error(res.error ?? t('保存总纲失败'));
    emit('flash', t('作品总纲已保存'));
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function saveVolume(id: string): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.updateVolume({ volumeId: id, outline: volumeDrafts[id] ?? '' });
    if (!res.ok) throw new Error(res.error ?? t('保存卷纲失败'));
    emit('flash', t('卷纲已保存'));
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function createVolume(): Promise<void> {
  if (!newVolumeTitle.value.trim()) return emit('flash', t('卷名不能为空'));
  busy.value = true;
  try {
    const res = await window.api.createVolume({
      bookId: props.workbench.book.id,
      title: newVolumeTitle.value.trim(),
      outline: newVolumeOutline.value,
    });
    if (!res.ok) throw new Error(res.error ?? t('创建卷失败'));
    newVolumeTitle.value = '';
    newVolumeOutline.value = '';
    emit('flash', t('卷已创建'));
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function deleteVolume(id: string, title: string): Promise<void> {
  if (!window.confirm(t('删除卷「{title}」？卷内章节不会删除，只会变为未归卷。', { title }))) return;
  const res = await window.api.deleteVolume({ volumeId: id });
  if (!res.ok) return emit('flash', res.error ?? t('删除卷失败'));
  emit('flash', t('卷已删除'));
  emit('refresh');
}
</script>

<template>
  <div class="panel">
    <section class="card block">
      <div class="block-head">
        <h3>{{ t('作品总纲') }}</h3>
        <button class="primary" :disabled="busy" @click="saveBookOutline">{{ t('保存总纲') }}</button>
      </div>
      <p class="hint">{{ t('总纲是写前事实，AI 写作会把它与卷纲、章纲一起注入；AI 大纲建议可在作品设置中生成后回填。') }}</p>
      <textarea v-model="bookOutline" rows="10" :placeholder="t('主线、核心冲突、卷结构、结局方向…')"></textarea>
    </section>

    <section class="card block">
      <div class="block-head"><h3>{{ t('卷纲') }}</h3></div>
      <div class="volume-list">
        <div v-for="volume in workbench.volumes" :key="volume.id" class="volume-item">
          <div class="volume-head">
            <strong>{{ t('第 {n} 卷 · {title}', { n: volume.ordinal, title: volume.title }) }}</strong>
            <div>
              <button :disabled="busy" @click="saveVolume(volume.id)">{{ t('保存卷纲') }}</button>
              <button class="danger" @click="deleteVolume(volume.id, volume.title)">{{ t('删除卷') }}</button>
            </div>
          </div>
          <textarea v-model="volumeDrafts[volume.id]" rows="4" :placeholder="t('本卷目标、关键转折、卷末钩子…')"></textarea>
        </div>
        <div v-if="workbench.volumes.length === 0" class="empty">{{ t('还没有卷') }}</div>
      </div>
      <div class="new-volume">
        <input v-model="newVolumeTitle" :placeholder="t('新卷名')" />
        <textarea v-model="newVolumeOutline" rows="2" :placeholder="t('卷纲（可选）')"></textarea>
        <button class="primary" :disabled="busy" @click="createVolume">{{ t('+ 新建卷') }}</button>
      </div>
    </section>

    <section class="card block">
      <div class="block-head"><h3>{{ t('定稿收据') }}</h3></div>
      <p class="hint">{{ t('每次定稿生成不可变收据；正文被替换后旧收据标记 superseded，绑定它的派生状态会标 stale。') }}</p>
      <div class="receipt-list">
        <div v-for="receipt in workbench.receipts" :key="receipt.id" class="receipt-row">
          <span class="badge info">{{ t('第 {n} 章', { n: receipt.chapterOrdinal }) }}</span>
          <span class="hash">{{ receipt.contentHash.slice(0, 12) }}…</span>
          <span class="time">{{ new Date(receipt.finalizedAt).toLocaleString('zh-CN') }}</span>
          <span v-if="receipt.supersededBy" class="badge muted">{{ t('已被替换') }}</span>
          <span v-else class="badge success">{{ t('当前有效') }}</span>
        </div>
        <div v-if="workbench.receipts.length === 0" class="empty">{{ t('还没有定稿收据') }}</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 14px; }
.block { padding: 16px 18px; }
.block-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.block-head h3 { margin: 0; font-size: 14px; }
.hint { margin: 0 0 10px; font-size: 11px; color: var(--text-muted); line-height: 1.6; }
textarea { width: 100%; resize: vertical; line-height: 1.8; }
.volume-list { display: flex; flex-direction: column; gap: 10px; }
.volume-item { border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
.volume-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px; }
.volume-head button { padding: 4px 8px; margin-left: 6px; }
.new-volume { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
.new-volume input, .new-volume textarea { width: 100%; }
.new-volume button { align-self: flex-end; }
.empty { padding: 20px; text-align: center; color: var(--text-muted); font-size: 12px; }
.receipt-list { display: flex; flex-direction: column; gap: 6px; }
.receipt-row { display: flex; align-items: center; gap: 10px; font-size: 11px; padding: 6px 0; border-bottom: 1px solid var(--border); }
.receipt-row:last-child { border-bottom: none; }
.hash { font-family: ui-monospace, SFMono-Regular, monospace; color: var(--text-muted); }
.time { color: var(--text-muted); margin-left: auto; }
</style>
