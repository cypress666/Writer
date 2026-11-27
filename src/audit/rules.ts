/**
 * 对照单一事实源的审计规则。
 *
 * 审计只产出问题清单与建议动作，绝不自动修改事实源或正文。
 * 最终裁决权始终在作者手里。
 */

import type { Ability, Chapter, Character, FactSourceState } from '../domain/models.js';
import type { AuditContext, AuditRule, NewAuditIssue } from './types.js';

const MEMORY_MARKERS = ['回忆', '梦中', '幻觉', '遗像', '生前', '记忆中', '想起'];

function namesOf(character: Character): string[] {
  return [character.name, ...character.aliases].filter((name) => name.length > 0);
}

function findNameOccurrence(content: string, names: string[]): { name: string; index: number } | null {
  for (const name of names) {
    const index = content.indexOf(name);
    if (index !== -1) return { name, index };
  }
  return null;
}

function isInMemoryContext(content: string, index: number, nameLength: number): boolean {
  const start = Math.max(0, index - 30);
  const end = Math.min(content.length, index + nameLength + 30);
  const window = content.slice(start, end);
  return MEMORY_MARKERS.some((marker) => window.includes(marker));
}

/** 已死角色出场：记忆/梦境语境降级为 info */
export const deadCharacterRule: AuditRule = {
  name: 'dead-character',
  check(context: AuditContext): NewAuditIssue[] {
    const content = context.chapter.content ?? '';
    const issues: NewAuditIssue[] = [];
    const declared = new Set(context.chapter.declaredCharacters);

    for (const character of context.facts.characters) {
      if (character.isAlive) continue;
      const occurrence = findNameOccurrence(content, namesOf(character));
      if (!occurrence) continue;
      const memory = isInMemoryContext(content, occurrence.index, occurrence.name.length);
      const explicitlyDeclared = declared.has(character.id);
      issues.push({
        severity: memory && !explicitlyDeclared ? 'info' : 'error',
        category: 'dead-character',
        message: memory
          ? `已故角色「${character.name}」出现在回忆语境中`
          : `已故角色「${character.name}」在正文中出场，与事实源冲突`,
        evidence: content.slice(
          Math.max(0, occurrence.index - 15),
          Math.min(content.length, occurrence.index + occurrence.name.length + 15),
        ),
        suggestion: '确认是否为复活/回忆剧情；若是状态错误，请将角色状态改回存活。',
        suggestedActions: memory
          ? []
          : [{ type: 'set-character-alive', payload: { characterId: character.id, isAlive: true } }],
        details: { characterId: character.id, memoryContext: memory },
      });
    }
    return issues;
  },
};

const LOCATION_VERBS = ['来到', '抵达', '进入', '出现在', '赶往', '返回'];

/** 角色位置漂移：正文写明角色抵达某地，但事实源仍记录旧位置 */
export const stateDriftRule: AuditRule = {
  name: 'state-drift',
  check(context: AuditContext): NewAuditIssue[] {
    const content = context.chapter.content ?? '';
    const issues: NewAuditIssue[] = [];
    const knownLocations = new Set<string>([
      ...context.chapter.declaredLocations,
      ...context.facts.characterStates.map((state) => state.location).filter((loc): loc is string => !!loc),
    ]);
    const declared = new Set(context.chapter.declaredCharacters);

    for (const character of context.facts.characters) {
      if (!declared.has(character.id)) continue;
      const state = context.facts.characterStates.find((item) => item.characterId === character.id);
      if (!state) continue;
      for (const name of namesOf(character)) {
        for (const verb of LOCATION_VERBS) {
          const pattern = new RegExp(`${escapeRegExp(name)}(?:[^。！？\\n]{0,12}?)${verb}(?:[^。！？\\n]{0,12}?)([\\u4e00-\\u9fff]{2,10})`);
          const match = pattern.exec(content);
          if (!match) continue;
          const candidate = match[1]!;
          if (![...knownLocations].some((loc) => loc.includes(candidate) || candidate.includes(loc))) continue;
          if (candidate === state.location) continue;
          issues.push({
            severity: 'warning',
            category: 'state-drift',
            message: `正文描述「${character.name}」${verb}${candidate}，但事实源位置仍为「${state.location ?? '未记录'}」`,
            evidence: match[0],
            suggestion: '若正文为准，请更新事实源位置；若位置未变，请改写正文。',
            suggestedActions: [
              { type: 'update-character-location', payload: { characterId: character.id, location: candidate } },
            ],
            details: { characterId: character.id, detectedLocation: candidate, recordedLocation: state.location },
          });
          break;
        }
      }
    }
    return issues;
  },
};

const UPGRADE_MARKERS = ['突破', '晋升', '觉醒', '达到', '晋级', '领悟'];

/** 能力越界：正文描述能力突破但事实源未登记，或使用了未拥有的能力 */
export const abilityBoundRule: AuditRule = {
  name: 'ability-bound',
  check(context: AuditContext): NewAuditIssue[] {
    const content = context.chapter.content ?? '';
    const issues: NewAuditIssue[] = [];
    const declared = new Set(context.chapter.declaredCharacters);

    for (const character of context.facts.characters) {
      if (!declared.has(character.id)) continue;
      const state = context.facts.characterStates.find((item) => item.characterId === character.id);
      if (!state) continue;
      const owned: Ability[] = state.abilities;
      const mentioned = owned.filter((ability) => content.includes(ability.name));
      const upgrading = mentioned.filter((ability) =>
        UPGRADE_MARKERS.some((marker) =>
          new RegExp(`${escapeRegExp(ability.name)}[^。！？\\n]{0,6}${marker}|${marker}[^。！？\\n]{0,6}${escapeRegExp(ability.name)}`).
            test(content),
        ),
      );

      for (const ability of upgrading) {
        issues.push({
          severity: 'warning',
          category: 'ability-bound',
          message: `正文暗示「${character.name}」的能力「${ability.name}」发生突破，但事实源未登记新境界`,
          evidence: `${character.name} / ${ability.name}`,
          suggestion: '确认突破是否成立；若成立请更新能力境界，避免后续章节沿用旧状态。',
          suggestedActions: [
            {
              type: 'add-ability',
              payload: { characterId: character.id, ability: { ...ability, level: ability.level + 1 } },
            },
          ],
          details: { characterId: character.id, abilityId: ability.id, currentLevel: ability.level },
        });
      }
    }
    return issues;
  },
};

/** 时间线冲突：本章的时间顺序早于已关联事件，但事件描述已在正文出现 */
export const timelineConflictRule: AuditRule = {
  name: 'timeline-conflict',
  check(context: AuditContext): NewAuditIssue[] {
    const content = context.chapter.content ?? '';
    const issues: NewAuditIssue[] = [];
    const events = context.facts.timelineEvents;

    for (const event of events) {
      if (event.chapterId === context.chapter.id) continue;
      if (!content.includes(event.description)) continue;
      // 保守近似：storyOrder 与章序同量纲时，事件的故事顺序晚于本章即视为提前引用。
      // 倒叙/预知章节会产生误报，因此这里只给 warning，由作者裁决。
      if (event.storyOrder <= context.chapter.ordinal) continue;
      issues.push({
        severity: 'warning',
        category: 'timeline-conflict',
        message: `正文引用了时间线事件「${event.description}」，其故事顺序（${event.storyOrder}）晚于本章章序（${context.chapter.ordinal}）`,
        evidence: event.description,
        suggestion: '核对是否为倒叙/预知；若是，请在时间线中标注叙事层级，避免审计反复告警。',
        details: { eventId: event.id, storyOrder: event.storyOrder },
      });
    }
    return issues;
  },
};

/** 伏笔状态矛盾：章纲声明与事实源状态不一致 */
export const foreshadowContradictionRule: AuditRule = {
  name: 'foreshadow-contradiction',
  check(context: AuditContext): NewAuditIssue[] {
    const issues: NewAuditIssue[] = [];
    const byId = new Map(context.facts.foreshadows.map((item) => [item.id, item]));

    for (const use of context.chapter.declaredForeshadows) {
      const foreshadow = byId.get(use.foreshadowId);
      if (!foreshadow) {
        issues.push({
          severity: 'error',
          category: 'foreshadow-contradiction',
          message: `章纲引用了事实源中不存在的伏笔：${use.foreshadowId}`,
          evidence: use.foreshadowId,
          suggestion: '先创建伏笔实体，再在章纲中引用。',
        });
        continue;
      }
      if (use.action === 'resolve' && foreshadow.status === 'abandoned') {
        issues.push({
          severity: 'error',
          category: 'foreshadow-contradiction',
          message: `章纲声明回收已放弃的伏笔「${foreshadow.title}」`,
          evidence: foreshadow.title,
          suggestion: '若决定恢复该支线，请先将伏笔状态从 abandoned 改回 advancing。',
          suggestedActions: [
            { type: 'update-foreshadow', payload: { id: foreshadow.id, status: 'advancing' } },
          ],
        });
      }
      if (use.action === 'plant' && foreshadow.plantedInChapterId && foreshadow.plantedInChapterId !== context.chapter.id) {
        issues.push({
          severity: 'warning',
          category: 'foreshadow-contradiction',
          message: `伏笔「${foreshadow.title}」已记录在第 ${foreshadow.plantedInChapterId} 章埋设，本章重复声明埋设`,
          evidence: foreshadow.title,
          suggestion: '核对埋设章记录；若本章才是真正埋设点，请修正伏笔的 plantedInChapterId。',
        });
      }
    }

    // 正文出现回收证据词但章纲未声明回收 —— 常见于作者手改正文后忘记同步章纲
    const declaredResolves = new Set(
      context.chapter.declaredForeshadows.filter((use) => use.action === 'resolve').map((use) => use.foreshadowId),
    );
    const content = context.chapter.content ?? '';
    for (const foreshadow of context.facts.foreshadows) {
      if (declaredResolves.has(foreshadow.id)) continue;
      if (foreshadow.status === 'resolved' || foreshadow.status === 'abandoned') continue;
      const markers = foreshadow.resolutionMarkers.filter((marker) => marker.length > 0);
      if (markers.length === 0) continue;
      if (markers.every((marker) => content.includes(marker))) {
        issues.push({
          severity: 'info',
          category: 'foreshadow-contradiction',
          message: `正文出现了伏笔「${foreshadow.title}」的全部回收证据词，但章纲未声明回收`,
          evidence: markers.join(' / '),
          suggestion: '确认是否遗漏了章纲声明；若已回收，请同步事实源状态。',
          suggestedActions: [
            { type: 'update-foreshadow', payload: { id: foreshadow.id, status: 'resolved' } },
          ],
        });
      }
    }
    return issues;
  },
};

/** 出场角色位置与章纲声明冲突 */
export const locationConflictRule: AuditRule = {
  name: 'location-conflict',
  check(context: AuditContext): NewAuditIssue[] {
    const issues: NewAuditIssue[] = [];
    const chapterLocations = context.chapter.declaredLocations;
    if (chapterLocations.length === 0) return issues;

    for (const characterId of context.chapter.declaredCharacters) {
      const character = context.facts.characters.find((item) => item.id === characterId);
      const state = context.facts.characterStates.find((item) => item.characterId === characterId);
      if (!character || !state?.location) continue;
      const matches = chapterLocations.some((loc) => loc.includes(state.location!) || state.location!.includes(loc));
      if (!matches) {
        issues.push({
          severity: 'warning',
          category: 'location-conflict',
          message: `出场角色「${character.name}」的事实源位置「${state.location}」与本章声明地点不符`,
          evidence: chapterLocations.join('、'),
          suggestion: '若角色确实换了地点，请先在事实源更新位置，再定稿本章。',
          details: { characterId, recordedLocation: state.location, chapterLocations },
        });
      }
    }
    return issues;
  },
};

export const defaultAuditRules: AuditRule[] = [
  deadCharacterRule,
  stateDriftRule,
  abilityBoundRule,
  timelineConflictRule,
  foreshadowContradictionRule,
  locationConflictRule,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 供规则层复用的事实源查询帮助函数 */
export function characterStatesOf(facts: FactSourceState, chapter: Chapter) {
  return chapter.declaredCharacters
    .map((id) => facts.characterStates.find((state) => state.characterId === id))
    .filter((state): state is NonNullable<typeof state> => !!state);
}
