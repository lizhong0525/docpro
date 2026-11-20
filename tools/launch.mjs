import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'));
const editor = join(root, 'editor');
const instanceId = createHash('sha256')
  .update(process.platform === 'win32' ? root.toLowerCase() : root)
  .digest('hex');
const address = 'http://127.0.0.1:4399';
const busyMessage = '端口 4399 已被其他服务或另一份 DocPro 占用。请先关闭该窗口，再启动当前目录中的编辑器。';

async function checkHealth() {
  let response;
  try {
    response = await fetch(address + '/api/health', {
      signal: AbortSignal.timeout(1000),
      redirect: 'error'
    });
  } catch (error) {
    return error.cause?.code === 'ECONNREFUSED' ? 'closed' : 'other';
  }
  const health = await response.json().catch(() => null);
  const matches = response.ok && health?.ok && health.product === 'DocPro'
    && health.mode === 'production' && health.instanceId === instanceId;
  return matches ? 'ours' : 'other';
}

async function openEditor() {
  const welcome = address + '/index.html';
  console.log('DocPro 欢迎页：' + welcome);
  if (process.argv.includes('--no-browser')) return;
  try {
    const shell = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', welcome], {
      windowsHide: true, stdio: 'ignore', detached: true
    });
    await new Promise((resolve, reject) => shell.once('spawn', resolve).once('error', reject));
    shell.unref();
  } catch {
    console.log('请将上面的地址粘贴到浏览器打开。');
  }
}

async function start() {
  const current = await checkHealth();
  if (current === 'ours') {
    console.log('当前目录的 DocPro 已经运行。');
    await openEditor();
    return;
  }
  if (current === 'other') throw new Error(busyMessage);
  const bundle = join(editor, 'runtime', 'server.mjs');
  await Promise.all([access(bundle), access(join(editor, 'dist', 'index.html'))])
    .catch(() => { throw new Error('请先完整解压综合作业，确认 editor/runtime 与 editor/dist 均在编辑器目录。'); });
  const child = spawn(process.execPath, [bundle, '--prod'], {
    cwd: editor,
    stdio: 'inherit',
    env: { ...process.env, DOCPRO_ROOT: editor, DOCPRO_DATA_DIR: join(editor, 'data'),
      DOCPRO_INSTANCE_ID: instanceId, PORT: '4399', HOST: '127.0.0.1', NODE_ENV: 'production' }
  });
  const stopped = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 0));
  });
  const stop = () => { if (child.exitCode === null && !child.killed) child.kill(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await checkHealth();
      if (state === 'ours') {
        await openEditor();
        if (child.exitCode !== null) return; // Concurrent launch won the port.
        console.log('关闭本窗口即可停止服务。');
        const code = await stopped;
        if (code && await checkHealth() !== 'ours') process.exitCode = code;
        return;
      }
      if (state === 'other') throw new Error(busyMessage);
      if (child.exitCode !== null) throw new Error('本地服务未启动，请查看上面的运行信息。');
      await delay(200);
    }
    throw new Error('启动在 20 秒内未完成，请查看运行信息后重试。');
  } finally {
    stop();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
  }
}

try { await start(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
