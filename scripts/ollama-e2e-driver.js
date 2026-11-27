/**
 * 本地模型端到端驱动（在渲染进程执行，通过真实 IPC 链路）。
 * 占位符由 ollama-e2e.cjs 注入。
 */
(async () => {
  const MODEL = __MODEL__;
  const BASE_URL = __BASE_URL__;
  const BOOK_PATH = __BOOK_PATH__;
  const MAX_CHAPTERS = __MAX_CHAPTERS__;
  const SKIP_WRITING = __SKIP_WRITING__;

  const steps = [];
  const started = Date.now();

  async function step(name, fn) {
    const begin = Date.now();
    try {
      const value = await fn();
      steps.push({ name, ok: true, note: `${((Date.now() - begin) / 1000).toFixed(1)}s` });
      return value;
    } catch (error) {
      steps.push({ name, ok: false, error: String((error && error.message) || error), note: `${((Date.now() - begin) / 1000).toFixed(1)}s` });
      return undefined;
    }
  }

  function must(result, label) {
    if (!result) throw new Error(`${label}：无返回`);
    if (result.ok === false) throw new Error(result.error || `${label} 失败`);
    return result.data;
  }

  // 1) 配置本地模型
  const modelId = 'ollama-local';
  await step('保存 Ollama 模型配置', async () => {
    const current = must(await window.api.getAiConfig(), '读取配置');
    const existing = current.config.models.find((m) => m.id === modelId);
    must(
      await window.api.saveAiModel({
        model: {
          id: modelId,
          label: existing?.label || `Ollama ${MODEL}`,
          provider: 'openai-compatible',
          baseUrl: BASE_URL,
          model: MODEL,
          contextWindow: 8192,
          temperature: 0.8,
          maxTokens: 4096,
          credentialId: '',
          enabled: true,
        },
      }),
      '保存模型',
    );
    for (const purpose of ['writing', 'audit', 'outline']) {
      must(await window.api.setAiDefault({ purpose, modelId }), `设置 ${purpose} 用途`);
    }
  });

  await step('连通性测试', async () => {
    const result = must(await window.api.testAiModel({ modelId }), '连通性');
    if (!result.ok) throw new Error(result.message || '连接失败');
  });

  // 2) 建书 + 导入旧稿
  const bookTitle = `本地模型测试 · ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`;
  const book = await step('新建作品', async () => must(await window.api.createBook({ title: bookTitle, outline: '' }), '建书'));
  if (!book) return { steps };

  let chapterCount = 0;
  let firstChapterId = '';
  if (BOOK_PATH) {
    await step('按路径导入旧稿', async () => {
      const preview = must(await window.api.importPath({ path: BOOK_PATH }), '解析稿件');
      chapterCount = preview.chapters.length;
      const committed = must(
        await window.api.commitManuscript({
          bookId: book.id,
          fileName: preview.fileName,
          chapters: preview.chapters,
          volumeId: null,
        }),
        '写入章节',
      );
      steps.push({ name: `导入 ${committed.created} 章 / 约 ${preview.totalWords} 字`, ok: true });
      const workbench = must(await window.api.getWorkbench(book.id), '读工作台');
      firstChapterId = workbench.chapters[0]?.id || '';
    });
  }

  // 3) 旧稿反推
  let sample = '';
  await step('AI 反推设定候选', async () => {
    const data = must(await window.api.extractFacts({ bookId: book.id, maxChapters: MAX_CHAPTERS }), '反推');
    const p = data.proposal;
    steps.push({
      name: `反推结果：角色 ${p.characters.length} / 伏笔 ${p.foreshadows.length} / 规则 ${p.worldRules.length} / 时间线 ${p.timelineEvents.length} / 冲突 ${p.conflicts.length}`,
      ok: p.characters.length + p.worldRules.length > 0,
      note: `${data.model} · 读取 ${data.usedChapters.length} 章`,
      error: p.characters.length + p.worldRules.length > 0 ? undefined : '未抽出任何实体，检查提示词或模型能力',
    });
    sample = [
      ...p.characters.slice(0, 5).map((c) => `角色：${c.name}${c.aliases.length ? `（${c.aliases.join('/')}）` : ''} @${c.location || '?'}`),
      ...p.worldRules.slice(0, 3).map((r) => `规则：[${r.category}] ${r.rule}`),
      ...p.conflicts.slice(0, 3).map((c) => `冲突：${c.description}`),
    ].join('\n');
  });

  // 4) 大纲建议
  await step('AI 大纲建议', async () => {
    const data = must(await window.api.suggestOutline({ bookId: book.id }), '大纲');
    if (!data.outline || data.outline.length < 20) throw new Error('返回内容过短');
    steps.push({ name: `大纲输出 ${data.outline.length} 字（${data.model}）`, ok: true });
  });

  // 5) 生成正文（最慢，可按需跳过）
  let generatedId = firstChapterId;
  if (!SKIP_WRITING && firstChapterId) {
    await step('保存章纲声明', async () => {
      must(
        await window.api.updateChapterSpec({
          chapterId: firstChapterId,
          spec: { targetWords: 600, strand: 'quest', outline: '本章要写出主角心态转变的瞬间。' },
        }),
        '更新章纲',
      );
    });
    await step('AI 生成正文', async () => {
      const data = must(
        await window.api.generateWriting({ chapterId: firstChapterId, authorGuidance: '写 500 字左右的场景，保留原文语气。' }),
        '生成正文',
      );
      if (!data.content || data.content.length < 100) throw new Error('生成内容过短');
      must(
        await window.api.saveChapter({ chapterId: firstChapterId, content: data.content, status: 'draft' }),
        '保存正文',
      );
      steps.push({ name: `生成 ${data.content.length} 字（${data.model}，${data.tokens} tok）`, ok: true });
      generatedId = firstChapterId;
    });
  }

  // 6) 门禁 + AI 审稿
  if (generatedId) {
    await step('本地门禁 + 事实源审计', async () => {
      const data = must(await window.api.runChecks({ chapterId: generatedId }), '跑门禁');
      steps.push({
        name: `门禁 ${data.gate.passed ? '通过' : '有阻断'}（${data.gate.results.length} 项规则）`,
        ok: true,
      });
    });
    await step('AI 判断性审稿', async () => {
      const data = must(await window.api.runLlmAudit({ chapterId: generatedId }), 'AI 审稿');
      steps.push({ name: `AI 审稿 ${data.observations.length} 条观察（${data.model}）`, ok: true });
    });
  }

  steps.push({ name: `总计耗时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`, ok: true });
  return { steps, sample };
})();
