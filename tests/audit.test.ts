import { describe, expect, it } from 'vitest';
import {
  AuditEngine,
  abilityBoundRule,
  deadCharacterRule,
  foreshadowContradictionRule,
  locationConflictRule,
  stateDriftRule,
  timelineConflictRule,
  type AuditContext,
  type AuditRule,
} from '../src/audit/index.js';
import {
  chineseText,
  makeAbility,
  makeCharacter,
  makeFactSourceState,
  makeForeshadow,
  makeState,
  makeTimelineEvent,
  makeChapter,
} from './helpers.js';

function context(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    chapter: makeChapter(),
    facts: makeFactSourceState(),
    previousChapters: [],
    ...overrides,
  };
}

function check(rule: AuditRule, ctx: AuditContext) {
  return rule.check(ctx);
}

describe('审计闭环 · 已故角色', () => {
  const deadCharacter = makeCharacter({ id: 'dead-1', name: '林风', isAlive: false });

  it('已故角色在正文出场 → error，并给出修正建议', () => {
    const issues = check(
      deadCharacterRule,
      context({
        chapter: makeChapter({
          content: '林风推开石门，缓步走了进去。',
          declaredCharacters: ['dead-1'],
        }),
        facts: makeFactSourceState({ characters: [deadCharacter] }),
      }),
    );
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.suggestedActions?.[0]?.type).toBe('set-character-alive');
  });

  it('回忆语境中提及已故角色降级为 info，不误伤', () => {
    const issues = check(
      deadCharacterRule,
      context({
        chapter: makeChapter({ content: '他想起林风生前曾说过的话。' }),
        facts: makeFactSourceState({ characters: [deadCharacter] }),
      }),
    );
    expect(issues[0]?.severity).toBe('info');
  });
});

describe('审计闭环 · 状态漂移', () => {
  it('正文写明角色抵达新地点但事实源未更新 → warning 与建议动作', () => {
    const issues = check(
      stateDriftRule,
      context({
        chapter: makeChapter({
          content: '林风来到天魔宗，四下无人。',
          declaredCharacters: ['char-1'],
          declaredLocations: ['天魔宗'],
        }),
        facts: makeFactSourceState({
          characters: [makeCharacter()],
          characterStates: [makeState({ location: '青云城' })],
        }),
      }),
    );
    expect(issues.some((issue) => issue.category === 'state-drift' && issue.severity === 'warning')).toBe(true);
    expect(issues[0]?.suggestedActions?.[0]?.payload.location).toBe('天魔宗');
  });

  it('事实源位置与正文一致时不产生问题', () => {
    const issues = check(
      stateDriftRule,
      context({
        chapter: makeChapter({
          content: '林风来到青云城，四下无人。',
          declaredCharacters: ['char-1'],
          declaredLocations: ['青云城'],
        }),
        facts: makeFactSourceState({
          characters: [makeCharacter()],
          characterStates: [makeState({ location: '青云城' })],
        }),
      }),
    );
    expect(issues).toHaveLength(0);
  });
});

describe('审计闭环 · 能力与时间线', () => {
  it('正文暗示能力突破但事实源境界未更新 → warning', () => {
    const issues = check(
      abilityBoundRule,
      context({
        chapter: makeChapter({
          content: '林风的灵力突破至筑基，周身一震。',
          declaredCharacters: ['char-1'],
        }),
        facts: makeFactSourceState({
          characters: [makeCharacter()],
          characterStates: [makeState({ abilities: [makeAbility({ name: '灵力', level: 1 })] })],
        }),
      }),
    );
    expect(issues.some((issue) => issue.category === 'ability-bound')).toBe(true);
  });

  it('正文提前引用尚未发生的时间线事件 → warning', () => {
    const issues = check(
      timelineConflictRule,
      context({
        chapter: makeChapter({ ordinal: 3, content: '他还记得宗门大比那日的景象。' }),
        facts: makeFactSourceState({
          timelineEvents: [
            makeTimelineEvent({ id: 'e1', storyOrder: 1, description: '入门测试' }),
            makeTimelineEvent({ id: 'e2', storyOrder: 5, description: '宗门大比' }),
          ],
        }),
      }),
    );
    expect(issues.some((issue) => issue.message.includes('晚于本章章序'))).toBe(true);
  });
});

describe('审计闭环 · 伏笔与地点', () => {
  it('章纲声明回收已放弃的伏笔 → error', () => {
    const issues = check(
      foreshadowContradictionRule,
      context({
        chapter: makeChapter({
          content: chineseText(100),
          declaredForeshadows: [{ foreshadowId: 'fs-1', action: 'resolve' }],
        }),
        facts: makeFactSourceState({
          foreshadows: [makeForeshadow({ status: 'abandoned' })],
        }),
      }),
    );
    expect(issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('出场角色事实源位置与本章地点冲突 → warning', () => {
    const issues = check(
      locationConflictRule,
      context({
        chapter: makeChapter({
          declaredCharacters: ['char-1'],
          declaredLocations: ['天魔宗'],
        }),
        facts: makeFactSourceState({
          characters: [makeCharacter()],
          characterStates: [makeState({ location: '青云城' })],
        }),
      }),
    );
    expect(issues[0]?.message).toContain('与本章声明地点不符');
  });
});

describe('审计引擎', () => {
  it('error 阻断定稿，问题按严重度分组', () => {
    const report = new AuditEngine().audit(
      context({
        chapter: makeChapter({
          content: '林风推开石门。',
          declaredCharacters: ['dead-1'],
        }),
        facts: makeFactSourceState({
          characters: [makeCharacter({ id: 'dead-1', name: '林风', isAlive: false })],
        }),
      }),
    );
    expect(report.passed).toBe(false);
    const grouped = AuditEngine.groupBySeverity(report);
    expect(grouped.errors.length).toBeGreaterThan(0);
    expect(report.issues.every((issue) => issue.id.startsWith(issue.category))).toBe(true);
  });
});
