// IndexedDB 저장소 — 타일셋 이미지(Blob)는 기기 밖으로 나가지 않는다.
const DB_NAME = 'tilemapeditor';
const DB_VER = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export async function saveProject(project, imageBlob) {
  const db = await open();
  const record = {
    id: project.id,
    name: project.name,
    updatedAt: Date.now(),
    data: JSON.parse(JSON.stringify(project)),
    image: imageBlob || null,
  };
  await tx(db, 'projects', 'readwrite', s => s.put(record));
  await setMeta('lastProjectId', project.id);
}

export async function loadProject(id) {
  const db = await open();
  return tx(db, 'projects', 'readonly', s => s.get(id));
}

export async function listProjects() {
  const db = await open();
  const all = await tx(db, 'projects', 'readonly', s => s.getAll());
  return (all || [])
    .map(r => ({ id: r.id, name: r.name, updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id) {
  const db = await open();
  await tx(db, 'projects', 'readwrite', s => s.delete(id));
}

export async function setMeta(key, value) {
  const db = await open();
  await tx(db, 'meta', 'readwrite', s => s.put(value, key));
}

export async function getMeta(key) {
  const db = await open();
  return tx(db, 'meta', 'readonly', s => s.get(key));
}
