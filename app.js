/* ============================================================
   Daddy Scanner v1.0.0 — app.js
   촬영 → 자동/수동 보정 → 필터 → PDF 생성/공유 (전부 브라우저 안에서 처리)
   ============================================================ */
'use strict';

const OPENCV_URL = 'https://docs.opencv.org/4.7.0/opencv.js';
const CAPTURE_MAX_SIDE = 4000;   // 촬영 원본 보관 해상도(장변) — 정지화상(takePhoto) 최대 해상도를 살리기 위해 상향
const THUMB_MAX_SIDE = 420;      // 갤러리 썸네일
const EDIT_MAX_SIDE = 1100;      // 편집 미리보기
const PDF_QUALITY = {
  high: { maxSide: 3200, jpeg: 0.92 },
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
    // 폴백: 복잡한 모양(주변 물체와 일부 병합 등)은 볼록껍질을 씌워 4점 근사
    // — 잘못된 후보면 경계 지지도 채점에서 걸러진다
    if (quad === null) {
      const hull = new cv.Mat();
      cv.convexHull(cnt, hull);
      const periH = cv.arcLength(hull, true);
      for (const k of [0.02, 0.04, 0.07, 0.1]) {
        const ap = new cv.Mat();
        if (quad === null) {
          cv.approxPolyDP(hull, ap, k * periH, true);
          if (ap.rows === 4) {
            const pts = [];
            for (let j = 0; j < 4; j++) pts.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] });
            quad = orderQuad(pts);
          }
        }
        ap.delete();
      }
      hull.delete();
    }
    // 내각 검증: 원근으로 기울어도 문서라면 각이 직각 근처여야 함 (55°~125°)
    if (quad && !quadAnglesOk(quad)) quad = null;
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

/* 어두운 가는 선(책 가장자리 그림자·표 선·글자) + 엣지를 마스크에서 제거
   — 흰 책 위 흰 책, 흰 책상 위 흰 문서를 flood가 넘어가지 못하게 하는 차단벽 */
function subtractDarkLines(blurGray, mask) {
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11));
  const bh = new cv.Mat();
  cv.morphologyEx(blurGray, bh, cv.MORPH_BLACKHAT, k);
  const bar = new cv.Mat();
  cv.threshold(bh, bar, 16, 255, cv.THRESH_BINARY);
  cv.subtract(mask, bar, mask);
  // 그림자 없는 경계(흰 책상 위 흰 문서의 가장자리)도 차단
  cv.Canny(blurGray, bh, 30, 90);
  const k3 = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.dilate(bh, bh, k3, new cv.Point(-1, -1), 1);
  cv.subtract(mask, bh, mask);
  k.delete(); bh.delete(); bar.delete(); k3.delete();
}

/* 후보 사각형 채점: 네 변을 따라 실제 이미지 경계(그라디언트)가 존재하는 비율.
   병합된 가짜 사각형은 경계 없는 허공을 가로지르므로 낮은 점수를 받는다 */
function edgeSupport(grad, q) {
  const edges = [[q.tl, q.tr], [q.tr, q.br], [q.br, q.bl], [q.bl, q.tl]];
  let hit = 0, n = 0;
  for (const [a, b] of edges) {
    for (let i = 1; i < 16; i++) {
      const t = i / 16;
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < grad.cols && yy < grad.rows) {
            m = Math.max(m, grad.ucharPtr(yy, xx)[0]);
          }
        }
      }
      n++;
      if (m > 18) hit++;
    }
  }
  return n ? hit / n : 0;
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

/* 색상거리 분할(사용자 제안 "색 차이"): 중앙(종이) 색을 시드로, Lab 색공간에서
   시드와의 색 차이가 허용치를 넘는 픽셀에서 flood가 멈춘다.
   밝기(L)는 곡면 그림자 때문에 넉넉히, 색조(a/b)는 엄격히 — 흰 책상 vs 흰 종이의 미묘한 톤 차이로 분리 */
function colorRegionQuad(srcRgba, imgArea, minRatio) {
  const rgb = new cv.Mat();
  cv.cvtColor(srcRgba, rgb, cv.COLOR_RGBA2RGB);
  // 블러 없이 변환 — 표 격자선 같은 가는 경계가 흐려져 flood가 넘는 것 방지
  // (FIXED_RANGE 허용치가 픽셀 노이즈는 흡수)
  const lab = new cv.Mat();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  rgb.delete();
  const W = lab.cols, H = lab.rows;
  // 시드가 글자·괘선(어두운 픽셀) 위에 있으면 근처의 밝은 종이 픽셀로 이동
  let sx = -1, sy = -1;
  outer:
  for (let r = 0; r <= 60; r += 5) {
    for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const x = (W >> 1) + dx, y = (H >> 1) + dy;
      if (x >= 0 && y >= 0 && x < W && y < H && lab.ucharPtr(y, x)[0] >= 140) { sx = x; sy = y; break outer; }
    }
  }
  if (sx < 0) { lab.delete(); return null; } // 중앙 부근에 종이가 없음
  const ffMask = cv.Mat.zeros(H + 2, W + 2, cv.CV_8U);
  let best = null;
  try {
    cv.floodFill(lab, ffMask, new cv.Point(sx, sy), new cv.Scalar(255, 255, 255),
      new cv.Rect(), new cv.Scalar(42, 7, 7, 0), new cv.Scalar(42, 7, 7, 0),
      4 | (255 << 8) | cv.FLOODFILL_MASK_ONLY | cv.FLOODFILL_FIXED_RANGE);
    const roi = ffMask.roi(new cv.Rect(1, 1, W, H));
    const comp = roi.clone();
    roi.delete();
    const k = cv.Mat.ones(3, 3, cv.CV_8U);
    // 닫기 1회만 — 표 격자선(≥3px)이 녹아 표 내부가 한 덩어리로 합쳐지는 것 방지
    cv.morphologyEx(comp, comp, cv.MORPH_CLOSE, k, new cv.Point(-1, -1), 1);
    healHorizontalBands(comp); // 스프링 제본 대응
    best = scanQuads(comp, imgArea, minRatio, 0.97, null);
    comp.delete(); k.delete();
  } catch (e) {
    console.warn('colorRegionQuad 실패', e);
  }
  lab.delete(); ffMask.delete();
  return best;
}

/* 캔버스에서 문서 사각형 감지 → {tl,tr,br,bl} (캔버스 좌표) 또는 null
   전략(각 베이스 마스크마다):
   ① 그림자 차단벽 절단 + 중앙 성분 선택 — 겹친 흰 책·잡동사니에 가장 강함
   ② 가로띠 메꿈(스프링 제본) + 중앙 포함 최대 사각형
   베이스: 종이색 마스크 → 밝기 이진화, 이후 엣지 폴백 */
function findDocQuad(canvas, minRatio = 0.15, borderPenalty = true) {
  const src = cv.imread(canvas);
  const imgArea = src.cols * src.rows;
  const center = new cv.Point(src.cols / 2, src.rows / 2);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  const bin = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const pt = new cv.Point(-1, -1);
  const cands = []; // 우선순위 순서대로 수집 → 경계 지지도로 검증
  const push = (r, tag) => { if (r) cands.push({ quad: r.quad, contour: r.contour, tag }); };
  const tryBase = (base) => {
    const a = base.clone();
    subtractDarkLines(blur, a);
    cv.morphologyEx(a, a, cv.MORPH_CLOSE, kernel, pt, 1);
    cv.erode(a, a, kernel, pt, 1);
    push(centerComponentQuad(a, imgArea, minRatio), 'barrier');
    a.delete();
    const b2 = base.clone();
    healHorizontalBands(b2);
    cv.morphologyEx(b2, b2, cv.MORPH_CLOSE, kernel, pt, 2);
    cv.erode(b2, b2, kernel, pt, 1);
    push(scanQuads(b2, imgArea, minRatio, 0.97, center), 'healed');
    b2.delete();
  };
  let best = null;
  try {
    const pm = paperMask(src);
    if (pm) { tryBase(pm); pm.delete(); }
    cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    tryBase(bin);
    cv.Canny(blur, bin, 60, 180);
    cv.dilate(bin, bin, kernel, pt, 2);
    push(scanQuads(bin, imgArea, minRatio, 0.985, center), 'canny1');
    cv.Canny(blur, bin, 20, 70);
    cv.dilate(bin, bin, kernel, pt, 2);
    push(scanQuads(bin, imgArea, minRatio, 0.985, center), 'canny2');
    // 색상거리 분할은 다른 모든 방법이 실패했을 때의 최후 폴백으로만
    if (!cands.length) push(colorRegionQuad(src, imgArea, minRatio), 'color');

    if (cands.length) {
      // 그라디언트 맵으로 "실제 경계 위에 놓인 사각형"인지 검증
      const gx = new cv.Mat(), gy = new cv.Mat(), grad = new cv.Mat();
      cv.Sobel(blur, gx, cv.CV_16S, 1, 0, 3);
      cv.Sobel(blur, gy, cv.CV_16S, 0, 1, 3);
      cv.convertScaleAbs(gx, gx);
      cv.convertScaleAbs(gy, gy);
      cv.addWeighted(gx, 0.5, gy, 0.5, 0, grad);
      gx.delete(); gy.delete();
      for (const c of cands) {
        c.support = edgeSupport(grad, c.quad);
        c.score = c.support;
        // 화면 가장자리에 붙은 후보 감점 — 책배·책상 등으로 번진 병합 영역일 가능성
        // (펼침면 절반 캔버스처럼 경계 접촉이 정상인 경우는 호출측에서 끔)
        if (borderPenalty) {
          const m = 3, Wc = src.cols - 1 - m, Hc = src.rows - 1 - m;
          const touched = [c.quad.tl, c.quad.tr, c.quad.br, c.quad.bl]
            .some((p) => p.x <= m || p.y <= m || p.x >= Wc || p.y >= Hc);
          if (touched) c.score -= 0.35;
        }
      }
      // 우선순위(수집 순서)대로, 점수가 충분한 첫 후보 채택.
      // 전부 부실하면 점수 최고를 채택 (병합 오감지가 우선순위만으로 뽑히는 것 방지)
      best = cands.find((c) => c.score >= 0.55) || cands.reduce((m2, c) => (c.score > m2.score ? c : m2));
      grad.delete();
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

  const samples = [];
  for (let i = 0; i <= K; i++) {
    if (bins[i].length) {
      bins[i].sort((a, b) => a - b);
      samples.push({ t: i / K, d: bins[i][bins[i].length >> 1] }); // 구간 중앙값 (이상치 강건)
    }
  }
  if (samples.length < 6) return null;

  // 베지어 파라미터 곡률(vFlat 특허 방식): 끝점 0 고정 3차 베지어(제어값 2개)로 피팅
  // → 수학적으로 매끈한 곡선만 허용되어 잔물결·감지 노이즈가 원리적으로 제거됨
  const bez = fitBezierDeviation(samples);
  if (!bez) return null;

  // 휨이 미미하면 직선 취급 (불필요한 리맵 방지)
  let maxDev = 0;
  for (let i = 0; i <= K; i++) maxDev = Math.max(maxDev, Math.abs(bez(i / K)));
  if (maxDev < Math.max(2.5, L * 0.012)) return null;

  return Array.from({ length: K + 1 }, (_, i) => {
    const t = i / K;
    const d = bez(t);
    return { x: A.x + t * ex + d * nx, y: A.y + t * ey + d * ny };
  });
}

/* 끝점 0 고정 3차 베지어 편차 곡선의 최소자승 피팅 (+ 이상치 1회 제거 후 재피팅)
   d(t) = 3(1-t)²t·c1 + 3(1-t)t²·c2  — 제어값 c1, c2 두 개가 곡률의 전부 */
function fitBezierDeviation(samples) {
  const f1 = (t) => 3 * (1 - t) * (1 - t) * t;
  const f2 = (t) => 3 * (1 - t) * t * t;
  const solve = (pts) => {
    let S11 = 0, S12 = 0, S22 = 0, b1 = 0, b2 = 0;
    for (const { t, d } of pts) {
      const a = f1(t), b = f2(t);
      S11 += a * a; S12 += a * b; S22 += b * b;
      b1 += a * d; b2 += b * d;
    }
    const det = S11 * S22 - S12 * S12;
    if (Math.abs(det) < 1e-9) return null;
    return [(b1 * S22 - b2 * S12) / det, (b2 * S11 - b1 * S12) / det];
  };
  let c = solve(samples);
  if (!c) return null;
  // 이상치(감지 튐) 1회 제거 후 재피팅
  const res = samples.map(({ t, d }) => Math.abs(d - (f1(t) * c[0] + f2(t) * c[1])));
  const med = [...res].sort((x, y) => x - y)[res.length >> 1] || 0;
  const kept = samples.filter((_, i) => res[i] <= Math.max(3, med * 3));
  if (kept.length >= 5 && kept.length < samples.length) {
    const c2 = solve(kept);
    if (c2) c = c2;
  }
  const [c1, c2v] = c;
  return (t) => f1(t) * c1 + f2(t) * c2v;
}

function sampleLine(A, B, n) {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
  });
}

/* 윤곽선 + 사각형 → 곡선 추출.
   책 도메인 지식: 좌우 변은 직선, 상·하 변만 곡선이 된다 (펼친 책의 물리적 특성) */
function extractCurves(contour, quad) {
  if (!contour || contour.length < 12) return null;
  const top = fitEdgeCurve(contour, quad.tl, quad.tr, quad);
  const bottom = fitEdgeCurve(contour, quad.bl, quad.br, quad);
  const left = null, right = null; // 좌우는 직선 고정
  if (!top && !bottom) return null;
  return {
    top: top || sampleLine(quad.tl, quad.tr, CURVE_SAMPLES),
    bottom: bottom || sampleLine(quad.bl, quad.br, CURVE_SAMPLES),
    left: left || sampleLine(quad.tl, quad.bl, CURVE_SAMPLES),
    right: right || sampleLine(quad.tr, quad.br, CURVE_SAMPLES),
  };
}

/* 곡선 묶음({top,bottom,left,right,…})의 모든 점에 좌표 변환 적용 */
function mapCurvePoints(curves, fn) {
  const o = {};
  for (const k in curves) o[k] = curves[k] ? curves[k].map(fn) : null; // 직선 고정된 변(null)은 그대로
  return o;
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

/* 곡선 경계 메시 리맵 — 네 변 곡선을 모두 반영하는 Coons 패치. 촬영 순간 곡면까지 평탄화 */
function warpCurved(canvas, quad, curves) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const leftC = curves.left || sampleLine(quad.tl, quad.bl, CURVE_SAMPLES);   // 구버전 저장 데이터 호환
  const rightC = curves.right || sampleLine(quad.tr, quad.br, CURVE_SAMPLES);
  const W = Math.max(24, Math.min(canvas.width * 2, Math.round(Math.max(polylineLen(curves.top), polylineLen(curves.bottom)))));
  const H = Math.max(24, Math.min(canvas.height * 2, Math.round(Math.max(polylineLen(leftC), polylineLen(rightC)))));
  const top = resamplePolyline(curves.top, W);
  const bot = resamplePolyline(curves.bottom, W);
  const lft = resamplePolyline(leftC, H);
  const rgt = resamplePolyline(rightC, H);
  const { tl, tr, br, bl } = quad;
  const mapX = new cv.Mat(H, W, cv.CV_32FC1);
  const mapY = new cv.Mat(H, W, cv.CV_32FC1);
  const mx = mapX.data32F, my = mapY.data32F;
  for (let y = 0; y < H; y++) {
    const s = y / (H - 1), is = 1 - s;
    const L = lft[y], R = rgt[y];
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const t = x / (W - 1), it = 1 - t;
      // Coons 패치: 상하 보간 + 좌우 보간 - 코너 이중계산 보정
      mx[row + x] = is * top[x].x + s * bot[x].x + it * L.x + t * R.x
        - (is * it * tl.x + is * t * tr.x + s * it * bl.x + s * t * br.x);
      my[row + x] = is * top[x].y + s * bot[x].y + it * L.y + t * R.y
        - (is * it * tl.y + is * t * tr.y + s * it * bl.y + s * t * br.y);
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

/* 가이드 기준 감지: 사용자가 가이드 프레임에 책을 맞춰 찍었다는 전제로,
   가이드 선 주변 좁은 밴드에서만 실제 경계를 스냅. 못 찾은 변은 가이드 선 그대로 사용
   — 자동 감지가 어긋나도 항상 가이드 근처의 예측 가능한 결과를 보장 */
function guideAnchoredQuad(canvas) {
  const W = canvas.width, H = canvas.height;
  const gx0 = W * GUIDE_INSET, gy0 = H * GUIDE_INSET;
  const gx1 = W * (1 - GUIDE_INSET), gy1 = H * (1 - GUIDE_INSET);
  const src = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  const gxm = new cv.Mat(), gym = new cv.Mat(), grad = new cv.Mat();
  cv.Sobel(blur, gxm, cv.CV_16S, 1, 0, 3);
  cv.Sobel(blur, gym, cv.CV_16S, 0, 1, 3);
  cv.convertScaleAbs(gxm, gxm);
  cv.convertScaleAbs(gym, gym);
  cv.addWeighted(gxm, 0.5, gym, 0.5, 0, grad);
  src.delete(); gray.delete(); blur.delete(); gxm.delete(); gym.delete();

  const band = Math.round(Math.max(W, H) * 0.05);
  const S = 17;
  const snapEdge = (A, B) => {
    const ex = B.x - A.x, ey = B.y - A.y;
    const L = Math.hypot(ex, ey) || 1;
    const nx = -ey / L, ny = ex / L;
    const samples = [];
    for (let i = 0; i < S; i++) {
      const t = 0.07 + (0.86 * i) / (S - 1);
      const px = A.x + ex * t, py = A.y + ey * t;
      let bestD = null, bestScore = 12;
      for (let d = -band; d <= band; d++) {
        const x = Math.round(px + nx * d), y = Math.round(py + ny * d);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const g = grad.ucharPtr(y, x)[0] * (1 - (0.35 * Math.abs(d)) / band);
        if (g > bestScore) { bestScore = g; bestD = d; }
      }
      samples.push({ t, d: bestD === null ? 0 : bestD }); // 못 찾으면 가이드 선(0)
    }
    // 직선 성분 강건 피팅 + 베지어 잔차(곡선)
    const fitLine = (pts) => {
      let st = 0, sd = 0, stt = 0, std2 = 0;
      for (const { t, d } of pts) { st += t; sd += d; stt += t * t; std2 += t * d; }
      const n = pts.length, den = n * stt - st * st;
      if (Math.abs(den) < 1e-9) return [0, 0];
      const b = (n * std2 - st * sd) / den;
      return [(sd - b * st) / n, b];
    };
    let lc = fitLine(samples);
    const res = samples.map(({ t, d }) => Math.abs(d - (lc[0] + lc[1] * t)));
    const med = [...res].sort((x, y) => x - y)[res.length >> 1] || 0;
    const kept = samples.filter((_, i) => res[i] <= Math.max(4, med * 3));
    if (kept.length >= 6) lc = fitLine(kept);
    const bez = fitBezierDeviation(kept.map(({ t, d }) => ({ t, d: d - (lc[0] + lc[1] * t) })));
    return { A, B, nx, ny, a: lc[0], b: lc[1], bez };
  };

  const top = snapEdge({ x: gx0, y: gy0 }, { x: gx1, y: gy0 });
  const bottom = snapEdge({ x: gx0, y: gy1 }, { x: gx1, y: gy1 });
  const left = snapEdge({ x: gx0, y: gy0 }, { x: gx0, y: gy1 });
  const right = snapEdge({ x: gx1, y: gy0 }, { x: gx1, y: gy1 });
  grad.delete();

  const lineOf = (e) => [
    { x: e.A.x + e.nx * e.a, y: e.A.y + e.ny * e.a },
    { x: e.B.x + e.nx * (e.a + e.b), y: e.B.y + e.ny * (e.a + e.b) },
  ];
  const xsect = (p, q, r2, s2) => {
    const d1x = q.x - p.x, d1y = q.y - p.y, d2x = s2.x - r2.x, d2y = s2.y - r2.y;
    const den = d1x * d2y - d1y * d2x;
    if (Math.abs(den) < 1e-9) return null;
    const u = ((r2.x - p.x) * d2y - (r2.y - p.y) * d2x) / den;
    return { x: p.x + u * d1x, y: p.y + u * d1y };
  };
  const [t0, t1] = lineOf(top), [b0, b1] = lineOf(bottom);
  const [l0, l1] = lineOf(left), [r0, r1] = lineOf(right);
  const tl = xsect(t0, t1, l0, l1) || { x: gx0, y: gy0 };
  const tr = xsect(t0, t1, r0, r1) || { x: gx1, y: gy0 };
  const bl = xsect(b0, b1, l0, l1) || { x: gx0, y: gy1 };
  const br = xsect(b0, b1, r0, r1) || { x: gx1, y: gy1 };
  const quad = { tl, tr, bl, br };
  if (!quadAnglesOk(quad)) return { quad: { tl: { x: gx0, y: gy0 }, tr: { x: gx1, y: gy0 }, bl: { x: gx0, y: gy1 }, br: { x: gx1, y: gy1 } }, curves: null };

  const mkCurve = (edge, A, B) => {
    if (!edge.bez) return null;
    const ex = B.x - A.x, ey = B.y - A.y;
    const L = Math.hypot(ex, ey) || 1;
    const nx = -ey / L, ny = ex / L;
    let maxDev = 0;
    for (let i = 0; i <= 16; i++) maxDev = Math.max(maxDev, Math.abs(edge.bez(i / 16)));
    // 책 촬영에서는 곡선일 확률이 높음 — 문턱을 낮춰 웬만하면 곡선으로 채택
    if (maxDev < Math.max(1.5, L * 0.005)) return null;
    return Array.from({ length: CURVE_SAMPLES }, (_, i) => {
      const t = i / (CURVE_SAMPLES - 1);
      const d = edge.bez(t);
      return { x: A.x + ex * t + nx * d, y: A.y + ey * t + ny * d };
    });
  };
  const cT = mkCurve(top, tl, tr), cB = mkCurve(bottom, bl, br);
  const cL = null, cR = null; // 책 좌우 변은 직선 고정 (도메인 지식)
  const curves = (cT || cB || cL || cR) ? {
    top: cT || sampleLine(tl, tr, CURVE_SAMPLES),
    bottom: cB || sampleLine(bl, br, CURVE_SAMPLES),
    left: cL || sampleLine(tl, bl, CURVE_SAMPLES),
    right: cR || sampleLine(tr, br, CURVE_SAMPLES),
  } : null;
  return { quad, curves };
}

/* 사각형 bbox와 가이드 영역의 IoU — 자동 감지가 가이드와 동떨어졌는지 판정 */
function bboxIouWithGuide(quad, W, H) {
  const xs = [quad.tl.x, quad.tr.x, quad.br.x, quad.bl.x];
  const ys = [quad.tl.y, quad.tr.y, quad.br.y, quad.bl.y];
  const ax0 = Math.min(...xs), ax1 = Math.max(...xs), ay0 = Math.min(...ys), ay1 = Math.max(...ys);
  const gx0 = W * GUIDE_INSET, gx1 = W * (1 - GUIDE_INSET), gy0 = H * GUIDE_INSET, gy1 = H * (1 - GUIDE_INSET);
  const ix = Math.max(0, Math.min(ax1, gx1) - Math.max(ax0, gx0));
  const iy = Math.max(0, Math.min(ay1, gy1) - Math.max(ay0, gy0));
  const inter = ix * iy;
  const uni = (ax1 - ax0) * (ay1 - ay0) + (gx1 - gx0) * (gy1 - gy0) - inter;
  return uni > 0 ? inter / uni : 0;
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

    const found = findDocQuad(c, 0.15, !page.spreadSide); // 반쪽은 책등 쪽이 경계에 닿으므로 경계 페널티 없음
    let corners = found ? found.quad : null;
    let curves = found ? (found.curves || extractCurves(found.contour, found.quad)) : null;

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

    // 펼침면 반쪽: 책등 쪽 변 = 캔버스 경계(중앙 고정선)로 고정, 바깥 변·상하는 감지값(없으면 6% 인셋)
    if (page.spreadSide) {
      const W = c.width, H = c.height;
      const gy0 = H * GUIDE_INSET, gy1 = H * (1 - GUIDE_INSET);
      if (!corners) corners = { tl: { x: 0, y: gy0 }, tr: { x: W, y: gy0 }, br: { x: W, y: gy1 }, bl: { x: 0, y: gy1 } };
      corners = { tl: { ...corners.tl }, tr: { ...corners.tr }, br: { ...corners.br }, bl: { ...corners.bl } };
      if (page.spreadSide === 'left') { corners.tr.x = W; corners.br.x = W; }
      else { corners.tl.x = 0; corners.bl.x = 0; }
      if (curves) { if (page.spreadSide === 'left') curves.right = null; else curves.left = null; }
    } else if (page.fromCamera && state.cvReady) {
      const iou = corners ? bboxIouWithGuide(corners, c.width, c.height) : 0;
      if (iou < 0.45) {
        const g = guideAnchoredQuad(c);
        if (g) { corners = g.quad; curves = g.curves; }
      }
    }

    if (corners && page.fromCamera && !page.spreadSide) {
      corners = enforceLeftGuide(corners, c.width, c.height); // 빨간 기준선 = 왼쪽 경계 정답
      if (curves && curves.left) curves.left = null;
    }
    if (corners) {
      const up = (p) => ({ x: p.x / scale, y: p.y / scale }); // 감지 좌표 → 원본 좌표
      page.corners = { tl: up(corners.tl), tr: up(corners.tr), br: up(corners.br), bl: up(corners.bl) };
      page.curves = curves ? mapCurvePoints(curves, up) : null;
      page.thumbDirty = true;
      persistPage(page);
      await fitModelForPage(page, c, scale); // 앵커 확보 → 페이지 모델 피팅 (수 초, UI 양보하며)
    }
    persistPage(page);
  } catch (e) {
    console.warn('detectCorners 실패', e);
  }
}

/* 문서 후보의 내각이 직각에 근사한지 (원근 기울기 감안해 55°~125° 허용) */
function quadAnglesOk(q) {
  const pts = [q.tl, q.tr, q.br, q.bl];
  for (let i = 0; i < 4; i++) {
    const p = pts[(i + 3) % 4], c = pts[i], n = pts[(i + 1) % 4];
    const v1x = p.x - c.x, v1y = p.y - c.y, v2x = n.x - c.x, v2y = n.y - c.y;
    const dot = v1x * v2x + v1y * v2y;
    const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
    const ang = (Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180) / Math.PI;
    if (ang < 55 || ang > 125) return false;
  }
  return true;
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
   모델 기반 평탄화 (pagemodel.js 엔진)
   앵커(가이드/자동감지/수동 모서리) → 페이지 모델 피팅(1단계 엣지, 2단계 글줄 수평)
   → 원본 해상도 리맵 → 3단계 글줄 직교화 → 테두리 트림
   ============================================================ */
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

/* 피팅은 수 초 걸리므로 시드 사이마다 이벤트 루프에 양보 (카메라 프리뷰가 멈추지 않게) */
async function fitPageModelAsync(canvas, anchors) {
  const W = canvas.width, H = canvas.height;
  const field = pmBuildField(canvas);
  try {
    const xs = [anchors.tl.x, anchors.tr.x, anchors.br.x, anchors.bl.x];
    const ys = [anchors.tl.y, anchors.tr.y, anchors.br.y, anchors.bl.y];
    const bbox = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    const P0 = pmAlignToQuad(anchors, W, H, pmInit(bbox, W, H)).P;
    const guide = { ...bbox, anchorC: anchors, slack: 0.01 * Math.max(W, H), w: 20 };
    let best = null;
    for (const s of PM_SEEDS) {
      const r = pmFit(field, W, H, guide, { ...P0, ...s });
      if (!best || r.score > best.score) best = r;
      await yieldUI();
    }
    const flip = pmFit(field, W, H, guide, pmFlipCurl(best.P));
    if (flip.score > best.score) best = flip;
    for (const sc of [0.25, 0.08, 0.03]) {
      const r = pmFit(field, W, H, guide, best.P, sc);
      if (r.score > best.score) best = r;
      await yieldUI();
    }
    // 2단계: 외곽은 고정하고 글줄 수평으로 자세 모호성(초점·요·비틀림·곡률 교환) 해소
    const g2 = { anchorPts: pmOutline(best.P, W, H), slackPts: 0.003 * Math.max(W, H), wPts: 60, rowW: 300 };
    let cur = { P: { ...best.P }, score: pmScore(best.P, field, W, H, g2) };
    for (const sc of [0.5, 0.2, 0.08]) {
      const r = pmFit(field, W, H, g2, cur.P, sc);
      if (r.score > cur.score) cur = r;
      await yieldUI();
    }
    return { P: cur.P, W, H };
  } finally {
    field.grayMat.delete();
  }
}

async function makeDetectCanvas(page) {
  const bmp = await createImageBitmap(page.blob);
  const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return { canvas: c, scale };
}

/* page.corners(원본 좌표)를 앵커로 모델 피팅 → page.model. 같은 페이지에 새 요청이 오면 이전 결과는 버림 */
async function fitModelForPage(page, canvas, scale) {
  if (!page.corners || !state.cvReady) { page.model = null; return; }
  const seq = (page._modelSeq = (page._modelSeq || 0) + 1);
  const dn = (p) => ({ x: p.x * scale, y: p.y * scale });
  const anchors = { tl: dn(page.corners.tl), tr: dn(page.corners.tr), br: dn(page.corners.br), bl: dn(page.corners.bl) };
  try {
    const model = await fitPageModelAsync(canvas, anchors);
    if (seq !== page._modelSeq) return;
    page.model = model;
  } catch (e) {
    console.warn('모델 피팅 실패', e);
    if (seq === page._modelSeq) page.model = null;
  }
  page.thumbDirty = true;
  persistPage(page);
}

/* 모델로 평탄화: 모델은 감지 캔버스(≤1000px) 좌표, 리맵은 입력 해상도(K배)로 수행 */
function warpModel(src, model, opts) {
  const { P } = model;
  const K = src.width / model.W;
  const cs = [pmProject(P, 0, 0, model.W, model.H), pmProject(P, 1, 0, model.W, model.H),
              pmProject(P, 1, 1, model.W, model.H), pmProject(P, 0, 1, model.W, model.H)];
  if (cs.some((p) => !p)) throw new Error('model corners invalid');
  const ys = cs.map((p) => p[1]);
  let outH = Math.round((Math.max(...ys) - Math.min(...ys)) * K);
  let outW = Math.round(outH * pmFlatAspect(P));
  const cap = 8e6 / Math.max(1, outW * outH); // 리맵 테이블 메모리 보호
  if (cap < 1) { outW = Math.round(outW * Math.sqrt(cap)); outH = Math.round(outH * Math.sqrt(cap)); }
  outW = Math.max(24, outW); outH = Math.max(24, outH);
  const rm = pmBuildRemap(P, model.W, model.H, outW, outH);
  for (let i = 0; i < rm.mapX.length; i++) { rm.mapX[i] *= K; rm.mapY[i] *= K; }
  const srcM = cv.imread(src);
  let dst = new cv.Mat();
  const mX = cv.matFromArray(outH, outW, cv.CV_32FC1, rm.mapX);
  const mY = cv.matFromArray(outH, outW, cv.CV_32FC1, rm.mapY);
  cv.remap(srcM, dst, mX, mY, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  mX.delete(); mY.delete(); srcM.delete();
  if (opts.textRect) {
    // 1) 전역 기울기: 괘선·글줄의 공통 기울기로 내용 전체 회전 (도형 보존)
    let g = new cv.Mat(); cv.cvtColor(dst, g, cv.COLOR_RGBA2GRAY);
    const ang = pmDeskewAngle(g, outW, outH);
    if (Math.abs(ang) > 0.05 && Math.abs(ang) < 12) {
      const r = pmRotateMat(dst, ang);
      dst.delete(); dst = r;
      g.delete(); g = new cv.Mat(); cv.cvtColor(dst, g, cv.COLOR_RGBA2GRAY);
    }
    // 2) 남은 휨만 직교화
    const rt = pmTextRectifyMaps(g, outW, outH, !!opts.marginFix);
    g.delete();
    if (rt) {
      const mXr = cv.matFromArray(outH, outW, cv.CV_32FC1, rt.mapX);
      const mYr = cv.matFromArray(outH, outW, cv.CV_32FC1, rt.mapY);
      const d2 = new cv.Mat();
      cv.remap(dst, d2, mXr, mYr, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      dst.delete(); mXr.delete(); mYr.delete();
      dst = d2;
    }
  }
  const g2 = new cv.Mat(); cv.cvtColor(dst, g2, cv.COLOR_RGBA2GRAY);
  const tb = pmTrimDarkBorders(g2.data, outW, outH);
  g2.delete();
  const roi = dst.roi(new cv.Rect(tb.x0, tb.y0, tb.x1 - tb.x0, tb.y1 - tb.y0));
  const out = document.createElement('canvas');
  cv.imshow(out, roi);
  roi.delete(); dst.delete();
  return out;
}

/* ============================================================
   손가락 제거 — 종이색 채우기 (PatchMatch류 내용 합성은 가려진 글자를 '지어내므로' 스캐너엔 부적합)
   검출: YCrCb 피부색 ∧ 페이지 테두리 접촉 ∧ 면적 0.08~20% ∧ 종이보다 확연히 어두움(누런 종이 오검출 방지)
   채움: 1/4 축소본에서 Telea 인페인팅으로 주변 종이색을 끌어와 원크기로 올린 뒤, 경계를 부드럽게 합성
   ============================================================ */
function removeFingers(canvas) {
  const W = canvas.width, H = canvas.height;
  if (W < 64 || H < 64) return false;
  const src = cv.imread(canvas);
  const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const ycc = new cv.Mat(); cv.cvtColor(rgb, ycc, cv.COLOR_RGB2YCrCb);
  const lo = new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(0, 133, 77));
  const hi = new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(255, 180, 135));
  const mask = new cv.Mat(); cv.inRange(ycc, lo, hi, mask);
  lo.delete(); hi.delete(); ycc.delete();
  const k5 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
  const k9 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k5);
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k9);
  // 종이 밝기: 그레이 70퍼센타일(글자 제외)
  const gray = new cv.Mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const gd = gray.data; const samp = [];
  for (let i = 0; i < gd.length; i += 97) samp.push(gd[i]);
  samp.sort((a, b) => a - b);
  const paper = samp[Math.floor(samp.length * 0.7)];
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(mask, labels, stats, cents, 8, cv.CV_32S);
  const keep = cv.Mat.zeros(H, W, cv.CV_8U);
  const lab = labels.data32S; const md = mask.data;
  let kept = 0;
  const dbg = { W, H, paper, comps: [] };
  for (let i = 1; i < n; i++) {
    const x = stats.intAt(i, cv.CC_STAT_LEFT), y = stats.intAt(i, cv.CC_STAT_TOP);
    const w = stats.intAt(i, cv.CC_STAT_WIDTH), h = stats.intAt(i, cv.CC_STAT_HEIGHT);
    const area = stats.intAt(i, cv.CC_STAT_AREA);
    const touches = x <= 1 || y <= 1 || x + w >= W - 1 || y + h >= H - 1;
    let sum = 0, c = 0;
    for (let yy = y; yy < y + h; yy += 2) for (let xx = x; xx < x + w; xx += 2) { const j = yy * W + xx; if (lab[j] === i) { sum += gd[j]; c++; } }
    const mean = c ? sum / c : 0;
    if (area > W * H * 0.0003) dbg.comps.push({ x, y, w, h, areaPct: +(area / (W * H) * 100).toFixed(2), touches, mean: Math.round(mean) });
    if (!touches || area < W * H * 0.0008 || area > W * H * 0.2) continue;
    if (!c || mean > paper - 15) continue;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const j = yy * W + xx; if (lab[j] === i) keep.data[j] = 255; }
    kept++;
  }
  labels.delete(); stats.delete(); cents.delete(); mask.delete(); gray.delete();
  state.lastFingerDbg = dbg;
  if (!kept) { src.delete(); rgb.delete(); keep.delete(); k5.delete(); k9.delete(); return false; }
  // 경계 여유: 손가락 가장자리 그림자까지 포함
  const kd = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(Math.max(7, Math.round(W * 0.012)) | 1, Math.max(7, Math.round(W * 0.012)) | 1));
  cv.dilate(keep, keep, kd);
  // 1/4 축소에서 인페인팅
  const ds = 0.25, sw = Math.max(16, Math.round(W * ds)), sh = Math.max(16, Math.round(H * ds));
  const smallRgb = new cv.Mat(); cv.resize(rgb, smallRgb, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const smallMask = new cv.Mat(); cv.resize(keep, smallMask, new cv.Size(sw, sh), 0, 0, cv.INTER_NEAREST);
  cv.dilate(smallMask, smallMask, k5);
  const filledS = new cv.Mat(); cv.inpaint(smallRgb, smallMask, filledS, 5, cv.INPAINT_TELEA); // (src, mask, dst, radius, flags)
  const filled = new cv.Mat(); cv.resize(filledS, filled, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  // 부드러운 합성
  const alpha = new cv.Mat(); cv.GaussianBlur(keep, alpha, new cv.Size(0, 0), Math.max(2, W * 0.004));
  const sd = src.data, fd = filled.data, ad = alpha.data;
  for (let i = 0, j = 0, q = 0; i < W * H; i++, j += 4, q += 3) {
    const a = ad[i] / 255; if (a <= 0) continue;
    sd[j] = sd[j] * (1 - a) + fd[q] * a;
    sd[j + 1] = sd[j + 1] * (1 - a) + fd[q + 1] * a;
    sd[j + 2] = sd[j + 2] * (1 - a) + fd[q + 2] * a;
  }
  cv.imshow(canvas, src);
  src.delete(); rgb.delete(); keep.delete(); k5.delete(); k9.delete(); kd.delete(); smallRgb.delete(); smallMask.delete(); filledS.delete(); filled.delete(); alpha.delete();
  return true;
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
        if (page.model) {
          // 페이지 모델(곡면+자세) 리맵 → 글줄 직교화 → 트림
          src = warpModel(src, page.model, { textRect: page.textRect !== false, marginFix: page.marginFix !== false });
        } else if (page.curves) {
          const cs = mapCurvePoints(page.curves, dn);
          src = warpCurved(src, sc, cs); // 곡선 경계 메시 워프 — 책 곡면까지 폄
        } else {
          src = warpPerspective(src, sc);
        }
      } catch (e) {
        console.warn('warp 실패', e);
        try { src = warpPerspective(src, sc); } catch (e2) { /* 원본 유지 */ }
      }
    }

    // 1.5) 손가락 제거 (종이색 채우기) — 페이지 테두리에 걸친 피부색 영역만
    if (state.cvReady && page.fingerFix !== false) {
      try { removeFingers(src); } catch (e) { console.warn('손가락 제거 실패', e); }
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
  if (filter === 'magic' && state.cvReady) { applyMagic(canvas, 0.35); applyBC(canvas, bright, contrast); return; }
  if (filter === 'sharpen' && state.cvReady) { applyMagic(canvas, 0.9); applyBC(canvas, bright, contrast); return; }

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

/* 매직컬러(OpenCV): 국소 조명 정규화(플랫필드) → 전역 곡선 → 언샤프.
   책 페이지의 책등 그림자·불균일 조명을 지우고 종이를 균일한 흰색으로 만들되, 채널 공통 게인이라 색조는 유지.
   배경(조명)은 1/4 축소본에서 큰 닫힘 연산(글자 제거)+블러로 추정. 게인 상한 2.0 — 큰 그림·사진이 탈색되지 않게 */
function applyMagic(canvas, sharpenAmount = 0.35) {
  const W = canvas.width, H = canvas.height;
  const src = cv.imread(canvas);
  const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const ds = Math.min(1, 400 / Math.max(W, H));
  const sw = Math.max(8, Math.round(W * ds)), sh = Math.max(8, Math.round(H * ds));
  const small = new cv.Mat(); cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const k = (Math.max(9, Math.round(Math.min(sw, sh) / 18)) | 1);
  const kern = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k));
  const bgS = new cv.Mat(); cv.morphologyEx(small, bgS, cv.MORPH_CLOSE, kern);
  cv.GaussianBlur(bgS, bgS, new cv.Size(0, 0), k / 2);
  const bg = new cv.Mat(); cv.resize(bgS, bg, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  const d = src.data, b = bg.data, n = W * H;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const g = Math.min(2.0, 246 / Math.max(60, b[i]));
    const r = d[j] * g, gg = d[j + 1] * g, bb = d[j + 2] * g;
    d[j] = r > 255 ? 255 : r; d[j + 1] = gg > 255 ? 255 : gg; d[j + 2] = bb > 255 ? 255 : bb;
  }
  magicLUTApply(d); // 종이 화이트밸런스 + 섀도 컷 (전역)
  if (sharpenAmount > 0) {
    const blur = new cv.Mat(); cv.GaussianBlur(src, blur, new cv.Size(0, 0), 1.2);
    cv.addWeighted(src, 1 + sharpenAmount, blur, -sharpenAmount, 0, src);
    blur.delete();
  }
  cv.imshow(canvas, src);
  src.delete(); gray.delete(); small.delete(); kern.delete(); bgS.delete(); bg.delete();
}

/* 매직컬러(폴백, OpenCV 없을 때): 종이 흰색 기준 화이트밸런스 + 전 채널 공통 대비 곡선
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
  // 사용자가 고른 카메라 방향을 기억 — 기기에 따라 세로 요청에도 가로 스트림이 오는 경우, 매번 '방향'을 누르지 않게
  if (state.camFlip === undefined) state.camFlip = localStorage.getItem('ds_camFlip') === '1';
  let portrait = window.innerHeight >= window.innerWidth;
  if (state.camFlip) portrait = !portrait; // 사용자가 회전 버튼으로 방향을 뒤집은 경우
  return {
    facingMode: { ideal: 'environment' },
    width: { ideal: portrait ? 3000 : 4000 },
    height: { ideal: portrait ? 4000 : 3000 },
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
      const orientMismatch = () => {
        const st = track.getSettings();
        const screenLandscape = window.innerWidth > window.innerHeight;
        const vidLandscape = (st.width || 0) > (st.height || 0);
        return vidLandscape !== screenLandscape; // 화면은 세로인데 프레임이 가로(또는 그 반대)
      };
      const bad = () => {
        const st = track.getSettings();
        const lowRes = (st.width || 0) * (st.height || 0) < 1200 * 900;
        return lowRes || orientMismatch();
      };
      if (bad()) {
        try {
          await track.applyConstraints(camConstraints());
          await new Promise((r) => setTimeout(r, 300));
        } catch (e) { /* 재협상 미지원 기기 */ }
        if (bad() && !isRetry) {
          // 방향이 어긋나면 요청을 뒤집어 딱 한 번만 재시작 (세션당 1회 — 반복 재시작 루프 금지).
          // 성공하면 그 방향을 기억해 다음부터 처음부터 맞게 시작한다
          const flipNow = orientMismatch() && !state.camAutoFlipTried;
          stopCamera();
          await new Promise((r) => setTimeout(r, 150));
          if (flipNow) {
            state.camAutoFlipTried = true;
            state.camFlip = !state.camFlip;
            state.camAutoFlipPending = true;
          }
          return startCamera(true);
        }
      }
      if (state.camAutoFlipPending) {
        state.camAutoFlipPending = false;
        if (!orientMismatch()) {
          try { localStorage.setItem('ds_camFlip', state.camFlip ? '1' : '0'); } catch (e) { /* 저장 불가 환경 */ }
        }
      }
    }

    msg.classList.add('hidden');
    $('btn-shutter').disabled = false;
    setupTorchButton();
  } catch (e) {
    console.warn('camera error', e);
    $('btn-shutter').disabled = true;
    msg.querySelector('.loading-spinner')?.remove();
    msg.querySelector('p').innerHTML =
      '카메라를 사용할 수 없습니다.<br>권한을 허용했는지 확인하거나<br>아래 <b>불러오기</b>로 사진을 가져오세요.';
  }
}

/* 플래시(torch): 지원 기기(안드로이드 크롬)에서만 버튼 표시. 그림자·어두운 조명을 촬영 단계에서 줄인다 */
function setupTorchButton() {
  const btn = $('btn-torch');
  const track = state.stream ? state.stream.getVideoTracks()[0] : null;
  let caps = null;
  try { caps = track && track.getCapabilities ? track.getCapabilities() : null; } catch (e) { caps = null; }
  const ok = !!(caps && caps.torch);
  btn.classList.toggle('hidden', !ok);
  btn.classList.remove('on');
  state.torchOn = false;
}
async function toggleTorch() {
  const track = state.stream ? state.stream.getVideoTracks()[0] : null;
  if (!track) return;
  const next = !state.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: next }] });
    state.torchOn = next;
    $('btn-torch').classList.toggle('on', next);
  } catch (e) {
    toast('이 기기에서는 플래시를 켤 수 없습니다', { type: 'error' });
  }
}

/* 수평계: 폰을 페이지와 평행하게(화면이 하늘을 향해 수평) 들도록 유도 — 원근 왜곡·초점 불균일 감소.
   DeviceOrientation beta(앞뒤)·gamma(좌우) 기울기를 버블로 표시, 4° 이내면 초록 */
let levelStarted = false;
async function startLevelIndicator(fromGesture) {
  if (levelStarted) return;
  const D = window.DeviceOrientationEvent;
  if (!D) return;
  if (typeof D.requestPermission === 'function') { // iOS
    if (!fromGesture) return;
    try { if ((await D.requestPermission()) !== 'granted') return; } catch (e) { return; }
  }
  levelStarted = true;
  const el = $('level-ind'); const dot = el.querySelector('i');
  window.addEventListener('deviceorientation', (ev) => {
    if (ev.beta === null || ev.gamma === null) return;
    el.classList.remove('hidden'); // 센서 값이 실제로 올 때만 표시 (센서 없는 PC에선 숨김)
    const bx = Math.max(-20, Math.min(20, ev.gamma)), by = Math.max(-20, Math.min(20, ev.beta));
    dot.style.transform = 'translate(' + (bx * 0.9).toFixed(1) + 'px, ' + (by * 0.9).toFixed(1) + 'px)';
    el.classList.toggle('ok', Math.abs(ev.gamma) < 4 && Math.abs(ev.beta) < 4);
  });
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    $('cam').srcObject = null;
  }
}

/* 촬영 가이드: 카메라 영상(레터박스 안쪽)에 정확히 정렬된 기준 프레임.
   좌측 빨간 세로 점선 = 기준선, 네 모서리 꺾쇠 = 책 모서리를 맞추는 위치 */
const GUIDE_INSET = 0.06;

function updateGuidePosition() {
  const wrap = document.querySelector('.cam-wrap');
  const g = document.querySelector('.frame-guide');
  const video = $('cam');
  if (!wrap || !g) return;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const vw = video.videoWidth || 3, vh = video.videoHeight || 4;
  const fit = Math.min(cw / vw, ch / vh);
  const w = vw * fit, h = vh * fit;
  const ox = (cw - w) / 2, oy = (ch - h) / 2;
  g.style.left = `${ox + w * GUIDE_INSET}px`;
  g.style.top = `${oy + h * GUIDE_INSET}px`;
  g.style.width = `${w * (1 - 2 * GUIDE_INSET)}px`;
  g.style.height = `${h * (1 - 2 * GUIDE_INSET)}px`;
}

/* 방향 전환은 사용자가 회전 버튼으로 직접 제어 (자동 재시작은 기기별 무한 루프 위험으로 제거).
   여기서는 가이드 위치 갱신만 주기적으로 수행 */
function startOrientationWatchdog() {
  setInterval(updateGuidePosition, 1200);
}

/* 카메라 방향 수동 전환 — 미리보기가 가로/세로로 잘못 나올 때 사용자가 누름 */
async function flipCameraOrientation() {
  state.camFlip = !state.camFlip;
  try { localStorage.setItem('ds_camFlip', state.camFlip ? '1' : '0'); } catch (e) { /* 저장 불가 환경 */ }
  stopCamera();
  await new Promise((r) => setTimeout(r, 300));
  await startCamera();
  toast(state.camFlip ? '카메라 방향 전환됨' : '카메라 기본 방향', { duration: 1200 });
}

/* 실시간 문서 감지 오버레이 — 시간 평활(EMA)로 떨림 억제 + 안정 상태 표시 */
const liveDetect = { quad: null, poly: null, pending: null, hitStreak: 0, missStreak: 0,
  prevSmall: null, motion: 99, sharp: 0, sharpMax: 0, stillStreak: 0, readyStreak: 0, lastAutoAt: 0, sceneChanged: true, lastPolyForStill: null };

/* 프레임 품질 측정(유료 앱의 '흔들림·흐림 게이트'): 움직임 = 연속 프레임 평균 절대차(90px 축소),
   선명도 = 라플라시안 분산(감지 캔버스 그레이). 선명도는 절대값이 내용에 따라 달라 최근 최대값 대비로도 본다 */
function measureFrameQuality(work) {
  const w = 90, h = Math.max(8, Math.round((90 * work.height) / work.width));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.drawImage(work, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let motion = 99;
  if (liveDetect.prevSmall && liveDetect.prevSmall.length === g.length) {
    let sum = 0; for (let i = 0; i < g.length; i++) sum += Math.abs(g[i] - liveDetect.prevSmall[i]);
    motion = sum / g.length;
  }
  liveDetect.prevSmall = g;
  let sharp = 0;
  if (state.cvReady) {
    const src = cv.imread(work); const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const lap = new cv.Mat(); cv.Laplacian(gray, lap, cv.CV_64F);
    const mean = new cv.Mat(), std = new cv.Mat(); cv.meanStdDev(lap, mean, std);
    const sd = std.doubleAt(0, 0);
    sharp = sd * sd;
    src.delete(); gray.delete(); lap.delete(); mean.delete(); std.delete();
  }
  liveDetect.motion = motion; liveDetect.sharp = sharp;
  liveDetect.sharpMax = Math.max(sharp, liveDetect.sharpMax * 0.97); // 서서히 잊는 최근 최대
  if (motion > 12) liveDetect.sceneChanged = true; // 페이지를 넘기거나 크게 움직임 → 다음 자동 촬영 허용
}

/* 빨간 기준선 규칙(사용자 원칙: 책의 왼쪽 변은 항상 빨간 선에 맞춘다):
   - 왼쪽 경계는 기준선 왼쪽으로 절대 못 넘는다 (넘으면 책상·옆 책을 잡은 것)
   - 기준선 오른쪽 4% 이내면 기준선에 스냅, 좌측 하단 모서리는 빨간 꺾쇠(가이드 좌하단)에 스냅
   W,H = 해당 좌표계(감지 캔버스)의 크기 */
function enforceLeftGuide(q, W, H) {
  // ㄴ 규칙(사용자 원칙): 왼쪽 변 = 빨간 점선(x=gx0), 아래 변 = 좌하단 꺾쇠의 가로선(y=gy1).
  // 이 ㄴ 밖으로는 절대 인식하지 않고(초과 → 선으로), 선 근처(12% 이내)면 선에 스냅한다
  // "무조건 ㄴ에서 시작": 왼쪽 변은 항상 빨간 선, 아래 변은 항상 바닥선, 좌하단 모서리는 항상 ㄴ 꼭짓점.
  // 감지는 위쪽 변과 오른쪽 변만 정한다
  const gx0 = W * GUIDE_INSET, gy1 = H * (1 - GUIDE_INSET);
  const out = { tl: { ...q.tl }, tr: { ...q.tr }, br: { ...q.br }, bl: { ...q.bl } };
  out.tl.x = gx0; out.bl.x = gx0; out.bl.y = gy1; out.br.y = gy1;
  if (out.tl.y > gy1 - H * 0.2) out.tl.y = H * GUIDE_INSET;   // 위 변이 바닥에 붙을 만큼 망가졌으면 가이드 상단으로
  if (out.tr.x < gx0 + W * 0.2) out.tr.x = W * (1 - GUIDE_INSET); // 오른쪽 변이 왼쪽으로 무너졌으면 가이드 우측으로
  if (out.br.x < gx0 + W * 0.2) out.br.x = W * (1 - GUIDE_INSET);
  if (out.tr.y > gy1 - H * 0.2) out.tr.y = H * GUIDE_INSET;
  return out;
}
function clampPolyToGuide(poly, W, H) {
  const gx0 = W * GUIDE_INSET, gy1 = H * (1 - GUIDE_INSET);
  for (const p of poly) { if (p.x < gx0) p.x = gx0; if (p.y > gy1) p.y = gy1; }
  return poly;
}

/* 윤곽을 고정 개수 점(상·하 9, 좌·우 5)으로 재표본 — 프레임 간 1:1 대응이 되어 선 전체를 평활할 수 있다 */
function resamplePath(pts, n) {
  if (!pts || pts.length < 2) return null;
  const seg = [], cum = [0];
  for (let i = 1; i < pts.length; i++) { seg.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)); cum.push(cum[i - 1] + seg[i - 1]); }
  const L = cum[cum.length - 1] || 1;
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = (L * k) / (n - 1);
    let i = 1; while (i < cum.length - 1 && cum[i] < t) i++;
    const f = seg[i - 1] ? (t - cum[i - 1]) / seg[i - 1] : 0;
    out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f });
  }
  return out;
}
function outlinePolyline(q, curves) {
  const top = resamplePath(curves && curves.top ? curves.top : [q.tl, q.tr], 9);
  const right = resamplePath(curves && curves.right ? curves.right : [q.tr, q.br], 5);
  const bottom = resamplePath(curves && curves.bottom ? curves.bottom.slice().reverse() : [q.br, q.bl], 9);
  const left = resamplePath(curves && curves.left ? curves.left.slice().reverse() : [q.bl, q.tl], 5);
  return [...top, ...right.slice(1), ...bottom.slice(1), ...left.slice(1, -1)];
}
function polyMaxDist(a, b) {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y));
  return m;
}

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

      measureFrameQuality(work);
      const foundRes = findDocQuad(work, 0.15);
      const found = foundRes ? foundRes.quad : null;
      if (found) {
        const curves = foundRes.curves || extractCurves(foundRes.contour, foundRes.quad);
        const fixed = enforceLeftGuide(found, work.width, work.height);
        found.tl = fixed.tl; found.bl = fixed.bl;
        found.br = fixed.br;
        if (curves && curves.left) curves.left = null; // 왼쪽 변은 기준선(직선)
        const poly = clampPolyToGuide(outlinePolyline(found, curves), work.width, work.height);
        // 후보 방식이 바뀌어 윤곽이 멀리 점프하면 바로 따라가지 않고 같은 자리가 2번 연속 나올 때만 수용
        const jumpTol = 0.10 * Math.max(work.width, work.height);
        if (liveDetect.poly && liveDetect.hitStreak >= 2 && polyMaxDist(liveDetect.poly, poly) > jumpTol) {
          if (liveDetect.pending && polyMaxDist(liveDetect.pending, poly) < jumpTol * 0.5) {
            liveDetect.poly = poly; liveDetect.quad = found; liveDetect.pending = null; liveDetect.hitStreak = 1;
          } else {
            liveDetect.pending = poly; // 한 번 더 확인
          }
        } else {
          liveDetect.pending = null;
          liveDetect.hitStreak++;
          if (liveDetect.poly) {
            // 선 전체 EMA 평활(30%) + 데드밴드(0.4% 프레임 이하 움직임 무시) → 떨림 억제
            const a = 0.3, dead = 0.004 * Math.max(work.width, work.height);
            for (let i = 0; i < poly.length; i++) {
              const dx = poly[i].x - liveDetect.poly[i].x, dy = poly[i].y - liveDetect.poly[i].y;
              if (Math.hypot(dx, dy) < dead) continue;
              liveDetect.poly[i].x += dx * a; liveDetect.poly[i].y += dy * a;
            }
            for (const k of ['tl', 'tr', 'br', 'bl']) {
              liveDetect.quad[k].x += (found[k].x - liveDetect.quad[k].x) * a;
              liveDetect.quad[k].y += (found[k].y - liveDetect.quad[k].y) * a;
            }
          } else {
            liveDetect.poly = poly; liveDetect.quad = found;
          }
        }
        liveDetect.missStreak = 0;
      } else {
        liveDetect.hitStreak = 0;
        liveDetect.missStreak++;
        if (liveDetect.missStreak >= 4) { liveDetect.quad = null; liveDetect.poly = null; liveDetect.pending = null; } // 잠깐 놓친 건 유지
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
        const color = stable ? 'rgba(74, 222, 128, 0.95)' : 'rgba(74, 222, 128, 0.45)';
        octx.beginPath();
        {
          // 평활된 윤곽 폴리라인(곡선 포함, 점 개수 고정) 그대로 그림
          const path = liveDetect.poly.map(map);
          octx.moveTo(path[0][0], path[0][1]);
          for (let i = 1; i < path.length; i++) octx.lineTo(path[i][0], path[i][1]);
        }
        octx.closePath();
        octx.fillStyle = stable ? 'rgba(74, 222, 128, 0.10)' : 'rgba(74, 222, 128, 0.04)';
        octx.strokeStyle = color;
        octx.lineWidth = 2.5;
        octx.fill();
        octx.stroke();
        // 모서리 점
        octx.fillStyle = color;
        for (const k of ['tl', 'tr', 'br', 'bl']) {
          const [x, y] = map(liveDetect.quad[k]);
          octx.beginPath();
          octx.arc(x, y, 5, 0, Math.PI * 2);
          octx.fill();
        }
      }
      // 정지 판정: 윤곽이 프레임 간 0.8% 이내로 머무름 + 화면 움직임 작음
      const frameMax = Math.max(work.width, work.height);
      if (liveDetect.poly && liveDetect.lastPolyForStill && polyMaxDist(liveDetect.poly, liveDetect.lastPolyForStill) < 0.008 * frameMax && liveDetect.motion < 4) liveDetect.stillStreak++;
      else liveDetect.stillStreak = 0;
      liveDetect.lastPolyForStill = liveDetect.poly ? liveDetect.poly.map((p) => ({ x: p.x, y: p.y })) : null;
      const blurry = liveDetect.sharp < Math.max(40, 0.55 * liveDetect.sharpMax);
      const moving = liveDetect.motion >= 4;
      const ready = stable && liveDetect.hitStreak >= 4 && liveDetect.stillStreak >= 2 && !blurry && !moving;
      liveDetect.readyStreak = ready ? liveDetect.readyStreak + 1 : 0;
      if (hint) {
        if (stable && (moving || blurry)) {
          hint.textContent = moving ? '흔들림 — 잠시 멈춰 주세요' : '초점이 흐림 — 거리를 조정해 주세요';
          hint.className = 'detect-hint warn';
        } else if (ready && state.autoCapture) {
          hint.textContent = liveDetect.sceneChanged ? '자동 촬영 준비…' : '다음 페이지로 넘겨 주세요';
          hint.className = 'detect-hint ok';
        } else if (stable) {
          hint.textContent = '문서 인식됨 — 촬영하세요';
          hint.className = 'detect-hint ok';
        } else {
          hint.textContent = '문서를 화면에 맞춰 주세요';
          hint.className = 'detect-hint';
        }
      }
      // 자동 촬영: 준비 상태가 약 1초(3프레임) 유지 + 쿨다운 + 장면 변화(페이지 넘김) 이후에만
      if (state.autoCapture && ready && liveDetect.readyStreak >= 3 && liveDetect.sceneChanged
          && !state.capturing && Date.now() - liveDetect.lastAutoAt > 2500) {
        liveDetect.lastAutoAt = Date.now();
        liveDetect.sceneChanged = false;
        liveDetect.readyStreak = 0;
        capture();
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

  if (state.capturing) { state.pendingCapture = true; return; } // 연속 셔터: 버리지 않고 현재 촬영 뒤 한 번 더
  state.capturing = true;
  try {
    const track = state.stream?.getVideoTracks()[0];
    const { canvas: c, source } = await grabBestStill(video, track);
    state.lastCapture = { source, w: c.width, h: c.height };
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
    await addCapturedBlob(blob, false, true);
  } finally {
    state.capturing = false;
    if (state.pendingCapture) { state.pendingCapture = false; setTimeout(capture, 50); }
  }
}

/* 정지화상 우선 촬영(유료 앱 방식): ImageCapture.takePhoto()는 영상 프레임보다 훨씬 높은
   사진 해상도를 준다(안드로이드 크롬). 단 기기에 따라 방향·화각이 프레임과 다를 수 있으므로
   프레임과 대조(방향 맞춤 + 정규화 상관 ≥ 0.85)해 통과할 때만 채택, 아니면 프레임 사용 */
function drawVideoFrame(video) {
  const c = document.createElement('canvas');
  const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c;
}
function thumbGray(src, w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
}
function ncc(a, b) {
  let ma = 0, mb = 0; const n = a.length;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / (Math.sqrt(saa * sbb) || 1);
}
function rotateBitmap(bmp, deg) {
  const swap = deg % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = swap ? bmp.height : bmp.width; c.height = swap ? bmp.width : bmp.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  return c;
}
async function grabBestStill(video, track) {
  const frame = drawVideoFrame(video);
  if (!window.ImageCapture || !track) return { canvas: frame, source: 'frame' };
  try {
    const ic = new ImageCapture(track);
    const blob = await Promise.race([ic.takePhoto(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    const bmp = await createImageBitmap(blob);
    const frameLandscape = frame.width > frame.height;
    const cands = (bmp.width > bmp.height) === frameLandscape ? [rotateBitmap(bmp, 0)] : [rotateBitmap(bmp, 90), rotateBitmap(bmp, -90)];
    bmp.close();
    const tw = 48, th = Math.max(8, Math.round((48 * frame.height) / frame.width));
    const ref = thumbGray(frame, tw, th);
    let best = null, bestR = -1;
    for (const cand of cands) { const r = ncc(ref, thumbGray(cand, tw, th)); if (r > bestR) { bestR = r; best = cand; } }
    const gain = Math.max(best.width, best.height) / Math.max(frame.width, frame.height);
    if (bestR < 0.85 || gain < 1.05) return { canvas: frame, source: `frame(photo r=${bestR.toFixed(2)} g=${gain.toFixed(2)})` };
    // 보관 해상도로 축소
    const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(best.width, best.height));
    if (scale < 1) {
      const c = document.createElement('canvas');
      c.width = Math.round(best.width * scale); c.height = Math.round(best.height * scale);
      c.getContext('2d').drawImage(best, 0, 0, c.width, c.height);
      return { canvas: c, source: 'photo' };
    }
    return { canvas: best, source: 'photo' };
  } catch (e) {
    return { canvas: frame, source: 'frame(' + (e && e.message ? e.message : 'err') + ')' };
  }
}

/* 촬영/불러오기 공통 진입점 — 펼침면 모드면 좌/우 분할 시도
   fromCamera=true면 가이드 프레임에 맞춰 찍었다고 보고 가이드 기준 보정을 허용 */
async function addCapturedBlob(blob, silent, fromCamera = false) {
  if (state.spreadMode) {
    if (!state.cvReady) {
      if (!silent) toast('보정 엔진 로딩 후 분할 가능 — 한 장으로 저장됨', { type: 'error' });
    } else if (await addSpreadPages(blob, silent)) {
      return;
    } else if (!silent) {
      toast('페이지 감지 실패 — 한 장으로 저장됨', { type: 'error' });
    }
  }
  await addPage(blob, silent, false, fromCamera);
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
    const L = findDocQuad(halfCanvas(0, mid), 0.18, false);       // 절반 캔버스는 경계 접촉이 정상
    const R = findDocQuad(halfCanvas(mid, W - mid), 0.18, false);
    // 페이지 안쪽 변이 중앙선 근처에 닿아 있어야 진짜 펼침면 페이지
    if (L && Math.max(L.quad.tr.x, L.quad.br.x) > mid * 0.75) {
      out.push({ quad: L.quad, contour: L.contour, curves: L.curves || null });
    }
    if (R) {
      const sh = (p) => ({ x: p.x + mid, y: p.y });
      const q = { tl: sh(R.quad.tl), tr: sh(R.quad.tr), br: sh(R.quad.br), bl: sh(R.quad.bl) };
      if (Math.min(q.tl.x, q.bl.x) < mid + (W - mid) * 0.25) {
        out.push({ quad: q, contour: R.contour.map(sh), curves: R.curves ? mapCurvePoints(R.curves, sh) : null });
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
    // 세로형 프레임이면 펼침면이 아니라 한 페이지(화면 미회전) — 자르지 않음
    if (bmp.height > bmp.width * 1.15) {
      bmp.close();
      if (!silent) toast('가로 프레임이 아니라 분할하지 않았어요 — 펼침면은 폰을 가로로 돌려 촬영해 주세요', { type: 'error', duration: 3500 });
      return false;
    }
    // 책등 = 화면 중앙 빨간 선(사용자가 맞춤) → 원본 해상도에서 정확히 반으로 분할.
    // 각 반쪽은 일반 페이지와 같은 경로(자동 감지 → 페이지 모델 피팅 → 평탄화·직교화)를 타되,
    // 책등 쪽 변은 캔버스 경계에 고정된다(spreadSide)
    const half = (x0, w) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, x0, 0, w, bmp.height, 0, 0, w, bmp.height);
      return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
    };
    const mid = Math.round(bmp.width / 2);
    const lb = await half(0, mid);
    const rb = await half(mid, bmp.width - mid);
    bmp.close();
    await addPage(lb, true, false, true, 'left');
    await addPage(rb, true, false, true, 'right');
    if (!silent) toast(`펼침면 분할 → ${state.pages.length - 1}·${state.pages.length}페이지`, { type: 'success', duration: 1600 });
    return true;
  } catch (e) {
    console.warn('addSpreadPages 실패', e);
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
async function addPage(blob, silent = false, preprocessed = false, fromCamera = false, spreadSide = null) {
  const page = {
    spreadSide, // 'left' | 'right' — 펼침면 반쪽: 책등 쪽 변은 캔버스 경계에 고정
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
    blob,
    corners: null,
    curves: null,
    fromCamera,
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
  $('opt-chips').classList.remove('hidden');
  $('opt-textrect').classList.toggle('hidden', !page.model);
  $('opt-margin').classList.toggle('hidden', !page.model);
  $('opt-textrect').classList.toggle('active', page.textRect !== false);
  $('opt-margin').classList.toggle('active', page.marginFix !== false);
  $('opt-finger').classList.toggle('active', page.fingerFix !== false);
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
  page.model = null; // 앵커가 바뀌었으니 모델 재피팅 (그동안은 원근/곡선 보정으로 표시)
  closeCornerModal();
  markDirtyAndRedraw(page);
  toast(useFull ? '전체 영역으로 설정됨' : '문서 영역이 적용됨', { type: 'success', duration: 1500 });
  if (!useFull && state.cvReady) {
    makeDetectCanvas(page)
      .then(({ canvas, scale }) => fitModelForPage(page, canvas, scale))
      .then(() => {
        if (page.model && currentPage() === page && state.screen === 'edit') redrawEdit();
        else if (state.screen === 'gallery') renderGallery();
      })
      .catch((e) => console.warn('모델 재피팅 실패', e));
  }
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
  $('btn-shutter').onclick = () => { startLevelIndicator(true); capture(); };
  // 자동 촬영 토글(기억) / 플래시 / 수평계
  state.autoCapture = localStorage.getItem('ds_auto') === '1';
  $('btn-auto').classList.toggle('on', state.autoCapture);
  $('btn-auto').onclick = () => {
    state.autoCapture = !state.autoCapture;
    try { localStorage.setItem('ds_auto', state.autoCapture ? '1' : '0'); } catch (e) { /* 저장 불가 */ }
    $('btn-auto').classList.toggle('on', state.autoCapture);
    liveDetect.sceneChanged = true; liveDetect.readyStreak = 0;
    startLevelIndicator(true);
    toast(state.autoCapture ? '자동 촬영 켜짐 — 문서가 안정되면 찍습니다' : '자동 촬영 꺼짐', { duration: 1600 });
  };
  $('btn-torch').onclick = toggleTorch;
  startLevelIndicator(false); // 안드로이드는 권한 없이 시작
  $('btn-cam-rotate').onclick = flipCameraOrientation;
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
  // 평탄화 옵션 (책마다 달라 사용자 선택): 글줄 직교화 / 좌측 정렬선 수직 보정
  const toggleOpt = (key, el) => {
    const p = currentPage();
    if (!p) return;
    p[key] = p[key] === false;
    el.classList.toggle('active', p[key] !== false);
    markDirtyAndRedraw(p);
  };
  $('opt-textrect').onclick = () => toggleOpt('textRect', $('opt-textrect'));
  $('opt-margin').onclick = () => toggleOpt('marginFix', $('opt-margin'));
  $('opt-finger').onclick = () => toggleOpt('fingerFix', $('opt-finger'));
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
      const lc = state.lastCapture ? ` / 최근촬영 ${state.lastCapture.source} ${state.lastCapture.w}×${state.lastCapture.h}` : '';
      toast(`카메라 ${st.width || '?'}×${st.height || '?'} / 표시 ${v.videoWidth}×${v.videoHeight} / 화면 ${window.innerWidth}×${window.innerHeight}${lc}`, { duration: 7000 });
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
  startOrientationWatchdog();
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
