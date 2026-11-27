import { describe, expect, it } from 'vitest';
import {
  GateEngine,
  GateRule,
  countCliches,
  countWords,
  createAiTraceRule,
  createEmotionRhythmRule,
  createForeshadowRule,
  createHookRotationRule,
  createRepetitionRule,
  createWordCountRule,
  type GateContext,
} from '../src/gates/index.js';
import { chineseText, makeChapter, makeForeshadow } from './helpers.js';

function context(overrides: Partial<GateContext> = {}): GateContext {
  return {
    chapter: makeChapter(),
    previousChapters: [],
    foreshadows: [],
    ...overrides,
  };
}

function findingsOf(rule: GateRule, ctx: GateContext) {
  return rule.check(ctx).findings;
}

describe('确定性门禁 · 字数实测', () => {
  it('中文按字、英文按词计数，标点不计', () => {
    expect(countWords('你好世界，hello world！')).toBe(4 + 2);
    expect(countWords('1234')).toBe(1);
  });

  it('字数偏差记为 observation，不阻断定稿', () => {
    const rule = createWordCountRule();
    const low = findingsOf(rule, context({ chapter: makeChapter({ content: '短', targetWords: 3000 }) }));
    expect(low.some((item) => item.severity === 'warning')).toBe(true);
    expect(low.every((item) => item.blocking === false)).toBe(true);

    const high = findingsOf(
      rule,
      context({ chapter: makeChapter({ content: chineseText(3000), targetWords: 1000 }) }),
    );
    expect(high.some((item) => item.severity === 'warning')).toBe(true);
    expect(high.every((item) => item.blocking === false)).toBe(true);
  });

  it('空白正文直接拦截', () => {
    const findings = findingsOf(createWordCountRule(), context());
    expect(findings[0]?.message).toContain('为空');
  });
});

describe('确定性门禁 · 伏笔执行率', () => {
  it('正文出现证据词才认定回收成立', () => {
    const rule = createForeshadowRule();
    const foreshadow = makeForeshadow();
    const ctx = context({
      chapter: makeChapter({
        content: `少年握紧玉佩，只听玉佩碎裂的声音。`,
        declaredForeshadows: [{ foreshadowId: 'fs-1', action: 'resolve' }],
      }),
      foreshadows: [foreshadow],
    });
    const findings = findingsOf(rule, ctx);
    expect(findings.some((item) => item.severity === 'error')).toBe(false);
    expect(findings.some((item) => item.details?.rate === 1)).toBe(true);
  });

  it('声明回收但正文没有证据词 → error', () => {
    const findings = findingsOf(
      createForeshadowRule(),
      context({
        chapter: makeChapter({
          content: chineseText(200),
          declaredForeshadows: [{ foreshadowId: 'fs-1', action: 'resolve' }],
        }),
        foreshadows: [makeForeshadow()],
      }),
    );
    expect(findings.some((item) => item.severity === 'error' && item.message.includes('未出现任何证据词'))).toBe(true);
  });

  it('未定义证据词时无法核对，降级为 warning 而不是放行', () => {
    const findings = findingsOf(
      createForeshadowRule(),
      context({
        chapter: makeChapter({
          content: chineseText(200),
          declaredForeshadows: [{ foreshadowId: 'fs-1', action: 'resolve' }],
        }),
        foreshadows: [makeForeshadow({ resolutionMarkers: [] })],
      }),
    );
    expect(findings.some((item) => item.severity === 'warning' && item.message.includes('未定义回收证据词'))).toBe(
      true,
    );
  });

  it('逾期主线伏笔高亮，支线不强制提醒', () => {
    const findings = findingsOf(
      createForeshadowRule(),
      context({
        chapter: makeChapter({ ordinal: 10, content: chineseText(200) }),
        foreshadows: [
          makeForeshadow({ id: 'main', kind: 'main', plannedResolveOrdinal: 5 }),
          makeForeshadow({ id: 'sub', kind: 'sub', plannedResolveOrdinal: 4 }),
        ],
      }),
    );
    expect(findings.filter((item) => item.message.includes('逾期')).map((item) => item.details?.foreshadowId)).toEqual([
      'main',
    ]);
  });
});

describe('确定性门禁 · 钩子与情绪节奏', () => {
  it('连续三章同类型钩子触发轮换告警', () => {
    const findings = findingsOf(
      createHookRotationRule(),
      context({
        chapter: makeChapter({ ordinal: 4, hookType: 'cliffhanger' }),
        previousChapters: [
          makeChapter({ ordinal: 2, hookType: 'cliffhanger' }),
          makeChapter({ ordinal: 3, hookType: 'cliffhanger' }),
        ],
      }),
    );
    expect(findings.some((item) => item.message.includes('连续 3 章'))).toBe(true);
  });

  it('情绪标签单一或缺失时告警', () => {
    const rule = createEmotionRhythmRule();
    const single = findingsOf(
      rule,
      context({
        chapter: makeChapter({ ordinal: 4, emotionTags: ['压抑'] }),
        previousChapters: [
          makeChapter({ ordinal: 2, emotionTags: ['压抑'] }),
          makeChapter({ ordinal: 3, emotionTags: ['压抑'] }),
        ],
      }),
    );
    expect(single.some((item) => item.message.includes('单一') || item.message.includes('连续'))).toBe(true);

    const missing = findingsOf(rule, context());
    expect(missing.some((item) => item.message.includes('未标注情绪标签'))).toBe(true);
  });
});

describe('确定性门禁 · 重复与 AI 痕迹', () => {
  it('识别章节内高频四字片段', () => {
    const repeated = '他缓缓走向那座古老的石门'.repeat(5);
    const findings = findingsOf(
      createRepetitionRule(),
      context({ chapter: makeChapter({ content: repeated }) }),
    );
    expect(findings.some((item) => item.severity === 'warning' && item.message.includes('高频重复'))).toBe(true);
  });

  it('统计套话密度并检测段落等长', () => {
    expect(countCliches('他深吸一口气，嘴角勾起一抹笑意，不禁倒吸一口凉气。他深吸一口气。')).toBeGreaterThanOrEqual(2);

    const paragraphs = Array.from({ length: 6 }, () => '他缓缓走进房间看到桌上的信').join('\n\n');
    const findings = findingsOf(
      createAiTraceRule(),
      context({ chapter: makeChapter({ content: paragraphs }) }),
    );
    expect(findings.some((item) => item.message.includes('段落长度过于整齐'))).toBe(true);
  });

  it('连续公式化转折触发告警', () => {
    const content = '然而他并未退缩。\n\n就在这时风声骤起。\n\n突然一道黑影掠过。';
    const findings = findingsOf(createAiTraceRule(), context({ chapter: makeChapter({ content }) }));
    expect(findings.some((item) => item.message.includes('公式化转折'))).toBe(true);
  });
});

describe('门禁引擎', () => {
  it('仅在存在 error 时拦截，warning 交由作者裁决', () => {
    const engine = new GateEngine([
      createWordCountRule(),
      createHookRotationRule(),
    ]);
    const report = engine.run(
      context({
        chapter: makeChapter({ content: chineseText(2000), targetWords: 2000, hookType: 'none' }),
      }),
    );
    expect(report.passed).toBe(true);
    expect(report.results.some((item) => item.findings.some((f) => f.severity === 'warning'))).toBe(true);
    expect(GateEngine.blockers(report)).toHaveLength(0);
  });

  it('伏笔声明回收但无证据词 → 阻断定稿', () => {
    const report = new GateEngine([createForeshadowRule()]).run(
      context({
        chapter: makeChapter({
          content: chineseText(2000),
          declaredForeshadows: [{ foreshadowId: 'fs-1', action: 'resolve' }],
        }),
        foreshadows: [makeForeshadow()],
      }),
    );
    expect(report.passed).toBe(false);
    expect(GateEngine.blockers(report).length).toBeGreaterThan(0);
  });
});
