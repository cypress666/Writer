/**
 * 题材侧重：门禁/审计的严格度只做升降级，不改判定逻辑。
 * 这里锁死「同一段正文 + 不同题材 → 阻断与否不同」和「判定结果本身不变」两件事。
 */
import { describe, expect, it } from 'vitest';
import { GENRE_TEMPLATES, findGenre, genreProfile } from '../src/domain/genres.js';
import { GateEngine } from '../src/gates/engine.js';
import { AuditEngine } from '../src/audit/engine.js';
import { createForeshadowRule } from '../src/gates/foreshadow-gate.js';
import { createTestHarness, makeChapter, makeForeshadow } from './helpers.js';

describe('题材模板完整性', () => {
  it('每个题材都有可落地的世界规则与侧重配置', () => {
    expect(GENRE_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    for (const genre of GENRE_TEMPLATES) {
      expect(genre.rules.length).toBeGreaterThan(0);
      expect(genre.rules.some((rule) => rule.priority >= 100)).toBe(true);
      // 侧重配置要么给门禁/审计权重，要么给审计关注点，不能是空壳
      const hasWeight =
        Object.keys(genre.profile.gate ?? {}).length > 0 ||
        Object.keys(genre.profile.audit ?? {}).length > 0;
      const hasFocus = (genre.profile.auditFocus ?? []).length > 0;
      expect(hasWeight || hasFocus).toBe(true);
    }
  });

  it('题材 id 不重复', () => {
    const ids = GENRE_TEMPLATES.map((genre) => genre.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('悬疑把伏笔逾期提到阻断级，玄幻不', () => {
    expect(genreProfile('suspense').gate?.['foreshadow-execution']).toBe('strict');
    expect(genreProfile('xuanhuan').gate?.['foreshadow-execution']).toBeUndefined();
  });

  it('玄幻把能力越界提到阻断级，悬疑不额外要求', () => {
    expect(genreProfile('xuanhuan').audit?.['ability-bound']).toBe('strict');
    expect(genreProfile('suspense').audit?.['ability-bound']).toBeUndefined();
  });

  it('未选题材时返回空配置，等价于全部 normal', () => {
    expect(genreProfile(null)).toEqual({});
    expect(genreProfile('')).toEqual({});
    expect(genreProfile('not-a-genre')).toEqual({});
    expect(findGenre('not-a-genre')).toBeNull();
  });
});

describe('门禁按题材升降级', () => {
  function overdueContext() {
    const chapters = [
      makeChapter({ ordinal: 1 }),
      makeChapter({ ordinal: 2 }),
      // 第 3 章声明了伏笔埋设，但计划第 2 章就该回收 —— 逾期
      makeChapter({ ordinal: 3, outline: '埋下玉佩伏笔' }),
    ];
    return {
      chapter: chapters[2]!,
      previousChapters: chapters.slice(0, 2),
      foreshadows: [
        makeForeshadow({
          id: 'f1',
          title: '玉佩线索',
          kind: 'main',
          status: 'planted',
          plannedResolveOrdinal: 2,
          resolutionMarkers: ['玉佩碎裂'],
        }),
      ],
    };
  }

  it('同一段正文：悬疑判为阻断，未选题材判为观察', () => {
    const context = overdueContext();
    const engine = new GateEngine([createForeshadowRule()]);

    const plain = engine.run(context);
    const suspense = engine.run(context, genreProfile('suspense'));

    const plainFindings = plain.results[0]!.findings;
    const suspenseFindings = suspense.results[0]!.findings;
    // 判定条数不变，说明只做了升降级、没有改判定逻辑
    expect(suspenseFindings).toHaveLength(plainFindings.length);
    expect(plainFindings.every((item) => item.blocking === false)).toBe(true);
    expect(suspenseFindings.some((item) => item.blocking === true)).toBe(true);
    expect(suspense.passed).toBe(false);
  });

  it('relaxed 把原本阻断的问题降为观察，报告整体通过', () => {
    const context = overdueContext();
    const engine = new GateEngine([createForeshadowRule()]);
    // 通用题材不设 foreshadow 权重，用显式策略验证 relaxed 语义
    const relaxed = engine.run(context, { gate: { 'foreshadow-execution': 'relaxed' } });
    expect(relaxed.results[0]!.findings.every((item) => !item.blocking)).toBe(true);
    expect(relaxed.passed).toBe(true);
  });

  it('off 直接过滤掉该规则的产出', () => {
    const context = overdueContext();
    const engine = new GateEngine([createForeshadowRule()]);
    const silenced = engine.run(context, { gate: { 'foreshadow-execution': 'off' } });
    expect(silenced.results[0]!.findings).toHaveLength(0);
  });
});

describe('事实审计按题材升降级', () => {
  it('玄幻把能力越界抬成 error，通用题材保持原级', () => {
    const { facts, books } = createTestHarness();
    const book = books.createBook({ title: '测试书', genreId: 'xuanhuan' });
    const chapter = books.createChapter({ bookId: book.id, title: '第一章', ordinal: 1 });
    books.updateChapterSpec(chapter.id, {
      outline: '',
      volumeId: null,
      declaredCharacters: ['char-1'],
      declaredLocations: [],
      declaredForeshadows: [],
      emotionTags: [],
      hookType: null,
      strand: null,
      targetWords: null,
    });
    facts.createCharacter({
      id: 'char-1',
      bookId: book.id,
      name: '林风',
      initialState: { abilities: [{ id: 'ab-1', name: '御剑术', level: 1 }] },
    });
    const content = '林风眼神一凛，御剑术骤然突破，踏入中期境界。';
    books.updateChapterContent(chapter.id, content);

    const state = facts.loadState(book.id);
    const ctx = {
      chapter: { ...books.getChapter(chapter.id)!, content },
      facts: state,
      previousChapters: [],
    };

    const plain = new AuditEngine().audit(ctx);
    const xuanhuan = new AuditEngine().audit(ctx, genreProfile('xuanhuan'));

    const plainAbility = plain.issues.filter((issue) => issue.category === 'ability-bound');
    const strictAbility = xuanhuan.issues.filter((issue) => issue.category === 'ability-bound');
    expect(strictAbility).toHaveLength(plainAbility.length);
    if (plainAbility.length > 0) {
      expect(strictAbility.every((issue) => issue.severity === 'error')).toBe(true);
    }
    // 题材不应凭空制造问题：其他分类条数不变
    expect(xuanhuan.issues.length).toBe(plain.issues.length);
  });
});
