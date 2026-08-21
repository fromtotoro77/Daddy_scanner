import threading, functools, http.server
from playwright.sync_api import sync_playwright
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"; PORT = 9111
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    pg = b.new_context(viewport={"width": 412, "height": 890}).new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{PORT}/index.html"); pg.wait_for_timeout(3000)
    dims = lambda: pg.evaluate("() => { const s = state.stream && state.stream.getVideoTracks()[0].getSettings(); return s ? [s.width, s.height, !!state.spreadMode, document.querySelector('.frame-guide').classList.contains('hidden')] : null; }")
    print("단일:", dims())
    pg.click("#btn-spread"); pg.wait_for_timeout(2500); print("책펼침:", dims())
    pg.click("#btn-spread"); pg.wait_for_timeout(2500); print("단일 복귀:", dims())
    print("errors:", errs[:3]); b.close()
server.shutdown()
