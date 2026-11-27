/** 设置、检索、导入、题材、AI 配置 */
export const settings: Record<string, string> = {
  // 题材（来自 src/domain/genres.ts，按中文原文匹配）
  玄幻: 'Xuanhuan',
  仙侠: 'Xianxia',
  悬疑: 'Mystery',
  都市: 'Urban',
  恐怖: 'Horror',
  通用: 'General',
  '力量体系明确、越阶代价清晰，强调资源与境界约束。':
    'Explicit power tiers, costly breakthroughs, tight resource and realm constraints.',
  '重因果与道心，飞升、天劫、师门伦理是核心约束。':
    'Karma and conviction drive everything; ascension, tribulation and sect ethics bind the plot.',
  '线索必须可回溯，伏笔逾期即失信，读者推理不能靠作者隐瞒。':
    'Every clue must be traceable; overdue foreshadowing breaks trust with the reader.',
  '现实规则优先，超自然元素必须有代价与隐藏机制。':
    'Real-world rules come first; the supernatural needs cost and concealment.',
  '未知优先于解释，规则一旦建立就必须被遵守。':
    'The unknown outranks explanation; once a rule is set, it must be obeyed.',
  '只保留最小写作纪律，适合现实、历史等未细分题材。':
    'Minimal discipline only, for realistic or historical fiction without a sub-genre.',

  // ── 作品设置 ──────────────────────────────────────────
  阻断定稿: 'blocks finalization',
  降为提示: 'down to advisory',
  不再检查: 'skipped',
  '门禁 {rule} → {level}': 'Gate {rule} → {level}',
  '审计 {rule} → {level}': 'Audit {rule} → {level}',
  作品名称不能为空: 'Book title is required',
  保存失败: 'Save failed',
  作品信息已保存: 'Book settings saved',
  生成大纲失败: 'Failed to generate the outline',
  '已生成卷纲建议（{model}），确认后再保存':
    'Outline suggestion ready ({model}) — review it, then save',
  应用题材失败: 'Failed to apply the genre',
  '已切换题材为「{name}」，补写 {n} 条世界规则，门禁与审计侧重已生效':
    'Genre switched to “{name}”: {n} world rule(s) added and the gate/audit focus is now active',
  清除题材失败: 'Failed to clear the genre',
  '已清除题材，门禁与审计恢复默认严格度（已写入的世界规则保留）':
    'Genre cleared — gates and audit are back to default strictness (world rules already written are kept)',
  '删除作品《{title}》？\n\n这会删除全部章节、事实源、快照与检索索引，且无法恢复。':
    'Delete the book “{title}”?\n\nThis removes every chapter, all fact-source data, snapshots and the search index. It cannot be undone.',
  题材规则集: 'Genre rule set',
  '当前：{name}': 'Current: {name}',
  '选择题材（可选）': 'Choose a genre (optional)',
  应用题材: 'Apply genre',
  清除: 'Clear',
  '侧重：{summary}': 'Focus: {summary}',
  '题材决定门禁与审计的松紧（例如悬疑把「伏笔逾期」提到阻断级、玄幻把「能力越界」提到阻断级），并补写对应世界规则。只补充不覆盖，可重复应用。':
    'The genre decides how strict gates and audit are (Mystery raises overdue foreshadowing to blocking, Xuanhuan raises out-of-bounds abilities), and adds the matching world rules. It only adds — never overwrites — and can be applied repeatedly.',
  '主线、卷结构、核心冲突、结局方向…': 'Main plot, volume structure, core conflict, ending direction…',
  '生成中…': 'Generating…',
  'AI 生成卷纲建议': 'AI outline suggestion',
  '生成结果只填入文本框，需你确认后保存':
    'The result is only placed in the text box — save it yourself once you are happy',
  删除作品: 'Delete book',

  // ── 导入旧稿 ──────────────────────────────────────────
  选择文件失败: 'Failed to pick the file',
  解析仓库失败: 'Failed to parse the vault',
  '解析到 {n} 章，来自 {f} 个文件': 'Parsed {n} chapter(s) from {f} file(s)',
  'Obsidian 仓库（{n} 个文件）': 'Obsidian vault ({n} files)',
  解析失败: 'Parsing failed',
  '解析到 {n} 章，约 {w} 字': 'Parsed {n} chapter(s), about {w} words',
  粘贴稿件: 'Pasted text',
  请先粘贴稿件内容: 'Paste the manuscript first',
  '解析到 {n} 章': 'Parsed {n} chapter(s)',
  '将导入 {n} 章、约 {w} 字，追加到作品末尾。\n\n不会自动反推角色/伏笔，事实源需后续手工补齐或使用 AI 反推。是否继续？':
    'About to import {n} chapter(s), roughly {w} words, appended to the end of the book.\n\nCharacters and foreshadows are not extracted automatically — fill in the facts later by hand or with AI extraction. Continue?',
  导入失败: 'Import failed',
  '已导入 {n} 章（第 {a}–{b} 章）': 'Imported {n} chapter(s) (chapters {a}–{b})',
  '支持 TXT / Markdown，按「第 N 章」「Chapter N」「# 标题」拆分。导入只追加正文，不覆盖现有章节。':
    'Supports TXT / Markdown, split on “第 N 章”, “Chapter N” or “# Heading”. Importing only appends text — existing chapters are never overwritten.',
  '选择文件…': 'Choose file…',
  '选 Obsidian 仓库…': 'Choose an Obsidian vault…',
  未选择文件: 'No file selected',
  '已跳过目录：{dirs}。': 'Skipped folders: {dirs}.',
  '每个 .md 视为一章；文件内若已有「第 N 章 / # 标题」会继续拆分。':
    'Each .md counts as one chapter; files that already contain “第 N 章 / # Heading” are split further.',
  或直接粘贴稿件: 'Or paste the manuscript',
  '粘贴整本旧稿…': 'Paste the whole manuscript…',
  解析粘贴内容: 'Parse pasted text',
  不归入卷: 'No volume',
  '约 {n} 字': 'about {n} words',
  '仅显示前 {limit} 章，导入时会写入全部 {n} 章。':
    'Only the first {limit} chapters are shown; all {n} will be imported.',
  确认导入: 'Import',

  // ── AI 设置 ───────────────────────────────────────────
  写作: 'Writing',
  'AI 审稿': 'AI review',
  大纲建议: 'Outline suggestions',
  '加载 AI 配置失败': 'Failed to load the AI configuration',
  模型配置: 'Models',
  系统加密可用: 'System encryption available',
  '系统加密不可用（禁止保存密钥）': 'System encryption unavailable (keys cannot be saved)',
  '支持 OpenAI 兼容端点（Ollama / LM Studio / OpenAI）与 Anthropic Messages。密钥经系统加密后单独存放，配置文件只保存引用 id。':
    'Works with OpenAI-compatible endpoints (Ollama / LM Studio / OpenAI) and Anthropic Messages. API keys are stored separately after system encryption; the config file only holds a reference id.',
  已配置密钥: 'Key configured',
  无密钥: 'No key',
  测试连接: 'Test connection',
  还没有配置模型: 'No models configured yet',
  编辑模型: 'Edit model',
  新增模型: 'New model',
  '例如：本地 Qwen': 'e.g. Local Qwen',
  协议: 'Protocol',
  'OpenAI 兼容': 'OpenAI-compatible',
  'Embedding（OpenAI 兼容）': 'Embedding (OpenAI-compatible)',
  模型名: 'Model name',
  上下文窗口: 'Context window',
  '本地 Ollama 模型会作为 num_ctx 生效，太小会截断提示词':
    'For local Ollama models this becomes num_ctx; too small and prompts get truncated',
  'API Key（留空表示不修改）': 'API key (leave blank to keep unchanged)',
  '最大输出 token': 'Max output tokens',
  添加模型: 'Add model',
  取消编辑: 'Cancel editing',
  用途分配: 'Purpose assignment',
  '写作、审稿、大纲、Embedding 可分别指定模型；未指定时对应 AI 功能不可用。':
    'Writing, review, outline and embedding can each use a different model; an unassigned purpose simply disables that AI feature.',
  未配置: 'Not configured',
  '超时（ms）': 'Timeout (ms)',
  非流式重试次数: 'Non-streaming retries',
  '重试间隔基数（ms）': 'Retry backoff base (ms)',
  保存运行参数: 'Save runtime settings',
  '请填写名称、base_url 与模型名': 'Name, base_url and model name are required',
  '系统加密不可用，拒绝保存密钥': 'System encryption unavailable — refusing to store the key',
  保存模型失败: 'Failed to save the model',
  '模型已保存，密钥已加密存储': 'Model saved; the key is stored encrypted',
  '删除该模型？其加密密钥也会一并删除，无法恢复。':
    'Delete this model? Its encrypted key is deleted too and cannot be recovered.',
  删除模型失败: 'Failed to delete the model',
  模型已删除: 'Model deleted',
  设置默认模型失败: 'Failed to set the default model',
  保存运行参数失败: 'Failed to save runtime settings',
  运行参数已保存: 'Runtime settings saved',
  '测试中…': 'Testing…',
  测试失败: 'Test failed',
};

