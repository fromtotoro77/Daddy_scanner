# 펼침면(새 엔진 경로) 검증: 합성 펼침면(좌우 페이지 곡면+책등 그림자+글줄) → 2페이지, 각 페이지 모델 피팅,
# 출력이 세로형인지, 글줄이 수평인지, 책등 쪽 가장자리에 어두운 띠가 남지 않는지
import base64, functools, http.server, threading, math
from PIL import Image, ImageDraw
import numpy as np
from playwright.sync_api import sync_playwright
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"; PORT = 9091
CW, CH = 2400, 1800
img = Image.new('RGB', (CW, CH), (40, 38, 36)); d = ImageDraw.Draw(img)
# 두 페이지: 책등(x=1200) 쪽으로 갈수록 위아래로 휘는 곡면 흉내 — 글줄을 곡선으로 그림
SP = 1200
def curve_y(x, y0, side):
    t = (abs(x - SP)) / 1000.0  # 책등에서의 거리 0~1
    return y0 - 60 * math.exp(-4 * t)  # 책등 근처에서 위로 들림
for side, x0, x1 in (('L', 220, SP), ('R', SP, 2180)):
    # 페이지 배경(흰색) — 상단/하단 경계도 곡선
    pts_top = [(x, curve_y(x, 200, side)) for x in range(x0, x1 + 1, 10)]
    pts_bot = [(x, curve_y(x, int(CH*0.94), side) + 60) for x in range(x1, x0 - 1, -10)]  # 바깥쪽 끝이 94% 바닥선에 닿고 책등 쪽은 들림
    d.polygon(pts_top + pts_bot, fill=(246, 244, 240))
    for y0 in range(320, int(CH*0.94) - 80, 70):
        pts = [(x, curve_y(x, y0, side)) for x in range(x0 + 80, x1 - 80, 8)]
        d.line(pts, fill=(40, 40, 44), width=7)
for gx in range(SP - 26, SP + 26):  # 책등 그림자
    depth = 1 - abs(gx - SP) / 26; v = int(244 - 170 * depth)
    d.line([(gx, 150), (gx, 1700)], fill=(v, v - 2, v - 4))
img.save('spread2.png')
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
b64 = base64.b64encode(open('spread2.png', 'rb').read()).decode()
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    pg = b.new_page(viewport={"width": 890, "height": 412}); pg.set_default_timeout(300000)
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append(m.type + ": " + m.text) if m.type in ("error", "warning") else None)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    r = pg.evaluate("""async (b64) => {
        state.spreadMode = true;
        const res = await fetch('data:image/png;base64,' + b64); const blob = await res.blob();
        const t0 = performance.now();
        await addCapturedBlob(blob, true, true);
        for (let i = 0; i < 120; i++) { if (state.pages.length >= 2 && state.pages.every(p => p.model !== undefined)) break; await new Promise(r => setTimeout(r, 500)); }
        const out = [];
        for (const p of state.pages) {
            const c = await processPage(p, 2500);
            const m = cv.imread(c); const g = new cv.Mat(); cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
            const W = c.width, H = c.height, gd = g.data;
            const colMean = (x0, x1) => { let s = 0, n = 0; for (let y = Math.round(H*0.2); y < H*0.8; y++) for (let x = x0; x < x1; x++) { s += gd[y*W+x]; n++; } return s / n; };
            const inner = p.spreadSide === 'left' ? colMean(Math.round(W*0.97), W) : colMean(0, Math.round(W*0.03));
            const center = colMean(Math.round(W*0.45), Math.round(W*0.55));
            out.push({ side: p.spreadSide, hasModel: !!p.model, corners: !!p.corners, w: W, h: H, portrait: H > W, innerEdgeBrightness: Math.round(inner), centerBrightness: Math.round(center), data: c.toDataURL('image/jpeg', 0.85) });
            m.delete(); g.delete();
        }
        return { n: state.pages.length, ms: Math.round(performance.now() - t0), out };
    }""", b64)
    print("pages:", r["n"], "elapsed:", r["ms"], "ms")
    for i, o in enumerate(r["out"]):
        print(f"  page{i+1} side={o['side']} model={o['hasModel']} corners={o['corners']} {o['w']}x{o['h']} portrait={o['portrait']} 책등쪽밝기={o['innerEdgeBrightness']} 중앙={o['centerBrightness']}")
        open(f"spread2_out{i+1}.jpg", "wb").write(base64.b64decode(o["data"].split(",",1)[1]))
    print("errors:", errs[:5])
    b.close()
server.shutdown()
# 글줄 수평 측정
for i in (1, 2):
    im = np.asarray(Image.open(f"spread2_out{i}.jpg").convert("L"), dtype=float); H, W = im.shape
    def prof(a, b2): p = im[:, int(W*a):int(W*b2)].mean(axis=1); return p - p.mean()
    c = prof(0.4, 0.6); xs, ys = [], []
    for k in range(5):
        a = 0.06 + 0.88*k/5; bb = 0.06 + 0.88*(k+1)/5; s = prof(a, bb); best = (0, -1e18)
        for sh in range(-int(H*0.08), int(H*0.08)+1):
            v = float(np.dot(c[max(0,-sh):H-max(0,sh)], s[max(0,sh):H-max(0,-sh)]))
            if v > best[1]: best = (sh, v)
        xs.append(W*(a+bb)/2); ys.append(best[0])
    print(f"  page{i} 글줄 띠시프트 {ys} (높이 {H}) 기울기 {np.degrees(np.arctan(np.polyfit(xs, ys, 1)[0])):.2f}도")
