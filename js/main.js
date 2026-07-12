import { EMPTY, mod, uid, newProject, newLayer, makeTileset, resizeMap, History } from './model.js';
import * as db from './db.js';
import { Palette } from './palette.js';
import { Editor } from './editor.js';
import { HandwritingPad } from './handwriting.js';

const $ = id => document.getElementById(id);
const TAG_COLORS = ['#ff5b5b', '#ffb84d', '#ffe14d', '#7bd88f', '#4dd2ff', '#5b8cff', '#b98bff', '#ff7bd8', '#63e6be', '#9aa0b4'];

const app = {
  project: null,
  tilesetImage: null, // HTMLImageElement
  tilesetBlob: null,  // Blob (IndexedDB 저장용, 기기 밖으로 나가지 않음)
  tool: 'brush',
  eraserSize: 1,
  fingerDraws: false,
  showGrid: true,
  stamp: null,
  activeLayer: 0,
  history: new History(),
  palette: null,
  editor: null,
};
window.app = app; // 디버깅용

// ─────────────────────────── 저장 ───────────────────────────
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await db.saveProject(app.project, app.tilesetBlob);
      $('saveStatus').textContent = '✓ 자동 저장됨 ' + new Date().toLocaleTimeString();
    } catch (err) {
      $('saveStatus').textContent = '⚠️ 저장 실패: ' + err.message;
    }
  }, 700);
}

app.onEdited = () => { scheduleSave(); };

// ─────────────────────────── 도구 동작 ───────────────────────────
function setCell(layerIdx, x, y, gid) {
  const m = app.project.map;
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return;
  const d = m.layers[layerIdx].data;
  const i = y * m.width + x;
  if (d[i] === gid) return;
  app.history.record(layerIdx, i, d[i], gid);
  d[i] = gid;
}

app.applyBrush = (cell, stroke) => {
  const li = app.activeLayer;
  if (stroke.erase) {
    const s = app.eraserSize;
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++)
        setCell(li, cell.x + x, cell.y + y, EMPTY);
    return;
  }
  const st = app.stamp;
  if (!st) return;
  // 스탬프 블록을 커서 위치에 찍되, 패턴은 스트로크 시작점 기준으로 정렬(드래그 시 이어짐)
  for (let y = 0; y < st.h; y++)
    for (let x = 0; x < st.w; x++) {
      const mx = cell.x + x, my = cell.y + y;
      const gid = st.gids[mod(my - stroke.anchor.y, st.h) * st.w + mod(mx - stroke.anchor.x, st.w)];
      setCell(li, mx, my, gid);
    }
};

app.applyRect = r => {
  const st = app.stamp;
  if (!st) return;
  const m = app.project.map;
  const x0 = Math.max(0, Math.min(r.x0, r.x1)), y0 = Math.max(0, Math.min(r.y0, r.y1));
  const x1 = Math.min(m.width - 1, Math.max(r.x0, r.x1)), y1 = Math.min(m.height - 1, Math.max(r.y0, r.y1));
  app.history.begin();
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      setCell(app.activeLayer, x, y, st.gids[mod(y - y0, st.h) * st.w + mod(x - x0, st.w)]);
  app.history.commit();
  app.onEdited();
};

app.floodFill = cell => {
  const st = app.stamp;
  const m = app.project.map;
  if (!st || cell.x < 0 || cell.y < 0 || cell.x >= m.width || cell.y >= m.height) return;
  const d = m.layers[app.activeLayer].data;
  const target = d[cell.y * m.width + cell.x];
  if (st.w === 1 && st.h === 1 && st.gids[0] === target) return;
  const visited = new Uint8Array(m.width * m.height);
  const queue = [cell.x, cell.y];
  app.history.begin();
  while (queue.length) {
    const y = queue.pop(), x = queue.pop();
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) continue;
    const i = y * m.width + x;
    if (visited[i] || d[i] !== target) continue;
    visited[i] = 1;
    setCell(app.activeLayer, x, y, st.gids[mod(y, st.h) * st.w + mod(x, st.w)]);
    queue.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  app.history.commit();
  app.onEdited();
};

app.pickAt = cell => {
  const m = app.project.map;
  if (cell.x < 0 || cell.y < 0 || cell.x >= m.width || cell.y >= m.height) return;
  const i = cell.y * m.width + cell.x;
  let gid = m.layers[app.activeLayer].data[i];
  if (gid < 0) {
    for (let l = m.layers.length - 1; l >= 0; l--) {
      if (m.layers[l].visible && m.layers[l].data[i] >= 0) { gid = m.layers[l].data[i]; break; }
    }
  }
  if (gid >= 0) {
    app.palette.selectGid(gid);
    setTool('brush');
  }
};

app.onStampChange = () => {
  app.stamp = app.palette.getStamp();
  renderSelInfo();
  app.editor?.requestRender();
};

app.updateStatus = () => {
  const el = $('status');
  const p = app.project;
  if (!p?.tileset) { el.textContent = ''; return; }
  const hv = app.editor.hover;
  const pos = hv ? `(${hv.x}, ${hv.y}) · ` : '';
  el.textContent = `${pos}${p.map.width}×${p.map.height} · ${Math.round(app.editor.cam.scale * 100)}%`;
};

// ─────────────────────────── 툴바 ───────────────────────────
function setTool(tool) {
  app.tool = tool;
  document.querySelectorAll('#toolbar .tool').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  $('eraserSizes').classList.toggle('hidden', tool !== 'erase');
  app.editor?.requestRender();
}

document.querySelectorAll('#toolbar .tool').forEach(b =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));

document.querySelectorAll('#eraserSizes .esize').forEach(b =>
  b.addEventListener('click', () => {
    app.eraserSize = +b.dataset.size;
    document.querySelectorAll('#eraserSizes .esize').forEach(x => x.classList.toggle('active', x === b));
  }));

$('btnFinger').addEventListener('click', () => {
  app.fingerDraws = !app.fingerDraws;
  $('btnFinger').classList.toggle('active', app.fingerDraws);
});
$('btnGrid').addEventListener('click', () => {
  app.showGrid = !app.showGrid;
  $('btnGrid').classList.toggle('active', app.showGrid);
  app.editor.requestRender();
});
$('btnUndo').addEventListener('click', () => { if (app.history.undo(app.project)) { app.editor.requestRender(); scheduleSave(); } });
$('btnRedo').addEventListener('click', () => { if (app.history.redo(app.project)) { app.editor.requestRender(); scheduleSave(); } });
$('btnZoomIn').addEventListener('click', () => app.editor.zoomCenter(1.3));
$('btnZoomOut').addEventListener('click', () => app.editor.zoomCenter(1 / 1.3));
$('btnFit').addEventListener('click', () => app.editor.fit());
$('btnMenu').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
$('editor').addEventListener('pointerdown', () => document.body.classList.remove('sidebar-open'));

window.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  const mod_ = e.metaKey || e.ctrlKey;
  if (mod_ && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) app.history.redo(app.project); else app.history.undo(app.project);
    app.editor.requestRender(); scheduleSave();
    return;
  }
  const keys = { b: 'brush', e: 'erase', g: 'fill', r: 'rect', i: 'picker', h: 'pan' };
  if (keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
  if (e.key === '=' || e.key === '+') app.editor.zoomCenter(1.3);
  if (e.key === '-') app.editor.zoomCenter(1 / 1.3);
  if (e.key === '0') app.editor.fit();
});

// ─────────────────────────── 탭/모달 ───────────────────────────
document.querySelectorAll('#tabs button').forEach(b =>
  b.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'tileset') app.palette.render();
  }));

function openModal(html) {
  const root = $('modalRoot');
  root.innerHTML = `<div class="modal"><button class="tb close">✕</button>${html}</div>`;
  root.classList.remove('hidden');
  root.querySelector('.close').addEventListener('click', closeModal);
  root.addEventListener('pointerdown', e => { if (e.target === root) closeModal(); });
  return root.querySelector('.modal');
}
function closeModal() {
  $('modalRoot').classList.add('hidden');
  $('modalRoot').innerHTML = '';
}

// ─────────────────────────── 타일셋 ───────────────────────────
async function loadImageFromBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

$('tilesetFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  app.tilesetBlob = file;
  app.tilesetImage = await loadImageFromBlob(file);
  $('tilesetName').textContent = `이미지: ${file.name} (${app.tilesetImage.naturalWidth}×${app.tilesetImage.naturalHeight}px)`;
  applyTilesetForm(file.name);
  e.target.value = '';
});

$('tilesetForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!app.tilesetImage) { alert('먼저 타일셋 이미지를 선택하세요.'); return; }
  applyTilesetForm(app.project.tileset?.name || '타일셋');
});

function applyTilesetForm(name) {
  const tw = Math.max(1, +$('tsW').value || 16);
  const th = Math.max(1, +$('tsH').value || 16);
  const margin = Math.max(0, +$('tsMargin').value || 0);
  const spacing = Math.max(0, +$('tsSpacing').value || 0);
  app.project.tileset = makeTileset(name, app.tilesetImage.naturalWidth, app.tilesetImage.naturalHeight, tw, th, margin, spacing);
  const ts = app.project.tileset;
  $('tsInfo').textContent = `${ts.columns} × ${ts.rows} = 타일 ${ts.columns * ts.rows}개`;
  $('editorHint').classList.add('hidden');
  $('tileTagRow').classList.remove('hidden');
  app.palette.setSel?.(0, 0, 0, 0);
  app.palette.render();
  app.onStampChange();
  app.editor.fit();
  scheduleSave();
}

function renderSelInfo() {
  const sel = app.palette.sel, ts = app.project?.tileset;
  if (!ts) { $('selInfo').textContent = ''; return; }
  const gid = sel.y * ts.columns + sel.x;
  $('selInfo').textContent = sel.w === 1 && sel.h === 1
    ? `선택: 타일 #${gid} (${sel.x}, ${sel.y})`
    : `선택: ${sel.w}×${sel.h} 스탬프 (시작 #${gid})`;
  renderTileTagChips();
}

function selectedGids() {
  const ts = app.project.tileset, sel = app.palette.sel;
  const out = [];
  for (let y = 0; y < sel.h; y++)
    for (let x = 0; x < sel.w; x++)
      out.push((sel.y + y) * ts.columns + (sel.x + x));
  return out;
}

function renderTileTagChips() {
  const wrap = $('tileTagChips');
  wrap.innerHTML = '';
  if (!app.project?.tileset) return;
  const gids = selectedGids();
  const ids = new Set();
  gids.forEach(g => (app.project.tileTags[g] || []).forEach(t => ids.add(t)));
  for (const tid of ids) {
    const tag = app.project.tags.find(t => t.id === tid);
    if (!tag) continue;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span class="dot" style="background:${tag.color}"></span>${escapeHtml(tag.name)}`;
    wrap.appendChild(chip);
  }
}

// ─────────────────────────── 태그 ───────────────────────────
function createTag(name) {
  name = name.trim();
  if (!name) return null;
  const exist = app.project.tags.find(t => t.name === name);
  if (exist) return exist;
  const tag = { id: uid('tag'), name, color: TAG_COLORS[app.project.tags.length % TAG_COLORS.length] };
  app.project.tags.push(tag);
  renderTags();
  scheduleSave();
  return tag;
}

function tagUsageCount(tagId) {
  return Object.values(app.project.tileTags).filter(a => a.includes(tagId)).length;
}

function renderTags() {
  const ul = $('tagList');
  ul.innerHTML = '';
  for (const tag of app.project.tags) {
    const li = document.createElement('li');
    li.classList.toggle('filtered', app.palette.filterTagId === tag.id);
    li.innerHTML = `<span class="dot" style="background:${tag.color}"></span>
      <span class="name">${escapeHtml(tag.name)}</span>
      <span class="cnt">타일 ${tagUsageCount(tag.id)}개</span>
      <button class="iconbtn rename">✏️</button>
      <button class="iconbtn del">🗑</button>`;
    li.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      app.palette.filterTagId = app.palette.filterTagId === tag.id ? null : tag.id;
      renderTags();
      app.palette.render();
    });
    li.querySelector('.rename').addEventListener('click', () => {
      const name = prompt('태그 이름 변경', tag.name);
      if (name && name.trim()) { tag.name = name.trim(); renderTags(); renderTileTagChips(); scheduleSave(); }
    });
    li.querySelector('.del').addEventListener('click', () => {
      if (!confirm(`태그 "${tag.name}" 삭제? (타일 지정도 함께 해제됩니다)`)) return;
      app.project.tags = app.project.tags.filter(t => t !== tag);
      for (const k of Object.keys(app.project.tileTags)) {
        app.project.tileTags[k] = app.project.tileTags[k].filter(id => id !== tag.id);
        if (!app.project.tileTags[k].length) delete app.project.tileTags[k];
      }
      if (app.palette.filterTagId === tag.id) app.palette.filterTagId = null;
      renderTags(); renderTileTagChips(); app.palette.render(); scheduleSave();
    });
    ul.appendChild(li);
  }
}

$('btnTagText').addEventListener('click', () => {
  const name = prompt('새 태그 이름');
  if (name) createTag(name);
});

// 손글씨 태그 모달
$('btnTagHand').addEventListener('click', openHandwritingModal);
function openHandwritingModal() {
  const modal = openModal(`
    <h2>✍️ 손글씨로 태그 추가</h2>
    <div class="row">
      <select id="hwLang"><option value="ko">한국어</option><option value="en">English</option></select>
      <button id="hwUndo" class="btn" style="width:auto">한 획 취소</button>
      <button id="hwClear" class="btn" style="width:auto">지우기</button>
    </div>
    <canvas id="hwCanvas"></canvas>
    <div class="hint">Apple Pencil이나 손가락으로 태그 이름을 쓰세요. 쓰기를 멈추면 자동으로 인식합니다.</div>
    <div id="hwCandidates"></div>
    <div class="row">
      <input type="text" id="hwText" placeholder="인식 결과 선택 또는 직접 입력">
      <button id="hwAdd" class="btn primary">태그 추가</button>
    </div>
    <div class="hint">💡 iPadOS에서는 위 입력창에 펜슬로 바로 써도(Scribble) 텍스트로 변환됩니다.</div>
  `);
  const pad = new HandwritingPad(modal.querySelector('#hwCanvas'));
  pad.resize();
  const candBox = modal.querySelector('#hwCandidates');
  const input = modal.querySelector('#hwText');

  let recTimer = 0;
  const scheduleRecognize = () => {
    clearTimeout(recTimer);
    recTimer = setTimeout(runRecognize, 800);
  };
  modal.querySelector('#hwCanvas').addEventListener('pointerup', scheduleRecognize);

  async function runRecognize() {
    if (pad.isEmpty()) return;
    candBox.innerHTML = '<span class="hint">인식 중…</span>';
    try {
      const cands = await pad.recognize(modal.querySelector('#hwLang').value);
      candBox.innerHTML = '';
      if (!cands.length) { candBox.innerHTML = '<span class="hint">인식 결과 없음</span>'; return; }
      if (!input.value) input.value = cands[0];
      cands.slice(0, 8).forEach(c => {
        const b = document.createElement('button');
        b.textContent = c;
        b.addEventListener('click', () => { input.value = c; });
        candBox.appendChild(b);
      });
    } catch (err) {
      candBox.innerHTML = `<span class="hint">⚠️ 인식 실패(네트워크 필요). 아래 입력창에 직접 입력하세요.</span>`;
    }
  }

  modal.querySelector('#hwUndo').addEventListener('click', () => { pad.strokes.pop(); pad.draw(); scheduleRecognize(); });
  modal.querySelector('#hwClear').addEventListener('click', () => { pad.clear(); candBox.innerHTML = ''; input.value = ''; });
  modal.querySelector('#hwAdd').addEventListener('click', () => {
    const tag = createTag(input.value);
    if (tag) closeModal();
  });
}

// 선택 타일에 태그 지정
$('btnAssignTags').addEventListener('click', () => {
  if (!app.project?.tileset) return;
  const gids = selectedGids();
  const rows = app.project.tags.map(tag => {
    const all = gids.every(g => (app.project.tileTags[g] || []).includes(tag.id));
    return `<label class="checkrow"><input type="checkbox" data-id="${tag.id}" ${all ? 'checked' : ''}>
      <span class="dot" style="width:14px;height:14px;border-radius:50%;background:${tag.color}"></span>
      <span>${escapeHtml(tag.name)}</span></label>`;
  }).join('');
  const modal = openModal(`
    <h2>🏷️ 태그 지정 — 타일 ${gids.length}개</h2>
    <div>${rows || '<p class="hint">태그가 없습니다. 아래에서 만들거나 ✍️ 손글씨로 추가하세요.</p>'}</div>
    <div class="row">
      <input type="text" id="quickTag" placeholder="새 태그 이름 (펜슬 Scribble 가능)">
      <button id="quickAdd" class="btn primary">추가+지정</button>
    </div>
  `);
  modal.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', () => {
      for (const g of gids) {
        let arr = app.project.tileTags[g] || [];
        arr = arr.filter(id => id !== cb.dataset.id);
        if (cb.checked) arr.push(cb.dataset.id);
        if (arr.length) app.project.tileTags[g] = arr;
        else delete app.project.tileTags[g];
      }
      renderTags(); renderTileTagChips(); app.palette.render(); scheduleSave();
    }));
  modal.querySelector('#quickAdd').addEventListener('click', () => {
    const tag = createTag(modal.querySelector('#quickTag').value);
    if (!tag) return;
    for (const g of gids) {
      const arr = app.project.tileTags[g] || [];
      if (!arr.includes(tag.id)) arr.push(tag.id);
      app.project.tileTags[g] = arr;
    }
    closeModal();
    renderTags(); renderTileTagChips(); app.palette.render(); scheduleSave();
  });
});

// ─────────────────────────── 맵/레이어 ───────────────────────────
$('mapSizeForm').addEventListener('submit', e => {
  e.preventDefault();
  const w = Math.min(1000, Math.max(1, +$('mapW').value || 40));
  const h = Math.min(1000, Math.max(1, +$('mapH').value || 30));
  resizeMap(app.project, w, h);
  app.history.clear();
  app.editor.fit();
  scheduleSave();
});

function renderLayers() {
  const ul = $('layerList');
  ul.innerHTML = '';
  const layers = app.project.map.layers;
  // 위에 그려지는 레이어가 목록 위쪽에 오도록 역순 표시
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const li = document.createElement('li');
    li.classList.toggle('active', i === app.activeLayer);
    li.innerHTML = `<button class="iconbtn vis">${layer.visible ? '👁' : '🚫'}</button>
      <span class="name">${escapeHtml(layer.name)}</span>
      <button class="iconbtn up">↑</button>
      <button class="iconbtn down">↓</button>
      <button class="iconbtn del">🗑</button>`;
    li.querySelector('.name').addEventListener('click', () => { app.activeLayer = i; renderLayers(); });
    li.querySelector('.name').addEventListener('dblclick', () => {
      const name = prompt('레이어 이름', layer.name);
      if (name && name.trim()) { layer.name = name.trim(); renderLayers(); scheduleSave(); }
    });
    li.querySelector('.vis').addEventListener('click', () => {
      layer.visible = !layer.visible;
      renderLayers(); app.editor.requestRender(); scheduleSave();
    });
    li.querySelector('.up').addEventListener('click', () => moveLayer(i, 1));
    li.querySelector('.down').addEventListener('click', () => moveLayer(i, -1));
    li.querySelector('.del').addEventListener('click', () => {
      if (layers.length <= 1) { alert('레이어는 최소 1개 필요합니다.'); return; }
      if (!confirm(`레이어 "${layer.name}" 삭제?`)) return;
      layers.splice(i, 1);
      app.activeLayer = Math.min(app.activeLayer, layers.length - 1);
      app.history.clear();
      renderLayers(); app.editor.requestRender(); scheduleSave();
    });
    ul.appendChild(li);
  }
}

function moveLayer(i, dir) {
  const layers = app.project.map.layers;
  const j = i + dir;
  if (j < 0 || j >= layers.length) return;
  [layers[i], layers[j]] = [layers[j], layers[i]];
  if (app.activeLayer === i) app.activeLayer = j;
  else if (app.activeLayer === j) app.activeLayer = i;
  app.history.clear();
  renderLayers(); app.editor.requestRender(); scheduleSave();
}

$('btnAddLayer').addEventListener('click', () => {
  const m = app.project.map;
  m.layers.push(newLayer('레이어 ' + (m.layers.length + 1), m.width * m.height));
  app.activeLayer = m.layers.length - 1;
  renderLayers(); scheduleSave();
});

// ─────────────────────────── 프로젝트 ───────────────────────────
$('projName').addEventListener('change', () => {
  app.project.name = $('projName').value.trim() || '이름 없음';
  scheduleSave();
});

$('btnNewProj').addEventListener('click', async () => {
  if (!confirm('새 프로젝트를 만들까요? (현재 프로젝트는 자동 저장되어 있습니다)')) return;
  const keepTs = app.project?.tileset && confirm('현재 타일셋을 새 프로젝트에서도 사용할까요?');
  const p = newProject();
  if (keepTs) p.tileset = JSON.parse(JSON.stringify(app.project.tileset));
  else { app.tilesetImage = null; app.tilesetBlob = null; }
  await setProject(p, keepTs ? app.tilesetBlob : null);
  scheduleSave();
});

$('btnOpenProj').addEventListener('click', async () => {
  const list = await db.listProjects();
  const rows = list.map(r => `
    <div class="checkrow" data-id="${r.id}">
      <span style="flex:1">${escapeHtml(r.name)}${r.id === app.project.id ? ' <b>(현재)</b>' : ''}</span>
      <span class="hint">${new Date(r.updatedAt).toLocaleString()}</span>
      <button class="iconbtn pdel" data-id="${r.id}">🗑</button>
    </div>`).join('');
  const modal = openModal(`<h2>📁 프로젝트 목록</h2>${rows || '<p class="hint">저장된 프로젝트가 없습니다.</p>'}`);
  modal.querySelectorAll('.checkrow').forEach(row =>
    row.addEventListener('click', async e => {
      if (e.target.closest('.pdel')) return;
      const rec = await db.loadProject(row.dataset.id);
      if (rec) { await openRecord(rec); closeModal(); }
    }));
  modal.querySelectorAll('.pdel').forEach(b =>
    b.addEventListener('click', async () => {
      if (!confirm('이 프로젝트를 삭제할까요?')) return;
      await db.deleteProject(b.dataset.id);
      b.closest('.checkrow').remove();
    }));
});

async function openRecord(rec) {
  const blob = rec.image || null;
  app.tilesetBlob = blob;
  app.tilesetImage = blob ? await loadImageFromBlob(blob) : null;
  await setProject(rec.data, blob);
}

async function setProject(p, blob) {
  app.project = p;
  app.tilesetBlob = blob || null;
  app.activeLayer = 0;
  app.history.clear();
  app.palette.filterTagId = null;

  $('projName').value = p.name;
  $('mapW').value = p.map.width;
  $('mapH').value = p.map.height;
  if (p.tileset) {
    $('tsW').value = p.tileset.tileWidth;
    $('tsH').value = p.tileset.tileHeight;
    $('tsMargin').value = p.tileset.margin;
    $('tsSpacing').value = p.tileset.spacing;
    $('tsInfo').textContent = `${p.tileset.columns} × ${p.tileset.rows} = 타일 ${p.tileset.columns * p.tileset.rows}개`;
    $('tilesetName').textContent = app.tilesetImage
      ? `이미지: ${p.tileset.name}`
      : `⚠️ "${p.tileset.name}" 이미지가 이 기기에 없습니다. 위 버튼으로 다시 선택하세요.`;
  } else {
    $('tsInfo').textContent = '';
    $('tilesetName').textContent = '';
  }
  $('editorHint').classList.toggle('hidden', !!(p.tileset && app.tilesetImage));
  $('tileTagRow').classList.toggle('hidden', !p.tileset);

  renderTags();
  renderLayers();
  app.palette.render();
  app.onStampChange();
  app.editor.fit();
  await db.setMeta('lastProjectId', p.id);
}

// ─────────────────────────── 내보내기/가져오기 ───────────────────────────
function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportObject() {
  const p = app.project;
  return {
    type: 'tilemap',
    version: 1,
    name: p.name,
    tileset: p.tileset,   // 메타데이터만 (이미지 없음)
    map: p.map,
    tags: p.tags,
    tileTags: p.tileTags,
  };
}

$('btnExportJson').addEventListener('click', () => {
  if (!app.project.tileset) { alert('타일셋을 먼저 설정하세요.'); return; }
  download(app.project.name + '.json', JSON.stringify(exportObject()));
});

$('btnExportFull').addEventListener('click', async () => {
  if (!app.project.tileset || !app.tilesetBlob) { alert('타일셋 이미지가 필요합니다.'); return; }
  if (!confirm('⚠️ 이 백업 파일에는 유료 타일셋 이미지가 포함됩니다.\n절대 공개된 곳(저장소, 웹 등)에 올리지 마세요.\n계속할까요?')) return;
  const dataURL = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(app.tilesetBlob);
  });
  const obj = exportObject();
  obj.imageDataURL = dataURL;
  download(app.project.name + '.backup.json', JSON.stringify(obj));
});

$('importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (obj.type !== 'tilemap' || !obj.map) throw new Error('타일맵 JSON 형식이 아닙니다.');
    const p = newProject(obj.name || '가져온 맵');
    p.tileset = obj.tileset || null;
    p.map = obj.map;
    p.tags = obj.tags || [];
    p.tileTags = obj.tileTags || {};
    let blob = null;
    if (obj.imageDataURL) blob = await (await fetch(obj.imageDataURL)).blob();
    app.tilesetImage = blob ? await loadImageFromBlob(blob) : null;
    await setProject(p, blob);
    scheduleSave();
    if (p.tileset && !blob) alert(`맵을 불러왔습니다.\n타일셋 이미지 "${p.tileset.name}"는 포함되어 있지 않으니 타일셋 탭에서 다시 선택하세요.`);
  } catch (err) {
    alert('가져오기 실패: ' + err.message);
  }
});

// ─────────────────────────── 유틸/초기화 ───────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function init() {
  app.palette = new Palette($('palette'), app);
  app.editor = new Editor($('editor'), app);

  let rec = null;
  try {
    const lastId = await db.getMeta('lastProjectId');
    if (lastId) rec = await db.loadProject(lastId);
  } catch { /* 첫 실행 */ }

  if (rec) await openRecord(rec);
  else await setProject(newProject(), null);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
