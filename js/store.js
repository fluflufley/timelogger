// Storage backends. Both expose the same interface:
//   init({ onEntries, onStatus, onUser })
//   apply(ops)   ops: [{op:'set', entry}, {op:'update', id, patch}, {op:'delete', id}]
//
// Data model: one entry = "I started <activity> at <start>".
// An entry ends when the next one starts. activity === null is a "stop"
// marker, i.e. untracked time.

const LS_KEY = 'timelog.entries.v1';
const FB_VERSION = '12.10.0';

export const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

export const sortEntries = (list) => list.slice().sort((a, b) => a.start - b.start);

export function sanitize(e) {
  const activity = typeof e.activity === 'string' && e.activity.trim()
    ? e.activity.trim().slice(0, 500) : null;
  return {
    id: String(e.id),
    activity,
    start: Number(e.start),
    note: typeof e.note === 'string' ? e.note.slice(0, 5000) : '',
  };
}

const LS_SETTINGS = 'timelog.settings.v1';

export function sanitizeSettings(v) {
  const colors = {};
  const src = v && typeof v.colors === 'object' && v.colors ? v.colors : {};
  for (const [k, c] of Object.entries(src).slice(0, 1000)) {
    if (typeof k === 'string' && k.length <= 500 && /^#[0-9a-f]{6}$/i.test(c)) colors[k] = c.toLowerCase();
  }
  return { colors };
}

function readLocalSettings() {
  try { return sanitizeSettings(JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch { return { colors: {} }; }
}

export function readLocalEntries() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(v) ? v.map(sanitize).filter((e) => Number.isFinite(e.start)) : [];
  } catch {
    return [];
  }
}

export function clearLocalEntries() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------- local */

export class LocalStore {
  mode = 'local';

  async init({ onEntries, onStatus, onSettings }) {
    this.onEntries = onEntries;
    this.onSettings = onSettings;
    onStatus?.({ state: 'local' });
    // keep several open tabs in sync
    window.addEventListener('storage', (e) => {
      if (e.key === LS_KEY) this.emit();
      if (e.key === LS_SETTINGS) onSettings?.(readLocalSettings());
    });
    onSettings?.(readLocalSettings());
    this.emit();
  }

  async saveSettings(settings) {
    const clean = sanitizeSettings(settings);
    localStorage.setItem(LS_SETTINGS, JSON.stringify(clean));
    this.onSettings?.(clean);
  }

  emit() { this.onEntries(sortEntries(readLocalEntries())); }

  async apply(ops) {
    const map = new Map(readLocalEntries().map((e) => [e.id, e]));
    for (const o of ops) {
      if (o.op === 'set') map.set(String(o.entry.id), sanitize(o.entry));
      else if (o.op === 'update') {
        const cur = map.get(o.id);
        if (cur) map.set(o.id, sanitize({ ...cur, ...o.patch }));
      } else if (o.op === 'delete') map.delete(o.id);
    }
    localStorage.setItem(LS_KEY, JSON.stringify([...map.values()]));
    this.emit();
  }
}

/* ------------------------------------------------------------- firebase */

export async function createFirebaseStore(config) {
  const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
  const [appMod, A, F] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);
  const app = appMod.initializeApp(config);
  const auth = A.getAuth(app);
  let db;
  try {
    // offline support: changes are kept locally and synced when back online
    db = F.initializeFirestore(app, {
      localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
    });
  } catch {
    db = F.getFirestore(app);
  }
  return new FirebaseStore(A, F, auth, db);
}

class FirebaseStore {
  mode = 'cloud';

  constructor(A, F, auth, db) {
    Object.assign(this, { A, F, auth, db });
    this.user = null;
    this.unsub = null;
  }

  async init({ onEntries, onStatus, onUser, onSettings }) {
    const { A, F } = this;
    this.onSettings = onSettings;
    A.getRedirectResult(this.auth).catch((err) => onStatus?.({ state: 'error', message: err.message }));
    A.onAuthStateChanged(this.auth, (user) => {
      this.user = user;
      this.unsub?.();
      this.unsub = null;
      this.unsubSettings?.();
      this.unsubSettings = null;
      onUser?.(user);
      if (!user) { onEntries([]); onSettings?.({ colors: {} }); return; }
      this.unsubSettings = F.onSnapshot(this.settingsDoc(), (snap) => {
        onSettings?.(sanitizeSettings(snap.data() || {}));
      }, (err) => {
        console.warn('Settings unavailable:', err.message);
        this.settingsError = err;
      });
      this.unsub = F.onSnapshot(this.col(), { includeMetadataChanges: true }, (snap) => {
        onEntries(sortEntries(snap.docs.map((d) => sanitize({ id: d.id, ...d.data() }))));
        onStatus?.({
          state: snap.metadata.hasPendingWrites ? 'pending'
            : snap.metadata.fromCache ? 'cache' : 'synced',
        });
      }, (err) => onStatus?.({ state: 'error', message: err.message }));
    });
  }

  col() { return this.F.collection(this.db, 'users', this.user.uid, 'entries'); }

  settingsDoc() { return this.F.doc(this.db, 'users', this.user.uid, 'settings', 'prefs'); }

  async saveSettings(settings) {
    if (!this.user) throw new Error('Not signed in');
    const clean = sanitizeSettings(settings);
    this.onSettings?.(clean); // show immediately
    try {
      await this.F.setDoc(this.settingsDoc(), { ...clean, updatedAt: this.F.serverTimestamp() });
    } catch (e) {
      if (e.code === 'permission-denied') {
        throw new Error('Firestore rules need updating to save colors – paste the new firestore.rules into Firebase (see README)');
      }
      throw e;
    }
  }

  async signIn() {
    const { A } = this;
    const provider = new A.GoogleAuthProvider();
    try {
      await A.signInWithPopup(this.auth, provider);
    } catch (e) {
      const fallback = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment',
        'auth/cancelled-popup-request'];
      if (fallback.includes(e.code)) return A.signInWithRedirect(this.auth, provider);
      throw e;
    }
  }

  signOut() { return this.A.signOut(this.auth); }

  async apply(ops) {
    if (!this.user) throw new Error('Not signed in');
    const { F } = this;
    for (let i = 0; i < ops.length; i += 450) {
      const batch = F.writeBatch(this.db);
      for (const o of ops.slice(i, i + 450)) {
        if (o.op === 'set') {
          const e = sanitize(o.entry);
          batch.set(F.doc(this.col(), e.id), {
            activity: e.activity, start: e.start, note: e.note, updatedAt: F.serverTimestamp(),
          });
        } else if (o.op === 'update') {
          batch.update(F.doc(this.col(), o.id), { ...o.patch, updatedAt: F.serverTimestamp() });
        } else if (o.op === 'delete') {
          batch.delete(F.doc(this.col(), o.id));
        }
      }
      await batch.commit();
    }
  }
}
