/** 通过 contextBridge 暴露类型化 API；渲染进程不接触 Node/Electron 原生对象。 */

import type { ContextBridge, IpcRenderer } from 'electron';
import type { AiStreamEvent, InkforgeApi, MenuAction } from '../src/shared/ipc-contract.js';

// preload 同样以 CJS 输出，直接 require Electron 内置模块
const { contextBridge, ipcRenderer } = require('electron') as {
  contextBridge: ContextBridge;
  ipcRenderer: IpcRenderer;
};

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: InkforgeApi = {
  setLocale: (payload) => invoke('api:setLocale', payload),
  onMenuAction: (listener) => {
    const wrapped = (_event: unknown, action: MenuAction): void => listener(action);
    ipcRenderer.on('menu:action', wrapped);
    return () => ipcRenderer.removeListener('menu:action', wrapped);
  },
  listBooks: () => invoke('api:listBooks'),
  createBook: (payload) => invoke('api:createBook', payload),
  updateBook: (payload) => invoke('api:updateBook', payload),
  deleteBook: (payload) => invoke('api:deleteBook', payload),
  getWorkbench: (bookId) => invoke('api:getWorkbench', bookId),
  getChapterContent: (payload) => invoke('api:getChapterContent', payload),
  createChapter: (payload) => invoke('api:createChapter', payload),
  deleteChapter: (payload) => invoke('api:deleteChapter', payload),
  reorderChapters: (payload) => invoke('api:reorderChapters', payload),
  updateChapterSpec: (payload) => invoke('api:updateChapterSpec', payload),
  saveChapter: (payload) => invoke('api:saveChapter', payload),
  runChecks: (payload) => invoke('api:runChecks', payload),
  createVolume: (payload) => invoke('api:createVolume', payload),
  updateVolume: (payload) => invoke('api:updateVolume', payload),
  deleteVolume: (payload) => invoke('api:deleteVolume', payload),
  createCharacter: (payload) => invoke('api:createCharacter', payload),
  updateCharacter: (payload) => invoke('api:updateCharacter', payload),
  deleteCharacter: (payload) => invoke('api:deleteCharacter', payload),
  createForeshadow: (payload) => invoke('api:createForeshadow', payload),
  updateForeshadow: (payload) => invoke('api:updateForeshadow', payload),
  advanceForeshadow: (payload) => invoke('api:advanceForeshadow', payload),
  resolveForeshadow: (payload) => invoke('api:resolveForeshadow', payload),
  abandonForeshadow: (payload) => invoke('api:abandonForeshadow', payload),
  deleteForeshadow: (payload) => invoke('api:deleteForeshadow', payload),
  createWorldRule: (payload) => invoke('api:createWorldRule', payload),
  updateWorldRule: (payload) => invoke('api:updateWorldRule', payload),
  deleteWorldRule: (payload) => invoke('api:deleteWorldRule', payload),
  createTimelineEvent: (payload) => invoke('api:createTimelineEvent', payload),
  updateTimelineEvent: (payload) => invoke('api:updateTimelineEvent', payload),
  deleteTimelineEvent: (payload) => invoke('api:deleteTimelineEvent', payload),
  createResource: (payload) => invoke('api:createResource', payload),
  updateResource: (payload) => invoke('api:updateResource', payload),
  deleteResource: (payload) => invoke('api:deleteResource', payload),
  listGenres: () => invoke('api:listGenres'),
  applyGenre: (payload) => invoke('api:applyGenre', payload),
  createSnapshot: (payload) => invoke('api:createSnapshot', payload),
  previewSnapshotRestore: (payload) => invoke('api:previewSnapshotRestore', payload),
  restoreSnapshot: (payload) => invoke('api:restoreSnapshot', payload),
  searchChapters: (payload) => invoke('api:searchChapters', payload),
  indexEmbeddings: (payload) => invoke('api:indexEmbeddings', payload),
  pickManuscript: () => invoke('api:pickManuscript'),
  pickVault: () => invoke('api:pickVault'),
  parseVault: (payload) => invoke('api:parseVault', payload),
  previewManuscript: (payload) => invoke('api:previewManuscript', payload),
  importPath: (payload) => invoke('api:importPath', payload),
  /** Electron 32+ 移除了 File.path，拖拽文件必须用 webUtils 取真实路径 */
  getFilePath: (file) => {
    try {
      const { webUtils } = require('electron');
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  commitManuscript: (payload) => invoke('api:commitManuscript', payload),
  revealDataDir: () => invoke('api:revealDataDir'),
  revealPath: (payload) => invoke('api:revealPath', payload),
  backupDatabase: () => invoke('api:backupDatabase'),
  exportMarkdown: (payload) => invoke('api:exportMarkdown', payload),
  getAiConfig: () => invoke('api:getAiConfig'),
  saveAiModel: (payload) => invoke('api:saveAiModel', payload),
  removeAiModel: (payload) => invoke('api:removeAiModel', payload),
  setAiDefault: (payload) => invoke('api:setAiDefault', payload),
  updateAiRuntime: (payload) => invoke('api:updateAiRuntime', payload),
  testAiModel: (payload) => invoke('api:testAiModel', payload),
  generateWriting: (payload) => invoke('api:generateWriting', payload),
  cancelWriting: () => invoke('api:cancelWriting'),
  previewWritingDiff: (payload) => invoke('api:previewWritingDiff', payload),
  applyWritingDiff: (payload) => invoke('api:applyWritingDiff', payload),
  runLlmAudit: (payload) => invoke('api:runLlmAudit', payload),
  suggestOutline: (payload) => invoke('api:suggestOutline', payload),
  extractFacts: (payload) => invoke('api:extractFacts', payload),
  onAiEvent: (listener: (event: AiStreamEvent) => void) => {
    const wrapped = (_event: unknown, payload: AiStreamEvent): void => listener(payload);
    ipcRenderer.on('ai:event', wrapped);
    return () => ipcRenderer.removeListener('ai:event', wrapped);
  },
};

contextBridge.exposeInMainWorld('api', api);
