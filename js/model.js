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
