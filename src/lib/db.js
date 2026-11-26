// Minimal IndexedDB layer. Everything stays on the device.
// Stores:
//   docs    {id, name, createdAt, updatedAt, folderId, tags[], pageIds[]}
//   pages   {id, docId, createdAt, quad, rotation, filter, aspect, width, height, hasOriginal, ocr}
//   blobs   key "<pageId>:orig" | ":proc" | ":thumb"  → Blob
//   folders {id, name, createdAt}
//   kv      settings and app state
const DB_NAME = 'papersnap';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async get(name, key) { return done((await store(name)).get(key)); },
  async all(name) { return done((await store(name)).getAll()); },
  async put(name, value, key) { return done((await store(name, 'readwrite')).put(value, key)); },
  async del(name, key) { return done((await store(name, 'readwrite')).delete(key)); },
  async keys(name) { return done((await store(name)).getAllKeys()); },
  async pagesOf(docId) { return done((await store('pages')).index('docId').getAll(docId)); },
  async clear(name) { return done((await store(name, 'readwrite')).clear()); },
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- settings ----
export const DEFAULT_SETTINGS = {
  lang: null,             // null = follow device
  theme: 'dark',          // 'dark' | 'light' | 'system'
  keepOriginals: true,
  originalsDays: 30,      // 0 = keep forever
  autoCapture: true,
  defaultFilter: 'enhance',
  defaultAspect: 'auto',
  ocrEnabled: false,
  ocrLangs: ['eng'],
  ocrAuto: false,
  ocrDownloaded: [],
  lastBackupAt: 0,
  sort: 'new',
};

export async function loadSettings() {
  const s = (await db.get('kv', 'settings')) || {};
  return { ...DEFAULT_SETTINGS, ...s };
}
export async function saveSettings(s) { await db.put('kv', s, 'settings'); }

// ---- documents / pages ----
export function scanName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export async function createDoc(extra = {}) {
  const now = Date.now();
  const doc = { id: uid(), name: scanName(), createdAt: now, updatedAt: now, folderId: null, tags: [], pageIds: [], ...extra };
  await db.put('docs', doc);
  return doc;
}

export async function deletePage(pageId) {
  const page = await db.get('pages', pageId);
  await Promise.all(['orig', 'proc', 'thumb'].map((k) => db.del('blobs', `${pageId}:${k}`)));
  await db.del('pages', pageId);
  if (page) {
    const doc = await db.get('docs', page.docId);
    if (doc) { doc.pageIds = doc.pageIds.filter((id) => id !== pageId); doc.updatedAt = Date.now(); await db.put('docs', doc); }
  }
}

export async function deleteDoc(docId) {
  const doc = await db.get('docs', docId);
  if (!doc) return;
  for (const pid of doc.pageIds) {
    await Promise.all(['orig', 'proc', 'thumb'].map((k) => db.del('blobs', `${pid}:${k}`)));
    await db.del('pages', pid);
  }
  await db.del('docs', docId);
}

// Delete originals older than the retention window (keeps processed pages).
export async function purgeOldOriginals(settings) {
  const keepForever = settings.keepOriginals && !settings.originalsDays;
  if (keepForever) return 0;
  const cutoff = settings.keepOriginals ? Date.now() - settings.originalsDays * 86400000 : Infinity;
  let n = 0;
  for (const p of await db.all('pages')) {
    if (p.hasOriginal && p.createdAt < cutoff) {
      await db.del('blobs', `${p.id}:orig`);
      p.hasOriginal = false;
      await db.put('pages', p);
      n++;
    }
  }
  return n;
}
