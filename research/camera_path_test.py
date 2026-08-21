# 카메라 촬영 경로(fromCamera=true) 회귀 검사: 모델 피팅이 실제로 이뤄지는지
import threading, functools, http.server, base64
from playwright.sync_api import sync_playwright
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"; PORT = 9095
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
b64 = base64.b64encode(open("C:/python_work/test_photos/4.jpg", "rb").read()).decode()
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    pg = b.new_page(viewport={"width": 412, "height": 890}); pg.set_default_timeout(300000)
    warns = []; pg.on("console", lambda m: warns.append(m.type + ": " + m.text) if m.type in ("error", "warning") else None)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    r = pg.evaluate("""async (b64) => {
        const res = await fetch('data:image/jpeg;base64,' + b64); const blob = await res.blob();
        await addCapturedBlob(blob, true, true);
        for (let i = 0; i < 120; i++) { if (state.pages[0] && state.pages[0].model !== undefined) break; await new Promise(r => setTimeout(r, 500)); }
        const p = state.pages[0];
        return { model: !!p.model, corners: !!p.corners, curvesLeft: p.curves ? p.curves.left : 'nocurves', tlx: p.corners ? Math.round(p.corners.tl.x) : null };
    }""", b64)
    print("camera path:", r); print("warnings:", [w for w in warns if '실패' in w or 'error' in w.lower()][:5])
    b.close()
server.shutdown()
