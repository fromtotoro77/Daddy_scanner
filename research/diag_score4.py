import base64, functools, http.server, threading, json, sys
from playwright.sync_api import sync_playwright
SCRATCH = r"C:/Users/ToTo/AppData/Local/Temp/claude/c--python-work/a92b09e6-f53b-4eb4-8c03-a5a796985259/scratchpad"
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
PORT = 8806
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
GT = json.load(open(SCRATCH + "/gt.json"))
NAME = sys.argv[1] if len(sys.argv) > 1 else "KakaoTalk_20260820_164818285.jpg"
JS = """async (arg) => {
    const [b64, gt] = arg;
    const res = await fetch('data:image/jpeg;base64,' + b64); const blob = await res.blob();
    const url = URL.createObjectURL(blob); const im = new Image();
    await new Promise((ok, ng) => { im.onload = ok; im.onerror = ng; im.src = url; }); URL.revokeObjectURL(url);
    const scale = Math.min(1, 1000 / Math.max(im.width, im.height));
    const dc = document.createElement('canvas'); dc.width = Math.round(im.width * scale); dc.height = Math.round(im.height * scale);
    dc.getContext('2d').drawImage(im, 0, 0, dc.width, dc.height);
    const W = dc.width, H = dc.height, S = im.width / gt.w * scale;
    const sc = (p) => ({ x: p.x * S, y: p.y * S });
    const gtTop = gt.top.map(sc), gtBot = gt.bottom.map(sc);
    const gtC = { tl: sc(gt.corners.tl), tr: sc(gt.corners.tr), br: sc(gt.corners.br), bl: sc(gt.corners.bl) };
    const src = cv.imread(dc); const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur2 = new cv.Mat(); cv.GaussianBlur(gray, blur2, new cv.Size(5,5), 0);
    const edges = new cv.Mat(); cv.Canny(blur2, edges, 40, 120);
    const k3 = cv.Mat.ones(3, 3, cv.CV_8U); cv.dilate(edges, edges, k3, new cv.Point(-1,-1), 1);
    const cnts = new cv.MatVector(); const hier = new cv.Mat();
    cv.findContours(edges, cnts, hier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
    const clean = cv.Mat.zeros(H, W, cv.CV_8U); const minLen = 0.35 * Math.min(W, H);
    for (let i = 0; i < cnts.size(); i++) { const cc = cnts.get(i); if (cv.arcLength(cc, false) >= minLen) cv.drawContours(clean, cnts, i, new cv.Scalar(255), 1); cc.delete(); }
    const inv = new cv.Mat(); cv.threshold(clean, inv, 50, 255, cv.THRESH_BINARY_INV);
    const distM = new cv.Mat(); cv.distanceTransform(inv, distM, cv.DIST_L2, 3);
    const field = { dist: new Float32Array(distM.data32F), gray: new Uint8Array(blur2.data) };
    const rawEdges = new Uint8Array(edges.data);
    const g = field.gray;
    const dAt = (p) => field.dist[Math.round(p.y) * W + Math.round(p.x)];
    // 정답선 위 증거: 긴 엣지까지 거리, 원시 Canny 존재율
    const sampPoly = (poly, n) => { // 폴리라인 등간격 샘플
        const out = []; let tot = 0; const segs = [];
        for (let i = 0; i + 1 < poly.length; i++) { const L = Math.hypot(poly[i+1].x-poly[i].x, poly[i+1].y-poly[i].y); segs.push(L); tot += L; }
        for (let k = 0; k < n; k++) { let t = tot * k / (n - 1), i = 0; while (i < segs.length - 1 && t > segs[i]) { t -= segs[i]; i++; }
            const f = segs[i] ? t / segs[i] : 0; out.push({ x: poly[i].x + (poly[i+1].x-poly[i].x)*f, y: poly[i].y + (poly[i+1].y-poly[i].y)*f }); }
        return out;
    };
    const evidence = (poly) => {
        const pts = sampPoly(poly, 30); let sd = 0, raw = 0;
        for (const p of pts) { sd += dAt(p); let hit = 0;
            for (let dy = -3; dy <= 3 && !hit; dy++) for (let dx = -3; dx <= 3; dx++) { const x = Math.round(p.x)+dx, y = Math.round(p.y)+dy; if (x>=0&&y>=0&&x<W&&y<H&&rawEdges[y*W+x]) { hit = 1; break; } }
            raw += hit; }
        return { longEdgeDist: +(sd / pts.length / S).toFixed(1), rawCannyRate: +(raw / pts.length).toFixed(2) };
    };
    const gtLeft = [gtC.tl, gtC.bl], gtRight = [gtC.tr, gtC.br];
    const ev = { top: evidence(gtTop), bottom: evidence(gtBot), left: evidence(gtLeft), right: evidence(gtRight) };

    const mk = (w) => { const g = { x0: Math.min(gtC.tl.x, gtC.bl.x), x1: Math.max(gtC.tr.x, gtC.br.x), y0: Math.min(gtC.tl.y, gtC.tr.y), y1: Math.max(gtC.bl.y, gtC.br.y), slack: 0.015*Math.max(W,H), w: w, anchorC: gtC }; return g; };
    const P0 = pmAlignToQuad(gtC, W, H, pmInit(mk(6), W, H)).P;
    window.PM_CURV_W = 150;
    const Pgood = pmFitMulti(field, W, H, mk(20), P0).P;
    const Pbad = pmFitMulti(field, W, H, mk(30), P0).P;
    const breakdown = (P, w) => {
        const save = window.PM_CURV_W; window.PM_CURV_W = 0;
        const chamfer = pmScore(P, { dist: field.dist }, W, H, null);
        const anchor = pmScore(P, { dist: field.dist }, W, H, mk(w)) - chamfer;
        window.PM_CURV_W = save;
        const curv = -150 * (Math.abs(P.z1)+Math.abs(P.z2)+Math.abs(P.z1b??P.z1)+Math.abs(P.z2b??P.z2));
        const inter = 1.6 * pmInteriorScore(P, field.gray, W, H);
        const pol = 0.45 * pmPolarityScore(P, field.gray, W, H);
        const mar = 1.2 * pmMarginScore(P, field.gray, W, H);
        const total = pmScore(P, field, W, H, mk(w));
        return { chamfer: Math.round(chamfer), anchor: Math.round(anchor), curv: Math.round(curv), interior: Math.round(inter), polarity: Math.round(pol), margin: Math.round(mar), total: Math.round(total) };
    };
    const err = (P) => { const pts = Array.from({length: 21}, (_, i) => { const p = pmProject(P, i/20, 0, W, H); return {x:p[0],y:p[1]}; });
        let s=0; for (const p of pts) { let best=1e9; for (let i=0;i+1<gtTop.length;i++){const a=gtTop[i],b=gtTop[i+1];const vx=b.x-a.x,vy=b.y-a.y;const L2=vx*vx+vy*vy||1;let t=((p.x-a.x)*vx+(p.y-a.y)*vy)/L2;t=Math.max(0,Math.min(1,t));best=Math.min(best,Math.hypot(p.x-(a.x+t*vx),p.y-(a.y+t*vy)));} s+=best; } return Math.round(s/21/S); };
    return { good_under_w30: breakdown(Pgood, 30), bad_under_w30: breakdown(Pbad, 30), good_under_w20: breakdown(Pgood, 20), bad_under_w20: breakdown(Pbad, 20),
             topErr: { good: err(Pgood), bad: err(Pbad) }, Pgood: Object.fromEntries(Object.entries(Pgood).map(([k,v])=>[k,+v.toFixed(3)])), Pbad: Object.fromEntries(Object.entries(Pbad).map(([k,v])=>[k,+v.toFixed(3)])) };
}"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 500, "height": 900}); pg.set_default_timeout(300000)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    pg.add_script_tag(path=SCRATCH + "/pagemodel.js")
    import os
    pg.evaluate(f"() => {{ window.PM_CURV_W = {os.environ.get('CURV_W','150')}; window.PM_GUIDE_W = {os.environ.get('GUIDE_W','20')}; window.PM_SLACK = {os.environ.get('SLACK','0.01')}; }}")
    b64 = base64.b64encode(open(rf"C:/python_work/test_photos/{NAME}", "rb").read()).decode()
    r = pg.evaluate(JS, [b64, GT[NAME]])
    for k, v in r.items(): print(k, json.dumps(v, ensure_ascii=False))
    b.close()
server.shutdown()
