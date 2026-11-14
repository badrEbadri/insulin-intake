/*
 * Insulin Intake is a single-page app with no build step or server-side code.
 * Screen markup is rendered from the in-memory `state` object; records are
 * persisted locally in this browser. The function groups below follow that
 * flow: state/storage, backup, date helpers, screen rendering, then actions.
 */
'use strict';

// Stable storage keys: changing these names requires a data migration.
const STORAGE_KEY = 'insulin-intake-vanilla-v1';
const BACKUP_FOLDER_NAME = 'insulin-intake-backups';
const BACKUP_FILE_PREFIX = 'insulin-intake-backup-';
const BACKUP_LIMIT = 10;
const BACKUP_DB_NAME = 'insulin-intake-local-backups-v1';
const BACKUP_STORE_NAME = 'snapshots';

// Navigation and chart options are shared by the desktop and mobile renderers.
const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'insulin', label: 'Insulin', icon: 'insulin' },
  { id: 'weight', label: 'Weight', icon: 'weight' },
  { id: 'charts', label: 'Charts', icon: 'charts' },
  { id: 'history', label: 'History', icon: 'history' },
];
// Reused for chart series and the dashboard's insulin-type legend.
const TYPE_PALETTE = ['#2677d5', '#36b7a2', '#8066c9', '#e29a3b', '#d85c79', '#4c8c78'];
// IDs become data-period values, so keep them in sync with periodBounds().
const PERIODS = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'sixMonths', label: '6 mo' },
  { id: 'year', label: 'Year' },
];

// Cache the page elements used by multiple handlers instead of querying again.
const app = document.querySelector('#app-content');
const recordDialog = document.querySelector('#record-dialog');
const toastElement = document.querySelector('#toast');

// Browser-only transient values; none of these are part of the saved records.
let toastTimer;
let installPromptEvent = null;
let backupDbPromise = null;

/** Return a clean UI state before loading this browser's saved records. */
function freshState() {
  return { doses: [], weights: [], view: 'dashboard', chartPeriod: 'day', weightPeriod: 'month', historyDate: dateKey(new Date()), chartSelection: null, weightSelection: null };
}

/** Load and validate the saved record arrays; ignore corrupt browser storage. */
function loadRecords() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      doses: Array.isArray(saved.doses) ? saved.doses.filter(validDose) : [],
      weights: Array.isArray(saved.weights) ? saved.weights.filter(validWeight) : [],
    };
  } catch {
    return { doses: [], weights: [] };
  }
}

// UI preferences and selections reset on reload; only the record arrays persist.
const state = Object.assign(freshState(), loadRecords());

/** Check the minimum shape required before a saved dose enters app state. */
function validDose(item) {
  return item && Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0 && typeof item.insulinType === 'string' && Number.isFinite(Number(item.units)) && Number(item.units) > 0 && Number.isFinite(new Date(item.takenAt).getTime());
}

/** Check the minimum shape required before a saved weight enters app state. */
function validWeight(item) {
  return item && Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0 && Number.isFinite(Number(item.kilograms)) && Number(item.kilograms) > 0 && Number.isFinite(new Date(item.measuredAt).getTime());
}

/** Persist both record types atomically as one JSON value in localStorage. */
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ doses: state.doses, weights: state.weights }));
    return true;
  } catch {
    showToast('The browser could not save this record. Check available storage.');
    return false;
  }
}

// Automatic backups contain full copies of local records, separate from CSVs.
/** Make an immutable, timestamped snapshot of the current records. */
function makeBackupSnapshot() {
  const savedAt = new Date().toISOString();
  return {
    id: `${savedAt}-${Math.random().toString(36).slice(2, 9)}`,
    savedAt,
    doses: JSON.parse(JSON.stringify(state.doses)),
    weights: JSON.parse(JSON.stringify(state.weights)),
  };
}

/** Build a stable, sortable filename for a snapshot in private file storage. */
function backupFileName(snapshot) {
  const stamp = snapshot.savedAt.replace(/[-:.]/g, '').replace('Z', 'Z');
  const suffix = snapshot.id.slice(-7).replace(/[^a-z0-9]/gi, '');
  return `${BACKUP_FILE_PREFIX}${stamp}-${suffix}.json`;
}

/** Open (or create) the IndexedDB fallback store and reuse its pending promise. */
async function openBackupDatabase() {
  if (backupDbPromise) return backupDbPromise;
  backupDbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available.'));
      return;
    }
    const request = indexedDB.open(BACKUP_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BACKUP_STORE_NAME)) database.createObjectStore(BACKUP_STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local backup storage.'));
  });
  return backupDbPromise;
}

/** Save one automatic snapshot in IndexedDB when private files are unavailable. */
async function storeBackupInIndexedDb(snapshot) {
  const database = await openBackupDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(BACKUP_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(BACKUP_STORE_NAME);
    store.put(snapshot);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Could not save local backup.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not save local backup.'));
  });
}

/** Save one automatic snapshot in the browser's private origin storage. */
async function storeBackupInPrivateFolder(snapshot) {
  if (typeof navigator.storage?.getDirectory !== 'function') throw new Error('Private file storage is unavailable.');
  if (typeof window.FileSystemFileHandle === 'undefined' || typeof window.FileSystemFileHandle.prototype.createWritable !== 'function') {
    throw new Error('Private file writing is unavailable.');
  }
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle(BACKUP_FOLDER_NAME, { create: true });
  const fileHandle = await folder.getFileHandle(backupFileName(snapshot), { create: true });
  try {
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(snapshot));
    await writable.close();
  } catch (error) {
    try { await folder.removeEntry(fileHandle.name); } catch {}
    throw error;
  }
}

/** Save a backup using private files first, then IndexedDB, and keep only ten. */
async function createAutomaticBackup() {
  const snapshot = makeBackupSnapshot();
  try {
    await storeBackupInPrivateFolder(snapshot);
  } catch (error) {
    console.info('Using IndexedDB for this automatic backup.', error);
    await storeBackupInIndexedDb(snapshot);
  }
  await pruneAutomaticBackups(await readStoredBackups());
  if (state.view === 'settings') void renderBackupSnapshots();
}

/** Start backup work without blocking the save form; report failures to the UI. */
function queueAutomaticBackup() {
  void createAutomaticBackup().catch((error) => {
    console.error('Automatic backup failed:', error);
    showToast('Record saved, but its automatic backup failed. Export a CSV backup.');
  });
}

/** Read valid JSON snapshots from the browser's private file-system directory. */
async function readPrivateFolderBackups() {
  if (typeof navigator.storage?.getDirectory !== 'function') return null;
  const root = await navigator.storage.getDirectory();
  let folder;
  try {
    folder = await root.getDirectoryHandle(BACKUP_FOLDER_NAME);
  } catch {
    return [];
  }
  const snapshots = [];
  for await (const entry of folder.values()) {
    if (entry.kind !== 'file' || !entry.name.startsWith(BACKUP_FILE_PREFIX) || !entry.name.endsWith('.json')) continue;
    try {
      const snapshot = JSON.parse(await (await entry.getFile()).text());
      if (snapshot && typeof snapshot.savedAt === 'string' && Array.isArray(snapshot.doses) && Array.isArray(snapshot.weights)) {
        snapshots.push({ ...snapshot, _backupStorage: 'private-folder', _backupFileName: entry.name });
      }
    } catch (error) {
      console.warn('Skipping an unreadable automatic backup.', error);
    }
  }
  return snapshots.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Read every automatic snapshot from IndexedDB and sort newest first. */
async function readIndexedDbBackups() {
  const database = await openBackupDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(BACKUP_STORE_NAME, 'readonly');
    const request = transaction.objectStore(BACKUP_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.map((snapshot) => ({ ...snapshot, _backupStorage: 'indexeddb' })).sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
    request.onerror = () => reject(request.error || new Error('Could not read local backups.'));
  });
}

/** Read from both backup stores so snapshots remain visible after browser changes. */
async function readStoredBackups() {
  const [privateResult, indexedDbResult] = await Promise.allSettled([readPrivateFolderBackups(), readIndexedDbBackups()]);
  const snapshots = [];
  if (privateResult.status === 'fulfilled' && privateResult.value) snapshots.push(...privateResult.value);
  if (indexedDbResult.status === 'fulfilled') snapshots.push(...indexedDbResult.value);
  if (!snapshots.length && privateResult.status === 'rejected' && indexedDbResult.status === 'rejected') {
    throw new Error('Local backup storage is unavailable.');
  }
  return snapshots.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Delete the oldest excess snapshots from their original storage locations. */
async function pruneAutomaticBackups(snapshots) {
  const oldestToRemove = [...snapshots].sort((a, b) => a.savedAt.localeCompare(b.savedAt)).slice(0, Math.max(0, snapshots.length - BACKUP_LIMIT));
  const privateFiles = oldestToRemove.filter((snapshot) => snapshot._backupStorage === 'private-folder');
  const indexedDbIds = oldestToRemove.filter((snapshot) => snapshot._backupStorage === 'indexeddb').map((snapshot) => snapshot.id);

  if (privateFiles.length && typeof navigator.storage?.getDirectory === 'function') {
    try {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle(BACKUP_FOLDER_NAME);
      await Promise.all(privateFiles.map((snapshot) => folder.removeEntry(snapshot._backupFileName)));
    } catch (error) {
      console.warn('Could not prune older private-folder backups.', error);
    }
  }
  if (indexedDbIds.length) {
    try {
      const database = await openBackupDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(BACKUP_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(BACKUP_STORE_NAME);
        indexedDbIds.forEach((id) => store.delete(id));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Could not prune older IndexedDB backups.'));
        transaction.onabort = () => reject(transaction.error || new Error('Could not prune older IndexedDB backups.'));
      });
    } catch (error) {
      console.warn('Could not prune older IndexedDB backups.', error);
    }
  }
}

/** Return at most the ten newest automatic snapshots after pruning old copies. */
async function readAutomaticBackups() {
  const snapshots = await readStoredBackups();
  await pruneAutomaticBackups(snapshots);
  return snapshots.slice(0, BACKUP_LIMIT);
}

// Formatting, date handling, and record ordering helpers used by all screens.
/** Escape user-entered text before inserting it into an HTML template. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

/** Format a local calendar date as the stable YYYY-MM-DD storage key. */
function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Parse a YYYY-MM-DD key as local time and reject impossible dates. */
function parseDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [year, month, day] = value.split('-').map(Number);
  const result = new Date(year, month - 1, day);
  return result.getFullYear() === year && result.getMonth() === month - 1 && result.getDate() === day ? result : null;
}

/** Combine form date/time fields as a local Date, or return null if invalid. */
function localDateTime(dateValue, timeValue) {
  const date = parseDateKey(dateValue);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeValue || '');
  if (!date || !match) return null;
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date;
}

/** Convert an ISO timestamp back into local date and time form values. */
function dateParts(iso) {
  const date = new Date(iso);
  return { date: dateKey(date), time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` };
}

/** Return local midnight boundaries for a single calendar day. */
function dayBounds(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { start, end };
}

/** Return the selected chart period's local-time interval, ending tomorrow. */
function periodBounds(period, now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'week') start.setDate(start.getDate() - 6);
  if (period === 'month') start.setDate(start.getDate() - 29);
  if (period === 'sixMonths') start.setMonth(start.getMonth() - 6);
  if (period === 'year') start.setFullYear(start.getFullYear() - 1);
  return { start, end };
}

/** Test a timestamp against a half-open interval [start, end). */
function inRange(iso, start, end) {
  const time = new Date(iso).getTime();
  return time >= start.getTime() && time < end.getTime();
}

/** Copy and sort doses newest first without mutating the stored array. */
function sortedDoses(doses = state.doses) {
  return [...doses].sort((a, b) => b.takenAt.localeCompare(a.takenAt) || b.id - a.id);
}

/** Copy and sort weight records newest first without mutating stored state. */
function sortedWeights(weights = state.weights) {
  return [...weights].sort((a, b) => b.measuredAt.localeCompare(a.measuredAt) || b.id - a.id);
}

/** Format a numeric value for the user's locale with a maximum precision. */
function formatNumber(value, digits = 2) {
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Format a calendar date using the browser's locale. */
function formatDay(date, options = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return date.toLocaleDateString([], options);
}

/** Format an ISO timestamp as a short, localized time. */
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Show a temporary status message and replace any message already on screen. */
function showToast(message) {
  toastElement.textContent = message;
  toastElement.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('show'), 3000);
}

/** Resolve a chart tap to its nearest data mark within a finger-sized radius. */
function nearestChartMark(event, chart) {
  let nearest = null;
  let nearestDistance = 73;
  chart.querySelectorAll('[data-chart-dose], [data-chart-day], [data-chart-weight]').forEach((mark) => {
    const rect = mark.getBoundingClientRect();
    const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right);
    const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
    const distance = Math.hypot(dx, dy);
    if (distance < nearestDistance) {
      nearest = mark;
      nearestDistance = distance;
    }
  });
  return nearest;
}

/** Render one navigation button; both nav bars share the same icon sprite. */
function navButton(item, current, mobile = false) {
  const selected = item.id === current;
  return `<button class="nav-item" type="button" data-nav="${item.id}" aria-current="${selected ? 'page' : 'false'}"><span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><use href="./icons/ui.svg#${item.icon}"></use></svg></span><span>${item.label}</span></button>`;
}

/** Rebuild the desktop sidebar and fixed mobile navigation from NAV_ITEMS. */
function renderNav() {
  document.querySelector('#primary-nav').innerHTML = NAV_ITEMS.map((item) => navButton(item, state.view)).join('');
  document.querySelector('#mobile-nav').innerHTML = NAV_ITEMS.map((item) => navButton(item, state.view, true)).join('');
}

/** Render a dose log row with escaped notes and edit/delete action metadata. */
function doseRow(dose) {
  return `<div class="entry-row">
    <span class="entry-rail" aria-hidden="true"></span>
    <div class="entry-main"><p class="entry-title">${escapeHtml(dose.insulinType)}</p><p class="entry-meta">${formatTime(dose.takenAt)}${dose.notes ? ` · ${escapeHtml(dose.notes)}` : ''}</p></div>
    <div class="entry-amount">${formatNumber(dose.units)} <span class="entry-meta">U</span></div>
    <div class="row-actions"><button class="row-action" data-action="edit-dose" data-id="${dose.id}" aria-label="Edit ${escapeHtml(dose.insulinType)} dose">Edit</button><button class="row-action delete" data-action="delete-dose" data-id="${dose.id}" aria-label="Delete ${escapeHtml(dose.insulinType)} dose">Delete</button></div>
  </div>`;
}

/** Render a weight log row with its local date and row action buttons. */
function weightRow(record) {
  const date = new Date(record.measuredAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<div class="entry-row">
    <div class="entry-main"><p class="entry-title">${Number(record.kilograms).toFixed(1)} <span class="entry-meta">kg</span></p><p class="entry-meta">${escapeHtml(date)}${record.notes ? ` · ${escapeHtml(record.notes)}` : ''}</p></div>
    <div class="row-actions"><button class="row-action" data-action="edit-weight" data-id="${record.id}" aria-label="Edit weight record">Edit</button><button class="row-action delete" data-action="delete-weight" data-id="${record.id}" aria-label="Delete weight record">Delete</button></div>
  </div>`;
}

/** Draw a decorative inline SVG trend; missing weight days use carry-forward values. */
function sparkline(values, className = '') {
  if (!values.length || values.every((value) => value === 0)) return `<svg class="mini-chart ${className}" viewBox="0 0 180 38" aria-hidden="true"><path class="spark-fill" d="M0,34 L180,34 L180,38 L0,38 Z"/><path class="spark" d="M2 30 H178"/></svg>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const points = values.map((value, index) => {
    const x = 3 + index * (174 / Math.max(1, values.length - 1));
    const y = 31 - ((value - min) / spread) * 25;
    return [x, y];
  });
  const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const fill = `${path} L 177 36 L 3 36 Z`;
  return `<svg class="mini-chart ${className}" viewBox="0 0 180 38" aria-hidden="true"><path class="spark-fill" d="${fill}"/><path class="spark" d="${path}"/></svg>`;
}

/** Return daily insulin totals from six days ago through the current day. */
function lastSevenDoses() {
  const today = new Date();
  const values = [];
  for (let offset = 6; offset >= 0; offset--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const bounds = dayBounds(day);
    values.push(state.doses.filter((dose) => inRange(dose.takenAt, bounds.start, bounds.end)).reduce((sum, dose) => sum + Number(dose.units), 0));
  }
  return values;
}

/** Return one weight value per day for the dashboard's small trend line. */
function lastSevenWeights() {
  const today = new Date();
  const values = [];
  for (let offset = 6; offset >= 0; offset--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const bounds = dayBounds(day);
    const records = sortedWeights(state.weights.filter((item) => inRange(item.measuredAt, bounds.start, bounds.end)));
    values.push(records[0] ? Number(records[0].kilograms) : null);
  }
  const nonNull = values.filter((value) => value !== null);
  if (!nonNull.length) return [];
  const first = nonNull[0];
  return values.map((value) => value === null ? first : value);
}

/** Build the landing screen from today's records, recent doses, and latest weight. */
function renderDashboard() {
  const today = new Date();
  const { start, end } = dayBounds(today);
  const todayDoses = sortedDoses(state.doses.filter((dose) => inRange(dose.takenAt, start, end)));
  const total = todayDoses.reduce((sum, dose) => sum + Number(dose.units), 0);
  const byType = new Map();
  todayDoses.forEach((dose) => byType.set(dose.insulinType, (byType.get(dose.insulinType) || 0) + Number(dose.units)));
  const types = [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
  const weights = sortedWeights();
  const latest = weights[0];
  const previous = weights[1];
  const weightDelta = latest && previous ? Number(latest.kilograms) - Number(previous.kilograms) : null;
  const recent = sortedDoses().slice(0, 5);

  return `<section class="page dashboard-page">
    <div class="page-heading"><div><p class="kicker">PERSONAL HEALTH LOG</p><h1>Today</h1></div><div class="date-stamp">${formatDay(today)}</div></div>
    <section class="hero" aria-label="Today's recorded insulin total"><span class="hero-label">Recorded insulin</span><div class="hero-total-line"><span class="hero-total">${formatNumber(total)}</span><span class="hero-unit">U</span></div><p class="hero-caption">${todayDoses.length} ${todayDoses.length === 1 ? 'injection' : 'injections'} entered today</p></section>
    <div class="quick-actions"><button class="quick-button dose" data-action="open-dose"><span class="plus" aria-hidden="true">＋</span> Insulin dose</button><button class="quick-button weight" data-action="open-weight"><span class="plus" aria-hidden="true">＋</span> Weight</button></div>
    <div class="dashboard-grid">
      <div class="dashboard-left">
        <div class="trend-grid">
          <section class="trend-card"><p class="kicker">Insulin · 7 days</p><p class="trend-value">${formatNumber(lastSevenDoses().reduce((sum, item) => sum + item, 0))} <small>U</small></p><p class="trend-caption">Recorded across the last 7 days</p>${sparkline(lastSevenDoses())}</section>
          <section class="trend-card"><p class="kicker">Weight · latest</p><p class="trend-value">${latest ? `${Number(latest.kilograms).toFixed(1)} <small>kg</small>` : '—'}</p><p class="trend-caption">${latest ? `${formatDay(new Date(latest.measuredAt), { month: 'short', day: 'numeric' })}${weightDelta === null ? '' : ` · ${weightDelta > 0 ? '+' : ''}${weightDelta.toFixed(1)} kg`}` : 'No measurement recorded yet'}</p>${sparkline(lastSevenWeights(), 'weight-spark')}</section>
        </div>
        <section class="card"><div class="card-heading"><h2>Today’s doses</h2><span class="kicker" style="margin:0">Individual entries</span></div><div class="entry-list">${todayDoses.length ? todayDoses.map(doseRow).join('') : `<div class="empty-state"><strong>No doses recorded today</strong><br />Add an entry to start your daily record.</div>`}</div></section>
      </div>
      <div class="dashboard-right">
        <section class="card"><div class="card-heading"><h2>Today by type</h2><button class="text-link" data-nav="settings">Reminders & backup</button></div>${types.length ? `<div class="type-list">${types.map(([name, units], index) => `<div class="type-row"><span class="type-dot" style="background:${TYPE_PALETTE[index % TYPE_PALETTE.length]}"></span><span class="type-name">${escapeHtml(name)}</span><span class="type-value">${formatNumber(units)} U</span></div>`).join('')}</div>` : `<p class="empty-state">Your recorded insulin types will appear here.</p>`}</section>
        <section class="card latest-weight"><div><p class="kicker">Latest weight</p>${latest ? `<p class="latest-value">${Number(latest.kilograms).toFixed(1)} kg</p><p class="subhead">${new Date(latest.measuredAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}${previous ? ` · ${weightDelta > 0 ? '+' : ''}${weightDelta.toFixed(1)} kg vs previous` : ''}</p>` : `<p class="subhead">No measurement recorded yet.</p>`}</div><span class="weight-badge" aria-hidden="true">kg</span></section>
        <section class="card"><div class="card-heading"><h2>Recent activity</h2><button class="text-link" data-nav="history">See history</button></div><div class="entry-list">${recent.length ? recent.map(doseRow).join('') : `<p class="empty-state">Your recent entries will appear here.</p>`}</div></section>
      </div>
    </div>
    <p class="disclaimer">Totals reflect entries recorded here and may be incomplete if an injection was not entered. This app does not recommend or adjust doses.</p>
  </section>`;
}

/** Build the complete dose log, ordered newest first. */
function renderInsulin() {
  const doses = sortedDoses();
  const total = doses.reduce((sum, dose) => sum + Number(dose.units), 0);
  return `<section class="page"><div class="page-heading"><div><p class="kicker">YOUR RECORDS</p><h1>Insulin</h1><p class="subhead">Individual entries, newest first</p></div><button class="primary-button" data-action="open-dose">＋ Add dose</button></div>
    <section class="card"><div class="card-heading"><div><h2>Dose log</h2><p class="subhead">${doses.length} ${doses.length === 1 ? 'entry' : 'entries'} · ${formatNumber(total)} U recorded</p></div></div><div class="entry-list">${doses.length ? doses.map(doseRow).join('') : `<div class="empty-state"><strong>Your dose log is empty</strong><br />Record an entry to begin.</div>`}</div></section>
    <p class="disclaimer">This log reflects the entries saved in this browser. It does not calculate or recommend doses.</p>
  </section>`;
}

/** Render the shared Day/Week/Month/6 mo/Year segmented control. */
function periodSelector(selected, actionName) {
  return `<div class="pill-row" role="group" aria-label="Select a date range">${PERIODS.map((period) => `<button type="button" class="period-pill" data-action="${actionName}" data-period="${period.id}" aria-pressed="${selected === period.id}">${period.label}</button>`).join('')}</div>`;
}

/** Build weight summaries and the full measurement list for the chosen period. */
function renderWeight() {
  const weights = sortedWeights();
  const selectedPeriod = state.weightPeriod;
  const bounds = periodBounds(selectedPeriod);
  const inPeriod = weights.filter((record) => inRange(record.measuredAt, bounds.start, bounds.end));
  const ascending = [...inPeriod].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  const change = ascending.length > 1 ? Number(ascending.at(-1).kilograms) - Number(ascending[0].kilograms) : null;
  const values = inPeriod.map((item) => Number(item.kilograms));
  const latest = weights[0];
  const previous = weights[1];
  return `<section class="page"><div class="page-heading"><div><p class="kicker">BODY MEASUREMENTS</p><h1>Weight</h1></div><button class="primary-button" data-action="open-weight">＋ Record weight</button></div>
    <section class="summary-card"><p class="eyebrow">Latest recorded</p>${latest ? `<p class="summary-number">${Number(latest.kilograms).toFixed(1)} <span style="font-size:16px;color:#e9e4fa">kg</span></p><p class="summary-sub">${new Date(latest.measuredAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>${previous ? `<p class="summary-sub" style="margin-top:6px">Change vs previous: ${Number(latest.kilograms) - Number(previous.kilograms) > 0 ? '+' : ''}${(Number(latest.kilograms) - Number(previous.kilograms)).toFixed(1)} kg</p>` : ''}` : `<p class="summary-sub" style="margin-top:9px">No weight measurements saved yet.</p>`}</section>
    <section class="card setting-card"><div class="card-heading"><div><h2>Period summary</h2><p class="subhead">Measurements in the selected range</p></div></div>${periodSelector(selectedPeriod, 'weight-period')}<div class="stats-grid"><div class="stat-box"><span class="eyebrow">Change</span><strong>${change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(1)} kg`}</strong></div><div class="stat-box"><span class="eyebrow">Lowest</span><strong>${values.length ? `${Math.min(...values).toFixed(1)} kg` : '—'}</strong></div><div class="stat-box"><span class="eyebrow">Highest</span><strong>${values.length ? `${Math.max(...values).toFixed(1)} kg` : '—'}</strong></div></div><p class="section-copy" style="margin:0">${inPeriod.length} ${inPeriod.length === 1 ? 'measurement' : 'measurements'} in selected range. Change compares earliest and latest measurements.</p></section>
    <section class="card"><div class="card-heading"><h2>Measurements</h2><span class="subhead">${weights.length} total</span></div><div class="entry-list">${weights.length ? weights.map(weightRow).join('') : `<p class="empty-state">Your measurements will appear here.</p>`}</div></section>
  </section>`;
}

/** Create escaped SVG label text for chart axes and dates. */
function svgText(x, y, text, anchor = 'middle', size = 9) {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}">${escapeHtml(text)}</text>`;
}

/** Build the insulin histogram, stacking daily totals by type outside day view. */
function renderInsulinChart(period, doses, bounds) {
  const width = 700;
  const height = 220;
  const left = 46;
  const right = 12;
  const top = 18;
  const bottom = 32;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const typeNames = [...new Set(doses.map((dose) => dose.insulinType))].sort();
  const colorByType = new Map(typeNames.map((name, index) => [name, TYPE_PALETTE[index % TYPE_PALETTE.length]]));
  const total = doses.reduce((sum, dose) => sum + Number(dose.units), 0);
  const days = Math.max(1, Math.ceil((bounds.end - bounds.start) / 86400000));
  const average = total / days;
  let maximum = 1;
  let groups = [];
  if (period === 'day') maximum = Math.max(1, ...doses.map((dose) => Number(dose.units)));
  else {
    const byDay = new Map();
    doses.forEach((dose) => {
      const key = dateKey(new Date(dose.takenAt));
      if (!byDay.has(key)) byDay.set(key, {});
      const values = byDay.get(key);
      values[dose.insulinType] = (values[dose.insulinType] || 0) + Number(dose.units);
    });
    groups = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({ key, values, total: Object.values(values).reduce((sum, value) => sum + value, 0) }));
    maximum = Math.max(1, ...groups.map((group) => group.total));
  }
  const grid = [0, 0.5, 1].map((fraction) => {
    const y = top + plotHeight * fraction;
    const value = Math.round(maximum * (1 - fraction));
    return `<line class="gridline" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/>${svgText(left - 8, y + 3, String(value), 'end', 8)}`;
  }).join('');
  let marks = '';
  let labels = '';
  if (period === 'day') {
    [0, 6, 12, 18, 24].forEach((hour) => {
      const x = left + plotWidth * hour / 24;
      const label = hour === 0 || hour === 24 ? '12a' : hour === 12 ? '12p' : `${hour > 12 ? hour - 12 : hour}${hour > 12 ? 'p' : 'a'}`;
      labels += svgText(x, height - 8, label, hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle', 8);
    });
    const offsets = new Map();
    marks = doses.map((dose) => {
      const date = new Date(dose.takenAt);
      const hour = date.getHours() + date.getMinutes() / 60;
      const minuteKey = `${date.getHours()}:${date.getMinutes()}`;
      const offset = offsets.get(minuteKey) || 0;
      offsets.set(minuteKey, offset + 1);
      const x = left + plotWidth * hour / 24 + offset * 7;
      const y = top + plotHeight * (1 - Number(dose.units) / maximum);
      const barHeight = top + plotHeight - y;
      const selectedClass = state.chartSelection?.type === 'dose' && state.chartSelection.id === dose.id ? ' selected' : '';
      return `<g><title>${escapeHtml(dose.insulinType)} · ${formatNumber(dose.units)} U · ${formatTime(dose.takenAt)}</title><rect class="bar${selectedClass}" data-chart-dose="${dose.id}" x="${x - 9}" y="${y}" width="18" height="${Math.max(4, barHeight)}" rx="5" fill="${colorByType.get(dose.insulinType)}" opacity=".9"/></g>`;
    }).join('');
  } else if (groups.length) {
    const step = plotWidth / groups.length;
    const barWidth = Math.max(6, Math.min(24, step * .72));
    marks = groups.map((group, index) => {
      const x = left + index * step + (step - barWidth) / 2;
      let bottomY = top + plotHeight;
      const bars = typeNames.map((type) => {
        const value = group.values[type] || 0;
        if (!value) return '';
        const barHeight = plotHeight * value / maximum;
        bottomY -= barHeight;
        return `<rect x="${x}" y="${bottomY}" width="${barWidth}" height="${barHeight}" fill="${colorByType.get(type)}"/>`;
      }).join('');
      const selectedClass = state.chartSelection?.type === 'day' && state.chartSelection.key === group.key ? ' selected' : '';
      return `<g><title>${group.key} · ${formatNumber(group.total)} U total</title><rect class="bar chart-hit-target${selectedClass}" data-chart-day="${group.key}" x="${x - 2}" y="${top}" width="${barWidth + 4}" height="${plotHeight}" fill="transparent"/>${bars}</g>`;
    }).join('');
    const indexes = [...new Set([0, Math.floor((groups.length - 1) / 2), groups.length - 1])];
    labels = indexes.map((index) => {
      const x = left + (index + .5) * step;
      const date = parseDateKey(groups[index].key);
      return svgText(x, height - 8, formatDay(date, { month: 'short', day: 'numeric' }), 'middle', 8);
    }).join('');
  }
  const noData = doses.length ? '' : `<text x="${width / 2}" y="${top + plotHeight / 2}" text-anchor="middle" fill="#71818c" font-size="11">No insulin entries in this range</text>`;
  const selected = state.chartSelection;
  let detail = period === 'day' ? 'Swipe sideways, then tap a bar to inspect the dose.' : 'Swipe sideways, then tap a bar to inspect the day.';
  if (selected?.type === 'dose') {
    const dose = doses.find((item) => item.id === selected.id);
    if (dose) detail = `${dose.insulinType} · ${Number(dose.units).toFixed(2)} U · ${new Date(dose.takenAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
  } else if (selected?.type === 'day') {
    const group = groups.find((item) => item.key === selected.key);
    const date = parseDateKey(selected.key);
    if (group && date) detail = `${formatDay(date, { dateStyle: 'medium' })} · ${group.total.toFixed(2)} U total`;
  }
  const legend = typeNames.map((type) => `<span class="legend-item"><span class="legend-swatch" style="background:${colorByType.get(type)}"></span>${escapeHtml(type)}</span>`).join('');
  const chartClass = doses.length ? ' chart-svg has-marks' : ' chart-svg';
  return `<section class="card chart-card"><div class="chart-summary"><div><span class="eyebrow">Period total</span><p class="chart-total">${total.toFixed(1)} <small style="font-size:12px;color:var(--muted)">U</small></p></div><p class="chart-footnote">Average ${average.toFixed(1)} U per calendar day</p></div><div class="chart-scroll"><svg class="${chartClass}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Insulin entries chart">${grid}${marks}${labels}${noData}</svg></div><p class="chart-detail">${escapeHtml(detail)}</p><div class="legend">${legend || `<span class="legend-item">No insulin types recorded</span>`}</div></section>`;
}

/** Build the weight trend chart; plotted points always correspond to saved entries. */
function renderWeightChart(records, bounds) {
  const width = 700;
  const height = 218;
  const left = 52;
  const right = 16;
  const top = 17;
  const bottom = 31;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const sorted = [...records].sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  const values = sorted.map((record) => Number(record.kilograms));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const pad = Math.max(.5, (max - min) * .16);
  const yMin = min - pad;
  const yMax = max + pad;
  const duration = Math.max(1, bounds.end - bounds.start);
  const xFor = (iso) => left + Math.max(0, Math.min(1, (new Date(iso) - bounds.start) / duration)) * plotWidth;
  const yFor = (value) => top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;
  let grid = '';
  [0, .5, 1].forEach((fraction) => {
    const y = top + plotHeight * fraction;
    const label = yMax - (yMax - yMin) * fraction;
    grid += `<line class="gridline" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/>${svgText(left - 8, y + 3, label.toFixed(1), 'end', 8)}`;
  });
  const lines = sorted.slice(1).map((record, index) => {
    const previous = sorted[index];
    return `<line class="trendline" x1="${xFor(previous.measuredAt)}" y1="${yFor(Number(previous.kilograms))}" x2="${xFor(record.measuredAt)}" y2="${yFor(Number(record.kilograms))}"/>`;
  }).join('');
  const points = sorted.map((record) => {
    const selectedClass = record.id === state.weightSelection ? ' selected' : '';
    return `<g><title>${Number(record.kilograms).toFixed(2)} kg · ${new Date(record.measuredAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</title><circle class="point${selectedClass}" data-chart-weight="${record.id}" cx="${xFor(record.measuredAt)}" cy="${yFor(Number(record.kilograms))}" r="8"/></g>`;
  }).join('');
  const startLabel = formatDay(bounds.start, { month: 'short', day: 'numeric' });
  const endLabel = formatDay(new Date(bounds.end.getTime() - 86400000), { month: 'short', day: 'numeric' });
  const selected = sorted.find((record) => record.id === state.weightSelection);
  const latest = sorted.at(-1);
  const change = sorted.length > 1 ? Number(sorted.at(-1).kilograms) - Number(sorted[0].kilograms) : null;
  const detail = selected ? `${Number(selected.kilograms).toFixed(2)} kg · ${new Date(selected.measuredAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : records.length ? 'Swipe sideways, then tap a point to inspect it.' : 'No measurements in this period; blank days remain blank.';
  const chartClass = records.length ? 'chart-svg weight-chart has-marks' : 'chart-svg weight-chart';
  return `<section class="card chart-card"><div class="weight-chart-summary"><div><span class="eyebrow">Latest in range</span><strong>${latest ? `${Number(latest.kilograms).toFixed(1)} kg` : '—'}</strong><span class="subhead">${latest ? formatDay(new Date(latest.measuredAt), { month: 'short', day: 'numeric' }) : 'No measurements'}</span></div><div><span class="eyebrow">Change</span><strong>${change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(1)}`}</strong><span class="subhead">kg, first to last</span></div></div><div class="chart-scroll"><svg class="${chartClass}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weight measurements chart">${grid}${lines}${points}${svgText(left, height - 8, startLabel, 'start', 8)}${svgText(width - right, height - 8, endLabel, 'end', 8)}${records.length ? '' : `<text x="${width / 2}" y="${top + plotHeight / 2}" text-anchor="middle" fill="#71818c" font-size="11">No measurements recorded in this range</text>`}</svg></div><p class="chart-detail">${escapeHtml(detail)}</p><p class="section-copy" style="margin:0;text-align:center">Points show recorded measurements only. No values are interpolated.</p></section>`;
}

/** Assemble date-range controls and both record-only chart cards. */
function renderCharts() {
  const bounds = periodBounds(state.chartPeriod);
  const doses = sortedDoses(state.doses.filter((dose) => inRange(dose.takenAt, bounds.start, bounds.end)));
  const weights = sortedWeights(state.weights.filter((record) => inRange(record.measuredAt, bounds.start, bounds.end)));
  const endDay = new Date(bounds.end.getTime() - 86400000);
  const rangeText = `${formatDay(bounds.start, { dateStyle: 'medium' })} – ${formatDay(endDay, { dateStyle: 'medium' })}`;
  return `<section class="page"><div class="page-heading"><div><p class="kicker">TRENDS FROM YOUR RECORDS</p><h1>Charts</h1></div></div>
    <section class="card setting-card"><div class="card-heading"><div><h2>Date range</h2><p class="subhead">${rangeText}</p></div></div>${periodSelector(state.chartPeriod, 'chart-period')}</section>
    <div class="section-stack"><div><h2>Insulin intake</h2><p class="section-copy">${state.chartPeriod === 'day' ? 'Each bar is an individual recorded dose across the day.' : 'Bars show the recorded total per day, separated by insulin type.'}</p></div>${renderInsulinChart(state.chartPeriod, doses, bounds)}</div>
    <div class="section-stack"><div><h2>Weight trend</h2><p class="section-copy">Only recorded measurements are plotted; days without a measurement stay blank.</p></div>${renderWeightChart(weights, bounds)}</div>
    <p class="disclaimer">Charts summarize records entered in this app. They are for record keeping and do not provide medical guidance.</p>
  </section>`;
}

/** Build one day's history with date navigation and separate record lists. */
function renderHistory() {
  const date = parseDateKey(state.historyDate) || new Date();
  const { start, end } = dayBounds(date);
  const doses = sortedDoses(state.doses.filter((dose) => inRange(dose.takenAt, start, end)));
  const weights = sortedWeights(state.weights.filter((record) => inRange(record.measuredAt, start, end)));
  const total = doses.reduce((sum, dose) => sum + Number(dose.units), 0);
  return `<section class="page"><div><p class="kicker">PAST RECORDS</p><h1>History</h1></div>
    <section class="card date-control"><button class="date-arrow" data-action="history-shift" data-amount="-1" type="button" aria-label="Previous day">‹</button><label class="date-select"><span class="eyebrow">Selected date</span><input id="history-date" type="date" value="${state.historyDate}" aria-label="Selected date" /></label><button class="date-arrow" data-action="history-shift" data-amount="1" type="button" aria-label="Next day">›</button></section>
    <section class="summary-card" style="background:var(--blue-dark)"><div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><div><p class="eyebrow">Recorded insulin</p><p class="summary-number">${formatNumber(total)} <span style="font-size:16px;color:#d8eafa">U</span></p></div><p class="summary-sub">${doses.length} ${doses.length === 1 ? 'dose' : 'doses'}</p></div></section>
    <section class="card"><div class="card-heading"><h2>Insulin doses</h2><button class="text-link" data-action="open-dose" data-date="${state.historyDate}">＋ Add</button></div><div class="entry-list">${doses.length ? doses.map(doseRow).join('') : `<p class="empty-state">No dose entries for this date.</p>`}</div><p class="section-copy" style="margin:8px 0 0">Totals are based only on entries recorded in this app.</p></section>
    <section class="card"><div class="card-heading"><h2>Weight measurements</h2><button class="text-link" data-action="open-weight" data-date="${state.historyDate}">＋ Add</button></div><div class="entry-list">${weights.length ? weights.map(weightRow).join('') : `<p class="empty-state">No weight measurements for this date.</p>`}</div></section>
  </section>`;
}

/** Build installation, reminder, backup, restore, and privacy settings content. */
function renderSettings() {
  return `<section class="page"><div><p class="kicker">PREFERENCES & DATA</p><h1>Settings</h1><p class="subhead">Manage your local records and backups.</p></div>
    <section class="card setting-card"><div><h2 class="setting-title">Install on your phone</h2><p class="setting-copy">Add Insulin Intake to your Home Screen for an app-style window and offline access after it has loaded once.</p></div><div class="privacy-note"><strong>iPhone:</strong> open this site in Safari, tap Share, choose <em>Add to Home Screen</em>, then tap Add.<br /><strong>Android:</strong> open this site in Chrome, tap the menu, then choose <em>Install app</em> or <em>Add to Home screen</em>.<br />Installation requires a secure HTTPS website. Localhost is supported for development.</div><div><button class="primary-button" data-action="install-pwa">Install app</button></div></section>
    <section class="card setting-card"><div><h2 class="setting-title">Reminders</h2><p class="setting-copy">Background reminders are not supported in this browser version. Your tracker remains available without notification permissions.</p></div><div class="privacy-note">Reminder scheduling in the original mobile app is handled by iOS. This plain JavaScript edition does not schedule notifications.</div></section>
    <section class="card setting-card"><div><h2 class="setting-title">Automatic backups · latest 10</h2><p class="setting-copy">After each saved, edited, or deleted record, the app saves a full-history snapshot and keeps only the 10 newest.</p></div><div class="privacy-note">On iPhone, automatic snapshots stay in this website’s private storage and do not appear in the Files app. To copy one into Files, tap Export CSV and choose Save to Files in the iOS share sheet. Keep this website’s data in Safari to retain its local snapshots.</div><div id="automatic-backups-list" class="backup-list" aria-live="polite"><p class="empty-state">Loading automatic backups…</p></div></section>
    <section class="card setting-card"><div><h2 class="setting-title">Backup & restore</h2><p class="setting-copy">Export a CSV copy to save somewhere you control. A backup may contain sensitive health information; store it carefully.</p></div><div class="settings-actions"><button class="primary-button" data-action="export-csv">Export CSV backup</button><button class="secondary-button" data-action="choose-restore">Restore from CSV</button><input class="file-input" id="restore-file" type="file" accept=".csv,text/csv" /></div></section>
    <section class="card setting-card"><div><h2 class="setting-title">Your data stays in this browser</h2><p class="setting-copy">Dose and weight records are stored in local browser storage on this device. They are not uploaded or synced. Clearing browser data can erase these records, so keep a backup.</p></div><div class="privacy-note">This tracker records information you enter. It does not calculate doses or provide medical advice. The original Expo app’s records are stored separately from this browser edition.</div></section>
  </section>`;
}

/** Re-render the active page and keep the selected/latest chart mark in view. */
function render() {
  renderNav();
  const pages = { dashboard: renderDashboard, insulin: renderInsulin, weight: renderWeight, charts: renderCharts, history: renderHistory, settings: renderSettings };
  app.innerHTML = (pages[state.view] || renderDashboard)();
  document.title = `${state.view === 'dashboard' ? 'Dashboard' : state.view.charAt(0).toUpperCase() + state.view.slice(1)} · Insulin Intake`;
  if (state.view === 'charts') {
    // A wider phone chart scrolls horizontally; center the selected or newest mark.
    requestAnimationFrame(() => {
      document.querySelectorAll('.chart-scroll').forEach((scroll) => {
        const chart = scroll.querySelector('.chart-svg');
        if (!chart) return;
        const isWeight = chart.classList.contains('weight-chart');
        let mark = null;
        if (isWeight && state.weightSelection !== null) {
          mark = chart.querySelector(`[data-chart-weight="${state.weightSelection}"]`);
        } else if (!isWeight && state.chartSelection?.type === 'dose') {
          mark = chart.querySelector(`[data-chart-dose="${state.chartSelection.id}"]`);
        } else if (!isWeight && state.chartSelection?.type === 'day') {
          mark = chart.querySelector(`[data-chart-day="${state.chartSelection.key}"]`);
        }
        const marks = chart?.querySelectorAll('[data-chart-dose], [data-chart-day], [data-chart-weight]');
        mark ||= marks?.[marks.length - 1];
        if (!mark) return;
        const markRect = mark.getBoundingClientRect();
        const scrollRect = scroll.getBoundingClientRect();
        const markCenter = markRect.left - scrollRect.left + scroll.scrollLeft + markRect.width / 2;
        scroll.scrollLeft = Math.max(0, markCenter - scroll.clientWidth / 2);
      });
    });
  }
  if (state.view === 'settings') void renderBackupSnapshots();
}

/** Populate the settings backup list after its asynchronous storage read. */
async function renderBackupSnapshots() {
  const list = document.querySelector('#automatic-backups-list');
  if (!list) return;
  try {
    const snapshots = await readAutomaticBackups();
    const currentList = document.querySelector('#automatic-backups-list');
    if (!currentList) return;
    if (!snapshots.length) {
      currentList.innerHTML = '<p class="empty-state">No automatic backups yet. Saving or changing a record will create the first snapshot.</p>';
      return;
    }
    currentList.innerHTML = snapshots.map((snapshot) => {
      const savedAt = new Date(snapshot.savedAt);
      const dateLabel = Number.isFinite(savedAt.getTime()) ? savedAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Saved backup';
      const recordCount = snapshot.doses.length + snapshot.weights.length;
      return `<div class="backup-item"><div><strong>${escapeHtml(dateLabel)}</strong><span>${recordCount} ${recordCount === 1 ? 'record' : 'records'} · ${snapshot.doses.length} insulin · ${snapshot.weights.length} weight</span></div><button class="secondary-button" type="button" data-action="export-snapshot" data-id="${escapeHtml(snapshot.id)}">Export CSV</button></div>`;
    }).join('');
  } catch (error) {
    console.error('Could not load automatic backups:', error);
    const currentList = document.querySelector('#automatic-backups-list');
    if (currentList) currentList.innerHTML = '<p class="empty-state">Automatic backups are unavailable in this browser.</p>';
  }
}

/** Change screens, keep the URL hash in sync, and return focus to app content. */
function setView(view) {
  state.view = view;
  state.chartSelection = null;
  state.weightSelection = null;
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  render();
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Render and open the shared create/edit form, then focus its first value field. */
function openRecordDialog(kind, id = null, dateOverride = null) {
  const isDose = kind === 'dose';
  const records = isDose ? state.doses : state.weights;
  const record = id ? records.find((item) => item.id === Number(id)) : null;
  if (id && !record) {
    showToast('That record could not be found.');
    return;
  }
  const baseTime = record ? dateParts(isDose ? record.takenAt : record.measuredAt) : { date: dateOverride || dateKey(new Date()), time: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}` };
  const insulinType = record?.insulinType || 'Rapid-acting';
  const presetTypes = ['Rapid-acting', 'Basal'];
  const typeValue = presetTypes.includes(insulinType) ? insulinType : 'Other';
  recordDialog.innerHTML = `<form id="record-form" data-kind="${kind}" data-id="${record ? record.id : ''}"><div class="dialog-inner">
    <div class="dialog-top"><div><p class="kicker">${record ? 'UPDATE RECORD' : 'NEW RECORD'}</p><h2 id="dialog-title" style="font-size:21px">${record ? `Edit ${isDose ? 'dose' : 'weight'}` : `Record ${isDose ? 'insulin dose' : 'weight'}`}</h2></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="Close">×</button></div>
    <p class="form-intro">${isDose ? 'Record the insulin entry as you took it. This app keeps your log; it does not calculate or recommend doses.' : 'Record a measurement in kilograms. No targets or health recommendations are calculated.'}</p>
    <div class="form-card">
      ${isDose ? `<div class="field"><label for="insulin-type">Insulin type</label><select id="insulin-type" name="insulinType"><option ${typeValue === 'Rapid-acting' ? 'selected' : ''}>Rapid-acting</option><option ${typeValue === 'Basal' ? 'selected' : ''}>Basal</option><option ${typeValue === 'Other' ? 'selected' : ''}>Other</option></select></div><div class="field" id="custom-type-wrap" style="${typeValue === 'Other' ? '' : 'display:none'}"><label for="custom-type">Type or name</label><input id="custom-type" name="customType" value="${typeValue === 'Other' ? escapeHtml(insulinType === 'Other' ? '' : insulinType) : ''}" placeholder="Name or type" maxlength="80" /></div><div class="field"><label for="units">Dose in units</label><input id="units" name="units" type="number" inputmode="decimal" min="0.01" max="1000" step="0.01" required placeholder="0" value="${record ? escapeHtml(record.units) : ''}" /></div>` : `<div class="field"><label for="kilograms">Weight in kilograms</label><input id="kilograms" name="kilograms" type="text" inputmode="decimal" autocomplete="off" pattern="[0-9]+([.,][0-9])?" title="Enter one decimal place, for example 84.3 or 84,3." required placeholder="0.0" value="${record ? escapeHtml(record.kilograms) : ''}" /></div>`}
      <div class="field-row"><div class="field"><label for="record-date">Date</label><input id="record-date" name="date" type="date" required value="${baseTime.date}" /></div><div class="field"><label for="record-time">24-hour time</label><input id="record-time" name="time" type="time" required value="${baseTime.time}" /></div></div>
      <div class="field"><label for="record-notes">Note <span style="font-weight:500;letter-spacing:0">(optional)</span></label><textarea id="record-notes" name="notes" maxlength="500" placeholder="${isDose ? 'Meal, correction, or other note' : 'Optional note'}">${escapeHtml(record?.notes || '')}</textarea></div>
    </div><div class="form-actions"><button class="secondary-button" type="button" data-action="close-dialog">Cancel</button><button class="primary-button" type="submit">${record ? 'Save changes' : isDose ? 'Save dose' : 'Save measurement'}</button></div>
  </div></form>`;
  if (typeof recordDialog.showModal === 'function') recordDialog.showModal();
  else recordDialog.setAttribute('open', '');
  const focus = recordDialog.querySelector(isDose ? '#units' : '#kilograms');
  setTimeout(() => focus?.focus(), 30);
}

/** Close the record dialog with a fallback for browsers without dialog methods. */
function closeDialog() {
  if (recordDialog.open && typeof recordDialog.close === 'function') recordDialog.close();
  else recordDialog.removeAttribute('open');
}

/**
 * Send the full CSV to the configured Telegram chat after a new record is saved.
 * This is optional frontend-only behavior; the token is visible to site visitors,
 * and the no-cors request cannot confirm Telegram accepted the file.
 */
async function sendTelegramFullBackup() {
  const config = window.TELEGRAM_BACKUP_CONFIG || {};
  if (!config.botToken || !config.chatId ||
      config.botToken === 'PASTE_BOT_TOKEN_HERE' ||
      config.chatId === 'PASTE_CHAT_ID_HERE') {
    console.warn('Telegram backup is not configured yet.');
    return;
  }

  try {
    const csv = recordsToCsv(state.doses, state.weights);
    const filename = `insulin-intake-backup-${dateKey(new Date())}.csv`;
    const file = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const form = new FormData();
    form.append('chat_id', String(config.chatId));
    form.append('document', file, filename);
    form.append('disable_notification', 'true');
    form.append(
      'caption',
      `Insulin Intake full backup · ${state.doses.length} insulin records · ${state.weights.length} weight records`
    );

    // no-cors allows the browser to submit the multipart request without
    // needing Telegram to grant CORS access. The response is opaque, so
    // the app cannot verify Telegram's result.
    await fetch(`https://api.telegram.org/bot${config.botToken}/sendDocument`, {
      method: 'POST',
      mode: 'no-cors',
      body: form
    });
  } catch (error) {
    // Keep this silent: local saving must never depend on Telegram availability.
    console.warn('Telegram backup attempt failed:', error);
  }
}

/** Validate a form, update the matching collection, persist, and refresh UI. */
function saveRecord(event) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const kind = form.dataset.kind;
  const id = form.dataset.id ? Number(form.dataset.id) : null;
  const date = localDateTime(String(data.get('date')), String(data.get('time')));
  if (!date) {
    showToast('Choose a valid date and time.');
    return;
  }
  const notes = String(data.get('notes') || '').trim();
  if (kind === 'dose') {
    const units = Number(String(data.get('units') || '').replace(',', '.'));
    const selectedType = String(data.get('insulinType') || '');
    const insulinType = selectedType === 'Other' ? String(data.get('customType') || '').trim() : selectedType;
    if (!Number.isFinite(units) || units <= 0 || units > 1000) {
      showToast('Enter a dose greater than 0 and no more than 1000 U.');
      return;
    }
    if (!insulinType) {
      showToast('Enter an insulin type or name.');
      form.querySelector('#custom-type')?.focus();
      return;
    }
    const entry = { id: id || nextId(state.doses), insulinType, units, takenAt: date.toISOString(), notes };
    if (id) state.doses = state.doses.map((item) => item.id === id ? entry : item);
    else state.doses.push(entry);
  } else {
    const kilograms = Number(String(data.get('kilograms') || '').replace(',', '.'));
    if (!Number.isFinite(kilograms) || kilograms < 0.1 || kilograms > 1000) {
      showToast('Enter a weight greater than 0 and no more than 1000 kg.');
      return;
    }
    const duplicate = state.weights.some((item) => item.id !== id && Number(item.kilograms) === kilograms && item.measuredAt === date.toISOString());
    if (duplicate) {
      showToast('A measurement with this value at the same date and time already exists.');
      return;
    }
    const entry = { id: id || nextId(state.weights), kilograms, measuredAt: date.toISOString(), notes };
    if (id) state.weights = state.weights.map((item) => item.id === id ? entry : item);
    else state.weights.push(entry);
  }
  if (persist()) {
    queueAutomaticBackup();
    if (!id) void sendTelegramFullBackup();
    closeDialog();
    render();
    showToast(kind === 'dose' ? (id ? 'Dose updated.' : 'Dose saved.') : (id ? 'Measurement updated.' : 'Measurement saved.'));
  }
}

/** Return the next positive integer ID within one record collection. */
function nextId(records) {
  return records.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0) + 1;
}

/** Confirm deletion, remove a record, and restore it if local persistence fails. */
function deleteRecord(kind, id) {
  const isDose = kind === 'dose';
  const record = (isDose ? state.doses : state.weights).find((item) => item.id === id);
  if (!record) return;
  const message = isDose ? 'Delete this recorded dose? It will be removed from your history and totals.' : 'Delete this weight measurement? It will be removed from your records and charts.';
  if (!window.confirm(message)) return;
  if (isDose) state.doses = state.doses.filter((item) => item.id !== id);
  else state.weights = state.weights.filter((item) => item.id !== id);
  if (!persist()) {
    if (isDose) state.doses.push(record);
    else state.weights.push(record);
    return;
  }
  queueAutomaticBackup();
  render();
  showToast(isDose ? 'Dose deleted.' : 'Measurement deleted.');
}

/** Escape one CSV cell according to the double-quote CSV convention. */
function csvQuote(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

/** Serialize both record types into the app's documented seven-column CSV format. */
function recordsToCsv(doses, weights) {
  const rows = [['record_type', 'id', 'timestamp', 'insulin_type', 'insulin_units', 'weight_kg', 'notes']];
  doses.forEach((dose) => rows.push(['insulin', dose.id, dose.takenAt, dose.insulinType, dose.units, '', dose.notes || '']));
  weights.forEach((weight) => rows.push(['weight', weight.id, weight.measuredAt, '', '', weight.kilograms, weight.notes || '']));
  return `${rows.map((row) => row.map(csvQuote).join(',')).join('\r\n')}\r\n`;
}

/** Share or download a CSV file, preferring the device's native share sheet. */
async function exportCsvFile(csv, filename) {
  const file = new File([csv], filename, { type: 'text/csv;charset=utf-8' });
  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Insulin Intake backup' });
      showToast('Choose Save to Files to keep this backup on your iPhone.');
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.info('File sharing was unavailable; using a download instead.', error);
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  showToast('CSV backup downloaded. Save it in Files if your browser asks.');
}

/** Export all current records as one dated CSV backup. */
function exportCsv() {
  const csv = recordsToCsv(state.doses, state.weights);
  void exportCsvFile(csv, `insulin-intake-backup-${dateKey(new Date())}.csv`);
}

/** Read and export one selected automatic snapshot as a CSV file. */
async function exportSnapshot(id) {
  try {
    const snapshots = await readAutomaticBackups();
    const snapshot = snapshots.find((item) => item.id === id);
    if (!snapshot) {
      showToast('That automatic backup could not be found.');
      return;
    }
    const csv = recordsToCsv(snapshot.doses, snapshot.weights);
    const stamp = snapshot.savedAt.replace(/[-:.]/g, '').replace('Z', 'Z');
    await exportCsvFile(csv, `insulin-intake-backup-${stamp}.csv`);
  } catch (error) {
    console.error('Could not export automatic backup:', error);
    showToast('Could not export that backup. Try Export CSV backup instead.');
  }
}

/** Parse and validate the complete app CSV before any records are replaced. */
function parseCsv(text) {
  const input = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(cell); cell = ''; }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index++;
      row.push(cell); cell = '';
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
    } else cell += character;
  }
  if (quoted) throw new Error('The CSV has an unclosed quoted field.');
  if (cell.length || row.length) { row.push(cell); if (row.some((value) => value.length)) rows.push(row); }
  const header = ['record_type', 'id', 'timestamp', 'insulin_type', 'insulin_units', 'weight_kg', 'notes'];
  if (!rows.length || rows[0].length !== header.length || rows[0].some((value, index) => value !== header[index])) throw new Error('This is not an Insulin Intake CSV backup.');
  const doses = [];
  const weights = [];
  const doseIds = new Set();
  const weightIds = new Set();
  const weightKeys = new Set();
  rows.slice(1).forEach((values, index) => {
    const line = index + 2;
    if (values.length !== header.length) throw new Error(`CSV row ${line} has the wrong number of columns.`);
    const [type, idText, timestamp, insulinType, unitsText, kilogramsText, notes] = values;
    const id = Number(idText);
    const date = new Date(timestamp);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(date.getTime())) throw new Error(`CSV row ${line} has an invalid ID or date/time.`);
    if (type === 'insulin') {
      const units = Number(unitsText);
      if (!insulinType.trim() || !Number.isFinite(units) || units <= 0 || units > 1000 || doseIds.has(id)) throw new Error(`CSV row ${line} has invalid or duplicate insulin data.`);
      doseIds.add(id);
      doses.push({ id, insulinType, units, takenAt: date.toISOString(), notes });
    } else if (type === 'weight') {
      const kilograms = Number(kilogramsText);
      const key = `${kilograms}|${date.toISOString()}`;
      if (!Number.isFinite(kilograms) || kilograms <= 0 || kilograms > 1000 || weightIds.has(id) || weightKeys.has(key)) throw new Error(`CSV row ${line} has invalid or duplicate weight data.`);
      weightIds.add(id); weightKeys.add(key);
      weights.push({ id, kilograms, measuredAt: date.toISOString(), notes });
    } else throw new Error(`CSV row ${line} has an unknown record type.`);
  });
  return { doses, weights };
}

/** Read a CSV backup, ask before replacement, then persist and redraw records. */
async function restoreCsv(file) {
  try {
    const backup = parseCsv(await file.text());
    const message = `Replace all current records with ${backup.doses.length} insulin entries and ${backup.weights.length} weight measurements from this backup? This cannot be undone. Export a backup first if you may need the current data.`;
    if (!window.confirm(message)) return;
    const previousDoses = state.doses;
    const previousWeights = state.weights;
    state.doses = backup.doses;
    state.weights = backup.weights;
    if (!persist()) {
      state.doses = previousDoses;
      state.weights = previousWeights;
      return;
    }
    queueAutomaticBackup();
    render();
    showToast('Backup restored.');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not read this backup file.');
  } finally {
    const input = document.querySelector('#restore-file');
    if (input) input.value = '';
  }
}

// One delegated click handler routes navigation, forms, chart taps, and row actions.
document.addEventListener('click', (event) => {
  const directTarget = event.target.closest('[data-nav], [data-action]');
  const chart = event.target.closest('.chart-svg');
  const markTarget = event.target.closest('[data-chart-dose], [data-chart-day], [data-chart-weight]');
  const target = directTarget || (chart ? nearestChartMark(event, chart) || markTarget : null);
  if (!target) return;
  if (target.dataset.nav) {
    event.preventDefault();
    setView(target.dataset.nav);
    return;
  }
  const { action, id, date, amount, period } = target.dataset;
  if (action === 'open-dose') openRecordDialog('dose', null, date || null);
  else if (action === 'open-weight') openRecordDialog('weight', null, date || null);
  else if (action === 'edit-dose') openRecordDialog('dose', Number(id));
  else if (action === 'edit-weight') openRecordDialog('weight', Number(id));
  else if (action === 'delete-dose') deleteRecord('dose', Number(id));
  else if (action === 'delete-weight') deleteRecord('weight', Number(id));
  else if (action === 'close-dialog') closeDialog();
  else if (action === 'chart-period') { state.chartPeriod = period; state.chartSelection = null; render(); }
  else if (action === 'weight-period') { state.weightPeriod = period; render(); }
  else if (action === 'history-shift') {
    const current = parseDateKey(state.historyDate) || new Date();
    current.setDate(current.getDate() + Number(amount));
    state.historyDate = dateKey(current);
    render();
  } else if (action === 'export-csv') exportCsv();
  else if (action === 'export-snapshot') void exportSnapshot(id);
  else if (action === 'choose-restore') document.querySelector('#restore-file')?.click();
  else if (action === 'install-pwa') void installPwa();
  else if (target.dataset.chartDose) {
    state.chartSelection = { type: 'dose', id: Number(target.dataset.chartDose) };
    render();
  } else if (target.dataset.chartDay) {
    state.chartSelection = { type: 'day', key: target.dataset.chartDay };
    render();
  } else if (target.dataset.chartWeight) {
    state.weightSelection = Number(target.dataset.chartWeight);
    render();
  }
});

// Keep form submission handling centralized because the record form is recreated.
document.addEventListener('submit', (event) => {
  if (event.target instanceof HTMLFormElement && event.target.id === 'record-form') saveRecord(event);
});

// Handle form-dependent fields and date/file controls after their values change.
document.addEventListener('change', (event) => {
  if (event.target.id === 'insulin-type') {
    const wrap = document.querySelector('#custom-type-wrap');
    if (wrap) {
      wrap.style.display = event.target.value === 'Other' ? 'grid' : 'none';
      if (event.target.value === 'Other') document.querySelector('#custom-type')?.focus();
    }
  } else if (event.target.id === 'history-date') {
    if (parseDateKey(event.target.value)) { state.historyDate = event.target.value; render(); }
  } else if (event.target.id === 'restore-file') {
    const file = event.target.files?.[0];
    if (file) void restoreCsv(file);
  }
});

recordDialog.addEventListener('click', (event) => {
  if (event.target === recordDialog) closeDialog();
});

// Refresh if another tab on this origin changes the same localStorage record key.
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) {
    const latest = loadRecords();
    state.doses = latest.doses;
    state.weights = latest.weights;
    render();
  }
});

// Restore a supported screen from the URL so links and browser history reopen it.
if (location.hash.slice(1) in { dashboard: 1, insulin: 1, weight: 1, charts: 1, history: 1, settings: 1 }) state.view = location.hash.slice(1);
render();

/** Detect standalone launch mode on browsers that expose either signal. */
function isRunningStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** Use the browser install prompt when available, or explain iPhone steps. */
async function installPwa() {
  if (isRunningStandalone()) {
    showToast('Insulin Intake is already installed on this device.');
    return;
  }
  if (!installPromptEvent) {
    showToast('On iPhone: Safari → Share → Add to Home Screen. On Android: Chrome menu → Install app.');
    return;
  }
  installPromptEvent.prompt();
  const result = await installPromptEvent.userChoice;
  installPromptEvent = null;
  document.querySelector('#install-app').hidden = true;
  showToast(result.outcome === 'accepted' ? 'Installation started.' : 'You can install it later from your browser menu.');
}

// Chromium fires this event when its native install prompt can be offered.
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPromptEvent = event;
  const installButton = document.querySelector('#install-app');
  if (installButton && !isRunningStandalone()) installButton.hidden = false;
});

// Clear the saved install prompt after the browser confirms installation.
window.addEventListener('appinstalled', () => {
  installPromptEvent = null;
  const installButton = document.querySelector('#install-app');
  if (installButton) installButton.hidden = true;
  showToast('Insulin Intake was added to your Home Screen.');
});

// Service workers require HTTP(S); file:// use should fail quietly and clearly.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('./service-worker.js', window.location.href), { scope: './' })
      .catch((error) => console.error('Offline app setup failed:', error));
  });
}
