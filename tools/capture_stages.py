"""Create real window captures for course reports, using only local source and task files."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from html import escape
from pathlib import Path
import sys
from threading import Thread

from capture_window import ROOT, capture, open_context
from playwright.sync_api import sync_playwright

STAGES = {'01':'01-html','02':'02-css','03':'03-js'}
OUT = ROOT/'evidence'/'shots'
VIEW = ROOT/'evidence'/'work'/'reading'
PORT = 4407
URL = f'http://127.0.0.1:{PORT}/'
class SourceHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        prefix = self.path.split('?')[0]
        if '..' in self.path or not prefix.startswith(('/stages/','/evidence/initial/','/evidence/work/reading/')):
            self.send_error(404)
            return
        super().do_GET()
    def log_message(self, *args): pass

def reading_page(stage, name, title, source, code_range=None):
    relative = source.relative_to(ROOT).as_posix()
    lines = source.read_text(encoding='utf-8-sig').splitlines()
    if code_range:
        a,b = code_range
        content = '<pre>' + ''.join(f'<div><i>{i+1}</i><code>{escape(l)}</code></div>' for i,l in enumerate(lines) if a<=i+1<=b) + '</pre>'
    else:
        content = ''.join(f'<p>{escape(l)}</p>' for l in lines[1:] if l.strip())
    html = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>{escape(title)}</title><style>
        *{{box-sizing:border-box}}body{{margin:32px auto;width:calc(100% - 96px);max-width:1190px;color:#342435;background:#fcfaf5;font:20px/1.64 "Microsoft YaHei",sans-serif}}
        header{{border-bottom:2px solid #674761;padding-bottom:10px;margin-bottom:16px}}small{{font:16px Consolas,monospace;color:#726473}}
        h1{{font-size:32px;margin:8px 0}}p{{margin:.7em 0}}pre{{margin:2px 0;font:19px/1.55 Consolas,"Microsoft YaHei",monospace}}
        pre div{{display:flex;gap:18px}}i{{color:#897488;font:normal 15px/1.9 Consolas,monospace;min-width:2em;text-align:right}}
        code{{white-space:pre-wrap;overflow-wrap:anywhere}}
        </style><header><small>{escape(relative)}</small><h1>{escape(title)}</h1></header>{content}</html>"""
    f = VIEW / f'{stage}-{name}.html'
    f.parent.mkdir(parents=True,exist_ok=True)
    f.write_text(html,encoding='utf-8')
    return URL+f.relative_to(ROOT).as_posix()

def take(stage, setup=None, snippets=None):
    server = ThreadingHTTPServer(('127.0.0.1',PORT),partial(SourceHandler,directory=str(ROOT)))
    thread = Thread(target=server.serve_forever,daemon=True); thread.start()
    try:
        with sync_playwright() as p:
            context=open_context(p)
            page=context.pages[0]
            page.emulate_media(reduced_motion='reduce')
            def save(name):
                page.evaluate('document.fonts.ready')
                capture(page,OUT/stage/(name+'.png'))
            prompt=next((ROOT/'prompts').glob(stage+'-*.md'))
            page.goto(reading_page(stage,'prompt',prompt.read_text(encoding='utf-8').splitlines()[0].lstrip('# '),prompt));save('prompt')
            for name,relative in [('before',f'evidence/initial/{stage}/'),('after',f'stages/{STAGES[stage]}/')]:
                page.emulate_media(media='screen',reduced_motion='reduce')
                page.goto(URL+relative+'index.html')
                if stage=='02' and name=='after':
                    page.locator('label[for=exhibit]').click()
                    save('screen')
                if setup: setup(page, name)
                save(name)
                file,ran=snippets[name]
                page.goto(reading_page(stage,name+'-code',('初稿' if name=='before' else '修订稿')+' · '+file, ROOT/relative/file,ran))
                save(name+'-code')
            context.close()
    finally:
        server.shutdown()
        server.server_close()

def gallery_css(page, phase):
    page.locator('label[for=exhibit]').click()
    # Turn on the actual print stylesheet to show the duplicated source/controls in v1.
    page.emulate_media(media='print',reduced_motion='reduce')

if __name__=='__main__':
    for stage in sys.argv[1:]:
        if stage=='01':
            take(stage,snippets={'before':('index.html',(8,18)),'after':('index.html',(8,18))})
        if stage=='02':
            take(stage,gallery_css,{'before':('styles.css',(36,48)),'after':('styles.css',(55,71))})

