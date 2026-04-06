const DB_NAME = 'lab6_activity_db';
const STORE_NAME = 'site_stats';
const ACTIVE_GAP_MS = 30000;
const NEW_VISIT_GAP_MS = 15 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'host' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getSiteStat(host) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(host);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function saveSiteStat(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE_NAME).put(record);
  });
}

async function listTopSites(limit = 10) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const rows = Array.isArray(req.result) ? req.result : [];
      rows.sort((a, b) => (b.totalMs || 0) - (a.totalMs || 0));
      resolve(rows.slice(0, limit));
    };
    req.onerror = () => reject(req.error);
  });
}

function toHost(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/i.test(u.protocol)) return '';
    return u.hostname || '';
  } catch (_) {
    return '';
  }
}

async function registerActivity(rawUrl, ts) {
  const host = toHost(rawUrl);
  if (!host) return;

  const now = Number(ts) || Date.now();
  const prev = (await getSiteStat(host)) || {
    host,
    totalMs: 0,
    visits: 0,
    lastActivityAt: 0,
    lastVisitAt: 0,
  };

  const diff = prev.lastActivityAt > 0 ? now - prev.lastActivityAt : 0;
  const addMs = diff > 0 ? Math.min(diff, ACTIVE_GAP_MS) : 0;
  const isNewVisit = !prev.lastVisitAt || now - prev.lastVisitAt > NEW_VISIT_GAP_MS;

  const next = {
    ...prev,
    host,
    totalMs: Math.max(0, (prev.totalMs || 0) + addMs),
    visits: (prev.visits || 0) + (isNewVisit ? 1 : 0),
    lastVisitAt: isNewVisit ? now : prev.lastVisitAt || now,
    lastActivityAt: now,
  };

  await saveSiteStat(next);
}

function formatStatRow(row) {
  if (!row) return null;
  return {
    host: row.host,
    totalMs: row.totalMs || 0,
    totalMinutes: Number(((row.totalMs || 0) / 60000).toFixed(2)),
    visits: row.visits || 0,
    lastActivityAt: row.lastActivityAt || 0,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  if (message.type === 'open-check-panel' && message.url) {
    const target = chrome.runtime.getURL(`panel.html?fileUrl=${encodeURIComponent(message.url)}`);
    chrome.tabs.create({ url: target });
    return;
  }

  if (message.type === 'site-activity') {
    registerActivity(message.url, message.ts).catch(() => {});
    return;
  }

  if (message.type === 'get-site-stats') {
    getSiteStat(String(message.host || ''))
      .then((row) => sendResponse({ ok: true, stat: formatStatRow(row) }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : 'DB error' }));
    return true;
  }

  if (message.type === 'get-top-sites') {
    const limit = Number(message.limit) > 0 ? Number(message.limit) : 10;
    listTopSites(limit)
      .then((rows) => sendResponse({ ok: true, items: rows.map((r) => formatStatRow(r)) }))
      .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : 'DB error' }));
    return true;
  }
});
