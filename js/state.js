/* state.js — stato condiviso: atleti (6 corsie), run corrente, risultati.
 * Persistenza semplice in localStorage. */

const Store = (() => {
  const KEY = 'atletica_state_v1';

  const def = () => ({
    distance: 60,                 // metri (informativo)
    direction: 'rtl',             // 'ltr' o 'rtl' = verso di corsa nell'immagine
    athletes: Array.from({ length: 6 }, (_, i) => ({ lane: i + 1, name: '' })),
    runs: [],                     // storico run: {ts, distance, results:[{lane,name,time}]}
    calibration: {                // calibrazione camera persistente
      finishX: 0.5, laneTop: 0.25, laneBottom: 0.95, nLanes: 6, lane1Top: true,
      laneEdges: null,            // bordi per-corsia (normalizzati); null = bande uguali
    },
    quality: 'fast',              // 'fast' (più fps) | 'hd' (più dettaglio)
    detectMode: 'ai',             // 'ai' (MoveNet) | 'line' (striscia, veloce)
    lineSensitivity: 30,          // soglia modalità linea (più bassa = più sensibile)
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return Object.assign(def(), JSON.parse(raw));
    } catch (e) {}
    return def();
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function get() { return state; }

  function setAthlete(lane, name) {
    const a = state.athletes.find(x => x.lane === lane);
    if (a) { a.name = name; save(); }
  }

  function athleteByLane(lane) {
    const a = state.athletes.find(x => x.lane === lane);
    return a ? a.name : '';
  }

  function setDistance(d) { state.distance = d; save(); }
  function setDirection(dir) { state.direction = dir; save(); }

  function setCalibration(partial) { Object.assign(state.calibration, partial); save(); }
  function getCalibration() { return { ...state.calibration }; }

  function setQuality(q) { state.quality = q; save(); }
  function getQuality() { return state.quality; }

  function setDetectMode(m) { state.detectMode = m; save(); }
  function getDetectMode() { return state.detectMode; }
  function setLineSensitivity(v) { state.lineSensitivity = v; save(); }
  function getLineSensitivity() { return state.lineSensitivity; }

  function addRun(results) {
    const run = {
      ts: Date.now(),
      distance: state.distance,
      results: results.slice().sort((a, b) => a.time - b.time),
    };
    state.runs.unshift(run);
    save();
    return run;
  }

  function clearRuns() { state.runs = []; save(); }

  function deleteRun(ts) {
    state.runs = state.runs.filter(r => r.ts !== ts);
    save();
  }

  // Statistiche aggregate per atleta+distanza (solo atleti con nome).
  // Ritorna: [{name, distance, times:[{t,ts}](cronologico), best, last, prev}]
  function athleteStats() {
    const map = new Map(); // chiave "name||distance"
    state.runs.slice().sort((a, b) => a.ts - b.ts).forEach(run => {
      run.results.forEach(r => {
        if (!r.name) return;
        const key = r.name + '||' + run.distance;
        if (!map.has(key)) map.set(key, { name: r.name, distance: run.distance, times: [] });
        map.get(key).times.push({ t: r.time, ts: run.ts });
      });
    });
    const out = [];
    for (const v of map.values()) {
      const ts = v.times;
      const best = Math.min(...ts.map(x => x.t));
      const last = ts[ts.length - 1].t;
      const prev = ts.length > 1 ? ts[ts.length - 2].t : null;
      out.push({ ...v, best, last, prev, count: ts.length });
    }
    out.sort((a, b) => a.name.localeCompare(b.name) || a.distance - b.distance);
    return out;
  }

  // Esporta tutti i run in CSV.
  function toCSV() {
    const rows = [['data', 'distanza_m', 'corsia', 'atleta', 'tempo_s']];
    state.runs.forEach(run => {
      const d = new Date(run.ts).toISOString();
      run.results.forEach(r => {
        rows.push([d, run.distance, r.lane, r.name || '', (r.time / 1000).toFixed(2)]);
      });
    });
    return rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  return { get, save, setAthlete, athleteByLane, setDistance, setDirection,
           setCalibration, getCalibration, setQuality, getQuality,
           setDetectMode, getDetectMode, setLineSensitivity, getLineSensitivity,
           addRun, clearRuns, deleteRun, athleteStats, toCSV };
})();
