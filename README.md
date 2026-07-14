# 타일맵 에디터 (Tilemap Editor)

로그라이크 게임 제작용 타일맵 에디터. **iPad / iPhone + Apple Pencil**에 최적화된 순수 정적 웹앱입니다.

**▶ 사용하기: https://namyunwoo.github.io/tilemapeditor/**

## 🔒 유료 에셋 보호

타일셋 이미지(tileset.png 등)는 **절대 이 저장소에 포함되지 않습니다.**

- 이미지는 브라우저의 IndexedDB(기기 내부)에만 저장되며 서버로 전송되지 않습니다.
- `.gitignore`가 저장소 루트의 모든 이미지 파일을 차단합니다 (`icons/`의 앱 아이콘만 예외).
- 맵 JSON 내보내기에는 타일셋 **메타데이터만** 포함됩니다 (이미지 없음).
- "개인 백업(이미지 포함)"으로 만든 파일은 절대 공개된 곳에 올리지 마세요.

## 주요 기능

### 타일셋
- 이미지 업로드 후 **타일 크기(px), 여백(margin), 간격(spacing)** 을 픽셀 단위로 지정
- 팔레트에서 탭으로 타일 선택, 펜슬/마우스 드래그로 **다중 타일 스탬프** 선택

### 맵 편집
- 도구: 브러시 🖌️ / 지우개 🧹(크기 1·2·3·5) / 채우기 🪣 / 사각형 ▦ / 스포이드 💉 / 이동 ✋
- 타일 뒤집기 ↔️↕️ / 90° 회전 🔄 (단축키 X·Y·Z) — 스탬프 전체에 적용, 스포이드는 방향까지 복사
- 변형 도구 🔃 (T) — 맵에 이미 놓인 타일을 탭/드래그로 그 자리에서 뒤집기·회전 (↔️↕️🔄로 연산 선택)
- 다중 레이어 (추가/삭제/순서/표시 토글)
- 실행 취소/다시 실행 (⌘Z / ⇧⌘Z)
- **Apple Pencil = 그리기, 손가락 = 화면 이동/핀치 줌** (☝️ 버튼으로 손가락 그리기 전환)
- 자동 저장 (IndexedDB), 여러 프로젝트 관리

### ✍️ 손글씨 태그 (Apple Pencil)
- 펜슬로 글자를 쓰면 자동 인식(한국어/영어)되어 태그로 생성
- 태그를 타일에 지정 → 팔레트에 색 점으로 표시, 태그별 필터
- 내보내기 JSON에 포함되어 게임 로직(벽/바닥/문/몬스터 등)에 활용 가능
- iPadOS에서는 텍스트 입력창에 펜슬로 바로 쓰는 Scribble도 지원

### 내보내기 / 가져오기
- **맵 JSON (이미지 제외)** — 게임에서 로드해 사용. 형식:

```jsonc
{
  "type": "tilemap",
  "version": 1,
  "name": "던전1",
  "tileset": { "name": "tileset.png", "tileWidth": 16, "tileHeight": 16,
               "margin": 0, "spacing": 0, "columns": 16, "rows": 10,
               "imageWidth": 256, "imageHeight": 160 },
  "map": { "width": 40, "height": 30,
           "layers": [{ "name": "레이어 1", "visible": true, "data": [ -1, 5, 6 /* gid, -1=빈칸 */ ] }] },
  "tags": [{ "id": "tag_xxx", "name": "벽", "color": "#ff5b5b" }],
  "tileTags": { "5": ["tag_xxx"] }
}
```

- **타일 방향(뒤집기/회전)**: gid 상위 비트에 인코딩됩니다.

```js
const FLIP_H = 1 << 30;        // 좌우 뒤집기
const FLIP_V = 1 << 29;        // 상하 뒤집기
const FLIP_D = 1 << 28;        // 대각 뒤집기(축 교환) — 90° 회전에 사용
const GID_MASK = (1 << 28) - 1;

const baseId = gid & GID_MASK; // 타일셋 안의 실제 타일 번호
// 렌더링: 타일 중심 기준으로 대각(축 교환) → 좌우 → 상하 순서로 적용
// 시계 90° 회전 = FLIP_D | FLIP_H, 180° = FLIP_H | FLIP_V, 반시계 90° = FLIP_D | FLIP_V
```

- gid → 타일셋 좌표: `sx = margin + (baseId % columns) * (tileWidth + spacing)`, `sy = margin + floor(baseId / columns) * (tileHeight + spacing)`
- **개인 백업 (이미지 포함)** — 기기 이동용. 공유 금지 ⚠️

### PWA
홈 화면에 추가하면 전체 화면 앱처럼 동작하고, 오프라인에서도 열립니다 (손글씨 인식만 네트워크 필요).

## 개발

빌드 과정 없는 순수 HTML/CSS/JS입니다.

```bash
python3 -m http.server 8000   # http://localhost:8000
```

배포: `main` 브랜치에 push하면 GitHub Pages가 루트에서 서빙합니다.
