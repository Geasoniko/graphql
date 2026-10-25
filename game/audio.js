import { store } from './util.js';

// Tiny WebAudio synth: dance beat, waltz, chimes, crunches, countdown beeps.
export const audio = { ctx: null, master: null, on: store.get('lg_sound', true), mode: null, next: 0, step: 0, noise: null };
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export function ensureAudio() {
  try {
    if (!audio.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audio.ctx = new AC();
      audio.master = audio.ctx.createGain();
      audio.master.gain.value = 0.32;
      audio.master.connect(audio.ctx.destination);
      const len = audio.ctx.sampleRate * 0.5;
      audio.noise = audio.ctx.createBuffer(1, len, audio.ctx.sampleRate);
      const d = audio.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
  } catch { /* audio unavailable */ }
}
const ready = () => audio.ctx && audio.on;

function tone(freq, t, dur, type = 'sine', vol = 0.2) {
  const { ctx, master } = audio;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.05);
}
function kick(t) {
  const { ctx, master } = audio;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
  g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  o.connect(g).connect(master); o.start(t); o.stop(t + 0.25);
}
function noise(t, vol, freq, dur, type = 'highpass') {
  const { ctx, master } = audio;
  const s = ctx.createBufferSource(); s.buffer = audio.noise;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(master); s.start(t, Math.random() * 0.3); s.stop(t + dur + 0.02);
}
const DANCE_BASS = [45, 45, 57, 45, 43, 43, 55, 43, 41, 41, 53, 41, 43, 43, 55, 47];
const DANCE_CHORDS = [[57, 60, 64], [55, 59, 62], [53, 57, 60], [55, 59, 62]];
const WALTZ = [
  [48, [64, 67, 72], [76, 79, 84]], [48, [64, 67, 72], [83, 81, 79]], [43, [65, 67, 71], [77, 76, 74]], [43, [65, 67, 71], [74, 0, 0]],
  [43, [65, 67, 71], [71, 74, 79]], [43, [65, 67, 71], [77, 76, 74]], [48, [64, 67, 72], [72, 76, 79]], [48, [64, 67, 72], [84, 0, 0]],
  [41, [65, 69, 72], [81, 79, 77]], [41, [65, 69, 72], [76, 77, 81]], [48, [64, 67, 72], [79, 76, 72]], [45, [64, 69, 72], [76, 0, 0]],
  [50, [65, 69, 74], [77, 76, 74]], [43, [65, 67, 71], [74, 76, 77]], [48, [64, 67, 72], [76, 74, 72]], [48, [64, 67, 72], [72, 0, 0]],
];
function playStep(mode, step, t) {
  if (mode === 'dance') {
    if (step % 2 === 0) kick(t); else noise(t, 0.12, 7000, 0.05);
    if (step % 4 === 2) noise(t, 0.2, 7000, 0.05);
    tone(midi(DANCE_BASS[step % 16]), t, 0.22, 'square', 0.06);
    if (step % 4 === 0) DANCE_CHORDS[Math.floor(step / 4) % 4].forEach((n) => tone(midi(n + 12), t, 0.18, 'sawtooth', 0.025));
  } else if (mode === 'waltz') {
    const bar = WALTZ[Math.floor(step / 3) % WALTZ.length];
    const beat = step % 3;
    if (beat === 0) tone(midi(bar[0]), t, 0.6, 'triangle', 0.22);
    else bar[1].forEach((n) => tone(midi(n), t, 0.28, 'triangle', 0.05));
    const m = bar[2][beat];
    if (m) tone(midi(m), t, beat === 0 && !bar[2][1] ? 1.0 : 0.4, 'sine', 0.11);
  }
}
const stepDur = (mode) => (mode === 'dance' ? 0.25 : 60 / 168);
setInterval(() => {
  if (!audio.ctx || !audio.mode || !audio.on) return;
  if (audio.next < audio.ctx.currentTime) audio.next = audio.ctx.currentTime + 0.05;
  while (audio.next < audio.ctx.currentTime + 0.15) {
    playStep(audio.mode, audio.step, audio.next);
    audio.next += stepDur(audio.mode);
    audio.step++;
  }
}, 30);

export function setMusic(mode) {
  if (audio.mode === mode) return;
  audio.mode = mode;
  audio.step = 0;
  if (audio.ctx) audio.next = audio.ctx.currentTime + 0.05;
}
export function chime() {
  if (!ready()) return;
  const t = audio.ctx.currentTime + 0.02;
  [76, 79, 83, 88].forEach((n, i) => tone(midi(n), t + i * 0.09, 0.8, 'sine', 0.12));
}
export function coin() {
  if (!ready()) return;
  const t = audio.ctx.currentTime + 0.01;
  tone(midi(88), t, 0.12, 'square', 0.06);
  tone(midi(93), t + 0.08, 0.3, 'square', 0.06);
}
export function crunch() {
  if (!ready()) return;
  const t = audio.ctx.currentTime + 0.01;
  for (let i = 0; i < 3; i++) noise(t + i * 0.07, 0.25, 1800, 0.05, 'bandpass');
}
export function slurp() {
  if (!ready()) return;
  noise(audio.ctx.currentTime + 0.01, 0.15, 600, 0.4, 'lowpass');
}
export function beep(high) {
  if (!ready()) return;
  tone(midi(high ? 84 : 72), audio.ctx.currentTime + 0.01, high ? 0.6 : 0.25, 'sine', 0.25);
}
