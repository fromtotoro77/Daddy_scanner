import base64, functools, http.server, threading, json, sys, os
from playwright.sync_api import sync_playwright
SCRATCH = r"C:/Users/ToTo/AppData/Local/Temp/claude/c--python-work/a92b09e6-f53b-4eb4-8c03-a5a796985259/scratchpad"
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
PORT = 8940
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
GT = json.load(open(SCRATCH + "/gt.json"))
NAME = sys.argv[1]
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
    const gtC = { tl: sc(gt.corners.tl), tr: sc(gt.corners.tr), br: sc(gt.corners.br), bl: sc(gt.corners.bl) };
    const src = cv.imread(dc); const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const text = pmExtractTextLines(gray, W, H);
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
    const gtGuide = { x0: Math.min(gtC.tl.x, gtC.bl.x), x1: Math.max(gtC.tr.x, gtC.br.x), y0: Math.min(gtC.tl.y, gtC.tr.y), y1: Math.max(gtC.bl.y, gtC.br.y), slack: 0.02*Math.max(W,H), w: 6 };
    const P0 = pmAlignToQuad(gtC, W, H, pmInit(gtGuide, W, H)).P;
    gtGuide.anchorC = gtC; gtGuide.slack = 0.01*Math.max(W,H); gtGuide.w = 20;
    const P1 = pmFitMulti(field, W, H, gtGuide, P0).P;
    const perLine = (P) => {
        const c = [pmProject(P,0,0,W,H), pmProject(P,1,0,W,H), pmProject(P,1,1,W,H), pmProject(P,0,1,W,H)];
        const seedH = pmHomography4(c.map(p => [p[0], p[1]]), [[0,0],[1,0],[1,1],[0,1]]);
        const out = [];
        for (const line of text.lines) {
            const vs = [], us = [];
            for (const q of line) { const uv = pmInverse(P, W, H, q.x, q.y, seedH); if (uv) { vs.push(uv[1]); us.push(uv[0]); } }
            if (vs.length < 6) { out.push(null); continue; }
            const m = vs.reduce((a,b)=>a+b,0)/vs.length;
            const sd = Math.sqrt(vs.reduce((a,b)=>a+(b-m)*(b-m),0)/vs.length);
            // 선형 기울기 성분: v vs u 회귀
            const mu = us.reduce((a,b)=>a+b,0)/us.length; let sxy=0,sxx=0;
            for (let i=0;i<us.length;i++){sxy+=(us[i]-mu)*(vs[i]-m);sxx+=(us[i]-mu)*(us[i]-mu);}
            out.push({ v: +m.toFixed(3), sd: +(sd*1000).toFixed(1), slope: +(sxx? sxy/sxx*1000:0).toFixed(1), n: vs.length });
        }
        return out;
    };
    const w = Number(window.TLW || 100);
    const P2 = pmRefineByTextLines(field, W, H, P1, text, { w, slack: 0.008, wPts: 20 });
    const L1 = perLine(P1), L2 = perLine(P2);
    const agg = (L) => { const v = L.filter(Boolean); return { lines: v.length, meanSd: +(v.reduce((a,l)=>a+l.sd,0)/v.length).toFixed(1), meanSlope: +(v.reduce((a,l)=>a+l.slope,0)/v.length).toFixed(1) }; };
    return { nLines: text.lines.length, sample: L1.slice(0, 6), before: agg(L1), after: agg(L2),
             score1: +pmTextLineScore(P1, text, W, H, true).toFixed(1), score2: +pmTextLineScore(P2, text, W, H, true).toFixed(1),
             P1: { rx:+P1.rx.toFixed(3), ry:+P1.ry.toFixed(3), rz:+P1.rz.toFixed(3), tw:+(P1.tw||0).toFixed(3) }, P2: { rx:+P2.rx.toFixed(3), ry:+P2.ry.toFixed(3), rz:+P2.rz.toFixed(3), tw:+(P2.tw||0).toFixed(3) } };
}"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 500, "height": 900}); pg.set_default_timeout(300000)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    pg.add_script_tag(path=SCRATCH + "/pagemodel.js")
    pg.evaluate(f"() => {{ window.TLW = {os.environ.get('TLW','100')}; }}")
    b64 = base64.b64encode(open(rf"C:/python_work/test_photos/{NAME}", "rb").read()).decode()
    r = pg.evaluate(JS, [b64, GT[NAME]])
    for k, v in r.items(): print(k, json.dumps(v, ensure_ascii=False))
    b.close()
server.shutdown()
