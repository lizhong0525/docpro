"""Capture a single Chromium window from our isolated course profile, including its real tab bar."""
from ctypes import windll
from pathlib import Path
import os
import time

import win32con
import win32gui
import win32ui
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / 'evidence' / 'work' / 'browser'
CACHE.mkdir(parents=True, exist_ok=True)
os.environ['TEMP'] = os.environ['TMP'] = str(CACHE)
windll.user32.SetProcessDPIAware()

def open_context(p):
    return p.chromium.launch_persistent_context(
        user_data_dir=CACHE / 'course-profile',
        channel='chrome', headless=False, no_viewport=True,
        ignore_default_args=['--enable-automation'],
        args=['--window-size=1280,840', '--window-position=50,65',
              '--disable-gpu','--disable-direct-composition','--force-device-scale-factor=1','--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
              '--no-first-run','--no-default-browser-check','--disable-features=Translate'],
    )

def capture(page, dest):
    page.bring_to_front()
    title = page.title()
    handles = []
    def match(hwnd, _):
        if (win32gui.GetClassName(hwnd) == 'Chrome_WidgetWin_1'
                and win32gui.GetWindowText(hwnd).startswith(title + ' - ')
                and win32gui.IsWindowVisible(hwnd)):
            handles.append(hwnd)
    for attempt in range(25):
        win32gui.EnumWindows(match, None)
        if handles:
            break
        time.sleep(.1)
    if len(handles) != 1:
        raise RuntimeError(f'Could not uniquely identify course window for {title}, count {len(handles)}')
    hwnd = handles[0]
    win32gui.RedrawWindow(hwnd,None,None,win32con.RDW_INVALIDATE | win32con.RDW_ALLCHILDREN | win32con.RDW_UPDATENOW)
    time.sleep(.32)
    left,top,right,bottom = win32gui.GetWindowRect(hwnd)
    width,height = right-left,bottom-top
    hdc = win32gui.GetWindowDC(hwnd)
    source = win32ui.CreateDCFromHandle(hdc)
    memory = source.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    bitmap.CreateCompatibleBitmap(source,width,height)
    old = memory.SelectObject(bitmap)
    try:
        if not windll.user32.PrintWindow(hwnd, memory.GetSafeHdc(), 2):
            raise RuntimeError('Window capture failed')
        img = Image.frombytes('RGB',(width,height),bitmap.GetBitmapBits(True),'raw','BGRX',0,1)
        dest.parent.mkdir(parents=True,exist_ok=True)
        img.save(dest)
    finally:
        memory.SelectObject(old)
        memory.DeleteDC()
        source.DeleteDC()
        win32gui.ReleaseDC(hwnd,hdc)
        win32gui.DeleteObject(bitmap.GetHandle())

if __name__ == '__main__':
    with sync_playwright() as p:
        ctx = open_context(p)
        page = ctx.pages[0]
        page.goto((ROOT/'index.html').as_uri())
        page.wait_for_timeout(900)
        capture(page,CACHE/'course-check.png')
        ctx.close()

