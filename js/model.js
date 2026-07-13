// 데이터 모델: 프로젝트 / 레이어 / 편집 히스토리
export const EMPTY = -1;

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function newLayer(name, size) {
  return { name, visible: true, data: new Array(size).fill(EMPTY) };
}

export function newProject(name = '새 맵') {
  return {
    version: 1,
    id: uid('proj'),
    name,
    // tileset: { name, tileWidth, tileHeight, margin, spacing, columns, rows, imageWidth, imageHeight }
    tileset: null,
    map: { width: 40, height: 30, layers: [newLayer('레이어 1', 40 * 30)] },
    tags: [],      // [{id, name, color}]
    tileTags: {},  // { gid(string): [tagId, ...] }
  };
}

export function makeTileset(imageName, imageWidth, imageHeight, tileWidth, tileHeight, margin, spacing) {
  const columns = Math.max(1, Math.floor((imageWidth - margin * 2 + spacing) / (tileWidth + spacing)));
  const rows = Math.max(1, Math.floor((imageHeight - margin * 2 + spacing) / (tileHeight + spacing)));
  return { name: imageName, tileWidth, tileHeight, margin, spacing, columns, rows, imageWidth, imageHeight };
}

export function resizeMap(project, w, h) {
  const { map } = project;
  for (const layer of map.layers) {
    const nd = new Array(w * h).fill(EMPTY);
    const mw = Math.min(w, map.width), mh = Math.min(h, map.height);
    for (let y = 0; y < mh; y++)
      for (let x = 0; x < mw; x++)
        nd[y * w + x] = layer.data[y * map.width + x];
    layer.data = nd;
  }
  map.width = w;
  map.height = h;
}

export const mod = (n, m) => ((n % m) + m) % m;

// ── 타일 방향(뒤집기/회전) 플래그 ──────────────────────────────
// gid 상위 비트에 인코딩 (부호 비트는 사용하지 않아 -1(빈칸) 판정과 안전하게 공존)
// 렌더링 순서: 대각 뒤집기(축 교환) → 좌우 뒤집기 → 상하 뒤집기
export const FLIP_D = 1 << 28; // 대각(축 교환)
export const FLIP_V = 1 << 29; // 상하
export const FLIP_H = 1 << 30; // 좌우
export const GID_MASK = FLIP_D - 1;

// (h,v,d) → 2×2 행렬 [m00,m01,m10,m11] (y-아래 화면 좌표계)
function matOf(h, v, d) {
  const a = d ? 0 : 1, b = d ? 1 : 0;
  const fx = h ? -1 : 1, fy = v ? -1 : 1;
  return [fx * a, fx * b, fy * b, fy * a];
}

const mulMat = (A, B) => [
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
];

const FLAG_LUT = new Map();
for (const h of [0, 1]) for (const v of [0, 1]) for (const d of [0, 1])
  FLAG_LUT.set(matOf(h, v, d).join(','), (h ? FLIP_H : 0) | (v ? FLIP_V : 0) | (d ? FLIP_D : 0));

const OPS = {
  h: [-1, 0, 0, 1],  // 좌우 뒤집기
  v: [1, 0, 0, -1],  // 상하 뒤집기
  r: [0, -1, 1, 0],  // 시계방향 90° 회전
};

// gid의 방향 플래그로부터 렌더링 행렬을 얻는다 (플래그 없으면 null)
export function orientMatrix(gid) {
  const flags = gid & ~GID_MASK;
  if (!flags) return null;
  return matOf(gid & FLIP_H ? 1 : 0, gid & FLIP_V ? 1 : 0, gid & FLIP_D ? 1 : 0);
}

export function transformGid(gid, op) {
  if (gid < 0) return gid;
  const m = mulMat(OPS[op],
    matOf(gid & FLIP_H ? 1 : 0, gid & FLIP_V ? 1 : 0, gid & FLIP_D ? 1 : 0));
  return (gid & GID_MASK) | FLAG_LUT.get(m.join(','));
}

// 스탬프 전체를 뒤집기/회전 (격자 재배열 + 각 타일 방향 합성)
export function transformStamp(stamp, op) {
  const { w, h, gids } = stamp;
  const out = [];
  if (op === 'h') {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        out.push(transformGid(gids[y * w + (w - 1 - x)], op));
    return { w, h, gids: out };
  }
  if (op === 'v') {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        out.push(transformGid(gids[(h - 1 - y) * w + x], op));
    return { w, h, gids: out };
  }
  // 시계방향 90° 회전: 크기 w×h → h×w
  const nw = h, nh = w;
  for (let ny = 0; ny < nh; ny++)
    for (let nx = 0; nx < nw; nx++)
      out.push(transformGid(gids[(h - 1 - nx) * w + ny], op));
  return { w: nw, h: nh, gids: out };
}

// 셀 단위 편집 히스토리 (스트로크 단위로 begin/commit)
export class History {
  constructor(limit = 200) {
    this.undoStack = [];
    this.redoStack = [];
    this.limit = limit;
    this.pending = null;
  }
  begin() { this.pending = new Map(); }
  record(layerIdx, cellIdx, before, after) {
    if (!this.pending) return;
    const k = layerIdx + ':' + cellIdx;
    const e = this.pending.get(k);
    if (e) e.after = after;
    else this.pending.set(k, { layerIdx, cellIdx, before, after });
  }
  commit() {
    if (this.pending && this.pending.size) {
      this.undoStack.push([...this.pending.values()]);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.pending = null;
  }
  undo(project) {
    const patch = this.undoStack.pop();
    if (!patch) return false;
    for (const e of patch) project.map.layers[e.layerIdx].data[e.cellIdx] = e.before;
    this.redoStack.push(patch);
    return true;
  }
  redo(project) {
    const patch = this.redoStack.pop();
    if (!patch) return false;
    for (const e of patch) project.map.layers[e.layerIdx].data[e.cellIdx] = e.after;
    this.undoStack.push(patch);
    return true;
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this.pending = null; }
}
