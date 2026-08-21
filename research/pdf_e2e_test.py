# 실사진 2장(모델 페이지) → PDF 생성 끝까지: 크기·페이지 수·소요시간·오류
import threading, functools, http.server, time, re
from playwright.sync_api import sync_playwright
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"; PORT = 9141
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    ctx = b.new_context(viewport={"width": 412, "height": 890}, accept_downloads=True); pg = ctx.new_page(); pg.set_default_timeout(300000)
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    pg.set_input_files("#file-input", ["C:/python_work/test_photos/4.jpg", "C:/python_work/test_photos/KakaoTalk_20260821_090722075_01.jpg"])
    t0 = time.time()
    for _ in range(240):
        if pg.evaluate("() => state.pages.length === 2 && state.pages.every(p => p.model !== undefined)"): break
        pg.wait_for_timeout(500)
    print("모델 2장 준비:", round(time.time() - t0, 1), "s", pg.evaluate("() => state.pages.map(p => !!p.model)"))
    pg.click("#btn-goto-gallery"); pg.wait_for_timeout(1500)
    pg.click("#btn-make-pdf"); pg.wait_for_timeout(800)
    t1 = time.time()
    with pg.expect_download(timeout=240000) as dl:
        pg.click("#btn-pdf-save")
    d = dl.value; path = d.path(); data = open(path, "rb").read()
    npages = len(re.findall(rb"/Type\s*/Page[^s]", data))
    print(f"PDF: {d.suggested_filename} {len(data)//1024}KB 페이지수={npages} 생성 {round(time.time()-t1,1)}s")
    print("errors:", errs[:5])
    b.close()
server.shutdown()
