"""Render hi-fi prototype reference screens. Requires Playwright and Chromium."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,argparse
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--chromium',default='/usr/bin/chromium');args=parser.parse_args()
PAGES=[('home','01-workspace','创作台'),('new','02-new-project','新建作品'),('script','03-script','脚本与来源'),('editor','04-director','导演工作台'),('assets','05-assets','素材库'),('identity','06-identity','创作者身份'),('render','07-review','成片与审核'),('publish','08-publishing','交付与发布'),('analytics','09-analytics','作品表现'),('extensions','10-extensions','扩展工具'),('settings','11-settings','服务与设置'),('welcome','12-landing','产品首页'),('system','13-design-system','设计系统')]
manifest=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
 ctx=b.new_context(viewport={'width':1600,'height':1000},device_scale_factor=1.5)
 page=ctx.new_page();page.set_content((ROOT/'index.html').read_text(),wait_until='domcontentloaded')
 def route(r):
  page.evaluate('(r)=>{state.selectedScene=2;state.approved=false;state.history=[];state.input="";state.script="";state.timeline=false;state.importTab="url";state.theme="light";state.projectTitle="当算力成为新资产";closeLayer();location.hash=r;render()}',r);page.wait_for_timeout(300)
 for r,n,label in PAGES:
  route(r);path=ROOT/f'screens/{n}.png';page.screenshot(path=str(path),full_page=True);manifest.append({'file':f'screens/{n}.png','label':label,'route':r,'viewport':'1600 × 1000','dpr':1.5})
 route('editor');page.locator('[data-action="aiedit"]').first.click();page.wait_for_timeout(400);page.screenshot(path=str(ROOT/'screens/14-ai-diff.png'),full_page=True);manifest.append({'file':'screens/14-ai-diff.png','label':'AI 修改差异与确认','route':'editor + drawer','viewport':'1600 × 1000','dpr':1.5})
 page.keyboard.press('Escape');route('home');page.locator('[data-action="theme"]').click();page.wait_for_timeout(300);page.screenshot(path=str(ROOT/'screens/18-dark-workspace.png'),full_page=True);manifest.append({'file':'screens/18-dark-workspace.png','label':'深色创作台','route':'home + dark','viewport':'1600 × 1000','dpr':1.5})
 ctx.close()
 ctx=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2)
 page=ctx.new_page();page.set_content((ROOT/'index.html').read_text(),wait_until='domcontentloaded')
 for r,n,label in [('home','15-mobile-workspace','移动端创作台'),('editor','16-mobile-director','移动端分镜'),('render','17-mobile-review','移动端审核')]:
  route(r);page.screenshot(path=str(ROOT/f'screens/{n}.png'),full_page=True);manifest.append({'file':f'screens/{n}.png','label':label,'route':r,'viewport':'390 × 844','dpr':2})
 ctx.close();b.close()
(ROOT/'handoff/SCREEN_MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print(f'Captured {len(manifest)} screens')
