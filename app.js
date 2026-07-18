import {
  getAll, put, putMany, remove, clear, getValue, setValue, clearEverything, storageMode
} from './db.js';
import {
  MUSCLE_COLORS, numberValue, e1rm, inferTarget, setLabels, readinessProfile,
  suggestSet, sessionStats, buildAnalytics, calculateLevel, achievements
} from './engine.js';

const APP_VERSION = '2.0.0';
const TOTAL_WEEKS = 14;
const DEFAULT_SETTINGS = {
  week: 1,
  units: 'kg',
  restAutoStart: true,
  reducedEffects: false,
  installHintDismissed: false,
  selectedTrendExercise: null
};

const state = {
  plan: null,
  settings: { ...DEFAULT_SETTINGS },
  active: null,
  timer: null,
  history: [],
  readiness: [],
  measurements: [],
  lastWeights: {},
  tab: 'home',
  screen: null,
  selectedWorkoutId: null,
  collapsed: {},
  timerInterval: null,
  clockInterval: null,
  wakeLock: null,
  installPrompt: null,
  modalDraft: null,
  lastSetAction: null,
  storage: 'IndexedDB'
};

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
const modalRoot = document.getElementById('modal-root');

const ICONS = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5z"/><path d="M9 21v-7h6v7"/></svg>',
  plan: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  analytics: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  profile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></svg>'
};

function safeJSON(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function uuid(prefix = 'pf') {
  if (crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat('it-IT', { maximumFractionDigits: digits }).format(Number(value) || 0);
}

function formatDate(iso, options = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('it-IT', options).format(new Date(iso));
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function restLabel(seconds) {
  if (!seconds) return 'senza pausa';
  if (seconds % 60 === 0) return `${seconds / 60} min recupero`;
  return `${seconds} sec recupero`;
}

function todayKey() { return new Date().toISOString().slice(0, 10); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

function allWorkouts() {
  if (!state.plan) return [];
  return [
    ...state.plan.phase1.workouts,
    ...state.plan.phase2A.workouts,
    ...state.plan.phase2B.workouts,
    ...state.plan.extras
  ];
}

function workoutById(id) { return allWorkouts().find((workout) => workout.id === id); }

function phaseForWeek(week) {
  if (week <= 6) return state.plan.phase1;
  return (week - 6) % 2 === 0 ? state.plan.phase2B : state.plan.phase2A;
}

function phaseLabelForWeek(week) {
  if (week <= 6) return `Fase 01 · settimana ${week}/6`;
  const localWeek = week - 6;
  return `Fase 02 · Scheda ${localWeek % 2 === 0 ? 'B' : 'A'} · settimana ${localWeek}/8`;
}

function estimatedMinutes(workout) {
  const seconds = workout.exercises.reduce((sum, exercise) => {
    const work = exercise.loadMode === 'timed' ? 35 : 38;
    return sum + exercise.setCount * (work + Math.max(20, exercise.restSeconds || 0));
  }, 0);
  return Math.max(20, Math.round(seconds / 60));
}

function latestReadiness() {
  return [...state.readiness].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function readinessToday() {
  return state.readiness.find((item) => item.createdAt?.slice(0, 10) === todayKey()) || latestReadiness();
}

function completedWorkoutIdsForWeek() {
  return new Set(state.history.filter((session) => Number(session.programWeek) === Number(state.settings.week)).map((session) => session.workoutId));
}

function currentPhaseWorkouts() { return phaseForWeek(state.settings.week).workouts; }

function nextWorkout() {
  const completed = completedWorkoutIdsForWeek();
  return currentPhaseWorkouts().find((workout) => !completed.has(workout.id)) || currentPhaseWorkouts()[0];
}

function workoutProgress(active = state.active) {
  if (!active) return { completed: 0, total: 0, percent: 0 };
  const sets = active.exercises.flatMap((exercise) => exercise.sets || []);
  const completed = sets.filter((set) => set.completed).length;
  return { completed, total: sets.length, percent: sets.length ? completed / sets.length : 0 };
}

function weekSummary() {
  const sessions = state.history.filter((session) => Number(session.programWeek) === Number(state.settings.week));
  const planned = currentPhaseWorkouts().length;
  const sets = sessions.reduce((sum, session) => sum + sessionStats(session).completedSets, 0);
  const volume = sessions.reduce((sum, session) => sum + sessionStats(session).volume, 0);
  return { sessions: sessions.length, planned, sets, volume };
}

function latestExerciseDraft(exerciseId) {
  const sorted = [...state.history].sort((a, b) => new Date(b.endedAt || b.startedAt) - new Date(a.endedAt || a.startedAt));
  for (const session of sorted) {
    const draft = session.exercises?.find((exercise) => exercise.exerciseId === exerciseId);
    if (draft) return draft;
  }
  return null;
}

function haptic(pattern = 14) {
  try { if ('vibrate' in navigator) navigator.vibrate(pattern); } catch { /* non essenziale */ }
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => toastEl.classList.remove('show'), 2300);
}

async function migrateV1() {
  const alreadyMigrated = await getValue('migration.v1.complete', false);
  if (alreadyMigrated) return;

  const oldSettings = safeJSON(localStorage.getItem('protocolfit.settings.v1'), null);
  const oldActive = safeJSON(localStorage.getItem('protocolfit.active.v1'), null);
  const oldHistory = safeJSON(localStorage.getItem('protocolfit.history.v1'), []);
  const oldLastWeights = safeJSON(localStorage.getItem('protocolfit.lastWeights.v1'), {});
  const oldTimer = safeJSON(localStorage.getItem('protocolfit.timer.v1'), null);

  if (oldSettings) await setValue('settings', { ...DEFAULT_SETTINGS, ...oldSettings });
  if (oldActive) await setValue('active', normalizeSession(oldActive, true));
  if (oldTimer) await setValue('timer', oldTimer);
  if (oldLastWeights) await setValue('lastWeights', oldLastWeights);
  if (Array.isArray(oldHistory) && oldHistory.length) {
    await putMany('history', oldHistory.map((session) => normalizeSession(session, false)));
  }
  await setValue('migration.v1.complete', true);
}

function normalizeSession(session, active = false) {
  const normalized = structuredClone(session || {});
  normalized.id ||= uuid(active ? 'active' : 'session');
  normalized.startedAt ||= new Date().toISOString();
  normalized.exercises = (normalized.exercises || []).map((exercise) => ({
    ...exercise,
    sets: (exercise.sets || []).map((set) => ({ rir: set.rir ?? 2, ...set }))
  }));
  return normalized;
}

async function loadState() {
  state.settings = { ...DEFAULT_SETTINGS, ...(await getValue('settings', DEFAULT_SETTINGS)) };
  state.active = await getValue('active', null);
  state.timer = await getValue('timer', null);
  state.lastWeights = await getValue('lastWeights', {});
  state.history = (await getAll('history')).sort((a, b) => new Date(b.endedAt || b.startedAt) - new Date(a.endedAt || a.startedAt));
  state.readiness = (await getAll('readiness')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  state.measurements = (await getAll('measurements')).sort((a, b) => new Date(b.date) - new Date(a.date));
  state.storage = await storageMode();
}

async function init() {
  try {
    const response = await fetch('./plan.json');
    if (!response.ok) throw new Error('Impossibile caricare la scheda');
    state.plan = await response.json();
    await migrateV1();
    await loadState();
    bindGlobalEvents();
    registerServiceWorker();
    if (state.timer) ensureTimerInterval();
    render();
  } catch (error) {
    console.error(error);
    app.innerHTML = `<main class="page"><section class="card card-pad empty-state"><div class="empty-icon">!</div><h2>Protocollo non disponibile</h2><p class="muted">Ricarica la pagina. Se il problema continua, controlla che tutti i file siano stati caricati nella radice di GitHub Pages.</p></section></main>`;
  }
}

function bindGlobalEvents() {
  app.addEventListener('click', handleClick);
  app.addEventListener('input', handleInput);
  app.addEventListener('change', handleChange);
  modalRoot.addEventListener('click', handleModalClick);
  modalRoot.addEventListener('submit', handleModalSubmit);
  modalRoot.addEventListener('change', handleModalChange);
  window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.installPrompt = event; render(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.timer) ensureTimerInterval();
      if (state.screen === 'active') requestWakeLock();
    }
  });
}

function render() {
  clearInterval(state.clockInterval);
  const focus = state.screen === 'active';
  app.innerHTML = `<div class="shell ${focus ? 'focus-shell' : ''}">${renderScreen()}${!focus && !state.screen ? renderBottomNav() : ''}</div>`;
  if (focus) startLiveClock();
  updateTimerDom();
}

function renderScreen() {
  if (state.screen === 'detail') return renderWorkoutDetail();
  if (state.screen === 'active') return renderActiveWorkout();
  if (state.tab === 'plan') return renderPlan();
  if (state.tab === 'analytics') return renderAnalytics();
  if (state.tab === 'profile') return renderProfile();
  return renderHome();
}

function renderBottomNav() {
  const items = [
    ['home', ICONS.home, 'Oggi'],
    ['plan', ICONS.plan, 'Scheda'],
    ['analytics', ICONS.analytics, 'Analisi'],
    ['profile', ICONS.profile, 'Profilo']
  ];
  return `<nav class="bottom-nav" aria-label="Navigazione principale">${items.map(([id, icon, label]) => `<button class="nav-item ${state.tab === id ? 'active' : ''}" data-tab="${id}">${icon}<span>${label}</span></button>`).join('')}</nav>`;
}

function renderBrandHeader(title, subtitle) {
  return `<header class="topbar"><div class="brand"><div class="brand-mark">PF</div><div><div class="eyebrow"><span class="signal-dot"></span>Protocol Fit 2.0</div><h2 style="margin:5px 0 4px">${escapeHTML(title)}</h2><p class="muted small" style="margin:0">${escapeHTML(subtitle)}</p></div></div><button class="icon-button" data-action="open-profile" aria-label="Profilo">◎</button></header>`;
}

function renderHome() {
  const phase = phaseForWeek(state.settings.week);
  const summary = weekSummary();
  const readiness = readinessToday();
  const profile = readinessProfile(readiness);
  const completedIds = completedWorkoutIdsForWeek();
  const next = nextWorkout();
  const analytics = buildAnalytics(state.history, allWorkouts());
  const level = calculateLevel(state.history, analytics);
  const showInstall = !isStandalone() && isIOS() && !state.settings.installHintDismissed;
  const activeWorkout = state.active ? workoutById(state.active.workoutId) : null;
  const progress = workoutProgress();

  return `<main class="page">
    <header class="topbar">
      <div><div class="eyebrow"><span class="signal-dot"></span>Offline · dati sul dispositivo</div><h1 class="display-title" style="margin-top:10px">Allenati.<span>Progredisci.</span></h1><p class="muted">La tua scheda, resa più intelligente ad ogni serie.</p></div>
      <button class="icon-button" data-action="open-profile" aria-label="Profilo">◎</button>
    </header>

    ${showInstall ? `<section class="card card-pad" style="border-color:rgba(141,255,181,.2)"><div class="eyebrow live">Installa su iPhone</div><h3 style="margin:7px 0">Apri come vera web app</h3><p class="muted small">Safari → Condividi → Aggiungi alla schermata Home.</p><button class="btn btn-secondary btn-small" data-action="dismiss-install">Ho capito</button></section>` : ''}

    ${state.active ? `<section class="card resume-card"><div class="resume-row"><div><div class="eyebrow live">Workout in corso</div><h3 style="margin:6px 0 4px">${escapeHTML(activeWorkout?.title || 'Workout')}</h3><p class="muted small" style="margin:0">${progress.completed}/${progress.total} serie · salvato automaticamente</p></div><button class="btn btn-primary btn-small" data-action="resume-workout">Riprendi</button></div><div class="resume-progress"><span style="width:${progress.percent * 100}%"></span></div></section>` : ''}

    <section class="card hero glass" style="margin-top:${state.active ? '14px' : '0'}">
      <div class="hero-main"><div><div class="eyebrow">Settimana ${state.settings.week} di ${TOTAL_WEEKS}</div><h2 class="hero-title">${escapeHTML(phase.title)}</h2><p class="muted small">${escapeHTML(phaseLabelForWeek(state.settings.week))}</p></div><div class="progress-orbit" style="--progress:${(state.settings.week / TOTAL_WEEKS) * 100}%"><span><strong>${state.settings.week}</strong><small>/14</small></span></div></div>
      <div class="hero-stats"><div class="metric"><strong>${summary.sessions}/${summary.planned}</strong><span>workout</span></div><div class="metric"><strong>${summary.sets}</strong><span>serie</span></div><div class="metric"><strong>LV ${level.level}</strong><span>${formatNumber(level.xp)} XP</span></div></div>
    </section>

    <div class="section-head"><div><div class="eyebrow">Readiness</div><h2>Come stai oggi?</h2></div><button class="section-action" data-action="open-readiness">${readiness?.createdAt?.slice(0,10) === todayKey() ? 'Modifica' : 'Check-in'}</button></div>
    <button class="card readiness-card" data-action="open-readiness" style="width:100%;text-align:left">
      <div class="pulse-ring" style="--score:${profile.score}%"><span>${profile.score}</span></div>
      <div class="readiness-copy"><div class="eyebrow">Coach locale</div><h3>${escapeHTML(profile.label)}</h3><p class="muted small" style="margin:0">${readinessMessage(profile, readiness)}</p></div>
      <span class="mode-chip ${profile.mode}">${profile.mode === 'push' ? 'PUSH' : profile.mode === 'conservative' ? 'SMART' : 'BASE'}</span>
    </button>

    <div class="section-head"><div><div class="eyebrow">Protocollo attuale</div><h2>Prossime sessioni</h2></div><button class="section-action" data-tab="plan">Vedi tutto</button></div>
    <div class="workout-list">${phase.workouts.map((workout, index) => renderWorkoutCard(workout, index, completedIds, next?.id)).join('')}</div>

    <div class="section-head"><div><div class="eyebrow">Intelligence</div><h2>Il vantaggio Protocol</h2></div></div>
    <div class="insight-strip">
      <section class="card insight"><div class="insight-icon">↗</div><div class="eyebrow">Set Autopilot</div><h3>Un tap per registrare</h3><p class="muted small">Peso e ripetizioni vengono precompilati dallo storico.</p></section>
      <section class="card insight"><div class="insight-icon">◉</div><div class="eyebrow">Training Twin</div><h3>${state.history.length ? `${formatNumber(analytics.totalSets)} serie analizzate` : 'Impara da te'}</h3><p class="muted small">Trend, e1RM e risposta al volume restano sul dispositivo.</p></section>
      <section class="card insight"><div class="insight-icon">⌁</div><div class="eyebrow">Program Guardian</div><h3>La scheda resta intatta</h3><p class="muted small">Il coach adatta il carico, non stravolge il protocollo.</p></section>
    </div>
  </main>`;
}

function readinessMessage(profile, readiness) {
  if (!readiness) return '15 secondi per calibrare carico e ritmo della seduta.';
  if (profile.mode === 'push') return 'Recupero alto: mantieni il protocollo e sfrutta la progressione.';
  if (profile.mode === 'conservative') return 'Priorità alla tecnica: Autopilot riduce i carichi suggeriti del 5%.';
  return 'Condizione stabile: esegui la scheda con i target previsti.';
}

function renderWorkoutCard(workout, index, completedIds, nextId) {
  const done = completedIds.has(workout.id);
  const isNext = workout.id === nextId && !done;
  const totalSets = workout.exercises.reduce((sum, exercise) => sum + exercise.setCount, 0);
  return `<button class="workout-card ${done ? 'done' : ''} ${isNext ? 'next' : ''}" data-workout="${escapeHTML(workout.id)}">${isNext ? '<span class="status-dot"></span>' : ''}<span class="workout-index"><span>Day</span><strong>${String(workout.slot || index + 1).padStart(2, '0')}</strong></span><span class="workout-copy"><h3>${escapeHTML(workout.title)}</h3><span class="workout-meta"><span>${escapeHTML(workout.subtitle)}</span><span>•</span><span>${totalSets} serie</span><span>•</span><span>~${estimatedMinutes(workout)} min</span></span></span><span class="chevron">${done ? '✓' : '›'}</span></button>`;
}

function renderWeekStrip() {
  return `<div class="week-strip" aria-label="Seleziona settimana">${Array.from({ length: TOTAL_WEEKS }, (_, index) => index + 1).map((week) => `<button class="week-pill ${week === state.settings.week ? 'active' : ''}" data-week="${week}"><span>Sett.</span><strong>${week}</strong></button>`).join('')}</div>`;
}

function renderPlan() {
  const phase = phaseForWeek(state.settings.week);
  const completed = completedWorkoutIdsForWeek();
  const next = nextWorkout();
  return `<main class="page">
    ${renderBrandHeader('La tua scheda', '14 settimane · protocollo preimpostato')}
    ${renderWeekStrip()}
    <section class="card phase-header"><div class="phase-header-row"><div><div class="eyebrow">${escapeHTML(phaseLabelForWeek(state.settings.week))}</div><h2 style="margin:7px 0 5px">${escapeHTML(phase.title)}</h2><p class="muted small" style="margin:0">${phase.workouts.length} sessioni · nessuna modifica al programma originale</p></div><span class="phase-badge">SETT. ${state.settings.week}</span></div></section>
    <div class="workout-list">${phase.workouts.map((workout, index) => renderWorkoutCard(workout, index, completed, next?.id)).join('')}</div>
    <div class="section-head"><div><div class="eyebrow">Moduli extra</div><h2>Addome e deload</h2></div></div>
    <div class="workout-list">${state.plan.extras.map((workout, index) => renderWorkoutCard(workout, index, new Set(), null)).join('')}</div>
    <section class="card card-pad" style="margin-top:14px"><div class="eyebrow">Legenda originale</div><div class="legend">${state.plan.notationLegend.map((item) => `<div class="legend-item"><strong>${escapeHTML(item.code)}</strong><span>${escapeHTML(item.meaning)}</span></div>`).join('')}</div></section>
  </main>`;
}

function renderWorkoutDetail() {
  const workout = workoutById(state.selectedWorkoutId);
  if (!workout) { state.screen = null; return renderHome(); }
  const readiness = readinessToday();
  const profile = readinessProfile(readiness);
  const totalSets = workout.exercises.reduce((sum, exercise) => sum + exercise.setCount, 0);
  return `<main class="page">
    <header class="topbar compact"><button class="back-button" data-action="back">‹</button><div class="eyebrow">Dettaglio workout</div><button class="icon-button" data-action="open-readiness">◉</button></header>
    <section class="card detail-hero"><div class="eyebrow">${escapeHTML(workout.subtitle)}</div><h1>${escapeHTML(workout.title)}</h1><p class="muted">Sessione guidata, timer automatico e suggerimenti basati sul tuo storico.</p><div class="detail-meta"><span class="pill">${workout.exercises.length} esercizi</span><span class="pill">${totalSets} serie</span><span class="pill">~${estimatedMinutes(workout)} min</span><span class="pill">${state.settings.units}</span></div></section>
    <section class="card coach-card" style="margin-top:14px"><div class="coach-grid"><div class="coach-icon">◉</div><div><div class="eyebrow">Program Guardian</div><h3 style="margin:5px 0">${escapeHTML(profile.label)}</h3><p class="muted small" style="margin:0">${profile.mode === 'conservative' ? 'Mantengo esercizi e recuperi, ma abbasso del 5% i carichi suggeriti.' : profile.mode === 'push' ? 'Mantengo la scheda e abilito gli incrementi quando lo storico li giustifica.' : 'La scheda viene eseguita esattamente come programmata.'}</p></div></div></section>
    <div class="section-head"><div><div class="eyebrow">Sequenza</div><h2>Esercizi</h2></div></div>
    ${workout.exercises.map((exercise, index) => `<section class="card exercise-preview"><span class="exercise-number">${index + 1}</span><div><h3>${escapeHTML(exercise.name)}</h3><div class="exercise-scheme">${exercise.setCount} × ${escapeHTML(exercise.scheme)}</div>${exercise.notes ? `<div class="note-box">${escapeHTML(exercise.notes)}</div>` : ''}${exercise.circuitSteps ? `<div class="circuit-steps" style="margin-top:10px">${exercise.circuitSteps.map((step) => `<span class="circuit-step">${escapeHTML(step)}</span>`).join('')}</div>` : ''}</div><span class="muted tiny">${restLabel(exercise.restSeconds)}</span></section>`).join('')}
    <div class="sticky-cta"><button class="btn btn-primary btn-full" data-action="start-workout">${state.active?.workoutId === workout.id ? 'Riprendi workout' : 'Inizia workout'} <span>→</span></button></div>
  </main>`;
}

function createActiveWorkout(workout) {
  const readiness = readinessToday();
  const active = {
    id: uuid('active'),
    workoutId: workout.id,
    programWeek: state.settings.week,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    readiness: readiness ? structuredClone(readiness) : null,
    exercises: []
  };
  for (const exercise of workout.exercises) {
    const previousExercise = latestExerciseDraft(exercise.id);
    const labels = setLabels(exercise);
    const draft = { exerciseId: exercise.id, sets: [] };
    for (let setIndex = 0; setIndex < exercise.setCount; setIndex += 1) {
      const suggestion = suggestSet({ exercise, previousExercise, setIndex, currentExercise: draft, readiness, units: state.settings.units });
      const noteRir = String(exercise.notes || '').match(/RIR\s*(\d)/i);
      draft.sets.push({
        label: labels[setIndex],
        weight: exercise.loadMode === 'timed' ? '' : suggestion.weight,
        reps: exercise.loadMode === 'timed' ? '' : suggestion.reps,
        rir: noteRir ? Number(noteRir[1]) : 2,
        completed: false,
        completedAt: null,
        suggestion
      });
    }
    active.exercises.push(draft);
  }
  return active;
}

function activeLocation() {
  if (!state.active) return { exerciseIndex: 0, setIndex: 0 };
  for (let exerciseIndex = 0; exerciseIndex < state.active.exercises.length; exerciseIndex += 1) {
    const setIndex = state.active.exercises[exerciseIndex].sets.findIndex((set) => !set.completed);
    if (setIndex >= 0) return { exerciseIndex, setIndex };
  }
  return { exerciseIndex: state.active.exercises.length - 1, setIndex: -1 };
}

function renderActiveWorkout() {
  if (!state.active) { state.screen = null; return renderHome(); }
  const workout = workoutById(state.active.workoutId);
  if (!workout) return renderHome();
  const progress = workoutProgress();
  const current = activeLocation();
  const currentExercise = workout.exercises[current.exerciseIndex];
  const currentSet = state.active.exercises[current.exerciseIndex]?.sets[current.setIndex];
  const stats = sessionStats(state.active);
  const activeSuggestion = currentSet?.suggestion;

  return `<main class="focus-page">
    <header class="focus-header">
      <div class="focus-top"><button class="back-button" data-action="exit-active">‹</button><div class="focus-title"><div class="eyebrow live">Workout live</div><h2>${escapeHTML(workout.title)}</h2></div><button class="icon-button" data-action="toggle-wake" aria-label="Mantieni schermo acceso">☀</button></div>
      <div class="focus-stats"><div class="focus-stat"><strong id="live-clock" class="mono">00:00</strong><span>durata</span></div><div class="focus-stat"><strong>${progress.completed}/${progress.total}</strong><span>serie</span></div><div class="focus-stat"><strong>${formatNumber(stats.volume)}</strong><span>volume</span></div></div>
      <div class="progress-line"><span style="width:${progress.percent * 100}%"></span></div>
    </header>

    ${renderTimerBanner()}
    ${activeSuggestion ? `<section class="card autopilot-banner"><div class="autopilot-icon">↗</div><div><div class="eyebrow">Set Autopilot · confidenza ${escapeHTML(activeSuggestion.confidence)}</div><h3 style="margin:5px 0">${escapeHTML(currentExercise?.name || '')}</h3><p class="muted small" style="margin:0">${escapeHTML(activeSuggestion.explanation)}</p></div></section>` : ''}

    <div class="exercise-stack">${workout.exercises.map((exercise, exerciseIndex) => renderActiveExercise(exercise, exerciseIndex, current)).join('')}</div>

    <div class="workout-footer"><button class="btn btn-secondary" data-action="undo-set" ${state.lastSetAction ? '' : 'disabled'}>↶ Undo</button><button class="btn btn-primary" data-action="finish-workout">Termina e salva</button></div>
    <button class="btn btn-danger btn-full" style="margin-top:9px" data-action="discard-workout">Scarta workout</button>
  </main>`;
}

function renderActiveExercise(exercise, exerciseIndex, current) {
  const draft = state.active.exercises[exerciseIndex];
  const completed = draft.sets.filter((set) => set.completed).length;
  const finished = completed === draft.sets.length;
  const isCurrent = current.exerciseIndex === exerciseIndex;
  const collapsed = state.collapsed[exercise.id] ?? (finished && !isCurrent);
  return `<section class="card exercise-card ${isCurrent ? 'current' : ''} ${finished ? 'finished' : ''} ${collapsed ? 'collapsed' : ''}" id="exercise-${exerciseIndex}">
    <button class="exercise-head" data-action="toggle-exercise" data-exercise="${escapeHTML(exercise.id)}"><div><div class="eyebrow">${exerciseIndex + 1}/${state.active.exercises.length} · ${escapeHTML(exercise.scheme)}</div><h3>${escapeHTML(exercise.name)}</h3><div class="exercise-count">${completed}/${draft.sets.length} serie · ${restLabel(exercise.restSeconds)}</div></div><div class="exercise-status"><span class="mode-chip ${finished ? 'push' : ''}">${finished ? 'FATTO' : isCurrent ? 'ORA' : 'DOPO'}</span><span class="exercise-chevron">⌄</span></div></button>
    <div class="exercise-body">
      ${exercise.notes ? `<div class="exercise-note">${escapeHTML(exercise.notes)}</div>` : ''}
      ${exercise.circuitSteps ? `<div class="circuit-steps">${exercise.circuitSteps.map((step) => `<span class="circuit-step">${escapeHTML(step)}</span>`).join('')}</div>` : ''}
      ${draft.sets.map((set, setIndex) => exercise.loadMode === 'timed' ? renderTimedSet(exercise, exerciseIndex, set, setIndex) : renderSetRow(exercise, exerciseIndex, set, setIndex)).join('')}
      ${isCurrent && current.setIndex >= 0 && exercise.loadMode !== 'timed' ? `<div class="quick-adjust"><button data-action="adjust-set" data-ex="${exerciseIndex}" data-set="${current.setIndex}" data-field="weight" data-delta="-1">−1 ${state.settings.units}</button><button data-action="adjust-set" data-ex="${exerciseIndex}" data-set="${current.setIndex}" data-field="weight" data-delta="1">+1 ${state.settings.units}</button><button data-action="adjust-set" data-ex="${exerciseIndex}" data-set="${current.setIndex}" data-field="reps" data-delta="-1">−1 rep</button><button data-action="adjust-set" data-ex="${exerciseIndex}" data-set="${current.setIndex}" data-field="reps" data-delta="1">+1 rep</button></div>` : ''}
    </div>
  </section>`;
}

function renderSetRow(exercise, exerciseIndex, set, setIndex) {
  const isBodyweight = exercise.loadMode === 'bodyweight';
  return `<div class="set-row ${set.completed ? 'completed' : ''}">
    <span class="set-label">${escapeHTML(set.label || `S${setIndex + 1}`)}</span>
    <label class="set-input-wrap suggested"><input type="text" inputmode="decimal" value="${escapeHTML(set.weight)}" data-set-input="weight" data-ex="${exerciseIndex}" data-set="${setIndex}" aria-label="Peso serie ${setIndex + 1}"><small>${isBodyweight ? '+kg' : state.settings.units}</small></label>
    <label class="set-input-wrap"><input type="text" inputmode="numeric" value="${escapeHTML(set.reps)}" data-set-input="reps" data-ex="${exerciseIndex}" data-set="${setIndex}" aria-label="Ripetizioni serie ${setIndex + 1}"><small>rep</small></label>
    <button class="rir-button" data-action="cycle-rir" data-ex="${exerciseIndex}" data-set="${setIndex}">RIR<br>${set.rir ?? '—'}</button>
    <button class="complete-set ${set.completed ? 'done' : ''}" data-action="complete-set" data-ex="${exerciseIndex}" data-set="${setIndex}" aria-label="Completa serie">${set.completed ? '✓' : '○'}</button>
  </div>`;
}

function timedSeconds(exercise) {
  if (exercise.circuitSteps?.length) return exercise.circuitSteps.reduce((sum, step) => sum + (Number(String(step).match(/\d+/)?.[0]) || 30), 0);
  return Number(String(exercise.scheme).match(/\d+/)?.[0]) || 30;
}

function renderTimedSet(exercise, exerciseIndex, set, setIndex) {
  return `<div class="set-row timed-row ${set.completed ? 'completed' : ''}"><span class="set-label">${escapeHTML(set.label || `G${setIndex + 1}`)}</span><div class="timed-info"><div><div class="eyebrow">${exercise.circuitSteps ? 'Giro' : 'Tempo'}</div><strong>${formatDuration(timedSeconds(exercise))}</strong></div><button class="btn btn-secondary btn-small" data-action="start-work-timer" data-ex="${exerciseIndex}" data-set="${setIndex}">Avvia</button></div><button class="complete-set ${set.completed ? 'done' : ''}" data-action="complete-set" data-ex="${exerciseIndex}" data-set="${setIndex}">${set.completed ? '✓' : '○'}</button></div>`;
}

function renderTimerBanner() {
  if (!state.timer) return '';
  const remaining = timerRemaining();
  const percent = state.timer.totalSeconds ? (remaining / state.timer.totalSeconds) * 100 : 0;
  return `<section class="timer-banner" id="timer-banner"><div class="timer-main"><div class="timer-ring" style="--pct:${percent}%"><span id="timer-count">${formatDuration(remaining)}</span></div><div><div class="eyebrow ${state.timer.kind === 'work' ? '' : 'live'}">${state.timer.kind === 'work' ? 'Intervallo attivo' : 'Recupero'}</div><strong>${escapeHTML(state.timer.exerciseName || '')}</strong></div></div><div class="timer-actions"><button data-action="timer-add">+15</button><button data-action="timer-cancel">×</button></div></section>`;
}

function renderAnalytics() {
  const analytics = buildAnalytics(state.history, allWorkouts());
  const summary = weekSummary();
  const trends = analytics.exerciseTrends;
  const selectedId = state.settings.selectedTrendExercise || trends[0]?.id || null;
  const selectedTrend = trends.find((item) => item.id === selectedId) || trends[0];
  const streak = calculateTrainingStreak();
  return `<main class="page">
    ${renderBrandHeader('Analisi', 'Progressi leggibili, non rumore')}
    <section class="card hero" style="min-height:176px"><div class="hero-main"><div><div class="eyebrow">Training Twin</div><h2 class="hero-title">${state.history.length ? `${state.history.length} sessioni apprese` : 'Inizia a costruire il tuo modello'}</h2><p class="muted small">Tutti i calcoli avvengono localmente.</p></div><div class="progress-orbit" style="--progress:${Math.min(100, state.history.length * 8)}%"><span><strong>${streak}</strong><small>streak</small></span></div></div><div class="hero-stats"><div class="metric"><strong>${formatNumber(analytics.totalSets)}</strong><span>serie totali</span></div><div class="metric"><strong>${formatNumber(analytics.totalVolume)}</strong><span>${state.settings.units} volume</span></div><div class="metric"><strong>${summary.sessions}</strong><span>questa sett.</span></div></div></section>

    <div class="analytics-grid" style="margin-top:14px">
      <section class="card chart-card"><div class="chart-head"><div><div class="eyebrow">Ultime 8 settimane</div><h3>Serie registrate</h3></div><div class="big-number">${analytics.weeks.at(-1)?.sets || 0}</div></div>${renderBarChart(analytics.weeks)}</section>
      <section class="card chart-card"><div class="chart-head"><div><div class="eyebrow">Massimale stimato</div><h3>Trend e1RM</h3></div>${trends.length ? `<select class="chart-select" id="trend-exercise">${trends.slice(0, 20).map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === selectedTrend?.id ? 'selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}</select>` : ''}</div>${selectedTrend ? renderLineChart(selectedTrend.points) : renderEmptyMini('Registra peso e ripetizioni per creare il grafico.')}</section>
    </div>

    <section class="card chart-card" style="margin-top:14px"><div class="chart-head"><div><div class="eyebrow">Distribuzione</div><h3>Serie equivalenti per muscolo</h3></div></div>${renderMuscleChart(analytics.muscleSets)}</section>

    <section class="card chart-card" style="margin-top:14px"><div class="chart-head"><div><div class="eyebrow">Costanza</div><h3>Heat map · 12 settimane</h3></div><div class="big-number">${streak}</div></div>${renderHeatmap(analytics.daily)}</section>

    <section class="card chart-card" style="margin-top:14px"><div class="chart-head"><div><div class="eyebrow">Personal record</div><h3>Migliori e1RM</h3></div></div>${analytics.prs.length ? `<div class="pr-list">${analytics.prs.slice(0, 8).map((item, index) => `<div class="pr-row"><span class="pr-icon">${index < 3 ? '◆' : '↗'}</span><div><strong>${escapeHTML(item.name)}</strong><div class="muted tiny">${item.points.length} rilevazioni</div></div><span class="pr-value">${formatNumber(item.best, 1)}</span></div>`).join('')}</div>` : renderEmptyMini('I record compariranno dopo i primi workout con carichi.')}</section>

    <div class="section-head"><div><div class="eyebrow">Registro</div><h2>Storico workout</h2></div><button class="section-action" data-action="export-csv">Esporta CSV</button></div>
    ${renderHistoryList()}
  </main>`;
}

function renderBarChart(weeks) {
  const max = Math.max(1, ...weeks.map((week) => week.sets));
  return `<div class="bar-chart">${weeks.map((week) => `<div class="bar-column"><div class="bar" title="${week.sets} serie" style="height:${Math.max(3, (week.sets / max) * 100)}%"></div><span>${escapeHTML(week.label)}</span></div>`).join('')}</div>`;
}

function renderLineChart(points) {
  const data = points.slice(-12);
  if (!data.length) return renderEmptyMini('Nessun dato disponibile.');
  const values = data.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const coordinates = data.map((point, index) => {
    const x = data.length === 1 ? 50 : (index / (data.length - 1)) * 100;
    const y = 88 - ((point.value - min) / range) * 68;
    return { x, y, value: point.value };
  });
  const line = coordinates.map((point) => `${point.x},${point.y}`).join(' ');
  const area = `0,100 ${line} 100,100`;
  return `<svg class="line-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Trend e1RM"><defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6ee7ff" stop-opacity=".22"/><stop offset="1" stop-color="#6ee7ff" stop-opacity="0"/></linearGradient></defs><line class="grid" x1="0" y1="25" x2="100" y2="25"/><line class="grid" x1="0" y1="55" x2="100" y2="55"/><line class="grid" x1="0" y1="85" x2="100" y2="85"/><polygon class="area" points="${area}"/><polyline class="line" points="${line}"/>${coordinates.map((point) => `<circle cx="${point.x}" cy="${point.y}" r="2.2"><title>${formatNumber(point.value, 1)} ${state.settings.units}</title></circle>`).join('')}</svg><div class="muted tiny" style="display:flex;justify-content:space-between;margin-top:7px"><span>${formatDate(data[0].date, { day: '2-digit', month: 'short' })}</span><strong style="color:var(--cyan)">${formatNumber(data.at(-1).value, 1)} ${state.settings.units}</strong><span>${formatDate(data.at(-1).date, { day: '2-digit', month: 'short' })}</span></div>`;
}

function renderMuscleChart(muscleSets) {
  const entries = Object.entries(muscleSets).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!total) return renderEmptyMini('Completa qualche sessione per vedere la distribuzione muscolare.');
  let cursor = 0;
  const segments = entries.map(([muscle, value]) => {
    const start = cursor;
    cursor += (value / total) * 100;
    return `${MUSCLE_COLORS[muscle] || '#8dffb5'} ${start}% ${cursor}%`;
  }).join(',');
  return `<div class="muscle-grid"><div class="donut" style="--segments:conic-gradient(${segments})"><div class="donut-center"><strong>${formatNumber(total, 1)}</strong><span>serie eq.</span></div></div><div class="muscle-list">${entries.map(([muscle, value]) => `<div class="muscle-row"><span class="muscle-dot" style="background:${MUSCLE_COLORS[muscle] || '#8dffb5'}"></span><span>${escapeHTML(muscle)}</span><strong>${formatNumber(value, 1)}</strong></div>`).join('')}</div></div>`;
}

function renderHeatmap(daily) {
  const cells = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 83);
  for (let index = 0; index < 84; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = date.toISOString().slice(0, 10);
    const count = daily.get(key) || 0;
    const level = count >= 16 ? 4 : count >= 10 ? 3 : count >= 5 ? 2 : count > 0 ? 1 : 0;
    cells.push(`<span class="heat-cell ${level ? `l${level}` : ''}" title="${key}: ${count} serie"></span>`);
  }
  return `<div class="heatmap-wrap"><div class="heatmap">${cells.join('')}</div></div><div class="muted tiny" style="display:flex;justify-content:space-between;margin-top:11px"><span>12 settimane fa</span><span>Oggi</span></div>`;
}

function renderEmptyMini(message) {
  return `<div class="empty-state" style="padding:20px 8px"><div class="empty-icon">⌁</div><p class="muted small" style="margin:0">${escapeHTML(message)}</p></div>`;
}

function renderHistoryList() {
  if (!state.history.length) return `<section class="card empty-state"><div class="empty-icon">◷</div><h3>Nessun workout salvato</h3><p class="muted small">Il tuo storico verrà costruito automaticamente.</p></section>`;
  return `<div class="history-list">${state.history.map((session) => {
    const workout = workoutById(session.workoutId);
    const stats = sessionStats(session);
    return `<section class="card history-card"><div><div class="eyebrow">${formatDate(session.endedAt || session.startedAt)}</div><h3>${escapeHTML(workout?.title || 'Workout')}</h3><div class="history-stats"><span>${stats.completedSets} serie</span><span>•</span><span>${formatNumber(stats.volume)} ${state.settings.units}</span><span>•</span><span>${formatDuration(session.durationSeconds || 0)}</span></div></div><div class="history-actions"><button data-action="history-detail" data-id="${escapeHTML(session.id)}">›</button><button data-action="history-delete" data-id="${escapeHTML(session.id)}">×</button></div></section>`;
  }).join('')}</div>`;
}

function calculateTrainingStreak() {
  if (!state.history.length) return 0;
  const weeks = new Set(state.history.map((session) => weekKey(new Date(session.endedAt || session.startedAt))));
  const current = new Date();
  let streak = 0;
  for (let offset = 0; offset < 60; offset += 1) {
    const date = new Date(current);
    date.setDate(date.getDate() - offset * 7);
    if (weeks.has(weekKey(date))) streak += 1;
    else if (offset === 0) continue;
    else break;
  }
  return streak;
}

function weekKey(date) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy - start) / 86400000) + 1) / 7);
  return `${copy.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}

function renderProfile() {
  const analytics = buildAnalytics(state.history, allWorkouts());
  const level = calculateLevel(state.history, analytics);
  const badges = achievements(state.history, analytics, allWorkouts());
  const latestMeasurement = state.measurements[0];
  return `<main class="page">
    ${renderBrandHeader('Profilo', 'Dati, obiettivi e controllo totale')}
    <section class="card profile-hero"><div class="level-ring" style="--level-progress:${level.progress * 100}%"><div><strong>${level.level}</strong><small>livello</small></div></div><div><div class="eyebrow">Protocol athlete</div><h2 style="margin:6px 0">${formatNumber(level.xp)} XP</h2><p class="muted small" style="margin:0">${formatNumber(Math.max(0, level.nextXp - level.xp))} XP al prossimo livello</p><div class="level-progress"><span style="width:${level.progress * 100}%"></span></div></div></section>

    <div class="section-head"><div><div class="eyebrow">Progressi corporei</div><h2>Misure</h2></div><button class="section-action" data-action="open-measurement">+ Aggiungi</button></div>
    <section class="card card-pad">${latestMeasurement ? `<div class="hero-stats" style="margin-top:0"><div class="metric"><strong>${latestMeasurement.weight ? `${escapeHTML(latestMeasurement.weight)} ${state.settings.units}` : '—'}</strong><span>peso</span></div><div class="metric"><strong>${latestMeasurement.waist ? `${escapeHTML(latestMeasurement.waist)} cm` : '—'}</strong><span>vita</span></div><div class="metric"><strong>${latestMeasurement.arm ? `${escapeHTML(latestMeasurement.arm)} cm` : '—'}</strong><span>braccio</span></div></div><div class="measure-list" style="margin-top:13px">${state.measurements.slice(0, 5).map((item) => `<div class="measure-row"><div><strong>${formatDate(item.date)}</strong><div class="muted tiny">${escapeHTML(item.note || 'Misurazione')}</div></div><div class="measure-values">${item.weight ? `${escapeHTML(item.weight)} ${state.settings.units}` : ''}${item.chest ? `<br>Petto ${escapeHTML(item.chest)} cm` : ''}${item.waist ? `<br>Vita ${escapeHTML(item.waist)} cm` : ''}</div></div>`).join('')}</div>` : renderEmptyMini('Aggiungi peso e circonferenze per monitorare il cambiamento.')}</section>

    <div class="section-head"><div><div class="eyebrow">Gamification sana</div><h2>Badge</h2></div><span class="muted small">${badges.filter((badge) => badge.unlocked).length}/${badges.length}</span></div>
    <div class="badge-grid">${badges.map((badge) => `<section class="card badge-card ${badge.unlocked ? '' : 'locked'}"><div class="badge-icon">${badge.icon}</div><h3>${escapeHTML(badge.title)}</h3><p>${escapeHTML(badge.description)}</p></section>`).join('')}</div>

    <div class="section-head"><div><div class="eyebrow">Impostazioni</div><h2>Protocollo</h2></div></div>
    <div class="setting-list">
      <section class="card setting-card"><div class="setting-row"><div><h3>Settimana programma</h3><p class="muted small">Seleziona la settimana attiva.</p></div><select class="select" id="settings-week">${Array.from({ length: TOTAL_WEEKS }, (_, index) => index + 1).map((week) => `<option value="${week}" ${week === state.settings.week ? 'selected' : ''}>${week}/14</option>`).join('')}</select></div></section>
      <section class="card setting-card"><div class="setting-row"><div><h3>Unità di carico</h3><p class="muted small">Usata nei workout e nei grafici.</p></div><select class="select" id="settings-units"><option value="kg" ${state.settings.units === 'kg' ? 'selected' : ''}>kg</option><option value="lb" ${state.settings.units === 'lb' ? 'selected' : ''}>lb</option></select></div></section>
      <section class="card setting-card"><div class="setting-row"><div><h3>Backup completo</h3><p class="muted small">Storico, misure, check-in e impostazioni.</p></div><button class="btn btn-secondary btn-small" data-action="export-data">Esporta</button></div><div style="display:flex;gap:8px;margin-top:10px"><label class="btn btn-secondary btn-small" for="import-file" style="flex:1;cursor:pointer">Importa JSON</label><input id="import-file" type="file" accept="application/json" hidden><button class="btn btn-secondary btn-small" style="flex:1" data-action="export-csv">Esporta CSV</button></div></section>
      <section class="card setting-card"><div class="setting-row"><div><h3>Archiviazione</h3><p class="muted small">${escapeHTML(state.storage)} · nessun account e nessun cloud.</p></div><span>🔒</span></div></section>
      <section class="card setting-card"><div class="setting-row"><div><h3>Health e smartwatch</h3><p class="muted small">Una PWA pura non può accedere direttamente ad Apple Health o Health Connect.</p></div><span class="muted">—</span></div></section>
      <section class="card setting-card"><div class="setting-row"><div><h3>Versione</h3><p class="muted small">Protocol Fit PWA</p></div><strong>${APP_VERSION}</strong></div></section>
    </div>
    <button class="btn btn-danger btn-full" style="margin-top:14px" data-action="reset-data">Cancella tutti i dati</button>
  </main>`;
}

async function handleClick(event) {
  const tab = event.target.closest('[data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    state.screen = null;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    render();
    return;
  }

  const workoutButton = event.target.closest('[data-workout]');
  if (workoutButton) {
    state.selectedWorkoutId = workoutButton.dataset.workout;
    state.screen = 'detail';
    window.scrollTo(0, 0);
    render();
    return;
  }

  const weekButton = event.target.closest('[data-week]');
  if (weekButton) {
    state.settings.week = Number(weekButton.dataset.week);
    await persistSettings();
    render();
    return;
  }

  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;

  if (action === 'open-profile') { state.tab = 'profile'; state.screen = null; render(); return; }
  if (action === 'dismiss-install') { state.settings.installHintDismissed = true; await persistSettings(); render(); return; }
  if (action === 'back') { state.screen = null; render(); return; }
  if (action === 'open-readiness') { openReadinessModal(); return; }
  if (action === 'open-measurement') { openMeasurementModal(); return; }
  if (action === 'resume-workout') { state.screen = 'active'; render(); await requestWakeLock(); return; }
  if (action === 'start-workout') { await startWorkout(); return; }
  if (action === 'exit-active') { await exitActive(); return; }
  if (action === 'discard-workout') { await discardWorkout(); return; }
  if (action === 'finish-workout') { await finishWorkout(); return; }
  if (action === 'toggle-exercise') {
    const id = actionButton.dataset.exercise;
    const card = actionButton.closest('.exercise-card');
    state.collapsed[id] = card ? !card.classList.contains('collapsed') : !(state.collapsed[id] ?? false);
    render();
    return;
  }
  if (action === 'complete-set') { await completeSet(Number(actionButton.dataset.ex), Number(actionButton.dataset.set)); return; }
  if (action === 'cycle-rir') { await cycleRir(Number(actionButton.dataset.ex), Number(actionButton.dataset.set)); return; }
  if (action === 'adjust-set') { await adjustSet(actionButton); return; }
  if (action === 'start-work-timer') { startWorkTimer(Number(actionButton.dataset.ex)); return; }
  if (action === 'undo-set') { await undoLastSet(); return; }
  if (action === 'timer-add') { await addTimer(15); return; }
  if (action === 'timer-cancel') { await cancelTimer(); return; }
  if (action === 'toggle-wake') { await toggleWakeLock(); return; }
  if (action === 'history-detail') { openHistoryModal(actionButton.dataset.id); return; }
  if (action === 'history-delete') { await deleteHistory(actionButton.dataset.id); return; }
  if (action === 'export-data') { await exportData(); return; }
  if (action === 'export-csv') { exportCSV(); return; }
  if (action === 'reset-data') { await resetData(); return; }
  if (action === 'install-pwa') { await promptInstall(); return; }
}

async function handleInput(event) {
  const input = event.target.closest('[data-set-input]');
  if (!input || !state.active) return;
  const exerciseIndex = Number(input.dataset.ex);
  const setIndex = Number(input.dataset.set);
  const field = input.dataset.setInput;
  const set = state.active.exercises?.[exerciseIndex]?.sets?.[setIndex];
  if (!set || !['weight', 'reps'].includes(field)) return;
  set[field] = input.value;
  state.active.updatedAt = new Date().toISOString();
  await setValue('active', state.active);
}

async function handleChange(event) {
  if (event.target.id === 'settings-week') {
    state.settings.week = Number(event.target.value);
    await persistSettings();
    toast('Settimana aggiornata');
    render();
  }
  if (event.target.id === 'settings-units') {
    state.settings.units = event.target.value;
    await persistSettings();
    toast('Unità aggiornata');
    render();
  }
  if (event.target.id === 'trend-exercise') {
    state.settings.selectedTrendExercise = event.target.value;
    await persistSettings();
    render();
  }
  if (event.target.id === 'import-file') await importData(event.target.files?.[0]);
}

async function persistSettings() { await setValue('settings', state.settings); }
async function persistActive() { await setValue('active', state.active); }

async function startWorkout() {
  const workout = workoutById(state.selectedWorkoutId);
  if (!workout) return;
  if (state.active && state.active.workoutId !== workout.id) {
    const current = workoutById(state.active.workoutId);
    if (!confirm(`Hai già “${current?.title || 'un workout'}” in corso. Vuoi scartarlo e iniziare questo?`)) return;
    state.active = null;
    await setValue('active', null);
  }
  if (!state.active) {
    state.active = createActiveWorkout(workout);
    await persistActive();
  }
  state.screen = 'active';
  render();
  await requestWakeLock();
}

async function exitActive() {
  state.screen = null;
  await releaseWakeLock();
  render();
  toast('Workout salvato in bozza');
}

async function discardWorkout() {
  if (!confirm('Scartare definitivamente il workout in corso?')) return;
  state.active = null;
  state.lastSetAction = null;
  await setValue('active', null);
  await cancelTimer(false);
  await releaseWakeLock();
  state.screen = null;
  render();
  toast('Workout scartato');
}

async function completeSet(exerciseIndex, setIndex) {
  if (!state.active) return;
  const workout = workoutById(state.active.workoutId);
  const exercise = workout?.exercises?.[exerciseIndex];
  const set = state.active.exercises?.[exerciseIndex]?.sets?.[setIndex];
  if (!exercise || !set) return;

  state.lastSetAction = {
    exerciseIndex,
    setIndex,
    previous: structuredClone(set)
  };
  set.completed = !set.completed;
  set.completedAt = set.completed ? new Date().toISOString() : null;
  state.active.updatedAt = new Date().toISOString();
  await persistActive();
  haptic(set.completed ? 18 : 8);

  if (set.completed && state.settings.restAutoStart && exercise.restSeconds > 0) {
    await startTimer(exercise.restSeconds, exercise.name, 'rest');
  }
  render();
  if (set.completed) setTimeout(scrollToCurrentExercise, 120);
}

async function cycleRir(exerciseIndex, setIndex) {
  const set = state.active?.exercises?.[exerciseIndex]?.sets?.[setIndex];
  if (!set) return;
  const current = Number.isFinite(Number(set.rir)) ? Number(set.rir) : 2;
  set.rir = current >= 4 ? 0 : current + 1;
  state.active.updatedAt = new Date().toISOString();
  await persistActive();
  haptic(7);
  render();
}

async function adjustSet(button) {
  const exerciseIndex = Number(button.dataset.ex);
  const setIndex = Number(button.dataset.set);
  const field = button.dataset.field;
  const delta = Number(button.dataset.delta);
  const set = state.active?.exercises?.[exerciseIndex]?.sets?.[setIndex];
  if (!set) return;
  const current = numberValue(set[field]);
  const updated = Math.max(0, current + delta);
  set[field] = String(updated).replace('.', ',');
  state.active.updatedAt = new Date().toISOString();
  await persistActive();
  haptic(6);
  render();
}

function startWorkTimer(exerciseIndex) {
  const workout = workoutById(state.active?.workoutId);
  const exercise = workout?.exercises?.[exerciseIndex];
  if (!exercise) return;
  startTimer(timedSeconds(exercise), exercise.name, 'work');
}

async function undoLastSet() {
  if (!state.lastSetAction || !state.active) return;
  const { exerciseIndex, setIndex, previous } = state.lastSetAction;
  const set = state.active.exercises?.[exerciseIndex]?.sets?.[setIndex];
  if (!set) return;
  state.active.exercises[exerciseIndex].sets[setIndex] = previous;
  state.lastSetAction = null;
  await persistActive();
  await cancelTimer(false);
  render();
  toast('Ultima azione annullata');
}

async function finishWorkout() {
  if (!state.active) return;
  const stats = sessionStats(state.active);
  if (!stats.completedSets) { toast('Completa almeno una serie'); return; }
  if (!confirm('Terminare e salvare il workout?')) return;
  const endedAt = new Date();
  const session = {
    ...state.active,
    id: uuid('session'),
    endedAt: endedAt.toISOString(),
    durationSeconds: Math.max(1, Math.floor((endedAt - new Date(state.active.startedAt)) / 1000))
  };
  await put('history', session);
  state.history.unshift(session);
  for (const exercise of session.exercises) {
    const last = [...exercise.sets].reverse().find((set) => set.completed && String(set.weight).trim());
    if (last) state.lastWeights[exercise.exerciseId] = last.weight;
  }
  await setValue('lastWeights', state.lastWeights);
  state.active = null;
  state.lastSetAction = null;
  await setValue('active', null);
  await cancelTimer(false);
  await releaseWakeLock();
  state.screen = null;
  state.tab = 'analytics';
  render();
  haptic([80, 45, 130]);
  toast('Workout salvato · +XP');
}

function scrollToCurrentExercise() {
  const current = activeLocation();
  document.getElementById(`exercise-${current.exerciseIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function timerRemaining() {
  if (!state.timer) return 0;
  return Math.max(0, Math.ceil((Number(state.timer.endAt) - Date.now()) / 1000));
}

async function startTimer(seconds, exerciseName, kind = 'rest') {
  state.timer = {
    totalSeconds: seconds,
    endAt: Date.now() + seconds * 1000,
    exerciseName,
    kind,
    notified: false
  };
  await setValue('timer', state.timer);
  ensureTimerInterval();
  render();
}

async function addTimer(seconds) {
  if (!state.timer) return;
  state.timer.endAt += seconds * 1000;
  state.timer.totalSeconds += seconds;
  await setValue('timer', state.timer);
  updateTimerDom();
}

async function cancelTimer(shouldRender = true) {
  state.timer = null;
  clearInterval(state.timerInterval);
  state.timerInterval = null;
  await setValue('timer', null);
  if (shouldRender) render();
}

function ensureTimerInterval() {
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(async () => {
    if (!state.timer) return;
    const remaining = timerRemaining();
    updateTimerDom();
    if (remaining <= 0 && !state.timer.notified) {
      state.timer.notified = true;
      await setValue('timer', state.timer);
      notifyTimerDone(state.timer.kind);
      setTimeout(() => cancelTimer(), 700);
    }
  }, 250);
}

function updateTimerDom() {
  if (!state.timer) return;
  const remaining = timerRemaining();
  const count = document.getElementById('timer-count');
  if (count) count.textContent = formatDuration(remaining);
  const ring = document.querySelector('.timer-ring');
  if (ring) ring.style.setProperty('--pct', `${state.timer.totalSeconds ? (remaining / state.timer.totalSeconds) * 100 : 0}%`);
}

function notifyTimerDone(kind) {
  haptic([180, 80, 180]);
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.frequency.value = kind === 'work' ? 720 : 880;
      gain.gain.setValueAtTime(.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(.2, context.currentTime + .02);
      gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .36);
      oscillator.start();
      oscillator.stop(context.currentTime + .4);
    }
  } catch { /* audio non essenziale */ }
  toast(kind === 'work' ? 'Intervallo terminato' : 'Recupero terminato');
}

function startLiveClock() {
  const update = () => {
    const element = document.getElementById('live-clock');
    if (!element || !state.active) return;
    element.textContent = formatDuration((Date.now() - new Date(state.active.startedAt).getTime()) / 1000);
  };
  update();
  state.clockInterval = setInterval(update, 1000);
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* non supportato */ }
}

async function releaseWakeLock() {
  try { if (state.wakeLock) await state.wakeLock.release(); } catch { /* non essenziale */ }
  state.wakeLock = null;
}

async function toggleWakeLock() {
  if (state.wakeLock) {
    await releaseWakeLock();
    toast('Blocco schermo automatico');
  } else {
    await requestWakeLock();
    toast(state.wakeLock ? 'Schermo mantenuto acceso' : 'Funzione non disponibile');
  }
}

function openReadinessModal() {
  const current = readinessToday();
  state.modalDraft = {
    type: 'readiness',
    sleep: current?.sleep || 3,
    energy: current?.energy || 3,
    soreness: current?.soreness || 3,
    stress: current?.stress || 3,
    time: current?.time || 60,
    note: current?.note || ''
  };
  renderReadinessModal();
}

function renderReadinessModal() {
  const draft = state.modalDraft;
  const fields = [
    ['sleep', 'Sonno', '1 scarso · 5 ottimo'],
    ['energy', 'Energia', '1 bassa · 5 alta'],
    ['soreness', 'Indolenzimento', '1 assente · 5 alto'],
    ['stress', 'Stress', '1 basso · 5 alto']
  ];
  const preview = readinessProfile(draft);
  modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-close><section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><div><div class="eyebrow">Check-in · 15 secondi</div><h2 style="margin:6px 0">Readiness</h2><p class="muted small">Calibra i suggerimenti senza cambiare la scheda.</p></div><button class="modal-close" data-modal-close>×</button></div><section class="card readiness-card" style="margin-bottom:15px"><div class="pulse-ring" style="--score:${preview.score}%"><span>${preview.score}</span></div><div class="readiness-copy"><div class="eyebrow">Esito live</div><h3>${escapeHTML(preview.label)}</h3><p class="muted tiny" style="margin:0">${preview.mode === 'conservative' ? 'Autopilot ridurrà del 5% i carichi.' : 'La scheda resta invariata.'}</p></div><span class="mode-chip ${preview.mode}">${preview.mode.toUpperCase()}</span></section><form id="readiness-form">${fields.map(([field, label, hint]) => `<div class="question"><div class="question-head"><strong>${label}</strong><span class="muted tiny">${hint}</span></div><div class="segmented">${[1,2,3,4,5].map((value) => `<button type="button" class="${Number(draft[field]) === value ? 'active' : ''}" data-readiness-field="${field}" data-value="${value}">${value}</button>`).join('')}</div></div>`).join('')}<div class="question"><div class="question-head"><strong>Tempo disponibile</strong><span class="muted tiny">minuti</span></div><div class="segmented time-options">${[30,45,60,90].map((value) => `<button type="button" class="${Number(draft.time) === value ? 'active' : ''}" data-readiness-field="time" data-value="${value}">${value}</button>`).join('')}</div></div><div class="field" style="margin-top:18px"><label>Nota opzionale</label><textarea name="note" placeholder="Dolore, attrezzatura, sensazioni…">${escapeHTML(draft.note)}</textarea></div><button class="btn btn-primary btn-full" style="margin-top:18px" type="submit">Salva check-in</button></form></section></div>`;
}

function openMeasurementModal() {
  state.modalDraft = { type: 'measurement' };
  modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-close><section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><div><div class="eyebrow">Progressi corporei</div><h2 style="margin:6px 0">Nuova misurazione</h2><p class="muted small">Compila solo i campi che ti interessano.</p></div><button class="modal-close" data-modal-close>×</button></div><form id="measurement-form"><div class="form-grid"><div class="field"><label>Peso (${state.settings.units})</label><input name="weight" inputmode="decimal" placeholder="80,0"></div><div class="field"><label>Vita (cm)</label><input name="waist" inputmode="decimal" placeholder="82"></div><div class="field"><label>Petto (cm)</label><input name="chest" inputmode="decimal" placeholder="105"></div><div class="field"><label>Braccio (cm)</label><input name="arm" inputmode="decimal" placeholder="39"></div><div class="field"><label>Coscia (cm)</label><input name="thigh" inputmode="decimal" placeholder="60"></div><div class="field"><label>Data</label><input name="date" type="date" value="${todayKey()}"></div></div><div class="field" style="margin-top:12px"><label>Nota</label><textarea name="note" placeholder="Condizione, foto, fase…"></textarea></div><button class="btn btn-primary btn-full" style="margin-top:18px" type="submit">Salva misurazione</button></form></section></div>`;
}

function openHistoryModal(id) {
  const session = state.history.find((item) => item.id === id);
  if (!session) return;
  const workout = workoutById(session.workoutId);
  const stats = sessionStats(session);
  modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-close><section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><div><div class="eyebrow">${formatDate(session.endedAt || session.startedAt)}</div><h2 style="margin:6px 0">${escapeHTML(workout?.title || 'Workout')}</h2><p class="muted small">${stats.completedSets} serie · ${formatNumber(stats.volume)} ${state.settings.units} · ${formatDuration(session.durationSeconds || 0)}</p></div><button class="modal-close" data-modal-close>×</button></div>${(session.exercises || []).map((draft, index) => {
    const exercise = workout?.exercises?.find((item) => item.id === draft.exerciseId) || workout?.exercises?.[index];
    const sets = (draft.sets || []).filter((set) => set.completed);
    if (!sets.length) return '';
    return `<div class="modal-set"><strong>${escapeHTML(exercise?.name || 'Esercizio')}</strong><div class="muted small" style="margin-top:6px">${sets.map((set) => exercise?.loadMode === 'timed' ? 'Completato' : `${escapeHTML(set.weight || '0')} ${state.settings.units} × ${escapeHTML(set.reps || '—')} · RIR ${escapeHTML(set.rir ?? '—')}`).join('<br>')}</div></div>`;
  }).join('')}</section></div>`;
}

function handleModalClick(event) {
  const close = event.target.closest('[data-modal-close]');
  if (close && (event.target === close || close.classList.contains('modal-close'))) {
    modalRoot.innerHTML = '';
    state.modalDraft = null;
    return;
  }
  const segment = event.target.closest('[data-readiness-field]');
  if (segment && state.modalDraft?.type === 'readiness') {
    state.modalDraft[segment.dataset.readinessField] = Number(segment.dataset.value);
    renderReadinessModal();
  }
}

async function handleModalSubmit(event) {
  event.preventDefault();
  if (event.target.id === 'readiness-form') {
    const form = new FormData(event.target);
    const entry = {
      id: `readiness-${todayKey()}`,
      sleep: Number(state.modalDraft.sleep),
      energy: Number(state.modalDraft.energy),
      soreness: Number(state.modalDraft.soreness),
      stress: Number(state.modalDraft.stress),
      time: Number(state.modalDraft.time),
      note: String(form.get('note') || ''),
      createdAt: new Date().toISOString()
    };
    await put('readiness', entry);
    state.readiness = [entry, ...state.readiness.filter((item) => item.id !== entry.id)];
    modalRoot.innerHTML = '';
    state.modalDraft = null;
    render();
    haptic(16);
    toast('Check-in salvato');
  }
  if (event.target.id === 'measurement-form') {
    const form = new FormData(event.target);
    const date = String(form.get('date') || todayKey());
    const entry = {
      id: uuid('measurement'),
      date: new Date(`${date}T12:00:00`).toISOString(),
      weight: String(form.get('weight') || '').replace(',', '.'),
      waist: String(form.get('waist') || '').replace(',', '.'),
      chest: String(form.get('chest') || '').replace(',', '.'),
      arm: String(form.get('arm') || '').replace(',', '.'),
      thigh: String(form.get('thigh') || '').replace(',', '.'),
      note: String(form.get('note') || '')
    };
    if (![entry.weight, entry.waist, entry.chest, entry.arm, entry.thigh].some(Boolean)) {
      toast('Inserisci almeno una misura');
      return;
    }
    await put('measurements', entry);
    state.measurements.unshift(entry);
    state.measurements.sort((a, b) => new Date(b.date) - new Date(a.date));
    modalRoot.innerHTML = '';
    state.modalDraft = null;
    render();
    toast('Misurazione salvata');
  }
}

function handleModalChange() { /* riservato a estensioni future */ }

async function deleteHistory(id) {
  if (!confirm('Eliminare questo workout dallo storico?')) return;
  await remove('history', id);
  state.history = state.history.filter((session) => session.id !== id);
  render();
  toast('Workout eliminato');
}

async function exportData() {
  const payload = {
    app: 'Protocol Fit',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    active: state.active,
    timer: state.timer,
    history: state.history,
    readiness: state.readiness,
    measurements: state.measurements,
    lastWeights: state.lastWeights
  };
  downloadBlob(JSON.stringify(payload, null, 2), `protocol-fit-v2-backup-${todayKey()}.json`, 'application/json');
  toast('Backup creato');
}

async function importData(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== 'Protocol Fit' || !Array.isArray(payload.history)) throw new Error('Formato non valido');
    if (!confirm('Sostituire tutti i dati attuali con questo backup?')) return;
    await Promise.all(['history', 'readiness', 'measurements'].map(clear));
    await putMany('history', payload.history.map((session) => normalizeSession(session, false)));
    await putMany('readiness', payload.readiness || []);
    await putMany('measurements', payload.measurements || []);
    await setValue('settings', { ...DEFAULT_SETTINGS, ...(payload.settings || {}) });
    await setValue('active', payload.active ? normalizeSession(payload.active, true) : null);
    await setValue('timer', payload.timer || null);
    await setValue('lastWeights', payload.lastWeights || {});
    await loadState();
    render();
    toast('Backup ripristinato');
  } catch (error) {
    console.error(error);
    alert('Il file non è un backup valido di Protocol Fit.');
  } finally {
    const input = document.getElementById('import-file');
    if (input) input.value = '';
  }
}

function exportCSV() {
  const rows = [['data', 'settimana_programma', 'workout', 'esercizio', 'serie', 'peso', 'ripetizioni', 'rir', 'e1rm']];
  for (const session of [...state.history].reverse()) {
    const workout = workoutById(session.workoutId);
    for (const draft of session.exercises || []) {
      const exercise = workout?.exercises?.find((item) => item.id === draft.exerciseId);
      (draft.sets || []).forEach((set, index) => {
        if (!set.completed) return;
        rows.push([
          String(session.endedAt || session.startedAt).slice(0, 10),
          session.programWeek,
          workout?.title || session.workoutId,
          exercise?.name || draft.exerciseId,
          index + 1,
          set.weight || '',
          set.reps || '',
          set.rir ?? '',
          e1rm(set.weight, set.reps).toFixed(2)
        ]);
      });
    }
  }
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  downloadBlob(csv, `protocol-fit-storico-${todayKey()}.csv`, 'text/csv;charset=utf-8');
  toast('CSV creato');
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 300);
}

async function resetData() {
  if (!confirm('Cancellare definitivamente workout, storico, misure e check-in?')) return;
  if (!confirm('Ultima conferma: questa operazione non può essere annullata.')) return;
  await clearEverything();
  ['protocolfit.settings.v1','protocolfit.active.v1','protocolfit.history.v1','protocolfit.lastWeights.v1','protocolfit.timer.v1'].forEach((key) => localStorage.removeItem(key));
  await setValue('migration.v1.complete', true);
  await setValue('settings', { ...DEFAULT_SETTINGS });
  state.settings = { ...DEFAULT_SETTINGS };
  state.active = null;
  state.timer = null;
  state.history = [];
  state.readiness = [];
  state.measurements = [];
  state.lastWeights = {};
  clearInterval(state.timerInterval);
  render();
  toast('Dati cancellati');
}

async function promptInstall() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  render();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  navigator.serviceWorker.register('./service-worker.js').then((registration) => {
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) toast('Aggiornamento pronto: riapri l’app');
      });
    });
  }).catch((error) => console.warn('Service worker non registrato', error));
}

init();
