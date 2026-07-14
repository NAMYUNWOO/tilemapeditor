// 맵 캔버스 에디터: 도구 적용 + 팬/핀치줌.
// 기본 모드: Apple Pencil(pen)/마우스 = 그리기, 손가락 = 이동/줌. (☝️ 토글로 손가락 그리기 허용)
import { EMPTY, mod, GID_MASK, orientMatrix } from './model.js';

const MIN_SCALE = 0.2, MAX_SCALE = 24;

export class Editor {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.cam = { x: 0, y: 0, scale: 2 };
    this.pointers = new Map(); // pointerId -> {x, y, type}
    this.pinch = null;         // {startDist, startScale, startMidWorld}
    this.panPointer = null;
    this.panLast = null;
    this.stroke = null;        // {pointerId, anchor, last, erase}
    this.rectDrag = null;      // {pointerId, x0, y0, x1, y1}
    this.hover = null;         // 셀 좌표 (pen/mouse)
    this._raf = 0;

    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', e => this.onUp(e));
    canvas.addEventListener('pointerleave', e => {
      if (!this.pointers.has(e.pointerId)) { this.hover = null; this.requestRender(); }
    });
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  // ── 좌표 변환 ──────────────────────────────────────────────
  screenToWorld(px, py) {
    return { x: px / this.cam.scale + this.cam.x, y: py / this.cam.scale + this.cam.y };
  }
  cellAt(px, py) {
    const ts = this.app.project?.tileset;
    if (!ts) return null;
    const w = this.screenToWorld(px, py);
    return { x: Math.floor(w.x / ts.tileWidth), y: Math.floor(w.y / ts.tileHeight) };
  }
  inMap(c) {
    const m = this.app.project.map;
    return c.x >= 0 && c.y >= 0 && c.x < m.width && c.y < m.height;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.requestRender();
  }

  fit() {
    const p = this.app.project, ts = p?.tileset;
    if (!ts) return;
    const r = this.canvas.parentElement.getBoundingClientRect();
    const mw = p.map.width * ts.tileWidth, mh = p.map.height * ts.tileHeight;
    const scale = Math.min(r.width / mw, r.height / mh) * 0.92;
    this.cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    this.cam.x = mw / 2 - r.width / 2 / this.cam.scale;
    this.cam.y = mh / 2 - r.height / 2 / this.cam.scale;
    this.requestRender();
  }

  zoomAt(px, py, factor) {
    const before = this.screenToWorld(px, py);
    this.cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.cam.scale * factor));
    this.cam.x = before.x - px / this.cam.scale;
    this.cam.y = before.y - py / this.cam.scale;
    this.requestRender();
  }

  zoomCenter(factor) {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.zoomAt(r.width / 2, r.height / 2, factor);
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.01));
    } else {
      this.cam.x += e.deltaX / this.cam.scale;
      this.cam.y += e.deltaY / this.cam.scale;
      this.requestRender();
    }
  }

  // ── 포인터 ──────────────────────────────────────────────
  touchPoints() {
    return [...this.pointers.entries()].filter(([, p]) => p.type === 'touch');
  }

  onDown(e) {
    if (!this.app.project?.tileset) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 이미 해제된 포인터 */ }
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY, type: e.pointerType });

    if (e.pointerType === 'touch') {
      const touches = this.touchPoints();
      if (touches.length === 2) {
        // 핀치 시작: 진행 중이던 손가락 스트로크/팬은 정리
        this.finishStroke();
        this.cancelRect();
        this.panPointer = null;
        this.startPinch();
        return;
      }
      if (touches.length > 2) return;
      // 단일 손가락
      if (this.app.fingerDraws && this.app.tool !== 'pan') this.beginTool(e);
      else this.beginPan(e);
      return;
    }

    // pen / mouse
    const panButton = e.pointerType === 'mouse' && (e.button === 1 || e.button === 2);
    if (this.app.tool === 'pan' || panButton) this.beginPan(e);
    else this.beginTool(e);
  }

  onMove(e) {
    const rec = this.pointers.get(e.pointerId);
    if (rec) { rec.x = e.offsetX; rec.y = e.offsetY; }

    if (e.pointerType !== 'touch') {
      this.hover = this.cellAt(e.offsetX, e.offsetY);
      this.requestRender();
    }

    if (this.pinch) { this.movePinch(); return; }
    if (this.panPointer === e.pointerId) { this.movePan(e); return; }
    if (this.stroke && this.stroke.pointerId === e.pointerId) this.moveStroke(e);
    else if (this.rectDrag && this.rectDrag.pointerId === e.pointerId) this.moveRect(e);
  }

  onUp(e) {
    const wasPinch = !!this.pinch;
    this.pointers.delete(e.pointerId);

    if (this.pinch) {
      const touches = this.touchPoints();
      if (touches.length < 2) {
        this.pinch = null;
        // 남은 손가락 하나는 팬으로 전환
        if (touches.length === 1) {
          this.panPointer = touches[0][0];
          this.panLast = { x: touches[0][1].x, y: touches[0][1].y };
        }
      }
      return;
    }
    if (this.panPointer === e.pointerId) { this.panPointer = null; this.panLast = null; return; }
    if (this.stroke && this.stroke.pointerId === e.pointerId) { this.finishStroke(); return; }
    if (this.rectDrag && this.rectDrag.pointerId === e.pointerId) {
      if (e.type === 'pointercancel') this.cancelRect();
      else this.commitRect(e);
    }
    if (wasPinch) this.requestRender();
  }

  beginPan(e) {
    this.panPointer = e.pointerId;
    this.panLast = { x: e.offsetX, y: e.offsetY };
  }
  movePan(e) {
    if (!this.panLast) return;
    this.cam.x -= (e.offsetX - this.panLast.x) / this.cam.scale;
    this.cam.y -= (e.offsetY - this.panLast.y) / this.cam.scale;
    this.panLast = { x: e.offsetX, y: e.offsetY };
    this.requestRender();
  }

  startPinch() {
    const [[, a], [, b]] = this.touchPoints();
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = { startDist: dist, startScale: this.cam.scale, startMidWorld: this.screenToWorld(mid.x, mid.y) };
  }
  movePinch() {
    const touches = this.touchPoints();
    if (touches.length < 2) return;
    const [[, a], [, b]] = touches;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.cam.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.pinch.startScale * dist / this.pinch.startDist));
    this.cam.x = this.pinch.startMidWorld.x - mid.x / this.cam.scale;
    this.cam.y = this.pinch.startMidWorld.y - mid.y / this.cam.scale;
    this.requestRender();
  }

  // ── 도구 ──────────────────────────────────────────────
  beginTool(e) {
    const cell = this.cellAt(e.offsetX, e.offsetY);
    if (!cell) return;
    const tool = this.app.tool;

    if (tool === 'picker') { this.app.pickAt(cell); return; }
    if (tool === 'fill') { this.app.floodFill(cell); this.requestRender(); return; }
    if (tool === 'rect') {
      this.rectDrag = { pointerId: e.pointerId, x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y };
      this.requestRender();
      return;
    }
    if (tool === 'brush' || tool === 'erase' || tool === 'transform') {
      this.app.history.begin();
      this.stroke = {
        pointerId: e.pointerId, anchor: cell, last: cell,
        erase: tool === 'erase', transform: tool === 'transform',
        visited: new Set(),
      };
      this.app.applyBrush(cell, this.stroke);
      this.requestRender();
    }
  }

  moveStroke(e) {
    const cell = this.cellAt(e.offsetX, e.offsetY);
    if (!cell) return;
    const s = this.stroke;
    if (cell.x === s.last.x && cell.y === s.last.y) return;
    // Bresenham으로 빠른 드래그의 틈 메우기
    let { x: x0, y: y0 } = s.last;
    const { x: x1, y: y1 } = cell;
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    while (x0 !== x1 || y0 !== y1) {
      const e2 = err * 2;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
      this.app.applyBrush({ x: x0, y: y0 }, s);
    }
    s.last = cell;
    this.requestRender();
  }

  finishStroke() {
    if (!this.stroke) return;
    this.stroke = null;
    this.app.history.commit();
    this.app.onEdited();
    this.requestRender();
  }

  moveRect(e) {
    const cell = this.cellAt(e.offsetX, e.offsetY);
    if (!cell) return;
    this.rectDrag.x1 = cell.x;
    this.rectDrag.y1 = cell.y;
    this.requestRender();
  }
  cancelRect() { this.rectDrag = null; this.requestRender(); }
  commitRect() {
    const r = this.rectDrag;
    this.rectDrag = null;
    if (r) this.app.applyRect(r);
    this.requestRender();
  }

  // ── 렌더링 ──────────────────────────────────────────────
  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  drawTile(ctx, ts, img, gid, dx, dy) {
    const base = gid & GID_MASK;
    const sx = ts.margin + (base % ts.columns) * (ts.tileWidth + ts.spacing);
    const sy = ts.margin + Math.floor(base / ts.columns) * (ts.tileHeight + ts.spacing);
    const tw = ts.tileWidth, th = ts.tileHeight;
    const m = orientMatrix(gid);
    if (!m) {
      ctx.drawImage(img, sx, sy, tw, th, dx, dy, tw, th);
      return;
    }
    ctx.save();
    ctx.translate(dx + tw / 2, dy + th / 2);
    ctx.transform(m[0], m[2], m[1], m[3], 0, 0);
    ctx.drawImage(img, sx, sy, tw, th, -tw / 2, -th / 2, tw, th);
    ctx.restore();
  }

  render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const p = this.app.project, ts = p?.tileset, img = this.app.tilesetImage;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#111118';
    ctx.fillRect(0, 0, W, H);
    if (!ts || !img) return;

    const { scale } = this.cam;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, -this.cam.x * scale * dpr, -this.cam.y * scale * dpr);
    ctx.imageSmoothingEnabled = false;

    const tw = ts.tileWidth, th = ts.tileHeight;
    const m = p.map;
    const mapW = m.width * tw, mapH = m.height * th;

    // 맵 배경
    ctx.fillStyle = '#1c1d26';
    ctx.fillRect(0, 0, mapW, mapH);

    // 보이는 셀 범위
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(W, H);
    const cx0 = Math.max(0, Math.floor(tl.x / tw)), cy0 = Math.max(0, Math.floor(tl.y / th));
    const cx1 = Math.min(m.width - 1, Math.floor(br.x / tw)), cy1 = Math.min(m.height - 1, Math.floor(br.y / th));

    for (const layer of m.layers) {
      if (!layer.visible) continue;
      const d = layer.data;
      for (let y = cy0; y <= cy1; y++)
        for (let x = cx0; x <= cx1; x++) {
          const gid = d[y * m.width + x];
          if (gid >= 0) this.drawTile(ctx, ts, img, gid, x * tw, y * th);
        }
    }

    const px = 1 / scale;

    // 격자
    if (this.app.showGrid && scale * tw >= 6) {
      ctx.strokeStyle = 'rgba(255,255,255,.09)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let x = cx0; x <= cx1 + 1; x++) { ctx.moveTo(x * tw, cy0 * th); ctx.lineTo(x * tw, (cy1 + 1) * th); }
      for (let y = cy0; y <= cy1 + 1; y++) { ctx.moveTo(cx0 * tw, y * th); ctx.lineTo((cx1 + 1) * tw, y * th); }
      ctx.stroke();
    }

    // 사각형 도구 미리보기
    if (this.rectDrag) {
      const r = this.rectDrag;
      const rx = Math.min(r.x0, r.x1), ry = Math.min(r.y0, r.y1);
      const rw = Math.abs(r.x1 - r.x0) + 1, rh = Math.abs(r.y1 - r.y0) + 1;
      const stamp = this.app.stamp;
      if (stamp && this.app.tool === 'rect') {
        ctx.globalAlpha = 0.55;
        for (let y = 0; y < rh; y++)
          for (let x = 0; x < rw; x++) {
            const mx = rx + x, my = ry + y;
            if (mx < 0 || my < 0 || mx >= m.width || my >= m.height) continue;
            this.drawTile(ctx, ts, img, stamp.gids[mod(y, stamp.h) * stamp.w + mod(x, stamp.w)], mx * tw, my * th);
          }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = '#5b8cff';
      ctx.lineWidth = px * 2;
      ctx.strokeRect(rx * tw, ry * th, rw * tw, rh * th);
    }

    // 호버 미리보기 (pen/mouse)
    if (this.hover && !this.rectDrag && !this.stroke) {
      const hv = this.hover;
      const stamp = this.app.stamp;
      if (this.app.tool === 'brush' && stamp) {
        ctx.globalAlpha = 0.5;
        for (let y = 0; y < stamp.h; y++)
          for (let x = 0; x < stamp.w; x++) {
            const mx = hv.x + x, my = hv.y + y;
            if (mx < 0 || my < 0 || mx >= m.width || my >= m.height) continue;
            this.drawTile(ctx, ts, img, stamp.gids[y * stamp.w + x], mx * tw, my * th);
          }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,.5)';
        ctx.lineWidth = px;
        ctx.strokeRect(hv.x * tw, hv.y * th, stamp.w * tw, stamp.h * th);
      } else if (this.app.tool === 'erase') {
        const s = this.app.eraserSize;
        ctx.strokeStyle = '#ff7b5b';
        ctx.lineWidth = px * 2;
        ctx.strokeRect(hv.x * tw, hv.y * th, s * tw, s * th);
      } else if (['fill', 'rect', 'picker', 'transform'].includes(this.app.tool)) {
        ctx.strokeStyle = 'rgba(255,255,255,.6)';
        ctx.lineWidth = px;
        ctx.strokeRect(hv.x * tw, hv.y * th, tw, th);
      }
    }

    // 맵 외곽선
    ctx.strokeStyle = 'rgba(140,150,200,.5)';
    ctx.lineWidth = px * 2;
    ctx.strokeRect(0, 0, mapW, mapH);

    this.app.updateStatus();
  }
}
