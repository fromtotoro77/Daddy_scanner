# 파라미터 복원 실험: 모델 자신으로 렌더링한 합성(정답 아는 이미지)에서
# 옵티마이저가 정답 파라미터를 복원하고 평탄화가 3px 이내로 펴지는지 측정
import base64, functools, http.server, threading, json
from playwright.sync_api import sync_playwright

SCRATCH = r"C:/Users/ToTo/AppData/Local/Temp/claude/c--python-work/a92b09e6-f53b-4eb4-8c03-a5a796985259/scratchpad"
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
PORT = 8802
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT),
    functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()

JS = """(caseP) => {
    const W = 700, H = 1000;
    // ==== 1) 정답 파라미터로 페이지 렌더링 ====
    const gt = Object.assign(pmInit({x0: W*0.14, x1: W*0.86, y0: H*0.12, y1: H*0.88, slack: 0}, W, H), caseP);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#191817';
    ctx.fillRect(0, 0, W, H);
    const NU = 70, NV = 90;
    const grid = [];
    for (let j = 0; j <= NV; j++) {
        grid.push([]);
        for (let i = 0; i <= NU; i++) grid[j].push(pmProject(gt, i / NU, j / NV, W, H));
    }
    for (let j = 0; j < NV; j++) {
        for (let i = 0; i < NU; i++) {
            const v = (j + 0.5) / NV;
            const lineBand = (v * 13) % 1 < 0.16 && v > 0.06 && v < 0.94;
            ctx.fillStyle = lineBand ? '#262629' : '#f5f3ef';
            const p00 = grid[j][i], p10 = grid[j][i+1], p11 = grid[j+1][i+1], p01 = grid[j+1][i];
            ctx.beginPath();
            ctx.moveTo(p00[0], p00[1]); ctx.lineTo(p10[0], p10[1]);
            ctx.lineTo(p11[0], p11[1]); ctx.lineTo(p01[0], p01[1]);
            ctx.closePath(); ctx.fill();
        }
    }

    // ==== 2) 엣지 거리장 (가이드 링 마스크) ====
    const src = cv.imread(c);
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur2 = new cv.Mat(); cv.GaussianBlur(gray, blur2, new cv.Size(5,5), 0);
    const edges = new cv.Mat(); cv.Canny(blur2, edges, 40, 120);
    const found = findDocQuad(c, 0.15);
    let g;
    if (found) {
        const xs = [found.quad.tl.x, found.quad.tr.x, found.quad.br.x, found.quad.bl.x];
        const ys = [found.quad.tl.y, found.quad.tr.y, found.quad.br.y, found.quad.bl.y];
        g = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), slack: 25 };
    } else g = { x0: W*0.06, x1: W*0.94, y0: H*0.06, y1: H*0.94, slack: 30 };
    const band = Math.max(20, Math.round(Math.max(W,H) * 0.05));
    const ring = cv.Mat.zeros(H, W, cv.CV_8U);
    cv.rectangle(ring, new cv.Point(g.x0-band, g.y0-band), new cv.Point(g.x1+band, g.y1+band), new cv.Scalar(255), -1);
    cv.rectangle(ring, new cv.Point(g.x0+band, g.y0+band), new cv.Point(g.x1-band, g.y1-band), new cv.Scalar(0), -1);
    cv.bitwise_and(edges, ring, edges);
    const inv = new cv.Mat(); cv.threshold(edges, inv, 50, 255, cv.THRESH_BINARY_INV);
    const distM = new cv.Mat(); cv.distanceTransform(inv, distM, cv.DIST_L2, 3);
    const field = { dist: new Float32Array(distM.data32F), gray: new Uint8Array(blur2.data) };
    src.delete(); gray.delete(); blur2.delete(); edges.delete(); inv.delete(); distM.delete(); ring.delete();

    // ==== 3) 피팅 (정답을 모르는 상태에서) ====
    const t0 = performance.now();
    const init = pmInit(g, W, H);
    const { P, score } = pmFitMulti(field, W, H, g, init);
    const ms = Math.round(performance.now() - t0);

    // ==== 4) 평가: 외곽선 평균 오차(정답 대비) + 평탄화 직선도 ====
    const gtPts = pmOutline(gt, W, H, 20, 10);
    const fitPts = pmOutline(P, W, H, 20, 10);
    let errSum = 0;
    for (let i = 0; i < gtPts.length; i++) {
        errSum += Math.hypot(gtPts[i][0] - fitPts[i][0], gtPts[i][1] - fitPts[i][1]);
    }
    const outlineErr = errSum / gtPts.length;

    const rm = pmBuildRemap(P, W, H, 500, 700);
    const mX = cv.matFromArray(700, 500, cv.CV_32FC1, Array.from(rm.mapX));
    const mY = cv.matFromArray(700, 500, cv.CV_32FC1, Array.from(rm.mapY));
    const src2 = cv.imread(c);
    const dst = new cv.Mat();
    cv.remap(src2, dst, mX, mY, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    const oc = document.createElement('canvas');
    cv.imshow(oc, dst);
    src2.delete(); dst.delete(); mX.delete(); mY.delete();

    return {
        ms, score: Math.round(score), outlineErr: +outlineErr.toFixed(1),
        gt: { z1: gt.z1, z2: gt.z2, rx: gt.rx, ry: gt.ry },
        fit: { z1: +P.z1.toFixed(3), z2: +P.z2.toFixed(3), rx: +P.rx.toFixed(3), ry: +P.ry.toFixed(3) },
        out: oc.toDataURL('image/jpeg', 0.9),
    };
}"""

cases = [
    ("flat",   {}),
    ("curlA",  {"z1": 0.10, "z2": 0.16}),
    ("curlB",  {"z1": 0.18, "z2": 0.06, "ry": -0.12}),
    ("tilt",   {"z1": 0.08, "z2": 0.12, "rx": 0.12, "ry": 0.10, "rz": 0.03}),
]

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 500, "height": 900})
    pg.set_default_timeout(300000)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"):
            break
        pg.wait_for_timeout(1000)
    pg.add_script_tag(path=SCRATCH + "/pagemodel.js")
    import numpy as np
    from PIL import Image
    import io
    for name, gtP in cases:
        r = pg.evaluate(JS, gtP)
        # 평탄화 직선도 측정
        img = np.array(Image.open(io.BytesIO(base64.b64decode(r["out"].split(",",1)[1]))).convert("L"))
        Hh, Ww = img.shape
        colns = [int(Ww*f) for f in (0.2, 0.4, 0.6, 0.8)]
        def centers(cx):
            dark = img[:, cx] < 100
            res, y = [], 0
            while y < Hh:
                if dark[y]:
                    y2 = y
                    while y2 < Hh and dark[y2]: y2 += 1
                    if 3 <= y2-y <= 60: res.append((y+y2-1)/2)
                    y = y2
                else: y += 1
            return res
        sets = [centers(cx) for cx in colns]
        counts = [len(s) for s in sets]
        # 기준 열(두 번째)의 각 줄을 다른 열의 최근접 줄과 매칭 (인덱스 어긋남 방지)
        ref = sets[1] if len(sets) > 1 else []
        devs = []
        for y0 in ref:
            ds = []
            okm = True
            for s in sets:
                if not s: okm = False; break
                near = min(s, key=lambda yy: abs(yy - y0))
                if abs(near - y0) > 40: okm = False; break
                ds.append(near)
            if okm and len(ds) == len(sets):
                devs.append(max(ds) - min(ds))
        dev = max(devs) if len(devs) >= 4 else -1
        ok = "PASS" if 0 <= dev < Hh*0.006 and r["outlineErr"] < 4 else "FAIL"
        print(f"[{name}] cols={counts} matched={len(devs)} | {ok} fit={r['ms']}ms outlineErr={r['outlineErr']}px lineDev={dev:.1f}px "
              f"gt(z1,z2,rx,ry)=({r['gt']['z1']},{r['gt']['z2']},{r['gt']['rx']},{r['gt']['ry']}) "
              f"fit=({r['fit']['z1']},{r['fit']['z2']},{r['fit']['rx']},{r['fit']['ry']})")
        with open(f"pm2_{name}.jpg", "wb") as f:
            f.write(base64.b64decode(r["out"].split(",",1)[1]))
    b.close()
server.shutdown()
print("done")
