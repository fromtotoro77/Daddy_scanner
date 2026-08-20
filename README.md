# 📄 Daddy Scanner

> 스마트폰 브라우저에서 책·문서를 촬영하고 보정해서 PDF로 만드는 스캐너
> **daddy 시리즈** — 설치 없이 웹 주소로 쓰는 우리집 앱

## 사용법

1. 스마트폰 브라우저로 배포 주소에 접속 (홈 화면에 추가하면 앱처럼 사용)
2. 책 페이지를 **촬영** (여러 장 연속 촬영 가능) — 문서 테두리를 자동 감지해 반듯하게 보정
3. **페이지** 화면에서 확인 — 필요 없는 장은 선택 삭제, 순서 조정
4. 페이지를 눌러 **편집** — 매직컬러/흑백/밝기 보정, 삐뚤어진 사진은 영역보정(자동/수동)
5. **PDF 만들기** → 저장 또는 공유(카톡·메일 등)

모든 처리는 브라우저 안에서 이루어지며 **사진이 어디에도 전송되지 않습니다.**

## 주요 기능

- 📸 카메라 연속 촬영 + 갤러리 사진 불러오기
- 🔍 문서 테두리 실시간 자동 감지·원근 보정 (jscanify/OpenCV)
- ✂️ 수동 4모서리 영역 조정, 90° 회전
- 🎨 문서 필터: 매직컬러(그림자 제거)·흑백문서(적응형 이진화)·그레이·선명하게·원본 + 밝기/대비
- 🗂 페이지 관리: 다중 선택 삭제(실행취소), 순서 이동, 전체 필터 적용
- 📑 PDF 생성 3단계 품질 + Web Share 공유
- 💾 자동 저장(IndexedDB) — 브라우저를 닫아도 작업 복원
- 📴 PWA — 두 번째 접속부터 오프라인 동작

## 기술 스택

순수 정적 웹앱 (빌드·서버 없음). [jscanify](https://github.com/puffinsoft/jscanify) + [OpenCV.js](https://docs.opencv.org/) + [jsPDF](https://github.com/parallax/jsPDF) — 전부 CDN 로드.

## 개발·배포

- 로컬 실행: 이 폴더에서 `python -m http.server 8000` → http://localhost:8000 (카메라는 localhost/HTTPS에서만 동작)
- 배포: `main` 브랜치 push → GitHub Pages
- 버전 관리: [CHANGELOG.md](CHANGELOG.md) + git 태그 (`v1.0.0` …)
- 설계 문서: [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)
