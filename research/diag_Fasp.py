import functools, http.server, threading, json
from playwright.sync_api import sync_playwright
SCRATCH = r"C:/Users/ToTo/AppData/Local/Temp/claude/c--python-work/a92b09e6-f53b-4eb4-8c03-a5a796985259/scratchpad"
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
PORT = 8825
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
GT = json.load(open(SCRATCH + "/gt.json"))
JS = """(gt) => {
    const scale = Math.min(1, 1000 / Math.max(gt.w, gt.h));
    const W = Math.round(gt.w * scale), H = Math.round(gt.h * scale), S = scale;
    const sc = (p) => ({ x: p.x * S, y: p.y * S });
    const gtC = { tl: sc(gt.corners.tl), tr: sc(gt.corners.tr), br: sc(gt.corners.br), bl: sc(gt.corners.bl) };
    const bbox = (Math.max(gtC.tr.x, gtC.br.x) - Math.min(gtC.tl.x, gtC.bl.x)) / (Math.max(gtC.bl.y, gtC.br.y) - Math.min(gtC.tl.y, gtC.tr.y));
    const out = [];
    for (const fm of [0.6, 0.75, 0.9, 1.15, 1.5, 2.0]) {
        const Q = pmPoseFromQuad(gtC, W, H, fm * Math.max(W, H));
        if (!Q) { out.push(fm + ':null'); continue; }
        let sum = 0;
        for (const [k,u,v] of [['tl',0,0],['tr',1,0],['br',1,1],['bl',0,1]]) { const p = pmProject(Q,u,v,W,H); sum += p ? Math.hypot(p[0]-gtC[k].x, p[1]-gtC[k].y)/S : 999; }
        out.push(`F${fm}: 잔차${Math.round(sum/4)} ry${(Q.ry*57.3).toFixed(0)}° rx${(Q.rx*57.3).toFixed(0)}° 비율${(Q.pw/Q.ph).toFixed(2)}`);
    }
    return { bbox: +bbox.toFixed(3), out };
}"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.set_default_timeout(120000)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    pg.add_script_tag(path=SCRATCH + "/pagemodel.js")
    for name in GT:
        r = pg.evaluate(JS, GT[name])
        print(name[:12], 'bbox비율', r['bbox'], '|', ' | '.join(r['out']))
    b.close()
server.shutdown()
