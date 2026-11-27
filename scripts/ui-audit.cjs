/**
 * UI 巡检：启动打包后的应用，通过 CDP 在渲染进程里执行 ui-audit-driver.js。
 *
 * 与 smoke.cjs 的分工：
 *  - smoke.cjs 只验证「能启动、渲染层无异常」
 *  - ui-audit.cjs 进一步跑通每个 IPC handler 与主要界面入口
 *
 * 使用隔离的临时用户数据目录，不会写到真实书库。
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');

const electronPath = require('electron');
const appDir = path.resolve(__dirname, '..');
const preferredPort = Number(process.env['UI_AUDIT_PORT'] ?? 9333);
let port = preferredPort;
const driverPath = path.join(__dirname, 'ui-audit-driver.js');
const graceLimitMs = Number(process.env['UI_AUDIT_TIMEOUT_MS'] ?? 90000);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkforge-audit-'));

/** 上一次运行可能还在退出，调试端口会被占用；这里退让到下一个可用端口 */
async function pickPort(start) {
  for (let candidate = start; candidate < start + 20; candidate += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(candidate, '127.0.0.1');
    });
    if (free) return candidate;
  }
  throw new Error('找不到可用的调试端口');
}
const env = { ...process.env, INKFORGE_LOG_RENDERER: '1', INKFORGE_USER_DATA_DIR: tempDir };
delete env.ELECTRON_RUN_AS_NODE;

let child = null;

let childOutput = '';
const rendererErrors = [];
function onOutput(chunk) {
  const text = chunk.toString();
  childOutput += text;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('[renderer:error]')) rendererErrors.push(line.trim());
  }
}

function stop() {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响结果 */
  }
}

function fail(message) {
  console.error(`[ui-audit] 失败：${message}`);
  if (rendererErrors.length > 0) console.error(rendererErrors.join('\n'));
  const tail = childOutput.trim().split(/\r?\n/).slice(-25).join('\n');
  if (tail) console.error('--- 应用输出（末 25 行）---\n' + tail);
  stop();
  process.exit(1);
}

async function findPageTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 端口未就绪，继续轮询 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('等待调试端口超时');
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    socket.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result);
        return;
      }
      if (data.method === 'Runtime.exceptionThrown') {
        const detail = data.params.exceptionDetails;
        const text = detail.exception?.description ?? detail.text ?? '未知异常';
        this.exceptions.push(String(text).split('\n')[0]);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, graceLimitMs);
    });
  }
}

async function main() {
  port = await pickPort(preferredPort);
  child = spawn(electronPath, [appDir, `--remote-debugging-port=${port}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.on('error', (error) => fail(error.message));
  child.on('exit', (code) => {
    if (code !== null) fail(`应用提前退出，退出码 ${code}`);
  });

  const page = await findPageTarget();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });

  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');

  // 准备一个最小 Obsidian 仓库用于验证 parseVault
  const vaultDir = path.join(tempDir, 'vault');
  fs.mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, '.obsidian', 'workspace.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(vaultDir, '第1章 雾起.md'), '雾在灯塔周围凝成一层薄壳。', 'utf8');
  fs.writeFileSync(path.join(vaultDir, '第2章 潮落.md'), '潮水退去，台阶露了出来。', 'utf8');
  fs.writeFileSync(path.join(vaultDir, '第3章 合集.md'), '# 第3章 上\n甲\n\n# 第4章 下\n乙', 'utf8');

  // 一份带章节标题的稿件，用于验证按路径导入
  const manuscriptPath = path.join(tempDir, '旧稿.txt');
  fs.writeFileSync(
    manuscriptPath,
    '第一章 雾起\n雾在灯塔周围凝成薄壳。\n\n第二章 潮落\n潮水退去，台阶露了出来。',
    'utf8',
  );

  const driver = fs
    .readFileSync(driverPath, 'utf8')
    .replace('__VAULT_PATH__', JSON.stringify(vaultDir))
    .replace('__MANUSCRIPT_PATH__', JSON.stringify(manuscriptPath));
  const result = await cdp.send('Runtime.evaluate', {
    expression: driver,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    fail(`驱动脚本抛错：${detail.exception?.description ?? detail.text}`);
  }

  const report = result.result?.value;
  if (!report || !Array.isArray(report.steps)) fail('未取得巡检报告');

  const failures = [];
  const line = (item) => `  ${item.ok ? '✓' : '✗'} ${item.name}${item.error ? ' — ' + item.error : ''}`;

  console.log('[ui-audit] IPC 链路：');
  for (const item of report.steps) {
    console.log(line(item));
    if (!item.ok) failures.push(`IPC:${item.name} — ${item.error}`);
  }

  console.log('[ui-audit] 界面入口：');
  for (const item of report.domSteps ?? []) {
    console.log(line(item));
    if (!item.ok) failures.push(`UI:${item.name} — ${item.error}`);
  }

  if (report.genres === 0) failures.push('题材模板为空');
  if (cdp.exceptions.length > 0) {
    failures.push(`渲染异常 ${cdp.exceptions.length} 条：${cdp.exceptions.slice(0, 5).join(' | ')}`);
  }

  socket.close();
  stop();

  if (failures.length > 0) {
    console.error('[ui-audit] 存在失败项：');
    for (const item of failures) console.error('  - ' + item);
    process.exit(1);
  }
  console.log(
    `[ui-audit] 全部通过：${report.steps.length} 项 IPC + ${(report.domSteps ?? []).length} 项界面入口`,
  );
  process.exit(0);
}

const guard = setTimeout(() => fail(`整体超时（${graceLimitMs}ms）`), graceLimitMs + 15000);
guard.unref?.();

main().catch((error) => fail(error.message));
