/**
 * E2E：对照模式（左侧对照文档 / 右侧当前文档 / 浮动控制栏）。
 *
 * 运行前提：http://127.0.0.1:4399 上 DocMax 服务已启动（不调用模型）。
 * 运行：node node_modules/@playwright/test/cli.js test e2e/compare.spec.ts
 *
 * 用例自建两份文档（对照文档 / 当前文档），结束后清理，不污染文档库。
 */
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SHOT_DIR = '.artifacts';

const REF_CONTENT = [
  '# 对照文档：格式样例',
  '',
  ...Array.from({ length: 40 }, (_, index) => `这是第 ${index + 1} 段对照内容，用于验证长文档的同步滚动。\n`),
  '| 指标 | 数值 |',
  '| --- | --- |',
  '| 准确率 | 0.92 |',
  '| 召回率 | 0.88 |',
  '',
  '## 二级标题',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
].join('\n');

const MAIN_CONTENT = [
  '# 当前文档：待修改稿件',
  '',
  ...Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段正文，正在修改的稿件内容，用于两侧同步滚动验证。\n`),
  '## 图表',
  '',
  '| 项目 | 值 |',
  '| --- | --- |',
  '| A | 1 |',
  '',
].join('\n');

interface CreatedDoc {
  id: string;
  title: string;
}

async function createDoc(request: APIRequestContext, title: string, content: string): Promise<CreatedDoc> {
  const response = await request.post('/api/docs', { data: { title, content } });
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { doc: { id: string; title: string } };
  return { id: payload.doc.id, title: payload.doc.title };
}

async function openActiveDoc(page: Page, docId: string): Promise<void> {
  await page.goto('/editor/');
  // 等首屏 bootstrap 完成（它会写回 active-doc），再设置目标文档，避免竞态覆盖
  await page.waitForSelector('[data-testid=doc-boot]', { state: 'detached', timeout: 20_000 });
  await page.evaluate((id) => localStorage.setItem('docpro:active-doc:v1', id), docId);
  await page.reload();
  await page.waitForSelector('[data-testid=doc-boot]', { state: 'detached', timeout: 20_000 });
  // 确认活动文档已切换
  await expect(page.locator('[data-testid=doc-title]')).toHaveValue(/当前文档/);
}

test.describe('对照模式', () => {
  test('对照文档 / 浮动控制栏 / 本地文件 / 同步滚动 / Esc 关闭', async ({ page, request }, testInfo) => {
    const main = await createDoc(request, '当前文档（对照验收）', MAIN_CONTENT);
    const ref = await createDoc(request, '对照文档（格式样例）', REF_CONTENT);
    const tmp = mkdtempSync(join(tmpdir(), 'docmax-compare-'));
    const localPath = join(tmp, '本地对照样例.md');
    writeFileSync(localPath, '# 本地对照样例\n\n来自本地文件的内容。\n');

    try {
      await openActiveDoc(page, main.id);

      // 打开对照
      await page.click('[data-testid=open-compare]');
      const pane = page.locator('[data-testid=compare-pane]');
      await expect(pane).toBeVisible();
      const bar = page.locator('[data-testid=compare-bar]');
      await expect(bar).toBeVisible();

      // 控制栏靠左浮动（x 贴近左边缘，且在对照面板内）
      const barBox = await bar.boundingBox();
      expect(barBox).not.toBeNull();
      expect(barBox!.x).toBeLessThan(40);
      const paneBox = await pane.boundingBox();
      expect(barBox!.x).toBeLessThan(paneBox!.x + paneBox!.width);

      // 自动选中对照文档并渲染（最近更新的、有内容的其它文档）
      await expect(page.locator('[data-testid=compare-select]')).toHaveValue(ref.id);
      await expect(page.locator('[data-testid=compare-doc]')).toContainText('对照文档：格式样例');
      await expect(page.locator('[data-testid=compare-doc] table')).toHaveCount(1);

      // 右侧是被修改文档：编辑器仍可见，工作区向左让出对照宽度
      await expect(page.locator('.cm-content').first()).toBeVisible();
      const padding = await page.locator('.workspace').evaluate((el) => getComputedStyle(el).paddingLeft);
      expect(Number.parseFloat(padding)).toBeGreaterThan(200);

      // 同步滚动：左侧滚到中部，右侧跟随
      await page.locator('[data-testid=compare-sync]').click(); // 确认开启（默认开，点击关闭再点开）
      await page.locator('[data-testid=compare-sync]').click();
      const synced = await page.evaluate(async () => {
        const left = document.querySelector<HTMLElement>('[data-testid=compare-scroll]');
        const right = document.querySelector<HTMLElement>('.workspace.is-compare .cm-scroller');
        if (!left || !right) return false;
        left.scrollTop = Math.floor((left.scrollHeight - left.clientHeight) * 0.6);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return right.scrollTop > 0;
      });
      expect(synced).toBeTruthy();

      // 打开本地文件作为对照
      await page.locator('[data-testid=compare-local-file]').setInputFiles(localPath);
      await expect(page.locator('.compare-doc-head')).toContainText('本地对照样例');
      await expect(page.locator('.compare-doc-head')).toContainText('本地文件');
      await expect(page.locator('[data-testid=compare-doc]')).toContainText('来自本地文件的内容');

      // 下拉切回文档库文档
      await page.locator('[data-testid=compare-select]').selectOption(ref.id);
      await expect(page.locator('[data-testid=compare-doc]')).toContainText('对照文档：格式样例');

      await page.screenshot({ path: `${SHOT_DIR}/compare-mode.png`, fullPage: false });

      // Esc 关闭
      await page.keyboard.press('Escape');
      await expect(pane).toHaveCount(0);
      const afterPadding = await page.locator('.workspace').evaluate((el) => getComputedStyle(el).paddingLeft);
      expect(Number.parseFloat(afterPadding)).toBe(0);
    } finally {
      await request.delete(`/api/docs/${main.id}`);
      await request.delete(`/api/docs/${ref.id}`);
      rmSync(tmp, { recursive: true, force: true });
    }
    void testInfo;
  });
});
