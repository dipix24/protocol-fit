const DB_NAME = 'protocolfit-v2';
const DB_VERSION = 2;
const FALLBACK_PREFIX = 'protocolfit.v2.fallback.';
let dbPromise;
let fallback = false;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

async function openDatabase() {
  if (fallback) return null;
  if (!('indexedDB' in window)) {
    fallback = true;
    return null;
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('history')) {
          const store = db.createObjectStore('history', { keyPath: 'id' });
          store.createIndex('endedAt', 'endedAt');
          store.createIndex('workoutId', 'workoutId');
          store.createIndex('programWeek', 'programWeek');
        }
        if (!db.objectStoreNames.contains('readiness')) {
          const store = db.createObjectStore('readiness', { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('measurements')) {
          const store = db.createObjectStore('measurements', { keyPath: 'id' });
          store.createIndex('date', 'date');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Database blocked'));
    }).catch((error) => {
      console.warn('IndexedDB non disponibile, uso localStorage.', error);
      fallback = true;
      return null;
    });
  }
  return dbPromise;
}

function fallbackRead(store) {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_PREFIX + store) || '[]');
  } catch {
    return [];
  }
}

function fallbackWrite(store, rows) {
  localStorage.setItem(FALLBACK_PREFIX + store, JSON.stringify(rows));
}

export async function get(storeName, key) {
  const db = await openDatabase();
  if (!db) return fallbackRead(storeName).find((row) => row.key === key || row.id === key) || null;
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise(tx.objectStore(storeName).get(key));
}

export async function getAll(storeName) {
  const db = await openDatabase();
  if (!db) return fallbackRead(storeName);
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise(tx.objectStore(storeName).getAll());
}

export async function put(storeName, value) {
  const db = await openDatabase();
  if (!db) {
    const rows = fallbackRead(storeName);
    const keyField = storeName === 'kv' ? 'key' : 'id';
    const index = rows.findIndex((row) => row[keyField] === value[keyField]);
    if (index >= 0) rows[index] = structuredClone(value);
    else rows.push(structuredClone(value));
    fallbackWrite(storeName, rows);
    return value;
  }
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(value);
  await txDone(tx);
  return value;
}

export async function putMany(storeName, values) {
  if (!values?.length) return;
  const db = await openDatabase();
  if (!db) {
    for (const value of values) await put(storeName, value);
    return;
  }
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  values.forEach((value) => store.put(value));
  await txDone(tx);
}

export async function remove(storeName, key) {
  const db = await openDatabase();
  if (!db) {
    const keyField = storeName === 'kv' ? 'key' : 'id';
    fallbackWrite(storeName, fallbackRead(storeName).filter((row) => row[keyField] !== key));
    return;
  }
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await txDone(tx);
}

export async function clear(storeName) {
  const db = await openDatabase();
  if (!db) {
    fallbackWrite(storeName, []);
    return;
  }
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).clear();
  await txDone(tx);
}

export async function getValue(key, fallbackValue = null) {
  const row = await get('kv', key);
  return row ? row.value : fallbackValue;
}

export async function setValue(key, value) {
  return put('kv', { key, value, updatedAt: new Date().toISOString() });
}

export async function clearEverything() {
  await Promise.all(['kv', 'history', 'readiness', 'measurements'].map(clear));
}

export async function storageMode() {
  await openDatabase();
  return fallback ? 'localStorage' : 'IndexedDB';
}
