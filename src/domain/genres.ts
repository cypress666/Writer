/**
 * 题材规则集：只提供「可编辑的世界规则初始值」+「门禁/审计侧重」，
 * 不绑定剧情模板。作者应用后仍可在事实源中逐条修改/删除。
 */

import type { AuditCategory } from '../audit/types.js';

export interface GenreRuleTemplate {
  category: string;
  rule: string;
  priority: number;
}

/** 门禁规则名，与 src/gates 中各规则产出 finding 时的 rule 字段保持一致 */
export type GateRuleName =
  | 'word-count'
  | 'foreshadow-execution'
  | 'hook-rotation'
  | 'emotion-rhythm'
  | 'strand-rhythm'
  | 'repetition'
  | 'ai-trace';

/**
 * 严格度。门禁产出的 finding 本身已带 blocking，题材只做「升降级」，
 * 不改判定逻辑 —— 否则同一段正文在不同题材下阈值会漂移，无法复现。
 * - strict：升级为阻断定稿，并把 info 抬成 warning、warning 抬成 error
 * - relaxed：降为观察项（不阻断），并把 error 降为 warning
 * - off：整条规则忽略
 */
export type RuleLevel = 'strict' | 'normal' | 'relaxed' | 'off';

export interface GenreProfile {
  /** 门禁侧重：例如悬疑把「伏笔逾期」提到阻断级 */
  gate?: Partial<Record<GateRuleName, RuleLevel>>;
  /** 本地事实审计侧重：例如玄幻把「能力越界」提到阻断级 */
  audit?: Partial<Record<AuditCategory, RuleLevel>>;
  /** LLM 审稿额外关注点，注入提示词。只写判断性内容，不写字数/条数这类脚本判定 */
  auditFocus?: string[];
}

export interface GenreTemplate {
  id: string;
  name: string;
  description: string;
  rules: GenreRuleTemplate[];
  profile: GenreProfile;
}

export const GENRE_TEMPLATES: GenreTemplate[] = [
  {
    id: 'xuanhuan',
    name: '玄幻',
    description: '力量体系明确、越阶代价清晰，强调资源与境界约束。',
    rules: [
      { category: '力量体系', rule: '境界分为炼气、筑基、金丹、元婴、化神；每境分初期/中期/后期。', priority: 100 },
      { category: '力量体系', rule: '越阶战斗必须有明确代价或外物支撑，不得无代价碾压。', priority: 100 },
      { category: '世界法则', rule: '灵气浓度决定修炼速度；贫瘠之地无法长期支撑高境界。', priority: 0 },
      { category: '社会规则', rule: '宗门资源按贡献分配，核心弟子享有优先权。', priority: 0 },
      { category: '禁忌', rule: '夺舍、血祭等禁术会留下可被追踪的痕迹。', priority: 0 },
    ],
    profile: {
      // 玄幻读者最不能容忍「境界忽然跳级」和「爽点连发到麻木」
      audit: { 'ability-bound': 'strict', 'state-drift': 'strict' },
      gate: { 'emotion-rhythm': 'strict', repetition: 'relaxed' },
      auditFocus: [
        '战力是否与事实源登记的境界一致，越阶取胜是否给了代价或外物支撑',
        '连续多章的爽点是否缺少冷却与铺垫，导致后续刺激失效',
        '同境界战斗的描写是否与已建立的境界差距自相矛盾',
      ],
    },
  },
  {
    id: 'xianxia',
    name: '仙侠',
    description: '重因果与道心，飞升、天劫、师门伦理是核心约束。',
    rules: [
      { category: '力量体系', rule: '修为越高，因果牵涉越重；杀伐需承担业力后果。', priority: 100 },
      { category: '世界法则', rule: '天劫强度与修士业力、道心坚定程度相关。', priority: 100 },
      { category: '社会规则', rule: '师门辈分与传承不可僭越，叛门者受追杀。', priority: 0 },
      { category: '禁忌', rule: '以凡人精血炼丹属魔道，正道宗门必追究。', priority: 0 },
      { category: '叙事约定', rule: '机缘与代价并存，不出现无来由的绝世传承。', priority: 0 },
    ],
    profile: {
      audit: { 'state-drift': 'strict', 'dead-character': 'strict' },
      gate: { 'emotion-rhythm': 'relaxed', 'strand-rhythm': 'strict' },
      auditFocus: [
        '因果与业力是否被当作硬约束，而不是随口一提的装饰',
        '角色道心变化是否有事件支撑，避免突然顿悟',
        '师门伦理冲突是否交代了立场与代价',
      ],
    },
  },
  {
    id: 'suspense',
    name: '悬疑',
    description: '线索必须可回溯，伏笔逾期即失信，读者推理不能靠作者隐瞒。',
    rules: [
      { category: '叙事约定', rule: '所有线索必须在正文中出现过，不得事后追加作者未写的信息。', priority: 100 },
      { category: '叙事约定', rule: '伏笔埋设后必须在计划章数内回收或明确宣判废弃。', priority: 100 },
      { category: '世界法则', rule: '角色的行动受已知信息限制，不能凭作者视角行动。', priority: 0 },
      { category: '禁忌', rule: '不得用「其实他早就知道」这类回溯补丁解释前文。', priority: 0 },
      { category: '叙事约定', rule: '每章至少推进一条线索或推翻一个既有假设。', priority: 0 },
    ],
    profile: {
      // 悬疑的失信成本最高：伏笔逾期、线索前后矛盾直接阻断定稿
      gate: { 'foreshadow-execution': 'strict', 'hook-rotation': 'strict', 'emotion-rhythm': 'relaxed' },
      audit: {
        'foreshadow-contradiction': 'strict',
        'timeline-conflict': 'strict',
        'location-conflict': 'strict',
      },
      auditFocus: [
        '线索是否在正文中可被读者看到，还是只存在于角色脑内',
        '推理链每一步是否都用了前文已给出的信息，有无作者视角作弊',
        '真相揭示是否建立在已埋设的证据上，而不是临时新增设定',
      ],
    },
  },
  {
    id: 'urban',
    name: '都市',
    description: '现实规则优先，超自然元素必须有代价与隐藏机制。',
    rules: [
      { category: '世界法则', rule: '现实社会中法律、金钱与舆论构成硬约束。', priority: 100 },
      { category: '世界法则', rule: '超自然能力若存在，必须隐藏于公众视野之外。', priority: 100 },
      { category: '社会规则', rule: '商业竞争遵循合同与资本逻辑，不靠武力直接解决。', priority: 0 },
      { category: '禁忌', rule: '能力暴露会导致组织介入与身份危机。', priority: 0 },
      { category: '叙事约定', rule: '日常细节要具体，避免只有冲突没有生活质感。', priority: 0 },
    ],
    profile: {
      audit: { 'location-conflict': 'strict' },
      gate: { 'ai-trace': 'strict', 'strand-rhythm': 'relaxed' },
      auditFocus: [
        '冲突解决是否符合现实规则（法律、金钱、人情），有无靠武力硬解',
        '超自然元素是否维持了隐藏前提，目击者的处理是否合理',
        '对白是否像真实都市人说话，有无翻译腔',
      ],
    },
  },
  {
    id: 'horror',
    name: '恐怖',
    description: '未知优先于解释，规则一旦建立就必须被遵守。',
    rules: [
      { category: '世界法则', rule: '诡异现象遵循固定规则，规则被说出后不可随意更改。', priority: 100 },
      { category: '世界法则', rule: '恐惧来源于未知与失控，不靠突然跳脸堆砌。', priority: 100 },
      { category: '禁忌', rule: '不要回应未知来源的呼唤，不要直视不可名状之物。', priority: 0 },
      { category: '叙事约定', rule: '信息揭示要分批，角色不能轻易获得全知视角。', priority: 0 },
      { category: '叙事约定', rule: '每个异常都要留下可回溯的物证或行为痕迹。', priority: 0 },
    ],
    profile: {
      audit: { 'state-drift': 'relaxed' },
      gate: { 'hook-rotation': 'relaxed', 'foreshadow-execution': 'strict' },
      auditFocus: [
        '诡异规则是否前后一致，有无为了制造惊吓而临时改设定',
        '恐惧是否来自信息缺失与失控感，而非单纯的血腥描写',
        '角色是否触犯了已建立的禁忌，触犯动机是否成立',
      ],
    },
  },
  {
    id: 'general',
    name: '通用',
    description: '只保留最小写作纪律，适合现实、历史等未细分题材。',
    rules: [
      { category: '叙事约定', rule: '角色行为必须有动机，不为了推进剧情而降智。', priority: 100 },
      { category: '叙事约定', rule: '世界规则一旦建立，后续不得随意打破。', priority: 100 },
      { category: '叙事约定', rule: '伏笔埋设后必须在计划章附近回收或明确放弃。', priority: 0 },
      { category: '叙事约定', rule: '章节结尾要有推动继续阅读的钩子。', priority: 0 },
    ],
    profile: {
      auditFocus: ['角色行为是否有可追溯的动机，有无为推进剧情而降智'],
    },
  },
];

export function findGenre(id: string): GenreTemplate | null {
  return GENRE_TEMPLATES.find((genre) => genre.id === id) ?? null;
}

/** 按 id 取侧重配置；未知题材返回空配置（等价于全部 normal） */
export function genreProfile(id: string | null | undefined): GenreProfile {
  if (!id) return {};
  return findGenre(id)?.profile ?? {};
}

interface GateLeveledFinding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  blocking: boolean;
}

function levelOf(
  policy: Partial<Record<string, RuleLevel>> | undefined,
  key: string,
): RuleLevel {
  if (!policy) return 'normal';
  return (policy as Record<string, RuleLevel | undefined>)[key] ?? 'normal';
}

/**
 * 门禁 finding 的严格度升降级。判定逻辑不随题材变化，只改「是否阻断」和「严重度」，
 * 保证「同一段正文 + 同一题材」结果可复现。
 */
export function applyGateLevel<T extends GateLeveledFinding>(
  findings: T[],
  policy: Partial<Record<string, RuleLevel>> | undefined,
): T[] {
  if (!policy) return findings;
  return findings.flatMap((item) => {
    switch (levelOf(policy, item.rule)) {
      case 'off':
        return [];
      case 'strict':
        return [
          { ...item, blocking: true, severity: item.severity === 'info' ? 'warning' : 'error' } as T,
        ];
      case 'relaxed':
        return [
          {
            ...item,
            blocking: false,
            severity: item.severity === 'error' ? 'warning' : item.severity,
          } as T,
        ];
      default:
        return [item];
    }
  });
}

interface AuditLeveledIssue {
  category: string;
  severity: 'error' | 'warning' | 'info';
}

/**
 * 审计 issue 的严格度升降级。审计没有 blocking 字段，靠 severity === 'error' 判阻断，
 * 所以 strict 抬成 error、relaxed 压到 warning（info 保持 info）。
 */
export function applyAuditLevel<T extends AuditLeveledIssue>(
  issues: T[],
  policy: Partial<Record<string, RuleLevel>> | undefined,
): T[] {
  if (!policy) return issues;
  return issues.flatMap((item) => {
    switch (levelOf(policy, item.category)) {
      case 'off':
        return [];
      case 'strict':
        return [{ ...item, severity: 'error' } as T];
      case 'relaxed':
        return [{ ...item, severity: item.severity === 'error' ? 'warning' : item.severity } as T];
      default:
        return [item];
    }
  });
}
