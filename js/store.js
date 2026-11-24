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

  async init({ onEntries, onStatus }) {
    this.onEntries = onEntries;
    onStatus?.({ state: 'local' });
    // keep several open tabs in sync
    window.addEventListener('storage', (e) => { if (e.key === LS_KEY) this.emit(); });
    this.emit();
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

  async init({ onEntries, onStatus, onUser }) {
    const { A, F } = this;
    A.getRedirectResult(this.auth).catch((err) => onStatus?.({ state: 'error', message: err.message }));
    A.onAuthStateChanged(this.auth, (user) => {
      this.user = user;
      this.unsub?.();
      this.unsub = null;
      onUser?.(user);
      if (!user) { onEntries([]); return; }
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
