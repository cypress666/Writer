<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Foreshadow, WorkbenchData } from '../../shared/ipc-contract.js';
import { t } from '../i18n/index.js';

const props = defineProps<{ workbench: WorkbenchData; chapterId?: string | null }>();
const emit = defineEmits<{ flash: [message: string]; refresh: [] }>();

const showForm = ref(false);
const editingId = ref<string | null>(null);
const busy = ref(false);
const actionChapterId = ref<string | null>(
  props.chapterId ?? props.workbench.chapters.at(-1)?.id ?? null,
);

const form = ref({
  title: '',
  kind: 'main' as Foreshadow['kind'],
  description: '',
  plantedInChapterId: '' as string,
  plannedResolveOrdinal: null as number | null,
  markers: '',
  status: 'planted' as Foreshadow['status'],
});

const chapterById = computed(() => new Map(props.workbench.chapters.map((chapter) => [chapter.id, chapter])));

function reset(): void {
  showForm.value = false;
  editingId.value = null;
  form.value = {
    title: '',
    kind: 'main',
    description: '',
    plantedInChapterId: actionChapterId.value ?? '',
    plannedResolveOrdinal: null,
    markers: '',
    status: 'planted',
  };
}

function startCreate(): void {
  reset();
  showForm.value = true;
}

function startEdit(foreshadow: Foreshadow): void {
  editingId.value = foreshadow.id;
  showForm.value = true;
  form.value = {
    title: foreshadow.title,
    kind: foreshadow.kind,
    description: foreshadow.description,
    plantedInChapterId: foreshadow.plantedInChapterId ?? '',
    plannedResolveOrdinal: foreshadow.plannedResolveOrdinal,
    markers: foreshadow.resolutionMarkers.join('、'),
    status: foreshadow.status,
  };
}

async function save(): Promise<void> {
  if (!form.value.title.trim()) return emit('flash', t('伏笔标题不能为空'));
  busy.value = true;
  try {
    const markers = form.value.markers.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const payload = {
      title: form.value.title.trim(),
      kind: form.value.kind,
      description: form.value.description,
      plantedInChapterId: form.value.plantedInChapterId || null,
      plannedResolveOrdinal: form.value.plannedResolveOrdinal,
      resolutionMarkers: markers,
      status: form.value.status,
    };
    const res = editingId.value
      ? await window.api.updateForeshadow({ foreshadowId: editingId.value, ...payload })
      : await window.api.createForeshadow({
          bookId: props.workbench.book.id,
          title: payload.title,
          kind: payload.kind,
          description: payload.description,
          plantedInChapterId: payload.plantedInChapterId,
          plannedResolveOrdinal: payload.plannedResolveOrdinal,
          resolutionMarkers: payload.resolutionMarkers,
        });
    if (!res.ok) throw new Error(res.error ?? t('保存伏笔失败'));
    if (editingId.value && form.value.status === 'resolved' && actionChapterId.value) {
      const resolve = await window.api.resolveForeshadow({
        foreshadowId: editingId.value,
        chapterId: actionChapterId.value,
      });
      if (!resolve.ok) throw new Error(resolve.error ?? t('回收伏笔失败'));
    }
    emit('flash', editingId.value ? t('伏笔已更新') : t('伏笔已创建'));
    reset();
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function action(kind: 'advance' | 'resolve' | 'abandon', foreshadow: Foreshadow): Promise<void> {
  if (!actionChapterId.value && kind !== 'abandon') return emit('flash', t('请先选择操作章'));
  const labels = { advance: '推进', resolve: '回收', abandon: '放弃' };
  if (!window.confirm(t('{action}伏笔「{title}」？', { action: t(labels[kind]), title: foreshadow.title }))) return;
  const res =
    kind === 'advance'
      ? await window.api.advanceForeshadow({ foreshadowId: foreshadow.id, chapterId: actionChapterId.value })
      : kind === 'resolve'
        ? await window.api.resolveForeshadow({ foreshadowId: foreshadow.id, chapterId: actionChapterId.value })
        : await window.api.abandonForeshadow({ foreshadowId: foreshadow.id });
  if (!res.ok) return emit('flash', res.error ?? t('{action}失败', { action: t(labels[kind]) }));
  emit('flash', t('已{action}「{title}」', { action: t(labels[kind]), title: foreshadow.title }));
  emit('refresh');
}

async function remove(foreshadow: Foreshadow): Promise<void> {
  if (!window.confirm(t('删除伏笔「{title}」？', { title: foreshadow.title }))) return;
  const res = await window.api.deleteForeshadow({ foreshadowId: foreshadow.id });
  if (!res.ok) return emit('flash', res.error ?? t('删除失败'));
  emit('flash', t('伏笔已删除'));
  emit('refresh');
}

function statusLabel(status: Foreshadow['status']): string {
  return t({ planted: '已埋设', advancing: '推进中', resolved: '已回收', abandoned: '已放弃' }[status] ?? status);
}

function plantedLabel(foreshadow: Foreshadow): string {
  const chapter = foreshadow.plantedInChapterId ? chapterById.value.get(foreshadow.plantedInChapterId) : null;
  return chapter ? t('第 {n} 章', { n: chapter.ordinal }) : t('未记录');
}
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <div>
        <h3>{{ t('伏笔账本') }}</h3>
        <p class="hint">{{ t('回收必须有正文证据词；门禁会核对章纲声明与伏笔状态。') }}</p>
      </div>
      <div class="head-actions">
        <select v-model="actionChapterId" :title="t('操作生效章')">
          <option :value="null">{{ t('选择操作章…') }}</option>
          <option v-for="chapter in workbench.chapters" :key="chapter.id" :value="chapter.id">
            {{ t('第 {n} 章 {title}', { n: chapter.ordinal, title: chapter.title }) }}
          </option>
        </select>
        <button class="primary" @click="startCreate">{{ t('+ 新建伏笔') }}</button>
      </div>
    </div>

    <div class="table-wrap card">
      <table>
        <thead>
          <tr>
            <th>{{ t('伏笔') }}</th>
            <th>{{ t('类型') }}</th>
            <th>{{ t('状态') }}</th>
            <th>{{ t('埋设') }}</th>
            <th>{{ t('计划回收') }}</th>
            <th>{{ t('证据词') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="foreshadow in workbench.foreshadows" :key="foreshadow.id">
            <td>
              <strong>{{ foreshadow.title }}</strong>
              <div v-if="foreshadow.description" class="description">{{ foreshadow.description }}</div>
            </td>
            <td><span class="badge" :class="foreshadow.kind === 'main' ? 'error' : 'muted'">{{ t(foreshadow.kind === 'main' ? '主线' : '支线') }}</span></td>
            <td><span class="badge" :class="foreshadow.status === 'resolved' ? 'success' : foreshadow.status === 'abandoned' ? 'muted' : 'info'">{{ statusLabel(foreshadow.status) }}</span></td>
            <td>{{ plantedLabel(foreshadow) }}</td>
            <td>{{ foreshadow.plannedResolveOrdinal ?? '—' }}</td>
            <td>{{ foreshadow.resolutionMarkers.join(' / ') || t('未定义') }}</td>
            <td class="actions">
              <button @click="startEdit(foreshadow)">{{ t('编辑') }}</button>
              <button v-if="foreshadow.status === 'planted'" @click="action('advance', foreshadow)">{{ t('推进') }}</button>
              <button v-if="foreshadow.status !== 'resolved' && foreshadow.status !== 'abandoned'" @click="action('resolve', foreshadow)">{{ t('回收') }}</button>
              <button v-if="foreshadow.status !== 'resolved' && foreshadow.status !== 'abandoned'" @click="action('abandon', foreshadow)">{{ t('放弃') }}</button>
              <button class="danger" @click="remove(foreshadow)">{{ t('删除') }}</button>
            </td>
          </tr>
          <tr v-if="workbench.foreshadows.length === 0">
            <td colspan="7" class="empty">{{ t('还没有伏笔') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showForm" class="form-card card">
      <div class="form-head">
        <h4>{{ editingId ? t('编辑伏笔') : t('新建伏笔') }}</h4>
        <button @click="reset">{{ t('取消') }}</button>
      </div>
      <div class="form-grid">
        <label class="wide">{{ t('标题') }}<input v-model="form.title" :placeholder="t('例如：雾中的钟声')" /></label>
        <label>{{ t('类型') }}
          <select v-model="form.kind">
            <option value="main">{{ t('主线') }}</option>
            <option value="sub">{{ t('支线') }}</option>
          </select>
        </label>
        <label>{{ t('状态') }}
          <select v-model="form.status">
            <option value="planted">{{ t('已埋设') }}</option>
            <option value="advancing">{{ t('推进中') }}</option>
            <option value="resolved">{{ t('已回收') }}</option>
            <option value="abandoned">{{ t('已放弃') }}</option>
          </select>
        </label>
        <label>{{ t('埋设章') }}
          <select v-model="form.plantedInChapterId">
            <option value="">{{ t('未记录') }}</option>
            <option v-for="chapter in workbench.chapters" :key="chapter.id" :value="chapter.id">
              {{ t('第 {n} 章 {title}', { n: chapter.ordinal, title: chapter.title }) }}
            </option>
          </select>
        </label>
        <label>{{ t('计划回收章') }}<input v-model.number="form.plannedResolveOrdinal" type="number" min="1" /></label>
        <label class="wide">{{ t('回收证据词') }}<input v-model="form.markers" :placeholder="t('用顿号分隔，必须出现在正文中')" /></label>
        <label class="wide">{{ t('描述') }}<textarea v-model="form.description" rows="3"></textarea></label>
      </div>
      <div class="form-actions">
        <button class="primary" :disabled="busy" @click="save">{{ editingId ? t('保存修改') : t('创建伏笔') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.panel-head h3 { margin: 0; font-size: 14px; }
.hint { margin: 4px 0 0; font-size: 11px; color: var(--text-muted); }
.head-actions { display: flex; gap: 8px; align-items: center; }
.head-actions select { max-width: 220px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: 10px 14px; background: #f7f8fa; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--border); }
td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.6; }
tr:last-child td { border-bottom: none; }
.description { font-size: 10px; color: var(--text-muted); margin-top: 3px; max-width: 300px; }
.actions { white-space: nowrap; }
.actions button { padding: 4px 8px; margin-left: 3px; }
.empty { text-align: center; color: var(--text-muted); padding: 28px; }
.form-card { padding: 16px; }
.form-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.form-head h4 { margin: 0; font-size: 13px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-muted); }
.form-grid .wide { grid-column: 1 / -1; }
.form-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
