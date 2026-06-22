/* app.js — UI, navigazione, cronometro, integrazione camera, risultati. */

(() => {
  const $ = (id) => document.getElementById(id);

  // ---- stato cronometro ----
  let t0 = null, rafId = null, running = false;
  let currentResults = [];   // {lane, name, time} della run corrente

  // ===================== NAVIGAZIONE A SCHEDE =====================
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      document.querySelectorAll('.tabpane').forEach(p => {
        p.hidden = (p.dataset.pane !== name);
      });
      if (name === 'storico') renderStorico();
    });
  });

  // ===================== SCHEDA ATLETI =====================
  function renderAthletes() {
    const ul = $('athletes');
    ul.innerHTML = '';
    Store.get().athletes.forEach(a => {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="lane-badge">C${a.lane}</span>
        <input type="text" placeholder="Nome atleta corsia ${a.lane}" value="${a.name || ''}" data-lane="${a.lane}">`;
      ul.appendChild(li);
    });
    ul.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', () => Store.setAthlete(+inp.dataset.lane, inp.value.trim()));
    });
  }

  $('distance').addEventListener('change', (e) => Store.setDistance(+e.target.value || 60));
  $('direction').addEventListener('change', (e) => {
    Store.setDirection(e.target.value);
    Camera.setCalibration({ direction: e.target.value });
  });

  // ===================== CRONOMETRO =====================
  function fmt(ms) {
    if (ms == null) return '—';
    const totalCs = Math.round(ms / 10);
    const cs = totalCs % 100;
    const totalSec = Math.floor(totalCs / 100);
    const sec = totalSec % 60;
    const min = Math.floor(totalSec / 60);
    const cc = String(cs).padStart(2, '0');
    return min > 0 ? `${min}:${String(sec).padStart(2,'0')}.${cc}` : `${sec}.${cc}`;
  }

  function tick() {
    if (!running || t0 === null) return;
    $('time').textContent = fmt(performance.now() - t0);
    rafId = requestAnimationFrame(tick);
  }

  function setPhase(text, cls) {
    $('phase').textContent = text;
    $('phase').className = 'phase' + (cls ? ' ' + cls : '');
  }

  // ===================== FLUSSO PARTENZA (2 tempi) =====================
  function onMarks() {
    StartSequence.unlock();
    resetRun(false);
    StartSequence.sayMarks({ voice: $('setVoice').checked });
    setPhase('Ai vostri posti — attendi che siano fermi', 'cmd');
    $('btnMarks').disabled = true;
    $('btnSet').disabled = false;
  }

  function onSet() {
    $('btnSet').disabled = true;
    setPhase('Pronti…', 'cmd');

    StartSequence.armSetAndGun({
      setMin: parseFloat($('setSetMin').value) || 1.5,
      setMax: parseFloat($('setSetMax').value) || 2.5,
      voice: $('setVoice').checked,
      onShot: (shotT0) => {
        t0 = shotT0;
        running = true;
        setPhase('VIA!', 'shot');
        $('time').classList.add('running');
        $('btnFinish').disabled = false;
        rafId = requestAnimationFrame(tick);
        setTimeout(() => { if (running) setPhase('In corsa', ''); }, 800);

        // se l'arrivo automatico è attivo, arma la camera con lo stesso t0
        if ($('useCamera').checked) {
          Camera.arm(shotT0, onAutoFinish);
        }
      },
    });
  }

  // arrivo rilevato dalla camera
  function onAutoFinish({ lane, time }) {
    addResult(lane, time, true);
  }

  // arrivo manuale (pulsante)
  function onManualFinish() {
    if (!running || t0 === null) return;
    addResult(null, performance.now() - t0, false);
  }

  function addResult(lane, time, fromCamera) {
    // evita doppioni di corsia nella stessa run
    if (lane != null && currentResults.some(r => r.lane === lane)) return;
    const name = lane != null ? Store.athleteByLane(lane) : '';
    currentResults.push({ lane, name, time });
    renderLaps();
    $('btnSaveRun').disabled = currentResults.length === 0;
  }

  function laneOptions(selected) {
    let opts = `<option value="">— manuale —</option>`;
    for (let l = 1; l <= 6; l++) {
      const nm = Store.athleteByLane(l);
      opts += `<option value="${l}" ${selected === l ? 'selected' : ''}>Corsia ${l}${nm ? ' · ' + nm : ''}</option>`;
    }
    return opts;
  }

  function renderLaps() {
    const ul = $('laps');
    ul.innerHTML = '';
    const sorted = currentResults.slice().sort((a, b) => a.time - b.time);
    sorted.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'lap-edit';
      li.innerHTML = `
        <span class="rank">${i + 1}°</span>
        <select class="lane-sel">${laneOptions(r.lane)}</select>
        <span class="lap-time">${fmt(r.time)}</span>
        <button class="del" title="Elimina">✕</button>`;
      // cambia corsia (correzione manuale se la camera sbaglia)
      li.querySelector('.lane-sel').addEventListener('change', (e) => {
        const v = e.target.value ? +e.target.value : null;
        r.lane = v;
        r.name = v != null ? Store.athleteByLane(v) : '';
        renderLaps();
      });
      // elimina rilevamento sbagliato
      li.querySelector('.del').addEventListener('click', () => {
        const idx = currentResults.indexOf(r);
        if (idx >= 0) currentResults.splice(idx, 1);
        renderLaps();
        $('btnSaveRun').disabled = currentResults.length === 0;
      });
      ul.appendChild(li);
    });
  }

  function resetRun(clearList = true) {
    StartSequence.abort();
    if (Camera && Camera.disarm) Camera.disarm();
    if (rafId) cancelAnimationFrame(rafId);
    running = false; t0 = null;
    $('time').textContent = '0.00';
    $('time').classList.remove('running');
    setPhase('Pronto', '');
    $('btnMarks').disabled = false;
    $('btnSet').disabled = true;
    $('btnFinish').disabled = true;
    if (clearList) {
      currentResults = [];
      renderLaps();
      $('btnSaveRun').disabled = true;
    }
  }

  function saveRun() {
    if (!currentResults.length) return;
    Store.addRun(currentResults);
    setPhase('Run salvata ✓', '');
    resetRun(true);
  }

  function exportCSV() {
    const csv = Store.toCSV();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tempi_atletica.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // ===================== STORICO & STATISTICHE =====================
  function sparkline(times) {
    // times: array cronologico (ms). Tempo minore = punto più in alto (= miglioramento).
    if (times.length < 2) return '';
    const w = 120, h = 30, pad = 3;
    const min = Math.min(...times), max = Math.max(...times);
    const span = (max - min) || 1;
    const pts = times.map((t, i) => {
      const x = pad + (w - 2 * pad) * i / (times.length - 1);
      const y = pad + (h - 2 * pad) * (t - min) / span; // min->top
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const improving = times[times.length - 1] <= times[0];
    const col = improving ? '#43e97b' : '#ff5d73';
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function renderStats() {
    const box = $('stats');
    const stats = Store.athleteStats();
    if (!stats.length) {
      box.innerHTML = '<p class="hint">Nessun dato: salva qualche run con i nomi degli atleti.</p>';
      return;
    }
    box.innerHTML = '';
    stats.forEach(s => {
      let trend = '';
      if (s.prev != null) {
        const d = s.last - s.prev; // <0 = migliorato
        const sign = d < 0 ? '▼' : (d > 0 ? '▲' : '=');
        const cls = d < 0 ? 'good' : (d > 0 ? 'bad' : '');
        trend = `<span class="trend ${cls}">${sign} ${fmt(Math.abs(d))}</span>`;
      }
      const card = document.createElement('div');
      card.className = 'stat-card';
      card.innerHTML = `
        <div class="stat-head">
          <span class="stat-name">${s.name}</span>
          <span class="stat-dist">${s.distance} m</span>
        </div>
        <div class="stat-body">
          <div class="stat-nums">
            <div><small>Migliore</small><b class="best">${fmt(s.best)}</b></div>
            <div><small>Ultimo</small><b>${fmt(s.last)}</b> ${trend}</div>
            <div><small>Prove</small><b>${s.count}</b></div>
          </div>
          ${sparkline(s.times.map(x => x.t))}
        </div>`;
      box.appendChild(card);
    });
  }

  function renderHistory() {
    const box = $('history');
    const runs = Store.get().runs;
    if (!runs.length) {
      box.innerHTML = '<p class="hint">Nessuna run salvata.</p>';
      return;
    }
    box.innerHTML = '';
    runs.forEach(run => {
      const d = new Date(run.ts);
      const when = d.toLocaleDateString('it-IT') + ' ' +
        d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      const rows = run.results.map((r, i) => {
        const who = r.lane != null ? `C${r.lane}${r.name ? ' · ' + r.name : ''}` : 'manuale';
        return `<li><span class="lap-label">${i + 1}° · ${who}</span>
                    <span class="lap-time">${fmt(r.time)}</span></li>`;
      }).join('');
      const div = document.createElement('div');
      div.className = 'run-card';
      div.innerHTML = `
        <div class="run-head">
          <span>${when} · ${run.distance} m</span>
          <button class="del" data-ts="${run.ts}">✕</button>
        </div>
        <ul class="laps">${rows}</ul>`;
      box.appendChild(div);
    });
    box.querySelectorAll('.del').forEach(b => {
      b.addEventListener('click', () => {
        Store.deleteRun(+b.dataset.ts);
        renderStorico();
      });
    });
  }

  function renderStorico() { renderStats(); renderHistory(); }

  // ===================== CAMERA =====================
  Camera.onStatusChange((s) => { $('camStatus').textContent = s; });

  async function camStart() {
    try {
      $('btnCamStart').disabled = true;
      applyCalibration();
      await Camera.start($('video'), $('overlay'));
      $('btnCamStop').disabled = false;
      $('btnRec').disabled = false;
      acquireWakeLock();
    } catch (e) {
      $('camStatus').textContent = 'Errore camera: ' + (e.message || e);
      $('btnCamStart').disabled = false;
    }
  }
  function camStop() {
    recStop();
    Camera.stop();
    releaseWakeLock();
    $('btnCamStart').disabled = false;
    $('btnCamStop').disabled = true;
    $('btnRec').disabled = true;
    $('btnRecStop').disabled = true;
    $('diagFps').textContent = '—'; $('diagDet').textContent = '—'; $('diagArmed').textContent = 'off';
    $('camStatus').textContent = 'Fotocamera spenta.';
  }

  // muovere uno slider di banda RIDISTRIBUISCE le corsie in modo uniforme
  function applyCalibration() {
    Camera.setCalibration({
      finishX: (+$('calFinishX').value) / 100,
      laneTop: (+$('calLaneTop').value) / 100,
      laneBottom: (+$('calLaneBottom').value) / 100,
      nLanes: +$('calNLanes').value || 6,
      lane1Top: $('calLane1Top').checked,
      direction: $('direction').value,
    });
    Store.setCalibration(Camera.getCalibration());   // include i bordi aggiornati
  }
  ['calFinishX','calLaneTop','calLaneBottom','calNLanes','calLane1Top']
    .forEach(id => $(id).addEventListener('input', applyCalibration));

  function loadCalibrationUI() {
    const c = Store.getCalibration();
    $('calFinishX').value    = Math.round(c.finishX * 100);
    $('calLaneTop').value    = Math.round((c.laneEdges ? c.laneEdges[0] : c.laneTop) * 100);
    $('calLaneBottom').value = Math.round((c.laneEdges ? c.laneEdges[c.laneEdges.length - 1] : c.laneBottom) * 100);
    $('calNLanes').value     = c.nLanes;
    $('calLane1Top').checked = c.lane1Top;
    $('calQuality').value    = Store.getQuality();
    $('calMode').value       = Store.getDetectMode();
    $('calSensitivity').value = Store.getLineSensitivity();
  }

  // trascinamento linee sul video -> persisti e aggiorna gli slider
  Camera.onCalChange((cal) => {
    Store.setCalibration(cal);
    $('calFinishX').value = Math.round(cal.finishX * 100);
    if (cal.laneEdges && cal.laneEdges.length) {
      $('calLaneTop').value    = Math.round(cal.laneEdges[0] * 100);
      $('calLaneBottom').value = Math.round(cal.laneEdges[cal.laneEdges.length - 1] * 100);
    }
  });

  let editLines = false;
  function toggleEdit() {
    editLines = !editLines;
    Camera.setEditMode(editLines);
    const b = $('btnEditLines');
    b.textContent = editLines ? '✓ Fine modifica' : '✏️ Modifica linee';
    b.classList.toggle('editing', editLines);
  }

  // ---- diagnostica live ----
  Camera.onDiagChange(({ fps, detected, armed }) => {
    $('diagFps').textContent = fps;
    $('diagDet').textContent = detected;
    $('diagArmed').textContent = armed ? 'ON' : 'off';
    $('diagArmed').className = armed ? 'on' : '';
  });

  // ---- registrazione clip arrivo (MediaRecorder) ----
  let recorder = null, recChunks = [];
  function recStart() {
    const stream = Camera.getStream();
    if (!stream) { alert('Avvia prima la fotocamera.'); return; }
    recChunks = [];
    const mime = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm';
    try { recorder = new MediaRecorder(stream, { mimeType: mime }); }
    catch (e) { recorder = new MediaRecorder(stream); }
    recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: recorder.mimeType });
      const url = URL.createObjectURL(blob);
      const ext = recorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
      const a = document.createElement('a');
      a.href = url; a.download = 'arrivo_' + Date.now() + '.' + ext;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    };
    recorder.start();
    $('btnRec').disabled = true; $('btnRecStop').disabled = false;
  }
  function recStop() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    $('btnRec').disabled = false; $('btnRecStop').disabled = true;
  }

  // ---- wake lock (schermo sempre acceso in pista) ----
  let wakeLock = null;
  async function acquireWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) {}
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(()=>{}); wakeLock = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('btnCamStop') && !$('btnCamStop').disabled) acquireWakeLock();
  });

  // ===================== EVENTI =====================
  $('btnMarks').addEventListener('click', onMarks);
  $('btnSet').addEventListener('click', onSet);
  $('btnFinish').addEventListener('click', onManualFinish);
  $('btnReset').addEventListener('click', () => resetRun(true));
  $('btnSaveRun').addEventListener('click', saveRun);
  $('btnExport').addEventListener('click', exportCSV);
  $('btnExport2').addEventListener('click', exportCSV);
  $('btnClearAll').addEventListener('click', () => {
    if (confirm('Cancellare tutte le run salvate? Operazione non annullabile.')) {
      Store.clearRuns();
      renderStorico();
    }
  });
  $('btnCamStart').addEventListener('click', camStart);
  $('btnCamStop').addEventListener('click', camStop);
  $('btnRec').addEventListener('click', recStart);
  $('btnRecStop').addEventListener('click', recStop);
  $('btnEditLines').addEventListener('click', toggleEdit);
  $('btnRedistribute').addEventListener('click', applyCalibration);
  $('calQuality').addEventListener('change', (e) => {
    Store.setQuality(e.target.value);
    Camera.setCaptureQuality(e.target.value);
    $('camStatus').textContent = 'Qualità impostata: spegni e riaccendi la fotocamera per applicarla.';
  });
  $('calMode').addEventListener('change', (e) => {
    Store.setDetectMode(e.target.value);
    Camera.setDetectMode(e.target.value);
    $('camStatus').textContent = 'Modalità cambiata: spegni e riaccendi la fotocamera per applicarla.';
  });
  $('calSensitivity').addEventListener('input', (e) => {
    Store.setLineSensitivity(+e.target.value);
    Camera.setLineSensitivity(+e.target.value);   // applicata subito, niente riavvio
  });

  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
  }

  // init
  $('distance').value = Store.get().distance;
  $('direction').value = Store.get().direction;
  // carica la calibrazione salvata NELLA camera (inclusi i bordi per-corsia)
  Camera.setCalibration({ ...Store.getCalibration(), direction: Store.get().direction });
  Camera.setCaptureQuality(Store.getQuality());
  Camera.setDetectMode(Store.getDetectMode());
  Camera.setLineSensitivity(Store.getLineSensitivity());
  loadCalibrationUI();
  renderAthletes();
  resetRun(true);
})();
