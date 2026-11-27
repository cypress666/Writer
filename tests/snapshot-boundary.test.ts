import { describe, expect, it } from 'vitest';
import { diffStates } from '../src/db/snapshot-repository.js';
import { findConflictParagraphs } from '../src/db/snapshot-preview.js';
import { createTestHarness } from './helpers.js';

describe('快照回退边界', () => {
  it('快照不存在时直接报错，不产生空回退', () => {
    const { snapshots } = createTestHarness();
    expect(() => snapshots.restore('missing-snapshot')).toThrow('Snapshot not found');
  });

  it('快照后新增的角色会在回退时移除，正文不受影响', () => {
    const { books, facts, snapshots } = createTestHarness();
    facts.createCharacter({
      id: 'char-old',
      bookId: 'book-1',
      name: '林风',
      initialState: { location: '青云城' },
    });
    const snapshot = snapshots.create('book-1', '回退点', 'ch-1');
    books.updateChapterContent('ch-1', '林风站在青云城门口，雾气很重。');
    const contentBefore = books.getChapter('ch-1')?.content;

    facts.createCharacter({
      id: 'char-new',
      bookId: 'book-1',
      name: '后来 added',
      initialState: { location: '天魔宗' },
    });
    expect(facts.listCharacters('book-1')).toHaveLength(2);

    const changes = snapshots.restore(snapshot.id);
    expect(changes.length).toBeGreaterThan(0);
    expect(facts.listCharacters('book-1').map((c) => c.id)).toEqual(['char-old']);
    expect(facts.getCharacterState('char-old')?.location).toBe('青云城');
    expect(books.getChapter('ch-1')?.content).toBe(contentBefore);
  });

  it('回退预览能列出正文中仍使用旧状态值的段落', () => {
    const { books, facts, snapshots } = createTestHarness();
    facts.createCharacter({
      id: 'char-old',
      bookId: 'book-1',
      name: '林风',
      initialState: { location: '青云城' },
    });
    const snapshot = snapshots.create('book-1', '旧状态', 'ch-1');
    facts.updateCharacterState('book-1', 'char-old', { location: '天魔宗' }, 'ch-2');

    const changes = diffStates(facts.loadState('book-1'), snapshot.state);
    // 快照后事实已改为天魔宗，正文也跟着写了天魔宗；回退到快照后这些段落会冲突
    const content = '林风离开青云城。\n\n他在天魔宗醒来，想起旧事。';
    books.updateChapterContent('ch-1', content);

    const conflicts = findConflictParagraphs(content, changes);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.paragraphIndex).toBe(1);
    expect(conflicts[0]?.reason).toContain('天魔宗');
    expect(conflicts[0]?.reason).toContain('回退后');
  });
});
