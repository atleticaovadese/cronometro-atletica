/* audio.js — Sequenza di partenza atletica con controllo manuale.
 *
 * Flusso voluto dall'allenatore:
 *   1) "Ai vostri posti"      (sayMarks)
 *   2) [l'allenatore controlla che gli atleti siano fermi sui blocchi e dà OK]
 *   3) "Pronti" -> dopo intervallo randomizzato -> SPARO   (armSetAndGun)
 *
 * - Voce: SpeechSynthesis (italiano).
 * - Sparo: burst di rumore sintetico via Web Audio (nessun file esterno).
 * - Il t0 del cronometro è preso ESATTAMENTE quando parte lo sparo,
 *   con performance.now() (stesso orologio di requestVideoFrameCallback).
 */

const StartSequence = (() => {
  let audioCtx = null;
  let aborted = false;
  let gunTimer = null;

  function ensureCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  // Sblocca audio + voce su iOS (va chiamato dentro un gesto utente).
  function unlock() {
    ensureCtx();
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance('');
      window.speechSynthesis.speak(u);
    }
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'it-IT';
    u.rate = 0.95;
    const itVoice = window.speechSynthesis.getVoices().find(v => v.lang && v.lang.startsWith('it'));
    if (itVoice) u.voice = itVoice;
    window.speechSynthesis.speak(u);
  }

  // "Sparo" sintetico forte e secco: crack di rumore + boom a bassa freq,
  // con compressore + guadagno per massima udibilità su cassa Bluetooth.
  function playShot() {
    const ctx = ensureCtx();
    const t = ctx.currentTime;

    // master: compressore (alza il volume percepito) + gain alto
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -28; comp.ratio.value = 12;
    comp.attack.value = 0.001; comp.release.value = 0.1;
    const master = ctx.createGain();
    master.gain.value = 4.0;            // volume elevato (un colpo deve "spaccare")
    comp.connect(master).connect(ctx.destination);

    // 1) crack: rumore bianco con decadimento rapidissimo
    const dur = 0.25;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const decay = Math.pow(1 - i / d.length, 3);
      d[i] = (Math.random() * 2 - 1) * decay;
    }
    const noise = ctx.createBufferSource(); noise.buffer = buf;
    const ng = ctx.createGain(); ng.gain.value = 1.0;
    noise.connect(ng).connect(comp);
    noise.start(t);

    // 2) boom: sinusoide bassa che scende, dà "corpo" allo sparo
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(1.0, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(og).connect(comp);
    osc.start(t); osc.stop(t + 0.2);
  }

  // Passo 1: "Ai vostri posti"
  function sayMarks(opt = {}) {
    aborted = false;
    ensureCtx();
    if (opt.voice !== false) speak('Ai vostri posti');
  }

  /**
   * Passo 2 (dopo l'OK dell'allenatore): "Pronti" -> sparo randomizzato.
   * @param {Object} opt
   * @param {number} opt.setMin  min secondi Pronti->sparo
   * @param {number} opt.setMax  max secondi Pronti->sparo
   * @param {boolean} opt.voice  comandi vocali on/off
   * @param {Function} opt.onShot  callback(t0) all'istante dello sparo
   * @returns {{plannedSetToGun:number}}
   */
  function armSetAndGun(opt) {
    aborted = false;
    ensureCtx();
    const min = opt.setMin ?? 1.5;
    const max = Math.max(opt.setMax ?? 2.5, min);
    const setToGun = (min + Math.random() * (max - min)) * 1000;

    if (opt.voice !== false) speak('Pronti');

    gunTimer = setTimeout(() => {
      if (aborted) return;
      const t0 = performance.now();
      playShot();
      if (opt.onShot) opt.onShot(t0);
    }, setToGun);

    return { plannedSetToGun: setToGun / 1000 };
  }

  function abort() {
    aborted = true;
    if (gunTimer) { clearTimeout(gunTimer); gunTimer = null; }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  return { unlock, sayMarks, armSetAndGun, abort, playShot };
})();
