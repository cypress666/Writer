/**
 * 旧稿 AI 反推：把 LLM 返回的设定候选解析成结构化提案。
 *
 * 设计原则：
 * - 只产出「候选」，绝不直接写库；采纳由作者在 UI 上逐项勾选。
 * - 解析必须容错：本地小模型经常带 ```json 围栏、多余解释、字段缺失或超量。
 * - 条数与字段长度都设上限，防止一次反推把事实源灌进几百条噪声。
 */

export interface AbilityProposal {
  name: string;
  level: number;
}

export interface CharacterProposal {
  name: string;
  aliases: string[];
  location: string | null;
  abilities: AbilityProposal[];
  knownFacts: string[];
}

export interface ForeshadowProposal {
  title: string;
  kind: 'main' | 'sub';
  plannedResolveOrdinal: number | null;
  resolutionMarkers: string[];
}

export interface WorldRuleProposal {
  category: string;
  rule: string;
  priority: number;
}

export interface TimelineProposal {
  chapterOrdinal: number | null;
  storyTime: string;
  description: string;
}

export interface ConflictNote {
  chapterOrdinal: number | null;
  description: string;
}

export interface FactProposalBody {
  characters: CharacterProposal[];
  foreshadows: ForeshadowProposal[];
  worldRules: WorldRuleProposal[];
  timelineEvents: TimelineProposal[];
  conflicts: ConflictNote[];
}

const LIMITS = {
  characters: 40,
  foreshadows: 30,
  worldRules: 30,
  timelineEvents: 40,
  conflicts: 20,
  aliases: 6,
  abilities: 8,
  knownFacts: 6,
  markers: 6,
  shortText: 60,
  midText: 200,
  longText: 400,
};

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const normalized = text(item, maxLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) break;
  }
  return out;
}

function ordinal(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d]/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.floor(parsed), 9999);
}

function abilities(value: unknown): AbilityProposal[] {
  if (!Array.isArray(value)) return [];
  const out: AbilityProposal[] = [];
  for (const item of value) {
    const name = text(typeof item === 'string' ? item : (item as { name?: unknown })?.name, LIMITS.shortText);
    if (!name) continue;
    const rawLevel = typeof item === 'object' && item ? (item as { level?: unknown }).level : 1;
    const level = Number(rawLevel);
    out.push({ name, level: Number.isFinite(level) && level > 0 ? Math.min(level, 99) : 1 });
    if (out.length >= LIMITS.abilities) break;
  }
  return out;
}

/** 从模型输出里抠出 JSON：去掉围栏，退化为首个 { 到最后一个 } 的切片 */
export function extractJsonBlock(raw: string): string | null {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

/**
 * 解析反推结果。任何单个条目解析失败都不应导致整批失败：
 * 无法识别的条目直接丢弃，其余照常返回。
 */
export function parseFactProposal(raw: string): FactProposalBody {
  const empty: FactProposalBody = {
    characters: [],
    foreshadows: [],
    worldRules: [],
    timelineEvents: [],
    conflicts: [],
  };
  const block = extractJsonBlock(raw);
  if (!block) return empty;

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(block) as Record<string, unknown>;
  } catch {
    return empty;
  }

  const characters: CharacterProposal[] = [];
  for (const item of Array.isArray(data.characters) ? data.characters : []) {
    const record = item as Record<string, unknown>;
    const name = text(record?.name, LIMITS.shortText);
    if (!name) continue;
    characters.push({
      name,
      aliases: textList(record.aliases, LIMITS.aliases, LIMITS.shortText),
      location: text(record.location, LIMITS.shortText) || null,
      abilities: abilities(record.abilities),
      knownFacts: textList(record.knownFacts, LIMITS.knownFacts, LIMITS.midText),
    });
    if (characters.length >= LIMITS.characters) break;
  }

  const foreshadows: ForeshadowProposal[] = [];
  for (const item of Array.isArray(data.foreshadows) ? data.foreshadows : []) {
    const record = item as Record<string, unknown>;
    const title = text(record?.title, LIMITS.midText);
    if (!title) continue;
    foreshadows.push({
      title,
      kind: record.kind === 'sub' ? 'sub' : 'main',
      plannedResolveOrdinal: ordinal(record.plannedResolveOrdinal),
      resolutionMarkers: textList(record.resolutionMarkers, LIMITS.markers, LIMITS.shortText),
    });
    if (foreshadows.length >= LIMITS.foreshadows) break;
  }

  const worldRules: WorldRuleProposal[] = [];
  for (const item of Array.isArray(data.worldRules) ? data.worldRules : []) {
    const record = item as Record<string, unknown>;
    const rule = text(record?.rule, LIMITS.longText);
    if (!rule) continue;
    const priority = Number(record.priority);
    worldRules.push({
      category: text(record.category, LIMITS.shortText) || '世界法则',
      rule,
      priority: Number.isFinite(priority) ? Math.max(0, Math.min(Math.floor(priority), 200)) : 0,
    });
    if (worldRules.length >= LIMITS.worldRules) break;
  }

  const timelineEvents: TimelineProposal[] = [];
  for (const item of Array.isArray(data.timelineEvents) ? data.timelineEvents : []) {
    const record = item as Record<string, unknown>;
    const description = text(record?.description, LIMITS.longText);
    if (!description) continue;
    timelineEvents.push({
      chapterOrdinal: ordinal(record.chapterOrdinal),
      storyTime: text(record.storyTime, LIMITS.shortText),
      description,
    });
    if (timelineEvents.length >= LIMITS.timelineEvents) break;
  }

  const conflicts: ConflictNote[] = [];
  for (const item of Array.isArray(data.conflicts) ? data.conflicts : []) {
    const record = item as Record<string, unknown>;
    const description =
      typeof item === 'string' ? text(item, LIMITS.longText) : text(record?.description, LIMITS.longText);
    if (!description) continue;
    conflicts.push({
      chapterOrdinal: typeof item === 'string' ? null : ordinal(record?.chapterOrdinal),
      description,
    });
    if (conflicts.length >= LIMITS.conflicts) break;
  }

  return { characters, foreshadows, worldRules, timelineEvents, conflicts };
}
