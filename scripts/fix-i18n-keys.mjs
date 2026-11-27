/**
 * 一次性工具：把英文词表里未加引号的非法键补上引号。
 * 中文键看似是合法标识符，但只要含「…」「，」「。」「/」「空格」就必须加引号。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'src', 'renderer', 'i18n', 'en');
const IDENT = /^[\p{ID_Start}$][\p{ID_Continue}$]*$/u;

let changed = 0;
for (const file of readdirSync(DIR)) {
  if (!file.endsWith('.ts') || file === 'index.ts') continue;
  const path = join(DIR, file);
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = lines.map((line) => {
    const m = /^ {2}([^'"\s/*][^:]*?):(?=\s|$)(.*)$/u.exec(line);
    if (!m) return line;
    const key = m[1];
    if (IDENT.test(key)) return line;
    changed += 1;
    return `  '${key}':${m[2]}`;
  });
  writeFileSync(path, out.join('\n'));
}
console.log('quoted keys:', changed);
