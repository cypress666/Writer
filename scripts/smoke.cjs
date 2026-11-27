/**
 * 无头启动烟测。
 *
 * 复用 launch.cjs 的环境清理规则，启动打包后的 Electron 应用：
 *  1. 等待主进程打印 [inkforge] ready（数据库与 IPC 就绪）
 *  2. 再给渲染层一段宽限期，捕获控制台 error 与页面加载失败
 *
 * CI 中可配合 xvfb-run 在 Linux 运行。
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron');
const appDir = path.resolve(__dirname, '..');
const timeoutMs = Number(process.env['SMOKE_TIMEOUT_MS'] ?? 30000);
const graceMs = Number(process.env['SMOKE_GRACE_MS'] ?? 4000);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// 主进程把渲染层控制台转发到 stdout，烟测才能看到模板运行时错误
env.INKFORGE_LOG_RENDERER = '1';

const child = spawn(electronPath, [appDir], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
let settled = false;
let graceTimer = null;
const rendererErrors = [];
const timer = setTimeout(() => finish(false, `启动超时（${timeoutMs}ms）`), timeoutMs);

function capture(chunk) {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('[renderer:error]')) rendererErrors.push(line.trim());
  }
  if (text.includes('[inkforge] ready') && graceTimer === null) {
    graceTimer = setTimeout(() => {
      if (rendererErrors.length > 0) {
        finish(false, `渲染层报错 ${rendererErrors.length} 条`);
      } else {
        finish(true);
      }
    }, graceMs);
  }
}

child.stdout.on('data', capture);
child.stderr.on('data', capture);

function stop() {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function finish(ok, message) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (graceTimer) clearTimeout(graceTimer);
  stop();
  if (ok) {
    console.log('[smoke] 应用启动成功：主进程就绪，渲染层无异常');
    process.exit(0);
  }
  console.error(`[smoke] 应用启动失败：${message ?? ''}`);
  if (rendererErrors.length > 0) console.error(rendererErrors.join('\n'));
  if (output.trim()) console.error(output.trim());
  process.exit(1);
}

child.on('error', (error) => finish(false, error.message));
child.on('exit', (code) => {
  if (!settled) finish(false, `进程提前退出，退出码 ${code ?? 'null'}`);
});
