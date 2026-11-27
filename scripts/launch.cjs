/**
 * 应用启动器。
 *
 * 解决 WorkBuddy / 某些终端环境预设 ELECTRON_RUN_AS_NODE=1 的问题：
 * 该变量会让 electron.exe 以纯 Node 模式启动，导致 require('electron') 返回
 * 可执行文件路径字符串而非 Electron 模块，应用无法启动。
 * 启动器在 spawn 前显式清除该变量。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron');
const appDir = path.resolve(__dirname, '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [appDir], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (error) => {
  console.error('启动失败:', error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
