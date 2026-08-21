/* vFlat 특허(US10991081B1) 방식의 파라미터 페이지 모델 — 무학습 반복 최적화 구현
   모델: 원통형으로 말린 페이지(단면 = 끝점 0 고정 3차 베지어, 제어값 z1·z2)
         + 핀홀 카메라(pitch/yaw/roll, tx/ty, 초점 F 고정) + 페이지 크기(pw, ph)
   안내선 = 이 모델의 투영 외곽선 → 물리적으로 가능한 책 모양만 허용됨 */
'use strict';

/* 실험으로 확정한 기본 가중치 (window.PM_* 로 오버라이드 가능 — 채점 하네스용) */
const PM_DEFAULTS = { PM_CURV_W: 150, PM_TW_W: 900, PM_ROW_W: 30, PM_SOFT_W: 1.0 };
function pmFlag(name) {
  if (typeof window !== 'undefined' && window[name] !== undefined) return window[name];
  return PM_DEFAULTS[name];
}

/* 단면 곡률: z(u) = 3(1-u)²u·z1 + 3(1-u)u²·z2  (페이지 폭 단위) */
function pmBez(u, z1, z2) {
  const iu = 1 - u;
  return 3 * iu * iu * u * z1 + 3 * iu * u * u * z2;
}

/* 페이지 파라미터 좌표 (u,v)∈[0,1]² → 화면 픽셀 좌표 */
function pmProject(P, u, v, W, H) {
  const { z1, z2, rx, ry, rz, tx, ty, pw, ph } = P;
  const F = P.F;
  // 페이지 좌표계 (원통: z는 u에만 의존)
  let X = (u - 0.5) * pw;
  let Y = (v - 0.5) * ph;
  // 로프트: 위(v=0)와 아래(v=1)의 곡률이 다를 수 있음 (z1b/z2b 없으면 원통과 동일)
  const zb1 = P.z1b === undefined ? z1 : P.z1b;
  const zb2 = P.z2b === undefined ? z2 : P.z2b;
  let Z = ((1 - v) * pmBez(u, z1, z2) + v * pmBez(u, zb1, zb2)) * pw;
  // 비틀림(쌍곡포물면): 네 모서리가 한 평면에 있지 않은 책장 — 모서리 정합의 8번째 자유도
  if (P.tw) Z += P.tw * (u - 0.5) * (v - 0.5) * pw;
  // 회전 (pitch=rx, yaw=ry, roll=rz)
  let x1 = X, y1 = Y * Math.cos(rx) - Z * Math.sin(rx), z1r = Y * Math.sin(rx) + Z * Math.cos(rx);
  let x2 = x1 * Math.cos(ry) + z1r * Math.sin(ry), y2 = y1, z2r = -x1 * Math.sin(ry) + z1r * Math.cos(ry);
  let x3 = x2 * Math.cos(rz) - y2 * Math.sin(rz), y3 = x2 * Math.sin(rz) + y2 * Math.cos(rz), z3 = z2r;
  // 카메라: 거리 1 고정 (스케일 모호성 제거), 평행이동 tx/ty
  const cz = z3 + 1;
  if (cz < 0.05) return null;
  return [
    (F * (x3 + tx)) / cz + W / 2,
    (F * (y3 + ty)) / cz + H / 2,
  ];
}

/* 모델 외곽선 샘플 (top/bottom 각 NT점, left/right 각 NS점) → 화면 좌표 배열 */
function pmOutline(P, W, H, NT = 15, NS = 9) {
  const pts = [];
  for (let i = 0; i < NT; i++) pts.push(pmProject(P, i / (NT - 1), 0, W, H)); // top
  for (let i = 0; i < NT; i++) pts.push(pmProject(P, i / (NT - 1), 1, W, H)); // bottom
  for (let i = 1; i < NS - 1; i++) pts.push(pmProject(P, 0, i / (NS - 1), W, H)); // left
  for (let i = 1; i < NS - 1; i++) pts.push(pmProject(P, 1, i / (NS - 1), W, H)); // right
  return pts;
}

/* 챔퍼 매칭 에너지: field = 엣지까지의 거리변환(픽셀). 외곽선이 엣지 위에 놓일수록 점수↑
   거리장이 매끄러워 좌표 하강이 안정적으로 수렴한다 */
function pmScore(P, fieldObj, W, H, guide) {
  const field = fieldObj.dist || fieldObj;
  const pts = pmOutline(P, W, H);
  let s = 0;
  for (const p of pts) {
    if (!p) return -1e9;
    const x = p[0], y = p[1];
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) { s -= 60; continue; }
    // 쌍선형 보간 거리
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const d00 = field[y0 * W + x0], d10 = field[y0 * W + x0 + 1];
    const d01 = field[(y0 + 1) * W + x0], d11 = field[(y0 + 1) * W + x0 + 1];
    const d = d00 * (1 - fx) * (1 - fy) + d10 * fx * (1 - fy) + d01 * (1 - fx) * fy + d11 * fx * fy;
    s += 25 - Math.min(d, 25);
  }
  // 신뢰 영역: 모서리 4점만 앵커에 고정 (자세 고정, 곡률은 자유 — 곡선 탐색을 막지 않음)
  if (guide && guide.anchorC) {
    const cs = [
      pmProject(P, 0, 0, W, H), pmProject(P, 1, 0, W, H),
      pmProject(P, 1, 1, W, H), pmProject(P, 0, 1, W, H),
    ];
    const tg = [guide.anchorC.tl, guide.anchorC.tr, guide.anchorC.br, guide.anchorC.bl];
    for (let i = 0; i < 4; i++) {
      if (!cs[i]) { s -= 500; continue; }
      const dev = Math.hypot(cs[i][0] - tg[i].x, cs[i][1] - tg[i].y);
      s -= guide.w * Math.max(0, dev - guide.slack);
    }
  }
  // 부드러운 경계 증거(그림자 경사·저대비 종이/책상 경계): 강한 블러 후 그라디언트 크기(0~1)
  const sw = pmFlag('PM_SOFT_W');
  if (sw && fieldObj.soft) {
    const sf = fieldObj.soft;
    for (const p of pts) {
      const x = p[0], y = p[1];
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const v = sf[y0 * W + x0] * (1 - fx) * (1 - fy) + sf[y0 * W + x0 + 1] * fx * (1 - fy) + sf[(y0 + 1) * W + x0] * (1 - fx) * fy + sf[(y0 + 1) * W + x0 + 1] * fx * fy;
      s += sw * 25 * v;
    }
  }
  // 외곽선 전체 앵커 (2단계: 1단계가 확정한 외곽을 유지한 채 내부 글줄로 자세 모호성만 해소)
  if (guide && guide.anchorPts) {
    const ap = guide.anchorPts;
    for (let i = 0; i < pts.length && i < ap.length; i++) {
      if (!pts[i] || !ap[i]) continue;
      const dev = Math.hypot(pts[i][0] - ap[i][0], pts[i][1] - ap[i][1]);
      s -= guide.wPts * Math.max(0, dev - guide.slackPts);
    }
  }
  // 곡률 오컴 페널티: 증거가 밀어붙이지 않는 한 직선 유지 (평면 문서 과곡률 방지)
  const cw = pmFlag('PM_CURV_W');
  if (cw) s -= cw * (Math.abs(P.z1) + Math.abs(P.z2) + Math.abs(P.z1b ?? P.z1) + Math.abs(P.z2b ?? P.z2));
  const tww = pmFlag('PM_TW_W');
  if (tww && P.tw) s -= tww * Math.abs(P.tw); // 비틀림 오컴 페널티 (평평한 문서에서 남용 방지)
  if (fieldObj.gray) {
    s += 1.6 * pmInteriorScore(P, fieldObj.gray, W, H); // 글자 줄 정합
    s += 0.45 * pmPolarityScore(P, fieldObj.gray, W, H); // 극성: 안쪽 밝음→바깥 어두움 전이 보상
    s += 1.2 * pmMarginScore(P, fieldObj.gray, W, H); // 세로 여백 정합 (글자 기울기 90도)
    const rw = (guide && guide.rowW !== undefined) ? guide.rowW : pmFlag('PM_ROW_W');
    if (rw) s += rw * pmRowScore(P, fieldObj.gray, W, H); // 글줄 수평 (자세·F 모호성 해소)
  }
  return s;
}

/* 글줄 수평 점수(사용자 제안 "글자의 줄과 줄은 수평"): 모델 (u,v) 격자에서 각 v행의 평균 밝기
   프로파일을 구해 그 대비(표준편차)를 잰다. 글줄이 v=일정 선에 정확히 놓이면 행 평균이
   줄/간격으로 또렷이 갈려 대비↑, 자세·곡률이 틀려 글줄이 기울거나 휘면 행끼리 섞여 대비↓.
   외곽만으로는 구분 안 되는 자세(F·요·롤) 모호성을 내부 글자로 푼다 */
function pmRowScore(P, gray, W, H) {
  const NR = 56, NC = 24;
  const rows = [];
  for (let r = 0; r < NR; r++) {
    const v = 0.12 + (0.76 * r) / (NR - 1);
    let s = 0, n = 0;
    for (let c = 0; c < NC; c++) {
      const u = 0.12 + (0.76 * c) / (NC - 1);
      const p = pmProject(P, u, v, W, H);
      if (!p) return -1e9;
      const x = Math.round(p[0]), y = Math.round(p[1]);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      s += gray[y * W + x]; n++;
    }
    if (n >= NC * 0.7) rows.push(s / n);
  }
  if (rows.length < NR * 0.7) return 0;
  // 저주파(조명 그라데이션) 제거: 이웃 9행 이동평균 차감 후 표준편차
  let tot = 0, cnt = 0;
  for (let i = 4; i < rows.length - 4; i++) {
    let m = 0;
    for (let k = -4; k <= 4; k++) m += rows[i + k];
    const d = rows[i] - m / 9;
    tot += d * d; cnt++;
  }
  return cnt ? Math.sqrt(tot / cnt) : 0;
}

/* 극성 점수: 외곽선 각 점에서 바깥 법선 방향으로 안/밖 밝기를 비교.
   페이지 테두리는 안쪽(종이)이 밝고 바깥(책상·그림자)이 어두운 전이 —
   그림자 반대편 같은 역극성 엣지에 끌리는 것을 막는다 */
function pmPolarityScore(P, gray, W, H) {
  const cen = pmProject(P, 0.5, 0.5, W, H);
  if (!cen) return -1e9;
  let s = 0, n = 0;
  const D = 5; // 법선 방향 샘플 거리(px)
  const edges = [[0, 'v'], [1, 'v'], [0, 'u'], [1, 'u']]; // v=0(top), v=1(bottom), u=0(left), u=1(right)
  for (const [fix, kind] of edges) {
    for (let i = 1; i < 14; i++) {
      const t = i / 14;
      const p = kind === 'v' ? pmProject(P, t, fix, W, H) : pmProject(P, fix, t, W, H);
      if (!p) return -1e9;
      // 바깥 방향 = 중심 반대쪽
      let nx = p[0] - cen[0], ny = p[1] - cen[1];
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
      const xi = Math.round(p[0] - nx * D), yi = Math.round(p[1] - ny * D); // 안쪽
      const xo = Math.round(p[0] + nx * D), yo = Math.round(p[1] + ny * D); // 바깥
      if (xi < 0 || yi < 0 || xi >= W || yi >= H || xo < 0 || yo < 0 || xo >= W || yo >= H) continue;
      const diff = gray[yi * W + xi] - gray[yo * W + xo]; // 밝은 안쪽 - 어두운 바깥 > 0 이어야
      s += Math.max(-25, Math.min(25, diff));
      n++;
    }
  }
  return n ? s / n : 0;
}

/* 내부 정합 항: 모델의 내부 수평선(v=const)이 이미지의 글자 줄무늬를 따라가면
   선을 따라 명암이 균일(분산↓). 컬 vs 기울기의 외곽선 모호성을 글자 줄이 해소한다 */
function pmInteriorScore(P, gray, W, H) {
  let total = 0, lines = 0;
  for (const v of [0.2, 0.32, 0.44, 0.56, 0.68, 0.8]) {
    const vals = [];
    for (let i = 0; i <= 24; i++) {
      const p = pmProject(P, 0.12 + (0.76 * i) / 24, v, W, H);
      if (!p) return -1e9;
      const x = Math.round(p[0]), y = Math.round(p[1]);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      vals.push(gray[y * W + x]);
    }
    if (vals.length < 15) continue;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const va = vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length;
    total -= Math.sqrt(va); // 표준편차가 작을수록 좋음
    lines++;
  }
  return lines ? total / lines : 0;
}

/* 세로 여백 정합(사용자 제안 "글자 기울기로 90도"):
   본문 좌우 여백은 페이지 기준 수직으로 균일하게 밝다 — 모델 세로선이 여백과
   나란하면 분산↓, 기울면 글자를 가로질러 분산↑. 세로 기울기(rz·ry)를 글자로 고정 */
function pmMarginScore(P, gray, W, H) {
  let total = 0, lines = 0;
  for (const u of [0.07, 0.115, 0.885, 0.93]) {
    const vals = [];
    for (let i = 0; i <= 20; i++) {
      const p = pmProject(P, u, 0.15 + (0.7 * i) / 20, W, H);
      if (!p) return -1e9;
      const x = Math.round(p[0]), y = Math.round(p[1]);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      vals.push(gray[y * W + x]);
    }
    if (vals.length < 14) continue;
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const va = vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length;
    total -= Math.sqrt(va);
    lines++;
  }
  return lines ? total / lines : 0;
}

/* 좌표 상승 최적화 (특허의 반복 추정 실시예 — 수치 미분 + 스텝 축소) */
function pmFit(grad, W, H, guide, initP, stepScale = 1) {
  const P = { ...initP };
  if (P.z1b === undefined) P.z1b = P.z1;
  if (P.z2b === undefined) P.z2b = P.z2;
  if (P.tw === undefined) P.tw = 0;
  const names = ['tx', 'ty', 'pw', 'ph', 'rx', 'ry', 'rz', 'z1', 'z2', 'z1b', 'z2b', 'tw'];
  const step0 = {};
  for (const [k, v] of Object.entries({ tx: 0.04, ty: 0.04, pw: 0.05, ph: 0.05, rx: 0.05, ry: 0.05, rz: 0.02, z1: 0.03, z2: 0.03, z1b: 0.03, z2b: 0.03, tw: 0.03 })) {
    step0[k] = v * stepScale;
  }
  const lim = { z1: [-0.5, 0.5], z2: [-0.5, 0.5], z1b: [-0.5, 0.5], z2b: [-0.5, 0.5], rx: [-0.6, 0.6], ry: [-0.6, 0.6], rz: [-0.35, 0.35], tw: [-0.4, 0.4] };
  let best = pmScore(P, grad, W, H, guide);
  for (let round = 0; round < 60; round++) {
    let improved = false;
    for (const k of names) {
      const st = step0[k] * Math.pow(0.9, round);
      for (const dir of [1, -1]) {
        let moved = false;
        // 같은 방향으로 계속 좋아지면 연속 전진 (수렴 가속)
        for (let hop = 0; hop < 6; hop++) {
          const old = P[k];
          P[k] = old + dir * st;
          if (lim[k]) P[k] = Math.max(lim[k][0], Math.min(lim[k][1], P[k]));
          const s = pmScore(P, grad, W, H, guide);
          if (s > best) { best = s; improved = true; moved = true; }
          else { P[k] = old; break; }
        }
        if (moved) break;
      }
    }
    if (!improved && round > 12) break;
  }
  return { P, score: best };
}

/* 다중 시작 피팅: 서로 다른 초기 곡률/기울기에서 출발해 최고 점수를 채택
   + 2단계(자세 먼저, 곡률 나중) 수렴 */
function pmFitMulti(field, W, H, guide, baseInit) {
  const seeds = [
    {},
    { z1: 0.08, z2: 0.08 },
    { z1: 0.15, z2: 0.05 },
    { z1: 0.05, z2: 0.15 },
    { z1: -0.08, z2: -0.08 },
    { z1: -0.15, z2: -0.05 },
    { z1: -0.05, z2: -0.15 },
    { ry: 0.15 }, { ry: -0.15 }, { rx: 0.15 }, { rx: -0.15 },
  ];
  let bestR = null;
  for (const s of seeds) {
    const r = pmFit(field, W, H, guide, { ...baseInit, ...s });
    if (!bestR || r.score > bestR.score) bestR = r;
  }
  // 곡률 부호 반전 검사: 위로 말림↔아래로 불룩은 외곽선만으로 헷갈리는 국소해 쌍 —
  // 최적해의 곡률을 뒤집어 다시 맞춰보고 더 좋은 쪽을 택한다
  {
    const bp = bestR.P;
    const flipped = { ...bp, z1: -bp.z1, z2: -bp.z2, z1b: -(bp.z1b ?? bp.z1), z2b: -(bp.z2b ?? bp.z2), tw: -(bp.tw || 0) };
    const r = pmFit(field, W, H, guide, flipped);
    if (r.score > bestR.score) bestR = r;
  }
  // 마무리 정밀 폴리시 (점점 작은 스텝 2단계)
  let cur = bestR;
  for (const sc of [0.25, 0.08, 0.03]) {
    const fine = pmFit(field, W, H, guide, cur.P, sc);
    if (fine.score > cur.score) cur = fine;
  }
  return cur;
}


/* 자세 정합: 평평한 모델(z=0)의 네 모서리를 목표 사각형 모서리에 맞춘다
   (기울어진 페이지도 회전·이동·크기로 정확히 초기화 — 이후 이미지 피팅은 정밀화만) */
/* 4점 호모그래피 (DLT, h33=1) — 8×8 가우스 소거 */
function pmHomography4(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/* 해석적 자세: 단위 사각형(중심 원점) → 화면 모서리 호모그래피를 K⁻¹로 정규화하면
   열벡터가 [pw·r1, ph·r2, t] (t.z=1) — 크기·회전·이동을 직접 읽는다 (F 불일치는 직교화로 흡수) */
function pmPoseFromQuad(targetC, W, H, F) {
  const src = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  const dst = [targetC.tl, targetC.tr, targetC.br, targetC.bl].map((p) => [(p.x - W / 2) / F, (p.y - H / 2) / F]);
  const h = pmHomography4(src, dst);
  if (!h) return null;
  const lam = h[8];
  if (Math.abs(lam) < 1e-9) return null;
  const c1 = [h[0] / lam, h[3] / lam, h[6] / lam];
  const c2 = [h[1] / lam, h[4] / lam, h[7] / lam];
  const t = [h[2] / lam, h[5] / lam, 1];
  const pw = Math.hypot(c1[0], c1[1], c1[2]), ph = Math.hypot(c2[0], c2[1], c2[2]);
  if (!(pw > 1e-6) || !(ph > 1e-6)) return null;
  const r1 = c1.map((v) => v / pw);
  let r2 = c2.map((v) => v / ph);
  const dot = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2];
  r2 = r2.map((v, i) => v - dot * r1[i]);
  const n2 = Math.hypot(r2[0], r2[1], r2[2]);
  if (!(n2 > 1e-6)) return null;
  r2 = r2.map((v) => v / n2);
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  // R = Rz·Ry·Rx 분해: R20=-sin(ry), R21=cy·sx, R22=cy·cx, R10=sz·cy, R00=cz·cy
  const ry = Math.asin(Math.max(-1, Math.min(1, -r1[2])));
  const rx = Math.atan2(r2[2], r3[2]);
  const rz = Math.atan2(r1[1], r1[0]);
  return { F, tx: t[0], ty: t[1], pw, ph, rx, ry, rz, z1: 0, z2: 0 };
}

function pmAlignToQuad(targetC, W, H, baseInit) {
  const quadLoss = (Q) => {
    const c = [pmProject(Q, 0, 0, W, H), pmProject(Q, 1, 0, W, H), pmProject(Q, 1, 1, W, H), pmProject(Q, 0, 1, W, H)];
    if (c.some((p) => !p)) return 1e9;
    return Math.hypot(c[0][0]-targetC.tl.x, c[0][1]-targetC.tl.y) + Math.hypot(c[1][0]-targetC.tr.x, c[1][1]-targetC.tr.y)
         + Math.hypot(c[2][0]-targetC.br.x, c[2][1]-targetC.br.y) + Math.hypot(c[3][0]-targetC.bl.x, c[3][1]-targetC.bl.y);
  };
  // 좌표하강 다듬기 (출발점마다 독립 실행)
  const names = ['tx', 'ty', 'pw', 'ph', 'rx', 'ry', 'rz', 'tw'];
  const step0 = { tx: 0.05, ty: 0.05, pw: 0.06, ph: 0.06, rx: 0.08, ry: 0.08, rz: 0.05, tw: 0.05 };
  const descend = (start, scale) => {
    const P = { ...start, tw: start.tw || 0 };
    let best = quadLoss(P);
    for (let round = 0; round < 70; round++) {
      let improved = false;
      for (const k of names) {
        const st = step0[k] * scale * Math.pow(0.93, round);
        for (const dir of [1, -1]) {
          let moved = false;
          for (let hop = 0; hop < 6; hop++) {
            const old = P[k];
            P[k] = old + dir * st;
            if (k === 'tw' && Math.abs(P[k]) > 0.35) { P[k] = old; break; } // 피팅 단계 한계와 일치 (밖으로 나가면 영구 고착)
            const s = quadLoss(P);
            if (s < best) { best = s; improved = true; moved = true; }
            else { P[k] = old; break; }
          }
          if (moved) break;
        }
      }
      if (!improved && round > 15) break;
    }
    return { P, loss: best };
  };
  // 출발점 후보: 평면 정면 초기값 + F 후보별 해석적 자세(호모그래피 분해).
  // 말린 페이지의 모서리는 한 평면에 있지 않아 해석해에도 잔차가 남으므로,
  // 각 출발점에서 다듬은 뒤 잔차 최소를 택한다
  const starts = [{ P: { ...baseInit, z1: 0, z2: 0, F: PM_F_DEFAULT * Math.max(W, H) }, scale: 1 }];
  // F는 네 모서리만으로 정할 수 없다(평면 사각형은 모든 F에서 잔차 동일, 곡면은 엉뚱한 F가 최소)
  // → 스마트폰 기본 카메라 물리값(26mm 환산 ≈ 0.75×장변)으로 고정
  const fList = (typeof window !== 'undefined' && window.PM_F_LIST) ? window.PM_F_LIST : [PM_F_DEFAULT];
  for (const fm of fList) {
    const Q = pmPoseFromQuad(targetC, W, H, fm * Math.max(W, H));
    if (Q && quadLoss(Q) < 1e8) starts.push({ P: Q, scale: 0.4 });
  }
  let bestR = null;
  for (const s of starts) {
    const r = descend(s.P, s.scale);
    if (!bestR || r.loss < bestR.loss) bestR = r;
  }
  return { P: bestR.P, cornerLoss: bestR.loss / 4 };
}

/* 초기값: 가이드 사각형(평평·정면 가정)에서 역산 */
const PM_F_DEFAULT = 0.75;
function pmInit(guide, W, H) {
  const F = PM_F_DEFAULT * Math.max(W, H);
  return {
    F,
    tx: ((guide.x0 + guide.x1) / 2 - W / 2) / F,
    ty: ((guide.y0 + guide.y1) / 2 - H / 2) / F,
    pw: (guide.x1 - guide.x0) / F,
    ph: (guide.y1 - guide.y0) / F,
    rx: 0, ry: 0, rz: 0, z1: 0, z2: 0,
  };
}

/* 2단계 내부 정밀화: 1단계 외곽을 앵커로 고정하고(여유 slackPts), 글줄 수평 항을 강하게 켜서
   외곽이 같은 자세 족(F·요·비틀림·곡률 교환) 중 글자가 수평이 되는 해를 고른다 */
function pmRefineInterior(field, W, H, P1, rowW = 100, slackFrac = 0.006, wPts = 20) {
  const guide = { anchorPts: pmOutline(P1, W, H), slackPts: slackFrac * Math.max(W, H), wPts, rowW };
  let cur = { P: { ...P1 }, score: pmScore(P1, field, W, H, guide) };
  for (const sc of [0.5, 0.2, 0.08]) {
    const r = pmFit(field, W, H, guide, cur.P, sc);
    if (r.score > cur.score) cur = r;
  }
  return cur.P;
}

/* 평탄화 결과의 테두리 다듬기: 외곽이 실제 경계보다 조금 바깥이면 가장자리에 책상/배경 띠가 남는다.
   가장자리에서 안쪽으로, 종이 밝기(중앙 중앙값)보다 확연히 어두운 행/열을 잘라낸다 (최대 8%) */
function pmTrimDarkBorders(gray, w, h) {
  const cx0 = Math.round(w * 0.3), cx1 = Math.round(w * 0.7), cy0 = Math.round(h * 0.3), cy1 = Math.round(h * 0.7);
  const samp = [];
  for (let y = cy0; y < cy1; y += 3) for (let x = cx0; x < cx1; x += 3) samp.push(gray[y * w + x]);
  samp.sort((a, b) => a - b);
  const paper = samp[Math.floor(samp.length * 0.7)]; // 글자 제외한 종이 밝기
  const thr = paper - 55;
  const colMean = (x) => { let s = 0; for (let y = cy0; y < cy1; y++) s += gray[y * w + x]; return s / (cy1 - cy0); };
  const rowMean = (y) => { let s = 0; for (let x = cx0; x < cx1; x++) s += gray[y * w + x]; return s / (cx1 - cx0); };
  const maxX = Math.round(w * 0.08), maxY = Math.round(h * 0.08);
  let x0 = 0, x1 = w, y0 = 0, y1 = h;
  while (x0 < maxX && colMean(x0) < thr) x0++;
  while (w - x1 < maxX && colMean(x1 - 1) < thr) x1--;
  while (y0 < maxY && rowMean(y0) < thr) y0++;
  while (h - y1 < maxY && rowMean(y1 - 1) < thr) y1--;
  // 어두운 띠 다음의 1~2px 전이도 함께 제거
  if (x0) x0 = Math.min(maxX, x0 + 2); if (x1 < w) x1 = Math.max(w - maxX, x1 - 2);
  if (y0) y0 = Math.min(maxY, y0 + 2); if (y1 < h) y1 = Math.max(h - maxY, y1 - 2);
  return { x0, x1, y0, y1 };
}

/* 펴진 페이지의 실제 가로/세로 비율: 중간 행 단면 호길이 × pw / ph
   (출력 크기를 화면 바운딩박스로 잡으면 원근으로 좁아진 만큼 글자가 눌린다) */
function pmFlatAspect(P) {
  const zb1 = P.z1b === undefined ? P.z1 : P.z1b;
  const zb2 = P.z2b === undefined ? P.z2 : P.z2b;
  const c1 = 0.5 * (P.z1 + zb1), c2 = 0.5 * (P.z2 + zb2);
  const N = 120;
  let arc = 0, pz = pmBez(0, c1, c2);
  for (let i = 1; i <= N; i++) { const z = pmBez(i / N, c1, c2); arc += Math.hypot(1 / N, z - pz); pz = z; }
  return (P.pw * arc) / P.ph;
}

/* 평탄화 리맵: 출력 (U,V) → 원본 좌표.
   로프트 지원 — 각 출력 행(v)의 단면 곡률로 호길이 균일화 (상·하 곡률이 달라도 정확) */
function pmBuildRemap(P, W, H, outW, outH) {
  const zb1 = P.z1b === undefined ? P.z1 : P.z1b;
  const zb2 = P.z2b === undefined ? P.z2 : P.z2b;
  const N = 120;
  const mapX = new Float32Array(outW * outH);
  const mapY = new Float32Array(outW * outH);
  const arc = new Float64Array(N + 1);
  for (let y = 0; y < outH; y++) {
    const v = outH > 1 ? y / (outH - 1) : 0;
    const c1 = (1 - v) * P.z1 + v * zb1;
    const c2 = (1 - v) * P.z2 + v * zb2;
    // 이 행의 단면 호길이 테이블
    let pz = pmBez(0, c1, c2);
    arc[0] = 0;
    for (let i = 1; i <= N; i++) {
      const z = pmBez(i / N, c1, c2);
      arc[i] = arc[i - 1] + Math.hypot(1 / N, z - pz);
      pz = z;
    }
    const total = arc[N];
    let seg = 1;
    for (let x = 0; x < outW; x++) {
      const target = (outW > 1 ? x / (outW - 1) : 0) * total;
      while (seg < N && arc[seg] < target) seg++;
      const f = (target - arc[seg - 1]) / (arc[seg] - arc[seg - 1] || 1);
      const u = (seg - 1 + f) / N;
      const p = pmProject(P, u, v, W, H);
      mapX[y * outW + x] = p ? p[0] : -1;
      mapY[y * outW + x] = p ? p[1] : -1;
    }
  }
  return { mapX, mapY };
}
