// NYAN ψ — ∀ GATO ∃ UN RIVAL
// Two-player math-cat fighter. Port of nyan_psi sketch into the Platanus arcade harness.

const W = 800, H = 600, FLOOR = 528;

// DO NOT replace existing keys — they match the physical arcade cabinet wiring.
const CABINET_KEYS = {
  P1_U: ['w'], P1_D: ['s'], P1_L: ['a'], P1_R: ['d'],
  P1_1: ['u'], P1_2: ['i'], P1_3: ['o'], P1_4: ['j'], P1_5: ['k'], P1_6: ['l'],
  P2_U: ['ArrowUp'], P2_D: ['ArrowDown'], P2_L: ['ArrowLeft'], P2_R: ['ArrowRight'],
  P2_1: ['r'], P2_2: ['t'], P2_3: ['y'], P2_4: ['f'], P2_5: ['g'], P2_6: ['h'],
  START1: ['Enter'], START2: ['2'],
};

const KEY_TO_ARCADE = {};
for (const [code, keys] of Object.entries(CABINET_KEYS)) {
  for (const k of keys) KEY_TO_ARCADE[k.toLowerCase()] = code;
}

function boot() {
  const root = document.getElementById('game-root') || document.body;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:#04000e;';
  root.appendChild(canvas);
  ctx = canvas.getContext('2d');
  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  let last = 0;
  function loop(ts) {
    const ds = last ? Math.min((ts - last) / 1000, 0.05) : 0;
    last = ts;
    T += ds;
    handleInput();
    if (sceneName === 'select') drawSelect();
    else if (sceneName === 'fight' && fight) {
      if (!fight.rOver) updateFight(fight, ds);
      drawFight(fight);
    } else if (sceneName === 'win') drawWin();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

let ctx;
let T = 0;
let sceneName = 'select';
let fight = null;
let winData = { winner: 0, ci: [0, 1] };
let winEnterT = 0;
const controls = { held: Object.create(null), pressed: Object.create(null) };
const sel = { cursor: [0, 3], confirmed: [false, false], chosen: [-1, -1] };

// ── AUDIO ──────────────────────────────────────────────────────
let AC, MG;
function initAudio() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    MG = AC.createGain(); MG.gain.value = 0.25; MG.connect(AC.destination);
  } catch (_) {}
}
function tone(f, type, dur, vol, slide) {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(f, AC.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, AC.currentTime + dur);
  g.gain.setValueAtTime(vol || 0.15, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + dur);
  o.connect(g); g.connect(MG); o.start(); o.stop(AC.currentTime + dur);
}
function mkN(d) {
  const n = Math.ceil(AC.sampleRate * d), b = AC.createBuffer(1, n, AC.sampleRate), a = b.getChannelData(0);
  for (let i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 1.5);
  return b;
}
function nFX(hp, dur, vol) {
  if (!AC) return;
  const s = AC.createBufferSource(), g = AC.createGain(), f = AC.createBiquadFilter();
  f.type = 'highpass'; f.frequency.value = hp;
  s.buffer = mkN(dur); s.connect(f); f.connect(g); g.connect(MG);
  g.gain.setValueAtTime(vol, AC.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + dur);
  s.start(); s.stop(AC.currentTime + dur);
}
const sSelect = () => tone(440, 'sine', 0.08, 0.12, 560);
const sConfirm = () => { tone(440, 'square', 0.06, 0.1); setTimeout(() => tone(660, 'square', 0.08, 0.12), 80); setTimeout(() => tone(880, 'sine', 0.12, 0.15), 160); };
const sShoot = (f) => tone(f || 300, 'square', 0.06, 0.08, f ? f * 1.4 : 500);
const sMeow = (p) => tone(p || 380, 'sawtooth', 0.18, 0.12, p ? p * 0.65 : 250);
const sHit = () => { nFX(700, 0.09, 0.25); tone(100, 'sine', 0.08, 0.18); };
const sPeak = () => tone(880, 'sine', 0.1, 0.16, 1400);
const sRound = () => { tone(220, 'square', 0.08, 0.2); setTimeout(() => tone(440, 'square', 0.12, 0.2), 100); setTimeout(() => tone(660, 'sine', 0.18, 0.22), 200); };

// ── ELECTRIC GUITAR RIFF SYNTH ──
// Saw oscillator → WaveShaper (soft-clip distortion) → lowpass tone → envelope.
// Pick attack = brief filtered noise burst. Power chord = 3 stacked notes (root+5th+octave).
let DIST_CURVE;
function distCurve() {
  if (DIST_CURVE) return DIST_CURVE;
  const n = 512, c = new Float32Array(n), k = 55;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    c[i] = ((3 + k) * x * 20 * Math.PI / 180) / (Math.PI + k * Math.abs(x));
  }
  DIST_CURVE = c;
  return DIST_CURVE;
}
// Single distorted guitar note
function gNote(freq, dur, vol, opts) {
  if (!AC) return;
  const now = AC.currentTime, o = opts || {}, t0 = now + (o.offset || 0);
  const out = o.dest || MG;
  // Pick attack: short highpass noise burst
  if (o.pick !== false) {
    const p = AC.createBufferSource(), pf = AC.createBiquadFilter(), pg = AC.createGain();
    pf.type = 'highpass'; pf.frequency.value = 1800;
    p.buffer = mkN(0.02); p.connect(pf); pf.connect(pg); pg.connect(out);
    pg.gain.setValueAtTime(o.pickVol || 0.18, t0);
    pg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.025);
    p.start(t0); p.stop(t0 + 0.03);
  }
  const osc = AC.createOscillator();
  osc.type = 'sawtooth'; osc.frequency.setValueAtTime(freq, t0);
  if (o.bend) osc.frequency.linearRampToValueAtTime(o.bend, t0 + (o.bendT || dur * 0.5));
  if (o.vib) {
    const lfo = AC.createOscillator(), lg = AC.createGain();
    lfo.frequency.value = 5.5; lg.gain.setValueAtTime(0, t0);
    lg.gain.linearRampToValueAtTime(o.vib, t0 + dur * 0.25);
    lfo.connect(lg); lg.connect(osc.frequency);
    lfo.start(t0); lfo.stop(t0 + dur + 0.02);
  }
  // Pre-gain to push into the clipper
  const preG = AC.createGain(); preG.gain.value = o.drive || 4;
  const shaper = AC.createWaveShaper();
  shaper.curve = distCurve(); shaper.oversample = '2x';
  // Tone: lowpass + slight midrange bandpass for that "cocked wah" rock tone
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass';
  lp.frequency.value = o.tone || 2800; lp.Q.value = 0.7;
  const mid = AC.createBiquadFilter(); mid.type = 'peaking';
  mid.frequency.value = 1100; mid.Q.value = 1.2; mid.gain.value = 6;
  // Amp env
  const g = AC.createGain();
  g.gain.setValueAtTime(0.001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.005);
  g.gain.linearRampToValueAtTime(vol * 0.85, t0 + dur * 0.7);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(preG); preG.connect(shaper); shaper.connect(mid); mid.connect(lp); lp.connect(g); g.connect(out);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
// Power chord: root + 5th (×1.498) + octave, each with its own pick
function pChord(root, dur, vol, opts) {
  gNote(root, dur, vol * 0.75, opts);
  gNote(root * 1.498, dur, vol * 0.65, opts);
  gNote(root * 2, dur, vol * 0.5, opts);
}

// Round win: ascending A-minor-pentatonic bell flourish. Same FM-bell timbre as the
// battle ambient so the round-win statement feels like the ambient "gathering" into a phrase.
function sRiffRound() {
  if (!AC) return;
  bellNote(440,    0.22, 1.2, 0);       // A4
  bellNote(523.25, 0.24, 1.2, 0.09);    // C5
  bellNote(659.25, 0.26, 1.2, 0.18);    // E5
  bellNote(880,    0.32, 3.8, 0.3);     // A5 — sustained climax
  bellNote(440,    0.14, 3.8, 0.3);     // A4 octave-below layer for body
}
// Match win: cursed bell toll. Descending tritone pairs (A ↔ Eb = diabolus in
// musica) ending on a sustained low cluster of A + Eb = unresolved dread.
// Same FM-bell timbre as the ambient, but the tritone intervals turn it malevolent.
function sRiffMatch() {
  if (!AC) return;
  bellNote(880,    0.26, 2.2, 0);     // A5
  bellNote(622.25, 0.23, 2.2, 0.15);  // Eb5 (tritone below A5)
  bellNote(440,    0.26, 2.2, 0.35);  // A4
  bellNote(311.13, 0.23, 2.5, 0.5);   // Eb4 (tritone below A4)
  bellNote(220,    0.30, 5.5, 0.85);  // A3 — low toll foundation
  bellNote(155.56, 0.24, 5.5, 0.85);  // Eb3 — tritone bass (THE evil note)
  bellNote(110,    0.28, 6.0, 0.85);  // A2 — seismic octave
}

// ── BATTLE AMBIENT ──
// Sparse FM-bell phrases from A minor pentatonic, routed through a feedback-delay
// reverb bus for long shimmer tails. Only plays during the fight scene.
let AMBG, REV_IN, currentAmb = null;
function ensureAmbBus() { if (!AMBG) { AMBG = AC.createGain(); AMBG.gain.value = 0.5; AMBG.connect(MG); } }
function ensureReverb() {
  if (REV_IN) return;
  const d1 = AC.createDelay(1.5); d1.delayTime.value = 0.37;
  const d2 = AC.createDelay(1.5); d2.delayTime.value = 0.23;
  const fb1 = AC.createGain(); fb1.gain.value = 0.55;
  const fb2 = AC.createGain(); fb2.gain.value = 0.5;
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
  const wet = AC.createGain(); wet.gain.value = 0.55;
  REV_IN = AC.createGain();
  REV_IN.connect(d1); REV_IN.connect(d2);
  d1.connect(fb1); fb1.connect(lp); lp.connect(d1);
  d2.connect(fb2); fb2.connect(d2);
  d1.connect(wet); d2.connect(wet); wet.connect(AMBG);
}
// FM bell: sine carrier + inharmonic sine modulator (2.76:1 ratio) for metallic timbre.
// Modulation index decays exponentially so the attack is bright and the tail softens.
function bellNote(freq, vol, life, offset) {
  if (!AC) return;
  ensureAmbBus(); ensureReverb();
  const t0 = AC.currentTime + (offset || 0);
  const car = AC.createOscillator(); car.type = 'sine'; car.frequency.value = freq;
  const mod = AC.createOscillator(); mod.type = 'sine'; mod.frequency.value = freq * 2.76;
  const modG = AC.createGain();
  modG.gain.setValueAtTime(freq * 3.5, t0);
  modG.gain.exponentialRampToValueAtTime(freq * 0.25, t0 + life);
  mod.connect(modG); modG.connect(car.frequency);
  const g = AC.createGain();
  g.gain.setValueAtTime(0.001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.06);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + life);
  car.connect(g); g.connect(AMBG); g.connect(REV_IN);
  car.start(t0); mod.start(t0);
  car.stop(t0 + life + 0.1); mod.stop(t0 + life + 0.1);
}

function ambBells() {
  const notes = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25, 783.99];
  let timer, stopped = false;
  const playBell = () => {
    if (stopped) return;
    bellNote(notes[Math.floor(Math.random() * notes.length)], 0.11, 3.5, 0);
    timer = setTimeout(playBell, 1600 + Math.random() * 3200);
  };
  timer = setTimeout(playBell, 600);
  return { stop() { stopped = true; clearTimeout(timer); } };
}
function startBattleAmb() {
  if (!AC || currentAmb) return;
  currentAmb = ambBells();
}
function stopBattleAmb() {
  if (currentAmb) { currentAmb.stop(); currentAmb = null; }
}

// ── CAT DRAWINGS (centered at 0,0, facing RIGHT; wrapper handles direction) ──

function drawFourier(T, state, hurtT) {
  const vib = Math.sin(T * 15) * 2;
  const al = state === 'dead' ? 0.35 : hurtT > 0 ? 0.5 + Math.sin(T * 30) * 0.5 : 1;
  ctx.fillStyle = '#06b6d4'; ctx.globalAlpha = al;
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = i / 24 * Math.PI * 2;
    const r = 22 + Math.sin(a * 3 + T * 8) * 4 + Math.sin(a * 5 + T * 6) * 2;
    ctx.lineTo(Math.cos(a) * r, 20 + Math.sin(a) * r * 0.7);
  } ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#0891b2'; ctx.lineWidth = 1.5; ctx.globalAlpha = al * 0.45;
  for (let row = -1; row <= 1; row++) {
    ctx.beginPath();
    for (let xi = -20; xi <= 20; xi += 2) ctx.lineTo(xi, 20 + row * 8 + Math.sin(xi * 0.5 + T * 6) * 4);
    ctx.stroke();
  }
  if (state === 'attack') pawDraw(38, 0, '#06b6d4', 'rgba(6,182,212,0.2)', '#7dd3fc', '∿', 'bold 10px monospace', 58, -18, al);
  ctx.fillStyle = '#0891b2'; ctx.globalAlpha = al * 0.9;
  const ls = Math.sin(T * 9) * 4;
  [-10, 10].forEach((ox, i) => { ctx.beginPath(); ctx.ellipse(ox, 42 + (i % 2 === 0 ? ls : -ls), 6, 11, 0, 0, Math.PI * 2); ctx.fill(); });
  ctx.strokeStyle = '#0891b2'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.globalAlpha = al * 0.85;
  ctx.beginPath(); ctx.moveTo(-18, 15);
  for (let i = 0; i <= 20; i++) { const p = i / 20; ctx.lineTo(-18 - p * 36, 15 + Math.sin(p * Math.PI * 4 + T * 5) * 10); }
  ctx.stroke();
  ctx.fillStyle = '#06b6d4'; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.ellipse(0 + vib * 0.4, -28, 28, 26, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#0891b2'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-15, -50); ctx.bezierCurveTo(-28, -66, -54, -60, -58, -50 + Math.sin(T * 3) * 5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(15, -50); ctx.bezierCurveTo(25, -70, 50, -80, 54, -72 + Math.sin(T * 4) * 6); ctx.stroke();
  [1, 2, 3].forEach(r => { ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.5; ctx.globalAlpha = al * 0.55 / r; ctx.beginPath(); ctx.arc(-58, -50 + Math.sin(T * 3) * 5, r * 5, 0, Math.PI * 2); ctx.stroke(); });
  [1, 2, 3].forEach(r => { ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 1.5; ctx.globalAlpha = al * 0.55 / r; ctx.beginPath(); ctx.arc(54, -72 + Math.sin(T * 4) * 6, r * 5, 0, Math.PI * 2); ctx.stroke(); });
  ctx.globalAlpha = al;
  ctx.strokeStyle = '#7dd3fc'; ctx.lineWidth = 2.5;
  [-11, 11].forEach(ox => { ctx.beginPath(); for (let i = 0; i <= 12; i++) { const p = i / 12; ctx.lineTo(ox - 6 + p * 12, -26 + Math.sin(p * Math.PI * 4 + T * 8) * 4); } ctx.stroke(); });
  ctx.fillStyle = '#06b6d4'; ctx.globalAlpha = al * 0.25;
  ctx.beginPath(); ctx.arc(-20, -20, 7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(20, -20, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#0891b2'; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.arc(0, -16, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#0891b2'; ctx.lineWidth = 2;
  ctx.beginPath(); for (let i = 0; i <= 10; i++) { const p = i / 10; ctx.lineTo(-10 + p * 20, -8 + Math.sin(p * Math.PI * 3 + T * 5) * 3); } ctx.stroke();
  ctx.fillStyle = '#7dd3fc'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
  ctx.fillText('~440Hz', 0, -68 + Math.sin(T * 2) * 3);
  ctx.globalAlpha = 1;
}

function drawGauss(T, state, hurtT) {
  const al = state === 'dead' ? 0.35 : hurtT > 0 ? 0.5 + Math.sin(T * 30) * 0.5 : 1;
  const breathe = Math.sin(T * 2.2) * 0.12;
  const bW = 30 * (1 + breathe), bH = 28 * (1 - breathe * 0.5);
  const bob = Math.sin(T * 2.2) * 3;
  ctx.fillStyle = '#fb923c'; ctx.globalAlpha = al * 0.15 * (1 + breathe * 2);
  ctx.beginPath(); ctx.ellipse(0, 18 + bob, bW * 1.4, bH * 1.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fb923c'; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.ellipse(0, 18 + bob, bW, bH, 0, 0, Math.PI * 2); ctx.fill();
  const sigma = 8 + Math.sin(T * 1.8) * 5;
  const peakH = 18 + Math.sin(T * 2.2) * 6;
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.moveTo(-28, 24 + bob);
  for (let xi = -28; xi <= 28; xi += 1) {
    const g = Math.exp(-xi * xi / (2 * sigma * sigma)) * peakH;
    ctx.lineTo(xi, 18 + bob - g + 6);
  }
  ctx.lineTo(28, 24 + bob); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 + breathe * 2; ctx.globalAlpha = al * 0.95;
  ctx.shadowColor = '#fed7aa'; ctx.shadowBlur = 8 + breathe * 12;
  ctx.beginPath();
  for (let xi = -28; xi <= 28; xi += 1) {
    const g = Math.exp(-xi * xi / (2 * sigma * sigma)) * peakH;
    xi === -28 ? ctx.moveTo(xi, 18 + bob - g + 6) : ctx.lineTo(xi, 18 + bob - g + 6);
  } ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.5; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.moveTo(-28, 24 + bob); ctx.lineTo(28, 24 + bob); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '7px monospace'; ctx.textAlign = 'center';
  ctx.fillText('σ=' + sigma.toFixed(1), 0, 32 + bob);
  ctx.fillStyle = '#ea580c'; ctx.globalAlpha = al;
  const ls = Math.sin(T * 9) * 3;
  [-12, 12].forEach((ox, i) => { ctx.beginPath(); ctx.ellipse(ox, 46 + bob + (i % 2 === 0 ? ls : -ls), 8, 8, 0, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = '#fb923c';
  [-12, 12].forEach(ox => { ctx.beginPath(); ctx.ellipse(ox + ox * 0.2, 52 + bob, 10, 5, 0, 0, Math.PI * 2); ctx.fill(); });
  ctx.strokeStyle = '#ea580c'; ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-28, 15 + bob); ctx.bezierCurveTo(-50, 10 + bob, -52, -5, -44, -8); ctx.stroke();
  ctx.fillStyle = '#fed7aa'; ctx.beginPath(); ctx.arc(-44, -8, 6, 0, Math.PI * 2); ctx.fill();
  if (state === 'attack') pawDraw(38, -2, '#fb923c', 'rgba(251,146,60,0.2)', '#fed7aa', 'σ', 'bold 10px monospace', 58, -20, al);
  const headR = 32 * (1 + breathe * 0.15);
  ctx.fillStyle = '#fb923c'; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.arc(0, -30 + bob * 0.4, headR, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ea580c';
  ctx.beginPath(); ctx.arc(-28, -54 + bob * 0.3, 11, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(28, -54 + bob * 0.3, 11, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fed7aa';
  ctx.beginPath(); ctx.arc(-28, -54 + bob * 0.3, 6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(28, -54 + bob * 0.3, 6, 0, Math.PI * 2); ctx.fill();
  const eyeY = -28 + bob * 0.4;
  ctx.strokeStyle = '#431407'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.arc(-13, eyeY, 7, -Math.PI * 0.9, -Math.PI * 0.1); ctx.stroke();
  ctx.beginPath(); ctx.arc(13, eyeY, 7, -Math.PI * 0.9, -Math.PI * 0.1); ctx.stroke();
  ctx.fillStyle = '#431407';
  ctx.beginPath(); ctx.arc(-19, eyeY - 4, 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(19, eyeY - 4, 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f472b6'; ctx.globalAlpha = al * (0.3 + breathe * 0.3);
  ctx.beginPath(); ctx.arc(-22, eyeY + 8, 10 + breathe * 4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(22, eyeY + 8, 10 + breathe * 4, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = al;
  ctx.fillStyle = '#c026d3'; ctx.beginPath(); ctx.arc(0, eyeY + 9, 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ea580c'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  const mOpen = 2 + breathe * 4;
  ctx.beginPath();
  ctx.moveTo(-11, eyeY + 18); ctx.quadraticCurveTo(-5, eyeY + 18 + mOpen, 0, eyeY + 16 + mOpen * 0.5); ctx.quadraticCurveTo(5, eyeY + 18 + mOpen, 11, eyeY + 18);
  ctx.stroke();
  ctx.fillStyle = '#fed7aa'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
  ctx.fillText('μ=0 ♡', 0, -72 + bob * 0.2);
  ctx.globalAlpha = 1;
}

function drawFibo(T, state, hurtT) {
  const al = state === 'dead' ? 0.35 : hurtT > 0 ? 0.5 + Math.sin(T * 30) * 0.5 : 1;
  ctx.fillStyle = '#10b981'; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.ellipse(0, 15, 20, 32, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#6ee7b7'; ctx.lineWidth = 1.8; ctx.globalAlpha = al * 0.7;
  ctx.beginPath();
  for (let i = 0; i <= 80; i++) { const t = i / 80 * Math.PI * 4 + T * 0.5; const r = Math.pow(1.618, t * 0.3) * 2; if (r > 22) break; ctx.lineTo(Math.cos(t) * r, 15 + Math.sin(t) * r * 0.7); }
  ctx.stroke(); ctx.globalAlpha = al;
  ctx.fillStyle = '#059669';
  [-10, 10].forEach((ox, i) => { ctx.beginPath(); ctx.ellipse(ox, 44, 5, 12, Math.sin(T * 7 + i * Math.PI) * 0.2, 0, Math.PI * 2); ctx.fill(); });
  const tCX = -42, tCY = 22;
  ctx.strokeStyle = '#059669'; ctx.lineWidth = 4.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-18, 18); ctx.quadraticCurveTo(-30, 20, tCX, tCY); ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i <= 80; i++) {
    const t = i / 80 * Math.PI * 2 * 2.5 + T * 0.8;
    const r = (i / 80) * 38;
    i === 0 ? ctx.moveTo(tCX + Math.cos(t) * r, tCY + Math.sin(t) * r * 0.55) : ctx.lineTo(tCX + Math.cos(t) * r, tCY + Math.sin(t) * r * 0.55);
  } ctx.stroke();
  if (state === 'attack') pawDraw(34, -14, '#10b981', 'rgba(16,185,129,0.2)', '#6ee7b7', 'φ', 'bold 12px serif', 58, -32, al);
  ctx.fillStyle = '#10b981'; ctx.globalAlpha = al;
  ctx.beginPath(); ctx.ellipse(0, -32, 22, 30, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#059669';
  ctx.beginPath(); ctx.moveTo(-14, -52); ctx.bezierCurveTo(-22, -78, -12, -88, -6, -72); ctx.bezierCurveTo(0, -60, -5, -52, -14, -52); ctx.fill();
  ctx.beginPath(); ctx.moveTo(14, -52); ctx.bezierCurveTo(22, -78, 12, -88, 6, -72); ctx.bezierCurveTo(0, -60, 5, -52, 14, -52); ctx.fill();
  ctx.fillStyle = '#6ee7b7';
  ctx.beginPath(); ctx.moveTo(-13, -54); ctx.bezierCurveTo(-19, -74, -11, -82, -7, -70); ctx.bezierCurveTo(-2, -60, -6, -54, -13, -54); ctx.fill();
  ctx.beginPath(); ctx.moveTo(13, -54); ctx.bezierCurveTo(19, -74, 11, -82, 7, -70); ctx.bezierCurveTo(2, -60, 6, -54, 13, -54); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(-9, -33, 9, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(9, -33, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#022c22'; ctx.beginPath(); ctx.arc(-9, -33, 6, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(9, -33, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  [-9, 9].forEach(ox => { ctx.beginPath(); ctx.arc(ox - 3, -36, 3, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(ox + 3, -30, 1.5, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = '#34d399'; ctx.globalAlpha = al * 0.3;
  ctx.beginPath(); ctx.arc(-20, -25, 7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(20, -25, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#059669'; ctx.globalAlpha = al; ctx.beginPath(); ctx.arc(0, -24, 3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#059669'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(0, -16, 9, 0.1, Math.PI - 0.1); ctx.stroke();
  ctx.fillStyle = '#6ee7b7'; ctx.font = 'bold 14px serif'; ctx.textAlign = 'center';
  ctx.globalAlpha = al * (0.7 + Math.sin(T * 2) * 0.3);
  ctx.fillText('φ', 44, -58 + Math.sin(T * 1.8) * 5);
  ctx.globalAlpha = 1;
}

function drawSchrodinger(T, state, hurtT) {
  const exist = Math.sin(T * 2.5);
  const al = state === 'dead' ? 0.2 : hurtT > 0 ? 0.4 + Math.abs(exist) * 0.4 : (0.35 + Math.abs(exist) * 0.65);
  const ghost = (Math.sin(T * 3 + 1.5) + 1) / 2 * 0.38;
  const flicker = Math.sin(T * 18) * 0.5 + 0.5;
  for (let ring = 3; ring >= 1; ring--) {
    ctx.fillStyle = 'rgba(232,121,249,' + ((0.04 + ring * 0.02) * al) + ')';
    ctx.beginPath(); ctx.ellipse(0, 15, 28 + ring * 10, 24 + ring * 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(232,121,249,' + (al * 0.75) + ')';
  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const t = i / 60 * Math.PI * 2;
    const psi = Math.cos(t) * Math.exp(-Math.pow(Math.cos(t), 2) * 0.8);
    ctx.lineTo(Math.cos(t) * (22 + psi * 12), 15 + Math.sin(t) * (18 + Math.abs(psi) * 8));
  } ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(232,121,249,' + (al * 0.9) + ')'; ctx.lineWidth = 2;
  ctx.beginPath(); for (let xi = -26; xi <= 26; xi += 1) ctx.lineTo(xi, 15 + Math.exp(-xi * xi / 200) * Math.cos(xi * 0.5 + T * 4) * 14); ctx.stroke();
  ctx.fillStyle = 'rgba(200,80,220,' + ghost + ')';
  ctx.beginPath(); ctx.ellipse(Math.sin(T * 4) * 10, 15, 20, 16, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(232,121,249,' + (al * (0.5 + flicker * 0.5)) + ')';
  [-11, 11].forEach(ox => { ctx.beginPath(); ctx.ellipse(ox, 42, 6, 11, 0, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = 'rgba(232,121,249,' + (al * 0.3) + ')';
  [-22, 22].forEach(ox => { ctx.beginPath(); ctx.ellipse(ox, 40, 5, 9, 0, 0, Math.PI * 2); ctx.fill(); });
  ctx.strokeStyle = 'rgba(232,121,249,' + (al * 0.8) + ')'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-18, 18);
  for (let i = 0; i <= 20; i++) { const p = i / 20; ctx.lineTo(-18 - p * 38, 18 - p * 15 + Math.sin(p * Math.PI * 3 + T * 5) * 15 * (1 - p)); }
  ctx.stroke();
  if (state === 'attack') {
    ctx.fillStyle = 'rgba(232,121,249,' + (al * 0.9) + ')'; ctx.beginPath(); ctx.arc(36, -10, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(232,121,249,0.2)'; ctx.beginPath(); ctx.arc(36, -10, 24, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2.5;
    [-1, 0, 1].forEach(c => { ctx.beginPath(); ctx.moveTo(42 + c * 3, -14); ctx.lineTo(50 + c * 4, -19 + c * 2); ctx.stroke(); });
    ctx.fillStyle = 'rgba(232,121,249,0.9)'; ctx.font = 'bold 12px serif'; ctx.textAlign = 'center'; ctx.fillText('ψ', 58, -28);
  }
  ctx.fillStyle = 'rgba(200,80,220,' + (ghost * 0.6) + ')';
  ctx.beginPath(); ctx.ellipse(Math.sin(T * 3) * 8, -30, 22, 20, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(232,121,249,' + (al * 0.88) + ')';
  ctx.beginPath(); ctx.ellipse(0, -30, 24, 22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(232,121,249,' + (al * 0.9) + ')';
  ctx.beginPath(); ctx.moveTo(-16, -46); ctx.lineTo(-24, -66); ctx.lineTo(-6, -48); ctx.fill();
  ctx.beginPath(); ctx.moveTo(6, -48); ctx.lineTo(24, -66); ctx.lineTo(16, -46); ctx.fill();
  ctx.fillStyle = 'rgba(200,80,220,' + (ghost * 0.5) + ')';
  ctx.beginPath(); ctx.moveTo(-10, -46); ctx.lineTo(-18, -66); ctx.lineTo(0, -48); ctx.fill();
  ctx.beginPath(); ctx.moveTo(12, -48); ctx.lineTo(30, -66); ctx.lineTo(22, -46); ctx.fill();
  const ea = al * (0.6 + flicker * 0.4);
  ctx.fillStyle = 'rgba(255,220,255,' + ea + ')';
  ctx.beginPath(); ctx.arc(-9, -32, 8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(9, -32, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(0,40,30,' + ea + ')';
  ctx.beginPath(); ctx.arc(-9, -32, 5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(9, -32, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(200,80,220,' + (ghost * 0.7) + ')';
  ctx.beginPath(); ctx.arc(-1, -32, 4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(17, -32, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,' + ea + ')';
  ctx.beginPath(); ctx.arc(-12, -35, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(6, -35, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(232,121,249,0.25)';
  ctx.beginPath(); ctx.arc(-20, -24, 7, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(20, -24, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(200,80,220,' + (al * 0.9) + ')'; ctx.beginPath(); ctx.arc(0, -23, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(200,80,220,' + (al * 0.85) + ')'; ctx.lineWidth = 2.5;
  ctx.beginPath(); for (let i = 0; i <= 12; i++) { const p = i / 12; ctx.lineTo(-10 + p * 20, -15 + Math.sin(p * Math.PI + T * 3) * 3 + 3); } ctx.stroke();
  ctx.fillStyle = 'rgba(232,121,249,' + (0.5 + Math.sin(T * 2) * 0.4) + ')';
  ctx.font = 'bold 18px serif'; ctx.textAlign = 'center'; ctx.fillText('ψ', -46, -54 + Math.sin(T * 1.4) * 5);
  ctx.font = '12px monospace'; ctx.fillText('☢', 46, -52 + Math.sin(T * 1.8) * 4);
  ctx.font = '7px monospace'; ctx.fillStyle = 'rgba(200,80,220,' + (flicker * 0.6) + ')';
  ctx.fillText('OBSERVED?', 0, -78);
  ctx.globalAlpha = 1;
}

// Inverted pentagram in circle — round-win marker next to winner's HP bar.
// Drawn as 5 crossing lines (classic pentagram), not filled.
function drawSatanicStar(cx, cy, size) {
  const outer = size / 2;
  ctx.save();
  ctx.shadowColor = '#ef4444'; ctx.shadowBlur = 6;
  ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1.4;
  ctx.lineJoin = 'miter'; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy, outer + 1, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i <= 5; i++) {
    const idx = (i * 2) % 5;
    const a = Math.PI / 2 + idx * 2 * Math.PI / 5;
    const x = cx + Math.cos(a) * outer, y = cy + Math.sin(a) * outer;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

// Shared attack-paw + glyph renderer used by the first three cats.
function pawDraw(px, py, fill, glow, gcol, glyph, font, gx, gy, al) {
  ctx.fillStyle = fill; ctx.globalAlpha = al; ctx.beginPath(); ctx.arc(px, py, 12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(px, py, 22, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
  [-1, 0, 1].forEach(c => { ctx.beginPath(); ctx.moveTo(px + 6 + c * 3, py - 4); ctx.lineTo(px + 14 + c * 4, py - 9 + c * 2); ctx.stroke(); });
  ctx.fillStyle = gcol; ctx.font = font; ctx.textAlign = 'center'; ctx.fillText(glyph, gx, gy);
}

// ── CATS ───────────────────────────────────────────────────────
const CATS = [
  { name: 'FOURY', subtitle: 'THE OSCILLATOR', css: '#06b6d4', syncFreq: 4,
    projPath(age, ox, oy, tx, ty) {
      const dx = tx - ox, dy = ty - oy, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const px = -dy / len, py = dx / len;
      const w = (Math.sin(age * Math.PI * 8) * 0.5 + Math.sin(age * Math.PI * 4) * 0.3 + Math.sin(age * Math.PI * 2) * 0.2) * 38 * (1 - age);
      return { x: ox + dx * age + px * w, y: oy + dy * age + py * w };
    },
    bgDraw(T, a) { const h = ((T * 20) % 360).toFixed(0); ctx.globalAlpha = a; this._r(ctx, T, h); ctx.globalAlpha = 1; },
    _r(o, T, h) {
      const aa = 3, b = 2, cx = W / 2, cy = H / 2, delta = T * 0.18;
      for (let layer = 0; layer < 4; layer++) {
        o.strokeStyle = `hsl(${h},100%,60%)`; o.globalAlpha = 0.12 + layer * 0.07; o.lineWidth = 0.8 + layer * 0.4;
        o.beginPath();
        for (let i = 0; i <= 400; i++) {
          const t = i / 400 * Math.PI * 2 * 3;
          o.lineTo(cx + W * 0.46 * Math.sin(aa * t + delta + layer * 0.25) * Math.cos(layer * 0.3 + T * 0.08), cy + H * 0.38 * Math.sin(b * t + layer * 0.4) * Math.sin(layer * 0.2 + T * 0.06));
        } o.stroke();
      }
      o.strokeStyle = `hsl(${h},100%,80%)`; o.globalAlpha = 0.7; o.lineWidth = 2;
      o.beginPath();
      for (let i = 0; i <= 150; i++) { const t = i / 150 * Math.PI * 2 * 3 + T * 0.12; o.lineTo(cx + W * 0.46 * Math.sin(aa * t + delta), cy + H * 0.38 * Math.sin(b * t)); }
      o.stroke(); o.globalAlpha = 1;
    } },
  { name: 'GAUSSY', subtitle: 'THE MEAN ONE', css: '#fb923c', syncFreq: 2,
    projPath(age, ox, oy, tx, ty) {
      const dx = tx - ox, dy = ty - oy, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const px = -dy / len, py = dx / len;
      const osc = Math.sin(2.01 * age * 30) * Math.exp(-0.003 * age * 30) * 42;
      return { x: ox + dx * age + px * osc, y: oy + dy * age + py * osc };
    },
    bgDraw(T, a) { const h = ((T * 20 + 90) % 360).toFixed(0); ctx.globalAlpha = a; this._r(ctx, T, h); ctx.globalAlpha = 1; },
    _r(o, T, h) {
      const f1 = 2.01, f2 = 3.0, f3 = 2.5, p1 = 0.5, p2 = 1.3, decay = 0.0008;
      const cx = W / 2, cy = H / 2, amp = Math.min(W, H) * 0.46;
      for (let layer = 0; layer < 3; layer++) {
        o.strokeStyle = `hsl(${h},100%,60%)`; o.globalAlpha = 0.1 + layer * 0.07; o.lineWidth = 0.8 + layer * 0.35;
        o.beginPath();
        for (let i = 0; i <= 1200; i++) {
          const t = i / 1200 * 80 + layer * 0.4;
          const d = Math.exp(-decay * t);
          o.lineTo(cx + amp * Math.sin(f1 * t + p1) * d, cy + amp * Math.sin(f2 * t + p2) * Math.sin(f3 * t) * d);
        } o.stroke();
      }
      const base = ((T * 0.5) % 1) * 1200;
      o.strokeStyle = `hsl(${h},100%,80%)`; o.globalAlpha = 0.85; o.lineWidth = 2.5;
      o.beginPath();
      for (let i = Math.max(0, base - 60); i <= Math.min(1200, base); i++) {
        const t = i / 1200 * 80, d = Math.exp(-decay * t);
        const x = cx + amp * Math.sin(f1 * t + p1) * d, y = cy + amp * Math.sin(f2 * t + p2) * Math.sin(f3 * t) * d;
        i === Math.max(0, base - 60) ? o.moveTo(x, y) : o.lineTo(x, y);
      } o.stroke();
      o.globalAlpha = 1;
    } },
  { name: 'FIBS', subtitle: 'THE GOLDEN MENACE', css: '#10b981', syncFreq: 5,
    projPath(age, ox, oy, tx, ty) {
      const dx = tx - ox, dy = ty - oy;
      const baseAngle = Math.atan2(dy, dx);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const wobble = Math.sin(age * 1.618 * Math.PI * 3) * 26 * (1 - age) * (1 - age);
      return { x: ox + Math.cos(baseAngle) * dist * age + Math.cos(baseAngle + Math.PI / 2) * wobble, y: oy + Math.sin(baseAngle) * dist * age + Math.sin(baseAngle + Math.PI / 2) * wobble };
    },
    bgDraw(T, a) {
      if (!this._oc) { this._oc = document.createElement('canvas'); this._oc.width = W; this._oc.height = H; this._ot = -99; }
      if (T - this._ot > 0.05) { this._ot = T; const h = ((T * 20 + 180) % 360).toFixed(0); const o = this._oc.getContext('2d'); o.clearRect(0, 0, W, H); this._r(o, T, h); }
      ctx.globalAlpha = a; ctx.drawImage(this._oc, 0, 0); ctx.globalAlpha = 1;
    },
    _r(o, T, h) {
      const n = 5, d = 97, cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.47;
      const STEPS = 180;
      for (let layer = 0; layer < 5; layer++) {
        const off = layer * 0.45 + T * (0.045 - layer * 0.007);
        o.strokeStyle = `hsl(${h},${80 + layer * 4}%,${45 + layer * 8}%)`; o.globalAlpha = 0.15 + layer * 0.1; o.lineWidth = 0.9 + layer * 0.4;
        o.beginPath();
        for (let k = 0; k <= STEPS; k++) {
          const angle = (k * d * 2) * Math.PI / 180 + off;
          const r = R * Math.sin((n + layer * 0.15) * angle);
          k === 0 ? o.moveTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle)) : o.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
        } o.stroke();
      }
      const tStep = (T * 17) % STEPS;
      o.strokeStyle = `hsl(${h},100%,85%)`; o.globalAlpha = 0.9; o.lineWidth = 2.5;
      o.beginPath();
      const tStart = Math.floor(tStep);
      for (let k = tStart; k <= tStart + 50; k++) {
        const angle = (k * d * 2) * Math.PI / 180, r = R * Math.sin(n * angle);
        k === tStart ? o.moveTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle)) : o.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
      } o.stroke();
      o.globalAlpha = 1;
    } },
  { name: 'SCHRÖDS', subtitle: 'THE UNDEFINED', css: '#e879f9', syncFreq: 3,
    projPath(age, ox, oy, tx, ty) {
      const dx = tx - ox, dy = ty - oy, len = Math.sqrt(dx * dx + dy * dy) || 1;
      const px = -dy / len, py = dx / len;
      const tunnel = Math.sin(age * Math.PI * 5) * Math.cos(age * Math.PI * 3) * 35 * (1 - age);
      return { x: ox + dx * age + px * tunnel, y: oy + dy * age + py * tunnel };
    },
    bgDraw(T, a) { const h = ((T * 20 + 270) % 360).toFixed(0); ctx.globalAlpha = a; this._r(ctx, T, h); ctx.globalAlpha = 1; },
    _r(o, T, h) {
      const R = Math.min(W, H) * 0.44, r = R * 0.38, d = r * 0.65, cx = W / 2, cy = H / 2;
      for (let layer = 0; layer < 4; layer++) {
        const off = layer * 0.7 + T * (0.032 - layer * 0.005);
        o.strokeStyle = `hsl(${h},100%,60%)`; o.globalAlpha = 0.1 + layer * 0.09; o.lineWidth = 0.8 + layer * 0.35;
        o.beginPath();
        for (let i = 0; i <= 600; i++) {
          const t = i / 600 * Math.PI * 2 * 20 + off;
          o.lineTo(cx + (R - r) * Math.cos(t) + d * Math.cos((R - r) / r * t), cy + (R - r) * Math.sin(t) - d * Math.sin((R - r) / r * t));
        } o.stroke();
      }
      for (let tr = 0; tr < 12; tr++) {
        const t2 = T * 2.5 - tr * 0.06;
        o.fillStyle = `hsl(${h},100%,75%)`; o.globalAlpha = (12 - tr) / 12 * 0.75;
        o.beginPath(); o.arc(cx + (R - r) * Math.cos(t2) + d * Math.cos((R - r) / r * t2), cy + (R - r) * Math.sin(t2) - d * Math.sin((R - r) / r * t2), 5 * (12 - tr) / 12 + 1, 0, Math.PI * 2); o.fill();
      }
      o.globalAlpha = 1;
    } },
];
const CAT_DRAW = [drawFourier, drawGauss, drawFibo, drawSchrodinger];

function drawCat(x, y, dir, ci, T, state, hurtT, scale, sync) {
  const C = CATS[ci];
  const s = scale || 1;
  if (sync > 0.5 && state !== 'dead') {
    ctx.strokeStyle = C.css; ctx.lineWidth = 2 * s; ctx.globalAlpha = (sync - 0.5) * 2 * 0.4;
    ctx.beginPath(); ctx.arc(x, y - 8 * s, (38 + sync * 12) * s, 0, Math.PI * 2); ctx.stroke();
    if (sync > 0.82) {
      ctx.globalAlpha = (sync - 0.82) / 0.18 * 0.35; ctx.lineWidth = 4 * s;
      ctx.beginPath(); ctx.arc(x, y - 8 * s, (52 + sync * 6) * s, 0, Math.PI * 2); ctx.stroke();
    } ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(x, y + 22 * s, 28 * s, 7 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir * s, s);
  CAT_DRAW[ci](T, state, hurtT);
  ctx.restore();
}

// ── BACKGROUND ──────────────────────────────────────────────────
const STARS = Array.from({ length: 80 }, (_, i) => ({
  x: (Math.sin(i * 127.1) * 0.5 + 0.5) * W,
  y: (Math.cos(i * 311.7) * 0.5 + 0.5) * (FLOOR - 10),
  r: 0.4 + ((i * 73.1) % 1) * 1.4,
  spd: 0.4 + ((i * 31.7) % 1) * 1.2,
  off: ((i * 53.3) % 1) * Math.PI * 2,
}));

function drawBG(T, ci1, ci2, beatF) {
  ctx.fillStyle = '#04000e'; ctx.fillRect(0, 0, W, H);
  STARS.forEach(s => {
    const tw = (Math.sin(T * s.spd + s.off) * 0.5 + 0.5);
    ctx.fillStyle = '#fff'; ctx.globalAlpha = tw * 0.55 + 0.05;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r * (0.7 + tw * 0.6), 0, Math.PI * 2); ctx.fill();
    if (tw > 0.85 && s.r > 1.2) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5; ctx.globalAlpha = tw * 0.3;
      ctx.beginPath(); ctx.moveTo(s.x - s.r * 3, s.y); ctx.lineTo(s.x + s.r * 3, s.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s.x, s.y - s.r * 3); ctx.lineTo(s.x, s.y + s.r * 3); ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;
  CATS[ci1].bgDraw(T, 0.55 + beatF * 0.2);
  CATS[ci2].bgDraw(T * 0.91 + 50, 0.45 + beatF * 0.15);
  const g = ctx.createLinearGradient(0, H * 0.5, 0, FLOOR);
  g.addColorStop(0, 'transparent'); g.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

function drawFloor(T, ci1, ci2) {
  const C1 = CATS[ci1], C2 = CATS[ci2];
  function noise(x, t) {
    return Math.sin(x * 0.018 + t * 1.1) * 6
      + Math.sin(x * 0.041 + t * 0.7 + 1.3) * 4
      + Math.sin(x * 0.093 + t * 1.8 + 2.7) * 2.5
      + Math.sin(x * 0.21 + t * 0.4 + 0.9) * 1.5
      + Math.sin(x * 0.47 + t * 2.2 + 4.1) * 1;
  }
  ctx.fillStyle = 'rgba(4,0,14,0.92)'; ctx.fillRect(0, FLOOR, W, H - FLOOR);
  const grad = ctx.createLinearGradient(0, FLOOR - 20, 0, FLOOR + 8);
  grad.addColorStop(0, 'transparent'); grad.addColorStop(1, 'rgba(4,0,14,0.92)');
  ctx.fillStyle = grad; ctx.fillRect(0, FLOOR - 20, W, 28);
  ctx.fillStyle = C1.css; ctx.globalAlpha = 0.06;
  ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, FLOOR + noise(x, T));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  ctx.fillStyle = C2.css; ctx.globalAlpha = 0.05;
  ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, FLOOR + noise(x, T * 0.8 + 20));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = C1.css; ctx.lineWidth = 2; ctx.globalAlpha = 0.7;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 3) ctx.lineTo(x, FLOOR + noise(x, T));
  ctx.stroke();
  ctx.strokeStyle = C2.css; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.45;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 3) ctx.lineTo(x, FLOOR + noise(x, T * 0.8 + 20));
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ── SELECT SCENE ────────────────────────────────────────────────
function drawSelect() {
  ctx.fillStyle = '#04000e'; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.07; CATS[sel.cursor[0]].bgDraw(T, 1);
  ctx.globalAlpha = 0.05; CATS[sel.cursor[1]].bgDraw(T * 0.8, 1);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(4,0,14,0.55)'; ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.font = 'bold 48px monospace';
  ctx.shadowColor = '#e879f9'; ctx.shadowBlur = 20;
  ctx.strokeStyle = '#000'; ctx.lineWidth = 8;
  const nyanPart = 'NYAN ', psiPart = 'ψ';
  const nW = ctx.measureText(nyanPart).width;
  const pW = ctx.measureText(psiPart).width;
  const totalW = nW + pW;
  const startX = W / 2 - totalW / 2;
  ctx.textAlign = 'left';
  ctx.strokeText(nyanPart, startX, 72); ctx.fillStyle = '#fff'; ctx.fillText(nyanPart, startX, 72);
  ctx.strokeText(psiPart, startX + nW, 64); ctx.fillStyle = '#fff'; ctx.fillText(psiPart, startX + nW, 64);
  ctx.textAlign = 'center';
  ctx.shadowBlur = 0;

  ctx.font = 'bold 22px monospace';
  ctx.shadowColor = '#e879f9'; ctx.shadowBlur = 18;
  ctx.strokeStyle = '#000'; ctx.lineWidth = 5; ctx.strokeText('∀ GATO ∃ UN RIVAL', W / 2, 112);
  ctx.fillStyle = '#e879f9'; ctx.fillText('∀ GATO ∃ UN RIVAL', W / 2, 112);
  ctx.shadowBlur = 35; ctx.globalAlpha = 0.4;
  ctx.fillText('∀ GATO ∃ UN RIVAL', W / 2, 112);
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;

  ctx.strokeStyle = 'rgba(232,121,249,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(80, 126); ctx.lineTo(W - 80, 126); ctx.stroke();

  const cW = 168, cH = 200, sX = W / 2 - cW * 2, sY = 190;
  CATS.forEach((C, i) => {
    const cx = sX + i * cW + cW / 2, cy = sY + cH / 2;
    const isP1 = sel.cursor[0] === i, isP2 = sel.cursor[1] === i;
    const isConf0 = sel.chosen[0] === i, isConf1 = sel.chosen[1] === i;
    const isTaken = (sel.confirmed[0] && sel.chosen[0] === i && !isP1) || (sel.confirmed[1] && sel.chosen[1] === i && !isP2);
    const cardAlpha = isTaken ? 0.3 : isP1 || isP2 ? 0.95 : 0.6;
    ctx.fillStyle = `rgba(8,0,24,${cardAlpha})`;
    ctx.beginPath(); ctx.roundRect(cx - 70, cy - 88, 140, 176, 10); ctx.fill();
    if (isP1 && isP2) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.roundRect(cx - 71, cy - 89, 142, 178, 10); ctx.stroke();
    } else if (isP1) {
      ctx.strokeStyle = '#ff9de2'; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.8 + Math.sin(T * 5) * 0.2;
      ctx.beginPath(); ctx.roundRect(cx - 71, cy - 89, 142, 178, 10); ctx.stroke();
    } else if (isP2) {
      ctx.strokeStyle = '#a5f3fc'; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.8 + Math.sin(T * 5 + 1) * 0.2;
      ctx.beginPath(); ctx.roundRect(cx - 71, cy - 89, 142, 178, 10); ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.roundRect(cx - 70, cy - 88, 140, 176, 10); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.save(); ctx.beginPath(); ctx.roundRect(cx - 70, cy - 88, 140, 176, 10); ctx.clip();
    drawCat(cx, cy - 5, 1, i, T, 'idle', 0, isP1 || isP2 ? 0.82 : 0.7, 0);
    ctx.restore();
    if (isConf0) {
      ctx.fillStyle = '#ff9de2'; ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.roundRect(cx - 20, cy - 87, 40, 16, 4); ctx.fill();
      ctx.fillStyle = '#000'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center'; ctx.fillText('P1', cx, cy - 76);
    }
    if (isConf1) {
      ctx.fillStyle = '#a5f3fc'; ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.roundRect(cx - 20, cy - 87, 40, 16, 4); ctx.fill();
      ctx.fillStyle = '#000'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center'; ctx.fillText('P2', cx, cy - 76);
    }
    ctx.globalAlpha = 1;
    ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = isTaken ? 'rgba(255,255,255,0.2)' : isP1 || isP2 ? C.css : 'rgba(255,255,255,0.35)';
    ctx.fillText(isTaken ? '✗ TAKEN' : C.name, cx, cy + 76);
  });

  [0, 1].forEach(pi => {
    const i = sel.cursor[pi], cx = sX + i * cW + cW / 2;
    const col = pi === 0 ? '#ff9de2' : '#a5f3fc';
    ctx.fillStyle = col; ctx.globalAlpha = 0.9;
    if (pi === 0) {
      ctx.beginPath(); ctx.moveTo(cx - 8, sY - 10); ctx.lineTo(cx + 8, sY - 10); ctx.lineTo(cx, sY - 2); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(cx - 8, sY + cH + 10); ctx.lineTo(cx + 8, sY + cH + 10); ctx.lineTo(cx, sY + cH + 2); ctx.fill();
    }
    ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = col;
    ctx.fillText(pi === 0 ? 'P1' : 'P2', cx, pi === 0 ? sY - 14 : sY + cH + 22);
    ctx.globalAlpha = 1;
  });

  ctx.font = 'bold 10px monospace'; ctx.fillStyle = '#b00020';
  ctx.textAlign = 'left';
  ctx.fillText('P1: A / D  ·  U confirm', 16, H - 14);
  ctx.textAlign = 'right';
  ctx.fillText('P2: ← / →  ·  R confirm', W - 16, H - 14);
}

// ── FIGHT ───────────────────────────────────────────────────────
function mkFight(ci1, ci2) {
  return {
    ci: [ci1, ci2],
    F: [
      { x: 185, y: FLOOR - 28, vy: 0, dir: 1, hp: 100, maxHp: 100, state: 'idle', stateT: 0, phase: 0, sync: 0, gnd: true, jumps: 0, bullets: [], cd: 0, hurtT: 0, wins: 0 },
      { x: W - 185, y: FLOOR - 28, vy: 0, dir: -1, hp: 100, maxHp: 100, state: 'idle', stateT: 0, phase: 0, sync: 0, gnd: true, jumps: 0, bullets: [], cd: 0, hurtT: 0, wins: 0 },
    ],
    round: 1, over: false, rOver: false, _bc: 0,
    beatT: 0, beatMS: 475, beatF: 0,
    parts: [], flash: 0, msg: '', msgT: 0,
    timer: 180, timeUp: false, suddenDeath: false,
  };
}

function endByTime(f) {
  if (f.rOver) return;
  const [a, b] = f.F;
  if (!f.suddenDeath && a.hp === b.hp) {
    f.suddenDeath = true;
    a.hp = 1; b.hp = 1;
    f.msg = 'SUDDEN DEATH!'; f.msgT = 2.5;
    sRiffRound();
    return;
  }
  f.timeUp = true;
  endRound(f, a.hp > b.hp ? 0 : 1);
}

function updateFight(f, dt) {
  if (!f.rOver && !f.suddenDeath) {
    f.timer -= dt;
    if (f.timer <= 0) { f.timer = 0; endByTime(f); return; }
  }
  f.beatT += dt;
  if (f.beatT >= f.beatMS / 1000) { f.beatT = 0; f.beatF = 1; if (++f._bc % 22 === 0) f.beatMS = Math.max(300, f.beatMS - 8); }
  f.beatF = Math.max(0, f.beatF - dt * 4);
  if (f.flash > 0) f.flash -= dt; if (f.msgT > 0) f.msgT -= dt;
  f.F.forEach((fi, pi) => {
    const C = CATS[f.ci[pi]], opp = f.F[1 - pi];
    fi.phase += dt * C.syncFreq * 0.85; fi.sync = (Math.sin(fi.phase) + 1) / 2;
    if (fi.stateT > 0) { fi.stateT -= dt; if (fi.stateT <= 0 && fi.state !== 'dead') fi.state = fi.gnd ? 'idle' : 'jump'; }
    if (fi.hurtT > 0) fi.hurtT -= dt; if (fi.cd > 0) fi.cd -= dt;
    fi.vy += 0.65 * dt * 60; fi.y += fi.vy * dt * 60;
    if (fi.y >= FLOOR - 28) { fi.y = FLOOR - 28; fi.vy = 0; fi.gnd = true; fi.jumps = 0; } else fi.gnd = false;
    fi.x = Math.max(40, Math.min(W - 40, fi.x));
    if (fi.state !== 'dead') fi.dir = fi.x < opp.x ? 1 : -1;
    fi.bullets = fi.bullets.filter(b => {
      b.age += dt * b.spd; if (b.age >= 1) return false;
      const p = C.projPath(b.age, b.ox, b.oy, b.tx, b.ty); b.x = p.x; b.y = p.y;
      const d = Math.sqrt((b.x - opp.x) ** 2 + (b.y - (opp.y - 20)) ** 2);
      if (d < 28 && !b.hit) {
        b.hit = true; opp.hp = Math.max(0, opp.hp - b.dmg);
        opp.state = 'hurt'; opp.stateT = 0.22; opp.hurtT = 0.22; opp.vy = -5;
        sHit(); f.flash = 0.07;
        for (let i = 0; i < 10; i++) { const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 5; f.parts.push({ x: opp.x, y: opp.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, col: C.css, life: 0.7, r: 4 }); }
        if (b.isPeak) { f.msg = 'PEAK HIT! ×2.5'; f.msgT = 1.2; sPeak(); }
        if (opp.hp <= 0) { opp.state = 'dead'; opp.vy = -8; endRound(f, pi); }
      }
      return !b.hit;
    });
  });
  const F = f.F;
  if (Math.abs(F[0].x - F[1].x) < 52 && F[0].state !== 'dead' && F[1].state !== 'dead') {
    const push = F[0].x < F[1].x ? -1.8 : 1.8; F[0].x += push; F[1].x -= push;
  }
  f.parts = f.parts.filter(p => { p.x += p.vx * dt * 60; p.y += p.vy * dt * 60; p.vy += 0.14 * dt * 60; p.life -= dt * 1.8; return p.life > 0; });
}

function endRound(f, winner) {
  if (f.rOver) return; f.rOver = true; f.F[winner].wins++;
  f.msg = CATS[f.ci[winner]].name + ' WINS!'; f.msgT = 999; sRiffRound();
  setTimeout(() => {
    if (f.F[winner].wins >= 2) { f.over = true; winData = { winner, ci: f.ci.slice() }; sceneName = 'win'; winEnterT = T; drainPressed(); stopBattleAmb(); sRiffMatch(); }
    else { f.round++; resetRound(f); drainPressed(); }
  }, 2200);
}
function resetRound(f) {
  const w = [f.F[0].wins, f.F[1].wins];
  f.F = [
    { x: 185, y: FLOOR - 28, vy: 0, dir: 1, hp: 100, maxHp: 100, state: 'idle', stateT: 0, phase: 0, sync: 0, gnd: true, jumps: 0, bullets: [], cd: 0, hurtT: 0, wins: w[0] },
    { x: W - 185, y: FLOOR - 28, vy: 0, dir: -1, hp: 100, maxHp: 100, state: 'idle', stateT: 0, phase: 0, sync: 0, gnd: true, jumps: 0, bullets: [], cd: 0, hurtT: 0, wins: w[1] },
  ];
  f.rOver = false; f.parts = []; f.flash = 0; f.msg = 'ROUND ' + f.round; f.msgT = 1.2;
  f.suddenDeath = false; f.timer = 180; f.timeUp = false;
}

function drawFight(f) {
  const F = f.F;
  drawBG(T, f.ci[0], f.ci[1], f.beatF);
  drawFloor(T, f.ci[0], f.ci[1]);
  if (f.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${f.flash * 5})`; ctx.fillRect(0, 0, W, H); }
  F.forEach((fi, pi) => { if (fi.state === 'dead' && fi.y > H + 80) return; drawCat(fi.x, fi.y, fi.dir, f.ci[pi], T, fi.state, fi.hurtT, 1, fi.sync); });
  F.forEach((fi, pi) => {
    const C = CATS[f.ci[pi]];
    fi.bullets.forEach(b => {
      for (let tr = 1; tr <= 8; tr++) {
        const ta = Math.max(0.001, b.age - tr * 0.035);
        const tp = C.projPath(ta, b.ox, b.oy, b.tx, b.ty);
        ctx.fillStyle = C.css; ctx.globalAlpha = (8 - tr) / 8 * (b.isPeak ? 0.45 : 0.2);
        ctx.beginPath(); ctx.arc(tp.x, tp.y, (b.isPeak ? 10 : 7) * (8 - tr) / 8 + 1, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = b.isPeak ? '#fff' : C.css; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.arc(b.x, b.y, b.isPeak ? 9 : 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.css; ctx.globalAlpha = 0.22; ctx.beginPath(); ctx.arc(b.x, b.y, b.isPeak ? 20 : 13, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    });
  });
  f.parts.forEach(p => { ctx.fillStyle = p.col; ctx.globalAlpha = p.life; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life + 1, 0, Math.PI * 2); ctx.fill(); });
  ctx.globalAlpha = 1;

  F.forEach((fi, pi) => {
    const C = CATS[f.ci[pi]];
    const bx = pi === 0 ? 28 : W - 278, by = 18;
    ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.beginPath(); ctx.roundRect(bx - 4, by - 4, 258, 18, 5); ctx.fill();
    ctx.fillStyle = '#1e293b'; ctx.beginPath(); ctx.roundRect(bx, by, 250, 10, 4); ctx.fill();
    const pct = fi.hp / fi.maxHp, hc = pct > 0.5 ? C.css : pct > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillStyle = hc;
    if (pi === 0) { ctx.beginPath(); ctx.roundRect(bx, by, 250 * pct, 10, 4); ctx.fill(); }
    else { ctx.beginPath(); ctx.roundRect(bx + 250 * (1 - pct), by, 250 * pct, 10, 4); ctx.fill(); }
    ctx.font = 'bold 10px monospace'; ctx.textAlign = pi === 0 ? 'left' : 'right'; ctx.fillStyle = C.css;
    ctx.fillText(C.name, pi === 0 ? bx : bx + 250, by + 24);
    for (let i = 0; i < fi.wins; i++) {
      const cx = pi === 0 ? W / 2 - 78 - i * 20 : W / 2 + 78 + i * 20;
      drawSatanicStar(cx, by + 5, 14);
    }
    const smX = pi === 0 ? 12 : W - 12, smY = 44, smH = 65;
    ctx.fillStyle = '#1e293b'; ctx.fillRect(smX - 4, smY, 8, smH);
    ctx.fillStyle = fi.sync > 0.82 ? '#fff' : C.css; ctx.fillRect(smX - 4, smY + smH - fi.sync * smH, 8, fi.sync * smH);
    if (fi.sync > 0.82) { ctx.fillStyle = C.css; ctx.globalAlpha = 0.25 + Math.sin(T * 18) * 0.25; ctx.fillRect(smX - 8, smY, 16, smH); ctx.globalAlpha = 1; }
    ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = fi.sync > 0.82 ? '#fff' : '#475569';
    ctx.fillText('SYNC', smX, smY + smH + 10);
    ctx.fillText(fi.sync > 0.82 ? 'PEAK!' : Math.round(fi.sync * 100) + '%', smX, smY + smH + 20);
  });
  const tLeft = Math.max(0, f.timer);
  const mm = Math.floor(tLeft / 60);
  const ss = Math.floor(tLeft % 60);
  const timeStr = f.suddenDeath ? 'SUDDEN DEATH' : mm + ':' + (ss < 10 ? '0' : '') + ss;
  const urgent = f.suddenDeath || tLeft <= 10;
  const warning = tLeft <= 30;
  ctx.textAlign = 'center';
  ctx.font = 'bold 22px monospace';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 5;
  ctx.fillStyle = '#fff';
  ctx.strokeText('ROUND ' + f.round, W / 2, 24);
  ctx.fillText('ROUND ' + f.round, W / 2, 24);
  const timeColor = urgent ? '#ef4444' : warning ? (Math.sin(T * 8) > 0 ? '#ef4444' : '#fff') : '#fff';
  const timeSize = urgent ? 34 : warning ? 30 : 28;
  ctx.font = 'bold ' + timeSize + 'px monospace';
  ctx.lineWidth = 6;
  ctx.save();
  ctx.shadowColor = urgent ? '#ef4444' : warning ? '#fca5a5' : '#94a3b8';
  ctx.shadowBlur = urgent ? 18 : 10;
  ctx.strokeText(timeStr, W / 2, 58);
  ctx.fillStyle = timeColor;
  ctx.fillText(timeStr, W / 2, 58);
  ctx.restore();
  if (f.msgT > 0) {
    ctx.globalAlpha = Math.min(f.msgT, 0.4) / 0.4;
    ctx.font = 'bold 46px monospace'; ctx.textAlign = 'center';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 8; ctx.strokeText(f.msg, W / 2, H / 2 - 20);
    ctx.fillStyle = f.msg.includes('PEAK') ? '#fff' : '#b00020';
    ctx.fillText(f.msg, W / 2, H / 2 - 20); ctx.globalAlpha = 1;
  }
}

// ── WIN ─────────────────────────────────────────────────────────
function drawWin() {
  ctx.fillStyle = '#04000e'; ctx.fillRect(0, 0, W, H);
  const C = CATS[winData.ci[winData.winner]];
  ctx.globalAlpha = 0.12;
  C.bgDraw(T, 1);
  drawCat(W / 2, FLOOR - 28, 1, winData.ci[winData.winner], T, 'idle', 0, 1.6, 0.9);
  ctx.textAlign = 'center'; ctx.font = 'bold 50px monospace';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 9; ctx.strokeText(C.name + ' WINS!', W / 2, H / 2 - 80);
  ctx.fillStyle = '#b00020'; ctx.fillText(C.name + ' WINS!', W / 2, H / 2 - 80);
  ctx.font = '16px monospace'; ctx.fillStyle = '#fff'; ctx.fillText(C.subtitle, W / 2, H / 2 - 50);
  ctx.font = 'bold 11px monospace'; ctx.fillStyle = '#b00020';
  ctx.textAlign = 'left';
  ctx.fillText('START / BUTTON 1: REMATCH', 16, H - 14);
  ctx.textAlign = 'right';
  ctx.fillText('DOWN: SELECT', W - 16, H - 14);
}

// ── INPUT ───────────────────────────────────────────────────────
function normKey(k) {
  if (typeof k !== 'string' || !k.length) return '';
  if (k === ' ') return 'space';
  return k.toLowerCase();
}
function isHeld(code) { return controls.held[code] === true; }
function consumePressed(codes) {
  for (const c of codes) if (controls.pressed[c]) { controls.pressed[c] = false; return true; }
  return false;
}
function getHoriz(pi) {
  let a = 0;
  if (isHeld(pi === 0 ? 'P1_L' : 'P2_L')) a -= 1;
  if (isHeld(pi === 0 ? 'P1_R' : 'P2_R')) a += 1;
  return a;
}

function onKey(e, down) {
  if (down) initAudio();
  const k = normKey(e.key); if (!k) return;
  const code = KEY_TO_ARCADE[k]; if (!code) return;
  if (down) {
    if (!controls.held[code]) controls.pressed[code] = true;
    controls.held[code] = true;
  } else {
    controls.held[code] = false;
  }
}

// Move cursor in direction `dir` (+1 right, -1 left), skipping the card currently
// held by the other player (cursor or confirmed — both live on sel.cursor[other]).
function advanceCursor(pi, dir) {
  const other = 1 - pi;
  let next = (sel.cursor[pi] + dir + 4) % 4;
  if (next === sel.cursor[other]) next = (next + dir + 4) % 4;
  return next;
}

function handleInput() {
  if (sceneName === 'select') {
    // P1 cursor
    if (!sel.confirmed[0]) {
      if (consumePressed(['P1_L'])) { sel.cursor[0] = advanceCursor(0, -1); sSelect(); }
      if (consumePressed(['P1_R'])) { sel.cursor[0] = advanceCursor(0, 1); sSelect(); }
    }
    // P1 confirm/unconfirm
    if (consumePressed(['P1_1'])) {
      if (sel.confirmed[0] && !sel.confirmed[1]) { sel.confirmed[0] = false; sel.chosen[0] = -1; tone(300, 'sine', 0.1, 0.08, 200); }
      else if (!sel.confirmed[0]) {
        if (sel.cursor[0] === sel.cursor[1] && sel.confirmed[1]) tone(200, 'square', 0.1, 0.1);
        else { sel.confirmed[0] = true; sel.chosen[0] = sel.cursor[0]; sConfirm(); sMeow(400); }
      }
    }
    // P2 cursor
    if (!sel.confirmed[1]) {
      if (consumePressed(['P2_L'])) { sel.cursor[1] = advanceCursor(1, -1); sSelect(); }
      if (consumePressed(['P2_R'])) { sel.cursor[1] = advanceCursor(1, 1); sSelect(); }
    }
    // P2 confirm/unconfirm
    if (consumePressed(['P2_1'])) {
      if (sel.confirmed[1] && !sel.confirmed[0]) { sel.confirmed[1] = false; sel.chosen[1] = -1; tone(300, 'sine', 0.1, 0.08, 200); }
      else if (!sel.confirmed[1]) {
        if (sel.cursor[1] === sel.cursor[0] && sel.confirmed[0]) tone(200, 'square', 0.1, 0.1);
        else { sel.confirmed[1] = true; sel.chosen[1] = sel.cursor[1]; sConfirm(); sMeow(480); }
      }
    }
    if (sel.confirmed[0] && sel.confirmed[1] && !sel.transitioning) {
      // Hold both confirmed selections on screen for a second so player 2's
      // label/card is visible before the fight starts. `transitioning` guards
      // re-trigger without clearing the visual state mid-countdown.
      sel.transitioning = true;
      const a = sel.chosen[0], b = sel.chosen[1];
      setTimeout(() => {
        fight = mkFight(a, b); fight.msg = 'ROUND 1'; fight.msgT = 1.2;
        sceneName = 'fight'; sRound(); startBattleAmb();
        sel.confirmed[0] = sel.confirmed[1] = false;
        sel.chosen[0] = sel.chosen[1] = -1;
        sel.transitioning = false;
      }, 650);
    }
    drainPressed();
    return;
  }

  if (sceneName === 'fight' && fight) {
    if (!fight.rOver) {
      const spd = 5;
      if (isHeld('P1_L')) fight.F[0].x -= spd;
      if (isHeld('P1_R')) fight.F[0].x += spd;
      if (isHeld('P2_L')) fight.F[1].x -= spd;
      if (isHeld('P2_R')) fight.F[1].x += spd;
      if (consumePressed(['P1_U'])) doJump(fight, 0);
      if (consumePressed(['P1_1'])) doAttack(fight, 0);
      if (consumePressed(['P2_U'])) doJump(fight, 1);
      if (consumePressed(['P2_1'])) doAttack(fight, 1);
    }
    drainPressed();
    return;
  }

  if (sceneName === 'win') {
    if (T - winEnterT < 0.6) { drainPressed(); return; }
    if (consumePressed(['START1', 'START2', 'P1_1', 'P2_1'])) {
      fight = mkFight(winData.ci[0], winData.ci[1]);
      fight.msg = 'ROUND 1'; fight.msgT = 1.2; sceneName = 'fight'; sRound(); startBattleAmb();
    }
    if (consumePressed(['P1_D', 'P2_D'])) {
      sel.confirmed = [false, false]; sel.chosen = [-1, -1]; sceneName = 'select';
    }
    drainPressed();
  }
}

function drainPressed() { for (const k in controls.pressed) controls.pressed[k] = false; }

function doAttack(f, pi) {
  const fi = f.F[pi], opp = f.F[1 - pi];
  if (fi.cd > 0 || fi.state === 'dead' || fi.state === 'hurt') return;
  fi.cd = 0.25; fi.state = 'attack'; fi.stateT = 0.16; sShoot(200 + pi * 120);
  const isPeak = fi.sync > 0.82, dmg = Math.round(8 * (0.5 + fi.sync * 1.5));
  fi.bullets.push({ ox: fi.x + fi.dir * 20, oy: fi.y - 20, tx: opp.x, ty: opp.y - 20, x: fi.x, y: fi.y - 20, age: 0, spd: 1.6 + fi.sync * 0.6, dmg, hit: false, isPeak });
}
function doJump(f, pi) {
  const fi = f.F[pi]; if (fi.state === 'dead' || fi.jumps >= 2) return;
  fi.vy = -16; fi.jumps++; fi.state = 'jump'; sMeow(300 + pi * 80);
}

