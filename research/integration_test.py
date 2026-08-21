# 앱 통합 테스트: 실제 사진을 앱에 불러와 모델 피팅 → 편집 렌더 → 원본 해상도 출력 → 글줄 수평 측정
import threading, functools, http.server, base64, time, sys
from playwright.sync_api import sync_playwright
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
import os
PORT = int(os.environ.get("PORT", "8985"))
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
PHOTO = sys.argv[1] if len(sys.argv) > 1 else "4.jpg"
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    ctx = b.new_context(viewport={"width": 412, "height": 890})
    pg = ctx.new_page()
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    pg.set_input_files("#file-input", f"C:/python_work/test_photos/{PHOTO}")
    t0 = time.time()
    for _ in range(120):
        st = pg.evaluate("() => ({ n: state.pages.length, corners: !!(state.pages[0] && state.pages[0].corners), model: !!(state.pages[0] && state.pages[0].model), checked: !!(state.pages[0] && state.pages[0].autoChecked) })")
        if st["n"] and st["model"]: break
        if st["n"] and st["checked"] and not st["corners"] and _ > 5: break
        pg.wait_for_timeout(500)
    res["fit_seconds"] = round(time.time() - t0, 1)
    res["state"] = st
    # 편집 화면 진입
    pg.click("#btn-goto-gallery"); pg.wait_for_timeout(1500)
    pg.click(".gal-item"); pg.wait_for_timeout(4000)
    res["edit_canvas"] = pg.evaluate("() => { const c = document.getElementById('edit-canvas'); return [c.width, c.height]; }")
    res["opt_visible"] = pg.evaluate("() => !document.getElementById('opt-chips').classList.contains('hidden')")
    # 원본 해상도 출력 (PDF 품질 수준)
    pg.evaluate(f"() => {{ window.PM_COLFIT = {os.environ.get('COLFIT', '1')}; }}")
    out = pg.evaluate("""async () => {
        const c = await processPage(state.pages[0], 2500);
        // 줄 단위 정밀 지표: 출력에서 글줄 재추출 → 줄마다 y 편차(최대·표준편차, px)
        const m = cv.imread(c); const g = new cv.Mat(); cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
        const t = pmExtractTextLines(g, c.width, c.height); m.delete(); g.delete();
        const stats = [];
        for (const pts of t.lines) {
            const ys = pts.map(p => p.y); const mean = ys.reduce((a,b)=>a+b,0)/ys.length;
            const sd = Math.sqrt(ys.reduce((a,b)=>a+(b-mean)*(b-mean),0)/ys.length);
            const mx = Math.max(...ys.map(y => Math.abs(y-mean)));
            // 기울기(직선 성분)
            const xs = pts.map(p=>p.x); const mxx = xs.reduce((a,b)=>a+b,0)/xs.length;
            let sxy=0,sxx=0; for (let i=0;i<xs.length;i++){sxy+=(xs[i]-mxx)*(ys[i]-mean);sxx+=(xs[i]-mxx)*(xs[i]-mxx);}
            stats.push({ sd: +sd.toFixed(1), mx: +mx.toFixed(1), tilt: +(Math.atan(sxx?sxy/sxx:0)*180/Math.PI).toFixed(2), len: xs[xs.length-1]-xs[0] });
        }
        const n = stats.length;
        const agg = n ? { lines: n, meanSd: +(stats.reduce((a,s)=>a+s.sd,0)/n).toFixed(2), maxDev: Math.max(...stats.map(s=>s.mx)), meanAbsTilt: +(stats.reduce((a,s)=>a+Math.abs(s.tilt),0)/n).toFixed(2), worstTilt: stats.reduce((a,s)=>Math.abs(s.tilt)>Math.abs(a)?s.tilt:a,0) } : null;
        return [c.width, c.height, c.toDataURL('image/jpeg', 0.92), agg];
    }""")
    res["line_metric"] = out[3]
    res["full_out"] = out[:2]
    open(f"C:/python_work/test_photos/app_out_{PHOTO}", "wb").write(base64.b64decode(out[2].split(",", 1)[1]))
    # 옵션 토글 동작
    pg.click("#opt-textrect"); pg.wait_for_timeout(2500)
    res["toggle_off"] = pg.evaluate("() => state.pages[0].textRect === false && !document.getElementById('opt-textrect').classList.contains('active')")
    pg.click("#opt-textrect"); pg.wait_for_timeout(500)
    res["console_errors"] = errs[:5]
    b.close()
server.shutdown()
for k, v in res.items(): print(k, v)
# 글줄 수평 측정 (세로 띠 5개 상관 → 기울기)
from PIL import Image
import numpy as np
im = np.asarray(Image.open(f"C:/python_work/test_photos/app_out_{PHOTO}").convert("L"), dtype=float)
H, W = im.shape
def prof(a, b):
    p = im[:, int(W*a):int(W*b)].mean(axis=1); return p - p.mean()
c = prof(0.4, 0.6); xs, ys = [], []
for k in range(5):
    a = 0.06 + 0.88*k/5; bnd = 0.06 + 0.88*(k+1)/5; s = prof(a, bnd)
    best = (0, -1e18)
    for sh in range(-int(H*0.08), int(H*0.08)+1):
        v = float(np.dot(c[max(0,-sh):H-max(0,sh)], s[max(0,sh):H-max(0,-sh)]))
        if v > best[1]: best = (sh, v)
    xs.append(W*(a+bnd)/2); ys.append(best[0])
slope = np.polyfit(xs, ys, 1)[0]
print(f"글줄 기울기 {np.degrees(np.arctan(slope)):.2f}도, 띠 시프트 {ys} (높이 {H})")
