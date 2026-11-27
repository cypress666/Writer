<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ExtractFactsResult, WorkbenchData } from '../../shared/ipc-contract.js';
import { listSep, locale, t } from '../i18n/index.js';

const props = defineProps<{ workbench: WorkbenchData }>();
const emit = defineEmits<{ flash: [message: string]; refresh: [] }>();

const busy = ref(false);
const adopting = ref(false);
const result = ref<ExtractFactsResult | null>(null);
const maxChapters = ref(8);

/** 勾选状态用「分区 + 下标」标识，避免模型返回重名条目时互相覆盖 */
const picked = ref<Set<string>>(new Set());

const counts = computed(() => {
  const proposal = result.value?.proposal;
  return {
    characters: proposal?.characters.length ?? 0,
    foreshadows: proposal?.foreshadows.length ?? 0,
    worldRules: proposal?.worldRules.length ?? 0,
    timelineEvents: proposal?.timelineEvents.length ?? 0,
    conflicts: proposal?.conflicts.length ?? 0,
  };
});

const pickedCount = computed(() => picked.value.size);

/**
 * 与既有事实源比对：重复条目在采纳时会被跳过，
 * 但「事后才知道跳过了哪些」等于没有裁决权，所以这里提前标出来。
 */
const existingCharacterNames = computed(
  () => new Set(props.workbench.characters.map((character) => character.name.trim())),
);
const existingRuleTexts = computed(
  () => new Set(props.workbench.worldRules.map((rule) => rule.rule.trim())),
);

function isExisting(section: 'characters' | 'worldRules', index: number): boolean {
  const proposal = result.value?.proposal;
  if (!proposal) return false;
  if (section === 'characters') {
    const name = proposal.characters[index]?.name;
    return !!name && existingCharacterNames.value.has(name.trim());
  }
  const rule = proposal.worldRules[index]?.rule;
  return !!rule && existingRuleTexts.value.has(rule.trim());
}

const existingCount = computed(() => {
  const proposal = result.value?.proposal;
  if (!proposal) return { characters: 0, worldRules: 0 };
  let characters = 0;
  let worldRules = 0;
  proposal.characters.forEach((item) => {
    if (existingCharacterNames.value.has(item.name.trim())) characters += 1;
  });
  proposal.worldRules.forEach((item) => {
    if (existingRuleTexts.value.has(item.rule.trim())) worldRules += 1;
  });
  return { characters, worldRules };
});

function key(section: string, index: number): string {
  return `${section}:${index}`;
}

function toggle(section: string, index: number): void {
  const id = key(section, index);
  const next = new Set(picked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  picked.value = next;
}

function isPicked(section: string, index: number): boolean {
  return picked.value.has(key(section, index));
}

function allPicked(section: string): boolean {
  const list = result.value?.proposal as unknown as Record<string, unknown[]> | undefined;
  const length = list?.[section]?.length ?? 0;
  if (length === 0) return false;
  for (let index = 0; index < length; index += 1) {
    if (!picked.value.has(key(section, index))) return false;
  }
  return true;
}

function toggleAll(section: string, checked: boolean): void {
  const list = result.value?.proposal;
  if (!list) return;
  const length = (list as unknown as Record<string, unknown[]>)[section]?.length ?? 0;
  const next = new Set(picked.value);
  for (let index = 0; index < length; index += 1) {
    const id = key(section, index);
    if (checked) next.add(id);
    else next.delete(id);
  }
  picked.value = next;
}

async function run(): Promise<void> {
  busy.value = true;
  try {
    const res = await window.api.extractFacts({
      bookId: props.workbench.book.id,
      maxChapters: maxChapters.value,
    });
    if (!res.ok || !res.data) throw new Error(res.error ?? t('反推失败'));
    result.value = res.data;
    // 默认勾选实体，冲突仅提示不自动处理
    const next = new Set<string>();
    (['characters', 'foreshadows', 'worldRules'] as const).forEach((section) => {
      const length = res.data!.proposal[section].length;
      for (let index = 0; index < length; index += 1) next.add(key(section, index));
    });
    picked.value = next;
    emit(
      'flash',
      t('反推完成：{model}，读取 {n} 章', {
        model: res.data.model,
        n: res.data.usedChapters.length,
      }),
    );
  } catch (error) {
    emit('flash', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

function chapterIdByOrdinal(ordinal: number | null): string | null {
  if (ordinal == null) return null;
  return props.workbench.chapters.find((chapter) => chapter.ordinal === ordinal)?.id ?? null;
}

async function adopt(): Promise<void> {
  const proposal = result.value?.proposal;
  if (!proposal) return;
  adopting.value = true;
  const stats = { characters: 0, foreshadows: 0, worldRules: 0, timelineEvents: 0, skipped: 0, failed: 0 };
  try {
    const bookId = props.workbench.book.id;
    const existingNames = new Set(props.workbench.characters.map((character) => character.name));
    const existingRules = new Set(props.workbench.worldRules.map((rule) => rule.rule));

    for (const [index, item] of proposal.characters.entries()) {
      if (!isPicked('characters', index)) continue;
      if (existingNames.has(item.name)) {
        stats.skipped += 1;
        continue;
      }
      const res = await window.api.createCharacter({
        bookId,
        name: item.name,
        aliases: item.aliases,
        initialLocation: item.location,
        abilities: item.abilities.map((ability, position) => ({
          id: `ab-${Date.now()}-${position}`,
          name: ability.name,
          level: ability.level,
        })),
        knownFacts: item.knownFacts,
      });
      if (res.ok) stats.characters += 1;
      else stats.failed += 1;
    }

    for (const [index, item] of proposal.foreshadows.entries()) {
      if (!isPicked('foreshadows', index)) continue;
      const res = await window.api.createForeshadow({
        bookId,
        title: item.title,
        kind: item.kind,
        plannedResolveOrdinal: item.plannedResolveOrdinal,
        resolutionMarkers: item.resolutionMarkers,
      });
      if (res.ok) stats.foreshadows += 1;
      else stats.failed += 1;
    }

    for (const [index, item] of proposal.worldRules.entries()) {
      if (!isPicked('worldRules', index)) continue;
      if (existingRules.has(item.rule)) {
        stats.skipped += 1;
        continue;
      }
      const res = await window.api.createWorldRule({
        bookId,
        category: item.category,
        rule: item.rule,
        priority: item.priority,
      });
      if (res.ok) stats.worldRules += 1;
      else stats.failed += 1;
    }

    for (const [index, item] of proposal.timelineEvents.entries()) {
      if (!isPicked('timelineEvents', index)) continue;
      const res = await window.api.createTimelineEvent({
        bookId,
        chapterId: chapterIdByOrdinal(item.chapterOrdinal),
        storyTime: item.storyTime || t('第 {n} 章', { n: item.chapterOrdinal ?? '?' }),
        storyOrder: item.chapterOrdinal ?? index + 1,
        description: item.description,
      });
      if (res.ok) stats.timelineEvents += 1;
      else stats.failed += 1;
    }

    const written =
      stats.characters + stats.foreshadows + stats.worldRules + stats.timelineEvents;
    emit(
      'flash',
      t('已采纳 {n} 条（角色 {characters}／伏笔 {foreshadows}／规则 {rules}／时间线 {timeline}）{skipped}{failed}', {
        n: written,
        characters: stats.characters,
        foreshadows: stats.foreshadows,
        rules: stats.worldRules,
        timeline: stats.timelineEvents,
        skipped: stats.skipped ? t('，跳过重复 {n} 条', { n: stats.skipped }) : '',
        failed: stats.failed ? t('，失败 {n} 条', { n: stats.failed }) : '',
      }),
    );
    emit('refresh');
  } finally {
    adopting.value = false;
  }
}
</script>

<template>
  <div class="extract">
    <div class="panel-head">
      <div>
        <h3>{{ t('旧稿 AI 反推') }}</h3>
        <p class="hint">
          {{ t('只读正文抽样，产出候选清单；勾选后才会写入事实源。不会改动已有条目。') }}
        </p>
      </div>
      <div class="head-actions">
        <label class="inline-field">
          {{ t('抽样章数') }}
          <input v-model.number="maxChapters" type="number" min="1" max="20" />
        </label>
        <button class="primary" :disabled="busy" @click="run">
          {{ busy ? t('反推中…') : t('开始反推') }}
        </button>
      </div>
    </div>

    <div v-if="!result" class="empty-hint">
      {{
        t(
          '选择作品后点击「开始反推」。抽样策略：保留开头 3 章建立世界观，其余章节均匀抽样，每章截断 3500 字，避免把百万字整本塞进上下文。',
        )
      }}
    </div>

    <template v-else>
      <div class="meta-row">
        <span class="badge muted">{{ t('模型 {model}', { model: result.model }) }}</span>
        <span class="badge muted">prompt {{ result.promptTokens }} tok</span>
        <span class="badge muted">{{ t('输出 {n} tok', { n: result.tokens }) }}</span>
        <span class="badge info">
          {{ t('读取章节：{list}', { list: result.usedChapters.map((c) => t('第 {n} 章', { n: c.ordinal })).join(listSep()) }) }}
        </span>
      </div>

      <div v-if="counts.conflicts" class="conflict-card card">
        <h4>{{ t('⚠ 疑似前后矛盾（{n}）——只提示，不自动改', { n: counts.conflicts }) }}</h4>
        <div v-for="(item, index) in result.proposal.conflicts" :key="index" class="conflict-item">
          <span v-if="item.chapterOrdinal" class="badge warning">
            {{ t('第 {n} 章', { n: item.chapterOrdinal }) }}
          </span>
          <span>{{ item.description }}</span>
        </div>
      </div>

      <section class="block card">
        <div class="block-head">
          <h4>{{ t('角色（{n}）', { n: counts.characters }) }}</h4>
          <label v-if="counts.characters" class="inline-field">
            <input
              type="checkbox"
              :checked="allPicked('characters')"
              @change="toggleAll('characters', ($event.target as HTMLInputElement).checked)"
            />
            {{ t('全选') }}
          </label>
        </div>
        <div v-if="!counts.characters" class="muted small">{{ t('未识别到角色') }}</div>
        <div v-else-if="existingCount.characters" class="muted small">
          {{
            t('其中 {n} 条已存在于事实源，采纳时自动跳过（要改请到角色页手动编辑）', {
              n: existingCount.characters,
            })
          }}
        </div>
        <div v-for="(item, index) in result.proposal.characters" :key="index" class="row">
          <input type="checkbox" :checked="isPicked('characters', index)" @change="toggle('characters', index)" />
          <div class="row-body">
            <div class="row-title">
              {{ item.name }}
              <span v-if="item.aliases.length" class="muted">（{{ item.aliases.join(listSep()) }}）</span>
              <span v-if="isExisting('characters', index)" class="badge muted">{{ t('已在事实源') }}</span>
            </div>
            <div class="row-sub">
              {{
                t('位置 {location} · 能力 {abilities}', {
                  location: item.location || t('未记录'),
                  abilities:
                    item.abilities.map((a) => `${a.name}${a.level}`).join(listSep()) || t('未记录'),
                })
              }}
            </div>
            <div v-if="item.knownFacts.length" class="row-sub">
              {{ t('已知：{list}', { list: item.knownFacts.join(locale === 'en' ? '; ' : '；') }) }}
            </div>
          </div>
        </div>
      </section>

      <section class="block card">
        <div class="block-head">
          <h4>{{ t('伏笔（{n}）', { n: counts.foreshadows }) }}</h4>
          <label v-if="counts.foreshadows" class="inline-field">
            <input
              type="checkbox"
              :checked="allPicked('foreshadows')"
              @change="toggleAll('foreshadows', ($event.target as HTMLInputElement).checked)"
            />
            {{ t('全选') }}
          </label>
        </div>
        <div v-if="!counts.foreshadows" class="muted small">{{ t('未识别到伏笔') }}</div>
        <div v-for="(item, index) in result.proposal.foreshadows" :key="index" class="row">
          <input type="checkbox" :checked="isPicked('foreshadows', index)" @change="toggle('foreshadows', index)" />
          <div class="row-body">
            <div class="row-title">
              {{ item.title }}
              <span class="badge" :class="item.kind === 'main' ? 'error' : 'muted'">
                {{ item.kind === 'main' ? t('主线') : t('支线') }}
              </span>
            </div>
            <div class="row-sub">
              {{
                t('计划第 {n} 章回收 · 证据词 {markers}', {
                  n: item.plannedResolveOrdinal ?? '?',
                  markers: item.resolutionMarkers.join(listSep()) || t('未给'),
                })
              }}
            </div>
          </div>
        </div>
      </section>

      <section class="block card">
        <div class="block-head">
          <h4>{{ t('世界规则（{n}）', { n: counts.worldRules }) }}</h4>
          <label v-if="counts.worldRules" class="inline-field">
            <input
              type="checkbox"
              :checked="allPicked('worldRules')"
              @change="toggleAll('worldRules', ($event.target as HTMLInputElement).checked)"
            />
            {{ t('全选') }}
          </label>
        </div>
        <div v-if="!counts.worldRules" class="muted small">{{ t('未识别到世界规则') }}</div>
        <div v-else-if="existingCount.worldRules" class="muted small">
          {{ t('其中 {n} 条已存在，采纳时自动跳过', { n: existingCount.worldRules }) }}
        </div>
        <div v-for="(item, index) in result.proposal.worldRules" :key="index" class="row">
          <input type="checkbox" :checked="isPicked('worldRules', index)" @change="toggle('worldRules', index)" />
          <div class="row-body">
            <div class="row-title">
              <span class="badge muted">{{ item.category }}</span>
              {{ item.rule }}
              <span v-if="isExisting('worldRules', index)" class="badge muted">{{ t('已在事实源') }}</span>
            </div>
            <div class="row-sub">
              {{ t('优先级 {n}', { n: item.priority }) }}{{ item.priority >= 100 ? t('（铁律）') : '' }}
            </div>
          </div>
        </div>
      </section>

      <section class="block card">
        <div class="block-head">
          <h4>{{ t('时间线（{n}，默认不勾选）', { n: counts.timelineEvents }) }}</h4>
          <label v-if="counts.timelineEvents" class="inline-field">
            <input
              type="checkbox"
              @change="toggleAll('timelineEvents', ($event.target as HTMLInputElement).checked)"
            />
            {{ t('全选') }}
          </label>
        </div>
        <div v-if="!counts.timelineEvents" class="muted small">{{ t('未识别到时间线事件') }}</div>
        <div v-for="(item, index) in result.proposal.timelineEvents" :key="index" class="row">
          <input
            type="checkbox"
            :checked="isPicked('timelineEvents', index)"
            @change="toggle('timelineEvents', index)"
          />
          <div class="row-body">
            <div class="row-title">
              <span v-if="item.chapterOrdinal" class="badge muted">
                {{ t('第 {n} 章', { n: item.chapterOrdinal }) }}
              </span>
              {{ item.storyTime || t('时间未标注') }}
            </div>
            <div class="row-sub">{{ item.description }}</div>
          </div>
        </div>
      </section>

      <div class="adopt-bar">
        <span class="muted small">{{ t('已勾选 {n} 条', { n: pickedCount }) }}</span>
        <button class="primary" :disabled="adopting || pickedCount === 0" @click="adopt">
          {{ adopting ? t('写入中…') : t('采纳所选并写入事实源') }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.extract { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.panel-head h3 { margin: 0 0 4px; font-size: 14px; }
.hint { margin: 0; font-size: 11px; color: var(--text-muted); line-height: 1.7; }
.head-actions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.inline-field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.inline-field input[type='number'] { width: 64px; }
.empty-hint { padding: 34px 20px; text-align: center; color: var(--text-muted); font-size: 12px; line-height: 1.9; }
.meta-row { display: flex; gap: 6px; flex-wrap: wrap; }
.conflict-card { padding: 12px 14px; border-left: 3px solid var(--warning); }
.conflict-card h4 { margin: 0 0 8px; font-size: 12px; color: var(--warning); }
.conflict-item { display: flex; gap: 8px; font-size: 12px; line-height: 1.8; padding: 3px 0; }
.block { padding: 12px 14px; }
.block-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.block-head h4 { margin: 0; font-size: 12px; }
.row { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
.row input[type='checkbox'] { margin-top: 2px; }
.row-body { flex: 1; min-width: 0; }
.row-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.row-sub { font-size: 11px; color: var(--text-muted); line-height: 1.7; margin-top: 2px; }
.muted { color: var(--text-muted); }
.small { font-size: 11px; }
.adopt-bar { display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 8px 0 4px; }
</style>
