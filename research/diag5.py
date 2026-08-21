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
    // 모델 피팅 (w=150)
    
    const gtGuide = { x0: Math.min(gtC.tl.x, gtC.bl.x), x1: Math.max(gtC.tr.x, gtC.br.x), y0: Math.min(gtC.tl.y, gtC.tr.y), y1: Math.max(gtC.bl.y, gtC.br.y), slack: 0.02*Math.max(W,H), w: 6 };
    const P0 = pmAlignToQuad(gtC, W, H, pmInit(gtGuide, W, H)).P;
    gtGuide.anchorC = gtC; gtGuide.slack = (window.PM_SLACK||0.015)*Math.max(W,H); gtGuide.w = (window.PM_GUIDE_W||8);
    const P = pmFitMulti(field, W, H, gtGuide, P0).P;
    const cornerDev = {};
    for (const [k,u,v] of [['tl',0,0],['tr',1,0],['br',1,1],['bl',0,1]]) { const p = pmProject(P,u,v,W,H); cornerDev[k] = { dx: +((p[0]-gtC[k].x)/S).toFixed(0), dy: +((p[1]-gtC[k].y)/S).toFixed(0) }; }
    // 하단/좌측 모델 vs 정답 부호 오프셋 (원본px, +=아래/오른쪽)
    const nearestY = (poly, x) => { for (let i = 0; i + 1 < poly.length; i++) { const a = poly[i], b = poly[i+1]; if ((x-a.x)*(x-b.x) <= 0 && a.x !== b.x) return a.y + (b.y-a.y)*(x-a.x)/(b.x-a.x); } return null; };
    const botOff = [], topOff = [];
    for (let i = 1; i < 10; i++) { const u = i/10; const p = pmProject(P,u,1,W,H); const gy = nearestY(gtBot, p[0]); botOff.push(gy===null?null:Math.round((p[1]-gy)/S));
        const q = pmProject(P,u,0,W,H); const gy2 = nearestY(gtTop, q[0]); topOff.push(gy2===null?null:Math.round((q[1]-gy2)/S)); }
    const leftOff = [];
    for (let i = 1; i < 8; i++) { const v = i/8; const p = pmProject(P,0,v,W,H); const gx = gtC.tl.x + (gtC.bl.x-gtC.tl.x)*((p[1]-gtC.tl.y)/(gtC.bl.y-gtC.tl.y)); leftOff.push(Math.round((p[0]-gx)/S)); }
    // 모델 하단선 위의 증거
    const modelBot = Array.from({length: 21}, (_, i) => { const p = pmProject(P, i/20, 1, W, H); return {x:p[0], y:p[1]}; });
    const modelLeft = Array.from({length: 9}, (_, i) => { const p = pmProject(P, 0, i/8, W, H); return {x:p[0], y:p[1]}; });
    // 하단 주변 밝기 프로파일: 정답 하단선 기준 법선 방향 -60..+60px(원본) 밝기 (중앙 u=0.5)
    const mid = sampPoly(gtBot, 3)[1]; const prof = [];
    for (let d = -60; d <= 80; d += 10) { const y = Math.round(mid.y + d*S), x = Math.round(mid.x); prof.push(y>=0&&y<H ? g[y*W+x] : -1); }
    const midL = { x: (gtC.tl.x+gtC.bl.x)/2, y: (gtC.tl.y+gtC.bl.y)/2 }; const profL = [];
    for (let d = -80; d <= 60; d += 10) { const x = Math.round(midL.x + d*S), y = Math.round(midL.y); profL.push(x>=0&&x<W ? g[y*W+x] : -1); }
    return { ev, cornerDev, topOff, botOff, leftOff, modelBotEv: evidence(modelBot), modelLeftEv: evidence(modelLeft), botProfile: prof, leftProfile: profL,
             P: { tw:+(P.tw||0).toFixed(3), F:P.F, pw:+P.pw.toFixed(3), ph:+P.ph.toFixed(3), rz:+P.rz.toFixed(3), z1:+P.z1.toFixed(3), z2:+P.z2.toFixed(3), z1b:+(P.z1b??P.z1).toFixed(3), z2b:+(P.z2b??P.z2).toFixed(3), rx:+P.rx.toFixed(3), ry:+P.ry.toFixed(3), rz:+P.rz.toFixed(3) } };
}"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 500, "height": 900}); pg.set_default_timeout(300000)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    pg.add_script_tag(path=SCRATCH + "/pagemodel.js")
    import os
    pg.evaluate(f"() => {{ window.PM_CURV_W = {os.environ.get('CURV_W','150')}; window.PM_GUIDE_W = {os.environ.get('GUIDE_W','20')}; window.PM_SLACK = {os.environ.get('SLACK','0.01')}; window.PM_ROW_W = {os.environ.get('ROW_W','30')}; window.PM_TW_W = {os.environ.get('TW_W','900')}; }}")
    b64 = base64.b64encode(open(rf"C:/python_work/test_photos/{NAME}", "rb").read()).decode()
    r = pg.evaluate(JS, [b64, GT[NAME]])
    for k, v in r.items(): print(k, json.dumps(v, ensure_ascii=False))
    b.close()
server.shutdown()
