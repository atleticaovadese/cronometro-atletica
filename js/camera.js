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

  // diagnostica fps
  let fpsEma = 0, lastFrameT = 0, lastDiagT = 0;

  // Calibrazione (valori normalizzati 0..1)
  let cal = {
    finishX: 0.5,
    laneTop: 0.25,
    laneBottom: 0.95,
    nLanes: 6,
    lane1Top: true,          // true: corsia 1 in alto nell'immagine
    direction: 'rtl',        // verso di corsa: 'ltr' o 'rtl'
  };

  // tracking per-atleta
  let tracks = new Map();    // id -> {prevX, prevY, prevT}
  let recorded = new Set();  // id già registrati in questo run

  const KP = {}; // mappa nome->indice (popolata al primo frame)

  function setStatus(s) { onStatus(s); }

  async function loadModel() {
    if (detector) return;
    setStatus('Carico il modello di rilevamento…');
    await tf.setBackend('webgl');
    await tf.ready();
    detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      {
        modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
        enableTracking: true,
        trackerType: poseDetection.TrackerType.BoundingBox,
      }
    );
    setStatus('Modello pronto.');
  }

  async function start(videoEl, canvasEl) {
    video = videoEl; canvas = canvasEl; ctx = canvas.getContext('2d');
    setStatus('Avvio fotocamera…');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },   // chiediamo 60; il browser può dare 30
      },
    });
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const s = track.getSettings ? track.getSettings() : {};
    setStatus(`Camera attiva ${s.width||'?'}×${s.height||'?'} @ ${s.frameRate||'?'}fps`);

    await loadModel();
    running = true;
    loop();
  }

  function stop() {
    running = false; armed = false;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (video) video.srcObject = null;
  }

  function setCalibration(partial) { Object.assign(cal, partial); }
  function getCalibration() { return { ...cal }; }

  function arm(startT0, finishCb) {
    t0 = startT0; onFinish = finishCb;
    tracks.clear(); recorded.clear();
    armed = true;
    setStatus('Rilevamento arrivi ATTIVO.');
  }
  function disarm() { armed = false; setStatus('Rilevamento in pausa.'); }
  function isArmed() { return armed; }

  // corsia dalla posizione verticale normalizzata
  function laneFromY(y) {
    if (y < cal.laneTop || y > cal.laneBottom) return null;
    const f = (y - cal.laneTop) / (cal.laneBottom - cal.laneTop);
    let idx = Math.floor(f * cal.nLanes); // 0..nLanes-1
    idx = Math.max(0, Math.min(cal.nLanes - 1, idx));
    return cal.lane1Top ? idx + 1 : cal.nLanes - idx;
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

  async function processFrame(now) {
    if (!detector || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight;

    // fps reali (media esponenziale)
    if (lastFrameT) {
      const inst = 1000 / Math.max(1, now - lastFrameT);
      fpsEma = fpsEma ? fpsEma * 0.85 + inst * 0.15 : inst;
    }
    lastFrameT = now;

    let poses = [];
    try {
      poses = await detector.estimatePoses(video, { maxPoses: 6, flipHorizontal: false });
    } catch (e) { return; }

    // disegna overlay
    drawOverlay(poses, vw, vh);

    // diagnostica ~5 volte/sec
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

    // banda corsie
    ctx.strokeStyle = 'rgba(76,201,240,.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= cal.nLanes; i++) {
      const y = (cal.laneTop + (cal.laneBottom - cal.laneTop) * i / cal.nLanes) * H;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    // linea traguardo
    ctx.strokeStyle = '#ff5d73';
    ctx.lineWidth = 4;
    const fx = cal.finishX * W;
    ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, H); ctx.stroke();

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

  return { start, stop, setCalibration, getCalibration, arm, disarm, isArmed, getStream,
           onStatusChange: (cb) => { onStatus = cb; },
           onDiagChange: (cb) => { onDiag = cb; } };
})();
