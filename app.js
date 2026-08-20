/* ============================================================
   Daddy Scanner v1.0.0 — app.js
   촬영 → 자동/수동 보정 → 필터 → PDF 생성/공유 (전부 브라우저 안에서 처리)
   ============================================================ */
'use strict';

const OPENCV_URL = 'https://docs.opencv.org/4.7.0/opencv.js';
const CAPTURE_MAX_SIDE = 2500;   // 촬영 원본 보관 해상도(장변)
const THUMB_MAX_SIDE = 420;      // 갤러리 썸네일
const EDIT_MAX_SIDE = 1100;      // 편집 미리보기
const PDF_QUALITY = {
  high: { maxSide: 2400, jpeg: 0.92 },
  mid:  { maxSide: 2000, jpeg: 0.80 },
  low:  { maxSide: 1400, jpeg: 0.60 },
};

const $ = (id) => document.getElementById(id);

/* ---------- 상태 ---------- */
const state = {
  pages: [],          // {id, blob, corners, autoChecked, rotation, filter, bright, contrast, thumbUrl, thumbDirty}
  screen: 'capture',
  selectMode: false,
  selected: new Set(),
  editIdx: -1,
  cvReady: false,
  scanner: null,
  stream: null,
  pdfQuality: 'mid',
  spreadMode: localStorage.getItem('spreadMode') === '1', // 펼침면 좌/우 분할
};

/* ============================================================
   유틸: 토스트 / 시계
   ============================================================ */
function toast(msg, opts = {}) {
  const { type = '', actionText, onAction, duration = 2600 } = opts;
  const el = document.createElement('div');
  el.className = `toast ${type}${actionText ? ' has-action' : ''}`;
  el.innerHTML = `<span>${msg}</span>`;
  if (actionText) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = actionText;
    btn.onclick = () => { onAction && onAction(); dismiss(); };
    el.appendChild(btn);
  }
  $('toast-container').appendChild(el);
  let done = false;
  const dismiss = () => {
    if (done) return; done = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  };
  setTimeout(dismiss, duration);
  return dismiss;
}

/* ============================================================
   IndexedDB — 작업 유실 방지 (브라우저 닫아도 복원)
   ============================================================ */
const idb = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('daddy-scanner', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('pages', { keyPath: 'id' });
      rq.onsuccess = () => { this.db = rq.result; res(); };
      rq.onerror = () => rej(rq.error);
    });
  },
  tx(mode) { return this.db.transaction('pages', mode).objectStore('pages'); },
  put(page, order) {
    if (!this.db) return;
    const { id, blob, corners, curves, autoChecked, rotation, filter, bright, contrast } = page;
    this.tx('readwrite').put({ id, blob, corners, curves: curves || null, autoChecked, rotation, filter, bright, contrast, order });
  },
  delete(id) { if (this.db) this.tx('readwrite').delete(id); },
  clear() { if (this.db) this.tx('readwrite').clear(); },
  getAll() {
    return new Promise((res) => {
      if (!this.db) return res([]);
      const rq = this.tx('readonly').getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });
  },
};

function persistPage(page) {
  const i = state.pages.indexOf(page);
  if (i < 0) return; // 분할용 임시 페이지 등 목록 밖 객체는 저장하지 않음
  idb.put(page, i);
}
function persistOrder() { state.pages.forEach((p, i) => idb.put(p, i)); }

/* ============================================================
   OpenCV 로더 — UI를 막지 않게 백그라운드 로드
   ============================================================ */
function loadOpenCV() {
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = OPENCV_URL;
    s.async = true;
    s.onload = () => {
      const c = window.cv;
      if (c && typeof c.then === 'function') c.then((m) => { window.cv = m; resolve(true); });
      else if (c && c.Mat) resolve(true);
      else if (c) c.onRuntimeInitialized = () => resolve(true);
      else resolve(false);
    };
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function initCV() {
  const ok = await loadOpenCV();
  const badge = $('cv-status');
  if (!ok) {
    badge.querySelector('span').textContent = '자동보정 사용불가 (오프라인?)';
    return;
  }
  state.cvReady = true;
  state.scanner = new jscanify();
  badge.classList.add('ready');
  badge.querySelector('span').textContent = '자동보정 준비완료';
  setTimeout(() => badge.classList.add('fade'), 2200);
  // 엔진 로딩 전에 촬영/불러온 페이지 소급 자동 감지
  for (const p of state.pages) {
    if (!p.autoChecked) await detectCorners(p);
  }
  if (state.screen === 'gallery') renderGallery();
}

/* ============================================================
   문서 테두리 자동 감지 (요구 6 — 자동)
   다단계 자체 감지: Canny 강/약 + Otsu 폴백 → 볼록 사각형 근사
   ============================================================ */
function orderQuad(pts) {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.x - a.y) - (b.x - b.y));
  return { tl: bySum[0], br: bySum[3], bl: byDiff[0], tr: byDiff[3] };
}

/* 이진 맵에서 가장 큰 볼록 사각형을 찾는다 (원시 윤곽선도 함께 반환 — 곡면 추출용)
   maxRatio: 화면 거의 전체를 덮는 프레임 오감지 방지
   center: 지정 시 그 점을 포함하는 윤곽만 인정 — 사용자가 겨눈 중앙 우선(모니터·키보드 오감지 방지) */
function scanQuads(binMat, imgArea, minRatio, maxRatio = 0.985, center = null) {
  let best = null, bestArea = 0, bestContour = null;
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(binMat, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < imgArea * minRatio || area > imgArea * maxRatio || area <= bestArea) { cnt.delete(); continue; }
    if (center && cv.pointPolygonTest(cnt, center, false) < 0) { cnt.delete(); continue; }
    // 곡면 페이지도 4점으로 잡히도록 근사 강도를 올려가며 시도
    const peri = cv.arcLength(cnt, true);
    let quad = null;
    for (const k of [0.02, 0.035, 0.05, 0.08]) {
      const approx = new cv.Mat();
      if (quad === null) {
        cv.approxPolyDP(cnt, approx, k * peri, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const pts = [];
          for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          quad = orderQuad(pts);
        }
      }
      approx.delete();
    }
    if (quad) {
      best = quad;
      bestArea = area;
      bestContour = [];
      const d = cnt.data32S;
      for (let j = 0; j < d.length; j += 2) bestContour.push({ x: d[j], y: d[j + 1] });
    }
    cnt.delete();
  }
  contours.delete();
  hier.delete();
  return best ? { quad: best, contour: bestContour } : null;
}

/* "종이다움" 마스크: 화면 중앙(사용자가 겨눈 지점) 색을 기준으로
   저채도+충분히 밝은 픽셀만 남긴다 — 포스트잇·나무책상·컬러 물체 자동 배제 */
function paperMask(srcRgba) {
  const rgb = new cv.Mat();
  cv.cvtColor(srcRgba, rgb, cv.COLOR_RGBA2RGB);
  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  rgb.delete();
  const W = hsv.cols, H = hsv.rows;
  const patch = hsv.roi(new cv.Rect((W * 0.44) | 0, (H * 0.44) | 0, Math.max(2, (W * 0.12) | 0), Math.max(2, (H * 0.12) | 0)));
  const m = cv.mean(patch); // [h, s, v]
  patch.delete();
  const sRef = m[1], vRef = m[2];
  if (sRef > 120 || vRef < 70) { hsv.delete(); return null; } // 중앙이 종이로 안 보임 → 이 방법 포기
  const vLow = Math.max(50, vRef * 0.62);
  const sHigh = Math.min(200, Math.max(80, sRef + 55));
  const low = new cv.Mat(H, W, hsv.type(), new cv.Scalar(0, 0, vLow, 0));
  const high = new cv.Mat(H, W, hsv.type(), new cv.Scalar(180, sHigh, 255, 0));
  const mask = new cv.Mat();
  cv.inRange(hsv, low, high, mask);
  hsv.delete(); low.delete(); high.delete();
  return mask;
}

/* 어두운 가는 선(책 가장자리 그림자·표 선·글자)을 마스크에서 제거 — 흰 책 위 흰 책 분리용 차단벽 */
function subtractDarkLines(blurGray, mask) {
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11));
  const bh = new cv.Mat();
  cv.morphologyEx(blurGray, bh, cv.MORPH_BLACKHAT, k);
  const bar = new cv.Mat();
  cv.threshold(bh, bar, 16, 255, cv.THRESH_BINARY);
  cv.subtract(mask, bar, mask);
  k.delete(); bh.delete(); bar.delete();
}

/* 중앙(사용자가 겨눈 지점)이 속한 연결 성분만 골라 사각형 추출
   — 흰 책이 겹쳐 있어도 그림자 차단벽으로 갈라진 뒤 "겨눈 책"만 선택된다 */
function centerComponentQuad(bin, imgArea, minRatio) {
  const H = bin.rows, W = bin.cols;
  let seed = null;
  for (let r = 0; r < 48 && !seed; r += 4) {
    for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const x = (W >> 1) + dx, y = (H >> 1) + dy;
      if (x >= 0 && y >= 0 && x < W && y < H && bin.ucharPtr(y, x)[0] > 0) { seed = [x, y]; break; }
    }
  }
  if (!seed) return null;
  const ffMask = cv.Mat.zeros(H + 2, W + 2, cv.CV_8U);
  try {
    cv.floodFill(bin, ffMask, new cv.Point(seed[0], seed[1]), new cv.Scalar(255),
      new cv.Rect(), new cv.Scalar(0), new cv.Scalar(0), 4 | (255 << 8) | cv.FLOODFILL_MASK_ONLY);
  } catch (e) {
    ffMask.delete();
    return null;
  }
  const roi = ffMask.roi(new cv.Rect(1, 1, W, H));
  const comp = roi.clone();
  roi.delete(); ffMask.delete();
  const best = scanQuads(comp, imgArea, minRatio, 0.97, null);
  comp.delete();
  return best;
}

/* 캔버스에서 문서 사각형 감지 → {tl,tr,br,bl} (캔버스 좌표) 또는 null
   전략(각 베이스 마스크마다):
   ① 그림자 차단벽 절단 + 중앙 성분 선택 — 겹친 흰 책·잡동사니에 가장 강함
   ② 가로띠 메꿈(스프링 제본) + 중앙 포함 최대 사각형
   베이스: 종이색 마스크 → 밝기 이진화, 이후 엣지 폴백 */
function findDocQuad(canvas, minRatio = 0.15) {
  const src = cv.imread(canvas);
  const imgArea = src.cols * src.rows;
  const center = new cv.Point(src.cols / 2, src.rows / 2);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  const bin = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  let best = null;
  const pt = new cv.Point(-1, -1);
  const tryBase = (base) => {
    if (!best) {
      const a = base.clone();
      subtractDarkLines(blur, a);
      cv.morphologyEx(a, a, cv.MORPH_CLOSE, kernel, pt, 1);
      cv.erode(a, a, kernel, pt, 1);
      best = centerComponentQuad(a, imgArea, minRatio);
      a.delete();
    }
    if (!best) {
      const b2 = base.clone();
      healHorizontalBands(b2);
      cv.morphologyEx(b2, b2, cv.MORPH_CLOSE, kernel, pt, 2);
      cv.erode(b2, b2, kernel, pt, 1);
      best = scanQuads(b2, imgArea, minRatio, 0.97, center);
      b2.delete();
    }
  };
  try {
    const pm = paperMask(src);
    if (pm) { tryBase(pm); pm.delete(); }
    if (!best) {
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      tryBase(bin);
    }
    // 엣지 폴백 (종이와 배경 밝기가 비슷할 때)
    if (!best) {
      cv.Canny(blur, bin, 60, 180);
      cv.dilate(bin, bin, kernel, pt, 2);
      best = scanQuads(bin, imgArea, minRatio, 0.985, center);
    }
    if (!best) {
      cv.Canny(blur, bin, 20, 70);
      cv.dilate(bin, bin, kernel, pt, 2);
      best = scanQuads(bin, imgArea, minRatio, 0.985, center);
    }
  } catch (e) {
    console.warn('findDocQuad 실패', e);
  }
  src.delete(); gray.delete(); blur.delete(); bin.delete(); kernel.delete();
  return best;
}

/* ============================================================
   곡면 평탄화 — 곡선 경계 메시 워프
   상·하 테두리를 곡선(폴리라인)으로 추출해 격자 리맵으로 편다
   ============================================================ */
const CURVE_SAMPLES = 17; // 곡선 샘플 점 개수

function segDist(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const len2 = vx * vx + vy * vy || 1;
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/* 윤곽선에서 A→B 변에 속한 점들로 곡선을 피팅 (구간별 중앙값 + 평활, 끝점은 모서리 고정) */
function fitEdgeCurve(contour, A, B, quad) {
  const ex = B.x - A.x, ey = B.y - A.y;
  const L = Math.hypot(ex, ey);
  if (L < 10) return null;
  const ux = ex / L, uy = ey / L;
  const nx = -uy, ny = ux; // 법선
  const edges = [[quad.tl, quad.tr], [quad.tr, quad.br], [quad.br, quad.bl], [quad.bl, quad.tl]];

  const K = CURVE_SAMPLES - 1;
  const bins = Array.from({ length: K + 1 }, () => []);
  for (const p of contour) {
    // 이 변에 가장 가까운 점만 채택 (모서리 부근 타 변 점 오염 방지)
    const dHere = segDist(p, A, B);
    let nearest = true;
    for (const [a, b] of edges) {
      if ((a === A && b === B) || (a === B && b === A)) continue;
      if (segDist(p, a, b) < dHere) { nearest = false; break; }
    }
    if (!nearest) continue;
    const t = ((p.x - A.x) * ux + (p.y - A.y) * uy) / L;
    if (t < -0.02 || t > 1.02) continue;
    const d = (p.x - A.x) * nx + (p.y - A.y) * ny; // 부호 있는 수직 편차
    const bi = Math.max(0, Math.min(K, Math.round(t * K)));
    bins[bi].push(d);
  }

  const dev = new Array(K + 1).fill(null);
  let filled = 0;
  for (let i = 0; i <= K; i++) {
    if (bins[i].length) {
      bins[i].sort((a, b) => a - b);
      dev[i] = bins[i][bins[i].length >> 1]; // 중앙값 (이상치 강건)
      filled++;
    }
  }
  if (filled < 6) return null;
  dev[0] = 0; dev[K] = 0; // 끝점은 모서리에 고정
  // 빈 구간 선형 보간
  for (let i = 1; i < K; i++) {
    if (dev[i] !== null) continue;
    let j = i + 1;
    while (dev[j] === null) j++;
    const prev = dev[i - 1];
    for (let k = i; k < j; k++) dev[k] = prev + ((dev[j] - prev) * (k - i + 1)) / (j - i + 1);
  }
  // 3점 이동평균 평활
  const sm = dev.slice();
  for (let i = 1; i < K; i++) sm[i] = (dev[i - 1] + dev[i] + dev[i + 1]) / 3;

  // 휨이 미미하면 직선 취급 (불필요한 리맵 방지)
  const maxDev = Math.max(...sm.map(Math.abs));
  if (maxDev < Math.max(2.5, L * 0.012)) return null;

  return sm.map((d, i) => {
    const t = i / K;
    return { x: A.x + t * ex + d * nx, y: A.y + t * ey + d * ny };
  });
}

function sampleLine(A, B, n) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
  });
}

/* 윤곽선 + 사각형 → 상·하 곡선 (휨이 없으면 null) */
function extractCurves(contour, quad) {
  if (!contour || contour.length < 12) return null;
  const top = fitEdgeCurve(contour, quad.tl, quad.tr, quad);
  const bottom = fitEdgeCurve(contour, quad.bl, quad.br, quad);
  if (!top && !bottom) return null;
  return {
    top: top || sampleLine(quad.tl, quad.tr, CURVE_SAMPLES),
    bottom: bottom || sampleLine(quad.bl, quad.br, CURVE_SAMPLES),
  };
}

function polylineLen(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

/* 폴리라인을 호길이 기준 n개 점으로 리샘플 */
function resamplePolyline(pts, n) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1] || 1;
  const out = new Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    while (seg < pts.length - 2 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / span;
    out[i] = {
      x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t,
      y: pts[seg].y + (pts[seg + 1].y - pts[seg].y) * t,
    };
  }
  return out;
}

/* 곡선 경계 메시 리맵 — 촬영 순간 곡면까지 평탄화 */
function warpCurved(canvas, quad, curves) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const W = Math.max(24, Math.min(canvas.width * 2, Math.round(Math.max(polylineLen(curves.top), polylineLen(curves.bottom)))));
  const H = Math.max(24, Math.min(canvas.height * 2, Math.round(Math.max(dist(quad.tl, quad.bl), dist(quad.tr, quad.br)))));
  const top = resamplePolyline(curves.top, W);
  const bot = resamplePolyline(curves.bottom, W);
  const mapX = new cv.Mat(H, W, cv.CV_32FC1);
  const mapY = new cv.Mat(H, W, cv.CV_32FC1);
  const mx = mapX.data32F, my = mapY.data32F;
  for (let y = 0; y < H; y++) {
    const s = y / (H - 1);
    const row = y * W;
    for (let x = 0; x < W; x++) {
      mx[row + x] = top[x].x + s * (bot[x].x - top[x].x);
      my[row + x] = top[x].y + s * (bot[x].y - top[x].y);
    }
  }
  const src = cv.imread(canvas);
  const dst = new cv.Mat();
  cv.remap(src, dst, mapX, mapY, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  const out = document.createElement('canvas');
  cv.imshow(out, dst);
  src.delete(); dst.delete(); mapX.delete(); mapY.delete();
  return out;
}

async function detectCorners(page) {
  page.autoChecked = true;
  if (!state.cvReady) return;
  try {
    const bmp = await createImageBitmap(page.blob);
    const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();

    const found = findDocQuad(c, 0.15);
    let corners = found ? found.quad : null;
    let curves = found ? extractCurves(found.contour, found.quad) : null;

    // 최후 폴백: jscanify 기본 감지 (곡선 없음)
    if (!corners) {
      const img = cv.imread(c);
      const contour = state.scanner.findPaperContour(img);
      if (contour) {
        const cp = state.scanner.getCornerPoints(contour);
        if (cp && cp.topLeftCorner && cp.topRightCorner && cp.bottomLeftCorner && cp.bottomRightCorner) {
          const q = {
            tl: cp.topLeftCorner, tr: cp.topRightCorner,
            br: cp.bottomRightCorner, bl: cp.bottomLeftCorner,
          };
          if (quadArea(q) >= c.width * c.height * 0.15) corners = q;
        }
        contour.delete();
      }
      img.delete();
    }

    if (corners) {
      const up = (p) => ({ x: p.x / scale, y: p.y / scale }); // 감지 좌표 → 원본 좌표
      page.corners = { tl: up(corners.tl), tr: up(corners.tr), br: up(corners.br), bl: up(corners.bl) };
      page.curves = curves ? { top: curves.top.map(up), bottom: curves.bottom.map(up) } : null;
      page.thumbDirty = true;
    }
    persistPage(page);
  } catch (e) {
    console.warn('detectCorners 실패', e);
  }
}

function quadArea(c) {
  const pts = [c.tl, c.tr, c.br, c.bl];
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = pts[i], q = pts[(i + 1) % 4];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/* ============================================================
   이미지 처리 파이프라인: 원본 → 원근보정 → 회전 → 필터 → 밝기/대비
   ============================================================ */
let procChain = Promise.resolve();
function enqueue(job) {
  const p = procChain.then(job, job);
  procChain = p.catch(() => {});
  return p;
}

async function processPage(page, maxSide) {
  return enqueue(async () => {
    const bmp = await createImageBitmap(page.blob);
    // 원근보정 비용을 제한하기 위해 처리 전 다운스케일
    const preScale = Math.min(1, (maxSide * 1.15) / Math.max(bmp.width, bmp.height));
    let src = document.createElement('canvas');
    src.width = Math.max(1, Math.round(bmp.width * preScale));
    src.height = Math.max(1, Math.round(bmp.height * preScale));
    src.getContext('2d').drawImage(bmp, 0, 0, src.width, src.height);
    bmp.close();

    // 1) 원근 보정 (+ 곡면 평탄화)
    if (page.corners && state.cvReady) {
      const dn = (p) => ({ x: p.x * preScale, y: p.y * preScale }); // 원본 좌표 → 다운스케일 좌표
      const sc = { tl: dn(page.corners.tl), tr: dn(page.corners.tr), br: dn(page.corners.br), bl: dn(page.corners.bl) };
      try {
        if (page.curves) {
          const cs = { top: page.curves.top.map(dn), bottom: page.curves.bottom.map(dn) };
          src = warpCurved(src, sc, cs); // 곡선 경계 메시 워프 — 책 곡면까지 폄
        } else {
          src = warpPerspective(src, sc);
        }
      } catch (e) {
        console.warn('warp 실패', e);
        try { src = warpPerspective(src, sc); } catch (e2) { /* 원본 유지 */ }
      }
    }

    // 2) 최종 크기 맞춤
    const fit = Math.min(1, maxSide / Math.max(src.width, src.height));
    if (fit < 1) {
      const c = document.createElement('canvas');
      c.width = Math.round(src.width * fit);
      c.height = Math.round(src.height * fit);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      src = c;
    }

    // 3) 회전
    if (page.rotation % 360 !== 0) src = rotateCanvas(src, page.rotation);

    // 4) 필터 + 밝기/대비
    applyFilter(src, page.filter, page.bright, page.contrast);
    return src;
  });
}

function warpPerspective(canvas, c) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const W = Math.max(24, Math.round(Math.max(dist(c.tl, c.tr), dist(c.bl, c.br))));
  const H = Math.max(24, Math.round(Math.max(dist(c.tl, c.bl), dist(c.tr, c.br))));
  const src = cv.imread(canvas);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [c.tl.x, c.tl.y, c.tr.x, c.tr.y, c.br.x, c.br.y, c.bl.x, c.bl.y]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  const out = document.createElement('canvas');
  cv.imshow(out, dst);
  src.delete(); dst.delete(); M.delete(); srcTri.delete(); dstTri.delete();
  return out;
}

function rotateCanvas(canvas, deg) {
  const rad = (deg * Math.PI) / 180;
  const swap = deg % 180 !== 0;
  const out = document.createElement('canvas');
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/* ---------- 필터 (요구 7 — 문자 가독성 중심) ---------- */
function applyFilter(canvas, filter, bright = 0, contrast = 0) {
  if (filter === 'bw' && state.cvReady) { applyBWAdaptive(canvas); applyBC(canvas, bright, contrast); return; }
  if (filter === 'sharpen' && state.cvReady) { applyMagic(canvas); applySharpenCV(canvas); applyBC(canvas, bright, contrast); return; }

  const ctx = canvas.getContext('2d');
  const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = im.data;

  if (filter === 'magic' || filter === 'sharpen') magicLUTApply(d);
  else if (filter === 'gray') {
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else if (filter === 'bw') {
    // OpenCV 없을 때 폴백: 그레이 + Otsu 전역 이진화
    const gray = new Uint8Array(d.length / 4);
    for (let i = 0, g = 0; i < d.length; i += 4, g++) {
      gray[g] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }
    const t = otsu(gray);
    for (let i = 0, g = 0; i < d.length; i += 4, g++) {
      const v = gray[g] > t ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  // 'original'은 무보정

  bcInPlace(d, bright, contrast);
  ctx.putImageData(im, 0, 0);
}

/* 매직컬러: 종이 흰색 기준 화이트밸런스 + 전 채널 공통 대비 곡선
   (채널별 독립 스트레칭은 색조가 왜곡되므로 사용하지 않음) */
function magicLUTApply(d) {
  const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < d.length; i += 16) { histR[d[i]]++; histG[d[i + 1]]++; histB[d[i + 2]]++; n++; }

  // 1) 종이(배경) 색 추정: 채널별 상위 97퍼센타일 → 종이가 순백이 되는 게인
  const gain = (hist) => Math.min(1.7, Math.max(0.9, 245 / Math.max(90, percentile(hist, n, 0.97))));
  const gR = gain(histR), gG = gain(histG), gB = gain(histB);

  // 2) 화이트밸런스 적용 후 밝기 분포에서 섀도 컷 지점(하위 2.5%) 계산
  const histL = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 16) {
    const l = Math.min(255, 0.299 * d[i] * gR + 0.587 * d[i + 1] * gG + 0.114 * d[i + 2] * gB) | 0;
    histL[l]++;
  }
  const lo = Math.min(120, percentile(histL, n, 0.025));

  // 3) 모든 채널에 같은 곡선 적용 → 색조 유지, 종이만 하얗게·글자는 진하게
  const range = Math.max(24, 246 - lo);
  const curve = (v) => {
    let x = (v - lo) / range;
    x = Math.max(0, Math.min(1, x));
    return Math.pow(x, 0.95) * 255;
  };
  const lutR = new Uint8ClampedArray(256), lutG = new Uint8ClampedArray(256), lutB = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lutR[v] = curve(Math.min(255, v * gR));
    lutG[v] = curve(Math.min(255, v * gG));
    lutB[v] = curve(Math.min(255, v * gB));
  }
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lutR[d[i]]; d[i + 1] = lutG[d[i + 1]]; d[i + 2] = lutB[d[i + 2]];
  }
}

function percentile(hist, total, p) {
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = v; }
  }
  return threshold;
}

/* 흑백문서: 적응형 이진화 — 조명이 고르지 않아도 글자 선명 */
function applyBWAdaptive(canvas) {
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const dst = new cv.Mat();
  cv.adaptiveThreshold(gray, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, 12);
  cv.imshow(canvas, dst);
  src.delete(); gray.delete(); dst.delete();
}

/* 선명하게: 언샤프 커널 */
function applySharpenCV(canvas) {
  const src = cv.imread(canvas);
  const dst = new cv.Mat();
  const k = cv.matFromArray(3, 3, cv.CV_32FC1, [0, -0.55, 0, -0.55, 3.2, -0.55, 0, -0.55, 0]);
  cv.filter2D(src, dst, cv.CV_8U, k);
  cv.imshow(canvas, dst);
  src.delete(); dst.delete(); k.delete();
}

function applyBC(canvas, bright, contrast) {
  if (!bright && !contrast) return;
  const ctx = canvas.getContext('2d');
  const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
  bcInPlace(im.data, bright, contrast);
  ctx.putImageData(im, 0, 0);
}

function bcInPlace(d, bright, contrast) {
  if (!bright && !contrast) return;
  const c = 1 + contrast / 100;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = (v - 128) * c + 128 + bright;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
  }
}

/* ============================================================
   카메라 (요구 1 — 한 장/여러 장 연속 촬영)
   ============================================================ */
/* 화면 방향에 맞는 카메라 치수 요청.
   (정사각 2560×2560 이상값을 주면 가로형 모드가 "가장 가깝다"고 선택되어
   세로 화면에서 가로 프레임이 오는 첫 실행 짤림이 발생 — 방향을 명시해서 방지) */
function camConstraints() {
  const portrait = window.innerHeight >= window.innerWidth;
  return {
    facingMode: { ideal: 'environment' },
    width: { ideal: portrait ? 1440 : 2560 },
    height: { ideal: portrait ? 2560 : 1440 },
    aspectRatio: { ideal: portrait ? 3 / 4 : 4 / 3 },
  };
}

async function startCamera(isRetry = false) {
  if (state.stream) return;
  const msg = $('cam-msg');
  msg.classList.remove('hidden');
  msg.querySelector('p').textContent = '카메라 준비 중…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: camConstraints(), audio: false });
    state.stream = stream;
    const video = $('cam');
    video.srcObject = stream;
    await video.play().catch(() => {});

    // 저해상도/방향 불일치 스트림이면 방향 명시 치수로 재협상 → 안 되면 1회 재시작
    const track = stream.getVideoTracks()[0];
    if (track) {
      await new Promise((r) => setTimeout(r, 250)); // 설정 안정화 대기
      const bad = () => {
        const st = track.getSettings();
        const lowRes = (st.width || 0) * (st.height || 0) < 1200 * 900;
        const winLandscape = window.innerWidth > window.innerHeight;
        const vidLandscape = (st.width || 0) > (st.height || 0);
        return lowRes || vidLandscape !== winLandscape;
      };
      if (bad()) {
        try {
          await track.applyConstraints(camConstraints());
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) { /* 재협상 미지원 기기 */ }
        if (bad() && !isRetry) {
          stopCamera();
          await new Promise((r) => setTimeout(r, 150));
          return startCamera(true);
        }
      }
    }

    msg.classList.add('hidden');
    $('btn-shutter').disabled = false;
  } catch (e) {
    console.warn('camera error', e);
    $('btn-shutter').disabled = true;
    msg.querySelector('.loading-spinner')?.remove();
    msg.querySelector('p').innerHTML =
      '카메라를 사용할 수 없습니다.<br>권한을 허용했는지 확인하거나<br>아래 <b>불러오기</b>로 사진을 가져오세요.';
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    $('cam').srcObject = null;
  }
}

/* 실시간 문서 감지 오버레이 — 시간 평활(EMA)로 떨림 억제 + 안정 상태 표시 */
const liveDetect = { quad: null, hitStreak: 0, missStreak: 0 };

function startLiveOverlay() {
  const overlay = $('cam-overlay');
  const video = $('cam');
  const hint = $('detect-hint');
  const work = document.createElement('canvas');
  setInterval(() => {
    if (!state.cvReady || !state.stream || state.screen !== 'capture' || !video.videoWidth) return;
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      const s = 360 / Math.max(vw, vh);
      work.width = Math.round(vw * s); work.height = Math.round(vh * s);
      work.getContext('2d').drawImage(video, 0, 0, work.width, work.height);

      // 펼침면 모드: 좌/우 페이지를 각각 표시 + 가운데 책등 경계를 빨간 선으로
      if (state.spreadMode) {
        const blobs = findPageBlobs(work);
        const cw = overlay.clientWidth, ch = overlay.clientHeight;
        overlay.width = cw; overlay.height = ch;
        const octx = overlay.getContext('2d');
        octx.clearRect(0, 0, cw, ch);
        const fit = Math.min(cw / vw, ch / vh);
        const ox = (cw - vw * fit) / 2, oy = (ch - vh * fit) / 2;
        const map = (p) => [(p.x / s) * fit + ox, (p.y / s) * fit + oy];
        const two = blobs.length === 2;
        const color = two ? 'rgba(74, 222, 128, 0.95)' : 'rgba(74, 222, 128, 0.45)';
        for (const b of blobs) {
          const pts = ['tl', 'tr', 'br', 'bl'].map((k) => map(b.quad[k]));
          octx.beginPath();
          octx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < 4; i++) octx.lineTo(pts[i][0], pts[i][1]);
          octx.closePath();
          octx.fillStyle = two ? 'rgba(74, 222, 128, 0.08)' : 'rgba(74, 222, 128, 0.04)';
          octx.strokeStyle = color;
          octx.lineWidth = 2.5;
          octx.fill();
          octx.stroke();
        }
        // 고정 중앙 분할선(빨간 점선) — 사용자가 책등을 이 선에 맞추고 촬영
        const lineX = ox + (vw * fit) / 2;
        octx.beginPath();
        octx.moveTo(lineX, oy);
        octx.lineTo(lineX, oy + vh * fit);
        octx.strokeStyle = 'rgba(244, 63, 94, 0.95)';
        octx.lineWidth = 3;
        octx.setLineDash([12, 8]);
        octx.stroke();
        octx.setLineDash([]);
        if (hint) {
          if (two) {
            hint.textContent = '펼침면 인식됨 — 촬영하면 2페이지로 분할';
            hint.className = 'detect-hint ok';
          } else {
            hint.textContent = '책등을 빨간 선에 맞추고 촬영하세요';
            hint.className = 'detect-hint';
          }
        }
        return;
      }

      const foundRes = findDocQuad(work, 0.15);
      const found = foundRes ? foundRes.quad : null;
      liveDetect.curves = foundRes ? extractCurves(foundRes.contour, foundRes.quad) : null;
      if (found) {
        liveDetect.hitStreak++;
        liveDetect.missStreak = 0;
        // EMA 평활: 이전 위치와 60:40 혼합 → 안내선 떨림 억제
        if (liveDetect.quad) {
          const a = 0.4;
          for (const k of ['tl', 'tr', 'br', 'bl']) {
            liveDetect.quad[k].x += (found[k].x - liveDetect.quad[k].x) * a;
            liveDetect.quad[k].y += (found[k].y - liveDetect.quad[k].y) * a;
          }
        } else {
          liveDetect.quad = found;
        }
      } else {
        liveDetect.hitStreak = 0;
        liveDetect.missStreak++;
        if (liveDetect.missStreak >= 3) liveDetect.quad = null; // 잠깐 놓친 건 유지
      }

      const cw = overlay.clientWidth, ch = overlay.clientHeight;
      overlay.width = cw; overlay.height = ch;
      const octx = overlay.getContext('2d');
      octx.clearRect(0, 0, cw, ch);

      const stable = liveDetect.quad && liveDetect.hitStreak >= 2;
      if (liveDetect.quad) {
        // object-fit: contain 좌표 변환 (미리보기 = 전체 프레임)
        const fit = Math.min(cw / vw, ch / vh);
        const ox = (cw - vw * fit) / 2, oy = (ch - vh * fit) / 2;
        const map = (p) => [(p.x / s) * fit + ox, (p.y / s) * fit + oy];
        const pts = ['tl', 'tr', 'br', 'bl'].map((k) => map(liveDetect.quad[k]));
        const color = stable ? 'rgba(74, 222, 128, 0.95)' : 'rgba(74, 222, 128, 0.45)';
        octx.beginPath();
        octx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < 4; i++) octx.lineTo(pts[i][0], pts[i][1]);
        octx.closePath();
        octx.fillStyle = stable ? 'rgba(74, 222, 128, 0.10)' : 'rgba(74, 222, 128, 0.04)';
        octx.strokeStyle = color;
        octx.lineWidth = 2.5;
        octx.fill();
        octx.stroke();
        // 모서리 점
        octx.fillStyle = color;
        for (const [x, y] of pts) {
          octx.beginPath();
          octx.arc(x, y, 5, 0, Math.PI * 2);
          octx.fill();
        }
        // 곡면이 감지되면 상·하 곡선 표시 (평탄화가 적용될 실제 경계)
        if (liveDetect.curves && stable) {
          octx.strokeStyle = 'rgba(244, 63, 94, 0.85)';
          octx.lineWidth = 2;
          for (const key of ['top', 'bottom']) {
            const cps = liveDetect.curves[key].map(map);
            octx.beginPath();
            octx.moveTo(cps[0][0], cps[0][1]);
            for (let i = 1; i < cps.length; i++) octx.lineTo(cps[i][0], cps[i][1]);
            octx.stroke();
          }
        }
      }
      if (hint) {
        if (stable) {
          hint.textContent = '문서 인식됨 — 촬영하세요';
          hint.className = 'detect-hint ok';
        } else {
          hint.textContent = '문서를 화면에 맞춰 주세요';
          hint.className = 'detect-hint';
        }
      }
    } catch (e) { /* 프레임 스킵 */ }
  }, 350);
}

/* 촬영 */
async function capture() {
  const video = $('cam');
  if (!video.videoWidth) return;
  // 플래시 효과
  const wrap = document.querySelector('.cam-wrap');
  let flash = $('flash-layer');
  if (!flash) {
    flash = document.createElement('div');
    flash.id = 'flash-layer';
    wrap.appendChild(flash);
  }
  flash.classList.remove('flash');
  void flash.offsetWidth;
  flash.classList.add('flash');

  const c = document.createElement('canvas');
  const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
  await addCapturedBlob(blob, false);
}

/* 촬영/불러오기 공통 진입점 — 펼침면 모드면 좌/우 분할 시도 */
async function addCapturedBlob(blob, silent) {
  if (state.spreadMode) {
    if (!state.cvReady) {
      if (!silent) toast('보정 엔진 로딩 후 분할 가능 — 한 장으로 저장됨', { type: 'error' });
    } else if (await addSpreadPages(blob, silent)) {
      return;
    } else if (!silent) {
      toast('페이지 감지 실패 — 한 장으로 저장됨', { type: 'error' });
    }
  }
  await addPage(blob, silent);
}

/* 세로 커널 닫기: 어두운 "가로 띠"(스프링 제본·자·그림자)로 갈라진 밝은 영역을 위아래로 이어붙임.
   세로 방향으로만 메꾸므로 펼침면의 세로 책등(좌/우 분리)은 유지된다 */
function healHorizontalBands(bin) {
  const h = Math.max(15, Math.round(bin.rows * 0.055)) | 1;
  const vk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, h));
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, vk, new cv.Point(-1, -1), 1);
  vk.delete();
}

/* 펼침면에서 좌/우 페이지 블롭을 각각 감지 (책등 그림자가 두 밝은 영역을 가르는 것을 이용) */
/* 펼침면 페이지 감지 — 중앙 고정선 방식:
   책등 = 화면 가운데(사용자가 빨간 선에 맞춤)로 고정하고,
   좌/우 절반에서 각각 "페이지 하나"만 찾는다 (책등 그림자 유무와 무관하게 동작) */
function findPageBlobs(canvas) {
  const W = canvas.width, H = canvas.height;
  const mid = W >> 1;
  const halfCanvas = (x0, w) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = H;
    c.getContext('2d').drawImage(canvas, x0, 0, w, H, 0, 0, w, H);
    return c;
  };
  const out = [];
  try {
    const L = findDocQuad(halfCanvas(0, mid), 0.18);
    const R = findDocQuad(halfCanvas(mid, W - mid), 0.18);
    // 페이지 안쪽 변이 중앙선 근처에 닿아 있어야 진짜 펼침면 페이지
    if (L && Math.max(L.quad.tr.x, L.quad.br.x) > mid * 0.75) {
      out.push({ quad: L.quad, contour: L.contour });
    }
    if (R) {
      const sh = (p) => ({ x: p.x + mid, y: p.y });
      const q = { tl: sh(R.quad.tl), tr: sh(R.quad.tr), br: sh(R.quad.br), bl: sh(R.quad.bl) };
      if (Math.min(q.tl.x, q.bl.x) < mid + (W - mid) * 0.25) {
        out.push({ quad: q, contour: R.contour.map(sh) });
      }
    }
  } catch (e) {
    console.warn('findPageBlobs 실패', e);
  }
  return out; // 왼쪽 → 오른쪽 순
}

/* 펼침면 분할: 좌/우 페이지를 각각 보정(원근+곡면)해 2페이지로 저장 */
async function addSpreadPages(blob, silent) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
    const dc = document.createElement('canvas');
    dc.width = Math.round(bmp.width * scale);
    dc.height = Math.round(bmp.height * scale);
    dc.getContext('2d').drawImage(bmp, 0, 0, dc.width, dc.height);
    bmp.close();

    const blobs = findPageBlobs(dc);
    const up = (p) => ({ x: p.x / scale, y: p.y / scale });

    // 두 블롭이 "좌우로 나란"할 때만 펼침면 두 페이지로 인정.
    // (스프링 제본·그림자 같은 어두운 가로 띠가 한 페이지를 위/아래로 가른 경우 오인 방지)
    if (blobs.length === 2) {
      const cen = (q) => ({ x: (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4, y: (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4 });
      const c1 = cen(blobs[0].quad), c2 = cen(blobs[1].quad);
      if (Math.abs(c1.x - c2.x) < Math.abs(c1.y - c2.y) * 1.2) blobs.length = 1;
    }

    if (blobs.length === 2) {
      // 이상적 경로: 페이지별로 각각 보정 → 곡면도 페이지 단위로 정확히 펴짐
      for (const b of blobs) {
        const curves = extractCurves(b.contour, b.quad);
        const temp = {
          blob,
          corners: { tl: up(b.quad.tl), tr: up(b.quad.tr), br: up(b.quad.br), bl: up(b.quad.bl) },
          curves: curves ? { top: curves.top.map(up), bottom: curves.bottom.map(up) } : null,
          autoChecked: true, rotation: 0, filter: 'original', bright: 0, contrast: 0,
        };
        const canvas = await processPage(temp, CAPTURE_MAX_SIDE);
        const pageBlob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
        await addPage(pageBlob, true, true);
      }
      if (!silent) toast(`펼침면 분할 → ${state.pages.length - 1}·${state.pages.length}페이지`, { type: 'success', duration: 1600 });
      return true;
    }

    // 폴백: 펼침면이 한 덩어리로 잡히면 통째 보정 후 책등 골짜기에서 절단
    const temp = {
      blob, corners: null, curves: null, autoChecked: false,
      rotation: 0, filter: 'original', bright: 0, contrast: 0,
    };
    await detectCorners(temp);
    if (!temp.corners) {
      // 최후 폴백: 감지 실패 시에도 고정 중앙선 기준으로 절단
      // (사용자가 책등을 빨간 선에 맞췄다는 전제 — 각 반쪽은 일반 감지·보정을 따로 거침)
      const bmp2 = await createImageBitmap(blob);
      const half = (x0, w) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = bmp2.height;
        c.getContext('2d').drawImage(bmp2, x0, 0, w, bmp2.height, 0, 0, w, bmp2.height);
        return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      };
      const mid = Math.round(bmp2.width / 2);
      const lb = await half(0, mid);
      const rb = await half(mid, bmp2.width - mid);
      bmp2.close();
      await addPage(lb, true);
      await addPage(rb, true);
      if (!silent) toast('가운데 선 기준으로 2페이지 분할됨', { duration: 1800 });
      return true;
    }
    const canvas = await processPage(temp, CAPTURE_MAX_SIDE);
    if (canvas.width < 200) return false;
    // 보정 결과가 세로형이면 펼침면이 아니라 한 페이지 → 자르지 않고 그대로 저장
    if (canvas.width < canvas.height * 1.15) {
      const single = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
      await addPage(single, true, true);
      if (!silent) {
        // 세로형인데 가로 골짜기가 있으면 = 화면이 안 돌아간 채 가로로 찍은 펼침면
        if (hasHorizontalValley(canvas)) {
          toast('화면이 회전되지 않아 좌/우 분할을 못 했어요 — 폰의 화면 자동회전을 켜고 다시 촬영해 주세요', { type: 'error', duration: 4000 });
        } else {
          toast('펼침면으로 보이지 않아 한 페이지로 저장됨', { duration: 1800 });
        }
      }
      return true;
    }
    const sx = findSpineX(canvas);
    const cut = (x0, w) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = canvas.height;
      c.getContext('2d').drawImage(canvas, x0, 0, w, canvas.height, 0, 0, w, canvas.height);
      return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
    };
    const leftBlob = await cut(0, sx);
    const rightBlob = await cut(sx, canvas.width - sx);
    await addPage(leftBlob, true, true);
    await addPage(rightBlob, true, true);
    if (!silent) toast(`펼침면 분할 → ${state.pages.length - 1}·${state.pages.length}페이지`, { type: 'success', duration: 1600 });
    return true;
  } catch (e) {
    console.warn('펼침면 분할 실패', e);
    return false;
  }
}

/* 화면 미회전 감지: 세로형 이미지 가운데에 어두운 "가로" 골짜기가 있으면
   = 폰만 돌리고 화면은 안 돌아간 상태의 펼침면 (책등이 가로로 누움) */
function hasHorizontalValley(canvas) {
  const H = 400;
  const scale = H / canvas.height;
  const W = Math.max(8, Math.round(canvas.width * scale));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, W, H);
  const x0 = Math.round(W * 0.2), cols = Math.max(1, Math.round(W * 0.6));
  const d = ctx.getImageData(x0, 0, cols, H).data;
  const row = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }
    row[y] = s / cols;
  }
  const sm = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < H) { s += row[yy]; n++; }
    }
    sm[y] = s / n;
  }
  let minV = Infinity;
  for (let y = Math.round(H * 0.35); y <= Math.round(H * 0.65); y++) {
    if (sm[y] < minV) minV = sm[y];
  }
  const sorted = [...sm].sort((a, b) => a - b);
  return minV < sorted[H >> 1] - 10;
}

/* 책등(골짜기) 위치: 중앙 30% 구간에서 가장 어두운 세로줄. 뚜렷하지 않으면 중앙 */
function findSpineX(canvas) {
  const W = 400;
  const scale = W / canvas.width;
  const H = Math.max(8, Math.round(canvas.height * scale));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, W, H);
  const d = ctx.getImageData(0, Math.round(H * 0.2), W, Math.max(1, Math.round(H * 0.6))).data;
  const rows = Math.max(1, Math.round(H * 0.6));
  const col = new Float32Array(W);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      col[x] += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }
  }
  for (let x = 0; x < W; x++) col[x] /= rows;
  // 5px 이동평균 후 중앙 35~65% 구간에서 최솟값 탐색
  const sm = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) {
      const xx = x + k;
      if (xx >= 0 && xx < W) { s += col[xx]; n++; }
    }
    sm[x] = s / n;
  }
  const lo = Math.round(W * 0.35), hi = Math.round(W * 0.65);
  let minX = Math.round(W / 2), minV = Infinity;
  for (let x = lo; x <= hi; x++) {
    if (sm[x] < minV) { minV = sm[x]; minX = x; }
  }
  const sorted = [...sm].sort((a, b) => a - b);
  const median = sorted[W >> 1];
  // 골짜기가 주변보다 확실히 어두울 때만 채택, 아니면 정중앙
  const spine = minV < median - 8 ? minX : Math.round(W / 2);
  return Math.round(spine / scale);
}

/* 페이지 추가 (촬영/불러오기 공용). preprocessed=true면 이미 보정된 이미지라 감지 생략 */
async function addPage(blob, silent = false, preprocessed = false) {
  const page = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
    blob,
    corners: null,
    curves: null,
    autoChecked: preprocessed,
    rotation: 0,
    filter: 'magic',
    bright: 0,
    contrast: 0,
    thumbUrl: null,
    thumbDirty: true,
  };
  state.pages.push(page);
  persistPage(page);
  updateCaptureBadge();
  if (!silent) toast(`${state.pages.length}페이지 추가됨`, { type: 'success', duration: 1400 });
  if (!preprocessed) {
    detectCorners(page).then(() => {
      if (state.screen === 'gallery') renderGallery();
    });
  }
  return page;
}

async function updateCaptureBadge() {
  const n = state.pages.length;
  const cnt = $('cap-count');
  const thumb = $('cap-thumb');
  cnt.textContent = n;
  cnt.classList.toggle('hidden', n === 0);
  thumb.classList.toggle('empty', n === 0);
  if (n > 0) {
    const last = state.pages[n - 1];
    const url = URL.createObjectURL(last.blob);
    thumb.style.backgroundImage = `url("${url}")`;
    thumb.dataset.tmpUrl && URL.revokeObjectURL(thumb.dataset.tmpUrl);
    thumb.dataset.tmpUrl = url;
  } else {
    thumb.style.backgroundImage = '';
  }
}

/* 파일 불러오기 */
async function importFiles(files) {
  if (!files || !files.length) return;
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  toast(`${list.length}장 불러오는 중…`, { duration: 1800 });
  for (const f of list) {
    // 너무 큰 원본은 보관 해상도로 리사이즈
    try {
      const bmp = await createImageBitmap(f);
      const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(bmp.width, bmp.height));
      let blob = f;
      if (scale < 1) {
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * scale);
        c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      }
      bmp.close();
      await addCapturedBlob(blob, true);
    } catch (e) {
      console.warn('불러오기 실패', e);
    }
  }
  toast(`${list.length}장 추가 완료 (총 ${state.pages.length}페이지)`, { type: 'success' });
  if (state.screen === 'gallery') renderGallery();
}

/* ============================================================
   화면 전환
   ============================================================ */
function show(screen) {
  state.screen = screen;
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  $(`page-${screen}`).classList.add('active');
  $('btn-back').classList.toggle('hidden', screen === 'capture');
  if (screen === 'capture') startCamera();
  else stopCamera();
  if (screen === 'gallery') { exitSelectMode(); renderGallery(); }
  if (screen === 'edit') renderEdit();
}

/* ============================================================
   화면 2: 갤러리 (요구 2 — 펼쳐보기/선택 삭제/순서 이동)
   ============================================================ */
async function ensureThumb(page) {
  if (page.thumbUrl && !page.thumbDirty) return page.thumbUrl;
  // 동시 호출 시 같은 작업을 공유 — 중복 생성으로 사용 중인 URL이 무효화되는 잔상 버그 방지
  if (page._thumbJob) return page._thumbJob;
  page._thumbJob = (async () => {
    try {
      do {
        page.thumbDirty = false;
        const canvas = await processPage(page, THUMB_MAX_SIDE);
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
        const old = page.thumbUrl;
        page.thumbUrl = URL.createObjectURL(blob);
        if (old) URL.revokeObjectURL(old);
      } while (page.thumbDirty); // 생성 도중 설정이 바뀌었으면 한 번 더
      return page.thumbUrl;
    } finally {
      page._thumbJob = null;
    }
  })();
  return page._thumbJob;
}

function renderGallery() {
  const grid = $('gal-grid');
  $('gal-count').textContent = state.pages.length;
  $('gal-empty').classList.toggle('hidden', state.pages.length > 0);
  grid.classList.toggle('select-mode', state.selectMode);
  grid.innerHTML = '';
  state.pages.forEach((page, i) => {
    const item = document.createElement('div');
    item.className = 'gal-item' + (state.selected.has(page.id) ? ' selected' : '');
    item.innerHTML = `<div class="gal-spin"><div class="loading-spinner"></div></div>
      <span class="gal-num">${i + 1}</span><span class="gal-check"></span>`;
    item.onclick = () => {
      if (state.selectMode) toggleSelect(page.id, item);
      else { state.editIdx = i; show('edit'); }
    };
    grid.appendChild(item);
    ensureThumb(page).then((url) => {
      if (!item.isConnected) return;
      const img = document.createElement('img');
      img.src = url;
      item.querySelector('.gal-spin')?.remove();
      item.prepend(img);
    }).catch(() => {
      // 실패해도 스피너가 영원히 돌지 않게 처리
      const spin = item.querySelector('.gal-spin');
      if (spin) spin.innerHTML = '<span style="color:var(--text-dim);font-size:11px;">오류</span>';
    });
  });
  updateSelectBar();
}

function toggleSelect(id, item) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  item.classList.toggle('selected', state.selected.has(id));
  updateSelectBar();
}

function updateSelectBar() {
  $('gal-bar-normal').classList.toggle('hidden', state.selectMode);
  $('gal-bar-select').classList.toggle('hidden', !state.selectMode);
  const n = state.selected.size;
  $('sel-count').textContent = n ? `(${n})` : '';
  $('btn-delete-sel').disabled = n === 0;
  const single = n === 1;
  $('btn-move-left').disabled = !single;
  $('btn-move-right').disabled = !single;
}

function enterSelectMode() {
  state.selectMode = true;
  state.selected.clear();
  renderGallery();
}

function exitSelectMode() {
  state.selectMode = false;
  state.selected.clear();
}

/* 선택 삭제 + 실행취소 */
function deleteSelected() {
  const ids = new Set(state.selected);
  if (!ids.size) return;
  const removed = [];
  state.pages = state.pages.filter((p, i) => {
    if (ids.has(p.id)) { removed.push({ page: p, idx: i }); return false; }
    return true;
  });
  exitSelectMode();
  state.selectMode = false;
  renderGallery();
  updateCaptureBadge();
  let undone = false;
  toast(`${removed.length}페이지 삭제됨`, {
    type: 'error',
    actionText: '실행취소',
    duration: 5000,
    onAction: () => {
      undone = true;
      removed.sort((a, b) => a.idx - b.idx).forEach(({ page, idx }) => {
        state.pages.splice(Math.min(idx, state.pages.length), 0, page);
      });
      persistOrder();
      renderGallery();
      updateCaptureBadge();
    },
  });
  setTimeout(() => {
    if (undone) return;
    removed.forEach(({ page }) => {
      idb.delete(page.id);
      if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
    });
    persistOrder();
  }, 5200);
}

function moveSelected(dir) {
  if (state.selected.size !== 1) return;
  const id = [...state.selected][0];
  const i = state.pages.findIndex((p) => p.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.pages.length) return;
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  persistOrder();
  renderGallery();
}

function clearAll() {
  if (!state.pages.length) return;
  if (!confirm(`전체 ${state.pages.length}페이지를 모두 삭제하고 새로 시작할까요?`)) return;
  state.pages.forEach((p) => p.thumbUrl && URL.revokeObjectURL(p.thumbUrl));
  state.pages = [];
  idb.clear();
  exitSelectMode();
  renderGallery();
  updateCaptureBadge();
  toast('새 스캔을 시작합니다');
}

/* ============================================================
   화면 3: 편집 (회전/필터/밝기/대비/전체적용)
   ============================================================ */
let editRenderSeq = 0;

function currentPage() { return state.pages[state.editIdx] || null; }

/* ---------- 미리보기 핀치 확대/축소 + 이동 + 더블탭 ---------- */
const editZoom = { scale: 1, tx: 0, ty: 0 };

function applyEditZoom() {
  $('edit-canvas').style.transform =
    `translate(${editZoom.tx}px, ${editZoom.ty}px) scale(${editZoom.scale})`;
}

function resetEditZoom() {
  editZoom.scale = 1; editZoom.tx = 0; editZoom.ty = 0;
  applyEditZoom();
}

function clampEditPan() {
  const c = $('edit-canvas');
  const maxX = ((editZoom.scale - 1) * c.clientWidth) / 2;
  const maxY = ((editZoom.scale - 1) * c.clientHeight) / 2;
  editZoom.tx = Math.max(-maxX, Math.min(maxX, editZoom.tx));
  editZoom.ty = Math.max(-maxY, Math.min(maxY, editZoom.ty));
}

function initEditGestures() {
  const wrap = document.querySelector('.edit-view-wrap');
  let mode = null; // 'swipe' | 'pan' | 'pinch'
  let startX = 0, startY = 0, startTx = 0, startTy = 0;
  let startDist = 0, startScale = 1, pinchCx = 0, pinchCy = 0, lastTap = 0;

  const dist2 = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      mode = 'pinch';
      startDist = dist2(e.touches);
      startScale = editZoom.scale;
      startTx = editZoom.tx; startTy = editZoom.ty;
      const r = wrap.getBoundingClientRect();
      pinchCx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left - r.width / 2;
      pinchCy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top - r.height / 2;
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { // 더블탭: 2.5배 ↔ 원래대로
        lastTap = 0;
        if (editZoom.scale > 1) resetEditZoom();
        else { editZoom.scale = 2.5; clampEditPan(); applyEditZoom(); }
        mode = null;
        return;
      }
      lastTap = now;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      startTx = editZoom.tx; startTy = editZoom.ty;
      mode = editZoom.scale > 1 ? 'pan' : 'swipe';
    }
  }, { passive: true });

  wrap.addEventListener('touchmove', (e) => {
    if (mode === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      const s = Math.min(5, Math.max(1, (startScale * dist2(e.touches)) / startDist));
      const k = s / startScale; // 손가락 중심점이 고정되도록 이동 보정
      editZoom.tx = pinchCx - k * (pinchCx - startTx);
      editZoom.ty = pinchCy - k * (pinchCy - startTy);
      editZoom.scale = s;
      clampEditPan();
      applyEditZoom();
    } else if (mode === 'pan' && e.touches.length === 1) {
      e.preventDefault();
      editZoom.tx = startTx + e.touches[0].clientX - startX;
      editZoom.ty = startTy + e.touches[0].clientY - startY;
      clampEditPan();
      applyEditZoom();
    }
  }, { passive: false });

  wrap.addEventListener('touchend', (e) => {
    if (mode === 'swipe' && e.changedTouches.length) {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 80) {
        if (dx < 0 && state.editIdx < state.pages.length - 1) { state.editIdx++; renderEdit(); }
        else if (dx > 0 && state.editIdx > 0) { state.editIdx--; renderEdit(); }
      }
    }
    if (e.touches.length === 0) mode = null;
    else if (e.touches.length === 1) { // 핀치 → 한 손가락 남으면 이동으로 전환
      mode = editZoom.scale > 1 ? 'pan' : null;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      startTx = editZoom.tx; startTy = editZoom.ty;
    }
  }, { passive: true });

  // 데스크톱: 휠 줌
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    editZoom.scale = Math.min(5, Math.max(1, editZoom.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (editZoom.scale === 1) { editZoom.tx = 0; editZoom.ty = 0; }
    clampEditPan();
    applyEditZoom();
  }, { passive: false });
}

async function renderEdit() {
  const page = currentPage();
  if (!page) { show('gallery'); return; }
  resetEditZoom();
  $('edit-pos').textContent = `${state.editIdx + 1} / ${state.pages.length}`;
  $('btn-edit-prev').disabled = state.editIdx === 0;
  $('btn-edit-next').disabled = state.editIdx === state.pages.length - 1;
  document.querySelectorAll('#filter-chips .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.filter === page.filter));
  $('sl-bright').value = page.bright;
  $('sl-contrast').value = page.contrast;
  $('sl-bright-v').textContent = page.bright;
  $('sl-contrast-v').textContent = page.contrast;
  await redrawEdit();
}

async function redrawEdit() {
  const page = currentPage();
  if (!page) return;
  const seq = ++editRenderSeq;
  $('edit-loading').classList.remove('hidden');
  try {
    const canvas = await processPage(page, EDIT_MAX_SIDE);
    if (seq !== editRenderSeq) return; // 오래된 렌더 무시
    const view = $('edit-canvas');
    view.width = canvas.width;
    view.height = canvas.height;
    view.getContext('2d').drawImage(canvas, 0, 0);
  } finally {
    if (seq === editRenderSeq) $('edit-loading').classList.add('hidden');
  }
}

function markDirtyAndRedraw(page) {
  page.thumbDirty = true;
  persistPage(page);
  redrawEdit();
}

let slTimer = null;
function onSlider() {
  const page = currentPage();
  if (!page) return;
  page.bright = +$('sl-bright').value;
  page.contrast = +$('sl-contrast').value;
  $('sl-bright-v').textContent = page.bright;
  $('sl-contrast-v').textContent = page.contrast;
  page.thumbDirty = true;
  clearTimeout(slTimer);
  slTimer = setTimeout(() => { persistPage(page); redrawEdit(); }, 180);
}

function applyToAll() {
  const page = currentPage();
  if (!page) return;
  state.pages.forEach((p) => {
    if (p === page) return;
    p.filter = page.filter;
    p.bright = page.bright;
    p.contrast = page.contrast;
    p.thumbDirty = true;
    persistPage(p);
  });
  toast(`전체 ${state.pages.length}페이지에 적용됨`, { type: 'success' });
}

function deleteCurrentPage() {
  const page = currentPage();
  if (!page) return;
  state.pages.splice(state.editIdx, 1);
  idb.delete(page.id);
  if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  persistOrder();
  updateCaptureBadge();
  toast('페이지 삭제됨');
  if (!state.pages.length) { show('gallery'); return; }
  state.editIdx = Math.min(state.editIdx, state.pages.length - 1);
  renderEdit();
}

/* ============================================================
   수동 영역보정 모달 (요구 6 — 수동)
   ============================================================ */
const cornerUI = {
  page: null,
  corners: null,      // 원본 이미지 좌표
  imgW: 0, imgH: 0,
  dispScale: 1, offX: 0, offY: 0,
  bmpCanvas: null,
};

async function openCornerModal() {
  const page = currentPage();
  if (!page) return;
  if (!state.cvReady) { toast('보정 엔진 로딩 후 사용할 수 있습니다', { type: 'error' }); return; }
  cornerUI.page = page;
  const bmp = await createImageBitmap(page.blob);
  cornerUI.imgW = bmp.width; cornerUI.imgH = bmp.height;
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  cornerUI.bmpCanvas = c;
  cornerUI.corners = page.corners
    ? JSON.parse(JSON.stringify(page.corners))
    : defaultCorners(cornerUI.imgW, cornerUI.imgH);
  cornerUI.detectedCurves = page.curves ? JSON.parse(JSON.stringify(page.curves)) : null;
  cornerUI.handleMoved = false;
  $('corner-modal').classList.add('open');
  requestAnimationFrame(layoutCornerStage);
}

function defaultCorners(w, h) {
  const mx = w * 0.08, my = h * 0.08;
  return {
    tl: { x: mx, y: my }, tr: { x: w - mx, y: my },
    br: { x: w - mx, y: h - my }, bl: { x: mx, y: h - my },
  };
}

function layoutCornerStage() {
  const stage = $('corner-stage');
  const canvas = $('corner-canvas');
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const scale = Math.min(sw / cornerUI.imgW, sh / cornerUI.imgH);
  const dw = cornerUI.imgW * scale, dh = cornerUI.imgH * scale;
  cornerUI.dispScale = scale;
  cornerUI.offX = (sw - dw) / 2;
  cornerUI.offY = (sh - dh) / 2;
  canvas.width = Math.round(dw);
  canvas.height = Math.round(dh);
  canvas.style.left = `${cornerUI.offX}px`;
  canvas.style.top = `${cornerUI.offY}px`;
  canvas.getContext('2d').drawImage(cornerUI.bmpCanvas, 0, 0, dw, dh);
  drawCornerOverlay();
}

function drawCornerOverlay() {
  const { corners, dispScale: s, offX, offY } = cornerUI;
  const toDisp = (p) => ({ x: p.x * s + offX, y: p.y * s + offY });
  const pts = ['tl', 'tr', 'br', 'bl'].map((k) => toDisp(corners[k]));
  const svg = $('corner-lines');
  svg.innerHTML = `<polygon points="${pts.map((p) => `${p.x},${p.y}`).join(' ')}"/>`;
  document.querySelectorAll('.corner-handle').forEach((h) => {
    const p = toDisp(corners[h.dataset.c]);
    h.style.left = `${p.x}px`;
    h.style.top = `${p.y}px`;
  });
}

function initCornerHandles() {
  document.querySelectorAll('.corner-handle').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const key = h.dataset.c;
      cornerUI.handleMoved = true; // 직접 조정 → 곡선 대신 직선 사각형 적용
      const move = (ev) => {
        const rect = $('corner-stage').getBoundingClientRect();
        const x = (ev.clientX - rect.left - cornerUI.offX) / cornerUI.dispScale;
        const y = (ev.clientY - rect.top - cornerUI.offY) / cornerUI.dispScale;
        cornerUI.corners[key] = {
          x: Math.max(0, Math.min(cornerUI.imgW, x)),
          y: Math.max(0, Math.min(cornerUI.imgH, y)),
        };
        drawCornerOverlay();
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
  });
}

async function cornerAutoDetect() {
  const page = cornerUI.page;
  const savedCorners = page.corners;
  const savedCurves = page.curves;
  page.corners = null;
  page.curves = null;
  page.autoChecked = false;
  await detectCorners(page);
  if (page.corners) {
    cornerUI.corners = JSON.parse(JSON.stringify(page.corners));
    cornerUI.detectedCurves = page.curves ? JSON.parse(JSON.stringify(page.curves)) : null;
    cornerUI.handleMoved = false; // 핸들을 안 건드리면 감지된 곡선까지 적용
    toast(page.curves ? '문서 영역 감지 (곡면 포함)' : '문서 영역을 자동 감지했습니다', { type: 'success', duration: 1500 });
  } else {
    toast('자동 감지 실패 — 직접 조정해 주세요', { type: 'error' });
  }
  page.corners = savedCorners; // 적용 버튼을 눌러야 확정
  page.curves = savedCurves;
  drawCornerOverlay();
}

function closeCornerModal() { $('corner-modal').classList.remove('open'); cornerUI.bmpCanvas = null; }

function applyCorners(useFull) {
  const page = cornerUI.page;
  page.corners = useFull ? null : JSON.parse(JSON.stringify(cornerUI.corners));
  // 자동감지 결과를 그대로 적용하면 곡선 유지, 핸들을 직접 움직였으면 직선 사각형
  page.curves = (!useFull && cornerUI.detectedCurves && !cornerUI.handleMoved)
    ? cornerUI.detectedCurves
    : null;
  page.autoChecked = true;
  closeCornerModal();
  markDirtyAndRedraw(page);
  toast(useFull ? '전체 영역으로 설정됨' : '문서 영역이 적용됨', { type: 'success', duration: 1500 });
}

/* ============================================================
   PDF 생성 + 공유 (요구 3·5 — 핵심)
   ============================================================ */
function openPdfModal() {
  if (!state.pages.length) { toast('먼저 페이지를 추가하세요', { type: 'error' }); return; }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('pdf-name').value = `스캔_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  $('pdf-page-info').textContent = `${state.pages.length}페이지`;
  // Web Share 미지원 브라우저에선 공유 버튼 숨김
  const testFile = new File(['x'], 't.pdf', { type: 'application/pdf' });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [testFile] }));
  $('btn-pdf-share').classList.toggle('hidden', !canShare);
  $('pdf-modal').classList.add('open');
}

function closePdfModal() { $('pdf-modal').classList.remove('open'); }

async function buildPdf() {
  const { maxSide, jpeg } = PDF_QUALITY[state.pdfQuality];
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const A4W = 210, A4H = 297;
  const overlay = $('progress-overlay');
  overlay.classList.add('open');
  try {
    for (let i = 0; i < state.pages.length; i++) {
      $('progress-text').textContent = `PDF 생성 중… ${i + 1} / ${state.pages.length}`;
      $('progress-fill').style.width = `${((i + 1) / state.pages.length) * 100}%`;
      const canvas = await processPage(state.pages[i], maxSide);
      const data = canvas.toDataURL('image/jpeg', jpeg);
      if (i > 0) doc.addPage();
      let w = A4W, h = (A4W * canvas.height) / canvas.width;
      if (h > A4H) { h = A4H; w = (A4H * canvas.width) / canvas.height; }
      doc.addImage(data, 'JPEG', (A4W - w) / 2, (A4H - h) / 2, w, h);
      await new Promise((r) => setTimeout(r)); // UI 숨통
    }
    return doc;
  } finally {
    overlay.classList.remove('open');
    $('progress-fill').style.width = '0%';
  }
}

function pdfFileName() {
  const raw = ($('pdf-name').value || 'scan').trim().replace(/[\\/:*?"<>|]/g, '_');
  return raw.endsWith('.pdf') ? raw : `${raw}.pdf`;
}

async function savePdf() {
  closePdfModal();
  try {
    const doc = await buildPdf();
    doc.save(pdfFileName());
    toast('PDF 저장 완료', { type: 'success' });
  } catch (e) {
    console.error(e);
    toast('PDF 생성에 실패했습니다', { type: 'error' });
  }
}

async function sharePdf() {
  closePdfModal();
  try {
    const doc = await buildPdf();
    const blob = doc.output('blob');
    const file = new File([blob], pdfFileName(), { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: pdfFileName() });
    } else {
      doc.save(pdfFileName());
      toast('공유 미지원 — 파일로 저장했습니다');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 사용자가 공유 취소
    console.error(e);
    toast('공유에 실패했습니다', { type: 'error' });
  }
}

/* ============================================================
   초기화 + 이벤트 바인딩
   ============================================================ */
async function restoreSession() {
  try {
    await idb.open();
    const rows = await idb.getAll();
    if (!rows.length) return;
    rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    state.pages = rows.map((r) => ({
      id: r.id, blob: r.blob, corners: r.corners || null,
      curves: r.curves || null,
      autoChecked: r.autoChecked ?? true,
      rotation: r.rotation || 0, filter: r.filter || 'magic',
      bright: r.bright || 0, contrast: r.contrast || 0,
      thumbUrl: null, thumbDirty: true,
    }));
    updateCaptureBadge();
    toast(`이전 작업 ${rows.length}페이지 복원됨`, { type: 'success' });
  } catch (e) {
    console.warn('세션 복원 실패', e);
  }
}

function bindEvents() {
  // 헤더
  $('btn-back').onclick = () => show(state.screen === 'edit' ? 'gallery' : 'capture');

  // 촬영
  $('btn-shutter').onclick = capture;
  $('btn-spread').classList.toggle('on', state.spreadMode);
  $('btn-spread').onclick = () => {
    state.spreadMode = !state.spreadMode;
    localStorage.setItem('spreadMode', state.spreadMode ? '1' : '0');
    $('btn-spread').classList.toggle('on', state.spreadMode);
    toast(state.spreadMode
      ? '펼침면 모드 ON — 촬영하면 좌/우 페이지로 나눠 저장됩니다'
      : '펼침면 모드 해제', { duration: 2000 });
  };
  $('btn-upload').onclick = () => $('file-input').click();
  $('file-input').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };
  $('btn-goto-gallery').onclick = () => show('gallery');

  // 갤러리
  $('btn-select-mode').onclick = enterSelectMode;
  $('btn-select-cancel').onclick = () => { exitSelectMode(); renderGallery(); };
  $('btn-clear-all').onclick = clearAll;
  $('btn-add-shot').onclick = () => show('capture');
  $('btn-make-pdf').onclick = openPdfModal;
  $('btn-delete-sel').onclick = deleteSelected;
  $('btn-move-left').onclick = () => moveSelected(-1);
  $('btn-move-right').onclick = () => moveSelected(1);

  // 편집
  $('btn-edit-prev').onclick = () => { if (state.editIdx > 0) { state.editIdx--; renderEdit(); } };
  $('btn-edit-next').onclick = () => { if (state.editIdx < state.pages.length - 1) { state.editIdx++; renderEdit(); } };
  $('btn-rotate').onclick = () => {
    const p = currentPage();
    if (!p) return;
    p.rotation = (p.rotation + 90) % 360;
    markDirtyAndRedraw(p);
  };
  $('btn-corners').onclick = openCornerModal;
  $('btn-apply-all').onclick = applyToAll;
  $('btn-edit-delete').onclick = deleteCurrentPage;
  document.querySelectorAll('#filter-chips .chip').forEach((chip) => {
    chip.onclick = () => {
      const p = currentPage();
      if (!p) return;
      p.filter = chip.dataset.filter;
      document.querySelectorAll('#filter-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
      markDirtyAndRedraw(p);
    };
  });
  $('sl-bright').oninput = onSlider;
  $('sl-contrast').oninput = onSlider;

  // 편집 화면 제스처: 핀치 확대/축소·이동·더블탭·스와이프 페이지 이동
  initEditGestures();

  // 수동 영역보정
  initCornerHandles();
  $('btn-corner-cancel').onclick = closeCornerModal;
  $('btn-corner-apply').onclick = () => applyCorners(false);
  $('btn-corner-full').onclick = () => applyCorners(true);
  $('btn-corner-auto').onclick = cornerAutoDetect;
  window.addEventListener('resize', () => {
    if ($('corner-modal').classList.contains('open')) layoutCornerStage();
  });

  // PDF 시트
  $('btn-pdf-cancel').onclick = closePdfModal;
  $('btn-pdf-save').onclick = savePdf;
  $('btn-pdf-share').onclick = sharePdf;
  document.querySelectorAll('#quality-chips .chip').forEach((chip) => {
    chip.onclick = () => {
      state.pdfQuality = chip.dataset.q;
      document.querySelectorAll('#quality-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });
  $('pdf-modal').addEventListener('click', (e) => { if (e.target === $('pdf-modal')) closePdfModal(); });

  // 좌우 스와이프로 촬영(1) ↔ 페이지(2) 화면 전환
  let navX = null, navY = null;
  const navZone = $('main');
  navZone.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { navX = null; return; }
    navX = e.touches[0].clientX;
    navY = e.touches[0].clientY;
  }, { passive: true });
  navZone.addEventListener('touchend', (e) => {
    if (navX === null || !e.changedTouches.length) return;
    const dx = e.changedTouches[0].clientX - navX;
    const dy = e.changedTouches[0].clientY - navY;
    navX = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 60) return;
    if (state.screen === 'capture' && dx < 0 && state.pages.length) show('gallery');
    else if (state.screen === 'gallery' && dx > 0 && !state.selectMode) show('capture');
  }, { passive: true });

  // 화면 꺼짐/전환 시 카메라 정리
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else if (state.screen === 'capture') startCamera();
  });

  // 화면 회전 시 카메라를 새 방향에 맞춰 재시작 (펼침면 가로 촬영 대응)
  let rotTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(rotTimer);
    rotTimer = setTimeout(() => {
      if (state.screen !== 'capture' || !state.stream) return;
      const st = state.stream.getVideoTracks()[0]?.getSettings() || {};
      const winLandscape = window.innerWidth > window.innerHeight;
      const vidLandscape = (st.width || 0) > (st.height || 0);
      if (vidLandscape !== winLandscape) {
        stopCamera();
        startCamera();
      }
    }, 400);
  });

  // 진단: 로고를 빠르게 두 번 탭하면 카메라 상태 표시
  let logoTap = 0;
  document.querySelector('.logo').addEventListener('click', () => {
    const now = Date.now();
    if (now - logoTap < 350) {
      const st = state.stream?.getVideoTracks()[0]?.getSettings() || {};
      const v = $('cam');
      toast(`카메라 ${st.width || '?'}×${st.height || '?'} / 표시 ${v.videoWidth}×${v.videoHeight} / 화면 ${window.innerWidth}×${window.innerHeight}`, { duration: 5000 });
    }
    logoTap = now;
  });
}

function dismissSplash() {
  const el = $('splash');
  if (!el) return;
  // 세션 첫 실행에만 온전히 보여주고, 자동 업데이트 새로고침 등에선 짧게
  const seen = sessionStorage.getItem('splashSeen');
  const delay = seen ? 200 : 1500;
  sessionStorage.setItem('splashSeen', '1');
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 550);
  }, delay);
}

/* 폰 뒤로가기 버튼 → 앱 종료 대신 화면 이동 (History 가드 패턴) */
function initBackNavigation() {
  try {
    history.replaceState({ app: 1 }, '');
    history.pushState({ guard: 1 }, '');
  } catch (e) { return; }
  const reguard = () => history.pushState({ guard: 1 }, '');
  window.addEventListener('popstate', () => {
    if ($('corner-modal').classList.contains('open')) { closeCornerModal(); reguard(); return; }
    if ($('pdf-modal').classList.contains('open')) { closePdfModal(); reguard(); return; }
    if ($('progress-overlay').classList.contains('open')) { reguard(); return; } // PDF 생성 중엔 무시
    if (state.screen === 'edit') { show('gallery'); reguard(); return; }
    if (state.screen === 'gallery') { show('capture'); reguard(); return; }
    history.back(); // 촬영 화면에서 한 번 더 누르면 실제 종료
  });
}

async function init() {
  dismissSplash();
  initBackNavigation();
  bindEvents();
  await restoreSession();
  show('capture');
  startLiveOverlay();
  initCV(); // 백그라운드 — UI를 막지 않음
  initServiceWorker();
}

/* 새 버전 자동 반영: 배포가 감지되면 안내 후 스스로 한 번 새로고침 */
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const wasControlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    // 앱이 포그라운드로 돌아올 때마다 업데이트 확인 (PWA는 오래 떠있는 경우가 많음)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  }).catch(() => {});
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !wasControlled) return; // 최초 설치 시에는 새로고침 불필요
    refreshing = true;
    toast('새 버전으로 업데이트 중…', { type: 'success', duration: 1500 });
    setTimeout(() => location.reload(), 700);
  });
}

init();
