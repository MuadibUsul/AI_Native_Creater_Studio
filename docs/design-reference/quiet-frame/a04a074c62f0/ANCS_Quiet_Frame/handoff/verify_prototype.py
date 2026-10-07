"""Validate the standalone design prototype. Does not test the production repository.
Requirements: Python 3.10+, playwright, Chromium. No external calls are made.
Run: python handoff/verify_prototype.py --chromium /path/to/chromium
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json,argparse,datetime
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--chromium',default='/usr/bin/chromium');args=parser.parse_args()
ROUTES=['home','new','script','editor','assets','identity','render','publish','analytics','extensions','settings','welcome','system']
checks=[]; errors=[]; scans=[]; requests=[]
def record(name,passed,details=''):
 checks.append({'name':name,'passed':bool(passed),'details':details});print(name, bool(passed),flush=True)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
 page=b.new_page(viewport={'width':1600,'height':1000},accept_downloads=True)
 page.set_default_timeout(3000)
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.on('request',lambda r: requests.append(r.url))
 page.set_content((ROOT/'index.html').read_text(),wait_until='domcontentloaded')
 def route(r):
  page.evaluate('(r)=>{location.hash=r;render()}',r);page.wait_for_timeout(50)
 def click(a):
  inside=page.locator(f'#layer [data-action="{a}"]'); target=inside.first if inside.count() else page.locator(f'[data-action="{a}"]').first; target.click();page.wait_for_timeout(60)
 for width in [1600,1280,768,390,320]:
  page.set_viewport_size({'width':width,'height':1000 if width>760 else 844})
  for r in ROUTES:
   route(r)
   d=page.evaluate('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})')
   scans.append({'route':r,**d,'passed':d['scrollWidth']<=width+1})
 record('13 页面 × 5 视口，无整页横向溢出',all(x['passed'] for x in scans))
 page.set_viewport_size({'width':1600,'height':1000});route('home')
 record('已有项目时仍有新建入口',page.locator('[data-action="go:new"]').count()==1)
 page.locator('#home-source').fill('设计演示正文');click('start')
 record('首页正文导入保留输入',page.locator('#source-text').input_value()=='设计演示正文')
 click('tab:url');page.locator('#source-url').fill('not-a-url');click('read-source')
 record('无效 URL 不进入生成流程',page.evaluate('state.route')=='new' and page.get_by_text('请输入完整的 http 或 https 文章链接。').count()>0)
 page.locator('#source-url').fill('https://example.org/article');click('read-source')
 record('有效 URL 只记录，不伪造抓取',page.evaluate('state.input')=='https://example.org/article' and len(requests)==0)
 click('generate-script');record('生成入口明确打开预置示例',page.evaluate('state.route')=='script')
 click('lockscript');record('脚本锁定成为只读',page.locator('#script-opening').get_attribute('contenteditable')=='false')
 click('aiedit');before=page.locator('#script-opening').inner_text();click('applyai')
 record('锁定脚本拒绝应用 AI 修改',page.locator('#script-opening').inner_text()==before)
 page.keyboard.press('Escape');click('lockscript');click('aiedit');click('applyai')
 record('确认 AI 修改后写入本地脚本',page.locator('#script-opening').inner_text()=='当一项新技术受到关注，先看投入如何转化为价值。')
 click('confirm-script');record('脚本确认进入分镜',page.evaluate('state.route')=='editor')
 click('aiedit');before=page.locator('.narration-line').inner_text();page.keyboard.press('Escape')
 record('拒绝或关闭 AI 修改不改变旁白',page.locator('.narration-line').inner_text()==before)
 click('aiedit');click('applyai');record('AI 差异确认后改变旁白', '判断才有依据' in page.locator('.narration-line').inner_text())
 click('timeline');record('轻时间线按需展开',page.evaluate('state.timeline') is True)
 click('timeline');click('scene:3');click('aiedit');before=page.locator('.narration-line').inner_text();click('applyai')
 record('锁定分镜拒绝应用',before==page.locator('.narration-line').inner_text());page.keyboard.press('Escape')
 route('render');page.evaluate('state.approved=false;render()');click('approve')
 record('未勾选审核不能批准',page.evaluate('state.approved') is False)
 page.locator('#review-check').check();click('approve');record('确认后进入交付演示',page.evaluate('state.approved&&state.route==="publish"'))
 click('export-package')
 with page.expect_download() as di:click('sample-download')
 dl=di.value;dest=ROOT/'handoff/sample_download_checked.txt';dl.save_as(dest)
 record('仅下载真实存在的 TXT 样例，不伪造 MP4',dl.suggested_filename.endswith('.txt') and '不含视频' in dest.read_text())
 page.keyboard.press('Escape');route('editor');page.evaluate('state.selectedScene=2;render()');click('aiedit');click('applyai')
 record('编辑使本地批准状态失效',page.evaluate('state.approved') is False)
 route('publish');click('export-package');record('未批准时导出被拦截',page.get_by_role('heading',name='先批准这一版作品').count()==1);page.keyboard.press('Escape')
 route('identity');click('voice-consent');click('consent-next')
 record('授权确认框未勾选不能继续',page.get_by_role('heading',name='这段声音，属于你吗？').count()==1)
 page.locator('#consent-check').check();click('consent-next');record('授权流程不假装创建真实克隆',page.get_by_text('尚未连接真实克隆服务，本原型不接收声音样本。').count()==1);page.keyboard.press('Escape')
 page.keyboard.press('Control+k');page.locator('#command-search').fill('导演');record('命令搜索筛选页面',page.locator('#command-results button:visible').count()==1);page.keyboard.press('Escape')
 record('Esc 关闭对话层',page.locator('#layer').inner_html()=='')
 route('settings');record('原型没有收集 API Key 的输入框',page.locator('input[type="password"]').count()==0)
 route('home');click('theme');record('深浅主题可切换',page.evaluate('state.theme')=='dark');click('theme')
 page.set_viewport_size({'width':390,'height':844});click('mobilemenu');record('手机导航可展开',page.locator('.sidebar.mobile-open').count()==1);page.keyboard.press('Escape')
 record('没有 JavaScript 未处理异常',not errors)
 record('没有外部网络请求',not requests)
 b.close()
report={'artifact':'Quiet Frame standalone prototype; not production repo','date':'2026-10-07','method':'Chromium via Playwright page.set_content; no backend, network, origin persistence or real media testing','checks':checks,'viewportScans':scans,'pageErrors':errors,'networkRequests':requests,'passed':all(c['passed'] for c in checks),'limitations':['No production build or automated repo tests run','No real LLM, video render, QA, billing, OAuth, cloning or publishing','LocalStorage persistence not validated: in-memory browser content fixture used','Not a full WCAG audit or cross-browser device certification']}
(ROOT/'handoff/QA_REPORT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'checks':len(checks),'passed':sum(c['passed'] for c in checks),'failures':[c for c in checks if not c['passed']],'overflow':[s for s in scans if not s['passed']],'errors':errors},ensure_ascii=False,indent=2))
