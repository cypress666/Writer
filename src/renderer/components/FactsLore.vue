<script setup lang="ts">
import { ref } from 'vue';
import type { Resource, TimelineEvent, WorkbenchData, WorldRule } from '../../shared/ipc-contract.js';
import { t } from '../i18n/index.js';

const props = defineProps<{ workbench: WorkbenchData }>();
const emit = defineEmits<{ flash: [message: string]; refresh: [] }>();

const subTab = ref<'rules' | 'timeline' | 'resources'>('rules');
const busy = ref(false);

const ruleForm = ref({ id: '', category: '世界法则', rule: '', priority: 0 });
const timelineForm = ref({
  id: '',
  chapterId: '' as string,
  storyTime: '',
  storyOrder: props.workbench.chapters.length,
  description: '',
});
const resourceForm = ref({
  id: '',
  name: '',
  category: '',
  holderCharacterId: '' as string,
  quantity: 0,
  notes: '',
});

function resetRule(): void {
  ruleForm.value = { id: '', category: '世界法则', rule: '', priority: 0 };
}
function resetTimeline(): void {
  timelineForm.value = {
    id: '',
    chapterId: '',
    storyTime: '',
    storyOrder: props.workbench.chapters.length,
    description: '',
  };
}
function resetResource(): void {
  resourceForm.value = { id: '', name: '', category: '', holderCharacterId: '', quantity: 0, notes: '' };
}

function editRule(rule: WorldRule): void {
  ruleForm.value = { id: rule.id, category: rule.category, rule: rule.rule, priority: rule.priority };
}
function editTimeline(event: TimelineEvent): void {
  timelineForm.value = {
    id: event.id,
    chapterId: event.chapterId ?? '',
    storyTime: event.storyTime,
    storyOrder: event.storyOrder,
    description: event.description,
  };
}
function editResource(resource: Resource): void {
  resourceForm.value = {
    id: resource.id,
    name: resource.name,
    category: resource.category,
    holderCharacterId: resource.holderCharacterId ?? '',
    quantity: resource.quantity,
    notes: resource.notes,
  };
}

async function saveRule(): Promise<void> {
  if (!ruleForm.value.rule.trim()) return emit('flash', t('规则内容不能为空'));
  busy.value = true;
  try {
    const res = ruleForm.value.id
      ? await window.api.updateWorldRule({
          ruleId: ruleForm.value.id,
          category: ruleForm.value.category,
          rule: ruleForm.value.rule,
          priority: ruleForm.value.priority,
        })
      : await window.api.createWorldRule({
          bookId: props.workbench.book.id,
          category: ruleForm.value.category,
          rule: ruleForm.value.rule,
          priority: ruleForm.value.priority,
        });
    if (!res.ok) throw new Error(res.error ?? t('保存规则失败'));
    emit('flash', ruleForm.value.id ? t('规则已更新') : t('规则已创建'));
    resetRule();
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function removeRule(rule: WorldRule): Promise<void> {
  if (!window.confirm(t('删除规则「{name}」？', { name: rule.rule }))) return;
  const res = await window.api.deleteWorldRule({ ruleId: rule.id });
  if (!res.ok) return emit('flash', res.error ?? t('删除失败'));
  emit('flash', t('规则已删除'));
  emit('refresh');
}

async function saveTimeline(): Promise<void> {
  if (!timelineForm.value.description.trim() || !timelineForm.value.storyTime.trim()) {
    return emit('flash', t('请填写故事时间与事件描述'));
  }
  busy.value = true;
  try {
    const payload = {
      chapterId: timelineForm.value.chapterId || null,
      storyTime: timelineForm.value.storyTime.trim(),
      storyOrder: timelineForm.value.storyOrder,
      description: timelineForm.value.description.trim(),
    };
    const res = timelineForm.value.id
      ? await window.api.updateTimelineEvent({ eventId: timelineForm.value.id, ...payload })
      : await window.api.createTimelineEvent({ bookId: props.workbench.book.id, ...payload });
    if (!res.ok) throw new Error(res.error ?? t('保存时间线失败'));
    emit('flash', timelineForm.value.id ? t('时间线已更新') : t('时间线已创建'));
    resetTimeline();
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function removeTimeline(event: TimelineEvent): Promise<void> {
  if (!window.confirm(t('删除时间线事件「{name}」？', { name: event.description }))) return;
  const res = await window.api.deleteTimelineEvent({ eventId: event.id });
  if (!res.ok) return emit('flash', res.error ?? '删除失败');
  emit('flash', t('时间线已删除'));
  emit('refresh');
}

async function saveResource(): Promise<void> {
  if (!resourceForm.value.name.trim()) return emit('flash', t('资源名称不能为空'));
  busy.value = true;
  try {
    const res = resourceForm.value.id
      ? await window.api.updateResource({
          resourceId: resourceForm.value.id,
          quantity: resourceForm.value.quantity,
          holderCharacterId: resourceForm.value.holderCharacterId || null,
          notes: resourceForm.value.notes,
        })
      : await window.api.createResource({
          bookId: props.workbench.book.id,
          name: resourceForm.value.name.trim(),
          category: resourceForm.value.category,
          holderCharacterId: resourceForm.value.holderCharacterId || null,
          quantity: resourceForm.value.quantity,
          notes: resourceForm.value.notes,
        });
    if (!res.ok) throw new Error(res.error ?? t('保存资源失败'));
    emit('flash', resourceForm.value.id ? t('资源已更新') : t('资源已创建'));
    resetResource();
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function removeResource(resource: Resource): Promise<void> {
  if (!window.confirm(t('删除资源「{name}」？', { name: resource.name }))) return;
  const res = await window.api.deleteResource({ resourceId: resource.id });
  if (!res.ok) return emit('flash', res.error ?? '删除失败');
  emit('flash', t('资源已删除'));
  emit('refresh');
}

function chapterLabel(id: string | null): string {
  if (!id) return '—';
  const chapter = props.workbench.chapters.find((item) => item.id === id);
  return chapter ? t('第 {n} 章', { n: chapter.ordinal }) : '—';
}
function holderLabel(id: string | null): string {
  if (!id) return '—';
  return props.workbench.characters.find((item) => item.id === id)?.name ?? '—';
}
</script>

<template>
  <div class="panel">
    <nav class="sub-tabs">
      <button :class="{ active: subTab === 'rules' }" @click="subTab = 'rules'">{{ t('世界规则') }}</button>
      <button :class="{ active: subTab === 'timeline' }" @click="subTab = 'timeline'">{{ t('时间线') }}</button>
      <button :class="{ active: subTab === 'resources' }" @click="subTab = 'resources'">{{ t('资源') }}</button>
    </nav>

    <template v-if="subTab === 'rules'">
      <div class="table-wrap card">
        <table>
          <thead><tr><th>{{ t('分类') }}</th><th>{{ t('规则') }}</th><th>{{ t('优先级') }}</th><th></th></tr></thead>
          <tbody>
            <tr v-for="rule in workbench.worldRules" :key="rule.id">
              <td><span class="badge muted">{{ rule.category }}</span></td>
              <td>{{ rule.rule }}<span v-if="rule.priority >= 100" class="badge error iron">{{ t('铁律') }}</span></td>
              <td>{{ rule.priority }}</td>
              <td class="actions"><button @click="editRule(rule)">{{ t('编辑') }}</button><button class="danger" @click="removeRule(rule)">{{ t('删除') }}</button></td>
            </tr>
            <tr v-if="workbench.worldRules.length === 0"><td colspan="4" class="empty">{{ t('还没有世界规则') }}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="form-card card">
        <div class="form-head"><h4>{{ ruleForm.id ? t('编辑规则') : t('新增规则') }}</h4><button v-if="ruleForm.id" @click="resetRule">{{ t('取消') }}</button></div>
        <div class="form-grid">
          <label>{{ t('分类') }}<input v-model="ruleForm.category" :placeholder="t('力量体系 / 世界法则 / 禁忌…')" /></label>
          <label>{{ t('优先级') }}<input v-model.number="ruleForm.priority" type="number" min="0" /><span class="tiny">{{ t('≥100 为铁律，无条件注入') }}</span></label>
          <label class="wide">{{ t('规则') }}<textarea v-model="ruleForm.rule" rows="2"></textarea></label>
        </div>
        <div class="form-actions"><button class="primary" :disabled="busy" @click="saveRule">{{ ruleForm.id ? t('保存规则') : t('添加规则') }}</button></div>
      </div>
    </template>

    <template v-else-if="subTab === 'timeline'">
      <div class="table-wrap card">
        <table>
          <thead><tr><th>{{ t('故事顺序') }}</th><th>{{ t('故事时间') }}</th><th>{{ t('事件') }}</th><th>{{ t('关联章') }}</th><th></th></tr></thead>
          <tbody>
            <tr v-for="event in workbench.timelineEvents" :key="event.id">
              <td>{{ event.storyOrder }}</td>
              <td>{{ event.storyTime }}</td>
              <td>{{ event.description }}</td>
              <td>{{ chapterLabel(event.chapterId) }}</td>
              <td class="actions"><button @click="editTimeline(event)">{{ t('编辑') }}</button><button class="danger" @click="removeTimeline(event)">{{ t('删除') }}</button></td>
            </tr>
            <tr v-if="workbench.timelineEvents.length === 0"><td colspan="5" class="empty">{{ t('还没有时间线事件') }}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="form-card card">
        <div class="form-head"><h4>{{ timelineForm.id ? t('编辑事件') : t('新增事件') }}</h4><button v-if="timelineForm.id" @click="resetTimeline">{{ t('取消') }}</button></div>
        <div class="form-grid">
          <label>{{ t('故事时间') }}<input v-model="timelineForm.storyTime" :placeholder="t('第三年·秋')" /></label>
          <label>{{ t('故事顺序') }}<input v-model.number="timelineForm.storyOrder" type="number" /></label>
          <label>{{ t('关联章') }}
            <select v-model="timelineForm.chapterId">
              <option value="">{{ t('不关联') }}</option>
              <option v-for="chapter in workbench.chapters" :key="chapter.id" :value="chapter.id">
                {{ t('第 {n} 章 {title}', { n: chapter.ordinal, title: chapter.title }) }}
              </option>
            </select>
          </label>
          <label class="wide">{{ t('事件描述') }}<textarea v-model="timelineForm.description" rows="2"></textarea></label>
        </div>
        <div class="form-actions"><button class="primary" :disabled="busy" @click="saveTimeline">{{ timelineForm.id ? t('保存事件') : t('添加事件') }}</button></div>
      </div>
    </template>

    <template v-else>
      <div class="table-wrap card">
        <table>
          <thead><tr><th>{{ t('资源') }}</th><th>{{ t('分类') }}</th><th>{{ t('持有者') }}</th><th>{{ t('数量') }}</th><th>{{ t('备注') }}</th><th></th></tr></thead>
          <tbody>
            <tr v-for="resource in workbench.resources" :key="resource.id">
              <td><strong>{{ resource.name }}</strong></td>
              <td>{{ resource.category || '—' }}</td>
              <td>{{ holderLabel(resource.holderCharacterId) }}</td>
              <td>{{ resource.quantity }}</td>
              <td>{{ resource.notes || '—' }}</td>
              <td class="actions"><button @click="editResource(resource)">{{ t('编辑') }}</button><button class="danger" @click="removeResource(resource)">{{ t('删除') }}</button></td>
            </tr>
            <tr v-if="workbench.resources.length === 0"><td colspan="6" class="empty">{{ t('还没有资源') }}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="form-card card">
        <div class="form-head"><h4>{{ resourceForm.id ? t('编辑资源') : t('新增资源') }}</h4><button v-if="resourceForm.id" @click="resetResource">{{ t('取消') }}</button></div>
        <div class="form-grid">
          <label>{{ t('名称') }}<input v-model="resourceForm.name" :disabled="Boolean(resourceForm.id)" /></label>
          <label>{{ t('分类') }}<input v-model="resourceForm.category" :disabled="Boolean(resourceForm.id)" /></label>
          <label>{{ t('持有者') }}
            <select v-model="resourceForm.holderCharacterId">
              <option value="">{{ t('无') }}</option>
              <option v-for="character in workbench.characters" :key="character.id" :value="character.id">{{ character.name }}</option>
            </select>
          </label>
          <label>{{ t('数量') }}<input v-model.number="resourceForm.quantity" type="number" step="1" /></label>
          <label class="wide">{{ t('备注') }}<textarea v-model="resourceForm.notes" rows="2"></textarea></label>
        </div>
        <div class="form-actions"><button class="primary" :disabled="busy" @click="saveResource">{{ resourceForm.id ? t('保存资源') : t('添加资源') }}</button></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.sub-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.sub-tabs button { border: none; border-bottom: 2px solid transparent; background: none; border-radius: 0; padding: 8px 14px; color: var(--text-muted); }
.sub-tabs button.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: 10px 14px; background: #f7f8fa; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--border); }
td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.6; }
tr:last-child td { border-bottom: none; }
.iron { margin-left: 6px; }
.actions { white-space: nowrap; }
.actions button { padding: 4px 8px; margin-left: 4px; }
.empty { text-align: center; color: var(--text-muted); padding: 28px; }
.form-card { padding: 16px; }
.form-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.form-head h4 { margin: 0; font-size: 13px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-muted); }
.form-grid .wide { grid-column: 1 / -1; }
.tiny { font-size: 10px; color: var(--text-muted); }
.form-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
