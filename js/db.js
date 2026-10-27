// 本地存储：优先 IndexedDB，不可用时退回 localStorage。数据只存在这台设备上。

const DB_NAME = 'migraine-diary';
const DB_VERSION = 1;
const STORES = { attacks: 'id', days: 'date', meta: 'key' };
const LS_KEY = 'migraine-diary:v1';

let dbPromise = null;
let useLocalStorage = false;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// ---- localStorage fallback ----
function lsRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || { attacks: {}, days: {}, meta: {} }; }
  catch { return { attacks: {}, days: {}, meta: {} }; }
}
function lsWrite(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { console.warn('save failed', e); }
}

export async function loadAll() {
  try {
    await openDB();
    const [attacks, days, meta] = await Promise.all(
      ['attacks', 'days', 'meta'].map(name => tx(name, 'readonly', s => s.getAll()))
    );
    return { attacks, days, meta };
  } catch (e) {
    console.warn('IndexedDB unavailable, using localStorage', e);
    useLocalStorage = true;
    const d = lsRead();
    return { attacks: Object.values(d.attacks), days: Object.values(d.days), meta: Object.values(d.meta) };
  }
}

export async function put(store, value) {
  if (useLocalStorage) {
    const d = lsRead();
    d[store][value[STORES[store]]] = value;
    return lsWrite(d);
  }
  return tx(store, 'readwrite', s => s.put(value));
}

export async function remove(store, key) {
  if (useLocalStorage) {
    const d = lsRead();
    delete d[store][key];
    return lsWrite(d);
  }
  return tx(store, 'readwrite', s => s.delete(key));
}

export async function clearAll() {
  if (useLocalStorage) return lsWrite({ attacks: {}, days: {}, meta: {} });
  for (const name of Object.keys(STORES)) await tx(name, 'readwrite', s => s.clear());
}

export async function putMany(store, values) {
  if (useLocalStorage) {
    const d = lsRead();
    for (const v of values) d[store][v[STORES[store]]] = v;
    return lsWrite(d);
  }
  return tx(store, 'readwrite', s => { for (const v of values) s.put(v); });
}

// 请求持久化存储，降低系统清理数据的可能
export async function requestPersist() {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}
