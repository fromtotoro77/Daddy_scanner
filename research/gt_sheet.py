# 신뢰영역 피팅 결과 시각화: 정답(초록) vs 알고리즘(빨강) + 평탄화
import base64, functools, http.server, threading, json
from playwright.sync_api import sync_playwright

SCRATCH = r"C:/Users/ToTo/AppData/Local/Temp/claude/c--python-work/a92b09e6-f53b-4eb4-8c03-a5a796985259/scratchpad"
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
PORT = 8804
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT),
    functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
GT = json.load(open(SCRATCH + "/gt.json"))

JS = """async (arg) => {
    const [b64, gt] = arg;
    const res = await fetch('data:image/jpeg;base64,' + b64);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const im = new Image();
    await new Promise((ok, ng) => { im.onload = ok; im.onerror = ng; im.src = url; });
    URL.revokeObjectURL(url);
    const scale = Math.min(1, 1000 / Math.max(im.width, im.height));
    const dc = document.createElement('canvas');
    dc.width = Math.round(im.width * scale);
    dc.height = Math.round(im.height * scale);
    dc.getContext('2d').drawImage(im, 0, 0, dc.width, dc.height);
    const W = dc.width, H = dc.height;
    const S = im.width / gt.w * scale;
    const sc = (p) => ({ x: p.x * S, y: p.y * S });
    const gtC = { tl: sc(gt.corners.tl), tr: sc(gt.corners.tr), br: sc(gt.corners.br), bl: sc(gt.corners.bl) };

    // 엣지 증거
    const src = cv.imread(dc);
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur2 = new cv.Mat(); cv.GaussianBlur(gray, blur2, new cv.Size(5,5), 0);
    const edges = new cv.Mat(); cv.Canny(blur2, edges, 40, 120);
    const k3 = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, k3, new cv.Point(-1,-1), 1);
    const cnts = new cv.MatVector(); const hier = new cv.Mat();
    cv.findContours(edges, cnts, hier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
    const clean = cv.Mat.zeros(H, W, cv.CV_8U);
    const minLen = 0.35 * Math.min(W, H);
    for (let i = 0; i < cnts.size(); i++) {
        const cc = cnts.get(i);
        if (cv.arcLength(cc, false) >= minLen) cv.drawContours(clean, cnts, i, new cv.Scalar(255), 1);
        cc.delete();
    }
    cnts.delete(); hier.delete(); k3.delete();
    const inv = new cv.Mat(); cv.threshold(clean, inv, 50, 255, cv.THRESH_BINARY_INV);
    const distM = new cv.Mat(); cv.distanceTransform(inv, distM, cv.DIST_L2, 3);
    const bb = new cv.Mat(); cv.GaussianBlur(gray, bb, new cv.Size(21, 21), 5);
    const gx = new cv.Mat(), gy = new cv.Mat();
    cv.Sobel(bb, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(bb, gy, cv.CV_32F, 0, 1, 3);
    const softArr = new Float32Array(W * H);
    { const a = gx.data32F, b = gy.data32F; const tmp = [];
      for (let i = 0; i < W * H; i++) { softArr[i] = Math.hypot(a[i], b[i]); if ((i & 31) === 0) tmp.push(softArr[i]); }
      tmp.sort((p, q) => p - q); const ref = tmp[Math.floor(tmp.length * 0.99)] || 1;
      for (let i = 0; i < W * H; i++) softArr[i] = Math.min(1, softArr[i] / ref); }
    bb.delete(); gx.delete(); gy.delete();
    const field = { dist: new Float32Array(distM.data32F), gray: new Uint8Array(blur2.data), soft: softArr };
    src.delete(); gray.delete(); blur2.delete(); edges.delete(); clean.delete(); inv.delete(); distM.delete();

    // 정렬 초기화 + 신뢰영역 피팅
    const gtGuide = {
        x0: Math.min(gtC.tl.x, gtC.bl.x), x1: Math.max(gtC.tr.x, gtC.br.x),
        y0: Math.min(gtC.tl.y, gtC.tr.y), y1: Math.max(gtC.bl.y, gtC.br.y),
        slack: 0.02 * Math.max(W, H), w: 6.0,
    };
    const al = pmAlignToQuad(gtC, W, H, pmInit(gtGuide, W, H));
    const P0 = al.P;
    gtGuide.anchorC = gtC;
    gtGuide.slack = 0.01 * Math.max(W, H);
    gtGuide.w = 20;
    const P = pmRefineInterior(field, W, H, pmFitMulti(field, W, H, gtGuide, P0).P, 300, 0.003, 60);

    // 시각화
    const ctx = dc.getContext('2d');
    const drawPoly = (pts, color, wpx) => {
        ctx.strokeStyle = color; ctx.lineWidth = wpx;
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
        for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
    };
    drawPoly(gt.top.map(sc), 'rgba(74,222,128,0.9)', 3);
    drawPoly(gt.bottom.map(sc), 'rgba(74,222,128,0.9)', 3);
    drawPoly([gtC.tl, gtC.bl], 'rgba(74,222,128,0.9)', 3);
    drawPoly([gtC.tr, gtC.br], 'rgba(74,222,128,0.9)', 3);
    const mline = (v) => Array.from({length: 25}, (_, i) => {
        const p = pmProject(P, i / 24, v, W, H); return { x: p[0], y: p[1] };
    });
    const mside = (u) => Array.from({length: 9}, (_, i) => {
        const p = pmProject(P, u, i / 8, W, H); return { x: p[0], y: p[1] };
    });
    drawPoly(mline(0), 'rgba(244,63,94,0.95)', 2);
    drawPoly(mline(1), 'rgba(244,63,94,0.95)', 2);
    drawPoly(mside(0), 'rgba(244,63,94,0.95)', 2);
    drawPoly(mside(1), 'rgba(244,63,94,0.95)', 2);

    // 평탄화
    const outH = Math.round(gtGuide.y1 - gtGuide.y0);
    const outW = Math.max(60, Math.round(outH * pmFlatAspect(P))); // 화면 bbox가 아니라 모델의 실제 페이지 비율
    const rm = pmBuildRemap(P, W, H, outW, outH);
    const mX = cv.matFromArray(outH, outW, cv.CV_32FC1, Array.from(rm.mapX));
    const mY = cv.matFromArray(outH, outW, cv.CV_32FC1, Array.from(rm.mapY));
    const src2raw = document.createElement('canvas'); // 선 없는 원본으로 평탄화
    src2raw.width = W; src2raw.height = H;
    src2raw.getContext('2d').drawImage(im, 0, 0, W, H);
    const src2 = cv.imread(src2raw);
    const dst = new cv.Mat();
    cv.remap(src2, dst, mX, mY, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    // 테두리 배경 띠 제거
    const gF = new cv.Mat(); cv.cvtColor(dst, gF, cv.COLOR_RGBA2GRAY);
    const tb = pmTrimDarkBorders(gF.data, outW, outH); gF.delete();
    const roi = dst.roi(new cv.Rect(tb.x0, tb.y0, tb.x1 - tb.x0, tb.y1 - tb.y0));
    const oc = document.createElement('canvas');
    cv.imshow(oc, roi); roi.delete();
    src2.delete(); dst.delete(); mX.delete(); mY.delete();

    return { viz: dc.toDataURL('image/jpeg', 0.85), out: oc.toDataURL('image/jpeg', 0.88) };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 500, "height": 900})
    pg.set_default_timeout(300000)
    pg.goto(f"http://{'127.0.0.1'}:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"):
            break
        pg.wait_for_timeout(1000)
    pg.add_script_tag(path=SCRATCH + "/pagemodel.js")
    pass  # 엔진 기본값 사용
    for idx, name in enumerate(GT.keys(), 1):
        with open(rf"C:/python_work/test_photos/{name}", "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        r = pg.evaluate(JS, [b64, GT[name]])
        n = idx
        with open(f"gts{n}_viz.jpg", "wb") as f:
            f.write(base64.b64decode(r["viz"].split(",", 1)[1]))
        with open(f"gts{n}_out.jpg", "wb") as f:
            f.write(base64.b64decode(r["out"].split(",", 1)[1]))
        print(name, "done")
    b.close()
server.shutdown()

from PIL import Image, ImageDraw
rows = []
for i in range(1, len(GT) + 1):
    a = Image.open(f'gts{i}_viz.jpg'); a.thumbnail((760, 520))
    bb = Image.open(f'gts{i}_out.jpg'); bb.thumbnail((760, 520))
    w = a.width + bb.width + 25
    h = max(a.height, bb.height) + 42
    c = Image.new('RGB', (w, h), (18, 18, 20))
    d = ImageDraw.Draw(c)
    c.paste(a, (0, 36)); c.paste(bb, (a.width + 25, 36))
    d.text((8, 8), f'{i}: GREEN=your truth / RED=algorithm', fill=(140, 220, 150))
    d.text((a.width + 33, 8), 'FLATTENED', fill=(220, 220, 220))
    rows.append(c)
W = max(r.width for r in rows); H = sum(r.height for r in rows) + 12 * len(rows)
s = Image.new('RGB', (W, H), (12, 12, 14)); y = 0
for r in rows:
    s.paste(r, (0, y)); y += r.height + 12
s.save('C:/python_work/test_photos/trustfit_v11_final.jpg', quality=88)
print('sheet saved')
