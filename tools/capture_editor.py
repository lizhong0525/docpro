"""Exercise the public editor UI, capturing the workspace and its offline review."""
from capture_window import ROOT,capture,open_context
from playwright.sync_api import sync_playwright, expect
OUT=ROOT/'evidence'/'shots'/'04'
with sync_playwright() as p:
    context=open_context(p)
    page=context.pages[0]
    errors=[]
    page.on('pageerror',lambda exc:errors.append(str(exc)))
    page.goto('http://127.0.0.1:4399/editor/')
    cm=page.locator('.cm-content')
    expect(cm).to_contain_text('进行报名')
    capture(page,OUT/'editor.png')
    cm.get_by_text('各位居民朋友们',exact=False).first.click()
    page.keyboard.press('Home')
    page.keyboard.press('Shift+End')
    page.keyboard.press('Control+k')
    page.get_by_role('button',name='精简公文用语').click()
    page.get_by_test_id('command-submit').click()
    expect(page.get_by_test_id('proposal-card').first).to_be_visible(timeout=15000)
    capture(page,OUT/'review.png')
    text=cm.inner_text()
    page.get_by_test_id('accept').click()
    assert cm.inner_text()!=text
    cm.press('Control+z')
    assert cm.inner_text()==text
    assert not errors, errors
    context.close()

