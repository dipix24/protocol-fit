(() => {
  'use strict';

  const APP_VERSION = '1.0.0';
  const TOTAL_WEEKS = 14;
  const KEYS = {
    settings: 'protocolfit.settings.v1',
    active: 'protocolfit.active.v1',
    history: 'protocolfit.history.v1',
    lastWeights: 'protocolfit.lastWeights.v1',
    installHint: 'protocolfit.installHint.v1',
    timer: 'protocolfit.timer.v1'
  };

  const state = {
    plan: null,
    tab: 'home',
    screen: null,
    selectedWorkoutId: null,
    settings: loadJSON(KEYS.settings, { week: 1, units: 'kg' }),
    active: loadJSON(KEYS.active, null),
    history: loadJSON(KEYS.history, []),
    lastWeights: loadJSON(KEYS.lastWeights, {}),
    collapsedExercises: {},
    timer: loadJSON(KEYS.timer, null),
    timerInterval: null,
    clockInterval: null,
    wakeLock: null,
    deferredInstallPrompt: null
  };

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const modalRoot = document.getElementById('modal-root');

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { toast('Spazio di salvataggio non disponibile'); }
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

  function formatDuration(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function formatDate(iso) {
    return new Intl.DateTimeFormat('it-IT', { day:'2-digit', month:'short', year:'numeric' }).format(new Date(iso));
  }

  function formatNumber(value, digits = 0) {
    return new Intl.NumberFormat('it-IT', { maximumFractionDigits: digits }).format(value || 0);
  }

  function suggestedReps(scheme) {
    const match = String(scheme).match(/\d+/);
    return match ? match[0] : '';
  }

  function restLabel(seconds) {
    if (!seconds) return 'Nessun recupero';
    if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds} sec`;
  }

  function estimatedMinutes(workout) {
    const seconds = workout.exercises.reduce((sum, ex) => sum + ex.setCount * Math.max(ex.restSeconds, 30) + ex.setCount * 35, 0);
    return Math.max(20, Math.floor(seconds / 60));
  }

  function allWorkouts() {
    if (!state.plan) return [];
    return [
      ...state.plan.phase1.workouts,
      ...state.plan.phase2A.workouts,
      ...state.plan.phase2B.workouts,
      ...state.plan.extras
    ];
  }

  function workoutById(id) { return allWorkouts().find(w => w.id === id); }

  function phaseForWeek(week) {
    if (week <= 6) return state.plan.phase1;
    return (week - 6) % 2 === 0 ? state.plan.phase2B : state.plan.phase2A;
  }

  function phaseLabelForWeek(week) {
    if (week <= 6) return `Fase 01 · settimana ${week}/6`;
    const local = week - 6;
    const variant = local % 2 === 0 ? 'Scheda B' : 'Scheda A';
    return `Fase 02 · ${variant} · settimana ${local}/8`;
  }

  function currentPhaseWorkouts() { return phaseForWeek(state.settings.week).workouts; }

  function sessionCompletedSets(session) {
    return session.exercises.flatMap(e => e.sets).filter(s => s.completed).length;
  }

  function sessionVolume(session) {
    return session.exercises.reduce((total, ex) => total + ex.sets.reduce((sum, set) => {
      if (!set.completed) return sum;
      const w = Number(String(set.weight).replace(',', '.')) || 0;
      const r = Number(String(set.reps).replace(',', '.')) || 0;
      return sum + (w * r);
    }, 0), 0);
  }

  function completedThisWeek() {
    return state.history.filter(h => h.programWeek === state.settings.week).length;
  }

  function volumeThisWeek() {
    return state.history.filter(h => h.programWeek === state.settings.week).reduce((sum,h) => sum + sessionVolume(h), 0);
  }

  function totalCompletedSets() {
    return state.history.reduce((sum,h) => sum + sessionCompletedSets(h), 0);
  }

  function persistSettings() { saveJSON(KEYS.settings, state.settings); }
  function persistActive() { saveJSON(KEYS.active, state.active); }
  function persistHistory() { saveJSON(KEYS.history, state.history); }
  function persistLastWeights() { saveJSON(KEYS.lastWeights, state.lastWeights); }
  function persistTimer() { saveJSON(KEYS.timer, state.timer); }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastEl._timeout);
    toastEl._timeout = setTimeout(() => toastEl.classList.remove('show'), 2400);
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

  function render() {
    clearInterval(state.clockInterval);
    const isActiveScreen = state.screen === 'active';
    app.innerHTML = `
      <div class="shell">
        ${renderCurrentScreen()}
        ${!isActiveScreen && !state.screen ? renderBottomNav() : ''}
      </div>`;
    bindEvents();
    if (isActiveScreen) startLiveClock();
    updateTimerBanner();
  }

  function renderCurrentScreen() {
    if (state.screen === 'detail') return renderWorkoutDetail();
    if (state.screen === 'active') return renderActiveWorkout();
    if (state.tab === 'plan') return renderPlan();
    if (state.tab === 'history') return renderHistory();
    if (state.tab === 'settings') return renderSettings();
    return renderHome();
  }

  function renderBottomNav() {
    const items = [
      ['home','⌂','Oggi'],
      ['plan','▦','Scheda'],
      ['history','◷','Storico'],
      ['settings','⚙','Impostazioni']
    ];
    return `<nav class="bottom-nav" aria-label="Navigazione principale">
      ${items.map(([id,icon,label]) => `<button class="nav-item ${state.tab === id ? 'active' : ''}" data-tab="${id}"><b>${icon}</b>${label}</button>`).join('')}
    </nav>`;
  }

  function renderWeekStrip() {
    return `<div class="week-strip" aria-label="Seleziona settimana">
      ${Array.from({length:TOTAL_WEEKS},(_,i)=>i+1).map(week => `
        <button class="week-pill ${week === state.settings.week ? 'active' : ''}" data-week="${week}">
          <span>Sett.</span><strong>${week}</strong>
        </button>`).join('')}
    </div>`;
  }

  function renderHome() {
    const phase = phaseForWeek(state.settings.week);
    const workouts = phase.workouts;
    const activeWorkout = state.active ? workoutById(state.active.workoutId) : null;
    const showInstall = !isStandalone() && isIOS() && !loadJSON(KEYS.installHint, false);

    return `<main class="page">
      <header class="topbar">
        <div>
          <div class="eyebrow">Protocol Fit</div>
          <h1>Allenati.</h1>
          <p class="muted">La tua scheda, senza distrazioni.</p>
        </div>
        <button class="icon-button" data-action="open-settings" aria-label="Impostazioni">⚙</button>
      </header>

      ${showInstall ? `
        <section class="card card-pad install-card">
          <div class="eyebrow">Installa su iPhone</div>
          <h3 style="margin-top:6px">Aggiungila alla schermata Home</h3>
          <p class="muted small">In Safari: Condividi → Aggiungi alla schermata Home.</p>
          <button class="btn btn-secondary btn-small" data-action="hide-install">Ho capito</button>
        </section>` : ''}

      <section class="card hero glass">
        <div class="hero-row">
          <div>
            <div class="eyebrow">Settimana ${state.settings.week}</div>
            <h2 class="hero-title">${escapeHTML(phase.title)}</h2>
            <p class="muted">${escapeHTML(phaseLabelForWeek(state.settings.week))}</p>
          </div>
          <div class="hero-badge">${state.settings.week}/14</div>
        </div>
        <div class="stats-grid">
          <div class="stat"><strong>${completedThisWeek()}</strong><span>Workout</span></div>
          <div class="stat"><strong>${formatNumber(volumeThisWeek())}</strong><span>Volume ${escapeHTML(state.settings.units)}</span></div>
          <div class="stat"><strong>${totalCompletedSets()}</strong><span>Serie totali</span></div>
        </div>
        ${renderWeekStrip()}
      </section>

      ${activeWorkout ? renderResumeCard(activeWorkout) : ''}

      <div class="section-head"><h2>Workout della settimana</h2><button data-tab="plan">Tutta la scheda</button></div>
      <section class="workout-list two-col">
        ${workouts.map((w,i) => renderWorkoutCard(w,i)).join('')}
      </section>

      <div class="section-head"><h2>Extra</h2></div>
      <section class="workout-list two-col">
        ${state.plan.extras.map((w,i) => renderWorkoutCard(w,i)).join('')}
      </section>
    </main>`;
  }

  function renderResumeCard(workout) {
    const done = state.active.exercises.flatMap(e=>e.sets).filter(s=>s.completed).length;
    const total = state.active.exercises.flatMap(e=>e.sets).length;
    return `<section class="resume-card">
      <div class="row">
        <div>
          <div class="eyebrow" style="color:var(--green)">Workout in corso</div>
          <h3>${escapeHTML(workout.title)} · ${escapeHTML(workout.subtitle)}</h3>
          <p>${done}/${total} serie · iniziato ${formatDate(state.active.startedAt)}</p>
        </div>
        <button class="btn btn-primary btn-small" data-action="resume">Riprendi</button>
      </div>
    </section>`;
  }

  function renderWorkoutCard(workout, index) {
    return `<button class="workout-card" data-workout="${escapeHTML(workout.id)}">
      <span class="workout-index">${String(index+1).padStart(2,'0')}</span>
      <span class="workout-main">
        <h3>${escapeHTML(workout.title)}</h3>
        <p>${escapeHTML(workout.subtitle)}</p>
      </span>
      <span class="workout-meta"><strong>${workout.exercises.length} esercizi</strong>${estimatedMinutes(workout)} min</span>
    </button>`;
  }

  function renderPlan() {
    const phases = [state.plan.phase1, state.plan.phase2A, state.plan.phase2B];
    return `<main class="page">
      <header class="topbar">
        <div><div class="eyebrow">Programma completo</div><h1>Scheda.</h1><p class="muted">14 settimane già organizzate.</p></div>
      </header>
      <section class="card card-pad" style="margin-bottom:16px">
        <div class="eyebrow">Settimana attiva</div>
        <h3 style="margin:6px 0 12px">${escapeHTML(phaseLabelForWeek(state.settings.week))}</h3>
        ${renderWeekStrip()}
      </section>
      ${phases.map(phase => `
        <section class="card phase-card">
          <div class="phase-head">
            <div><div class="phase-tag">${phase.durationWeeks} settimane</div><h2 style="margin:4px 0 0">${escapeHTML(phase.title)}</h2></div>
            <span class="muted small">${phase.workouts.length} workout</span>
          </div>
          <div class="phase-body workout-list">
            ${phase.workouts.map((w,i)=>renderWorkoutCard(w,i)).join('')}
          </div>
        </section>`).join('')}
      <section class="card phase-card">
        <div class="phase-head"><div><div class="phase-tag">Extra</div><h2 style="margin:4px 0 0">Addominali e deload</h2></div></div>
        <div class="phase-body workout-list">${state.plan.extras.map((w,i)=>renderWorkoutCard(w,i)).join('')}</div>
      </section>
    </main>`;
  }

  function renderWorkoutDetail() {
    const workout = workoutById(state.selectedWorkoutId);
    if (!workout) { state.screen = null; return renderHome(); }
    const totalSets = workout.exercises.reduce((sum,e)=>sum+e.setCount,0);
    return `<main class="page">
      <header class="topbar">
        <button class="back-button" data-action="back" aria-label="Indietro">←</button>
        <div class="eyebrow">Dettaglio workout</div>
        <span style="width:44px"></span>
      </header>
      <section class="card hero detail-hero">
        <div class="eyebrow">${escapeHTML(workout.title)}</div>
        <h1 class="hero-title">${escapeHTML(workout.subtitle)}</h1>
        ${workout.variant ? `<p class="muted">${escapeHTML(workout.variant)}</p>` : ''}
        <div class="detail-metrics">
          <div class="metric"><strong>${workout.exercises.length}</strong><span>Esercizi</span></div>
          <div class="metric"><strong>${totalSets}</strong><span>Serie</span></div>
          <div class="metric"><strong>~${estimatedMinutes(workout)} min</strong><span>Durata</span></div>
        </div>
      </section>
      <section>
        ${workout.exercises.map((ex,i)=>renderExercisePreview(ex,i)).join('')}
      </section>
      <div class="sticky-action">
        <button class="btn btn-primary btn-full" data-action="start-workout">▶ Inizia workout</button>
      </div>
    </main>`;
  }

  function renderExercisePreview(ex, index) {
    return `<article class="exercise-preview">
      <div class="exercise-title-row">
        <span class="exercise-num">${String(index+1).padStart(2,'0')}</span>
        <div><h3>${escapeHTML(ex.name)}</h3><div class="muted small">${ex.setCount} serie · ${escapeHTML(ex.scheme)}</div></div>
        <span class="rest-chip">⏱ ${escapeHTML(restLabel(ex.restSeconds))}</span>
      </div>
      ${ex.notes ? `<p class="exercise-note">${escapeHTML(ex.notes)}</p>` : ''}
    </article>`;
  }

  function createActiveWorkout(workout) {
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      workoutId: workout.id,
      programWeek: state.settings.week,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      exercises: workout.exercises.map(ex => ({
        exerciseId: ex.id,
        sets: Array.from({length:ex.setCount},(_,i)=>({
          index:i+1,
          weight: state.lastWeights[ex.id] ?? '',
          reps: suggestedReps(ex.scheme),
          completed:false
        }))
      }))
    };
  }

  function renderActiveWorkout() {
    const workout = state.active ? workoutById(state.active.workoutId) : null;
    if (!workout || !state.active) { state.screen = null; return renderHome(); }
    const allSets = state.active.exercises.flatMap(e=>e.sets);
    const completed = allSets.filter(s=>s.completed).length;
    const progress = allSets.length ? (completed/allSets.length)*100 : 0;
    return `${state.timer ? renderTimerBanner() : ''}
      <main class="page ${state.timer ? 'with-timer' : ''}">
        <header class="topbar">
          <button class="back-button" data-action="exit-active" aria-label="Esci">×</button>
          <div class="eyebrow">Workout live</div>
          <button class="icon-button" data-action="toggle-wake" aria-label="Mantieni schermo acceso">☀</button>
        </header>
        <section class="card card-pad live-header">
          <div class="live-title">
            <div><div class="eyebrow">${escapeHTML(workout.title)}</div><h2 style="margin:5px 0 3px">${escapeHTML(workout.subtitle)}</h2><p class="muted small">Settimana ${state.active.programWeek} · ${completed}/${allSets.length} serie</p></div>
            <div class="live-clock mono" id="live-clock">00:00</div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
        </section>
        <section>
          ${workout.exercises.map((ex,i)=>renderLiveExercise(ex,i)).join('')}
        </section>
        <button class="btn btn-primary btn-full" data-action="finish-workout">✓ Termina e salva</button>
        <button class="btn btn-danger btn-full" style="margin-top:10px" data-action="discard-workout">Scarta workout</button>
      </main>`;
  }

  function renderTimerBanner() {
    const remaining = timerRemaining();
    const pct = state.timer.totalSeconds > 0 ? clamp((remaining/state.timer.totalSeconds)*100,0,100) : 0;
    return `<aside class="timer-banner" id="timer-banner">
      <div class="timer-ring" style="--timer-progress:${pct}%"><span>⏱</span></div>
      <div class="timer-copy"><small>RECUPERO</small><strong id="timer-count">${formatDuration(remaining)}</strong></div>
      <button class="timer-btn" data-action="timer-add">+15</button>
      <button class="timer-btn timer-skip" data-action="timer-cancel">×</button>
    </aside>`;
  }

  function renderLiveExercise(ex, exIndex) {
    const draft = state.active.exercises[exIndex];
    const collapsed = !!state.collapsedExercises[ex.id];
    const previous = state.lastWeights[ex.id];
    return `<article class="exercise-live">
      <div class="live-ex-head" data-action="toggle-exercise" data-exercise="${escapeHTML(ex.id)}">
        <span class="exercise-num">${String(exIndex+1).padStart(2,'0')}</span>
        <div><h3>${escapeHTML(ex.name)}</h3><div class="muted small">${ex.setCount} serie · ${escapeHTML(ex.scheme)} · <span style="color:var(--green)">${escapeHTML(restLabel(ex.restSeconds))}</span></div></div>
        <span class="collapse-icon">${collapsed ? '⌄' : '⌃'}</span>
      </div>
      ${collapsed ? '' : `<div class="live-ex-body">
        ${ex.notes ? `<p class="note-live">${escapeHTML(ex.notes)}</p>` : ''}
        <div class="set-head"><span>Set</span><span>Peso ${escapeHTML(state.settings.units)}</span><span>Reps</span><span>OK</span></div>
        ${draft.sets.map((set,setIndex)=>`
          <div class="set-row">
            <span class="set-number">${set.index}</span>
            <input class="field" inputmode="decimal" type="text" autocomplete="off" aria-label="Peso serie ${set.index}" value="${escapeHTML(set.weight)}" data-input="weight" data-ex="${exIndex}" data-set="${setIndex}">
            <input class="field" inputmode="numeric" type="text" autocomplete="off" aria-label="Ripetizioni serie ${set.index}" value="${escapeHTML(set.reps)}" data-input="reps" data-ex="${exIndex}" data-set="${setIndex}">
            <button class="check-set ${set.completed ? 'done' : ''}" data-action="complete-set" data-ex="${exIndex}" data-set="${setIndex}" aria-label="Completa serie ${set.index}">${set.completed ? '✓' : '○'}</button>
          </div>`).join('')}
        ${previous !== undefined && previous !== '' ? `<div class="previous">Ultimo carico registrato: <strong>${escapeHTML(previous)} ${escapeHTML(state.settings.units)}</strong></div>` : ''}
      </div>`}
    </article>`;
  }

  function renderHistory() {
    const sorted = [...state.history].sort((a,b)=>new Date(b.endedAt)-new Date(a.endedAt));
    return `<main class="page">
      <header class="topbar"><div><div class="eyebrow">Progressi</div><h1>Storico.</h1><p class="muted">Ogni workout salvato sul dispositivo.</p></div></header>
      ${sorted.length ? sorted.map(session => renderHistoryItem(session)).join('') : `
        <div class="empty"><span class="emoji">◷</span><strong>Nessun workout salvato</strong><p>Completa il primo allenamento per vedere volume e serie.</p></div>`}
    </main>`;
  }

  function renderHistoryItem(session) {
    const workout = workoutById(session.workoutId);
    const volume = sessionVolume(session);
    return `<article class="card history-item">
      <div class="history-top">
        <div><div class="eyebrow">${formatDate(session.endedAt)}</div><h3>${escapeHTML(workout?.title || 'Workout')}</h3><p class="muted small">${escapeHTML(workout?.subtitle || '')}</p></div>
        <div class="history-volume">${formatNumber(volume)} ${escapeHTML(state.settings.units)}</div>
      </div>
      <div class="history-meta"><span>Settimana ${session.programWeek}</span><span>${sessionCompletedSets(session)} serie</span><span>${formatDuration(session.durationSeconds)}</span></div>
      <div class="history-actions">
        <button class="btn btn-secondary btn-small" data-action="history-detail" data-session="${escapeHTML(session.id)}">Dettagli</button>
        <button class="btn btn-danger btn-small" data-action="history-delete" data-session="${escapeHTML(session.id)}">Elimina</button>
      </div>
    </article>`;
  }

  function renderSettings() {
    return `<main class="page">
      <header class="topbar"><div><div class="eyebrow">Preferenze</div><h1>Impostazioni.</h1><p class="muted">Dati locali, nessun account.</p></div></header>

      <section class="card setting-card">
        <div class="setting-row"><div class="setting-copy"><h3>Settimana del programma</h3><p>Determina quale scheda mostrare in Home.</p></div>
          <select class="select" id="settings-week">${Array.from({length:TOTAL_WEEKS},(_,i)=>i+1).map(w=>`<option value="${w}" ${w===state.settings.week?'selected':''}>${w}</option>`).join('')}</select>
        </div>
        <div class="setting-row"><div class="setting-copy"><h3>Unità di misura</h3><p>Usata per carichi e volume.</p></div>
          <select class="select" id="settings-units"><option value="kg" ${state.settings.units==='kg'?'selected':''}>kg</option><option value="lb" ${state.settings.units==='lb'?'selected':''}>lb</option></select>
        </div>
      </section>

      <section class="card setting-card install-card">
        <div class="eyebrow">Installazione iPhone</div>
        <h3 style="margin-top:6px">Usala come una vera app web</h3>
        <ol class="install-steps"><li>Apri questo sito con Safari.</li><li>Tocca Condividi.</li><li>Scegli “Aggiungi alla schermata Home”.</li><li>Conferma con “Aggiungi”.</li></ol>
        ${state.deferredInstallPrompt ? `<button class="btn btn-primary btn-full" style="margin-top:12px" data-action="install-pwa">Installa ora</button>` : ''}
      </section>

      <section class="card setting-card">
        <div class="setting-copy"><h3>Backup dei dati</h3><p>Esporta pesi e storico in un file JSON, oppure ripristinali.</p></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px">
          <button class="btn btn-secondary" data-action="export-data">Esporta</button>
          <label class="btn btn-secondary" for="import-file" style="cursor:pointer">Importa</label>
          <input id="import-file" type="file" accept="application/json" hidden>
        </div>
      </section>

      <section class="card setting-card">
        <div class="setting-copy"><h3>Legenda scheda</h3><p>Le sigle originali sono mantenute.</p></div>
        <div class="legend">${state.plan.notationLegend.map(item=>`<div class="legend-item"><strong>${escapeHTML(item.code)}</strong><span>${escapeHTML(item.meaning)}</span></div>`).join('')}</div>
      </section>

      <section class="card setting-card">
        <div class="setting-row"><div class="setting-copy"><h3>Privacy</h3><p>Pesi, serie e storico restano nel browser di questo dispositivo.</p></div><span>🔒</span></div>
        <div class="setting-row"><div class="setting-copy"><h3>Versione</h3><p>Protocol Fit PWA</p></div><strong>${APP_VERSION}</strong></div>
      </section>

      <button class="btn btn-danger btn-full" data-action="reset-data">Cancella tutti i dati</button>
    </main>`;
  }

  function bindEvents() {
    app.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => {
      state.tab = el.dataset.tab;
      state.screen = null;
      window.scrollTo({top:0,behavior:'smooth'});
      render();
    }));

    app.querySelectorAll('[data-week]').forEach(el => el.addEventListener('click', () => {
      state.settings.week = Number(el.dataset.week);
      persistSettings();
      render();
    }));

    app.querySelectorAll('[data-workout]').forEach(el => el.addEventListener('click', () => {
      state.selectedWorkoutId = el.dataset.workout;
      state.screen = 'detail';
      window.scrollTo(0,0);
      render();
    }));

    app.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', handleAction));

    app.querySelectorAll('[data-input]').forEach(input => {
      input.addEventListener('input', handleSetInput);
      input.addEventListener('blur', () => {
        input.value = input.value.trim().replace(',', '.');
        handleSetInput({currentTarget:input});
      });
    });

    const weekSelect = document.getElementById('settings-week');
    if (weekSelect) weekSelect.addEventListener('change', e => {
      state.settings.week = Number(e.target.value);
      persistSettings();
      toast('Settimana aggiornata');
    });
    const unitSelect = document.getElementById('settings-units');
    if (unitSelect) unitSelect.addEventListener('change', e => {
      state.settings.units = e.target.value;
      persistSettings();
      render();
    });
    const importFile = document.getElementById('import-file');
    if (importFile) importFile.addEventListener('change', importData);
  }

  async function handleAction(event) {
    const el = event.currentTarget;
    const action = el.dataset.action;

    if (action === 'open-settings') { state.tab='settings'; state.screen=null; render(); return; }
    if (action === 'hide-install') { saveJSON(KEYS.installHint,true); render(); return; }
    if (action === 'back') { state.screen=null; render(); return; }
    if (action === 'resume') { state.screen='active'; render(); requestWakeLock(); return; }
    if (action === 'start-workout') { startWorkout(); return; }
    if (action === 'exit-active') { exitActive(); return; }
    if (action === 'finish-workout') { finishWorkout(); return; }
    if (action === 'discard-workout') { discardWorkout(); return; }
    if (action === 'toggle-exercise') {
      const id = el.dataset.exercise;
      state.collapsedExercises[id] = !state.collapsedExercises[id];
      render(); return;
    }
    if (action === 'complete-set') { completeSet(Number(el.dataset.ex),Number(el.dataset.set)); return; }
    if (action === 'timer-add') { addTimer(15); return; }
    if (action === 'timer-cancel') { cancelTimer(); return; }
    if (action === 'toggle-wake') { await toggleWakeLock(); return; }
    if (action === 'history-detail') { showHistoryDetail(el.dataset.session); return; }
    if (action === 'history-delete') { deleteHistory(el.dataset.session); return; }
    if (action === 'export-data') { exportData(); return; }
    if (action === 'reset-data') { resetData(); return; }
    if (action === 'install-pwa') { await promptInstall(); return; }
  }

  function startWorkout() {
    const workout = workoutById(state.selectedWorkoutId);
    if (!workout) return;
    if (state.active && state.active.workoutId !== workout.id) {
      const current = workoutById(state.active.workoutId);
      const replace = confirm(`Hai già “${current?.title || 'un workout'}” in corso. Vuoi scartarlo e iniziare questo?`);
      if (!replace) return;
    }
    if (!state.active || state.active.workoutId !== workout.id) {
      state.active = createActiveWorkout(workout);
      persistActive();
    }
    state.screen='active';
    render();
    requestWakeLock();
  }

  function exitActive() {
    const choice = confirm('Il workout resta salvato e potrai riprenderlo dalla Home. Vuoi uscire?');
    if (!choice) return;
    state.screen=null;
    releaseWakeLock();
    render();
  }

  function discardWorkout() {
    if (!confirm('Scartare definitivamente il workout in corso?')) return;
    state.active=null;
    saveJSON(KEYS.active,null);
    cancelTimer(false);
    releaseWakeLock();
    state.screen=null;
    toast('Workout scartato');
    render();
  }

  function handleSetInput(event) {
    const input = event.currentTarget;
    if (!state.active) return;
    const exIndex = Number(input.dataset.ex);
    const setIndex = Number(input.dataset.set);
    const field = input.dataset.input;
    const set = state.active.exercises?.[exIndex]?.sets?.[setIndex];
    if (!set || !['weight','reps'].includes(field)) return;
    set[field] = input.value;
    state.active.updatedAt = new Date().toISOString();
    persistActive();
  }

  function completeSet(exIndex, setIndex) {
    if (!state.active) return;
    const workout = workoutById(state.active.workoutId);
    const set = state.active.exercises?.[exIndex]?.sets?.[setIndex];
    const exercise = workout?.exercises?.[exIndex];
    if (!set || !exercise) return;
    set.completed = !set.completed;
    state.active.updatedAt = new Date().toISOString();
    persistActive();
    if (set.completed && exercise.restSeconds > 0) startTimer(exercise.restSeconds, exercise.name);
    render();
  }

  function finishWorkout() {
    if (!state.active) return;
    const completed = state.active.exercises.flatMap(e=>e.sets).filter(s=>s.completed);
    if (!completed.length) { toast('Completa almeno una serie'); return; }
    if (!confirm('Terminare e salvare questo workout?')) return;

    const endedAt = new Date();
    const session = {
      ...state.active,
      endedAt: endedAt.toISOString(),
      durationSeconds: Math.max(1, Math.floor((endedAt - new Date(state.active.startedAt))/1000))
    };

    session.exercises.forEach(ex => {
      const last = [...ex.sets].reverse().find(s => s.completed && String(s.weight).trim() !== '');
      if (last) state.lastWeights[ex.exerciseId] = last.weight;
    });
    state.history.push(session);
    persistHistory();
    persistLastWeights();
    state.active=null;
    saveJSON(KEYS.active,null);
    cancelTimer(false);
    releaseWakeLock();
    state.screen=null;
    state.tab='history';
    toast('Workout salvato');
    render();
  }

  function timerRemaining() {
    if (!state.timer) return 0;
    return Math.max(0, Math.ceil((state.timer.endAt - Date.now())/1000));
  }

  function startTimer(seconds, exerciseName) {
    state.timer = { totalSeconds:seconds, endAt:Date.now()+seconds*1000, exerciseName, notified:false };
    persistTimer();
    ensureTimerInterval();
  }

  function addTimer(seconds) {
    if (!state.timer) return;
    state.timer.endAt += seconds*1000;
    state.timer.totalSeconds += seconds;
    persistTimer();
    updateTimerBanner();
  }

  function cancelTimer(shouldRender=true) {
    state.timer=null;
    saveJSON(KEYS.timer, null);
    clearInterval(state.timerInterval);
    state.timerInterval=null;
    if (shouldRender) render();
  }

  function ensureTimerInterval() {
    clearInterval(state.timerInterval);
    state.timerInterval=setInterval(() => {
      if (!state.timer) return;
      const remaining=timerRemaining();
      updateTimerBanner();
      if (remaining<=0 && !state.timer.notified) {
        state.timer.notified=true;
        persistTimer();
        notifyTimerDone();
        setTimeout(()=>cancelTimer(),650);
      }
    },250);
    render();
  }

  function updateTimerBanner() {
    if (!state.timer) return;
    const remaining=timerRemaining();
    const count=document.getElementById('timer-count');
    if (count) count.textContent=formatDuration(remaining);
    const ring=document.querySelector('.timer-ring');
    if (ring) {
      const pct=state.timer.totalSeconds ? clamp((remaining/state.timer.totalSeconds)*100,0,100) : 0;
      ring.style.setProperty('--timer-progress',`${pct}%`);
    }
  }

  function notifyTimerDone() {
    try {
      if ('vibrate' in navigator) navigator.vibrate([180,90,180]);
      const AudioCtx=window.AudioContext||window.webkitAudioContext;
      if (AudioCtx) {
        const ctx=new AudioCtx();
        const osc=ctx.createOscillator();
        const gain=ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value=880; gain.gain.setValueAtTime(.0001,ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(.22,ctx.currentTime+.02);
        gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.38);
        osc.start(); osc.stop(ctx.currentTime+.4);
      }
    } catch { /* feedback non essenziale */ }
    toast('Recupero terminato');
  }

  function startLiveClock() {
    const update=()=>{
      const el=document.getElementById('live-clock');
      if (!el||!state.active) return;
      el.textContent=formatDuration((Date.now()-new Date(state.active.startedAt).getTime())/1000);
    };
    update();
    state.clockInterval=setInterval(update,1000);
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { state.wakeLock=await navigator.wakeLock.request('screen'); }
    catch { /* non supportato o negato */ }
  }

  async function toggleWakeLock() {
    if (state.wakeLock) { await releaseWakeLock(); toast('Schermo automatico'); }
    else { await requestWakeLock(); toast(state.wakeLock ? 'Schermo mantenuto acceso' : 'Funzione non disponibile'); }
  }

  async function releaseWakeLock() {
    try { if (state.wakeLock) await state.wakeLock.release(); } catch {}
    state.wakeLock=null;
  }

  function showHistoryDetail(id) {
    const session=state.history.find(h=>h.id===id);
    if (!session) return;
    const workout=workoutById(session.workoutId);
    modalRoot.innerHTML=`<div class="modal-backdrop" data-modal-close>
      <section class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><div><div class="eyebrow">${formatDate(session.endedAt)}</div><h2 style="margin:5px 0">${escapeHTML(workout?.title || 'Workout')}</h2><p class="muted small">${escapeHTML(workout?.subtitle || '')}</p></div><button class="modal-close" data-modal-close>×</button></div>
        ${session.exercises.map((exDraft,idx)=>{
          const ex=workout?.exercises[idx];
          const completed=exDraft.sets.filter(s=>s.completed);
          if (!completed.length) return '';
          return `<div class="modal-set"><strong>${escapeHTML(ex?.name || 'Esercizio')}</strong><div class="muted small" style="margin-top:5px">${completed.map(s=>`${escapeHTML(s.weight || '—')} ${escapeHTML(state.settings.units)} × ${escapeHTML(s.reps || '—')}`).join(' · ')}</div></div>`;
        }).join('')}
      </section></div>`;
    modalRoot.querySelectorAll('[data-modal-close]').forEach(el=>el.addEventListener('click',e=>{
      if (e.target===el || el.classList.contains('modal-close')) modalRoot.innerHTML='';
    }));
  }

  function deleteHistory(id) {
    if (!confirm('Eliminare questo workout dallo storico?')) return;
    state.history=state.history.filter(h=>h.id!==id);
    persistHistory();
    render();
  }

  function exportData() {
    const payload={
      app:'Protocol Fit', version:APP_VERSION, exportedAt:new Date().toISOString(),
      settings:state.settings, active:state.active, history:state.history, lastWeights:state.lastWeights
    };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=`protocol-fit-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast('Backup creato');
  }

  async function importData(event) {
    const file=event.target.files?.[0];
    if (!file) return;
    try {
      const data=JSON.parse(await file.text());
      if (!data || data.app!=='Protocol Fit' || !Array.isArray(data.history)) throw new Error('Formato non valido');
      if (!confirm('Sostituire i dati attuali con questo backup?')) return;
      state.settings=data.settings || {week:1,units:'kg'};
      state.active=data.active || null;
      state.history=data.history || [];
      state.lastWeights=data.lastWeights || {};
      persistSettings(); persistActive(); persistHistory(); persistLastWeights();
      toast('Backup ripristinato'); render();
    } catch { alert('Il file non è un backup valido di Protocol Fit.'); }
    finally { event.target.value=''; }
  }

  function resetData() {
    if (!confirm('Cancellare definitivamente workout in corso, storico e carichi?')) return;
    state.active=null; state.history=[]; state.lastWeights={}; state.settings={week:1,units:'kg'};
    Object.values(KEYS).forEach(key=>localStorage.removeItem(key));
    cancelTimer(false); render(); toast('Dati cancellati');
  }

  async function promptInstall() {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt=null;
    render();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));
    }
  }

  async function init() {
    app.innerHTML='<div class="loading"><div><div class="spinner"></div><h2>Caricamento Protocol Fit</h2><p class="muted">Preparazione della scheda…</p></div></div>';
    try {
      const response=await fetch('./plan.json',{cache:'no-cache'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.plan=await response.json();
      state.settings.week=clamp(Number(state.settings.week)||1,1,TOTAL_WEEKS);
      state.settings.units=['kg','lb'].includes(state.settings.units)?state.settings.units:'kg';
      persistSettings();
      render();
      if (state.timer && timerRemaining() > 0) ensureTimerInterval();
      else if (state.timer) cancelTimer(false);
    } catch (error) {
      app.innerHTML=`<div class="loading"><div><h2>Impossibile caricare la scheda</h2><p class="muted">Apri l’app dal link HTTPS pubblicato, non direttamente dal file index.html.</p><pre class="small">${escapeHTML(error.message)}</pre></div></div>`;
    }
  }

  window.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();
    state.deferredInstallPrompt=event;
    if (state.tab==='settings') render();
  });

  document.addEventListener('visibilitychange',()=>{
    if (document.visibilityState==='visible') {
      if (state.screen==='active') requestWakeLock();
      if (state.timer && timerRemaining()<=0 && !state.timer.notified) {
        state.timer.notified=true; persistTimer(); notifyTimerDone(); setTimeout(()=>cancelTimer(),650);
      }
    }
  });

  window.addEventListener('storage',()=>{
    state.active=loadJSON(KEYS.active,null);
    state.history=loadJSON(KEYS.history,[]);
    state.lastWeights=loadJSON(KEYS.lastWeights,{});
    render();
  });

  registerServiceWorker();
  init();
})();
