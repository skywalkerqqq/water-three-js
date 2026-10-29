// Procedural ambient audio — ocean surf + wind, generated entirely with
// WebAudio (no asset files). White noise through a breathing low-pass makes the
// surf; pink noise through a band-pass makes the breeze. Both track the sea
// state from main.js so a storm genuinely sounds bigger than a calm afternoon.
//
// Autoplay policy: the AudioContext can only start from a user gesture, so the
// GUI toggle calls start() (a click) — and update() is a no-op until then.
export class AmbientAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.master = null;
    this.waveGain = null;
    this.windGain = null;
    this._lfo = null;
  }

  // Create (or resume) the graph. Must be reached from a user gesture.
  start() {
    if (this.ctx) { this.ctx.resume(); this.enabled = true; this._fadeIn(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);

    // --- Surf: looping white noise → low-pass, whose loudness "breathes" ---
    const wave = ctx.createBufferSource();
    wave.buffer = makeNoise(ctx, 4, 'white');
    wave.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 0.6;
    this.waveGain = ctx.createGain();
    this.waveGain.gain.value = 0.5;
    wave.connect(lp); lp.connect(this.waveGain); this.waveGain.connect(this.master);
    wave.start();

    // Slow LFO = the rise and fall of each wave set arriving at the beach.
    this._lfo = ctx.createOscillator();
    this._lfo.frequency.value = 0.09;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.35;
    this._lfo.connect(lfoDepth); lfoDepth.connect(this.waveGain.gain);
    this._lfo.start();

    // --- Wind: pink noise → band-pass, quiet & steady ---
    const wind = ctx.createBufferSource();
    wind.buffer = makeNoise(ctx, 4, 'pink');
    wind.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 480;
    bp.Q.value = 0.4;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.10;
    wind.connect(bp); bp.connect(this.windGain); this.windGain.connect(this.master);
    wind.start();

    this.enabled = true;
    this._fadeIn();
  }

  _fadeIn() {
    if (!this.ctx) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0.7, this.ctx.currentTime + 1.2);
  }

  stop() {
    if (!this.ctx || !this.enabled) return;
    this.enabled = false;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0.0, this.ctx.currentTime + 0.5);
  }

  // Sea-state tracking: louder surf + stronger wind as the waves build.
  update(amplitude, windSpeed) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const storm = Math.min(1, amplitude / 2.0);
    this.waveGain.gain.setTargetAtTime(0.4 + 0.9 * storm, t, 0.4);
    this.windGain.gain.setTargetAtTime(0.06 + 0.24 * Math.min(1, windSpeed / 18), t, 0.4);
    if (this._lfo) this._lfo.frequency.setTargetAtTime(0.06 + 0.14 * storm, t, 0.5);
  }
}

function makeNoise(ctx, seconds, type) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  if (type === 'pink') {
    // Paul Kellet's refined pink-noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return buf;
}
