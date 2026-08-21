# 매직컬러 구/신 비교: 펴진 출력(원본 해상도)에 기존 전역 LUT vs 새 플랫필드 적용
import threading, functools, http.server, base64, sys, os
from playwright.sync_api import sync_playwright
ROOT = r"C:/python_work/01_completed/005_daddy_scanner"
PORT = int(os.environ.get("PORT", "9062"))
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()
JS = """async (b64) => {
  const im = new Image(); im.src = 'data:image/jpeg;base64,' + b64; await im.decode();
  const mk = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0); return c; };
  const a = mk(); { const ctx = a.getContext('2d'); const d = ctx.getImageData(0,0,a.width,a.height); magicLUTApply(d.data); ctx.putImageData(d,0,0); }
  const t0 = performance.now(); const b = mk(); applyMagic(b, 0.35); const ms = Math.round(performance.now() - t0);
  // 종이 균일도: 밝은 픽셀(상위 40%)의 표준편차 — 낮을수록 그림자 제거 잘됨
  const uni = (c) => { const g = c.getContext('2d').getImageData(0,0,c.width,c.height).data; const v = []; for (let i = 0; i < g.length; i += 64) v.push(0.299*g[i]+0.587*g[i+1]+0.114*g[i+2]); v.sort((p,q)=>p-q); const top = v.slice(Math.floor(v.length*0.6)); const m = top.reduce((p,q)=>p+q,0)/top.length; return Math.sqrt(top.reduce((p,q)=>p+(q-m)*(q-m),0)/top.length).toFixed(1); };
  return { ms, uniOld: uni(a), uniNew: uni(b), old: a.toDataURL('image/jpeg', 0.92), neu: b.toDataURL('image/jpeg', 0.92) };
}"""
with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(viewport={"width": 500, "height": 900}); pg.set_default_timeout(300000)
    pg.goto(f"http://127.0.0.1:{PORT}/index.html")
    for _ in range(60):
        if pg.evaluate("() => window.cv && !!window.cv.Mat && state.cvReady"): break
        pg.wait_for_timeout(1000)
    for name in sys.argv[1:]:
        b64 = base64.b64encode(open(f"C:/python_work/test_photos/{name}", "rb").read()).decode()
        r = pg.evaluate(JS, b64)
        print(f"{name}: {r['ms']}ms 종이균일도(표준편차) 구 {r['uniOld']} → 신 {r['uniNew']}")
        open(f"fx_old_{name}", "wb").write(base64.b64decode(r["old"].split(",",1)[1]))
        open(f"fx_new_{name}", "wb").write(base64.b64decode(r["neu"].split(",",1)[1]))
    br.close()
server.shutdown()
