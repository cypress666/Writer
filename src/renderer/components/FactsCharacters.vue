<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Ability, Character, CharacterState, WorkbenchData } from '../../shared/ipc-contract.js';
import { t } from '../i18n/index.js';

const props = defineProps<{ workbench: WorkbenchData; chapterId?: string | null }>();
const emit = defineEmits<{ flash: [message: string]; refresh: [] }>();

const editingId = ref<string | null>(null);
const showForm = ref(false);
const busy = ref(false);
const effectiveChapterId = ref<string | null>(null);

const form = ref({
  name: '',
  aliases: '',
  notes: '',
  isAlive: true,
  location: '',
  abilities: '',
  knownFacts: '',
});

const stateByChar = computed(() => {
  const map = new Map<string, CharacterState>();
  for (const state of props.workbench.characterStates) map.set(state.characterId, state);
  return map;
});

function parseAbilities(text: string): Ability[] {
  return text
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item, index) => {
      const [name, level] = item.split(/[:：]/);
      return {
        id: `ab-${Date.now()}-${index}`,
        name: (name ?? item).trim(),
        level: Number(level ?? 1) || 1,
      };
    });
}

function formatAbilities(abilities: Ability[]): string {
  return abilities.map((ability) => `${ability.name}:${ability.level}`).join('、');
}

function reset(): void {
  editingId.value = null;
  showForm.value = false;
  effectiveChapterId.value = props.chapterId ?? props.workbench.chapters.at(-1)?.id ?? null;
  form.value = { name: '', aliases: '', notes: '', isAlive: true, location: '', abilities: '', knownFacts: '' };
}

function startCreate(): void {
  reset();
  showForm.value = true;
}

function startEdit(character: Character): void {
  const state = stateByChar.value.get(character.id);
  editingId.value = character.id;
  showForm.value = true;
  effectiveChapterId.value = props.chapterId ?? props.workbench.chapters.at(-1)?.id ?? null;
  form.value = {
    name: character.name,
    aliases: character.aliases.join('、'),
    notes: character.notes,
    isAlive: character.isAlive,
    location: state?.location ?? '',
    abilities: formatAbilities(state?.abilities ?? []),
    knownFacts: (state?.knownFacts ?? []).join('\n'),
  };
}

async function save(): Promise<void> {
  if (!form.value.name.trim()) return emit('flash', t('角色姓名不能为空'));
  busy.value = true;
  try {
    const abilities = parseAbilities(form.value.abilities);
    const knownFacts = form.value.knownFacts.split('\n').map((s) => s.trim()).filter(Boolean);
    const aliases = form.value.aliases.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    const res = editingId.value
      ? await window.api.updateCharacter({
          characterId: editingId.value,
          name: form.value.name.trim(),
          aliases,
          notes: form.value.notes,
          isAlive: form.value.isAlive,
          location: form.value.location.trim() || null,
          abilities,
          knownFacts,
          chapterId: effectiveChapterId.value,
        })
      : await window.api.createCharacter({
          bookId: props.workbench.book.id,
          name: form.value.name.trim(),
          aliases,
          notes: form.value.notes,
          initialLocation: form.value.location.trim() || null,
          abilities,
          knownFacts,
        });
    if (!res.ok) throw new Error(res.error ?? t('保存角色失败'));
    emit('flash', editingId.value ? t('角色已更新') : t('角色已创建'));
    reset();
    emit('refresh');
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function remove(character: Character): Promise<void> {
  if (!window.confirm(t('删除角色「{name}」？其状态事实与状态历史会一并删除。', { name: character.name }))) return;
  const res = await window.api.deleteCharacter({ characterId: character.id });
  if (!res.ok) return emit('flash', res.error ?? t('删除角色失败'));
  emit('flash', t('角色已删除'));
  emit('refresh');
}

function provenanceLabel(state: CharacterState | undefined): string {
  const provenance = state?.fieldProvenance?.location?.provenance ?? 'legacy';
  return t({ author: '作者', derived: '定稿派生', legacy: '历史' }[provenance] ?? '历史');
}
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <div>
        <h3>{{ t('角色状态') }}</h3>
        <p class="hint">{{ t('状态按生效章取值；补写中间章不会读到后文状态。') }}</p>
      </div>
      <button class="primary" @click="startCreate">{{ t('+ 新建角色') }}</button>
    </div>

    <div class="table-wrap card">
      <table>
        <thead>
          <tr>
            <th>{{ t('角色') }}</th>
            <th>{{ t('位置') }}</th>
            <th>{{ t('能力/境界') }}</th>
            <th>{{ t('已知信息') }}</th>
            <th>{{ t('来源') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="character in workbench.characters" :key="character.id">
            <td>
              <strong>{{ character.name }}</strong>
              <span v-if="character.aliases.length" class="aliases">{{ character.aliases.join(' / ') }}</span>
              <span v-if="!character.isAlive" class="badge error dead">{{ t('已故') }}</span>
            </td>
            <td>{{ stateByChar.get(character.id)?.location ?? '—' }}</td>
            <td>{{ formatAbilities(stateByChar.get(character.id)?.abilities ?? []) || '—' }}</td>
            <td class="pre">{{ (stateByChar.get(character.id)?.knownFacts ?? []).join('；') || '—' }}</td>
            <td><span class="badge muted">{{ provenanceLabel(stateByChar.get(character.id)) }}</span></td>
            <td class="actions">
              <button @click="startEdit(character)">{{ t('编辑') }}</button>
              <button class="danger" @click="remove(character)">{{ t('删除') }}</button>
            </td>
          </tr>
          <tr v-if="workbench.characters.length === 0">
            <td colspan="6" class="empty">{{ t('还没有角色') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showForm" class="form-card card">
      <div class="form-head">
        <h4>{{ editingId ? t('编辑角色') : t('新建角色') }}</h4>
        <button @click="reset">{{ t('取消') }}</button>
      </div>
      <div class="form-grid">
        <label>{{ t('姓名') }}<input v-model="form.name" :placeholder="t('角色姓名')" /></label>
        <label>{{ t('别名') }}<input v-model="form.aliases" :placeholder="t('用顿号分隔')" /></label>
        <label>{{ t('位置') }}<input v-model="form.location" :placeholder="t('当前所在地')" /></label>
        <label v-if="editingId">{{ t('生效章') }}
          <select v-model="effectiveChapterId">
            <option :value="null">{{ t('初始状态（第 0 章）') }}</option>
            <option v-for="chapter in workbench.chapters" :key="chapter.id" :value="chapter.id">
              {{ t('第 {n} 章 {title}', { n: chapter.ordinal, title: chapter.title }) }}
            </option>
          </select>
        </label>
        <label>{{ t('能力/境界') }}<input v-model="form.abilities" :placeholder="t('灵力:3、剑意:2')" /></label>
        <label class="check"><input v-model="form.isAlive" type="checkbox" /> {{ t('存活') }}</label>
        <label class="wide">{{ t('已知信息') }}<textarea v-model="form.knownFacts" rows="4" :placeholder="t('每行一条')"></textarea></label>
        <label class="wide">{{ t('备注') }}<textarea v-model="form.notes" rows="3"></textarea></label>
      </div>
      <div class="form-actions">
        <button class="primary" :disabled="busy" @click="save">{{ editingId ? t('保存修改') : t('创建角色') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; }
.panel-head h3 { margin: 0; font-size: 14px; }
.hint { margin: 4px 0 0; font-size: 11px; color: var(--text-muted); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; padding: 10px 14px; background: #f7f8fa; color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--border); }
td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.6; }
tr:last-child td { border-bottom: none; }
.aliases { display: block; font-size: 10px; color: var(--text-muted); margin-top: 2px; }
.dead { margin-left: 6px; }
.pre { white-space: pre-wrap; max-width: 280px; }
.actions { white-space: nowrap; }
.actions button { padding: 4px 8px; margin-left: 4px; }
.empty { text-align: center; color: var(--text-muted); padding: 28px; }
.form-card { padding: 16px; }
.form-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.form-head h4 { margin: 0; font-size: 13px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-muted); }
.form-grid .wide { grid-column: 1 / -1; }
.form-grid .check { flex-direction: row; align-items: center; gap: 6px; }
.form-grid input[type='checkbox'] { width: auto; }
.form-actions { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
