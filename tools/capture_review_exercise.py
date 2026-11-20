"""Capture the display of a four-space change on the two real versions of the JS exercise."""
from capture_stages import take
def spacing_case(page, name):
    box=page.locator('#draft')
    box.fill('周日九点，社区修补角开放。\n\n请到入口    右侧的登记台领取工具。\n\n自带布袋或衣物，志愿者现场协助。')
    box.evaluate("""e => {e.focus();const start=e.value.indexOf('入口');e.setSelectionRange(start,start+8)}""")
    page.locator('#rule').select_option('spacing')
    page.locator('#generate').click()
    assert page.locator('#accept').is_enabled()
    assert ('␠' in page.locator('#diff').inner_text()) == (name=='after')
if __name__=='__main__':
    take('03',spacing_case,{'before':('review.js',(32,45)), 'after':('review.js',(35,48))})

