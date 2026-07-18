export const MUSCLE_COLORS = {
  Petto: '#8dffb5',
  Dorsali: '#6ee7ff',
  Spalle: '#a78bfa',
  Bicipiti: '#ff8ad8',
  Tricipiti: '#ffb86c',
  Quadricipiti: '#fef08a',
  Femorali: '#fb7185',
  Glutei: '#c4ff72',
  Polpacci: '#67e8f9',
  Addome: '#f0abfc'
};

export function numberValue(value) {
  const parsed = Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function e1rm(weight, reps) {
  const w = numberValue(weight);
  const r = numberValue(reps);
  if (!w || !r) return 0;
  if (r === 1) return w;
  return w * (1 + Math.min(r, 30) / 30);
}

export function inferTarget(scheme) {
  const text = String(scheme || '').replaceAll('–', '-').toLowerCase();
  if (/\d+\s*(wu|f|w|b|st)\b/i.test(text) || /\b(working|feeder|back)\b/i.test(text)) {
    return { min: 0, max: 0, display: scheme || 'Libero' };
  }
  if (text.includes('max')) return { min: 0, max: 0, display: 'Max' };
  const range = text.match(/(\d+)\s*-\s*(\d+)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]), display: scheme };
  const first = text.match(/\d+/);
  if (first) {
    const value = Number(first[0]);
    return { min: value, max: value, display: scheme };
  }
  return { min: 0, max: 0, display: scheme || 'Libero' };
}

export function setLabels(exercise) {
  const result = [];
  const parts = String(exercise.scheme || '').split('·').map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(\d+)\s*([A-Za-z]+)$/);
    if (!match) continue;
    const count = Number(match[1]);
    for (let i = 0; i < count; i += 1) result.push(match[2].toUpperCase());
  }
  if (result.length === exercise.setCount) return result;
  return Array.from({ length: exercise.setCount }, (_, index) => `S${index + 1}`);
}

function isSmallMuscle(name) {
  return /curl|bicip|tricip|alzate|aperture|croci|leg extension|leg curl|calf|addutt|abdutt/i.test(name);
}

function roundToStep(value, step) {
  return Math.max(0, Math.round(value / step) * step);
}

export function readinessProfile(checkin) {
  if (!checkin) return { score: 68, mode: 'standard', label: 'Standard', modifier: 1, volumeModifier: 1 };
  const sleep = Number(checkin.sleep || 3);
  const energy = Number(checkin.energy || 3);
  const soreness = Number(checkin.soreness || 3);
  const stress = Number(checkin.stress || 3);
  const score = Math.round(((sleep + energy + (6 - soreness) + (6 - stress)) / 20) * 100);
  if (score >= 80) return { score, mode: 'push', label: 'Pronto a spingere', modifier: 1.015, volumeModifier: 1 };
  if (score < 52) return { score, mode: 'conservative', label: 'Gestione fatica', modifier: 0.95, volumeModifier: 0.85 };
  return { score, mode: 'standard', label: 'Carico standard', modifier: 1, volumeModifier: 1 };
}

export function suggestSet({ exercise, previousExercise, setIndex, currentExercise, readiness, units = 'kg' }) {
  const target = inferTarget(exercise.scheme);
  const step = units === 'lb' ? (isSmallMuscle(exercise.name) ? 2.5 : 5) : (isSmallMuscle(exercise.name) ? 1 : 2.5);
  const profile = readinessProfile(readiness);
  const currentPrevious = currentExercise?.sets?.slice(0, setIndex).reverse().find((set) => set.completed);
  const priorSet = previousExercise?.sets?.[setIndex] || previousExercise?.sets?.find((set) => set.completed);
  const source = currentPrevious || priorSet;
  let weight = source ? numberValue(source.weight) : 0;
  let reps = source ? numberValue(source.reps) : (target.min || 0);
  let explanation = source ? 'Riprendo l’ultima serie valida.' : 'Prima registrazione: completa il carico una volta.';
  let confidence = source ? 'Media' : 'Bassa';

  if (previousExercise?.sets?.length && weight) {
    const completed = previousExercise.sets.filter((set) => set.completed && numberValue(set.reps));
    const avgReps = completed.length ? completed.reduce((sum, set) => sum + numberValue(set.reps), 0) / completed.length : reps;
    const avgRir = completed.filter((set) => Number.isFinite(Number(set.rir))).reduce((sum, set) => sum + Number(set.rir), 0) / Math.max(1, completed.filter((set) => Number.isFinite(Number(set.rir))).length);
    const reachedTop = target.max > 0 && avgReps >= target.max;
    const effortControlled = !Number.isFinite(avgRir) || avgRir >= 1;
    if (reachedTop && effortControlled) {
      weight = roundToStep(weight + step, step);
      reps = target.min || reps;
      explanation = `Target centrato: incremento prudente di ${step} ${units}.`;
      confidence = 'Alta';
    } else if (target.min && avgReps < target.min - 1) {
      weight = roundToStep(weight * 0.975, step);
      explanation = 'Target non centrato: piccolo reset per proteggere la qualità.';
      confidence = 'Media';
    }
  }

  if (weight && profile.mode === 'conservative') {
    weight = roundToStep(weight * profile.modifier, step);
    explanation += ' Check-in basso: riduzione del 5%.';
  }

  if (exercise.loadMode === 'bodyweight' || exercise.loadMode === 'timed') weight = 0;
  return {
    weight: weight ? String(weight).replace('.', ',') : '',
    reps: reps ? String(Math.round(reps)) : '',
    target,
    explanation,
    confidence,
    mode: profile.mode
  };
}

export function classifyExercise(exercise, workout) {
  const text = `${exercise?.name || ''} ${workout?.subtitle || ''}`.toLowerCase();
  const result = {};
  const add = (muscle, value) => { result[muscle] = Math.max(result[muscle] || 0, value); };

  if (/addome|crunch|plank|vacuum|leg raise/.test(text)) add('Addome', 1);
  if (/calf|polpacc/.test(text)) add('Polpacci', 1);
  if (/leg extension|squat|pressa|leg press|affond/.test(text)) { add('Quadricipiti', 1); add('Glutei', 0.35); }
  if (/leg curl|femoral|stacco rumeno|romanian/.test(text)) { add('Femorali', 1); add('Glutei', 0.35); }
  if (/hip thrust|glute|abdutt|sumo/.test(text)) add('Glutei', 1);
  if (/tricip|french|push.?down|dip/.test(text)) add('Tricipiti', 1);
  if (/bicip|curl/.test(text)) add('Bicipiti', 1);
  if (/military|arnold|alzate|shoulder|distensioni 90|spalle|aperture posteriori|face pull/.test(text)) add('Spalle', 1);
  if (/lat machine|trazion|rematore|pulley|dorso|dorsal|pullover|pull-over/.test(text)) { add('Dorsali', 1); add('Bicipiti', 0.35); }
  if (/panca|petto|croci|chest|pectoral|distensioni.*(manubri|multipower|bilanciere)|push.?up/.test(text)) {
    add('Petto', 1); add('Tricipiti', 0.35); add('Spalle', 0.25);
  }
  if (!Object.keys(result).length) add('Spalle', 0.5);
  return result;
}

export function sessionStats(session) {
  let completedSets = 0;
  let volume = 0;
  let bestE1rm = 0;
  for (const exercise of session.exercises || []) {
    for (const set of exercise.sets || []) {
      if (!set.completed) continue;
      completedSets += 1;
      const weight = numberValue(set.weight);
      const reps = numberValue(set.reps);
      volume += weight * reps;
      bestE1rm = Math.max(bestE1rm, e1rm(weight, reps));
    }
  }
  return { completedSets, volume, bestE1rm };
}

export function buildAnalytics(history, workouts) {
  const workoutMap = new Map(workouts.map((workout) => [workout.id, workout]));
  const sorted = [...history].sort((a, b) => new Date(a.endedAt) - new Date(b.endedAt));
  const muscleSets = {};
  const exerciseSeries = new Map();
  const daily = new Map();
  let totalSets = 0;
  let totalVolume = 0;

  for (const session of sorted) {
    const workout = workoutMap.get(session.workoutId);
    const day = String(session.endedAt || session.startedAt).slice(0, 10);
    const stats = sessionStats(session);
    totalSets += stats.completedSets;
    totalVolume += stats.volume;
    daily.set(day, (daily.get(day) || 0) + stats.completedSets);
    for (const draft of session.exercises || []) {
      const exercise = workout?.exercises?.find((item) => item.id === draft.exerciseId) || { id: draft.exerciseId, name: draft.name || 'Esercizio' };
      const contributions = classifyExercise(exercise, workout);
      const completed = (draft.sets || []).filter((set) => set.completed);
      for (const [muscle, coefficient] of Object.entries(contributions)) {
        muscleSets[muscle] = (muscleSets[muscle] || 0) + completed.length * coefficient;
      }
      const points = exerciseSeries.get(exercise.id) || { id: exercise.id, name: exercise.name, points: [] };
      const best = completed.reduce((max, set) => Math.max(max, e1rm(set.weight, set.reps)), 0);
      if (best) points.points.push({ date: day, value: best });
      exerciseSeries.set(exercise.id, points);
    }
  }

  const now = new Date();
  const weeks = Array.from({ length: 8 }, (_, offset) => {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    end.setDate(end.getDate() - (7 - offset) * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const sessions = sorted.filter((session) => {
      const date = new Date(session.endedAt || session.startedAt);
      return date >= start && date <= end;
    });
    return {
      label: `${start.getDate()}/${start.getMonth() + 1}`,
      sets: sessions.reduce((sum, session) => sum + sessionStats(session).completedSets, 0),
      volume: sessions.reduce((sum, session) => sum + sessionStats(session).volume, 0)
    };
  });

  const exerciseTrends = [...exerciseSeries.values()].filter((item) => item.points.length).sort((a, b) => b.points.length - a.points.length);
  const prs = exerciseTrends.map((item) => ({ ...item, best: Math.max(...item.points.map((point) => point.value)) })).sort((a, b) => b.best - a.best);
  return { totalSets, totalVolume, muscleSets, daily, weeks, exerciseTrends, prs };
}

export function calculateLevel(history, analytics) {
  const xp = history.length * 120 + analytics.totalSets * 8 + analytics.prs.length * 20;
  const level = Math.max(1, Math.floor(Math.sqrt(xp / 150)) + 1);
  const currentFloor = Math.pow(level - 1, 2) * 150;
  const nextFloor = Math.pow(level, 2) * 150;
  const progress = Math.max(0, Math.min(1, (xp - currentFloor) / Math.max(1, nextFloor - currentFloor)));
  return { xp, level, progress, nextXp: nextFloor };
}

export function achievements(history, analytics, workouts) {
  const workoutIds = new Set(history.map((session) => session.workoutId));
  const hasDeload = history.some((session) => /deload/i.test(workouts.find((workout) => workout.id === session.workoutId)?.title || ''));
  return [
    { id: 'first', icon: '⚡', title: 'Protocollo avviato', description: 'Completa il primo workout.', unlocked: history.length >= 1 },
    { id: 'five', icon: '🔥', title: 'Costanza', description: 'Completa 5 workout.', unlocked: history.length >= 5 },
    { id: 'sets100', icon: '◫', title: '100 serie', description: 'Registra 100 serie allenanti.', unlocked: analytics.totalSets >= 100 },
    { id: 'explorer', icon: '⌁', title: 'Protocol Explorer', description: 'Completa 8 workout diversi.', unlocked: workoutIds.size >= 8 },
    { id: 'deload', icon: '☾', title: 'Recovery win', description: 'Completa il deload programmato.', unlocked: hasDeload },
    { id: 'data', icon: '⌁', title: 'Data driven', description: 'Crea trend su 5 esercizi.', unlocked: analytics.exerciseTrends.length >= 5 }
  ];
}
