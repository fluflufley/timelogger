import { firebaseConfig } from './config.js';
import {
  LocalStore, createFirebaseStore, newId, readLocalEntries, clearLocalEntries, sanitize,
} from './store.js';

/* =============================================================== helpers */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const pad = (n) => String(n).padStart(2, '0');

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const dayYearFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });

const fmtTime = (ms) => timeFmt.format(ms);
function fmtDur(ms) {
  if (ms <= 0) return '0m';
  if (ms < MIN) return '<1m';
  const m = Math.round(ms / MIN);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m}m`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function fmtDay(ms) {
  const today = startOfDay(Date.now());
  if (ms === today) return 'Today';
  if (ms === addDays(today, -1)) return 'Yesterday';
  return new Date(ms).getFullYear() === new Date().getFullYear() ? dayFmt.format(ms) : dayYearFmt.format(ms);
}
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(ms, n) { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function keyToMs(k) { return new Date(`${k}T00:00`).getTime(); }
function toLocalInput(ms) { const d = new Date(ms); return `${dayKey(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fromLocalInput(s) { if (!s) return null; const t = new Date(s).getTime(); return Number.isNaN(t) ? NaN : t; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => (s || '').trim().replace(/\s+/g, ' ');
const norm = (s) => clean(s).toLowerCase();

const TAG_RE = /#([\p{L}\p{N}_-]+)/gu;
const tagsOf = (a) => [...new Set([...(a || '').matchAll(TAG_RE)].map((m) => m[1].toLowerCase()))];
const withTags = (a) => esc(a).replace(TAG_RE, '<span class="tag">#$1</span>');

const PALETTE = ['#d9643a', '#3f86c7', '#4fa36c', '#c49a1e', '#9a63c9', '#d1506f', '#2fa3a0', '#7f8a2e', '#c97a2b', '#5e70c9', '#b65a9e', '#5b8f8a'];
const OTHER = '#9a958b';
let colorMap = new Map();
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function colorFor(key) { return colorMap.get(key) || PALETTE[hash(key) % PALETTE.length]; }

/* ================================================================= state */

const state = {
  entries: [],
  tab: 'now',
  range: 'week',
  groupBy: 'activity',
  customFrom: '',
  customTo: '',
  offset: '0',
  mode: 'local',
  user: null,
  sync: { state: 'local' },
  loaded: false,
};
let store;

function saved(key, fallback) { try { return localStorage.getItem('timelog.ui.' + key) ?? fallback; } catch { return fallback; } }
function save(key, v) { try { localStorage.setItem('timelog.ui.' + key, v); } catch { /* ignore */ } }
state.range = saved('range', 'week');
state.groupBy = saved('groupBy', 'activity');

/* =========================================================== derivations */

// Adds `end` (the next entry's start, or now if still running) to each entry.
function withEnds(entries = state.entries, now = Date.now()) {
  return entries.map((e, i) => {
    const next = entries[i + 1];
    const end = next ? next.start : (e.activity ? Math.max(now, e.start) : e.start);
    return { ...e, end, ongoing: !next && !!e.activity };
  });
}

function current() {
  const last = state.entries.at(-1);
  return last && last.activity ? last : null;
}

function recomputeColors() {
  const totals = new Map();
  for (const e of withEnds()) {
    if (!e.activity) continue;
    const k = norm(e.activity);
    totals.set(k, (totals.get(k) || 0) + (e.end - e.start));
    for (const t of tagsOf(e.activity)) totals.set('#' + t, (totals.get('#' + t) || 0) + (e.end - e.start));
  }
  const acts = [...totals].filter(([k]) => !k.startsWith('#')).sort((a, b) => b[1] - a[1]);
  const tags = [...totals].filter(([k]) => k.startsWith('#')).sort((a, b) => b[1] - a[1]);
  colorMap = new Map();
  acts.slice(0, PALETTE.length).forEach(([k], i) => colorMap.set(k, PALETTE[i]));
  tags.slice(0, PALETTE.length).forEach(([k], i) => colorMap.set(k, PALETTE[i]));
}

function* daySlices(s, e) {
  let cur = s;
  while (cur < e) {
    const next = Math.min(e, addDays(startOfDay(cur), 1));
    yield [startOfDay(cur), next - cur];
    cur = next;
  }
}

function rangeBounds() {
  const now = Date.now();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  switch (state.range) {
    case 'today': return [today, tomorrow];
    case 'yesterday': return [addDays(today, -1), today];
    case 'month30': return [addDays(today, -29), tomorrow];
    case 'thismonth': { const d = new Date(now); return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), tomorrow]; }
    case 'all': return [startOfDay(state.entries[0]?.start ?? now), tomorrow];
    case 'custom': {
      const from = state.customFrom || dayKey(today);
      let to = state.customTo || from;
      if (to < from) to = from;
      return [keyToMs(from), addDays(keyToMs(to), 1)];
    }
    case 'week':
    default: return [addDays(today, -6), tomorrow];
  }
}

function groupKeys(activity) {
  if (state.groupBy === 'tag') {
    const t = tagsOf(activity);
    return t.length ? t.map((x) => '#' + x) : ['(untagged)'];
  }
  return [norm(activity)];
}

function computeStats(rs, re) {
  const groups = new Map();
  const days = new Map();
  let total = 0;
  let count = 0;
  for (const e of withEnds()) {
    if (!e.activity) continue;
    const s = Math.max(e.start, rs);
    const en = Math.min(e.end, re);
    if (en <= s) continue;
    const dur = en - s;
    count++;
    total += dur;
    const keys = groupKeys(e.activity);
    for (const k of keys) {
      const g = groups.get(k) || { key: k, label: k, ms: 0, n: 0, last: -1 };
      g.ms += dur;
      g.n++;
      if (e.start > g.last) { g.last = e.start; if (state.groupBy !== 'tag') g.label = e.activity; }
      groups.set(k, g);
    }
    for (const [d, ms] of daySlices(s, en)) {
      const m = days.get(d) || new Map();
      for (const k of keys) m.set(k, (m.get(k) || 0) + ms);
      m.set('__total', (m.get('__total') || 0) + ms);
      days.set(d, m);
    }
  }
  return { groups: [...groups.values()].sort((a, b) => b.ms - a.ms), days, total, count };
}

/* ============================================================= rendering */

function render() {
  if (!state.loaded) return;
  const needsAuth = state.mode === 'cloud' && !state.user;
  $('#view-loading').hidden = true;
  $('#view-auth').hidden = !needsAuth;
  $('#tabs').hidden = needsAuth;
  $('#view-now').hidden = needsAuth || state.tab !== 'now';
  $('#view-log').hidden = needsAuth || state.tab !== 'log';
  $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  renderSync();
  if (needsAuth) return;
  renderDatalist();
  if (state.tab === 'now') renderNow(); else renderLog();
  tick();
}

function renderSync() {
  const dot = $('#syncDot');
  const s = state.sync.state;
  const offline = !navigator.onLine;
  const map = {
    local: ['', 'Saved on this device only'],
    synced: ['ok', 'All changes synced'],
    pending: ['wait', offline ? 'Offline – changes will sync when you reconnect' : 'Syncing…'],
    cache: ['wait', 'Offline – showing saved data'],
    error: ['bad', 'Sync error: ' + (state.sync.message || '')],
  };
  const [cls, text] = map[s] || map.local;
  dot.className = 'dot ' + cls;
  dot.title = text;
}

function renderDatalist() {
  const seen = new Set();
  const opts = [];
  for (let i = state.entries.length - 1; i >= 0 && opts.length < 200; i--) {
    const a = state.entries[i].activity;
    if (!a || seen.has(norm(a))) continue;
    seen.add(norm(a));
    opts.push(`<option value="${esc(a)}"></option>`);
  }
  $('#activityList').innerHTML = opts.join('');
}

function renderNow() {
  const cur = current();
  const last = state.entries.at(-1);
  $('#current').classList.toggle('idle', !cur);
  $('#stopBtn').hidden = !cur;
  if (cur) {
    $('#curLabel').textContent = 'Now';
    $('#curActivity').innerHTML = withTags(cur.activity);
    $('#current').style.setProperty('--c', colorFor(norm(cur.activity)));
  } else {
    $('#curLabel').textContent = 'Not tracking';
    $('#curActivity').innerHTML = '<span class="muted">Nothing running</span>';
    $('#current').style.removeProperty('--c');
    $('#curSince').textContent = last ? `Last stopped at ${fmtTime(last.start)}` : 'Type what you\'re doing below to start.';
    $('#curTimer').textContent = '';
  }

  // offset buttons
  $$('#offsetSeg button').forEach((b) => b.classList.toggle('on', b.dataset.off === state.offset));
  $('#customTime').hidden = state.offset !== 'custom';

  // recent chips
  const seen = new Set(cur ? [norm(cur.activity)] : []);
  const chips = [];
  for (let i = state.entries.length - 1; i >= 0 && chips.length < 8; i--) {
    const a = state.entries[i].activity;
    if (!a || seen.has(norm(a))) continue;
    seen.add(norm(a));
    chips.push(`<button type="button" class="chip" data-act="${esc(a)}" style="--c:${colorFor(norm(a))}" dir="auto">${withTags(a)}</button>`);
  }
  $('#recentChips').innerHTML = chips.join('');

  // today
  const today = startOfDay(Date.now());
  const tomorrow = addDays(today, 1);
  const list = withEnds().filter((e) => e.end > today && e.start < tomorrow && (e.activity || e.end > e.start));
  const total = list.filter((e) => e.activity)
    .reduce((s, e) => s + (Math.min(e.end, tomorrow) - Math.max(e.start, today)), 0);
  $('#todayTotal').textContent = total ? `${fmtDur(total)} tracked` : '';
  $('#todayRibbon').innerHTML = list.length ? ribbon(today, tomorrow) : '';
  $('#todayList').innerHTML = list.length
    ? list.slice().reverse().map((e) => entryRow(e, today, tomorrow)).join('')
    : '<li class="empty muted">Nothing logged yet today.</li>';
}

function entryRow(e, rs = -Infinity, re = Infinity) {
  const s = Math.max(e.start, rs);
  const en = Math.min(e.end, re);
  const dur = en - s;
  const span = `${fmtTime(e.start)}–${e.ongoing ? 'now' : fmtTime(e.end)}`;
  const carried = e.start < rs ? '<span class="muted small" title="Started the day before">↤ </span>' : '';
  if (!e.activity) {
    const label = e.end > e.start ? 'Untracked' : 'Stopped';
    return `<li class="entry untracked" data-id="${e.id}" tabindex="0">
      <span class="when">${carried}${e.end > e.start ? span : fmtTime(e.start)}</span>
      <span class="what">${label}</span>
      <span class="dur">${e.end > e.start ? fmtDur(dur) : ''}</span></li>`;
  }
  return `<li class="entry${e.ongoing ? ' ongoing' : ''}" data-id="${e.id}" tabindex="0" style="--c:${colorFor(norm(e.activity))}">
    <span class="when">${carried}${span}</span>
    <span class="what" dir="auto">${withTags(e.activity)}${e.note ? `<span class="note" dir="auto">${esc(e.note)}</span>` : ''}</span>
    <span class="dur">${fmtDur(dur)}</span></li>`;
}

function ribbon(rs, re) {
  // 24h strip for a single day
  const span = re - rs;
  const segs = withEnds().filter((e) => e.activity && e.end > rs && e.start < re).map((e) => {
    const s = Math.max(e.start, rs);
    const en = Math.min(e.end, re);
    const left = ((s - rs) / span) * 100;
    const w = Math.max(((en - s) / span) * 100, 0.15);
    return `<span class="seg-bar" style="left:${left}%;width:${w}%;--c:${colorFor(norm(e.activity))}" title="${esc(e.activity)} · ${fmtTime(e.start)}–${e.ongoing ? 'now' : fmtTime(e.end)} · ${fmtDur(en - s)}"></span>`;
  }).join('');
  const ticks = [0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${pad(h % 24 === 0 && h ? 24 : h)}</span>`).join('');
  const nowPos = Date.now() >= rs && Date.now() < re ? `<span class="now-line" style="left:${((Date.now() - rs) / span) * 100}%"></span>` : '';
  return `<div class="ribbon"><div class="ribbon-track">${segs}${nowPos}</div><div class="ribbon-ticks">${ticks}</div></div>`;
}

function renderLog() {
  $$('#rangeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.range === state.range));
  $$('#groupSeg button').forEach((b) => b.classList.toggle('on', b.dataset.group === state.groupBy));
  $('#customRange').hidden = state.range !== 'custom';
  const [rs, re] = rangeBounds();
  if (state.range === 'custom') {
    $('#fromDate').value = dayKey(rs);
    $('#toDate').value = dayKey(addDays(re, -1));
  }
  const st = computeStats(rs, re);

  // stat tiles
  const activeDays = [...st.days.values()].filter((m) => m.get('__total') > 0).length;
  const top = state.groupBy === 'tag' ? st.groups.find((g) => g.key !== '(untagged)') : st.groups[0];
  const longest = Math.max(0, ...[...st.days.values()].map((m) => m.get('__total') || 0));
  $('#statsGrid').innerHTML = [
    ['Tracked', fmtDur(st.total)],
    ['Avg / active day', activeDays ? fmtDur(st.total / activeDays) : '–'],
    ['Entries', st.count],
    [state.groupBy === 'tag' ? 'Top tag' : 'Top activity', top ? `<span dir="auto">${esc(top.label)}</span>` : '–'],
    ['Active days', activeDays],
    ['Busiest day', longest ? fmtDur(longest) : '–'],
  ].map(([k, v]) => `<div class="stat"><div class="stat-v">${v}</div><div class="stat-k">${k}</div></div>`).join('');

  // breakdown bars
  const max = st.groups[0]?.ms || 1;
  $('#breakdown').innerHTML = st.groups.length ? st.groups.map((g) => {
    const pct = st.total ? Math.round((g.ms / st.total) * 100) : 0;
    const c = g.key === '(untagged)' ? OTHER : colorFor(g.key);
    return `<li style="--c:${c}">
      <div class="bar-head"><span class="bar-label" dir="auto">${state.groupBy === 'tag' ? esc(g.label) : withTags(g.label)}</span>
      <span class="bar-val">${fmtDur(g.ms)} <span class="muted">· ${pct}%</span></span></div>
      <div class="bar"><span style="width:${(g.ms / max) * 100}%"></span></div></li>`;
  }).join('') : '<li class="empty muted">No tracked time in this range.</li>';
  if (state.groupBy === 'tag' && st.groups.length) {
    $('#breakdown').insertAdjacentHTML('beforeend', '<li class="hint">Add tags by writing #something in an activity. Entries with several tags count toward each.</li>');
  }

  // chart
  const nDays = Math.round((re - rs) / DAY);
  $('#chart').innerHTML = !st.total ? '' : nDays <= 1 ? ribbon(rs, re) : stackedChart(st, rs, re, nDays);

  // entries grouped by day
  const iv = withEnds().filter((e) => e.end > rs && e.start < re && (e.activity || e.end > e.start));
  const byDay = new Map();
  for (const e of iv) {
    const d = Math.max(startOfDay(e.start), rs);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  const daysSorted = [...byDay.keys()].sort((a, b) => b - a);
  const LIMIT = 120;
  $('#logList').innerHTML = daysSorted.length ? daysSorted.slice(0, LIMIT).map((d) => {
    const dEnd = addDays(d, 1);
    const tot = st.days.get(d)?.get('__total') || 0;
    return `<div class="day"><div class="day-head"><span>${fmtDay(d)}</span><span class="muted">${fmtDur(tot)}</span></div>
      <ol class="entries">${byDay.get(d).map((e) => entryRow(e, d, dEnd)).join('')}</ol></div>`;
  }).join('') + (daysSorted.length > LIMIT ? `<p class="hint">Showing the latest ${LIMIT} days. Narrow the range to see older entries.</p>` : '')
    : '<p class="empty muted">No entries in this range.</p>';
}

function stackedChart(st, rs, re, nDays) {
  const now = Date.now();
  const weekly = nDays > 62;
  const buckets = [];
  if (weekly) {
    let w = addDays(startOfDay(rs), -new Date(rs).getDay()); // weeks start Sunday
    while (w < re) { buckets.push([w, addDays(w, 7)]); w = addDays(w, 7); }
  } else {
    for (let d = rs; d < re; d = addDays(d, 1)) buckets.push([d, addDays(d, 1)]);
  }
  const topKeys = st.groups.slice(0, 7).map((g) => g.key);
  const data = buckets.map(([bs, be]) => {
    const vals = new Map();
    let tot = 0;
    for (const [d, m] of st.days) {
      if (d < bs || d >= be) continue;
      for (const [k, ms] of m) {
        if (k === '__total') { tot += ms; continue; }
        const key = topKeys.includes(k) ? k : '__other';
        vals.set(key, (vals.get(key) || 0) + ms);
      }
    }
    return { bs, be, vals, tot };
  });
  const max = Math.max(...data.map((d) => Math.max(d.tot, [...d.vals.values()].reduce((a, b) => a + b, 0))), 1);
  const labelEvery = buckets.length > 20 ? Math.ceil(buckets.length / 10) : 1;
  const cols = data.map((d, i) => {
    const future = d.bs > now;
    const keys = [...topKeys, '__other'].filter((k) => d.vals.get(k));
    const segs = keys.map((k) => {
      const g = st.groups.find((x) => x.key === k);
      const name = k === '__other' ? 'Other' : g?.label || k;
      const c = k === '__other' || k === '(untagged)' ? OTHER : colorFor(k);
      return `<span style="height:${(d.vals.get(k) / max) * 100}%;background:${c}" title="${esc(name)}: ${fmtDur(d.vals.get(k))}"></span>`;
    }).join('');
    const label = weekly ? shortFmt.format(d.bs) : (buckets.length <= 7 ? wdFmt.format(d.bs) : new Date(d.bs).getDate());
    const title = `${weekly ? 'Week of ' + shortFmt.format(d.bs) : fmtDay(d.bs)} · ${fmtDur(d.tot)}`;
    return `<div class="col${future ? ' future' : ''}" title="${esc(title)}"><div class="stack">${segs}</div>
      <div class="col-label">${i % labelEvery === 0 ? label : ''}</div></div>`;
  }).join('');
  const legend = st.groups.length ? `<div class="legend">${topKeys.map((k) => {
    const g = st.groups.find((x) => x.key === k);
    const c = k === '(untagged)' ? OTHER : colorFor(k);
    return `<span><i style="background:${c}"></i><span dir="auto">${esc(g.label)}</span></span>`;
  }).join('')}${st.groups.length > 7 ? `<span><i style="background:${OTHER}"></i>Other</span>` : ''}</div>` : '';
  return `<div class="chart-wrap"><div class="chart-max muted">${fmtDur(max)}</div><div class="cols">${cols}</div></div>${legend}`;
}

/* ========================================================== live updates */

function tick() {
  const cur = current();
  if (cur && state.tab === 'now') {
    $('#curTimer').textContent = fmtClock(Date.now() - cur.start);
    const startedDay = startOfDay(cur.start) === startOfDay(Date.now()) ? '' : `${shortFmt.format(cur.start)} `;
    $('#curSince').textContent = `since ${startedDay}${fmtTime(cur.start)}`;
  }
  document.title = cur ? `${fmtClock(Date.now() - cur.start).replace(/:\d\d$/, '')} · ${cur.activity} — Timelog` : 'Timelog';
}
setInterval(tick, 1000);
setInterval(() => { if (!$('#editDialog').open) render(); }, 30e3);
window.addEventListener('online', renderSync);
window.addEventListener('offline', renderSync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

/* ================================================================ writes */

function apply(ops) {
  return store.apply(ops).catch((err) => {
    console.error(err);
    toast('Could not save: ' + err.message, true);
  });
}

function chosenStart() {
  const now = Date.now();
  if (state.offset === 'custom') {
    const v = $('#customTime').value;
    if (!v) { toast('Pick the time you started'); $('#customTime').focus(); return null; }
    const [h, m] = v.split(':').map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    let t = d.getTime();
    if (t > now) t = addDays(t, -1); // a time later than now means yesterday
    return t;
  }
  return now - Number(state.offset) * MIN;
}

function resetOffset() {
  state.offset = '0';
  $('#customTime').value = '';
}

function startActivity(text) {
  const activity = clean(text);
  if (!activity) { $('#activityInput').focus(); return; }
  const start = chosenStart();
  if (start == null) return;
  const last = state.entries.at(-1);
  if (last && start <= last.start) {
    toast(`That's before the last entry (${fmtTime(last.start)}). Use “Add entry” in the Log for past entries.`);
    return;
  }
  if (last?.activity && norm(last.activity) === norm(activity)) { toast('Already tracking that'); return; }
  apply([{ op: 'set', entry: { id: newId(), activity, start, note: '' } }]);
  $('#activityInput').value = '';
  resetOffset();
  render();
}

function stopActivity() {
  const cur = current();
  if (!cur) return;
  const at = chosenStart();
  if (at == null) return;
  if (at <= cur.start) { toast(`That's before “${cur.activity}” started.`); return; }
  apply([{ op: 'set', entry: { id: newId(), activity: null, start: at, note: '' } }]);
  resetOffset();
  render();
}

/* ========================================================== edit dialog */

let editing = null; // { entry|null, startStr, endStr }

function neighbors(id, start) {
  const others = state.entries.filter((e) => e.id !== id);
  let i = others.findIndex((e) => e.start > start);
  if (i === -1) i = others.length;
  return { prev: others[i - 1] || null, next: others[i] || null, nextnext: others[i + 1] || null, others };
}

function openEdit(entry) {
  const f = $('#editForm');
  f.reset();
  $('#editError').textContent = '';
  const startMs = entry ? entry.start : Math.floor(Date.now() / MIN) * MIN;
  const startStr = toLocalInput(startMs);
  const { next } = neighbors(entry?.id, startMs);
  const endStr = entry && next ? toLocalInput(next.start) : '';
  editing = { entry, startStr, endStr };
  $('#editTitle').textContent = entry ? 'Edit entry' : 'Add entry';
  f.activity.value = entry?.activity || '';
  f.start.value = startStr;
  f.end.value = endStr;
  f.note.value = entry?.note || '';
  $('#deleteBtn').hidden = !entry;
  updateEditHints();
  $('#editDialog').showModal();
  if (!entry) f.activity.focus();
}

function editTimes() {
  const f = $('#editForm');
  const start = f.start.value === editing.startStr && editing.entry ? editing.entry.start : fromLocalInput(f.start.value);
  const endChanged = f.end.value !== editing.endStr;
  const end = endChanged ? fromLocalInput(f.end.value) : null;
  return { start, end, endChanged };
}

function updateEditHints() {
  const f = $('#editForm');
  const hint = $('#endHint');
  const thenRow = $('#thenRow');
  thenRow.hidden = true;
  const { start, end, endChanged } = editTimes();
  if (start == null || Number.isNaN(start)) { hint.textContent = ''; return; }
  const { prev, next } = neighbors(editing.entry?.id, start);
  const nm = (e) => (e.activity ? `“${e.activity}”` : 'untracked time');
  if (!endChanged || end == null) {
    if (!f.end.value) {
      hint.textContent = next
        ? `Empty end = lasts until the next entry, ${nm(next)}, at ${fmtTime(next.start)}.`
        : 'Empty end = still going.';
    } else {
      hint.textContent = next ? `Followed by ${nm(next)}.` : '';
    }
    return;
  }
  if (Number.isNaN(end)) { hint.textContent = ''; return; }
  if (end <= start) { hint.textContent = 'End must be after start.'; return; }
  if (!next) { hint.textContent = `Tracking stops at ${fmtTime(end)}.`; return; }
  if (end > next.start) { hint.textContent = `${nm(next)} will start later, at ${fmtTime(end)}.`; return; }
  if (end < next.start) {
    hint.textContent = `There will be a gap until ${nm(next)} at ${fmtTime(next.start)}. What happened in it?`;
    const sel = f.then;
    const resumeOpt = prev?.activity ? `<option value="resume">Back to “${esc(prev.activity)}”</option>` : '';
    const prevVal = sel.value;
    sel.innerHTML = `${resumeOpt}<option value="idle">Nothing (untracked)</option>`;
    sel.value = prevVal && sel.querySelector(`option[value="${prevVal}"]`) ? prevVal
      : (!editing.entry && prev?.activity ? 'resume' : 'idle');
    thenRow.hidden = false;
  }
}

function saveEdit(ev) {
  ev.preventDefault();
  const f = $('#editForm');
  const err = (m) => { $('#editError').textContent = m; };
  const id = editing.entry?.id || newId();
  const activity = clean(f.activity.value) || null;
  const { start, end, endChanged } = editTimes();
  if (start == null || Number.isNaN(start)) return err('Please enter a valid start time.');
  if (endChanged && end != null && Number.isNaN(end)) return err('Please enter a valid end time.');
  if (endChanged && end != null && end <= start) return err('End must be after start.');
  const { prev, next, nextnext, others } = neighbors(id, start);
  if (others.some((e) => e.start === start)) return err('Another entry starts at exactly this time. Pick a different minute.');

  const ops = [{ op: 'set', entry: { id, activity, start, note: f.note.value.trim() } }];
  if (endChanged && end != null) {
    if (!next) {
      ops.push({ op: 'set', entry: { id: newId(), activity: null, start: end, note: '' } });
    } else if (end > next.start) {
      if (nextnext && end >= nextnext.start) {
        return err(`That end time runs past “${nextnext.activity || 'untracked'}” (${fmtTime(nextnext.start)}). Edit or delete the entries in between first.`);
      }
      ops.push({ op: 'update', id: next.id, patch: { start: end } });
    } else if (end < next.start) {
      const then = f.then.value || 'idle';
      if (then === 'idle' && !next.activity) {
        ops.push({ op: 'update', id: next.id, patch: { start: end } });
      } else {
        ops.push({ op: 'set', entry: { id: newId(), activity: then === 'resume' ? prev?.activity ?? null : null, start: end, note: '' } });
      }
    }
  }
  apply(ops);
  $('#editDialog').close();
  toast(editing.entry ? 'Saved' : 'Entry added');
}

function deleteEdit() {
  const e = editing.entry;
  if (!e) return;
  const { prev } = neighbors(e.id, e.start);
  const msg = prev?.activity
    ? `Delete this entry?\n\nIts time will be added to the entry before it (“${prev.activity}”). To keep the gap instead, clear the activity name and save.`
    : 'Delete this entry?';
  if (!confirm(msg)) return;
  apply([{ op: 'delete', id: e.id }]);
  $('#editDialog').close();
  toast('Deleted');
}

/* ======================================================== export/import */

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(all) {
  const [rs, re] = all ? [-Infinity, Infinity] : rangeBounds();
  const rows = withEnds().filter((e) => e.activity && e.end > rs && e.start < re);
  const local = (ms) => { const d = new Date(ms); return `${dayKey(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const lines = [['Date', 'Start', 'End', 'Duration (min)', 'Duration', 'Activity', 'Tags', 'Note', 'Ongoing'].join(',')];
  for (const e of rows) {
    const dur = e.end - e.start;
    lines.push([dayKey(e.start), local(e.start), local(e.end), Math.round(dur / MIN), fmtDur(dur),
      e.activity, tagsOf(e.activity).map((t) => '#' + t).join(' '), e.note, e.ongoing ? 'yes' : '']
      .map(csvCell).join(','));
  }
  const name = all ? `timelog-all-${dayKey(Date.now())}.csv` : `timelog-${dayKey(rs)}_to_${dayKey(addDays(re, -1))}.csv`;
  // BOM so Excel reads UTF-8 (Hebrew etc.) correctly
  download(name, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} entries`);
}

function exportJson() {
  const data = { app: 'timelog', version: 1, exportedAt: new Date().toISOString(), entries: state.entries };
  download(`timelog-backup-${dayKey(Date.now())}.json`, JSON.stringify(data, null, 2), 'application/json');
}

async function importJson(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = (Array.isArray(data) ? data : data.entries || [])
      .map((e) => sanitize({ ...e, id: e.id || newId() }))
      .filter((e) => Number.isFinite(e.start) && e.start > 0);
    if (!list.length) return toast('No entries found in that file', true);
    if (!confirm(`Restore ${list.length} entries from “${file.name}”?\n\nEntries are merged with what you have (same entries get overwritten, nothing is deleted).`)) return;
    await apply(list.map((entry) => ({ op: 'set', entry })));
    toast(`Restored ${list.length} entries`);
  } catch (e) {
    toast('Could not read that file: ' + e.message, true);
  }
}

/* ================================================================== menu */

function openMenu() {
  const acts = $('#menuActions');
  acts.innerHTML = '';
  const s = state.sync.state;
  if (state.mode === 'local') {
    $('#menuMode').innerHTML = '<strong>Local mode.</strong> Your log is saved in this browser only. Add a Firebase config (see README) to sync between devices.';
  } else if (state.user) {
    $('#menuMode').innerHTML = `Signed in as <strong>${esc(state.user.email || state.user.displayName)}</strong>. Your log syncs across devices.`;
    const localCount = readLocalEntries().length;
    if (localCount) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = `Upload ${localCount} entries saved on this device`;
      b.onclick = async () => {
        if (!confirm(`Copy ${localCount} locally-saved entries into your account?`)) return;
        await apply(readLocalEntries().map((entry) => ({ op: 'set', entry })));
        clearLocalEntries();
        toast('Uploaded');
        openMenu();
      };
      acts.append(b);
    }
    const out = document.createElement('button');
    out.className = 'btn';
    out.textContent = 'Sign out';
    out.onclick = () => { store.signOut(); $('#menuDialog').close(); };
    acts.append(out);
  } else {
    $('#menuMode').textContent = 'Not signed in.';
  }
  $('#menuSync').textContent = $('#syncDot').title + (s === 'local' ? '' : '.');
  if (!$('#menuDialog').open) $('#menuDialog').showModal();
}

/* ================================================================= toast */

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2600);
}

/* ================================================================ events */

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  location.hash = state.tab === 'log' ? 'log' : '';
  render();
});
window.addEventListener('hashchange', () => { state.tab = location.hash === '#log' ? 'log' : 'now'; render(); });
state.tab = location.hash === '#log' ? 'log' : 'now';

$('#startForm').addEventListener('submit', (e) => { e.preventDefault(); startActivity($('#activityInput').value); });
$('#recentChips').addEventListener('click', (e) => {
  const c = e.target.closest('[data-act]');
  if (c) startActivity(c.dataset.act);
});
$('#offsetSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-off]');
  if (!b) return;
  state.offset = b.dataset.off;
  renderNow();
  if (state.offset === 'custom') {
    const t = $('#customTime');
    if (!t.value) { const d = new Date(); t.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
    t.focus();
  }
});
$('#stopBtn').addEventListener('click', stopActivity);

$('#rangeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  state.range = b.dataset.range;
  save('range', state.range);
  if (state.range === 'custom' && !state.customFrom) {
    state.customFrom = dayKey(addDays(Date.now(), -13));
    state.customTo = dayKey(Date.now());
  }
  renderLog();
});
$('#fromDate').addEventListener('change', (e) => { state.customFrom = e.target.value; renderLog(); });
$('#toDate').addEventListener('change', (e) => { state.customTo = e.target.value; renderLog(); });
$('#groupSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-group]');
  if (!b) return;
  state.groupBy = b.dataset.group;
  save('groupBy', state.groupBy);
  renderLog();
});

function onEntryActivate(e) {
  const li = e.target.closest('.entry[data-id]');
  if (!li) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  const entry = state.entries.find((x) => x.id === li.dataset.id);
  if (entry) openEdit(entry);
}
for (const sel of ['#todayList', '#logList']) {
  $(sel).addEventListener('click', onEntryActivate);
  $(sel).addEventListener('keydown', onEntryActivate);
}

$('#addEntryBtn').addEventListener('click', () => openEdit(null));
$('#editForm').addEventListener('submit', saveEdit);
$('#editForm').addEventListener('input', (e) => { if (['start', 'end'].includes(e.target.name)) updateEditHints(); });
$('#cancelEdit').addEventListener('click', () => $('#editDialog').close());
$('#deleteBtn').addEventListener('click', deleteEdit);
$('#editDialog').addEventListener('close', () => render());

$('#exportCsvRange').addEventListener('click', () => exportCsv(false));
$('#exportCsvAll').addEventListener('click', () => exportCsv(true));
$('#exportJson').addEventListener('click', exportJson);
$('#importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importJson(file);
});

$('#menuBtn').addEventListener('click', openMenu);
$('#closeMenu').addEventListener('click', () => $('#menuDialog').close());
for (const d of ['#editDialog', '#menuDialog']) {
  $(d).addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
}
$('#signInBtn').addEventListener('click', async () => {
  $('#authError').textContent = '';
  try { await store.signIn(); } catch (e) { $('#authError').textContent = e.message; }
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input,textarea,select') && state.tab === 'now') {
    e.preventDefault();
    $('#activityInput').focus();
  }
});

/* ================================================================== boot */

async function boot() {
  try {
    store = firebaseConfig ? await createFirebaseStore(firebaseConfig) : new LocalStore();
  } catch (e) {
    console.error(e);
    $('#view-loading').innerHTML = `<p class="error center">Couldn't load Firebase (${esc(e.message)}). Check your connection and js/config.js.</p>`;
    return;
  }
  state.mode = store.mode;
  await store.init({
    onEntries: (list) => {
      state.entries = list;
      state.loaded = true;
      recomputeColors();
      if (!$('#editDialog').open) render();
    },
    onStatus: (s) => { state.sync = s; renderSync(); },
    onUser: (u) => { state.user = u; state.loaded = true; render(); },
  });
}
boot();
