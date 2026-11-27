/**
 * 应用菜单。
 *
 * 不设菜单时 Electron 会给一个**英文默认菜单**（File / Edit / View / Window / Help），
 * 中文界面下这就成了顶栏唯一的英文区域。所以这里显式构建菜单，并按当前语言切换文案。
 * 语言变化时由渲染层通过 IPC 触发重建。
 */

import { Menu, app, dialog, shell, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '../src/shared/ipc-contract.js';

export type MenuLocale = 'zh' | 'en';

interface Labels {
  file: string;
  newBook: string;
  importManuscript: string;
  backup: string;
  exportTxt: string;
  quit: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  view: string;
  reload: string;
  devTools: string;
  resetZoom: string;
  zoomIn: string;
  zoomOut: string;
  fullscreen: string;
  help: string;
  usage: string;
  openDataDir: string;
  about: string;
  aboutDetail: string;
}

const LABELS: Record<MenuLocale, Labels> = {
  zh: {
    file: '文件',
    newBook: '新建作品',
    importManuscript: '导入旧稿',
    backup: '备份书库',
    exportTxt: '导出 TXT',
    quit: '退出',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    view: '视图',
    reload: '重新加载',
    devTools: '开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullscreen: '全屏',
    help: '帮助',
    usage: '使用说明',
    openDataDir: '打开数据目录',
    about: '关于 Inkforge',
    aboutDetail: '面向长篇连载的小说创作工作台：事实源、门禁检查、AI 辅助。',
  },
  en: {
    file: 'File',
    newBook: 'New Book',
    importManuscript: 'Import Manuscript',
    backup: 'Back Up Library',
    exportTxt: 'Export TXT',
    quit: 'Quit',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    reload: 'Reload',
    devTools: 'Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Full Screen',
    help: 'Help',
    usage: 'Usage Guide',
    openDataDir: 'Open Data Folder',
    about: 'About Inkforge',
    aboutDetail: 'A writing workbench for long-form serial fiction: fact source, gate checks, AI assist.',
  },
};

export interface MenuHost {
  sendAction(action: MenuAction): void;
  openDataDir(): void;
  openUsageGuide(): void;
  getWindow(): Electron.BrowserWindow | null;
}

export function buildAppMenu(locale: MenuLocale, host: MenuHost): void {
  const l = LABELS[locale];
  const template: MenuItemConstructorOptions[] = [
    {
      label: l.file,
      submenu: [
        { label: l.newBook, accelerator: 'CmdOrCtrl+N', click: () => host.sendAction('new-book') },
        { label: l.importManuscript, accelerator: 'CmdOrCtrl+O', click: () => host.sendAction('import') },
        { type: 'separator' },
        { label: l.backup, click: () => host.sendAction('backup') },
        { label: l.exportTxt, click: () => host.sendAction('export-txt') },
        { type: 'separator' },
        { label: l.quit, role: 'quit' },
      ],
    },
    {
      label: l.edit,
      submenu: [
        { label: l.undo, role: 'undo' },
        { label: l.redo, role: 'redo' },
        { type: 'separator' },
        { label: l.cut, role: 'cut' },
        { label: l.copy, role: 'copy' },
        { label: l.paste, role: 'paste' },
        { label: l.selectAll, role: 'selectAll' },
      ],
    },
    {
      label: l.view,
      submenu: [
        { label: l.reload, role: 'reload' },
        { label: l.devTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: l.resetZoom, role: 'resetZoom' },
        { label: l.zoomIn, role: 'zoomIn' },
        { label: l.zoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: l.fullscreen, role: 'togglefullscreen' },
      ],
    },
    {
      label: l.help,
      submenu: [
        { label: l.usage, click: () => host.openUsageGuide() },
        { label: l.openDataDir, click: () => host.openDataDir() },
        { type: 'separator' },
        {
          label: l.about,
          click: () => {
            void dialog.showMessageBox(host.getWindow() ?? undefined!, {
              type: 'info',
              title: l.about,
              message: `Inkforge ${app.getVersion()}`,
              detail: l.aboutDetail,
            });
          },
        },
        {
          label: 'GitHub',
          click: () => void shell.openExternal('https://github.com/cypress666/Writer'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 菜单初始语言：与渲染层默认一致（中文）。
 * 渲染层挂载后会用自己保存的语言再发一次 setLocale 覆盖，
 * 所以这里不做系统语言推断——否则会出现「菜单英文、界面中文」的错位。
 */
export function defaultMenuLocale(): MenuLocale {
  return 'zh';
}
