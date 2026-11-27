/**
 * 英文词条总表。key 是中文原文，value 是英文。
 * 各区域分文件维护，避免一个巨型对象，新增区域只要在这里 spread 一次。
 */
import { shell } from './shell.js';
import { editor } from './editor.js';
import { facts } from './facts.js';
import { search } from './search.js';
import { settings } from './settings.js';

export const EN_MESSAGES: Record<string, string> = {
  ...shell,
  ...editor,
  ...facts,
  ...search,
  ...settings,
};
