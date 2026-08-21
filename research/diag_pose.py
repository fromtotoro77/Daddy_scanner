import functools, http.server, threading, json, sys
from playwright.sync_api import sync_playwright
SCRATCH = r"C:/Users/ToTo/AppData/Local/Temp/claude/c--python-work/a92b09e6-f53b-4eb4-8c03-a5a796985259/scratchpad"
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
PORT = 8816
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
GT = json.load(open(SCRATCH + "/gt.json"))
JS = """(gt) => {
    const scale = Math.min(1, 1000 / Math.max(gt.w, gt.h));
    const W = Math.round(gt.w * scale), H = Math.round(gt.h * scale), S = scale;
    const sc = (p) => ({ x: +(p.x * S).toFixed(1), y: +(p.y * S).toFixed(1) });
    const gtC = { tl: sc(gt.corners.tl), tr: sc(gt.corners.tr), br: sc(gt.corners.br), bl: sc(gt.corners.bl) };
    const F = 1.15 * Math.max(W, H);
    const Q = pmPoseFromQuad(gtC, W, H, F);
    const proj = Q ? ['tl','tr','br','bl'].map((k, i) => { const [u,v] = [[0,0],[1,0],[1,1],[0,1]][i]; const p = pmProject(Q, u, v, W, H); return k + ':' + (p ? p.map(x=>x.toFixed(0)).join(',') : 'null'); }) : null;
    // 원시 호모그래피 검산
    const src = [[-0.5,-0.5],[0.5,-0.5],[0.5,0.5],[-0.5,0.5]];
    const dst = [gtC.tl, gtC.tr, gtC.br, gtC.bl].map(p => [(p.x - W/2)/F, (p.y - H/2)/F]);
    const h = pmHomography4(src, dst);
    const hp = src.map(([x,y]) => { const d = h[6]*x + h[7]*y + 1; return [((h[0]*x+h[1]*y+h[2])/d*F + W/2).toFixed(0), ((h[3]*x+h[4]*y+h[5])/d*F + H/2).toFixed(0)].join(','); });
    return { gtC, Q: Q && Object.fromEntries(Object.entries(Q).map(([k,v]) => [k, +v.toFixed(3)])), proj, homographyCheck: hp, h: h.map(v => +v.toFixed(4)) };
}"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.set_default_timeout(120000)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    pg.add_script_tag(path=SCRATCH + "/pagemodel.js")
    for name in sys.argv[1:]:
        r = pg.evaluate(JS, GT[name])
        print('==', name); 
        for k, v in r.items(): print(' ', k, json.dumps(v))
    b.close()
server.shutdown()
