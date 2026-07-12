// 타일셋 팔레트: 탭=단일 선택, 펜슬/마우스 드래그=사각형 다중 선택(스탬프)
export class Palette {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.sel = { x: 0, y: 0, w: 1, h: 1 };
    this.filterTagId = null;
    this.drag = null; // {pointerId, start:{x,y}}
    this.scale = 1;

    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  ts() { return this.app.project?.tileset || null; }

  tileAt(offX, offY) {
    const ts = this.ts();
    if (!ts) return null;
    const px = offX / this.scale, py = offY / this.scale;
    const x = Math.floor((px - ts.margin) / (ts.tileWidth + ts.spacing));
    const y = Math.floor((py - ts.margin) / (ts.tileHeight + ts.spacing));
    if (x < 0 || y < 0 || x >= ts.columns || y >= ts.rows) return null;
    return { x, y };
  }

  onDown(e) {
    const t = this.tileAt(e.offsetX, e.offsetY);
    if (!t) return;
    // 손가락은 세로 스크롤과 충돌하므로 탭(단일 선택)만, 펜슬/마우스는 드래그 다중 선택
    if (e.pointerType !== 'touch') {
      this.canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
    this.drag = { pointerId: e.pointerId, start: t, type: e.pointerType };
    this.setSel(t.x, t.y, t.x, t.y);
  }

  onMove(e) {
    if (!this.drag || this.drag.pointerId !== e.pointerId) return;
    if (this.drag.type === 'touch') return;
    const t = this.tileAt(e.offsetX, e.offsetY);
    if (!t) return;
    this.setSel(this.drag.start.x, this.drag.start.y, t.x, t.y);
  }

  onUp(e) {
    if (this.drag && this.drag.pointerId === e.pointerId) this.drag = null;
  }

  setSel(x0, y0, x1, y1) {
    this.sel = {
      x: Math.min(x0, x1), y: Math.min(y0, y1),
      w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1,
    };
    this.render();
    this.app.onStampChange();
  }

  selectGid(gid) {
    const ts = this.ts();
    if (!ts) return;
    this.setSel(gid % ts.columns, Math.floor(gid / ts.columns), gid % ts.columns, Math.floor(gid / ts.columns));
  }

  // 현재 선택 영역을 스탬프(패턴)로 변환
  getStamp() {
    const ts = this.ts();
    if (!ts) return null;
    const { x, y, w, h } = this.sel;
    const gids = [];
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        gids.push((y + j) * ts.columns + (x + i));
    return { w, h, gids };
  }

  render() {
    const ts = this.ts();
    const img = this.app.tilesetImage;
    const c = this.canvas, ctx = this.ctx;
    if (!ts || !img) {
      c.width = 1; c.height = 1;
      c.style.height = '0px';
      return;
    }
    const wrapW = c.parentElement.clientWidth || 300;
    const dpr = window.devicePixelRatio || 1;
    this.scale = wrapW / ts.imageWidth;
    c.width = Math.round(ts.imageWidth * this.scale * dpr);
    c.height = Math.round(ts.imageHeight * this.scale * dpr);
    c.style.height = (ts.imageHeight * this.scale) + 'px';

    const s = this.scale * dpr;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, ts.imageWidth, ts.imageHeight);
    // 투명 배경 체크무늬
    ctx.fillStyle = '#101017';
    ctx.fillRect(0, 0, ts.imageWidth, ts.imageHeight);
    ctx.drawImage(img, 0, 0);

    const px = 1 / s; // 화면 1px
    const tileRect = (tx, ty) => [
      ts.margin + tx * (ts.tileWidth + ts.spacing),
      ts.margin + ty * (ts.tileHeight + ts.spacing),
      ts.tileWidth, ts.tileHeight,
    ];

    // 격자
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = px;
    for (let ty = 0; ty < ts.rows; ty++)
      for (let tx = 0; tx < ts.columns; tx++) {
        const [rx, ry, rw, rh] = tileRect(tx, ty);
        ctx.strokeRect(rx + px / 2, ry + px / 2, rw - px, rh - px);
      }

    // 태그 필터: 태그 없는 타일 어둡게 처리
    if (this.filterTagId) {
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      for (let ty = 0; ty < ts.rows; ty++)
        for (let tx = 0; tx < ts.columns; tx++) {
          const gid = ty * ts.columns + tx;
          const tags = this.app.project.tileTags[gid] || [];
          if (!tags.includes(this.filterTagId)) {
            const [rx, ry, rw, rh] = tileRect(tx, ty);
            ctx.fillRect(rx, ry, rw, rh);
          }
        }
    }

    // 타일 태그 점 표시 (최대 3개)
    const tagById = Object.fromEntries(this.app.project.tags.map(t => [t.id, t]));
    for (const [gidStr, tagIds] of Object.entries(this.app.project.tileTags)) {
      if (!tagIds || !tagIds.length) continue;
      const gid = +gidStr;
      const tx = gid % ts.columns, ty = Math.floor(gid / ts.columns);
      if (ty >= ts.rows) continue;
      const [rx, ry] = tileRect(tx, ty);
      const r = Math.max(1.2, ts.tileWidth * 0.09);
      tagIds.slice(0, 3).forEach((tid, i) => {
        const tag = tagById[tid];
        if (!tag) return;
        ctx.fillStyle = tag.color;
        ctx.beginPath();
        ctx.arc(rx + r + 0.5 + i * (r * 2 + 1), ry + r + 0.5, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 선택 영역 강조
    const { x, y, w, h } = this.sel;
    const [sx, sy] = tileRect(x, y);
    const selW = w * ts.tileWidth + (w - 1) * ts.spacing;
    const selH = h * ts.tileHeight + (h - 1) * ts.spacing;
    ctx.strokeStyle = '#5b8cff';
    ctx.lineWidth = px * 2;
    ctx.strokeRect(sx + px, sy + px, selW - px * 2, selH - px * 2);
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = px;
    ctx.strokeRect(sx + px * 3, sy + px * 3, selW - px * 6, selH - px * 6);
  }
}
