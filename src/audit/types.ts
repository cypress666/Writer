import type { Chapter, FactSourceState } from '../domain/models.js';

export type AuditSeverity = 'error' | 'warning' | 'info';

export type AuditCategory =
  | 'dead-character'
  | 'location-conflict'
  | 'ability-bound'
  | 'timeline-conflict'
  | 'foreshadow-contradiction'
  | 'state-drift';

export interface SuggestedAction {
  type:
    | 'update-character-location'
    | 'set-character-alive'
    | 'add-ability'
    | 'update-foreshadow'
    | 'add-timeline-event';
  payload: Record<string, unknown>;
}

export interface AuditIssue {
  id: string;
  severity: AuditSeverity;
  category: AuditCategory;
  message: string;
  /** 触发问题的原文片段，便于作者定位 */
  evidence: string;
  suggestion?: string;
  /** 可供 GUI 生成"一键修正事实源"的操作，是否执行由作者决定 */
  suggestedActions?: SuggestedAction[];
  details?: Record<string, unknown>;
}

export interface AuditReport {
  chapterId: string;
  issues: AuditIssue[];
  passed: boolean;
  checkedAt: string;
}

export interface AuditContext {
  chapter: Chapter;
  facts: FactSourceState;
  previousChapters: Chapter[];
}

export type NewAuditIssue = Omit<AuditIssue, 'id'>;

export interface AuditRule {
  readonly name: AuditCategory;
  check(context: AuditContext): NewAuditIssue[];
}
