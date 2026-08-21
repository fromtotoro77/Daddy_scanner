import threading, functools, http.server, base64, sys
from playwright.sync_api import sync_playwright
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"; PORT = 9101
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.set_default_timeout(300000)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    for name in sys.argv[1:]:
        b64 = base64.b64encode(open(f"C:/python_work/test_photos/{name}", "rb").read()).decode()
        r = pg.evaluate("""async (b64) => { const im = new Image(); im.src = 'data:image/jpeg;base64,' + b64; await im.decode();
            const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0);
            let ok, err = null; try { ok = removeFingers(c); } catch (e) { err = (typeof e === 'number' && cv.exceptionFromPtr) ? cv.exceptionFromPtr(e).msg : String(e); } return { ok, err, dbg: state.lastFingerDbg, hasInpaint: typeof cv.inpaint, hasInRange: typeof cv.inRange, out: c.toDataURL('image/jpeg', 0.92) }; }""", b64)
        print(name, "removed:", r["ok"], "err:", r["err"], "inpaint:", r["hasInpaint"], "inRange:", r["hasInRange"]); d = r["dbg"]
        open("fingerfix_" + name, "wb").write(base64.b64decode(r["out"].split(",",1)[1]))
        if d:
            print("  size", d["W"], d["H"], "paper", d["paper"])
            for cpt in d["comps"]: print("   comp", cpt)
    b.close()
server.shutdown()
