/**
 * 检索子页。
 * key 一律加引号：部分中文文案含「…」「。」「空格」，不带引号会被当成非法标识符。
 */
export const search: Record<string, string> = {
  '检索失败': 'Search failed',
  '检索中…': 'Searching…',
  '检索正文：人名、地名、道具、情节片段…':
    'Search the manuscript: names, places, items, plot fragments…',
  '全部卷': 'All volumes',
  '第 {n} 卷': 'Volume {n}',
  '向量召回': 'Vector recall',
  '重建向量索引': 'Rebuild vector index',
  '重建中…': 'Rebuilding…',
  '重建向量索引失败': 'Failed to rebuild the vector index',
  '向量索引完成：{model} 新索引 {a} 章，跳过 {b} 章，失败 {c} 章':
    'Vector index done: {model} — {a} chapter(s) indexed, {b} skipped, {c} failed',
  '向量：{a} / {b} 章已索引': 'Vector: {a} / {b} chapters indexed',
  '综合 {score}': 'Combined {score}',
  '向量 {score}': 'Vector {score}',
  '未配置 Embedding 模型，检索退化为 BM25':
    'No embedding model configured — retrieval falls back to BM25',
  '本次为混合检索': 'Hybrid retrieval',
  '本次为纯 BM25': 'Pure BM25',
  '没有匹配的章节': 'No matching chapters',
  '输入关键词开始检索。向量召回需要先在「AI 设置」里为':
    'Type a keyword to search. For vector recall, first assign a model to the',
  '用途指定模型。': 'purpose in AI settings.',
};
