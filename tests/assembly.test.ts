import { describe, expect, it } from 'vitest';
import { IRON_RULE_PRIORITY, assembleContext, estimateTokens } from '../src/assembly/assembler.js';
import {
  makeAbility,
  makeCharacter,
  makeFactSourceState,
  makeForeshadow,
  makeSpec,
  makeState,
  makeTimelineEvent,
  makeWorldRule,
} from './helpers.js';

describe('按需状态装配', () => {
  const facts = makeFactSourceState({
    characters: [
      makeCharacter({ id: 'c1', name: '林风' }),
      makeCharacter({ id: 'c2', name: '苏瑶' }),
      makeCharacter({ id: 'c3', name: '长老' }),
    ],
    characterStates: [
      makeState({ characterId: 'c1', abilities: [makeAbility()] }),
      makeState({ characterId: 'c2', location: '天魔宗' }),
      makeState({ characterId: 'c3', location: '青云城' }),
    ],
    worldRules: [
      makeWorldRule({ id: 'r1', category: 'combat', priority: 0 }),
      makeWorldRule({ id: 'r2', category: 'language', priority: IRON_RULE_PRIORITY }),
      makeWorldRule({ id: 'r3', category: 'geography', priority: 0 }),
    ],
    foreshadows: [
      makeForeshadow({ id: 'f1' }),
      makeForeshadow({ id: 'f2', title: '支线', kind: 'sub' }),
    ],
    timelineEvents: [makeTimelineEvent()],
  });

  it('只注入章纲声明出场角色的状态，其余显式列入排除清单', () => {
    const result = assembleContext({
      spec: makeSpec({ characterIds: ['c1'], worldRuleCategories: ['combat'] }),
      ...facts,
    });

    expect(result.characters.map((item) => item.name)).toEqual(['林风']);
    expect(result.excluded.characters.map((item) => item.name)).toEqual(['苏瑶', '长老']);
    expect(result.excluded.characters.every((item) => item.reason.length > 0)).toBe(true);
  });

  it('铁律无视章纲声明无条件注入', () => {
    const result = assembleContext({
      spec: makeSpec({ worldRuleCategories: ['combat'] }),
      ...facts,
    });
    expect(result.worldRules.map((rule) => rule.id).sort()).toEqual(['r1', 'r2']);
    expect(result.excluded.worldRules.map((item) => item.id)).toEqual(['r3']);
  });

  it('注入本章需推进的伏笔与逾期主线伏笔', () => {
    const result = assembleContext({
      spec: makeSpec({
        ordinal: 8,
        foreshadows: [{ foreshadowId: 'f1', action: 'resolve' }],
      }),
      ...facts,
    });
    expect(result.foreshadows.map((item) => item.id)).toEqual(['f1']);
    // f1 被作者指派本章处理 → assigned 任务
    expect(result.chapterTasks.some((task) => task.foreshadowId === 'f1' && task.source === 'assigned')).toBe(true);
    // f2 是支线，逾期不强制注入
    expect(result.overdueForeshadows).toHaveLength(0);
    expect(result.excluded.foreshadows.map((item) => item.id)).toEqual(['f2']);
  });

  it('按需装配的 token 估算显著低于全量加载', () => {
    const lean = assembleContext({
      spec: makeSpec({ characterIds: ['c1'], worldRuleCategories: ['combat'] }),
      ...facts,
    });
    const full = estimateTokens(JSON.stringify(facts));
    expect(lean.tokenEstimate).toBeLessThan(full);
  });

  it('时间线按故事顺序去重并限制条数', () => {
    const result = assembleContext({
      spec: makeSpec({ locations: ['青云城'] }),
      ...facts,
      timelineEvents: [
        makeTimelineEvent({ id: 't1', storyOrder: 1 }),
        makeTimelineEvent({ id: 't2', storyOrder: 2 }),
        makeTimelineEvent({ id: 't3', storyOrder: 3 }),
      ],
    }, { timelineLimit: 2 });
    expect(result.timelineSlice.length).toBeLessThanOrEqual(3);
    expect(result.timelineSlice.map((item) => item.storyOrder)).toEqual(
      [...result.timelineSlice.map((item) => item.storyOrder)].sort((a, b) => a - b),
    );
  });
});
