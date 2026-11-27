/**
 * 轻量 i18n。
 *
 * 设计取舍：直接用**中文原文当 key**，英文表做覆盖。
 * - 模板里写 `t('检查报告')`，中文环境原样返回，英文环境查表。
 * - 没翻译的词条自动回落中文，不会出现 key 泄漏或空白。
 * - 省掉「给 600 条文案起 key 名」的工作量和错配风险。
 * 代价：中文文案一旦改写，对应英文会静默失效——由 tests/i18n.test.ts 兜底检查。
 */

import { ref } from 'vue';
import { EN_MESSAGES } from './en/index.js';

export type Locale = 'zh' | 'en';

export const LOCALES: ReadonlyArray<{ id: Locale; label: string }> = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

const STORAGE_KEY = 'inkforge.locale';

/**
 * 默认中文：这是面向中文作者的工具，且界面文案本身以中文为准。
 * 不按 navigator.language 自动判断，避免英文系统上突然全变英文、把中文用户挡在门外。
 */
function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // localStorage 不可用（如被隐私策略禁用）时按默认处理
  }
  return 'zh';
}

export const locale = ref<Locale>(initialLocale());

/** 当前语言是否英文，模板里做条件文案时用 */
export function isEn(): boolean {
  return locale.value === 'en';
}

export function t(zh: string, params?: Record<string, string | number>): string {
  const dict = locale.value === 'en' ? EN_MESSAGES : null;
  let text = (dict && dict[zh]) || zh;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      text = text.split(`{${key}}`).join(String(value));
    }
  }
  return text;
}

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 存不了就只在本次会话生效
  }
  // 原生菜单在主进程里，需要同步重建，否则顶栏文案会和界面不一致
  void window.api?.setLocale?.({ locale: next });
}

export function toggleLocale(): void {
  setLocale(locale.value === 'zh' ? 'en' : 'zh');
}

/**
 * 列表分隔符。中文用顿号，英文用逗号加空格。
 * 直接拼 '、' 会让英文界面里出现「A、B」这种混排，所以统一走这里。
 */
export function listSep(): string {
  return locale.value === 'en' ? ', ' : '、';
}

/** 供测试与检查脚本使用：英文表里是否已有该词条 */
export function hasTranslation(zh: string): boolean {
  return Object.prototype.hasOwnProperty.call(EN_MESSAGES, zh);
}
