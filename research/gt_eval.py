# 정답(사용자 라벨) 기반 자동 채점: 알고리즘 외곽선 vs 정답 폴리라인 평균 오차(원본 px)
import base64, functools, http.server, threading, json, sys
from playwright.sync_api import sync_playwright

SCRATCH = r"C:/Users/ToTo/AppData/Local/Temp/claude/c--python-work/a92b09e6-f53b-4eb4-8c03-a5a796985259/scratchpad"
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
import os
PORT = int(os.environ.get("PORT", "8803"))
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
    const S = im.width / gt.w * scale; // 정답 좌표 → 감지 캔버스 좌표 배율

    // ---- 정답 (감지 캔버스 좌표) ----
    const sc = (p) => ({ x: p.x * S, y: p.y * S });
    const gtTop = gt.top.map(sc), gtBot = gt.bottom.map(sc);
    const gtC = { tl: sc(gt.corners.tl), tr: sc(gt.corners.tr), br: sc(gt.corners.br), bl: sc(gt.corners.bl) };
    const gtLeft = [gtC.tl, gtC.bl], gtRight = [gtC.tr, gtC.br];

    const d2poly = (p, poly) => {
        let best = 1e9;
        for (let i = 0; i + 1 < poly.length; i++) {
            const a = poly[i], b = poly[i + 1];
            const vx = b.x - a.x, vy = b.y - a.y;
            const L2 = vx * vx + vy * vy || 1;
            let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2;
            t = Math.max(0, Math.min(1, t));
            best = Math.min(best, Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy)));
        }
        return best;
    };
    // 외곽선 오차: 곡선/변마다 샘플 점 → 정답 폴리라인까지 평균 거리 (원본 px 환산)
    const evalOutline = (topPts2, botPts2, leftPts2, rightPts2) => {
        let s = 0, n = 0;
        for (const [pts, poly] of [[topPts2, gtTop], [botPts2, gtBot], [leftPts2, gtLeft], [rightPts2, gtRight]]) {
            for (const p of pts) { s += d2poly(p, poly); n++; }
        }
        return (s / n) / S; // 원본 픽셀
    };

    // ---- A) 현재 앱 감지 (기존 방식) ----
    let curErr = null;
    const found = findDocQuad(dc, 0.15);
    if (found) {
        const curves = found.curves || extractCurves(found.contour, found.quad);
        const q = found.quad;
        const tt = curves ? curves.top : sampleLine(q.tl, q.tr, 17);
        const bb = curves ? curves.bottom : sampleLine(q.bl, q.br, 17);
        curErr = evalOutline(tt, bb, sampleLine(q.tl, q.bl, 9), sampleLine(q.tr, q.br, 9));
    }

    // ---- B) 모델 피팅 (긴 엣지 챔퍼 + 다중 초기) ----
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
    // 부드러운 경계장: 강한 블러(σ5) → Sobel 크기 → 상위 1% 기준 정규화
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
    const textInfo = pmExtractTextLines(gray, W, H);
    src.delete(); gray.delete(); blur2.delete(); edges.delete(); clean.delete(); inv.delete(); distM.delete();

    const guides = [
        { x0: W*0.06, x1: W*0.94, y0: H*0.06, y1: H*0.94 },
        { x0: W*0.14, x1: W*0.86, y0: H*0.12, y1: H*0.88 },
    ];
    if (found) {
        const xs = [found.quad.tl.x, found.quad.tr.x, found.quad.br.x, found.quad.bl.x];
        const ys = [found.quad.tl.y, found.quad.tr.y, found.quad.br.y, found.quad.bl.y];
        guides.unshift({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
    let bestFit = null;
    for (const g2 of guides) {
        const r2 = pmFitMulti(field, W, H, null, pmInit(g2, W, H));
        if (!bestFit || r2.score > bestFit.score) bestFit = r2;
    }
    const P = bestFit.P;
    const mline = (v) => Array.from({length: 21}, (_, i) => {
        const p = pmProject(P, i / 20, v, W, H);
        return { x: p[0], y: p[1] };
    });
    const mside = (u) => Array.from({length: 9}, (_, i) => {
        const p = pmProject(P, u, i / 8, W, H);
        return { x: p[0], y: p[1] };
    });
    const fitErr = evalOutline(mline(0), mline(1), mside(0), mside(1));

    // ---- C) 정답 코너 초기화: 무피팅(init 그대로) vs 신뢰영역 피팅 ----
    const gtGuide = {
        x0: Math.min(gtC.tl.x, gtC.bl.x), x1: Math.max(gtC.tr.x, gtC.br.x),
        y0: Math.min(gtC.tl.y, gtC.tr.y), y1: Math.max(gtC.bl.y, gtC.br.y),
        slack: 0.02 * Math.max(W, H), w: 6.0,
    };
    const al = pmAlignToQuad(gtC, W, H, pmInit(gtGuide, W, H));
    const P0 = al.P;
    gtGuide.anchorC = gtC;                    // 신뢰영역 = 모서리 4점만
    gtGuide.slack = (window.PM_SLACK || 0.015) * Math.max(W, H);   // 모서리는 더 엄격
    gtGuide.w = (window.PM_GUIDE_W || 8.0);
    const line0 = (Pp, v) => Array.from({length: 21}, (_, i) => {
        const p = pmProject(Pp, i / 20, v, W, H); return { x: p[0], y: p[1] };
    });
    const side0 = (Pp, u) => Array.from({length: 9}, (_, i) => {
        const p = pmProject(Pp, u, i / 8, W, H); return { x: p[0], y: p[1] };
    });
    const initErr = evalOutline(line0(P0, 0), line0(P0, 1), side0(P0, 0), side0(P0, 1));
    const r3x = pmFitMulti(field, W, H, gtGuide, P0);
    const P3 = (window.PM_TL_W > 0 && textInfo.lines.length >= 4) ? pmRefineByTextLines(field, W, H, r3x.P, textInfo, { w: window.PM_TL_W, slack: window.PM_ROW_SLACK || 0.008, wPts: window.PM_ROW_WPTS || 20 }) : (window.PM_TEXT_FIRST) ? pmFitTextFirst(field, W, H, gtC, P0, window.PM_TEXT_FIRST) : (window.PM_ROW_W2 > 0) ? pmRefineInterior(field, W, H, r3x.P, window.PM_ROW_W2, window.PM_ROW_SLACK || 0.006, window.PM_ROW_WPTS || 20) : r3x.P;
    const oracleErr = evalOutline(line0(P3, 0), line0(P3, 1), side0(P3, 0), side0(P3, 1));
    // 변별 오차 분해
    const edgeErr = {};
    for (const [k, pts, poly] of [["top", line0(P3,0), gtTop], ["bot", line0(P3,1), gtBot], ["left", side0(P3,0), gtLeft], ["right", side0(P3,1), gtRight]]) {
        let se = 0;
        for (const p of pts) se += d2poly(p, poly);
        edgeErr[k] = Math.round(se / pts.length / S * 10) / 10;
    }

    // 평탄화 품질 자동 측정: 펴진 결과에서 좌/중/우 세로 명암 프로파일의 상호 시프트(글줄 어긋남)
    const outH2 = 560, outW2 = Math.max(120, Math.round(outH2 * pmFlatAspect(P3)));
    const bboxAspect = (gtGuide.x1 - gtGuide.x0) / (gtGuide.y1 - gtGuide.y0);
    const aspectFix = +(pmFlatAspect(P3) / bboxAspect).toFixed(3); // 1보다 크면 기존 출력이 가로로 눌려 있었음
    const rm2 = pmBuildRemap(P3, W, H, outW2, outH2);
    const mX2 = cv.matFromArray(outH2, outW2, cv.CV_32FC1, Array.from(rm2.mapX));
    const mY2 = cv.matFromArray(outH2, outW2, cv.CV_32FC1, Array.from(rm2.mapY));
    const srcF = cv.imread(dc); let dstF = new cv.Mat();
    cv.remap(srcF, dstF, mX2, mY2, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    let gF = new cv.Mat(); cv.cvtColor(dstF, gF, cv.COLOR_RGBA2GRAY);
    let rectInfo = null;
    if (window.PM_RECT) {
        const ang = pmDeskewAngle(gF, outW2, outH2);
        if (Math.abs(ang) > 0.05 && Math.abs(ang) < 12) {
            const r0 = pmRotateMat(dstF, ang); dstF.delete(); dstF = r0;
            gF.delete(); gF = new cv.Mat(); cv.cvtColor(dstF, gF, cv.COLOR_RGBA2GRAY);
        }
        const rm = pmTextRectifyMaps(gF, outW2, outH2, window.PM_RECT_MARGIN !== false);
        if (rm) {
            const mXr = cv.matFromArray(outH2, outW2, cv.CV_32FC1, Array.from(rm.mapX));
            const mYr = cv.matFromArray(outH2, outW2, cv.CV_32FC1, Array.from(rm.mapY));
            const d2 = new cv.Mat(); cv.remap(dstF, d2, mXr, mYr, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
            dstF.delete(); mXr.delete(); mYr.delete();
            dstF = d2;
            gF.delete(); gF = new cv.Mat(); cv.cvtColor(dstF, gF, cv.COLOR_RGBA2GRAY);
            rectInfo = { deskew: +ang.toFixed(2), nLines: rm.nLines, maxShift: +rm.maxShift.toFixed(1) };
        }
    }
    const gd = gF.data;
    const prof = (x0, x1) => {
        const pr = new Float64Array(outH2);
        const dark = new Uint8Array(outH2);
        for (let y = 0; y < outH2; y++) {
            let s2 = 0;
            for (let x = x0; x < x1; x++) s2 += gd[y * outW2 + x];
            pr[y] = s2 / (x1 - x0);
            if (pr[y] < 70) dark[y] = 1; // 배경(검은 책상)이 섞인 행 — 글줄 상관에서 제외
        }
        let m = 0, nm = 0;
        for (let y = 0; y < outH2; y++) if (!dark[y]) { m += pr[y]; nm++; }
        m = nm ? m / nm : 0;
        for (let y = 0; y < outH2; y++) pr[y] = dark[y] ? 0 : pr[y] - m;
        return pr;
    };
    const bandC = prof(outW2*0.4|0, outW2*0.6|0);
    // 글줄이 있는 밴드만 상관 (빈 여백·그림 밴드는 상관이 무의미 → 탐색 한계에 포화)
    const textRows = (pr) => { let n = 0, inRun = false; for (let y = 0; y < outH2; y++) { const d = pr[y] < -12; if (d && !inRun) n++; inRun = d; } return n; };
    const shifts = [];
    for (const [a2, b2] of [[outW2*0.08|0, outW2*0.28|0], [outW2*0.72|0, outW2*0.92|0]]) {
        const pb = prof(a2, b2);
        if (textRows(pb) < 4 || textRows(bandC) < 4) continue;
        let bestS = 0, bestC = -1e18;
        for (let sh = -30; sh <= 30; sh++) {
            let cc2 = 0;
            for (let y = Math.max(0, -sh); y < Math.min(outH2, outH2 - sh); y++) cc2 += bandC[y] * pb[y + sh];
            if (cc2 > bestC) { bestC = cc2; bestS = sh; }
        }
        shifts.push(Math.abs(bestS));
    }
    const flatShift = shifts.length ? Math.max(...shifts) / outH2 * 100 : -1; // 출력 높이 대비 % (-1 = 측정 불가)
    const stripShift = [];
    const NSTRIP = 5;
    for (let k = 0; k < NSTRIP; k++) {
        const a3 = Math.round(outW2 * (0.06 + 0.88 * k / NSTRIP)), b3 = Math.round(outW2 * (0.06 + 0.88 * (k + 1) / NSTRIP));
        const ps = prof(a3, b3);
        if (textRows(ps) < 4 || textRows(bandC) < 4) { stripShift.push(null); continue; }
        let bestS = 0, bestC = -1e18;
        for (let sh = -40; sh <= 40; sh++) {
            let cc2 = 0;
            for (let y = Math.max(0, -sh); y < Math.min(outH2, outH2 - sh); y++) cc2 += bandC[y] * ps[y + sh];
            if (cc2 > bestC) { bestC = cc2; bestS = sh; }
        }
        stripShift.push(bestS);
    }
    // 유효 띠의 (x, shift) 직선 피팅 → 글줄 기울기(도), 잔차 최대(px) = 곡선 잔류
    const xsS = [], ysS = [];
    stripShift.forEach((s3, k) => { if (s3 !== null) { xsS.push(outW2 * (0.06 + 0.88 * (k + 0.5) / NSTRIP)); ysS.push(s3); } });
    let lineTilt = -1, lineBow = -1;
    if (xsS.length >= 3) {
        const mx = xsS.reduce((a2,b2)=>a2+b2,0)/xsS.length, my = ysS.reduce((a2,b2)=>a2+b2,0)/ysS.length;
        let sxy = 0, sxx = 0;
        for (let i = 0; i < xsS.length; i++) { sxy += (xsS[i]-mx)*(ysS[i]-my); sxx += (xsS[i]-mx)*(xsS[i]-mx); }
        const slope = sxx ? sxy / sxx : 0;
        lineTilt = +(Math.atan(slope) * 180 / Math.PI).toFixed(2);
        lineBow = Math.max(...xsS.map((x3, i) => Math.abs(ysS[i] - (my + slope * (x3 - mx)))));
    }
    // 자기 검증(사용자 제안): 펴진 결과에서 글자 좌측 정렬선의 기울기(90도 이탈각)
    // 행별 "본문 시작 x"(어두운 픽셀 최초 등장)를 상/하 절반에서 중앙값으로 → 기울기
    const textStartX = (y0, y1) => {
        const xs = [];
        for (let y = y0; y < y1; y += 4) {
            for (let x = Math.round(outW2*0.04); x < outW2 * 0.5; x++) {
                if (gd[y * outW2 + x] < 110) { xs.push(x); break; }
            }
        }
        if (xs.length < 10) return null;
        xs.sort((a2, b2) => a2 - b2);
        return xs[xs.length >> 1];
    };
    const xTop = textStartX(Math.round(outH2*0.12), Math.round(outH2*0.45));
    const xBot = textStartX(Math.round(outH2*0.55), Math.round(outH2*0.88));
    let marginSlant = -1;
    if (xTop !== null && xBot !== null) {
        marginSlant = Math.abs(Math.atan2(xBot - xTop, outH2 * 0.43) * 180 / Math.PI);
    }
    srcF.delete(); dstF.delete(); gF.delete(); mX2.delete(); mY2.delete();

    return { curErr: curErr === null ? -1 : +curErr.toFixed(1), fitErr: +fitErr.toFixed(1), initErr: +initErr.toFixed(1), oracleErr: +oracleErr.toFixed(1),
             flatShift: +flatShift.toFixed(2), edgeErr, nLines: textInfo.lines.length, nStarts: textInfo.starts.length, rectInfo, aspectFix, lineTilt, lineBow, stripShift, marginSlant: marginSlant < 0 ? -1 : +marginSlant.toFixed(1),
             Pz: { z1:+P3.z1.toFixed(2), z2:+P3.z2.toFixed(2), z1b:+(P3.z1b??P3.z1).toFixed(2), z2b:+(P3.z2b??P3.z2).toFixed(2), rx:+P3.rx.toFixed(2), ry:+P3.ry.toFixed(2) } };
}"""

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
    import os
    cw = float(os.environ.get("CURV_W", "0"))
    gw = float(os.environ.get("GUIDE_W", "8")); sl = float(os.environ.get("SLACK", "0.015"))
    rw = float(os.environ.get("ROW_W", "0")); fl = os.environ.get("F_LIST", "")
    pg.evaluate(f"() => {{ window.PM_CURV_W = {cw}; window.PM_GUIDE_W = {gw}; window.PM_SLACK = {sl}; window.PM_ROW_W = {rw}; window.PM_TW_W = {os.environ.get("TW_W", "0")}; window.PM_ROW_W2 = {os.environ.get("ROW_W2", "0")}; window.PM_SOFT_W = {os.environ.get("SOFT_W", "1.0")}; window.PM_TEXT_FIRST = {os.environ.get("TEXT_FIRST", "0")}; window.PM_TL_W = {os.environ.get("TL_W", "0")}; window.PM_RECT = {os.environ.get("RECT", "0")}; window.PM_RECT_DEG = {os.environ.get("RECT_DEG", "2")}; window.PM_COLFIT = {os.environ.get("COLFIT", "1")}; window.PM_ROW_SLACK = {os.environ.get("ROW_SLACK", "0.006")}; window.PM_ROW_WPTS = {os.environ.get("ROW_WPTS", "20")}; if ('{fl}') window.PM_F_LIST = [{fl}]; }}")
    print(f"== 곡률 {cw} / 앵커 {gw} / 여유 {sl} / 글줄 {rw} / 비틀림페널티 {os.environ.get('TW_W', '0')} / 연경계 {os.environ.get('SOFT_W','1.0')} / 글자우선 {os.environ.get('TEXT_FIRST','0')} / 글줄곡선 {os.environ.get('TL_W','0')} / 직교화 {os.environ.get('RECT','0')} / 2단계글줄 {os.environ.get('ROW_W2', '0')} 여유{os.environ.get('ROW_SLACK','0.006')} 강도{os.environ.get('ROW_WPTS','20')} / F {fl or 0.75} ==")
    tot = {"cur": [], "fit": [], "orc": []}
    only = os.environ.get("ONLY", "")
    for name in GT.keys():
        if only and name != only: continue
        with open(rf"C:/python_work/test_photos/{name}", "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        r = pg.evaluate(JS, [b64, GT[name]])
        print(f"[{name}] 외곽={r['oracleErr']}px (상{r['edgeErr']['top']}/하{r['edgeErr']['bot']}/좌{r['edgeErr']['left']}/우{r['edgeErr']['right']}) 시프트={r['flatShift']}% 글줄기울기={r['lineTilt']}도 글줄휨={r['lineBow']}px 띠시프트={r['stripShift']} 비율보정={r['aspectFix']} 글줄검출={r['nLines']}/시작점{r['nStarts']} 직교화={r['rectInfo']}")
        if r["curErr"] >= 0: tot["cur"].append(r["curErr"])
        tot["fit"].append(r["fitErr"]); tot["orc"].append(r["oracleErr"]); tot.setdefault("ini", []).append(r["initErr"])
    if len(tot['orc']) == 0: pass
    else: print(f"평균: 기존={sum(tot['cur'])/len(tot['cur']):.1f}  피팅={sum(tot['fit'])/4:.1f}  init만={sum(tot['ini'])/4:.1f}  신뢰영역={sum(tot['orc'])/4:.1f} px")
    b.close()
server.shutdown()
