/* camera.js — fotocamera + MoveNet MultiPose + rilevamento arrivo.
 *
 * Vista LATERALE: il telefono è di lato, allineato al traguardo.
 * - Calibrazione: linea del traguardo (X) + banda delle corsie (Y alto/basso).
 * - Rilevamento: MoveNet MultiPose individua fino a 6 atleti; per ciascuno si
 *   segue il centro del busto. Quando il busto attraversa la linea del traguardo
 *   si registra il tempo (interpolato tra due fotogrammi -> precisione migliore
 *   del singolo frame) e la corsia (dalla posizione verticale).
 *
 * Riferimento tempo: requestVideoFrameCallback fornisce 'now' nello stesso
 * orologio di performance.now(), quindi elapsed = frameNow - t0(sparo).
 */

const Camera = (() => {
  let video, canvas, ctx;
  let detector = null;
  let stream = null;
  let running = false;       // loop rVFC attivo
  let armed = false;         // rilevamento arrivi attivo
  let t0 = null;
  let onFinish = null;
  let onStatus = () => {};
  let onDiag = () => {};
  let onCal = () => {};       // chiamata quando la calibrazione cambia (drag)

  // diagnostica fps
  let fpsEma = 0, lastFrameT = 0, lastDiagT = 0;

  // qualità cattura ('fast' = più fps, 'hd' = più dettaglio)
  let quality = 'fast';

  // modalità rilevamento: 'ai' (MoveNet) | 'line' (striscia di pixel, veloce)
  let detectMode = 'ai';
  let lineSensitivity = 30;
  let pcanvas = null, pctx = null, prevGray = null;
  let lastTrig = [], lineTriggers = 0;
  const PW = 192, PH = 144, STRIP = 2;   // buffer di analisi + semilarghezza striscia

  // calibrazione interattiva
  let editing = false;
  let dragTarget = null;     // {type:'finish'} | {type:'edge', i}

  // Calibrazione (valori normalizzati 0..1)
  let cal = {
    finishX: 0.5,
    laneTop: 0.25,
    laneBottom: 0.95,
    nLanes: 6,
    lane1Top: true,          // true: corsia 1 in alto nell'immagine
    direction: 'rtl',        // verso di corsa: 'ltr' o 'rtl'
    laneEdges: null,         // bordi per-corsia (lung. nLanes+1); null = ricalcola uguali
  };

  // ricalcola i bordi corsia in modo uniforme tra laneTop e laneBottom
  function redistribute() {
    const n = cal.nLanes, t = cal.laneTop, b = cal.laneBottom;
    cal.laneEdges = Array.from({ length: n + 1 }, (_, i) => t + (b - t) * i / n);
  }

  // tracking per-atleta
  let tracks = new Map();    // id -> {prevX, prevY, prevT}
  let recorded = new Set();  // id già registrati in questo run

  const KP = {}; // mappa nome->indice (popolata al primo frame)

  function setStatus(s) { onStatus(s); }

  async function pickBackend() {
    // WebGPU è più veloce dove supportato (iPhone recenti); fallback a WebGL
    for (const b of ['webgpu', 'webgl']) {
      try { if (await tf.setBackend(b)) { await tf.ready(); return b; } } catch (e) {}
    }
    await tf.ready();
    return tf.getBackend();
  }

  async function loadModel() {
    if (detector) return;
    setStatus('Carico il modello di rilevamento…');
    const backend = await pickBackend();
    setStatus('Backend: ' + backend + ' — carico il modello…');
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
        enableTracking: true,
        trackerType: poseDetection.TrackerType.BoundingBox,
      }
    );
    setStatus('Pronto · backend ' + tf.getBackend());
  }

  async function start(videoEl, canvasEl) {
    video = videoEl; canvas = canvasEl; ctx = canvas.getContext('2d');
    if (!canvas._calBound) {
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
      canvas._calBound = true;
    }
    setStatus('Avvio fotocamera…');
    // risoluzione più bassa = analisi AI più veloce = più fps
    const res = quality === 'hd' ? { w: 1280, h: 720 } : { w: 480, h: 270 };
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: res.w },
        height: { ideal: res.h },
        frameRate: { ideal: 60 },   // chiediamo 60; il browser può dare meno
      },
    });
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const s = track.getSettings ? track.getSettings() : {};
    setStatus(`Camera attiva ${s.width||'?'}×${s.height||'?'} @ ${s.frameRate||'?'}fps`);

    if (detectMode === 'ai') {
      await loadModel();
    } else {
      setStatus('Modalità LINEA (veloce) · nessun modello AI da caricare');
    }
    running = true;
    loop();
  }

  function stop() {
    running = false; armed = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (video) video.srcObject = null;
  }

  function setCalibration(partial) {
    Object.assign(cal, partial);
    if (partial.laneEdges) { cal.laneEdges = partial.laneEdges.slice(); return; }
    // se cambiano banda o numero corsie (o non esistono bordi), ridistribuisci
    if ('laneTop' in partial || 'laneBottom' in partial || 'nLanes' in partial || !cal.laneEdges) {
      redistribute();
    }
  }
  function getCalibration() { return { ...cal, laneEdges: cal.laneEdges ? cal.laneEdges.slice() : null }; }
  function setCaptureQuality(q) { quality = q; }

  function arm(startT0, finishCb) {
    t0 = startT0; onFinish = finishCb;
    tracks.clear(); recorded.clear();
    prevGray = null; lastTrig = []; lineTriggers = 0;   // reset modalità linea
    armed = true;
    setStatus('Rilevamento arrivi ATTIVO.');
  }
  function disarm() { armed = false; setStatus('Rilevamento in pausa.'); }
  function isArmed() { return armed; }

  // corsia dalla posizione verticale normalizzata (bordi per-corsia)
  function laneFromY(y) {
    const e = cal.laneEdges;
    if (!e || e.length < 2) return null;
    if (y < e[0] || y > e[e.length - 1]) return null;
    let idx = 0;
    for (let i = 0; i < e.length - 1; i++) {
      if (y >= e[i] && y < e[i + 1]) { idx = i; break; }
      if (i === e.length - 2) idx = i; // bordo inferiore incluso
    }
    return cal.lane1Top ? idx + 1 : (e.length - 1 - idx);
  }

  // ---- MODALITÀ LINEA: differenza di pixel su una striscia al traguardo ----
  // Per ogni corsia misura quanto cambia la striscia tra due fotogrammi; un picco
  // = qualcuno sta attraversando. Niente rete neurale -> gira agli fps della camera.
  function lineDetect(now) {
    if (!pcanvas) {
      pcanvas = document.createElement('canvas');
      pcanvas.width = PW; pcanvas.height = PH;
      pctx = pcanvas.getContext('2d', { willReadFrequently: true });
    }
    pctx.drawImage(video, 0, 0, PW, PH);          // frame intero "stirato" nel buffer
    const data = pctx.getImageData(0, 0, PW, PH).data;

    const cx = Math.round(cal.finishX * PW);
    const x0 = Math.max(0, cx - STRIP), x1 = Math.min(PW - 1, cx + STRIP);

    // luminanza media della striscia, riga per riga
    const cur = new Float32Array(PH);
    for (let r = 0; r < PH; r++) {
      let s = 0, c = 0;
      for (let x = x0; x <= x1; x++) {
        const idx = (r * PW + x) * 4;
        s += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114; c++;
      }
      cur[r] = s / c;
    }

    if (prevGray && armed && t0 !== null) {
      const e = cal.laneEdges || [];
      for (let i = 0; i < e.length - 1; i++) {
        const r0 = Math.max(0, Math.floor(e[i] * PH));
        const r1 = Math.min(PH, Math.ceil(e[i + 1] * PH));
        let diff = 0, n = 0;
        for (let r = r0; r < r1; r++) { diff += Math.abs(cur[r] - prevGray[r]); n++; }
        const act = n ? diff / n : 0;
        const lane = cal.lane1Top ? i + 1 : (e.length - 1 - i);
        const last = lastTrig[lane] || 0;
        // fronte di salita oltre soglia + tempo morto per corsia (no doppioni)
        if (act > lineSensitivity && (now - last) > 600) {
          lastTrig[lane] = now;
          lineTriggers++;
          if (onFinish) onFinish({ lane, time: now - t0 });
        }
      }
    }
    prevGray = cur;
  }

  // centro busto (media spalle+anche) in coord normalizzate; null se incerto
  function torso(kps, vw, vh) {
    const need = ['left_shoulder','right_shoulder','left_hip','right_hip'];
    let sx = 0, sy = 0, n = 0;
    for (const name of need) {
      const k = kps.find(p => p.name === name);
      if (k && k.score > 0.3) { sx += k.x; sy += k.y; n++; }
    }
    if (n < 2) return null;
    return { x: (sx / n) / vw, y: (sy / n) / vh };
  }

  function detectCrossing(prev, cur, now, prevT) {
    const fx = cal.finishX;
    const a = prev.x, b = cur.x;
    let crossed = false;
    if (cal.direction === 'ltr') crossed = a < fx && b >= fx;
    else                          crossed = a > fx && b <= fx;
    if (!crossed) return null;
    // interpolazione sub-frame
    const denom = (b - a) || 1e-6;
    const frac = (fx - a) / denom;        // 0..1
    const crossT = prevT + frac * (now - prevT);
    const crossY = prev.y + frac * (cur.y - prev.y);
    return { crossT, crossY };
  }

  function calcFps(now) {
    if (lastFrameT) {
      const inst = 1000 / Math.max(1, now - lastFrameT);
      fpsEma = fpsEma ? fpsEma * 0.85 + inst * 0.15 : inst;
    }
    lastFrameT = now;
  }

  async function processFrame(now) {
    if (!video.videoWidth) return;
    calcFps(now);
    const vw = video.videoWidth, vh = video.videoHeight;

    // --- MODALITÀ LINEA (veloce, senza AI) ---
    if (detectMode === 'line') {
      lineDetect(now);
      drawOverlay([], vw, vh);
      if (now - lastDiagT > 200) {
        lastDiagT = now;
        onDiag({ fps: Math.round(fpsEma), detected: lineTriggers, armed });
      }
      return;
    }

    // --- MODALITÀ AI (MoveNet) ---
    if (!detector) return;
    let poses = [];
    try {
      poses = await detector.estimatePoses(video, { maxPoses: 6, flipHorizontal: false });
    } catch (e) { return; }

    drawOverlay(poses, vw, vh);

    if (now - lastDiagT > 200) {
      lastDiagT = now;
      const detected = poses.filter(p => torso(p.keypoints, vw, vh)).length;
      onDiag({ fps: Math.round(fpsEma), detected, armed });
    }

    if (!armed || t0 === null) return;

    for (const pose of poses) {
      const id = pose.id ?? -1;
      const c = torso(pose.keypoints, vw, vh);
      if (!c) continue;
      const prev = tracks.get(id);
      if (prev && !recorded.has(id)) {
        const cr = detectCrossing(prev, c, now, prev.prevT);
        if (cr) {
          const lane = laneFromY(cr.crossY);
          const elapsed = cr.crossT - t0;   // ms
          recorded.add(id);
          if (onFinish) onFinish({ lane, time: elapsed });
        }
      }
      tracks.set(id, { x: c.x, y: c.y, prevT: now });
    }
  }

  function drawOverlay(poses, vw, vh) {
    const W = canvas.width = canvas.clientWidth;
    const H = canvas.height = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const edges = cal.laneEdges || [];
    // righe di confine corsia + (in modalità modifica) maniglie + numero corsia
    for (let i = 0; i < edges.length; i++) {
      const y = edges[i] * H;
      ctx.strokeStyle = 'rgba(76,201,240,.7)';
      ctx.lineWidth = (dragTarget && dragTarget.type === 'edge' && dragTarget.i === i) ? 4 : 1.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      if (editing) {
        ctx.fillStyle = '#4cc9f0';
        ctx.beginPath(); ctx.arc(22, y, 11, 0, Math.PI * 2); ctx.fill();
      }
    }
    // numero corsia al centro di ogni banda
    ctx.font = 'bold 15px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(76,201,240,.9)';
    for (let i = 0; i < edges.length - 1; i++) {
      const yc = (edges[i] + edges[i + 1]) / 2 * H;
      const laneNum = cal.lane1Top ? i + 1 : (edges.length - 1 - i);
      ctx.fillText('C' + laneNum, W - 36, yc + 5);
    }
    // linea traguardo (+ maniglia in alto se in modifica)
    const fx = cal.finishX * W;
    ctx.strokeStyle = '#ff5d73';
    ctx.lineWidth = (dragTarget && dragTarget.type === 'finish') ? 6 : 4;
    ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, H); ctx.stroke();
    if (editing) {
      ctx.fillStyle = '#ff5d73';
      ctx.beginPath(); ctx.arc(fx, 22, 11, 0, Math.PI * 2); ctx.fill();
    }
    // striscia di analisi (modalità linea)
    if (detectMode === 'line') {
      const sw = ((STRIP * 2 + 1) / PW) * W;
      ctx.fillStyle = 'rgba(255,93,115,.20)';
      ctx.fillRect(fx - sw / 2, 0, sw, H);
    }

    // atleti (centro busto) + corsia assegnata (verifica calibrazione dal vivo)
    ctx.font = 'bold 18px -apple-system, sans-serif';
    for (const pose of poses) {
      const c = torso(pose.keypoints, vw, vh);
      if (!c) continue;
      const px = c.x * W, py = c.y * H;
      const lane = laneFromY(c.y);
      ctx.fillStyle = lane ? '#43e97b' : '#ffd166';
      ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill();
      const label = lane ? ('C' + lane) : '?';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.7)';
      ctx.strokeText(label, px + 12, py - 8);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, px + 12, py - 8);
    }
  }

  // ---- calibrazione interattiva (trascina linee sul video) ----
  function evToNorm(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  function pickTarget(p) {
    const edges = cal.laneEdges || [];
    let best = null, bestD = 0.06;       // tolleranza tocco
    if (Math.abs(p.x - cal.finishX) < bestD) { best = { type: 'finish' }; bestD = Math.abs(p.x - cal.finishX); }
    for (let i = 0; i < edges.length; i++) {
      const d = Math.abs(p.y - edges[i]);
      if (d < bestD) { best = { type: 'edge', i }; bestD = d; }
    }
    return best;
  }
  function onDown(e) { if (!editing) return; e.preventDefault(); dragTarget = pickTarget(evToNorm(e)); }
  function onMove(e) {
    if (!editing || !dragTarget) return;
    e.preventDefault();
    const p = evToNorm(e);
    if (dragTarget.type === 'finish') {
      cal.finishX = p.x;
    } else {
      const ed = cal.laneEdges, i = dragTarget.i;
      const lo = i > 0 ? ed[i - 1] + 0.01 : 0;
      const hi = i < ed.length - 1 ? ed[i + 1] - 0.01 : 1;
      ed[i] = Math.max(lo, Math.min(hi, p.y));
      cal.laneTop = ed[0]; cal.laneBottom = ed[ed.length - 1];
    }
  }
  function onUp() { if (!editing || !dragTarget) return; dragTarget = null; onCal(getCalibration()); }
  function setEditMode(b) { editing = b; if (canvas) canvas.style.pointerEvents = b ? 'auto' : 'none'; }

  function loop() {
    if (!running) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      video.requestVideoFrameCallback((now) => {
        processFrame(now).finally(loop);
      });
    } else {
      // fallback: rAF (timestamp comunque su performance.now)
      requestAnimationFrame((now) => { processFrame(now).finally(loop); });
    }
  }

  function getStream() { return stream; }
  function setDetectMode(m) { detectMode = m; }
  function setLineSensitivity(v) { lineSensitivity = v; }

  return { start, stop, setCalibration, getCalibration, setCaptureQuality,
           setEditMode, setDetectMode, setLineSensitivity,
           arm, disarm, isArmed, getStream,
           onStatusChange: (cb) => { onStatus = cb; },
           onDiagChange: (cb) => { onDiag = cb; },
           onCalChange: (cb) => { onCal = cb; } };
})();
