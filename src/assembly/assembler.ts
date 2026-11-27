/**
 * 章纲驱动的按需状态装配。
 *
 * 设计纪律：
 * 1. 不做"字符串预算机械截断"——显式返回被排除项及原因（对应 Pagekin 的省略记录、
 *    InkOS 的 context trace）。
 * 2. 铁律（priority >= IRON_RULE_PRIORITY）无条件注入。
 * 3. 角色状态按章取值：写第 N 章用第 N 章时点的值，补写中间章不剧透后文
 *    （对应 Pagekin 的人物状态时间线）。
 * 4. 到期/逾期/作者指派的伏笔汇成 ChapterTask 注入本章任务列表（对应 Pagekin 线索提醒）。
 */

import type {
  Ability,
  ChapterSpec,
  ChapterTask,
  Character,
  CharacterState,
  Foreshadow,
  TimelineEvent,
  WorldRule,
} from '../domain/models.js';

export const IRON_RULE_PRIORITY = 100;

export interface AssembledCharacter {
  id: string;
  name: string;
  isAlive: boolean;
  location: string | null;
  abilities: Ability[];
  relations: CharacterState['relations'];
  knownFacts: string[];
}

export interface AssembledContext {
  characters: AssembledCharacter[];
  worldRules: WorldRule[];
  foreshadows: Foreshadow[];
  timelineSlice: TimelineEvent[];
  /** 本章必须处理的线索任务（到期/逾期/作者指派） */
  chapterTasks: ChapterTask[];
  /** 逾期未回收的主线伏笔，写作时必须留意 */
  overdueForeshadows: Foreshadow[];
  /** 显式记录未被注入的内容及原因，供审计核对"是否丢掉了该读的规则" */
  excluded: {
    characters: Array<{ name: string; reason: string }>;
    worldRules: Array<{ id: string; reason: string }>;
    foreshadows: Array<{ id: string; reason: string }>;
  };
  estimatedChars: number;
  tokenEstimate: number;
}

export interface AssembleOptions {
  /** 注入的最近时间线事件条数，默认 10 */
  timelineLimit?: number;
  /** 注入的逾期未回收伏笔上限，默认 5；超出部分写入 excluded 而不进 prompt */
  overdueLimit?: number;
  /** 是否注入铁律，默认 true */
  includeIronRules?: boolean;
}

export interface AssemblyInput {
  spec: ChapterSpec;
  characters: Character[];
  characterStates: CharacterState[];
  worldRules: WorldRule[];
  foreshadows: Foreshadow[];
  timelineEvents: TimelineEvent[];
  /**
   * 可选的按章状态取值函数：stateAt(characterId, chapterOrdinal)。
   * 提供时角色状态按第 N 章时点取值，避免补写中间章剧透后文。
   * 不提供时退化为使用 characterStates 当前值（向后兼容）。
   */
  stateAt?: (characterId: string, chapterOrdinal: number) => Record<string, unknown> | null;
}

/** 中文约 1.5 token/字，英文/数字约 0.3 token/字符 */
export function estimateTokens(text: string): number {
  const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const other = text.length - han;
  return Math.ceil(han * 1.5 + other * 0.3);
}

export function assembleContext(input: AssemblyInput, options: AssembleOptions = {}): AssembledContext {
  const timelineLimit = options.timelineLimit ?? 10;
  const overdueLimit = options.overdueLimit ?? 5;
  const includeIronRules = options.includeIronRules ?? true;
  const { spec } = input;

  const wantedCharacters = new Set(spec.characterIds);
  const characterById = new Map(input.characters.map((item) => [item.id, item]));
  const stateByCharacter = new Map(input.characterStates.map((item) => [item.characterId, item]));

  const characters: AssembledCharacter[] = [];
  for (const id of spec.characterIds) {
    const character = characterById.get(id);
    if (!character) continue;
    // 优先按章取值；无 stateAt 时退回当前状态投影
    const atChapter = input.stateAt?.(id, spec.ordinal) ?? null;
    const current = stateByCharacter.get(id);
    characters.push({
      id: character.id,
      name: character.name,
      isAlive: character.isAlive,
      location: (atChapter?.location as string | null | undefined) ?? current?.location ?? null,
      abilities: (atChapter?.abilities as Ability[] | undefined) ?? current?.abilities ?? [],
      relations: (atChapter?.relations as CharacterState['relations'] | undefined) ?? current?.relations ?? [],
      knownFacts: (atChapter?.knownFacts as string[] | undefined) ?? current?.knownFacts ?? [],
    });
  }
  const excludedCharacters = input.characters
    .filter((character) => !wantedCharacters.has(character.id))
    .map((character) => ({ name: character.name, reason: '本章章纲未声明出场' }));

  const wantedCategories = new Set(spec.worldRuleCategories ?? []);
  const worldRules = input.worldRules.filter(
    (rule) =>
      wantedCategories.has(rule.category) ||
      (includeIronRules && rule.priority >= IRON_RULE_PRIORITY),
  );
  const injectedRuleIds = new Set(worldRules.map((rule) => rule.id));
  const excludedWorldRules = input.worldRules
    .filter((rule) => !injectedRuleIds.has(rule.id))
    .map((rule) => ({ id: rule.id, reason: `分类 ${rule.category} 未被本章章纲引用` }));

  const wantedForeshadows = new Map(
    spec.foreshadows.map((use) => [use.foreshadowId, use.action]),
  );
  const foreshadows = input.foreshadows.filter((item) => wantedForeshadows.has(item.id));
  const allOverdue = input.foreshadows.filter(
    (item) =>
      item.kind === 'main' &&
      (item.status === 'planted' || item.status === 'advancing') &&
      item.plannedResolveOrdinal != null &&
      item.plannedResolveOrdinal < spec.ordinal &&
      item.resolvedInChapterId == null &&
      !wantedForeshadows.has(item.id),
  );
  // 逾期伏笔按最早到期优先注入并设上限，否则百万字长篇会被累积的欠账撑爆 prompt
  const overdueForeshadows = [...allOverdue]
    .sort((a, b) => (a.plannedResolveOrdinal ?? 0) - (b.plannedResolveOrdinal ?? 0))
    .slice(0, overdueLimit);
  const droppedOverdueIds = new Set(
    allOverdue.filter((item) => !overdueForeshadows.some((kept) => kept.id === item.id)).map((item) => item.id),
  );

  // 本章任务：作者指派（assigned）+ 本章到期（due）+ 逾期未回收（overdue）
  const chapterTasks: ChapterTask[] = [];
  const taskIds = new Set<string>();
  const pushTask = (foreshadow: Foreshadow, source: ChapterTask['source'], explicitAction?: ChapterTask['action']): void => {
    if (taskIds.has(foreshadow.id)) return;
    taskIds.add(foreshadow.id);
    const action = explicitAction ?? (foreshadow.status === 'advancing' ? 'advance' : 'resolve');
    chapterTasks.push({
      foreshadowId: foreshadow.id,
      title: foreshadow.title,
      action,
      source,
      markers: foreshadow.resolutionMarkers,
      plannedResolveOrdinal: foreshadow.plannedResolveOrdinal,
    });
  };

  for (const use of spec.foreshadows) {
    const foreshadow = input.foreshadows.find((item) => item.id === use.foreshadowId);
    if (foreshadow) pushTask(foreshadow, 'assigned', use.action);
  }
  for (const item of input.foreshadows) {
    if (
      item.plannedResolveOrdinal === spec.ordinal &&
      (item.status === 'planted' || item.status === 'advancing') &&
      item.resolvedInChapterId == null
    ) {
      pushTask(item, 'due');
    }
  }
  for (const item of overdueForeshadows) pushTask(item, 'overdue');

  const injectedForeshadowIds = new Set([
    ...foreshadows.map((item) => item.id),
    ...overdueForeshadows.map((item) => item.id),
  ]);
  const excludedForeshadows = input.foreshadows
    .filter((item) => !injectedForeshadowIds.has(item.id))
    .map((item) => ({
      id: item.id,
      reason: droppedOverdueIds.has(item.id)
        ? `逾期未回收伏笔超过 ${overdueLimit} 条上限，未注入本章`
        : item.plannedResolveOrdinal == null
          ? '无到期章节且未被本章章纲引用'
          : `计划第 ${item.plannedResolveOrdinal} 章处理，非本章任务`,
    }));

  // 时间线：优先取本章涉及地点/角色的事件，再按故事顺序补足最近事件
  const relevant = input.timelineEvents
    .filter((event) => {
      const text = `${event.description} ${event.storyTime}`;
      return (
        spec.locations.some((loc) => text.includes(loc)) ||
        characters.some((character) => text.includes(character.name))
      );
    })
    // 主角几乎会出现在每一条时间线里；相关事件同样要设上限，否则随章数线性增长
    .sort((a, b) => b.storyOrder - a.storyOrder)
    .slice(0, timelineLimit);
  const recent = [...input.timelineEvents].sort((a, b) => b.storyOrder - a.storyOrder).slice(0, timelineLimit);
  const merged = new Map<number, TimelineEvent>();
  for (const event of [...relevant, ...recent]) merged.set(event.storyOrder, event);
  const timelineSlice = [...merged.values()].sort((a, b) => a.storyOrder - b.storyOrder);

  const serialized = JSON.stringify({
    characters,
    worldRules,
    foreshadows,
    chapterTasks,
    overdueForeshadows,
    timelineSlice,
  });

  return {
    characters,
    worldRules,
    foreshadows,
    timelineSlice,
    chapterTasks,
    overdueForeshadows,
    excluded: {
      characters: excludedCharacters,
      worldRules: excludedWorldRules,
      foreshadows: excludedForeshadows,
    },
    estimatedChars: serialized.length,
    tokenEstimate: estimateTokens(serialized),
  };
}
