import { expect, test } from '@playwright/test';

test('规则提案支持点击接受、还原、拒绝与全文逐处审批', async ({page, request}) => {
  const health = await (await request.get('/api/health')).json();
  test.skip(health.hasApiKey, '本用例验证无凭据的课堂运行方式');
  await page.goto('/editor/');
  await expect(page.getByTestId('doc-boot')).toHaveCount(0);
  const editor = page.locator('.cm-content');
  const first = '居民可以进行报名。';
  const last = '请带好相关的材料。';
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(first + '\n\n' + last);
  const propose = async () => {
    await page.getByRole('button', {name:'精简公文用语'}).click();
    await page.getByTestId('command-submit').click();
  };
  const selectFirst = async () => {
    await editor.locator('.cm-line').first().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Control+k');
    await propose();
    await expect(page.getByTestId('review-panel')).toContainText('本地文字规则');
  };
  await selectFirst();
  await page.getByTestId('accept').click();
  await expect(editor.locator('.cm-line').first()).toHaveText('居民可以报名。');
  await page.keyboard.press('Control+z');
  await expect(editor.locator('.cm-line').first()).toHaveText(first);
  await selectFirst();
  await page.getByTestId('reject').click();
  await expect(editor.locator('.cm-line').first()).toHaveText(first);
  await page.getByTestId('full-doc-edit').click();
  await propose();
  await expect(page.getByTestId('full-review')).toBeVisible();
  await page.getByTestId('review-approve-1').click();
  await page.getByTestId('review-reject-2').click();
  await page.getByTestId('review-apply').click();
  await expect(editor.locator('.cm-line').first()).toHaveText('居民可以报名。');
  await expect(editor.locator('.cm-line').last()).toHaveText(last);
});
