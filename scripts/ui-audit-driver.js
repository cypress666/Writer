/**
 * UI 巡检驱动脚本（在渲染进程上下文执行，不是 Node 模块）。
 *
 * 通过 window.api 走真实的 preload → 主进程 IPC 链路，逐项验证每个 handler；
 * 随后点击界面上的主要入口，捕获模板渲染期异常。
 * 返回 { steps, domSteps }。
 */
(async () => {
  const VAULT_PATH = __VAULT_PATH__;
  const MANUSCRIPT_PATH = __MANUSCRIPT_PATH__;
  const steps = [];
  const domSteps = [];

  async function step(name, fn) {
    try {
      const result = await fn();
      if (result && result.ok === false) throw new Error(result.error || '未知错误');
      steps.push({ name, ok: true });
      return result ? result.data : undefined;
    } catch (error) {
      steps.push({ name, ok: false, error: String((error && error.message) || error) });
      return undefined;
    }
  }

  /** 预期失败的步骤：AI 未配置模型时应当给出可读错误，而不是崩溃 */
  async function expectFailure(name, fn) {
    try {
      const result = await fn();
      if (result && result.ok === false) {
        steps.push({ name, ok: true, note: '按预期返回错误' });
        return;
      }
      steps.push({ name, ok: false, error: '本应失败但返回成功' });
    } catch (error) {
      steps.push({ name, ok: true, note: '按预期抛错' });
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---- 数据链路 ----
  const genres = await step('listGenres', () => window.api.listGenres());
  const book = await step('createBook(含题材规则)', () =>
    window.api.createBook({ title: '巡检·雾港灯塔', outline: '主角在雾港追查灯塔失踪案。', genreId: 'xuanhuan' }),
  );
  if (!book) return { steps, domSteps };

  await step('updateBook(改名+总纲)', () =>
    window.api.updateBook({ bookId: book.id, title: '巡检·雾港灯塔（改）', outline: '总纲已更新。' }),
  );

  const volume1 = await step('createVolume#1', () =>
    window.api.createVolume({ bookId: book.id, title: '第一卷 雾起', outline: '卷纲一' }),
  );
  const volume2 = await step('createVolume#2', () =>
    window.api.createVolume({ bookId: book.id, title: '第二卷 灯塔', outline: '卷纲二' }),
  );
  if (volume1) await step('updateVolume', () =>
    window.api.updateVolume({ volumeId: volume1.id, outline: '卷纲一（改）' }),
  );

  const chapter1 = await step('createChapter#1', () =>
    window.api.createChapter({
      bookId: book.id,
      ordinal: 1,
      title: '第一章 雾中来客',
      volumeId: volume1 ? volume1.id : null,
      outline: '主角登场。',
      targetWords: 3000,
      strand: 'quest',
    }),
  );
  const chapter2 = await step('createChapter#2', () =>
    window.api.createChapter({ bookId: book.id, ordinal: 2, title: '第二章 灯塔熄灭', volumeId: volume1 ? volume1.id : null }),
  );
  await step('createChapter#3', () =>
    window.api.createChapter({ bookId: book.id, ordinal: 3, title: '第三章 潮下回声' }),
  );

  if (chapter2) {
    await step('updateChapterSpec(标题/卷/章纲)', () =>
      window.api.updateChapterSpec({
        chapterId: chapter2.id,
        spec: { title: '第二章 灯塔熄灭（改）', volumeId: volume2 ? volume2.id : null, outline: '改后的章纲。' },
      }),
    );
    await step('saveChapter(正文+已审稿)', () =>
      window.api.saveChapter({
        chapterId: chapter2.id,
        content: '雾在灯塔周围凝成一层薄壳。\n\n他知道，今晚不会有人来。',
        status: 'reviewed',
        spec: { emotionTags: ['压抑'], hookType: 'cliffhanger', strand: 'quest', targetWords: 3000 },
      }),
    );
    await step('runChecks', () => window.api.runChecks({ chapterId: chapter2.id }));
  }

  await step('reorderChapters(拖拽重排)', async () => {
    const wb = await window.api.getWorkbench(book.id);
    if (!wb.ok) return wb;
    const ids = (wb.data.chapters || []).slice().sort((a, b) => a.ordinal - b.ordinal).map((c) => c.id);
    if (ids.length < 2) throw new Error('章节不足，无法验证重排');
    const reversed = [...ids].reverse();
    const result = await window.api.reorderChapters({ bookId: book.id, orderedChapterIds: reversed });
    if (!result.ok) return result;
    const after = await window.api.getWorkbench(book.id);
    const actual = (after.data.chapters || []).slice().sort((a, b) => a.ordinal - b.ordinal).map((c) => c.id);
    if (JSON.stringify(actual) !== JSON.stringify(reversed)) throw new Error('重排后章序与请求不一致');
    // 复原，避免影响后续基于章序的断言
    return window.api.reorderChapters({ bookId: book.id, orderedChapterIds: ids });
  });

  const character = await step('createCharacter', () =>
    window.api.createCharacter({
      bookId: book.id,
      name: '沈砚',
      aliases: ['老沈'],
      notes: '守塔人',
      initialLocation: '雾港',
    }),
  );
  if (character) {
    await step('updateCharacter(位置/能力/已知/生效章)', () =>
      window.api.updateCharacter({
        characterId: character.id,
        location: '灯塔顶层',
        abilities: [{ id: 'ab-1', name: '观测', level: 2 }],
        knownFacts: ['灯塔在退潮时熄灭'],
        isAlive: true,
        chapterId: chapter2 ? chapter2.id : null,
      }),
    );
  }

  const foreshadow = await step('createForeshadow', () =>
    window.api.createForeshadow({
      bookId: book.id,
      title: '灯塔的第七级台阶',
      kind: 'main',
      plannedResolveOrdinal: 3,
      resolutionMarkers: ['第七级', '台阶'],
    }),
  );
  if (foreshadow) {
    await step('updateForeshadow', () =>
      window.api.updateForeshadow({ foreshadowId: foreshadow.id, description: '踏上去会听见潮声。' }),
    );
    await step('advanceForeshadow', () =>
      window.api.advanceForeshadow({ foreshadowId: foreshadow.id, chapterId: chapter2 ? chapter2.id : null }),
    );
    await step('resolveForeshadow', () =>
      window.api.resolveForeshadow({ foreshadowId: foreshadow.id, chapterId: chapter2 ? chapter2.id : null }),
    );
  }

  const rule = await step('createWorldRule', () =>
    window.api.createWorldRule({ bookId: book.id, category: '世界法则', rule: '潮汐决定雾的浓度。', priority: 100 }),
  );
  if (rule) await step('updateWorldRule', () => window.api.updateWorldRule({ ruleId: rule.id, priority: 120 }));

  const event = await step('createTimelineEvent', () =>
    window.api.createTimelineEvent({
      bookId: book.id,
      chapterId: chapter2 ? chapter2.id : null,
      storyTime: '第一夜',
      storyOrder: 1,
      description: '灯塔熄灭',
    }),
  );
  if (event) await step('updateTimelineEvent', () => window.api.updateTimelineEvent({ eventId: event.id, storyTime: '第一夜（改）' }));

  const resource = await step('createResource', () =>
    window.api.createResource({ bookId: book.id, name: '铜钥匙', category: '道具', quantity: 1 }),
  );
  if (resource) await step('updateResource', () => window.api.updateResource({ resourceId: resource.id, quantity: 2 }));

  const snapshot = await step('createSnapshot', () =>
    window.api.createSnapshot({ bookId: book.id, label: '巡检快照', chapterId: chapter2 ? chapter2.id : null }),
  );
  if (snapshot) {
    await step('previewSnapshotRestore', () =>
      window.api.previewSnapshotRestore({ snapshotId: snapshot.id, chapterId: chapter2 ? chapter2.id : null }),
    );
    await step('restoreSnapshot', () => window.api.restoreSnapshot({ snapshotId: snapshot.id }));
  }

  if (chapter2) {
    await step('getChapterContent(按需正文)', async () => {
      const result = await window.api.getChapterContent({ chapterId: chapter2.id });
      if (!result.ok) return result;
      if (!(result.data || '').includes('雾在灯塔')) throw new Error('正文内容与写入不一致');
      return result;
    });
  }
  await step('getWorkbench 不含正文', async () => {
    const result = await window.api.getWorkbench(book.id);
    if (!result.ok) return result;
    const withContent = (result.data.chapters || []).filter((chapter) => chapter.content);
    if (withContent.length > 0) throw new Error(`工作台仍携带 ${withContent.length} 章正文`);
    if (!result.data.chapterWordCounts) throw new Error('缺少字数统计');
    return result;
  });

  await step('searchChapters', () => window.api.searchChapters({ bookId: book.id, query: '灯塔', limit: 10 }));
  await expectFailure('indexEmbeddings(未配置模型)', () => window.api.indexEmbeddings({ bookId: book.id }));
  await step('exportMarkdown(可读版 MD)', () => window.api.exportMarkdown({ bookId: book.id, format: 'md' }));
  await step('exportMarkdown(可读版 TXT)', () =>
    window.api.exportMarkdown({ bookId: book.id, format: 'txt' }),
  );
  await step('exportMarkdown(归档版)', () =>
    window.api.exportMarkdown({ bookId: book.id, format: 'md', mode: 'archive' }),
  );
  await step('importPath(拖拽路径导入)', async () => {
    const result = await window.api.importPath({ path: MANUSCRIPT_PATH });
    if (!result.ok) return result;
    if (result.data.chapters.length < 2) throw new Error('未按章节标题拆分');
    return result;
  });
  await expectFailure('extractFacts(未配置模型)', () => window.api.extractFacts({ bookId: book.id, maxChapters: 2 }));
  await step('parseVault(Obsidian 仓库)', async () => {
    const result = await window.api.parseVault({ folder: VAULT_PATH });
    if (!result.ok) return result;
    // 2 个单章文件 + 1 个内部含两章的文件 = 4 章
    if (result.data.chapters.length !== 4) throw new Error(`期望 4 章，实际 ${result.data.chapters.length}`);
    if (result.data.chapters[0].title !== '第1章 雾起') throw new Error('章节顺序未按文件名自然序');
    if (result.data.fileCount !== 3) throw new Error('文件计数未跳过 .obsidian');
    return result;
  });
  await step('backupDatabase(一致性快照)', async () => {
    const result = await window.api.backupDatabase();
    if (!result.ok) return result;
    if (!(result.data.sizeBytes > 0)) throw new Error('备份文件为空');
    return result;
  });
  await step('getWorkbench', () => window.api.getWorkbench(book.id));
  await step('getAiConfig', () => window.api.getAiConfig());
  await expectFailure('suggestOutline(未配置模型)', () => window.api.suggestOutline({ bookId: book.id }));
  await expectFailure('generateWriting(未配置模型)', () =>
    window.api.generateWriting({ chapterId: chapter2 ? chapter2.id : '', authorGuidance: '' }),
  );

  // ---- 界面点击巡检 ----
  async function click(selector, text) {
    // 首屏是异步渲染的，给最多 10 次机会（约 3 秒），避免启动时序造成的假失败
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const target = text ? nodes.find((node) => (node.textContent || '').includes(text)) : nodes[0];
      if (target) {
        target.click();
        await sleep(320);
        return;
      }
      await sleep(300);
    }
    throw new Error(`未找到元素 ${selector} ${text || ''}`);
  }

  async function domStep(name, fn) {
    try {
      await fn();
      domSteps.push({ name, ok: true });
    } catch (error) {
      domSteps.push({ name, ok: false, error: String((error && error.message) || error) });
    }
  }

  async function typeInto(selector, value) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`未找到输入框 ${selector}`);
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
  }

  await domStep('刷新书架', async () => {
    await click('.side-section-title .icon-btn');
    await sleep(400);
  });
  await domStep('书架卡片渲染', async () => {
    const cards = document.querySelectorAll('.shelf-card');
    if (cards.length < 2) throw new Error(`书架卡片数量异常：${cards.length}`);
  });
  await domStep('书架搜索过滤', async () => {
    await typeInto('.shelf-search', '不存在的书名');
    const none = document.querySelectorAll('.shelf-card:not(.shelf-new)').length;
    if (none !== 0) throw new Error('搜索未生效');
    await typeInto('.shelf-search', '巡检');
    const hit = document.querySelectorAll('.shelf-card:not(.shelf-new)').length;
    if (hit !== 1) throw new Error(`搜索命中数量异常：${hit}`);
  });
  await domStep('点击书架卡片进入工作台', () => click('.shelf-card'));
  await domStep('切换到 检查报告', () => click('.tabs button', '检查报告'));
  await domStep('切换到 事实源', () => click('.tabs button', '事实源'));
  await domStep('事实源子页：伏笔', () => click('.sub-tabs button', '伏笔'));
  await domStep('事实源子页：规则·时间线·资源', () => click('.sub-tabs button', '规则'));
  await domStep('事实源子页：大纲·分卷·收据', () => click('.sub-tabs button', '大纲'));
  await domStep('事实源子页：状态快照', () => click('.sub-tabs button', '状态快照'));
  await domStep('事实源子页：角色', () => click('.sub-tabs button', '角色'));
  await domStep('打开章节设置并关闭', async () => {
    await click('.header-actions button', '章节设置');
    await click('.modal-actions button', '取消');
  });
  await domStep('打开作品设置并关闭', async () => {
    await click('.side-book-title .icon-btn');
    await sleep(200);
    const buttons = Array.from(document.querySelectorAll('.modal button'));
    const close = buttons.find((node) => ['取消', '关闭'].includes((node.textContent || '').trim()));
    if (close) close.click();
    await sleep(200);
  });
  await domStep('全书检索页', () => click('.tabs button', '全书检索'));
  await domStep('侧栏按卷折叠/展开', async () => {
    const title = document.querySelector('.group-title');
    if (!title) throw new Error('未找到卷分组标题');
    title.click();
    await sleep(150);
    title.click();
    await sleep(150);
  });
  await domStep('章节条目可拖拽', async () => {
    const item = document.querySelector('.chapter-item');
    if (!item) throw new Error('未找到章节条目');
    if (item.getAttribute('draggable') !== 'true') throw new Error('章节条目未开启拖拽');
  });

  // ---- 清理 ----
  if (resource) await step('deleteResource', () => window.api.deleteResource({ resourceId: resource.id }));
  if (event) await step('deleteTimelineEvent', () => window.api.deleteTimelineEvent({ eventId: event.id }));
  if (rule) await step('deleteWorldRule', () => window.api.deleteWorldRule({ ruleId: rule.id }));
  if (foreshadow) await step('deleteForeshadow', () => window.api.deleteForeshadow({ foreshadowId: foreshadow.id }));
  if (character) await step('deleteCharacter', () => window.api.deleteCharacter({ characterId: character.id }));
  if (chapter2) await step('deleteChapter', () => window.api.deleteChapter({ chapterId: chapter2.id }));
  if (volume2) await step('deleteVolume', () => window.api.deleteVolume({ volumeId: volume2.id }));
  await step('deleteBook', () => window.api.deleteBook({ bookId: book.id }));
  await step('listBooks(应为空)', async () => {
    const result = await window.api.listBooks();
    if (!result.ok) return result;
    if ((result.data || []).length !== 0) throw new Error('清理后仍有作品残留');
    return result;
  });

  return { steps, domSteps, genres: (genres || []).length };
})();
