/**
 * 伏笔执行率核对 —— 门禁中最关键的一条。
 *
 * 只相信正文里的证据词，不相信章纲的"已回收"声明。
 * 每条伏笔定义时要求 resolutionMarkers，作者声明回收时正文必须出现其中之一。
 */

import type { GateContext, GateFinding, GateRule } from './types.js';
import { finding, result } from './types.js';

export function createForeshadowRule(): GateRule {
  return {
    name: 'foreshadow-execution',
    check(context: GateContext) {
      const findings: GateFinding[] = [];
      const content = context.chapter.content ?? '';
      const byId = new Map(context.foreshadows.map((item) => [item.id, item]));
      let resolveDeclarations = 0;
      let evidencedResolves = 0;

      for (const use of context.chapter.declaredForeshadows) {
        const foreshadow = byId.get(use.foreshadowId);
        if (!foreshadow) {
          findings.push(
            finding('foreshadow-execution', 'error', `章纲引用了不存在的伏笔：${use.foreshadowId}`, {
              foreshadowId: use.foreshadowId,
            }),
          );
          continue;
        }

        if (use.action === 'resolve') {
          resolveDeclarations += 1;

          if (foreshadow.status === 'abandoned') {
            findings.push(
              finding('foreshadow-execution', 'warning', `伏笔「${foreshadow.title}」已标记放弃，本章又声明回收`, {
                foreshadowId: foreshadow.id,
              }),
            );
          }

          if (foreshadow.status === 'resolved' && foreshadow.resolvedInChapterId !== context.chapter.id) {
            findings.push(
              finding('foreshadow-execution', 'warning', `伏笔「${foreshadow.title}」此前已回收，本章重复声明回收`, {
                foreshadowId: foreshadow.id,
              }),
            );
          }

          const markers = use.evidenceOverride ?? foreshadow.resolutionMarkers;
          if (markers.length === 0) {
            findings.push(
              finding(
                'foreshadow-execution',
                'warning',
                `伏笔「${foreshadow.title}」未定义回收证据词，无法程序化核对`,
                { foreshadowId: foreshadow.id },
              ),
            );
            continue;
          }

          const matched = markers.filter((marker) => marker.length > 0 && content.includes(marker));
          if (matched.length === 0) {
            findings.push(
              finding(
                'foreshadow-execution',
                'error',
                `声明回收「${foreshadow.title}」，但正文未出现任何证据词（${markers.join(' / ')}）`,
                { foreshadowId: foreshadow.id, markers },
              ),
            );
          } else {
            evidencedResolves += 1;
            if (foreshadow.plantedInChapterId == null) {
              findings.push(
                finding('foreshadow-execution', 'error', `伏笔「${foreshadow.title}」无埋设记录，不能直接回收`, {
                  foreshadowId: foreshadow.id,
                }),
              );
            }
          }
        } else if (use.action === 'advance') {
          if (foreshadow.status === 'resolved' || foreshadow.status === 'abandoned') {
            findings.push(
              finding(
                'foreshadow-execution',
                'warning',
                `伏笔「${foreshadow.title}」状态为 ${foreshadow.status}，不应再声明推进`,
                { foreshadowId: foreshadow.id },
              ),
            );
          }
        } else if (use.action === 'plant') {
          if (foreshadow.status !== 'planted') {
            findings.push(
              finding(
                'foreshadow-execution',
                'warning',
                `伏笔「${foreshadow.title}」当前状态为 ${foreshadow.status}，重复声明埋设`,
                { foreshadowId: foreshadow.id },
              ),
            );
          }
        }
      }

      // 逾期未回收的主线伏笔：高亮但不强制拦截（支线可放弃）
      const overdue = context.foreshadows.filter(
        (item) =>
          item.kind === 'main' &&
          (item.status === 'planted' || item.status === 'advancing') &&
          item.plannedResolveOrdinal != null &&
          item.plannedResolveOrdinal < context.chapter.ordinal &&
          item.resolvedInChapterId == null,
      );
      for (const item of overdue) {
        findings.push(
          finding(
            'foreshadow-execution',
            'warning',
            `主线伏笔「${item.title}」已逾期未回收（计划第 ${item.plannedResolveOrdinal} 章，当前第 ${context.chapter.ordinal} 章）`,
            { foreshadowId: item.id, plannedResolveOrdinal: item.plannedResolveOrdinal },
          ),
        );
      }

      if (resolveDeclarations > 0) {
        const rate = evidencedResolves / resolveDeclarations;
        findings.push(
          finding('foreshadow-execution', 'info', `本章伏笔回收执行率 ${Math.round(rate * 100)}%`, {
            rate,
            resolved: evidencedResolves,
            declared: resolveDeclarations,
          }),
        );
      }

      return result('foreshadow-execution', findings);
    },
  };
}
