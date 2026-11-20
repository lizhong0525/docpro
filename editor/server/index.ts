/**
 * DocPro 本地服务：一个进程同时提供 API 与前端。
 * - 开发模式（pnpm dev）：Vite middleware 提供 HMR
 * - 生产模式（pnpm start）：服务 dist 静态文件
 */
import express from 'express';
import { join } from 'node:path';
import { config, hasApiKey, PROJECT_ROOT, saveApiKeyToEnvFile, setRuntimeApiKey } from './config';
import { isPlausibleApiKey } from '../src/core/envFile';
import { handleEdit } from './editRoute';
import { handleWordEdit } from './wordRoute';
import { docsRouter } from './docsRoute';
import { handlePaperMemoryGet, handlePaperMemoryPut, handlePaperRefsFix, handlePaperRefsVerify, handlePaperRevise } from './paperRoute';
import { convertDocxToMarkdown, DocxConversionError } from './docx';
import { publicConfig } from '../src/core/protocol';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));

const courseRoot = join(PROJECT_ROOT, '..');
app.get(['/', '/index.html'], (_req, res) => res.sendFile(join(courseRoot, 'index.html')));
app.use('/stages', express.static(join(courseRoot, 'stages'), { dotfiles: 'deny' }));
app.get('/course', (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect('/course/');
  res.sendFile(join(courseRoot, 'index.html'));
});
app.get('/course/index.html', (_req, res) => res.sendFile(join(courseRoot, 'index.html')));
app.use('/course/stages', express.static(join(courseRoot, 'stages'), { dotfiles: 'deny' }));
app.use('/course', (_req, res) => res.sendStatus(404));

// A directly opened course index can discover the local welcome URL without
// reading credentials or other configuration across origins.
app.get('/api/welcome', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*').set('Cache-Control', 'no-store').json({ product: 'DocPro' });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    product: 'DocPro',
    instanceId: process.env.DOCPRO_INSTANCE_ID || null,
    version: config.version,
    hasApiKey: hasApiKey(),
    model: config.defaultModel,
    mode: config.isProduction ? 'production' : 'development',
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ...publicConfig(hasApiKey(), config.defaultModel, config.paperModels, config.paperDefaultThinking),
    keySuffix: hasApiKey() && config.apiKey.length > 8 ? config.apiKey.slice(-4) : null,
  });
});

/**
 * PUT /api/config/apikey —— 应用内配置 DeepSeek API Key（空白密钥安装包的用户入口）。
 *
 * - 先用 GET /models 校验 Key 是否可用（401/402 直接报错，不保存）；
 * - 校验通过后立即在进程内生效（无需重启），并写回安装目录 .env；
 * - 只接受本机请求（服务默认仅监听 127.0.0.1）。
 */
app.put('/api/config/apikey', async (req, res) => {
  const key = typeof (req.body as { apiKey?: unknown })?.apiKey === 'string' ? ((req.body as { apiKey: string }).apiKey).trim() : '';
  if (!isPlausibleApiKey(key)) {
    res.status(400).json({ code: 'invalid-format', error: 'API Key 格式不正确：应以 sk- 开头，且长度不少于 12 个字符。' });
    return;
  }
  let verified = false;
  let verifyError = '';
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string };
        if (typeof parsed.error === 'string') detail = parsed.error;
        else if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // 保留原始文本
      }
      res.status(400).json({ code: 'invalid-api-key', error: `API Key 校验失败：${detail || `HTTP ${response.status}`}` });
      return;
    }
    verified = true;
  } catch (err) {
    if (req.body?.requireVerification === true) {
      res.status(503).json({ code: 'verification-unavailable', error: '暂时无法连接 DeepSeek。请检查网络后重试。' });
      return;
    }
    verifyError = err instanceof Error ? err.message : String(err);
  }
  setRuntimeApiKey(key);
  const saved = saveApiKeyToEnvFile(key);
  res.json({
    ok: true,
    verified,
    saved: saved.ok,
    envPath: saved.ok ? saved.envPath : undefined,
    warning: !saved.ok
      ? `Key 已在本次运行中生效，但写入 .env 失败：${saved.error}`
      : !verified
        ? `已保存，但无法连接 DeepSeek 进行校验（${verifyError}），请稍后确认`
        : undefined,
  });
});

app.post('/api/edit', (req, res) => {
  void handleEdit(req, res);
});

/**
 * 论文助手：
 * - /api/paper/revise  逐段修订（SSE，引文保护）
 * - /api/paper/refs/fix 参考文献格式重排（JSON，快模型）
 * - /api/paper/memory  论文记忆（GET 读 / PUT 写）
 */
app.post('/api/paper/revise', (req, res) => {
  void handlePaperRevise(req, res);
});

app.post('/api/paper/refs/fix', (req, res) => {
  void handlePaperRefsFix(req, res);
});

app.post('/api/paper/refs/verify', (req, res) => {
  void handlePaperRefsVerify(req, res);
});

app.get('/api/paper/memory', handlePaperMemoryGet);
app.put('/api/paper/memory', handlePaperMemoryPut);

/**
 * Word 插件专用：一次性 JSON 返回（VBA 无法消费 SSE）。
 * 复用 /api/edit 的完整编辑流水线；详细契约见 server/wordRoute.ts。
 */
app.post('/api/word/edit', (req, res) => {
  void handleWordEdit(req, res);
});

/** 文档库：每个文档一个子文件夹（document.md + revisions + audit.jsonl） */
app.use('/api/docs', docsRouter);

const DOCX_MIME = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream',
];

/**
 * DOCX → Markdown 导入。
 * 请求体为 .docx 原始二进制（application/vnd.openxmlformats-... 或 octet-stream），
 * 文件名通过 query ?name= 传入（仅用于兜底标题与提示）。
 */
app.post('/api/import/docx', express.raw({ type: DOCX_MIME, limit: config.docxMaxBytes }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ code: 'missing-file', error: '缺少 .docx 文件内容（请以二进制方式上传）。' });
      return;
    }
    const fileName = typeof req.query.name === 'string' ? req.query.name : '';
    const result = await convertDocxToMarkdown(req.body, { fileName, maxBytes: config.docxMaxBytes });
    console.log(
      `[docx] ${fileName || '(未命名)'} ${req.body.length}B → ${result.markdown.length} 字符, ` +
        `标题=${result.stats.headings} 表格=${result.stats.tables} 图片=${result.stats.images} 列表项=${result.stats.listItems}`,
    );
    res.json(result);
  } catch (err) {
    if (err instanceof DocxConversionError) {
      res.status(err.status).json({ code: err.code, error: err.message, detail: err.detail });
      return;
    }
    console.error('[docx] 转换异常:', err);
    res.status(500).json({ code: 'internal-error', error: 'docx 转换失败，请稍后重试。' });
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ code: 'not-found', error: 'API 不存在' });
});

async function mountFrontend(): Promise<void> {
  if (config.isProduction) {
    const dist = join(PROJECT_ROOT, 'dist');
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      res.sendFile(join(dist, 'index.html'), (err) => {
        if (err) next(err);
      });
    });
    return;
  }
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(PROJECT_ROOT, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.get(['/editor', '/editor/'], async (req, res, next) => {
    try {
      const { readFile } = await import('node:fs/promises');
      const template = await readFile(join(PROJECT_ROOT, 'index.html'), 'utf8');
      res.type('html').send(await vite.transformIndexHtml(req.originalUrl, template));
    } catch (error) { next(error); }
  });
  app.use(vite.middlewares);
}

// 统一错误处理（JSON 解析失败、请求体超限、处理函数抛错等）
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
  const isJsonParseError = err instanceof SyntaxError && (err as SyntaxError & { type?: string }).type === 'entity.parse.failed';
  if (isJsonParseError) {
    if (!res.headersSent) res.status(400).json({ code: 'bad-json', error: '请求体不是合法 JSON。' });
    return;
  }
  if (status === 413) {
    if (!res.headersSent) {
      res.status(413).json({
        code: 'payload-too-large',
        error: `文件超过大小上限（${(config.docxMaxBytes / 1024 / 1024).toFixed(0)} MB）。`,
      });
    }
    return;
  }
  console.error('[server] 未处理的错误:', err);
  if (!res.headersSent) {
    res.status(status >= 400 && status < 600 ? status : 500).json({ code: 'internal-error', error: `服务端错误：${message}` });
  } else if (!res.writableEnded) {
    res.end();
  }
});

await mountFrontend();

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  console.log('');
  console.log('  DocPro · 极简 Markdown 编辑器');
  console.log(`  ${url}`);
  console.log(`  模式: ${config.isProduction ? 'production' : 'development'}   模型: ${config.defaultModel}`);
  console.log(`  API Key: ${hasApiKey() ? '已配置' : '未配置（请在 .env 中设置 DEEPSEEK_API_KEY）'}`);
  console.log('');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${config.port} 已被占用。请设置 PORT 环境变量或关闭占用进程。`);
  } else {
    console.error('[server] 启动失败:', err);
  }
  process.exitCode = 1;
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[server] 收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}
