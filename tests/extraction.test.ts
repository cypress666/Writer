import { describe, expect, it } from 'vitest';
import { extractJsonBlock, parseFactProposal } from '../src/ai/extraction.js';

const SAMPLE = {
  characters: [
    {
      name: '佐城涉',
      aliases: ['涉', '佐城'],
      location: '教室',
      abilities: [{ name: '观察', level: 2 }],
      knownFacts: ['夏川爱华坐在前排'],
    },
  ],
  foreshadows: [
    { title: '夏川的伞', kind: 'main', plannedResolveOrdinal: 12, resolutionMarkers: ['伞', '雨'] },
  ],
  worldRules: [{ category: '世界法则', rule: '这里没有魔法', priority: 100 }],
  timelineEvents: [{ chapterOrdinal: 1, storyTime: '开学第一天', description: '涉决定不再纠缠' }],
  conflicts: [{ chapterOrdinal: 3, description: '第3章说主角16岁，第9章写18岁' }],
};

describe('旧稿反推结果解析', () => {
  it('解析标准 JSON', () => {
    const result = parseFactProposal(JSON.stringify(SAMPLE));
    expect(result.characters[0]?.name).toBe('佐城涉');
    expect(result.characters[0]?.abilities[0]).toEqual({ name: '观察', level: 2 });
    expect(result.foreshadows[0]?.plannedResolveOrdinal).toBe(12);
    expect(result.worldRules[0]?.priority).toBe(100);
    expect(result.timelineEvents[0]?.chapterOrdinal).toBe(1);
    expect(result.conflicts).toHaveLength(1);
  });

  it('容忍 Markdown 围栏与前后解释文字', () => {
    const raw = `好的，下面是结果：\n\`\`\`json\n${JSON.stringify(SAMPLE)}\n\`\`\`\n希望有帮助。`;
    const result = parseFactProposal(raw);
    expect(result.characters).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
  });

  it('非法 JSON 返回空结果而不抛错', () => {
    const result = parseFactProposal('模型跑飞了，这里没有任何 JSON');
    expect(result.characters).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('丢弃缺名字的角色，保留其余合法条目', () => {
    const result = parseFactProposal(
      JSON.stringify({
        characters: [{ name: '' }, { name: '夏川爱华' }, { location: '操场' }],
      }),
    );
    expect(result.characters.map((c) => c.name)).toEqual(['夏川爱华']);
  });

  it('别名去重并截断到上限', () => {
    const result = parseFactProposal(
      JSON.stringify({
        characters: [{ name: 'A', aliases: ['甲', '甲', '乙', '', '丙', '丁', '戊', '己', '庚', '辛'] }],
      }),
    );
    expect(result.characters[0]?.aliases).toEqual(['甲', '乙', '丙', '丁', '戊', '己']);
  });

  it('冲突支持纯字符串数组', () => {
    const result = parseFactProposal(JSON.stringify({ conflicts: ['前后战力不一致'] }));
    expect(result.conflicts[0]).toEqual({ chapterOrdinal: null, description: '前后战力不一致' });
  });

  it('超量条目按上限截断', () => {
    const characters = Array.from({ length: 60 }, (_, index) => ({ name: `角色${index}` }));
    const result = parseFactProposal(JSON.stringify({ characters }));
    expect(result.characters).toHaveLength(40);
  });

  it('优先级被夹在合理区间', () => {
    const result = parseFactProposal(
      JSON.stringify({ worldRules: [{ rule: '天不生我', priority: 9999 }, { rule: '负数', priority: -5 }] }),
    );
    expect(result.worldRules[0]?.priority).toBe(200);
    expect(result.worldRules[1]?.priority).toBe(0);
  });

  it('extractJsonBlock 能从裸文本里取出对象', () => {
    expect(extractJsonBlock('前言 {"a":1} 后记')).toBe('{"a":1}');
    expect(extractJsonBlock('没有对象')).toBeNull();
  });
});
