/**
 * 本地模型（Ollama）端到端自检。
 *
 * 用真实用户数据目录启动应用，依次验证：
 *   配置模型 → 连通性 → 导入旧稿 → AI 反推 → 大纲建议 → 生成正文 → 门禁与 AI 审稿
 * 结果会留在书库里，方便打开界面继续看。
 *
 * 用法：
 *   node scripts/ollama-e2e.cjs --model qwen2.5:7b --book "D:\\Desktop\\某本书.txt"
 *   node scripts/ollama-e2e.cjs --skip-writing      # 跳过最慢的正文生成
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const electronPath = require('electron');
const appDir = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const modelName = arg('model', 'qwen2.5:7b');
const baseUrl = arg('base-url', 'http://127.0.0.1:11434/v1');
const bookPath = arg('book', '');
const maxChapters = Number(arg('chapters', '4'));
const port = Number(arg('port', '9455'));
const skipWriting = flag('skip-writing');

const env = { ...process.env, INKFORGE_LOG_RENDERER: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [appDir, `--remote-debugging-port=${port}`], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let appOutput = '';
child.stdout.on('data', (chunk) => (appOutput += chunk.toString()));
child.stderr.on('data', (chunk) => (appOutput += chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stop() {
  if (!child.pid) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

async function findTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 端口未就绪 */
    }
    await sleep(300);
  }
  throw new Error('等待调试端口超时');
}

function cdpClient(socket) {
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
}

async function main() {
  const page = await findTarget();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
  });
  const send = cdpClient(socket);
  await send('Runtime.enable');

  const driver = fs
    .readFileSync(path.join(__dirname, 'ollama-e2e-driver.js'), 'utf8')
    .replace('__MODEL__', JSON.stringify(modelName))
    .replace('__BASE_URL__', JSON.stringify(baseUrl))
    .replace('__BOOK_PATH__', JSON.stringify(bookPath))
    .replace('__MAX_CHAPTERS__', String(maxChapters))
    .replace('__SKIP_WRITING__', String(skipWriting));

  const result = await send('Runtime.evaluate', {
    expression: driver,
    awaitPromise: true,
    returnByValue: true,
    timeout: 1800000,
  });

  if (result.exceptionDetails) {
    console.error('[e2e] 驱动异常：', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  const report = result.result?.value;
  if (report?.steps) {
    for (const step of report.steps) {
      const marker = step.ok ? '✓' : '✗';
      const note = step.note ? ` · ${step.note}` : '';
      console.log(`  ${marker} ${step.name}${note}${step.error ? ' — ' + step.error : ''}`);
    }
  }
  if (report?.sample) {
    console.log('\n--- 抽取样本（角色/规则）---');
    console.log(report.sample);
  }

  socket.close();
  stop();
  const failed = (report?.steps ?? []).filter((step) => !step.ok);
  if (failed.length > 0 || !report) {
    console.error(`[e2e] 失败 ${failed.length} 项`);
    const tail = appOutput.trim().split(/\r?\n/).slice(-12).join('\n');
    if (tail) console.error(tail);
    process.exit(1);
  }
  console.log('[e2e] 全部通过');
  process.exit(0);
}

child.on('error', (error) => {
  console.error('[e2e] 启动失败：', error.message);
  process.exit(1);
});

main().catch((error) => {
  console.error('[e2e] 失败：', error.message);
  stop();
  process.exit(1);
});
