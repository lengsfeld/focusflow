import "./index.css";
import { useEffect, useMemo, useRef, useState } from "react";

console.log("🧩 App.jsx wurde geladen");

/* =========================================================
   FocusFlow – vereinfacht (ohne Eisenhower)
   Lokale Speicherung; Tagesplan, Pausen, Pool, Inbox, Journal, Check-in
   ========================================================= */

/* ---------- Persistenz ---------- */
const LS_KEY = "focusflow_v7";
const load = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; } catch { return null; }
};
const save = (s) => { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { } };
const uid = () => (
  (typeof globalThis !== "undefined"
    && globalThis.crypto
    && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : (Date.now().toString(36) + Math.random().toString(36).slice(2))
);

const clone = (o) => (
  typeof structuredClone === "function"
    ? structuredClone(o)
    : JSON.parse(JSON.stringify(o))
);

/* ---------- Startzustand ---------- */
const INITIAL = {
  __schema: 2,
  profile: { nickname: "", consent: false },
  planner: { today: [], backlog: [], pool: [] },
  inbox: [],
  journal: [],
  checkins: [],
  nudges: { lastStressISO: null },
  timers: { activeId: null, startedAt: null }, // laufender Aufgaben-Timer
  settings: {
    dayMinutes: 480,   // Arbeitstag in Minuten (8h) – per Slider 60..720
    breakMinutes: 10,  // Pausenlänge
    maxNoBreak: 90,     // harte Obergrenze ohne Pause (1,5h)
    longBreakMinutes: 45,
    dayStart: "09:00"   // Startuhrzeit für den Zeitstrahl
  },
  ui: {
    route: "home" // wird persistiert
  }
};

/* ---------- Prio Mapping (optional) ---------- */
const PRIO_WEIGHT = { DW: 4, NDW: 3, DNW: 2, NDNW: 1, null: 0, undefined: 0 };
const PRIO_LABEL = {
  DW: "Dringend & Wichtig (DW)",
  NDW: "Nicht dringend & Wichtig (NDW)",
  DNW: "Dringend & nicht wichtig (DNW)",
  NDNW: "Nicht dringend & nicht wichtig (NDNW)",
  null: "ohne Prio"
};
const prioLabel = (p) => PRIO_LABEL[p ?? null] || "ohne Prio";

/* ---------- Date Utils ---------- */
const parseDateOnly = (isoDate) => new Date(`${isoDate}T00:00:00`);
const fmtDate = (isoDate) => (isoDate ? parseDateOnly(isoDate).toLocaleDateString() : "");

/* ---------- Time Utils (Zeitstrahl & Timer) ---------- */
const hhmmToMin = (s) => {
  const [h, m] = String(s || "09:00").split(":").map(n => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
};
const minToHHMM = (min) => {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60), m = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
// Aus der (nach order sortierten) Today-Liste Start/Ende je Eintrag berechnen
function computeSchedule(list = [], dayStart = "09:00") {
  let cursor = hhmmToMin(dayStart);
  const sorted = [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return sorted.map(it => {
    const dur = Math.max(0, Number(it.durationMin) || 0);
    const startMin = cursor;
    cursor += dur;
    return { ...it, startMin, endMin: cursor };
  });
}
// Sekunden → mm:ss
const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const r = (s % 60).toString().padStart(2, "0");
  return `${m}:${r}`;
};
// live verbrauchte Sekunden einer Aufgabe (inkl. laufendem Timer)
function liveSpentSec(item, timers) {
  const base = Number(item?.spentSec) || 0;
  if (timers && timers.activeId === item?.id && timers.startedAt) {
    return base + Math.max(0, (Date.now() - timers.startedAt) / 1000);
  }
  return base;
}

/* ---------- UI-Label für Navigation ---------- */
function label(route) {
  switch (route) {
    case "home": return "Übersicht";
    case "planner": return "Tagesplan";
    case "inbox": return "Inbox";
    case "stress": return "Atemübung";
    case "journal": return "Journal";
    case "checkin": return "Check-in";
    default: return String(route || "").trim() || "Unbenannt";
  }
}

/* ---------- Helper für Reihenfolge ---------- */
function _dndNormalizeOrdersForList(_list, arr = []) {
  const items = [...(arr || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return items.map((it, i) => ({ ...it, order: i }));
}

/* ---------- Reflow Today mit präziser Pausenlogik ----------
   Regeln:
   - Kurzpause 10 Min, wenn sonst > 90 Min Arbeit am Stück überschritten würden (vorausschauend).
   - Lange Pause 45 Min, sobald seit letzter langer Pause 210 Min Gesamtzeit (Arbeit + Kurzpausen) erreicht/überschritten sind (nicht vorausschauend).
   - Große Blöcke werden NICHT gesplittet; ggf. Pause VOR dem Block.
------------------------------------------------------------- */
function _reflowToday(list = [], cfg = { maxNoBreak: 90, breakMinutes: 10, longBreakMinutes: 45 }) {
  const MAX_STREAK = Math.max(30, +cfg.maxNoBreak || 90);                // 90
  const SHORT_BREAK = Math.max(5, +cfg.breakMinutes || 10);              // 10
  const LONG_BREAK = Math.max(SHORT_BREAK, +cfg.longBreakMinutes || 45); // 45
  const LONG_AFTER_TOTAL = 210; // 3,5 h inkl. Kurzpausen

  // nur Aufgaben (Pausen raus); stabil nach order
  const tasks = [...(list || [])]
    .filter(it => !it.isBreak)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const out = [];
  let workSinceShort = 0;  // reine Arbeitszeit seit letzter Kurz- ODER Langpause
  let totalSinceLong = 0;  // Gesamtzeit (Arbeit + Kurzpausen) seit letzter Langpause

  const pushBreak = (mins, label) => {
    out.push({
      id: uid(),
      title: label,
      isBreak: true,
      done: false,
      prio: null,
      durationMin: mins,
      order: out.length
    });
    if (mins >= LONG_BREAK) {
      // lange Pause setzt alles zurück
      workSinceShort = 0;
      totalSinceLong = 0;
    } else {
      // kurze Pause setzt Arbeitsstreak zurück, zählt aber zur Gesamtzeit
      workSinceShort = 0;
      totalSinceLong += mins;
    }
  };

  for (const t of tasks) {
    const dur = Math.max(5, +t.durationMin || 30);

    // 1) Lange Pause NACH 210 Min (nicht vorausschauend)
    while (totalSinceLong >= LONG_AFTER_TOTAL) {
      pushBreak(LONG_BREAK, "Lange Pause");
    }

    // 2) Kurzpause vorausschauend vor Überschreitung der 90-Min-Streak
    if (workSinceShort > 0 && (workSinceShort + dur) > MAX_STREAK) {
      // Wenn die Kurzpause selbst die 210-Min-Grenze sprengen würde → direkt lange Pause
      if ((totalSinceLong + SHORT_BREAK) >= LONG_AFTER_TOTAL) {
        pushBreak(LONG_BREAK, "Lange Pause");
      } else {
        pushBreak(SHORT_BREAK, "Pause");
      }
    }

    // 3) Aufgabe platzieren
    out.push({ ...t, isBreak: false, order: out.length });
    workSinceShort += dur;
    totalSinceLong += dur;
  }

  // Falls am Ende >210 erreicht wurde, lassen wir es so (keine Pause hinten anhängen).
  return out;
}

// === Sortier-Helfer für "Heute": Deadline → Prio → Dauer + Pausen neu einstreuen ===

// eigener Comparator (top-level), nutzt parseDateOnly und PRIO_WEIGHT
function _sortByDuePrioDurPublic(a, b) {
  const da = a.dueISO ? parseDateOnly(a.dueISO) : null;
  const db = b.dueISO ? parseDateOnly(b.dueISO) : null;

  // Deadlines: zuerst überfällige/nah dran
  if (da && db && da.getTime() !== db.getTime()) return da - db;
  if (da && !db) return -1;
  if (!da && db) return 1;

  // Prio (DW > NDW > DNW > NDNW)
  const pa = PRIO_WEIGHT[a.prio] || 0;
  const pb = PRIO_WEIGHT[b.prio] || 0;
  if (pb !== pa) return pb - pa;

  // Kürzere Dauer zuerst
  const durA = a.durationMin || 30;
  const durB = b.durationMin || 30;
  return durA - durB;
}

// sortiert NUR Aufgaben (ohne Pausen) nach obiger Regel
// vergibt order neu und lässt _reflowToday die Pausen korrekt einfügen
function _sortTodayByRules(list = [], settings) {
  const tasksOnly = (list || [])
    .filter(x => !x.isBreak)
    .sort(_sortByDuePrioDurPublic)
    .map((t, i) => ({ ...t, order: i })); // Tasks 0..n nummerieren

  return _reflowToday(tasksOnly, settings);
}

/* ---------- Time Budget Helpers ---------- */
function _sumDur(items) {
  return (items || []).reduce((acc, it) => acc + (Number(it.durationMin) || 0), 0);
}
function computeBudgetToday(state) {
  const today = (state?.planner?.today || []);
  const workMin = today.filter(x => !x.isBreak).reduce((a, b) => a + (b.durationMin || 0), 0);
  const breakMin = today.filter(x =>  x.isBreak).reduce((a, b) => a + (b.durationMin || 0), 0);
  const total = workMin + breakMin;
  const target = Number(state?.settings?.dayMinutes) || 480;
  const pct = target > 0 ? Math.min(100, Math.round((total / target) * 100)) : 0;
  return { workMin, breakMin, total, target, pct };
}

/* =========================================================
   Store / Actions
   ========================================================= */
function useStore() {
  const [state, setState] = useState(() => migrate(load()) || INITIAL);

  // debounced save (schont I/O)
  useEffect(() => { const id = setTimeout(() => save(state), 150); return () => clearTimeout(id); }, [state]);

  // Profile
  const setConsent = v => setState(s => ({ ...s, profile: { ...s.profile, consent: v } }));
  const setNickname = v => setState(s => ({ ...s, profile: { ...s.profile, nickname: v } }));

  // Route-Persistenz
  const setRoute = (r) => setState(s => ({ ...s, ui: { ...s.ui, route: r } }));

  // Helper: normalisiere Prio
  function normalizePrio(p) {
    if (!p) return null;
    const up = String(p).toUpperCase();
    return ["DW", "NDW", "DNW", "NDNW"].includes(up) ? up : null;
  }

  // Helper: Sortierer (Deadline → Prio → Dauer)
 // ---- Einheitliche Sortierung: Due → Prio → Dauer (überfällige ganz oben) ----
const _dueKey = (iso) => {
  if (!iso) return Number.POSITIVE_INFINITY;
  const d = parseDateOnly(iso).getTime();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // Boost: Überfällige weit nach vorne ziehen
  return d < today.getTime() ? d - 1e12 : d;
};

const sortByDuePrioDur = (a, b) => {
  const da = a?.dueISO ? parseDateOnly(a.dueISO) : null;
  const db = b?.dueISO ? parseDateOnly(b.dueISO) : null;

  const daT = da && !isNaN(da) ? da.getTime() : null;
  const dbT = db && !isNaN(db) ? db.getTime() : null;

  if (daT !== null && dbT !== null && daT !== dbT) return daT - dbT;
  if (daT !== null && dbT === null) return -1;
  if (daT === null && dbT !== null) return 1;

  const pa = (PRIO_WEIGHT[a?.prio] || 0);
  const pb = (PRIO_WEIGHT[b?.prio] || 0);
  if (pb !== pa) return pb - pa;

  const durA = Number.isFinite(+a?.durationMin) ? +a.durationMin : 30;
  const durB = Number.isFinite(+b?.durationMin) ? +b.durationMin : 30;
  return durA - durB;
};

  // Helper: nächster Order innerhalb Liste
  const nextOrder = (s, list) => {
    const arr = (s.planner[list] || []);
    if (!arr.length) return 0;
    return Math.max(...arr.map(it => typeof it.order === "number" ? it.order : 0)) + 1;
  };

  const uniqById = (arr) => { const seen = new Set(); return arr.filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true))); };

  /* ---------- Planner CRUD ---------- */
 const plannerAdd = (list, title, prio = "NDNW", durationMin = null, dueISO = null) => {
  const t = (title || "").trim(); if (!t) return;
  const pp = normalizePrio(prio);

  // sicher & robust: Dauer sauber in Zahl konvertieren
  const durNum = Number.isFinite(+durationMin) && +durationMin > 0 ? Math.round(+durationMin) : null;

  setState(s => {
    const order = nextOrder(s, list);
    const item = {
      id: uid(),
      title: t,
      done: false,
      prio: pp || null,
      order,
      durationMin: durNum,
      dueISO: (dueISO && String(dueISO).trim()) ? dueISO : null
    };
    return { ...s, planner: { ...s.planner, [list]: [item, ...(s.planner[list] || [])] } };
  });
};

  const plannerToggle = (list, id) => setState(s => ({ ...s, planner: { ...s.planner, [list]: (s.planner[list] || []).map(it => it.id === id ? { ...it, done: !it.done } : it) } }));
  const plannerDelete = (list, id) => setState(s => ({ ...s, planner: { ...s.planner, [list]: (s.planner[list] || []).filter(it => it.id !== id) } }));

  // Verschieben innerhalb einer Liste (↑/↓ über order) – jetzt inkl. Pausen
  const plannerMove = (list, id, dir /* -1 | +1 */) => setState(s => {
    const arr = [...(s.planner[list] || [])];
    const idx = arr.findIndex(x => x.id === id); if (idx < 0) return s;

    // gesamte Liste nach order sortieren (inkl. Pausen)
    const sorted = [...arr].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const curPos = sorted.findIndex(x => x.id === id);
    const tgtPos = curPos + (dir < 0 ? -1 : 1);
    if (tgtPos < 0 || tgtPos >= sorted.length) return s;

    // swap der order-Werte
    const a = sorted[curPos], b = sorted[tgtPos];
    const aOrder = a.order ?? curPos, bOrder = b.order ?? tgtPos;
    const arr2 = arr.map(it =>
      it.id === a.id ? { ...it, order: bOrder } :
      it.id === b.id ? { ...it, order: aOrder } : it
    );

    const updated = { ...s.planner, [list]: arr2 };

    // KEIN automatischer Reflow bei Pfeil-Move
    return { ...s, planner: updated };
  });

  // Zwischen den Listen verschieben (Backlog ↔ Today ↔ Pool)
const moveItem = (from, to, id) => setState(s => {
  if (from === to) return s;

  const planner = { ...s.planner };
  const src = [...(planner[from] || [])];
  const idx = src.findIndex(x => x.id === id);
  if (idx < 0) return s;

  let item = { ...src[idx] };
  src.splice(idx, 1);
  planner[from] = src;

  // Pausen-Flag nur in "today" relevant
  if (to !== "today") {
    const { isBreak, ...rest } = item;
    item = rest;
  }

  const dst = [...(planner[to] || [])];
  item.order = dst.length ? Math.max(...dst.map(x => x.order ?? 0)) + 1 : 0;
  dst.push(item);
  planner[to] = dst;

  // NEU: whenever "today" betroffen → immer nach Regeln sortieren + Pausen setzen
  if (from === "today") planner[from] = _sortTodayByRules(planner[from], s.settings);
  if (to   === "today") planner[to]   = _sortTodayByRules(planner[to],   s.settings);

  return { ...s, planner };
});

  /* ---------- Inbox ---------- */
  const inboxAdd = text => { const v = (text || "").trim(); if (!v) return; setState(s => ({ ...s, inbox: [{ id: uid(), text: v, dateISO: new Date().toISOString() }, ...s.inbox] })); };
  const inboxRemove = id => setState(s => ({ ...s, inbox: s.inbox.filter(x => x.id !== id) }));
  const inboxToBacklog = id => setState(s => {
    const it = s.inbox.find(x => x.id === id); if (!it) return s;
    const order = nextOrder(s, "backlog");
    return { ...s, inbox: s.inbox.filter(x => x.id !== id), planner: { ...s.planner, backlog: [{ id: uid(), title: it.text, done: false, order, prio: null }, ...s.planner.backlog] } };
  });

  /* ---------- Automatik-Planer mit Pausen & Pool ---------- */
const autoPlanToday = (overrideMinutes) => {
  setState(s => {
    const cfg = s.settings || { dayMinutes: 480, breakMinutes: 10, longBreakMinutes: 45, maxNoBreak: 90 };
    const maxMinutes = Math.max(30, overrideMinutes ?? cfg.dayMinutes);

    const todayList   = (s.planner.today   || []).filter(it => !it.done && !it.isBreak);
    const backlogList = (s.planner.backlog || []).filter(it => !it.done);
    const poolList    = (s.planner.pool    || []).filter(it => !it.done);

    // Kandidaten dedupliziert & nach Deadlines/Prio/Dauer sortieren
    const candidates = uniqById([...todayList, ...backlogList, ...poolList])
      .sort(_sortByDuePrioDurPublic);

    // 1) Aufgaben (ohne Pausen) in das verfügbare Work-Budget packen
    const plannedTasks = [];
    let plannedWork = 0;
    for (const t of candidates) {
      const dur = t.durationMin || 30;
      if (plannedWork + dur > maxMinutes) continue;
      plannedTasks.push({ ...t });
      plannedWork += dur;
    }

    // 2) Pausen nach Regeln einstreuen
    const withBreaks = _reflowToday(plannedTasks, cfg);

    // 3) Auf maxMinutes (inkl. Pausen) trimmen
    const keep = [];
    let total = 0;
    for (const it of withBreaks) {
      const dur = it.durationMin || 0;
      if (total + dur > maxMinutes) break;
      keep.push(it);
      total += dur;
    }

    // 4) Today final nach Regeln sortieren + Pausen korrekt (sicherheits-halber)
    const todaySorted = _sortTodayByRules(keep.filter(x => !x.isBreak), cfg);

    // Overflow: alle Kandidaten-Aufgaben, die NICHT in todaySorted gelandet sind
    const keptTaskIds = new Set(todaySorted.filter(x => !x.isBreak).map(x => x.id));
    const overflow = candidates.filter(t => !keptTaskIds.has(t.id));

    const newPool    = [...overflow].sort(_sortByDuePrioDurPublic);
    const newBacklog = (s.planner.backlog || []).filter(x => !keptTaskIds.has(x.id));

    return {
      ...s,
      planner: {
        ...s.planner,
        today: todaySorted,
        backlog: newBacklog,
        pool: newPool
      }
    };
  });
};

  /* ---------- Journal/Checkins/Nudges ---------- */
  const addJournal = (mood, focus, note) => {
    const entry = { id: uid(), dateISO: new Date().toISOString(), mood, focus, note: (note || "").trim() };
    setState(s => ({ ...s, journal: [entry, ...s.journal] }));
  };

  const scoreFromAnswers = (a) => {
    if (a?.type === "adhd") {
      const vals = ["focus", "thoughts", "tension", "stimuli", "impulse", "social", "energy", "mood"].map(k => +a[k] || 0);
      const sum = vals.reduce((x, y) => x + y, 0);
      return Math.round((sum / (8 * 5)) * 100);
    }
    if (typeof a.score === "number") return a.score;
    const sum = (a.sleep + a.energy + a.focus + (6 - a.stress) + (6 - a.stimuli));
    return Math.round((sum / 5) * 20);
  };

  const addCheckin = (answers) => {
    const entry = { id: uid(), dateISO: new Date().toISOString(), answers, score: scoreFromAnswers(answers) };
    setState(s => ({ ...s, checkins: [entry, ...s.checkins] }));
  };

  const touchStressNudge = () => setState(s => ({ ...s, nudges: { ...s.nudges, lastStressISO: new Date().toISOString() } }));

  /* ---------- Aufgaben-Timer (Start/Ende je Aufgabe) ---------- */
  const setDayStart = (v) => setState(s => ({ ...s, settings: { ...s.settings, dayStart: v || "09:00" } }));

  const taskStart = (id) => setState(s => {
    const t = s.timers || { activeId: null, startedAt: null };
    let today = [...(s.planner.today || [])];
    // laufenden Timer erst sauber verbuchen
    if (t.activeId && t.startedAt) {
      const el = Math.max(0, Math.round((Date.now() - t.startedAt) / 1000));
      today = today.map(x => x.id === t.activeId ? { ...x, spentSec: (Number(x.spentSec) || 0) + el } : x);
    }
    return { ...s, planner: { ...s.planner, today }, timers: { activeId: id, startedAt: Date.now() } };
  });

  const taskStop = () => setState(s => {
    const t = s.timers || {};
    if (!t.activeId || !t.startedAt) return { ...s, timers: { activeId: null, startedAt: null } };
    const el = Math.max(0, Math.round((Date.now() - t.startedAt) / 1000));
    const today = (s.planner.today || []).map(x => x.id === t.activeId ? { ...x, spentSec: (Number(x.spentSec) || 0) + el } : x);
    return { ...s, planner: { ...s.planner, today }, timers: { activeId: null, startedAt: null } };
  });

  const taskResetTimer = (id) => setState(s => {
    const t = s.timers || {};
    const today = (s.planner.today || []).map(x => x.id === id ? { ...x, spentSec: 0 } : x);
    const timers = t.activeId === id ? { activeId: null, startedAt: null } : t;
    return { ...s, planner: { ...s.planner, today }, timers };
  });

  /* ---------- Maintenance ---------- */
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `focusflow_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1200);
  };
  const resetAll = () => {
    if (confirm("Wirklich alles löschen?")) {
      localStorage.removeItem(LS_KEY);
      setState(INITIAL);
    }
  }; // <-- diese Klammer + Semikolon MUSS da sein

  return { state, setState, setRoute, setConsent, setNickname,
    // Planner
    plannerAdd, plannerToggle, plannerDelete, plannerMove, moveItem, autoPlanToday,
    // Inbox
    inboxAdd, inboxRemove, inboxToBacklog,
    // Journal/Checkins
    addJournal, addCheckin,
    // Aufgaben-Timer
    setDayStart, taskStart, taskStop, taskResetTimer,
    // Maintenance & Nudges
    exportJson, resetAll, touchStressNudge
  };
}

/* ---------- Ticker: rendert jede Sekunde neu, wenn aktiv ---------- */
function useNow(active) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setN(n => (n + 1) % 1e9), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/* ---------- Migration ---------- */
function migrate(s) {
  if (!s) return s;
  const out = clone(s);
  const v = out.__schema || 0;

  // v0→v1
  if (v < 1) {
    out.planner = out.planner || { today: [], backlog: [], pool: [] };
    delete out.eisenhower;
    out.__schema = 1;
  }
  // v1→v2
  if (v < 2) {
    out.settings = out.settings || INITIAL.settings;
    out.ui = out.ui || { route: "home" };
    out.__schema = 2;
  }

  // Normalisierung vorhandener Einträge
  for (const list of ["today", "backlog", "pool"]) {
    if (!Array.isArray(out.planner[list])) out.planner[list] = [];
    out.planner[list] = out.planner[list].map(it => ({
      id: it.id || uid(),
      title: String(it.title || "").trim(),
      done: !!it.done,
      prio: ["DW", "NDW", "DNW", "NDNW"].includes(it.prio) ? it.prio : null,
      order: typeof it.order === "number" ? it.order : 0,
      durationMin: typeof it.durationMin === "number" ? it.durationMin : (it.isBreak ? (it.durationMin || 10) : null),
      dueISO: typeof it.dueISO === "string" ? it.dueISO : null,
      isBreak: !!it.isBreak,
      spentSec: Number(it.spentSec) || 0
    }));
  }

  out.profile ||= { nickname: "", consent: false };
  out.inbox ||= [];
  out.journal ||= [];
  out.checkins ||= [];
  out.nudges ||= { lastStressISO: null };
  out.timers ||= { activeId: null, startedAt: null };
  out.settings ||= clone(INITIAL.settings);
  if (!out.settings.dayStart) out.settings.dayStart = "09:00";

  return out;
}

/* =========================================================
   App
   ========================================================= */
export default function App() {
  const api = useStore();
  const { state } = api;
  const [menuOpen, setMenuOpen] = useState(false);

  // Default-Route (Onboarding)
  useEffect(() => {
    if (!state.profile.consent) api.setRoute("home");
  }, [state.profile.consent]);

  // Check-in-Anstupser
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayCheckin = state.checkins.find(c => c.dateISO.slice(0, 10) === todayStr);
  const [checkinPrompted, setCheckinPrompted] = useState(false);
  useEffect(() => {
    if (state.profile.consent && !todayCheckin && !checkinPrompted) {
      api.setRoute("checkin");
      setCheckinPrompted(true);
    }
  }, [state.profile.consent, todayCheckin, checkinPrompted]);

  // 2h-Stress-Nudge
  const [showStressNudge, setShowStressNudge] = useState(false);
  useEffect(() => {
    const check = () => {
      const lastISO = state.nudges?.lastStressISO;
      const last = lastISO ? new Date(lastISO).getTime() : 0;
      const due = Date.now() - last >= 2 * 60 * 60 * 1000;
      setShowStressNudge(due);
    };
    check();
    const id = setInterval(check, 60 * 1000);
    return () => clearInterval(id);
  }, [state.nudges?.lastStressISO]);

  const todayDone = state.planner.today.filter(i => i.done && !i.isBreak).length;
  const todayTotal = state.planner.today.filter(i => !i.isBreak).length;

  // Onboarding
  if (!state.profile.consent) {
    return (
      <div className="safe">
        <div className="appbar">
          <div className="appbar-inner">
            <button className="burger" aria-label="Menü" onClick={() => { }}>☰</button>
            <div className="brand">FocusFlow</div>
          </div>
        </div>
        <div className="wrap">
          <div className="card card-hero">
            <h1 className="h1">Willkommen</h1>
            <p className="muted">Kurze Übungen für Struktur & Fokus. Alle Daten bleiben lokal.</p>
            <label className="label">Nickname (optional)</label>
            <input className="input" value={state.profile.nickname} onChange={e => api.setNickname(e.target.value)} placeholder="Nickname" />
            <label className="consent">
              <input type="checkbox" checked={state.profile.consent} onChange={e => api.setConsent(e.target.checked)} />
              <span>Selbsthilfe, keine Therapie. In Notfällen 112.</span>
            </label>
            <button className="btn btn-primary" disabled={!state.profile.consent} onClick={() => api.setRoute("home")}>Loslegen</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="safe">
      {/* Header */}
      <div className="appbar">
        <div className="appbar-inner">
          <button className="burger" aria-label="Menü" onClick={() => setMenuOpen(true)}>☰</button>
          <div className="brand">FocusFlow</div>
          <div className="head-actions">
            <button className="btn" onClick={api.exportJson}>Export</button>
            <button className="btn" onClick={() => { if (confirm("Alles zurücksetzen?")) api.resetAll(); }}>Reset</button>
          </div>
        </div>
      </div>

      {/* Drawer-Menü */}
      <div className={`drawer ${menuOpen ? "open" : ""}`} role="dialog" aria-modal="true" aria-labelledby="navTitle">
        <div className="backdrop" onClick={() => setMenuOpen(false)} />
        <aside className="panel">
          <div className="menu-title" id="navTitle">Navigation</div>
          <ul className="menu-list">
            {["home", "planner", "inbox", "stress", "journal", "checkin"].map(r => (
              <li key={r}>
                <button className={`menu-btn ${state.ui.route === r ? "active" : ""}`} onClick={() => { api.setRoute(r); setMenuOpen(false); }}>{label(r)}</button>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {/* Inhalt */}
      <div className="wrap grid">
        {state.ui.route === "home" && <Dashboard state={state} api={api} go={api.setRoute} todayDone={todayDone} todayTotal={todayTotal} showStressNudge={showStressNudge} />}
        {state.ui.route === "planner" && <PlannerView state={state} api={api} />}
        {state.ui.route === "inbox" && <InboxView state={state} api={api} />}
        {state.ui.route === "stress" && <StressView onAcknowledge={api.touchStressNudge} />}
        {state.ui.route === "journal" && <JournalView state={state} api={api} />}
        {state.ui.route === "checkin" && <CheckinView api={api} last={state.checkins[0]} />}
      </div>

      <footer className="footer">© {new Date().getFullYear()} FocusFlow — Lokale Daten</footer>
    </div>
  );
}

/* =========================================================
   Dashboard
   ========================================================= */
function Dashboard({ state, api, go, todayDone, todayTotal, showStressNudge }) {
  // im Dashboard()
const sortedToday = useMemo(() => {
  // nur strikt nach order, egal ob Pause oder Aufgabe
  return [...state.planner.today].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}, [state.planner.today]);

  const last7 = useMemo(() => {
    const now = Date.now();
    return state.journal.filter(j => now - new Date(j.dateISO).getTime() <= 7 * 24 * 3600 * 1000);
  }, [state.journal]);
  const moodAvg7 = last7.length ? (last7.reduce((a, b) => a + b.mood, 0) / last7.length).toFixed(1) : "–";
  const focusAvg7 = last7.length ? (last7.reduce((a, b) => a + b.focus, 0) / last7.length).toFixed(1) : "–";

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayCheckin = state.checkins.find(c => c.dateISO.slice(0, 10) === todayStr);

  const progressPct = useMemo(() => {
    const total = state.planner.today.filter(i => !i.isBreak).length || 0;
    const done = state.planner.today.filter(i => !i.isBreak && i.done).length;
    return total ? Math.round((done / total) * 100) : 0;
  }, [state.planner.today]);

  const PlannerRow = _PlannerRowMini;

  return (
    <>
      <div className="card card-hero">
        <h2 className="h1">Hi {state.profile.nickname || "Du"} 👋</h2>
        <p className="muted">Selbsthilfe • Struktur • Fokus</p>
        {showStressNudge && (
          <div className="nudge">
            <div className="nudge-title">2-Stunden-Reminder</div>
            <div className="nudge-actions">
              <button className="btn btn-primary" onClick={() => go("stress")}>3-Min Atemübung</button>
              <button className="btn" onClick={() => go("journal")}>Kurz notieren</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <strong>Heute (geplant)</strong>
        <p className="muted">Automatische Pause nach 1,5 h Arbeit. Pausenlänge: {state.settings.breakMinutes} Min.</p>
        <ul className="list">
          {sortedToday.map(it => (
            <PlannerRow
              key={it.id}
              api={api}
              list="today"
              item={it}
              onToggle={(id) => api.plannerToggle("today", id)}
              onDelete={(id) => api.plannerDelete("today", id)}
              onMove={(id, dir) => api.plannerMove("today", id, dir)}
              onMoveBetween={(id, to) => api.moveItem("today", to, id)}
            />
          ))}
          {!sortedToday.length && <div className="muted">Noch nichts geplant.</div>}
        </ul>

        <div className="progress"><div className="progress-bar" style={{ width: `${progressPct}%` }} /></div>
        <div className="row mt8">
          <button className="btn btn-primary" onClick={() => go("planner")}>Plan bearbeiten</button>
          <button className="btn" onClick={() => go("stress")}>3-Min Atemübung</button>
        </div>
      </div>

      <div className="card">
        <strong>Zeitstrahl heute</strong>
        <p className="muted">Start {state.settings.dayStart || "09:00"} · geplante Uhrzeiten je Aufgabe</p>
        <DayTimeline today={state.planner.today} dayStart={state.settings.dayStart} timers={state.timers} />
      </div>

      <div className="grid two">
        <div className="card">
          <strong>Self-Check-in</strong>
          <p className="muted">{todayCheckin ? `Heute erledigt · Score ${todayCheckin.score}/100` : "Noch kein Check-in heute."}</p>
          <button className="btn btn-primary" onClick={() => go("checkin")}>
            {todayCheckin ? "Ansehen / erneut" : "Jetzt ausfüllen (1 Min)"}
          </button>
        </div>

        <div className="card">
          <strong>Journal</strong>
          <p className="muted">Ø 7 Tage — Stimmung {moodAvg7} · Fokus {focusAvg7}</p>
          <button className="btn" onClick={() => go("journal")}>Öffnen</button>
        </div>
      </div>

      <div className="card">
        <strong>Ablenkungen</strong>
        <p className="muted">{state.inbox.length} offen · bitte klassifizieren</p>
        <button className="btn" onClick={() => go("inbox")}>Öffnen</button>
      </div>
    </>
  );
}

/* --- Minimaler Row-Renderer nur fürs Dashboard --- */
/* --- Minimaler Row-Renderer nur fürs Dashboard (übersichtlich) --- */
function _PlannerRowMini({ item, onToggle, api }) {
  // Pause kompakt darstellen (positiv gerahmt)
  if (item.isBreak) {
    return (
      <li className="item overview-task is-break">
        <div className="row top">
          <span className="task-title">🌿 {item.title || "Pause"}</span>
        </div>
        <div className="row meta">
          <span className="badge small break-badge">⏱ {item.durationMin || 10} Min · Erholung</span>
        </div>
      </li>
    );
  }

  // Überfällig?
  const overdue =
    item.dueISO && new Date(item.dueISO) < new Date(new Date().toDateString());

  // Prio-Farbklasse nur für Text (nicht für Hintergründe)
  const prioClass =
    item.prio === "DW"   ? "c-dw"   :
    item.prio === "DNW"  ? "c-dnw"  :
    item.prio === "NDW"  ? "c-ndw"  :
    item.prio === "NDNW" ? "c-ndnw" : "";

  return (
    <li className={`item overview-task ${prioClass}`}>
      {/* Zeile 1: Checkbox + Name */}
      <div className="row top">
        <input
          type="checkbox"
          className="checkbox"
          checked={!!item.done}
          onChange={() => onToggle(item.id)}
          aria-label="Task erledigt"
        />
        <span className={`task-title ${item.done ? "done" : ""}`}>
          {item.title || "Ohne Titel"}
        </span>
      </div>

      {/* Zeile 2: Dauer · PRIO · Deadline (rechts) */}
      <div className="row meta">
        {item.durationMin ? (
          <span className="badge small">⏱ {item.durationMin} Min</span>
        ) : null}

        {item.prio ? (
          <span className="badge small prio-text">{item.prio}</span>
        ) : null}

        <span className={`deadline ${overdue ? "overdue" : ""}`}>
          {item.dueISO ? `📅 ${fmtDate(item.dueISO)}` : ""}
        </span>
      </div>

      {api && !item.done && (
        <TaskTimer item={item} timers={api.state.timers} api={api} compact />
      )}
    </li>
  );
}


/* =========================================================
   PlannerView
   ========================================================= */
function PlannerView({ state, api }) {
  // Slider für Arbeitstag (60..720 Min)
  const [sliderVal, setSliderVal] = useState(state.settings.dayMinutes);
  useEffect(() => { setSliderVal(state.settings.dayMinutes); }, [state.settings.dayMinutes]);

  const budget = computeBudgetToday(state);

  return (
    <>
      <div className="card">
        <strong>Arbeitszeit heute</strong>
        <div className="row wrap mt8">
          <input
            className="range"
            type="range"
            min={60}
            max={720}
            step={15}
            value={sliderVal}
            onChange={e => setSliderVal(+e.target.value)}
            aria-label="Tägliche Arbeitszeit (Minuten)"
          />
          <span className="badge metric">{sliderVal} Min</span>
          <button
            className="btn"
            type="button"
            onClick={() => api.setState(s => ({ ...s, settings: { ...s.settings, dayMinutes: sliderVal } }))}
          >
            Übernehmen
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => api.autoPlanToday(sliderVal)}
          >
            🔄 Tagesplan automatisch erstellen
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => api.setState(s => ({
              ...s,
              planner: {
                ...s.planner,
                today: _reflowToday(s.planner.today || [], s.settings)
              }
            }))}
          >
            Pausen neu verteilen
          </button>
        </div>
        <div className="row wrap mt8" style={{ alignItems: "center" }}>
          <label className="muted" htmlFor="dayStart">Tagesstart (Zeitstrahl):</label>
          <input
            id="dayStart"
            className="input"
            type="time"
            value={state.settings.dayStart || "09:00"}
            onChange={e => api.setDayStart(e.target.value)}
            style={{ maxWidth: 130 }}
          />
        </div>
        <p className="muted mt6">
          Nach jeweils 1,5 h Arbeit wird automatisch eine Pause ({state.settings.breakMinutes} Min) eingefügt.
        </p>
      </div>

      {/* Zeitstrahl */}
      <div className="card">
        <strong>Zeitstrahl heute</strong>
        <p className="muted">Ab {state.settings.dayStart || "09:00"} · Start/Ende jeder Aufgabe direkt in der Liste unten.</p>
        <DayTimeline today={state.planner.today} dayStart={state.settings.dayStart} timers={state.timers} />
      </div>

      {/* Zeitbudget */}
      <div className="card">
        <strong>Zeitbudget heute</strong>
        <p className="muted">
          Arbeit <strong>{budget.workMin} Min</strong> · Pausen <strong>{budget.breakMin} Min</strong> ·
          Summe <strong>{budget.total} Min</strong> / Ziel <strong>{budget.target} Min</strong>
        </p>
        <div className="progress">
          <div className="progress-bar" style={{ width: `${budget.pct}%` }} />
        </div>
      </div>

      <h2 className="h1">Tagesplan</h2>
      <p className="muted">Links: Heute (mit Pausen & Drag&Drop). Rechts oben: Backlog. Rechts unten: Pool.</p>

      <div className="grid two">
        {/* Heute */}
        <_PlannerColumn
          api={api}
          listKey="today"
          title="Heute"
          items={state.planner.today}
          onAdd={(t, p, dur, due) => api.plannerAdd("today", t, p, dur, due)}
          onToggle={(id) => api.plannerToggle("today", id)}
          onDelete={(id) => api.plannerDelete("today", id)}
          onMove={(id, dir) => api.plannerMove("today", id, dir)}
          allowAdd={false}
          dnd
        />

        {/* Rechts: Backlog + Pool */}
        <div>
          <_PlannerColumn
            api={api}
            listKey="backlog"
            title="Backlog"
            items={state.planner.backlog}
            onAdd={(t, p, dur, due) => api.plannerAdd("backlog", t, p, dur, due)}
            onToggle={(id) => api.plannerToggle("backlog", id)}
            onDelete={(id) => api.plannerDelete("backlog", id)}
            onMove={(id, dir) => api.plannerMove("backlog", id, dir)}
            allowAdd
            dnd
          />

          {/* Pool */}
          <div className="card mt12" onDragOver={(e) => e.preventDefault()} onDrop={(e) => _dndListDrop(e, api, "pool")}>
            <strong>Pool (für später)</strong>
            <p className="muted">Heute nicht mehr unterzubringen — sortiert nach Deadline, Prio, Dauer.</p>
            <ul className="list mt8">
              {state.planner.pool.map(it => (
                <li
                  key={it.id}
                  className="item"
                  draggable
                  onDragStart={(e) => _dndDragStart(e, { id: it.id, from: "pool" })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => _dndItemDrop(e, api, { to: "pool", beforeId: it.id })}
                >
                  <div className="title">{it.title}</div>
                  <div className="muted">
                    {_dndPrioLabel(it.prio)}
                    {it.durationMin ? ` · ⏱️ ${it.durationMin} Min` : ""}
                    {it.dueISO ? ` · 📅 bis ${_dndFmtDate(it.dueISO)}` : ""}
                  </div>
                  <div className="row wrap gap actions">
                    <button className="btn btn-primary" type="button" onClick={() => _dndReorderOrMove(api, { from: "pool", to: "today", draggedId: it.id })}>→ Heute</button>
                    <button className="btn" type="button" onClick={() => _dndReorderOrMove(api, { from: "pool", to: "backlog", draggedId: it.id })}>→ Backlog</button>
                    <button className="btn" type="button" onClick={() => api.plannerDelete("pool", it.id)}>Löschen</button>
                  </div>
                </li>
              ))}
              {!state.planner.pool.length && <div className="muted">Aktuell leer.</div>}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}

/* =========================================================
   Planner (Drag & Drop – eigenständig, safe to drop-in)
   ========================================================= */

// --- lokale Helper (konfliktfreie Namen) ---
const _dndWEIGHT = { DW: 4, NDW: 3, DNW: 2, NDNW: 1, null: 0, undefined: 0 };
const _dndParseDateOnly = (iso) => new Date(`${iso}T00:00:00`);
const _dndFmtDate = (iso) => (iso ? _dndParseDateOnly(iso).toLocaleDateString() : "");
const _dndPrioLabel = (p) =>
  ({
    DW: "Dringend & Wichtig (DW)", NDW: "Nicht dringend & Wichtig (NDW)",
    DNW: "Dringend & nicht wichtig (DNW)", NDNW: "Nicht dringend & nicht wichtig (NDNW)", null: "ohne Prio"
  })[p ?? null] || "ohne Prio";

// sortiert nach Deadline → Prio → Dauer
// Backlog & Pool nutzen exakt dieselbe Sortierung
const _dndSortBacklog = (a, b) => {
  const da = a?.dueISO ? _dndParseDateOnly(a.dueISO) : null;
  const db = b?.dueISO ? _dndParseDateOnly(b.dueISO) : null;

  const daT = da && !isNaN(da) ? da.getTime() : null;
  const dbT = db && !isNaN(db) ? db.getTime() : null;

  if (daT !== null && dbT !== null && daT !== dbT) return daT - dbT;
  if (daT !== null && dbT === null) return -1;
  if (daT === null && dbT !== null) return 1;

  const pa = (_dndWEIGHT[a?.prio] || 0);
  const pb = (_dndWEIGHT[b?.prio] || 0);
  if (pb !== pa) return pb - pa;

  const durA = Number.isFinite(+a?.durationMin) ? +a.durationMin : 30;
  const durB = Number.isFinite(+b?.durationMin) ? +b.durationMin : 30;
  return durA - durB;
};

// --- Drag & Drop Utils ---
function _dndDragStart(e, payload) {
  e.dataTransfer.setData("application/json", JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "move";
}
function _dndItemDrop(e, api, { to, beforeId }) {
  e.preventDefault();
  const data = _dndSafeParse(e.dataTransfer.getData("application/json"));
  if (!data || !data.id) return;
  _dndReorderOrMove(api, { from: data.from, to, draggedId: data.id, beforeId });
}
function _dndListDrop(e, api, to) {
  e.preventDefault();
  const data = _dndSafeParse(e.dataTransfer.getData("application/json"));
  if (!data || !data.id) return;
  _dndReorderOrMove(api, { from: data.from, to, draggedId: data.id });
}
function _dndSafeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Reflow der "today"-Liste: Pausen korrekt nach Regeln einfügen (DnD-Version)
function _reflowTodayDnD(list = [], settings) {
  const cfg = settings || { maxNoBreak: 90, breakMinutes: 10, longBreakMinutes: 45 };

  // Regeln:
  const MAX_STREAK       = Math.max(30, +cfg.maxNoBreak || 90);          // 90 Min Arbeit am Stück
  const SHORT_BREAK      = Math.max(5,  +cfg.breakMinutes || 10);        // 10 Min Kurzpause
  const LONG_BREAK       = Math.max(SHORT_BREAK, +cfg.longBreakMinutes || 45); // 45 Min Langpause
  const LONG_AFTER_TOTAL = 210; // 3,5 h Gesamtzeit (Arbeit + Kurzpausen) seit letzter Langpause

  // nur Aufgaben (Pausen raus), stabil nach order
  const tasks = [...(list || [])]
    .filter(it => !it.isBreak)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const out = [];
  let workSinceShort = 0;  // reine Arbeitszeit seit letzter Kurz-/Langpause
  let totalSinceLong = 0;  // Arbeit + Kurzpausen seit letzter Langpause

  const pushBreak = (mins, label) => {
    out.push({
      id: uid(),
      title: label,
      done: false,
      prio: null,
      order: out.length,
      durationMin: mins,
      isBreak: true
    });
    if (mins >= LONG_BREAK) {
      // Langpause setzt beide Zähler zurück
      workSinceShort = 0;
      totalSinceLong = 0;
    } else {
      // Kurzpause: Arbeitsstreak zurück, Gesamtzeit steigt weiter
      workSinceShort = 0;
      totalSinceLong += mins;
    }
  };

  for (const t of tasks) {
    const dur = Math.max(5, +t.durationMin || 30);

    // WICHTIG: kein "> 0" Wächter mehr – so wird vor großen ersten Blöcken
    // korrekt eine Pause eingefügt (wir splitten Aufgaben nicht).
    const wouldBreakLong  = (totalSinceLong + dur) > LONG_AFTER_TOTAL;
    const wouldBreakShort = (workSinceShort + dur) > MAX_STREAK;

    if (wouldBreakLong) {
      pushBreak(LONG_BREAK, "Lange Pause");
    } else if (wouldBreakShort) {
      pushBreak(SHORT_BREAK, "Pause");
    }

    out.push({ ...t, isBreak: false, order: out.length });
    workSinceShort += dur;
    totalSinceLong += dur;
  }

  return out;
}

// Orders normalisieren (konfliktfreier Name)
function _dndNormalizeOrdersDnD(list, arr) {
  const out = [...arr];
  if (list === "today") {
    // Nur Aufgaben (ohne Pausen) neu nummerieren; Pausen behalten ihre order
    const tasks = out.map((it, i) => ({ ...it, __i: i }))
      .filter(it => !it.isBreak)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    tasks.forEach((t, idx) => { out[t.__i] = { ...out[t.__i], order: idx }; });
    return out;
  }
  return out.map((it, idx) => ({ ...it, order: idx }));
}

// Zentrale DnD-Operation: reorder in Liste oder Move zwischen Listen + Reflow für "today"
function _dndReorderOrMove(api, { from, to, draggedId, beforeId }) {
  api.setState(s => {
    const planner = clone(s.planner);
    const src = [...(planner[from] || [])];
    const draggedIdx = src.findIndex(x => x.id === draggedId);
    if (draggedIdx < 0) return s;
    let dragged = { ...src[draggedIdx] };

    // Entfernen aus Quelle
    src.splice(draggedIdx, 1);
    planner[from] = src;

    // Falls Move in andere Liste
    if (from !== to) {
      // In Ziel-Liste einfügen
      let dst = [...(planner[to] || [])];
      // Pausenflag nur für today
      if (to !== "today") {
        const { isBreak, ...rest } = dragged; dragged = rest;
      }

      // Einfügeposition bestimmen
      let insertIdx = typeof beforeId === "string" ? dst.findIndex(x => x.id === beforeId) : -1;
      if (insertIdx < 0) insertIdx = dst.length;
      dst.splice(insertIdx, 0, { ...dragged });

      // Orders normalisieren + ggf. Reflow
      if (to === "today") {
        dst = _reflowTodayDnD(_dndNormalizeOrdersDnD("today", dst), s.settings);
      } else {
        dst = _dndNormalizeOrdersDnD(to, dst);
      }

      planner[to] = dst;

      // Quelle ggf. reflowen (wenn today)
      if (from === "today") planner[from] = _reflowTodayDnD(_dndNormalizeOrdersDnD("today", planner[from]), s.settings);

      return { ...s, planner };
    }

    // Reorder innerhalb derselben Liste
    let dst = [...(planner[to] || [])];
    let insertIdx = typeof beforeId === "string" ? dst.findIndex(x => x.id === beforeId) : -1;
    if (insertIdx < 0) insertIdx = dst.length;

    // Finde alte Position im Ziel nach Entfernen (ggf. korrigieren, wenn hinter sich selbst gedropped)
    const currentIndexInDst = dst.findIndex(x => x.id === draggedId);
    if (currentIndexInDst >= 0 && insertIdx > currentIndexInDst) insertIdx--; // because removed earlier

    // Falls der Einfügepunkt identisch ist, nichts tun
    if (currentIndexInDst === insertIdx) return s;

    // Insert an neuer Stelle
    dst.splice(insertIdx, 0, dragged);

    // Orders + Reflow
    if (to === "today") {
      dst = _reflowTodayDnD(_dndNormalizeOrdersDnD("today", dst), s.settings);
    } else {
      dst = _dndNormalizeOrdersDnD(to, dst);
    }

    planner[to] = dst;
    return { ...s, planner };
  });
}

/* ---------------- Column & Row (mit DnD) ---------------- */
function _PlannerColumn({
  api,
  listKey, title, items,
  onAdd, onToggle, onDelete, onMove,
  allowAdd, dnd
}) {
  const [v, setV] = useState("");
  const [p, setP] = useState("NDNW");
  const [dur, setDur] = useState("");
  const [due, setDue] = useState("");

  const add = () => {
    const t = v.trim(); if (!t) return;
    onAdd(t, p, dur ? +dur : null, due || null);
    setV(""); setDur(""); setDue("");
  };

  const sorted = useMemo(() => {
  if (listKey === "today") {
    // nur strikt nach order
    return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  return [...items].sort(_dndSortBacklog);
}, [items, listKey]);

  return (
    <div className="card"
      onDragOver={(e) => dnd && e.preventDefault()}
      onDrop={(e) => dnd && _dndListDrop(e, api, listKey)}>
      <div className="row between"><strong>{title}</strong></div>

      {allowAdd && (
        <div className="row wrap mt8">
          <input className="input" placeholder="Aufgabe…" value={v}
            onChange={e => setV(e.target.value)}
            onKeyDown={e => e.key === "Enter" && add()} />
<div className="prio-buttons">
  {[
    { val: "DW", label: "Dringend & Wichtig", color: "#ff5e5e" },
    { val: "NDW", label: "Nicht dringend & Wichtig", color: "#4dff8a" },
    { val: "DNW", label: "Dringend & nicht wichtig", color: "#ffb84d" },
    { val: "NDNW", label: "Nicht dringend & nicht wichtig", color: "#4da6ff" },
    { val: "", label: "Keine Prio", color: "#aaa" },
  ].map(btn => (
    <button
      key={btn.val || "none"}
      className={`prio-btn ${p === btn.val ? "active" : ""}`}
      style={{
        borderColor: btn.color,
        color: p === btn.val ? "#fff" : btn.color,
        background: p === btn.val ? btn.color : "transparent",
      }}
      onClick={() => setP(btn.val)}
      type="button"
    >
      {btn.label}
    </button>
  ))}
</div>
          <input className="input num" type="number" min="5" step="5" placeholder="Dauer (Min)"
            value={dur} onChange={e => setDur(e.target.value)} />
          <input className="input" type="date" value={due} onChange={e => setDue(e.target.value)} />
          <button className="btn btn-primary" onClick={add} type="button">Hinzufügen</button>
        </div>
      )}

      <ul className="list mt8">
        {sorted.map(it => (
          <_PlannerRow
            key={it.id}
            api={api}
            list={listKey}
            item={it}
            onToggle={(id) => onToggle(id)}
            onDelete={(id) => onDelete(id)}
            onMove={(id, dir) => onMove(id, dir)}
            dnd={dnd}
          />
        ))}
        {!sorted.length && <div className="muted">Noch keine Einträge.</div>}
      </ul>
    </div>
  );
}

function _PlannerRow({ api, list, item, onToggle, onDelete, onMove, dnd }) {
  if (item.isBreak) {
    return (
      <li className="item break" aria-label={`Pause ${item.durationMin || 10} Minuten`}>
        <div className="title">☕ Pause · {item.durationMin || 10} Min</div>
      </li>
    );
  }

  // Farbklasse nach Dringlichkeit
  const prioClass =
    item.prio === "DW" ? "prio-dw" :
    item.prio === "NDW" ? "prio-ndw" :
    item.prio === "DNW" ? "prio-dnw" :
    item.prio === "NDNW" ? "prio-ndnw" : "";

  const prioShort =
    item.prio === "DW" ? "DW" :
    item.prio === "NDW" ? "NDW" :
    item.prio === "DNW" ? "DNW" :
    item.prio === "NDNW" ? "NDNW" : "";

  return (
    <li
      className={`item task ${prioClass}`}
      draggable={!!dnd}
      onDragStart={(e) => dnd && _dndDragStart(e, { id: item.id, from: list })}
      onDragOver={(e) => dnd && e.preventDefault()}
      onDrop={(e) => dnd && _dndItemDrop(e, api, { to: list, beforeId: item.id })}
    >
      {/* 1. Zeile: Checkbox + Taskname */}
      <div className="row top">
        <input
          type="checkbox"
          checked={item.done}
          onChange={() => onToggle(item.id)}
          className="checkbox"
        />
        <span className={`task-title ${item.done ? "done" : ""}`}>{item.title}</span>
      </div>

      {/* 2. Zeile: Dauer + Prio (kurz) + Deadline */}
      <div className="row mid">
        <div className="muted">
          ⏱ {item.durationMin || 0} Min
        </div>
        {prioShort && <span className="badge small">{prioShort}</span>}
        {item.dueISO && (
          <div className="muted deadline">
            📅 bis {_dndFmtDate(item.dueISO)}
          </div>
        )}
      </div>

      {/* 3. Zeile: Buttons nebeneinander */}
      <div className="row bottom actions">
        <button className="btn ghost" title="nach oben" onClick={() => onMove(item.id, -1)} type="button">↑</button>
        <button className="btn ghost" title="nach unten" onClick={() => onMove(item.id, +1)} type="button">↓</button>
        {list !== "today" && (
          <button className="btn" onClick={() => _dndReorderOrMove(api, { from: list, to: "today", draggedId: item.id })} type="button">→ Heute</button>
        )}
        {list !== "backlog" && (
          <button className="btn" onClick={() => _dndReorderOrMove(api, { from: list, to: "backlog", draggedId: item.id })} type="button">→ Backlog</button>
        )}
        {list !== "pool" && (
          <button className="btn" onClick={() => _dndReorderOrMove(api, { from: list, to: "pool", draggedId: item.id })} type="button">→ Pool</button>
        )}
        <button className="btn" onClick={() => onDelete(item.id)} type="button">Löschen</button>
      </div>

      {/* Live-Timer nur im Tagesplan (Heute) */}
      {list === "today" && !item.done && (
        <TaskTimer item={item} timers={api.state.timers} api={api} />
      )}
    </li>
  );
}

/* =========================================================
   Aufgaben-Timer (Start/Ende je Aufgabe) + Countdown-Balken
   ========================================================= */
function TaskTimer({ item, timers, api, compact }) {
  const isActive = timers?.activeId === item.id;
  useNow(isActive);
  const spent = liveSpentSec(item, timers);
  const plannedSec = (Number(item.durationMin) || 0) * 60;
  const pct = plannedSec > 0 ? Math.min(100, (spent / plannedSec) * 100) : 0;
  const over = plannedSec > 0 && spent > plannedSec;
  const barState = !plannedSec ? "none" : over ? "over" : pct >= 80 ? "warn" : "ok";

  return (
    <div className={`tasktimer ${isActive ? "running" : ""} ${compact ? "compact" : ""}`}>
      <div className="tasktimer-row">
        {!isActive
          ? <button className="btn btn-primary tt-btn" type="button" onClick={() => api.taskStart(item.id)}>▶ Start</button>
          : <button className="btn tt-btn tt-stop" type="button" onClick={() => api.taskStop()}>⏹ Ende</button>}
        <span className="tt-time">
          {mmss(spent)}{plannedSec ? <span className="muted"> / {mmss(plannedSec)}</span> : null}
          {over ? <span className="tt-over"> +{mmss(spent - plannedSec)}</span> : null}
        </span>
        {(spent > 0 || isActive) && (
          <button className="btn ghost tt-btn" type="button" title="Timer zurücksetzen" onClick={() => api.taskResetTimer(item.id)}>↺</button>
        )}
      </div>
      {plannedSec > 0 && (
        <div className="tt-bar"><div className={`tt-fill s-${barState}`} style={{ width: `${over ? 100 : pct}%` }} /></div>
      )}
    </div>
  );
}

/* =========================================================
   Zeitstrahl – Tagesplan als visuelle Zeitachse
   ========================================================= */
function DayTimeline({ today, dayStart, timers }) {
  const sched = useMemo(() => computeSchedule(today || [], dayStart), [today, dayStart]);
  useNow(!!timers?.activeId);
  if (!sched.length) return <div className="muted">Noch nichts geplant – erstelle einen Tagesplan.</div>;
  const endLabel = minToHHMM(sched[sched.length - 1].endMin);
  return (
    <div className="timeline">
      {sched.map(it => {
        const active = timers?.activeId === it.id;
        const cls = it.isBreak ? "tl-break" : (it.done ? "tl-done" : "tl-task");
        return (
          <div key={it.id} className={`tl-row ${cls} ${active ? "tl-active" : ""}`}>
            <div className="tl-time">{minToHHMM(it.startMin)}</div>
            <div className="tl-track"><span className="tl-dot" /></div>
            <div className="tl-body">
              <div className="tl-title">{it.isBreak ? `🌿 ${it.title || "Pause"}` : (it.title || "Ohne Titel")}</div>
              <div className="tl-meta muted">{minToHHMM(it.startMin)}–{minToHHMM(it.endMin)} · {Math.max(0, Number(it.durationMin) || 0)} Min{active ? " · läuft ⏱" : ""}</div>
            </div>
          </div>
        );
      })}
      <div className="tl-row tl-end">
        <div className="tl-time">{endLabel}</div>
        <div className="tl-track"><span className="tl-dot end" /></div>
        <div className="tl-body"><div className="tl-title muted">Feierabend 🎉</div></div>
      </div>
    </div>
  );
}

/* =========================================================
   PhaseTimer – geführter Timer für Atem-/Reset-Übungen
   ========================================================= */
function PhaseTimer({ phases = [], repeat = 1, onAcknowledge }) {
  const seq = useMemo(() => {
    const arr = [];
    for (let r = 0; r < Math.max(1, repeat); r++) phases.forEach(p => arr.push(p));
    return arr;
  }, [phases, repeat]);
  const totalSec = useMemo(() => seq.reduce((a, p) => a + (p.seconds || 0), 0), [seq]);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef(null);

  useEffect(() => {
    if (!running) { if (tickRef.current) clearInterval(tickRef.current); return; }
    tickRef.current = setInterval(() => {
      setElapsed(t => {
        const next = t + 1;
        if (next >= totalSec) { clearInterval(tickRef.current); setRunning(false); onAcknowledge?.(); return totalSec; }
        return next;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [running, totalSec, onAcknowledge]);

  // aktuelle Phase bestimmen
  let acc = 0, idx = 0, into = 0;
  for (let i = 0; i < seq.length; i++) {
    const len = seq[i].seconds || 0;
    if (elapsed < acc + len || i === seq.length - 1) { idx = i; into = elapsed - acc; break; }
    acc += len;
  }
  const cur = seq[idx] || { label: "—", seconds: 0 };
  const remainInPhase = Math.max(0, (cur.seconds || 0) - into);
  const phaseProg = cur.seconds ? Math.min(1, into / cur.seconds) : 0;
  const done = elapsed >= totalSec;
  const cycleLen = phases.length;
  const roundNo = cycleLen ? Math.floor(idx / cycleLen) + 1 : 1;

  return (
    <div className="nudge">
      <div className="timer-head">
        <div className="timer-big">{done ? "Fertig ✓" : cur.label}</div>
        <div className="timer-sub">
          {done ? `${mmss(totalSec)} gesamt` : `noch ${remainInPhase}s · ${mmss(totalSec - elapsed)} verbleibend`}
          {repeat > 1 && !done ? ` · Runde ${Math.min(roundNo, repeat)}/${repeat}` : ""}
        </div>
      </div>
      <div className="phase-bar"><div style={{ width: `${phaseProg * 100}%` }} /></div>
      <div className="progress"><div className="progress-bar" style={{ width: `${totalSec ? (elapsed / totalSec) * 100 : 0}%` }} /></div>
      <div className="row mt8">
        {!running && elapsed === 0 && <button className="btn btn-primary" onClick={() => setRunning(true)}>Start</button>}
        {running && <button className="btn" onClick={() => setRunning(false)}>Pause</button>}
        {!running && elapsed > 0 && elapsed < totalSec && <button className="btn btn-primary" onClick={() => setRunning(true)}>Weiter</button>}
        <button className="btn" onClick={() => { setRunning(false); setElapsed(0); }}>Reset</button>
        <button className="btn" onClick={onAcknowledge}>Fertig</button>
      </div>
    </div>
  );
}

/* ---------- Kleine UI-Bausteine ---------- */
function PrioSelect({ value, onChange }) {
  return (
    <select className="input" value={value} onChange={e => onChange(e.target.value)}>
      <option value="DW">DW – dringend & wichtig</option>
      <option value="NDW">NDW – nicht dringend & wichtig</option>
      <option value="DNW">DNW – dringend & nicht wichtig</option>
      <option value="NDNW">NDNW – nicht dringend & nicht wichtig</option>
      <option value="">ohne Prio</option>
    </select>
  );
}

/* =========================================================
   Inbox
   ========================================================= */
function InboxView({ state, api }) {
  const [v, setV] = useState("");
  const add = () => { if (v.trim()) { api.inboxAdd(v); setV(""); } };

  return (
    <>
      <h2 className="h1">Ablenkungs-Parkplatz</h2>
      <div className="card">
        <div className="row wrap">
          <input className="input" placeholder="Gedanke / Ablenkung…" value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === "Enter" && add()} />
          <button className="btn btn-primary" onClick={add}>Parken</button>
        </div>

        <ul className="list mt8">
          {state.inbox.map(it => (
            <li key={it.id} className="item">
              <div>
                <div className="title">{it.text}</div>
                <div className="muted">{new Date(it.dateISO).toLocaleString()}</div>
              </div>
              <div className="row wrap gap actions">
                <button className="btn" onClick={() => api.inboxToBacklog(it.id)}>→ Backlog</button>
                <button className="btn" onClick={() => api.inboxRemove(it.id)}>Löschen</button>
              </div>
            </li>
          ))}
          {!state.inbox.length && <div className="muted">Aktuell nichts geparkt.</div>}
        </ul>
      </div>
    </>
  );
}

/* =========================================================
   Journal
   ========================================================= */
function JournalView({ state, api }) {
  const [mood, setMood] = useState(3);
  const [focus, setFocus] = useState(3);
  const [note, setNote] = useState("");
  const chips = ["Timer geholfen", "Ablenkungen geparkt", "Klarer Start", "Kurze Pause", "Aufgabe zerlegt", "Frische Luft"];

  const last7 = useMemo(() => { const now = Date.now(); return state.journal.filter(j => now - new Date(j.dateISO).getTime() <= 7 * 24 * 3600 * 1000); }, [state.journal]);
  const moodAvg7 = last7.length ? (last7.reduce((a, b) => a + b.mood, 0) / last7.length).toFixed(1) : "–";
  const focusAvg7 = last7.length ? (last7.reduce((a, b) => a + b.focus, 0) / last7.length).toFixed(1) : "–";

  return (
    <>
      <h2 className="h1">Journal</h2>

      <div className="card">
        <ol className="ol"><li>Stimmung (1–5)</li><li>Fokus (1–5)</li><li>1 Satz: Was hat geholfen?</li></ol>
        <div className="row wrap">
          <label>Stimmung<input type="number" min={1} max={5} value={mood} onChange={e => setMood(+e.target.value)} className="input num" /></label>
          <label>Fokus<input type="number" min={1} max={5} value={focus} onChange={e => setFocus(+e.target.value)} className="input num" /></label>
        </div>
        <div className="row wrap mt8">{chips.map(c => <button key={c} className="btn ghost" onClick={() => setNote(n => n ? n + "; " + c : c)}>{c}</button>)}</div>
        <textarea className="textarea mt8" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="z. B. 15-Min-Timer + Handy weg → guter Fokus" />
        <div className="row end mt8"><button className="btn btn-primary" onClick={() => { api.addJournal(mood, focus, note); setNote(""); }}>Speichern</button></div>
      </div>

      <div className="card"><strong>Auswertung (7 Tage)</strong><p className="muted">Ø Stimmung {moodAvg7} · Ø Fokus {focusAvg7} · Einträge {state.journal.length}</p></div>

      <div className="card">
        <strong>Einträge</strong>
        <ul className="list mt8">
          {state.journal.map(e => (
            <li key={e.id} className="item">
              <div>
                <div><strong>{new Date(e.dateISO).toLocaleString()}</strong></div>
                <div className="muted">Stimmung {e.mood} · Fokus {e.focus}</div>
                {e.note && <div className="mt6">{e.note}</div>}
              </div>
            </li>
          ))}
          {!state.journal.length && <div className="muted">Noch keine Einträge.</div>}
        </ul>
      </div>
    </>
  );
}

/* =========================================================
   Check-in
   ========================================================= */
function CheckinView({ api, last }) {
  const [vals, setVals] = useState({ focus: 3, thoughts: 3, tension: 3, stimuli: 3, impulse: 3, social: 3, energy: 3, mood: 3 });
  const setVal = (k, v) => setVals(s => ({ ...s, [k]: +v }));

  const score = useMemo(() => { const sum = Object.values(vals).reduce((a, b) => a + b, 0); return Math.round((sum / (8 * 5)) * 100); }, [vals]);
  const adv = useMemo(() => computeAdviceADHD(vals), [vals]);
  const band = useMemo(() => scoreBand(score), [score]);

  return (
    <>
      <h2 className="h1"> Micro-Check-in</h2>
      <div className="row gap mt8">
        <span className={`badge metric band-${band.label.toLowerCase().replace(/\s+/g, '-')}`}>Score {score}</span>
        <span className="muted">Status: {band.label} — {band.tone}. {band.label === "hoch belastet" ? "Atme 3x ruhig, dann ein Mini-Schritt (2–5 Min)." : band.label === "angespannt" ? "Kleine Struktur hilft: 5–10 Min Fokus-Sprint starten." : band.label === "solide" ? "Sieht gut aus: Plane den nächsten 15-Min-Block." : "Top: Kurs halten – danach kleine Belohnung einplanen."}</span>
      </div>

      <div className="card">
        <ScaleADHD label="Fokus auf Aufgabe" value={vals.focus} set={v => setVal("focus", v)} />
        <ScaleADHD label="Gedankenflut (Tabs im Kopf)" value={vals.thoughts} set={v => setVal("thoughts", v)} />
        <ScaleADHD label="Körperanspannung (locker?)" value={vals.tension} set={v => setVal("tension", v)} />
        <ScaleADHD label="Reizpegel abschirmen" value={vals.stimuli} set={v => setVal("stimuli", v)} />
        <ScaleADHD label="Beim Thema bleiben (Impulsdrang gering?)" value={vals.impulse} set={v => setVal("impulse", v)} />
        <ScaleADHD label="Soziale Batterie" value={vals.social} set={v => setVal("social", v)} />
        <ScaleADHD label="Energie" value={vals.energy} set={v => setVal("energy", v)} />
        <ScaleADHD label="Stimmung/Frusttoleranz" value={vals.mood} set={v => setVal("mood", v)} />
        <div className="row between mt8">
          <strong>Score: {score}/100</strong>
          <button className="btn btn-primary" onClick={() => { api.addCheckin({ type: "adhd", ...vals }); alert("Check-in gespeichert."); }}>Speichern</button>
        </div>
      </div>

      <div className="card">
        <strong>Empfehlungen</strong>
        <p className="muted">Zugeschnitten auf deine niedrigsten Werte — nach ADHS-Wissensstand.</p>
        <ul className="list mt8">
          {adv.map((a, i) => (
            <li key={i} className="item advice">
              <div className="title">💡 {a.title}</div>
              <div className="muted mt6">{a.why}</div>
            </li>
          ))}
        </ul>
        <div className="row mt8"><a className="btn" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Nach oben</a></div>
      </div>

      {last && (<div className="card"><strong>Letzter Check-in</strong><p className="muted">{new Date(last.dateISO).toLocaleString()} · Score {last.score}/100</p></div>)}
    </>
  );
}

function scaleWord(v) {
  if (v <= 1.5) return "sehr niedrig";
  if (v <= 2.5) return "niedrig";
  if (v <= 3.5) return "mittel";
  if (v <= 4.5) return "gut";
  return "sehr gut";
}

function ScaleADHD({ label, value, set }) {
  return (
    <div className="scale">
      <div className="scale-label">{label}</div>
      <input type="range" min="1" max="5" step="0.5" value={value} onChange={e => set(e.target.value)} className="range color" />
      <span className="badge metric">{Number(value).toFixed(1)}</span>
      <span className="scale-word muted">{scaleWord(Number(value))}</span>
    </div>
  );
}

/* =========================================================
   Stress – kurze Übungen
   ========================================================= */
function StressView({ onAcknowledge }) {
  const [mode, setMode] = useState("box"); // "box" | "478" | "sigh" | "pmr" | "eyes"
  return (
    <div className="card">
      <h2 className="h1">Stress – kurze Übungen</h2>
      <div className="row wrap mt8">
        <button className={`btn ${mode === "box" ? "btn-primary" : ""}`} onClick={() => setMode("box")}>Box-Breathing</button>
        <button className={`btn ${mode === "478" ? "btn-primary" : ""}`} onClick={() => setMode("478")}>4-7-8 Atmung</button>
        <button className={`btn ${mode === "sigh" ? "btn-primary" : ""}`} onClick={() => setMode("sigh")}>Physio-Seufzer</button>
        <button className={`btn ${mode === "pmr" ? "btn-primary" : ""}`} onClick={() => setMode("pmr")}>Mini-PMR</button>
        <button className={`btn ${mode === "eyes" ? "btn-primary" : ""}`} onClick={() => setMode("eyes")}>Augen-Reset</button>
      </div>
      <div className="mt8">
        {mode === "box" && (<><h3 className="h1">Atem-Übung (Box Breathing)</h3><BreathTimer totalSeconds={180} stepSeconds={4} onAcknowledge={onAcknowledge} /></>)}
        {mode === "478" && (<>
          <h3 className="h1">4-7-8 Atmung (≈1 Min · 4 Runden)</h3>
          <PhaseTimer
            repeat={4}
            phases={[
              { label: "Einatmen durch die Nase", seconds: 4 },
              { label: "Atem halten", seconds: 7 },
              { label: "Langsam durch den Mund ausatmen", seconds: 8 },
            ]}
            onAcknowledge={onAcknowledge}
          />
        </>)}
        {mode === "sigh" && (<>
          <h3 className="h1">Physiologischer Seufzer (≈2 Min · 8 Runden)</h3>
          <PhaseTimer
            repeat={8}
            phases={[
              { label: "Doppelt einatmen (Nase + kleiner Zusatzzug)", seconds: 4 },
              { label: "Lang & gleichmäßig ausatmen (Mund)", seconds: 6 },
            ]}
            onAcknowledge={onAcknowledge}
          />
        </>)}
        {mode === "pmr" && (<>
          <h3 className="h1">Mini-PMR (≈1,5 Min · 2 Runden)</h3>
          <PhaseTimer
            repeat={2}
            phases={[
              { label: "Schultern anspannen", seconds: 6 },
              { label: "Loslassen & nachspüren", seconds: 12 },
              { label: "Kiefer sanft pressen", seconds: 5 },
              { label: "Loslassen & nachspüren", seconds: 12 },
            ]}
            onAcknowledge={onAcknowledge}
          />
        </>)}
        {mode === "eyes" && (<>
          <h3 className="h1">Augen-Reset (≈1 Min)</h3>
          <PhaseTimer
            repeat={1}
            phases={[
              { label: "In die Ferne schauen (≥6 m)", seconds: 25 },
              { label: "10× blinzeln, Blick weich werden lassen", seconds: 10 },
              { label: "5 ruhige Atemzüge durch die Nase", seconds: 20 },
            ]}
            onAcknowledge={onAcknowledge}
          />
        </>)}
      </div>
    </div>
  );
}

function SimpleExercise({ title, steps }) {
  return (
    <div className="nudge">
      <div className="nudge-title">{title}</div>
      <ul className="ol">{steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
      <div className="row end mt8"><button className="btn" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Nach oben</button></div>
    </div>
  );
}

function BreathTimer({ totalSeconds = 180, stepSeconds = 4, onAcknowledge }) {
  const steps = useMemo(() => ([{ key: "ein", label: "Einatmen" }, { key: "halt1", label: "Halten" }, { key: "aus", label: "Ausatmen" }, { key: "halt2", label: "Halten" },]), []);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef(null);

  useEffect(() => {
    if (!running) { if (tickRef.current) clearInterval(tickRef.current); return; }
    tickRef.current = setInterval(() => {
      setElapsed(t => {
        const next = t + 1;
        if (next >= totalSeconds) { clearInterval(tickRef.current); setRunning(false); onAcknowledge?.(); return totalSeconds; }
        return next;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [running, totalSeconds, onAcknowledge]);

  const cycle = steps.length * stepSeconds;
  const cyclePos = elapsed % cycle;
  const stepIdx = Math.floor(cyclePos / stepSeconds);
  const stepElapsed = cyclePos - stepIdx * stepSeconds;
  const stepProgress = Math.min(1, stepElapsed / stepSeconds);

  const mmss = sec => { const m = Math.floor(sec / 60).toString().padStart(2, "0"); const s = (sec % 60).toString().padStart(2, "0"); return `${m}:${s}`; };

  return (
    <>
      <div className="timer-head">
        <div className="timer-big">{mmss(elapsed)}</div>
        <div className="timer-sub">von {mmss(totalSeconds)} · aktuell: <strong>{steps[stepIdx].label}</strong> ({stepSeconds}s)</div>
      </div>
      <div className="timer-steps">
        {steps.map((s, i) => (
          <div key={s.key} className={`step ${i === stepIdx ? "active" : ""}`}>
            <div className="step-name">{s.label}</div>
            <div className="step-seconds">{i === stepIdx ? (stepSeconds - stepElapsed) : stepSeconds}s</div>
            <div className="step-bar"><div style={{ width: `${i === stepIdx ? stepProgress * 100 : 0}%` }} /></div>
          </div>
        ))}
      </div>
      <div className="row mt8">
        {!running && elapsed === 0 && (<button className="btn btn-primary" onClick={() => setRunning(true)}>Start</button>)}
        {running && <button className="btn" onClick={() => setRunning(false)}>Pause</button>}
        {!running && elapsed > 0 && elapsed < totalSeconds && (<button className="btn btn-primary" onClick={() => setRunning(true)}>Weiter</button>)}
        <button className="btn" onClick={() => { setRunning(false); setElapsed(0); }}>Reset</button>
        <button className="btn" onClick={onAcknowledge}>Fertig</button>
      </div>
    </>
  );
}

/* ---------- Helpers ---------- */

// Dimensionsbezogene ADHS-Empfehlungen (niedrigste Werte zuerst)
function computeAdviceADHD(vals = {}) {
  const DIM = {
    focus:    { title: "Pomodoro + Body-Doubling", why: "25-Min-Timer, Handy außer Reichweite; jemand mit im Raum oder Video-Call senkt den Startwiderstand spürbar." },
    thoughts: { title: "2-Minuten-Brain-Dump", why: "Alle offenen Gedanken in die Inbox schreiben — entlastet das Arbeitsgedächtnis, das bei ADHS schneller überläuft." },
    tension:  { title: "Physiologischer Seufzer", why: "Zweimal einatmen, lang ausatmen, 6–8×. Beruhigt das Nervensystem in ein bis zwei Minuten." },
    stimuli:  { title: "Reizarme Zone bauen", why: "Kopfhörer/Noise, Benachrichtigungen aus, Sichtfeld aufräumen — weniger Reize, weniger Abschweifen." },
    impulse:  { title: "Wenn-Dann-Plan", why: "‚Wenn ich abschweife, dann notiere ich eine Zeile und kehre zurück.' Solche Vorsätze steigern die Handlungsauslösung." },
    social:   { title: "Solo-Block + Rückzug", why: "Termine bündeln und 20 Min bewusst allein einplanen — schützt die begrenzte soziale Energie." },
    energy:   { title: "Bewegungs-Snack + Wasser", why: "3–5 Min Bewegung, dazu Wasser/Protein. Kurze Aktivierung hebt Dopamin & Noradrenalin — die zentrale ADHS-Stellschraube." },
    mood:     { title: "Mini-Win + Selbstmitgefühl", why: "Ein 2-Minuten-Schritt zählt und wird sichtbar abgehakt. Kleine Erfolge stabilisieren Frusttoleranz und Antrieb." },
  };
  const order = ["focus", "thoughts", "tension", "stimuli", "impulse", "social", "energy", "mood"];
  const low = order
    .map(k => ({ k, v: Number(vals[k]) || 0 }))
    .filter(x => x.v <= 3)
    .sort((a, b) => a.v - b.v)
    .slice(0, 3)
    .map(x => DIM[x.k]);
  if (!low.length) {
    return [{ title: "Kurs halten", why: "Alles im grünen Bereich — plane den nächsten Fokusblock und danach eine kleine Belohnung." }];
  }
  return low;
}

// Empfehlungen nur noch aus dem Gesamtscore (0..100)
function computeAdviceFromScore(score) {
  if (score <= 40) {
    return ["3 Min Box-Breathing und 2 Min Brain-Dump in die Inbox.", "10 Min Fokus-Sprint mit Teilziel (Timer stellen, Handy weg).", "Reize runter: Kopfhörer / Benachrichtigungen aus, ruhiger Ort."];
  }
  if (score <= 60) {
    return ["5 Min Mini-Sprint → kleine Aufgabe abschließen.", "Kurzstruktur aufschreiben, 10–15 Min Timer.", "Energie auffüllen: Wasser + Bewegung."];
  }
  if (score <= 80) {
    return ["Flow halten: 15 Min Deep-Work, dann 2 Min lockern.", "Ablenkungen parken statt wechseln.", "Leichte Musik / Noise Control für Konstanz."];
  }
  return ["Weiter so: Nächsten 20-Min-Block planen, Belohnung danach.", "Im Journal notieren, was heute gut lief."];
}
function scoreBand(score) {
  if (score <= 40) return { label: "hoch belastet", tone: "Erdung & kurze Atmung helfen" };
  if (score <= 60) return { label: "angespannt", tone: "Mini-Sprints & klare Struktur" };
  if (score <= 80) return { label: "solide", tone: "Flow halten, kurze Lockerung" };
  return { label: "gut", tone: "Kurs halten, kleine Belohnung" };
}

