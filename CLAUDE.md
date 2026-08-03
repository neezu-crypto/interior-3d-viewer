# interior-3d-viewer (스트리머 배경시장)

Three.js 기반 방송(OBS) 배경 화면 모음. 페이지마다 완전히 독립된 단일 HTML 파일이며,
공용 번들러/빌드 과정 없이 브라우저에서 그대로 열어 쓴다.

## 페이지 목록과 기술 스택

- `index.html` — 인테리어 방 뷰어 (벽지/몰딩/바닥/가구/낮밤/줌 조정 가능). three.js **r128**,
  `<script>` 태그로 전역 로드 (module 아님).
- `ski-resort.html` — 스키장 배경. 마찬가지로 **r128** classic script.
- `fireworks.html` — 불꽃놀이 야시장 배경. **최신 three.js를 ES 모듈로(importmap)** 불러온
  첫 페이지.

**새 배경 페이지를 만들 때는 `fireworks.html`처럼 최신 three.js를 ES 모듈로 새로 시작한다.**
기존 r128 페이지(index.html, ski-resort.html)는 이미 잘 동작하니 최신 방식으로
마이그레이션하지 않는다 — 회귀 위험 대비 이득이 적다.

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/"
} }
</script>
```

버전은 `/Users/jaechanpark/Documents/GitHub/StreamBet-Market`(같은 개발자의 자매 프로젝트,
`js/winter-scene.js`, `js/firework-scene.js`에 검증된 이펙트 다수)와 맞춰뒀다 — 거기서 효과를
가져다 쓸 때 셰이더 청크 구조 차이가 안 생기게 하기 위함.

## 모든 배경 페이지가 지키는 공통 규칙

- **카메라는 항상 고정**이다 (방송 배경이라 유저 조작/카메라 이동이 없음). `FIXED_ASPECT = 16/9`,
  `#app`의 실제 rect를 기준으로 레터박스 맞추는 `fitCanvas()` 패턴을 그대로 재사용한다.
  **예외**: `fireworks.html`은 기준 위치(`CAMERA_POS`/`CAM_LOOK_TARGET`)에서 벗어나지 않는
  아주 미세한 절차적 핸드헬드 흔들림(`applyHandheldShake`, `animate()` 루프)을 의도적으로
  추가했다 — 유저 조작/카메라 이동은 여전히 없고 화면 프레이밍에 실질적 영향이 없는 수준.
  `prefers-reduced-motion`이면 꺼지고 완전 고정으로 되돌아간다. 새 페이지에 이 예외를
  기본값으로 복사하지 말 것 — 필요할 때만 의도적으로 넣을 것.
- 상단 `devbar`(다른 제작물 홍보 바), 우측 드래그 가능한 `#sidePanel`(로그인/프리셋/갤러리)을
  모든 페이지가 동일하게 가진다. 새 페이지 만들 때 이 HTML/CSS를 통째로 복사해오면 된다.
- `window.obsstudio`가 있으면(실제 OBS 캡처 중) devbar/패널을 숨긴다. 더블클릭으로 전체화면
  전환도 모든 페이지에 있어야 하며, 전체화면 중에도 devbar/패널을 숨긴다.
- 로컬 프리셋은 `localStorage`의 `interior3dViewer.presets` 키를 **모든 페이지가 공유**한다.
  방 설정이 없는 페이지(스키장/불꽃놀이 등)는 프리셋을 `{ sceneUrl: '파일명.html' }` 형태로
  저장하고, "적용"을 누르면 그 페이지로 이동한다. 방 설정 프리셋을 다른 배경 페이지에서
  "적용"하면 `index.html?preset=<인코딩>`으로 리다이렉트해서 거기서 처리한다.
- 공개 갤러리는 Firebase RTDB `presetGallery` + Cloud Functions(`functions/index.js`,
  isolated `presetgallery` codebase, `soop-stock-market` 프로젝트 안의 다른 ~69개 무관한
  함수는 절대 건드리지 않는다)를 쓴다. 게시/수정/삭제는 `ADMIN_EMAIL`
  (`skftodwocks2@gmail.com`) 계정만 서버(`requireAdmin`)에서 검증한다 — 클라이언트는
  버튼 표시 여부만 판단할 뿐 권한을 신뢰하지 않는다.
- 갤러리 목록의 "적용"/"OBS" 버튼은 클릭 횟수를 서버(`incrementPresetApplyCount`/
  `incrementPresetObsLinkCount`, `presetGallery/{id}/stats`)에 자동 집계한다(통합 관리
  센터 통계용). **새 배경 페이지를 만들 때 이 두 호출도 반드시 같이 복사할 것** — UI만
  복사하고 이 호출을 빠뜨리면 그 페이지에서는 집계가 전혀 안 되는데도 겉보기엔 정상
  작동하는 것처럼 보여서 알아채기 어렵다(2026-08-03에 `ski-resort.html`/`fireworks.html`이
  이렇게 빠져 있었다가 뒤늦게 발견됨). 특히 `sceneUrl` 프리셋의 "적용" 버튼은 집계 요청을
  보내자마자 `location.href`로 페이지를 이동시키면 응답 전에 요청이 취소되므로, 반드시
  `#sceneApplyOverlay`(로딩 오버레이)를 띄운 채 집계 요청이 끝나거나 5초 안전장치가
  지날 때까지 기다린 뒤 이동해야 한다(`index.html`의 해당 버튼 핸들러가 기준 구현).
- 배경음은 **기본적으로 꺼둔다** (`soundEnabled: false` 등). 방송 배경 특성상 갑자기 소리가
  나면 사고가 될 수 있어서, 필요하면 사용자가 명시적으로 켜게 한다.

## 후처리(블러 등) 관련 - 반드시 지킬 것

- **`BokehPass`(또는 씬을 `MeshDepthMaterial`로 다시 그려 깊이 텍스처를 얻는 방식)는 쓰지
  않는다.** 실제 사용자 GPU에서 블러가 프레임마다 켜졌다 꺼졌다 깜빡이는 버그가 실제로
  확인됐고 (`needsSwap`, 리사이즈 픽셀비, 깊이 텍스처 공유 등 여러 방식으로 시도했지만
  전부 실패/새로운 GPU 에러만 발생), 근본 원인은 "같은 프레임 안에서 텍스처를 렌더타겟으로
  썼다가 바로 다시 읽는" 패턴 자체가 이 부류의 GPU/드라이버에서 불안정하다는 것으로 결론남.
- **블러(피사계심도 느낌)가 필요하면 틸트시프트(tilt-shift) 방식을 쓴다** — 실제 3D 깊이가
  아니라 화면 세로 좌표(`vUv.y`)와 고정된 "초점 띠" 위치의 차이로 블러 반경을 정하는 방식
  (`ski-resort.html`, `fireworks.html`에 이미 구현돼있음, `StreamBet-Market/js/winter-scene.js`
  원본). 씬을 두 번 그릴 필요가 없어서 위 버그가 구조적으로 발생할 수 없다.
- **진짜 반사(물 등)도 렌더타겟을 다시 읽는 방식(`Reflector` 등) 대신, 지오메트리를 복제해서
  y를 뒤집고 불투명도를 낮추는 "가짜 반사"를 쓴다.** 파티클처럼 매 프레임 위치가 바뀌는
  것도 CPU에서 좌표만 미러링해서 별도로 그리면 된다 (씬 재렌더 없음 → 안전).
- `UnrealBloomPass`의 threshold(4번째 인자)를 0으로 두면, 화면에 창문 같은 넓은 면적의
  은은한 광원이 있을 때 전부 블룸에 걸려 뿌옇게 하얗게 뜬다. 배경에 그런 밝은 표면이 있는
  씬이면 threshold를 0.3~0.4 정도로 올릴 것.
- `onBeforeCompile`로 표준 재질(MeshStandardMaterial 등) 셰이더에 커스텀 코드를 끼워 넣을
  때는, three.js 버전마다 셰이더 청크 구조가 다르다는 걸 명심할 것 — 예를 들어 최신
  three.js의 `#include <opaque_fragment>` 청크는 r128엔 없고, r128은
  `gl_FragColor = vec4( outgoingLight, diffuseColor.a );`가 그대로 인라인으로 박혀있다.
  `String.replace()`는 매칭 안 되면 에러 없이 조용히 원본을 그대로 반환하므로, 삽입이 실제로
  됐는지 `fragmentShader.indexOf(...)`로 확인하는 안전장치를 반드시 넣을 것.

## 구현 후 검증 필수

- 코드를 구현한 뒤 배포·커밋으로 넘어가기 전에 반드시 검증 단계를 거친다. 필드명·파라미터명·상태값을 "이렇게 생겼겠지"라고 추측하지 말고, 실제로 그 데이터를 쓰는(write) 쪽 소스 코드를 다시 읽어 대조한다.
- 자매 프로젝트(StreamBet-Market, soop-stock-market, admin-center)에서 실제로 검증 없이 넘어갔다면 조용히 묻혔을 사례들: 구매 현황 집계에서 `uid` 필드가 실제로는 `requesterUid`였던 걸 가정만 하고 넘어가 절반 가까운 항목이 누락될 뻔했던 일, 감사 로그 자동 기록 대상 액션 3개가 누락됐던 일, 신청 유형 하나가 최근 리팩터로 이미 즉시 자동 승인되도록 바뀌어 있어 "승인 대기" 큐 UI를 만들어도 절대 나타나지 않는다는 걸 뒤늦게 발견한 일. 전부 실제 소스를 재확인하는 검증 단계에서만 잡을 수 있었다.
- 구체적으로 확인할 것: 문법 검사(`node -c` 등), RTDB 규칙 변경은 `--dry-run`으로 먼저 확인, 그리고 무엇보다 새로 읽거나 다루는 RTDB 노드(`presetGallery`/`presetMergeTickets`/`presetMergeFailures` 등)의 필드명은 그 노드를 쓰는 실제 코드를 찾아 대조.

## 테스트 방법

이 프로젝트엔 빌드/서버가 따로 없다. 로컬에서 확인할 땐:
```
python3 -m http.server 8080 --directory /Users/jaechanpark/Documents/GitHub/interior-3d-viewer
```
Playwright로 스크린샷/콘솔 에러를 확인하되, **헤드리스 테스트 환경은 SwiftShader(소프트웨어
렌더링)라 실제 GPU와 동작이 다를 수 있다** — 특히 타이밍/드라이버에 민감한 버그(위 블러
깜빡임 등)는 헤드리스에서 재현이 안 될 수 있으니, 그런 의심이 들면 사용자에게 실제 브라우저
화면 녹화를 요청해서 프레임 단위로 비교하는 게 확실하다 (macOS라면 `swift`로 AVFoundation
프레임 추출 스크립트를 짜서 쓸 수 있음).

## Firebase

- 프로젝트: `soop-stock-market` (다른 무관한 서비스도 같이 쓰는 프로젝트이므로 주의).
- `functions/` 디렉토리는 `firebase.json`에서 `codebase: "presetgallery"`로 격리돼있다.
  배포 시 `firebase deploy --only functions:presetgallery --project soop-stock-market`처럼
  codebase를 반드시 지정할 것.
- `database.rules.json`의 `presetGallery`/`presetMergeTickets`/`presetMergeFailures` 외
  나머지 노드는 이 프로젝트와 무관한 다른 서비스 소유이니 건드리지 않는다.
