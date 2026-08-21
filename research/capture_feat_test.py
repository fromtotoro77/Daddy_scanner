import threading, functools, http.server
from playwright.sync_api import sync_playwright
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"; PORT = 9071
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    pg = b.new_context(viewport={"width": 412, "height": 890}).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    pg.wait_for_timeout(1500)
    pg.click("#btn-shutter"); pg.wait_for_timeout(2500)
    print("lastCapture:", pg.evaluate("() => state.lastCapture"))
    print("cam settings:", pg.evaluate("() => { const s = state.stream.getVideoTracks()[0].getSettings(); return [s.width, s.height]; }"))
    pg.click("#btn-auto"); pg.wait_for_timeout(2000)
    print("auto on:", pg.evaluate("() => state.autoCapture && document.getElementById('btn-auto').classList.contains('on')"))
    print("quality:", pg.evaluate("() => ({ motion: +liveDetect.motion.toFixed(1), sharp: Math.round(liveDetect.sharp), sharpMax: Math.round(liveDetect.sharpMax), still: liveDetect.stillStreak, hint: document.getElementById('detect-hint').textContent, hintCls: document.getElementById('detect-hint').className })"))
    print("torch hidden:", pg.evaluate("() => document.getElementById('btn-torch').classList.contains('hidden')"), "level hidden:", pg.evaluate("() => document.getElementById('level-ind').classList.contains('hidden')"))
    # 루프 1회 소요시간 측정
    print("loop ms:", pg.evaluate("""() => { const v = document.getElementById('cam'); const w = document.createElement('canvas'); const s = 360/Math.max(v.videoWidth, v.videoHeight); w.width = Math.round(v.videoWidth*s); w.height = Math.round(v.videoHeight*s); w.getContext('2d').drawImage(v,0,0,w.width,w.height); const t0 = performance.now(); measureFrameQuality(w); const t1 = performance.now(); findDocQuad(w, 0.15); return [Math.round(t1-t0), Math.round(performance.now()-t1)]; }"""))
    pg.click("#btn-auto")
    print("errors:", errs[:5])
    b.close()
server.shutdown()
