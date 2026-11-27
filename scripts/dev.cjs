/**
 * 开发模式启动器：与 launch.cjs 共用同一条环境清理规则。
 * electron-vite 会派生 Electron 子进程，父进程清掉 ELECTRON_RUN_AS_NODE 后子进程才会进入 GUI 模式。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const cli = path.resolve(__dirname, '../node_modules/electron-vite/bin/electron-vite.js');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cli, 'dev', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('error', (error) => {
  console.error('开发服务器启动失败:', error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
