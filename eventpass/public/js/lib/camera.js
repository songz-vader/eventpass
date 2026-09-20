import { h } from './dom.js';

// ── what a scanned QR may mean ──
// Our QR codes hold the bare guest code. A link to the invitation (…/i/CODE) is accepted too. Anything else is refused, never guessed at.
const CODE_RE = /^[A-Z0-9]{6,12}$/;
export function extractCode(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 300) return null;
  const direct = s.toUpperCase();
  if (CODE_RE.test(direct)) return direct;
  const m = s.match(/^https?:\/\/[^\s/]+\/i\/([A-Za-z0-9]{6,12})\/?(?:[?#].*)?$/);
  return m ? m[1].toUpperCase() : null;
}

// ── reading frames ──
// Chrome/Android has a built-in QR detector. Everywhere else (iPhone Safari, Firefox) we load the bundled jsQR on demand.
let jsQrLoad;
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQrLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jsqr.js';
    s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('The QR reader did not load.')));
    s.onerror = () => { jsQrLoad = null; reject(new Error('Could not load the QR reader. Check your connection.')); };
    document.head.append(s);
  });
  return jsQrLoad;
}

export async function makeDecoder() {
  if (typeof window.BarcodeDetector === 'function') {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats?.();
      if (!formats || formats.includes('qr_code')) {
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        return { name: 'native', interval: 120, decode: async (video) => (await det.detect(video))[0]?.rawValue || null };
      }
    } catch { /* fall through to jsQR */ }
  }
  const jsQR = await loadJsQr();
  const canvas = document.createElement('canvas');
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  return {
    name: 'jsqr', interval: 200,
    decode: async (video) => {
      const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
      const k = Math.min(1, 640 / vw);                                  // decode a small copy: much faster, and QR codes survive it
      canvas.width = Math.round(vw * k); canvas.height = Math.round(vh * k);
      c2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = c2d.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
    },
  };
}

export class CameraError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
const explain = (e) => {
  if (e instanceof CameraError) return e;
  const n = e?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return new CameraError('denied', 'Camera permission is blocked. Allow camera access for this site in your browser settings, then try again.');
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return new CameraError('none', 'No camera was found on this device.');
  if (n === 'NotReadableError' || n === 'AbortError') return new CameraError('busy', 'The camera is in use by another app. Close it and try again.');
  return new CameraError('error', e?.message || 'The camera could not be started.');
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The scanning loop. It owns the camera stream, calls onCode(code) for each new code it reads, and pauses briefly after each
// one so a guest holding their phone in view is not checked in (or rejected) five times a second.
export function createScanner({ video, onCode, onReject, decoderFactory = makeDecoder, cooldownMs = 1200, repeatMs = 4000, now = () => Date.now() }) {
  let stream = null, running = false, timer = null, decoder = null, busy = false, facing = 'environment';
  let lastCode = '', lastAt = 0, lastBad = 0;

  async function handle(raw) {
    const code = extractCode(raw);
    const t = now();
    if (!code) { if (t - lastBad > 3000) { lastBad = t; onReject?.(raw); } return; }
    if (code === lastCode && t - lastAt < repeatMs) return;
    lastCode = code; lastAt = t;
    await onCode(code);
    await sleep(cooldownMs);
  }

  async function tick() {
    timer = null;
    if (!running) return;
    if (!busy && video.readyState >= 2 && !document.hidden) {
      busy = true;
      try { const raw = await decoder.decode(video); if (raw) await handle(raw); } catch { /* one bad frame is fine */ } finally { busy = false; }
    }
    if (running) timer = setTimeout(tick, decoder.interval);
  }

  async function open() {
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported', 'This browser cannot use the camera on this page. Type the code instead.');
    if (window.isSecureContext === false) throw new CameraError('insecure', 'Camera scanning needs a secure (https) connection. Type the code instead.');
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
    catch (e) { throw explain(e); }
    video.srcObject = stream; video.muted = true; video.setAttribute('playsinline', '');
    try { await video.play(); } catch { /* some browsers start on their own */ }
  }

  function release() {
    if (stream) for (const tr of stream.getTracks()) { try { tr.stop(); } catch { /* already stopped */ } }
    stream = null; video.srcObject = null;
  }

  return {
    get running() { return running; },
    get torchSupported() { return !!stream?.getVideoTracks?.()[0]?.getCapabilities?.().torch; },
    async start() {
      if (running) return;
      await open();
      try { decoder ??= await decoderFactory(); } catch (e) { release(); throw explain(e); }
      running = true; timer = setTimeout(tick, 60);
    },
    stop() { running = false; clearTimeout(timer); timer = null; release(); },
    async flip() { facing = facing === 'environment' ? 'user' : 'environment'; release(); await open(); },
    async torch(on) { await stream?.getVideoTracks?.()[0]?.applyConstraints?.({ advanced: [{ torch: !!on }] }); },
  };
}

// ── feedback the door staff can notice without looking: a tone and a buzz ──
let audio;
export function beep(kind = 'ok') {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = kind === 'ok' ? 880 : kind === 'warn' ? 520 : 220; g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + (kind === 'ok' ? 0.12 : 0.3));
  } catch { /* no audio: the coloured result is still there */ }
  try { navigator.vibrate?.(kind === 'ok' ? 60 : [80, 60, 80]); } catch { /* not supported */ }
}

// The on-screen scanner: camera view, aim guide, and torch / flip / stop buttons. `onCode` returns a promise; scanning waits for it.
export function cameraPanel({ onCode }) {
  const video = h('video', { class: 'cam-video', playsinline: true, muted: true, 'aria-label': 'Camera view' });
  const msg = h('p', { class: 'small muted', role: 'status' }, 'Point the camera at the guest\'s QR code.');
  const torchBtn = h('button', { class: 'btn line sm', type: 'button', hidden: true }, 'Light');
  const flipBtn = h('button', { class: 'btn line sm', type: 'button', hidden: true }, 'Switch camera');
  const stopBtn = h('button', { class: 'btn quiet sm', type: 'button' }, 'Stop camera');
  const el = h('div', { class: 'stack', style: { gap: '.6rem' } }, h('div', { class: 'cam-frame' }, video, h('div', { class: 'cam-guide', 'aria-hidden': 'true' })), msg, h('div', { class: 'row' }, torchBtn, flipBtn, stopBtn));

  const scanner = createScanner({
    video,
    onCode: async (code) => { msg.textContent = 'Reading…'; await onCode(code); msg.textContent = 'Ready for the next guest.'; },
    onReject: () => { msg.textContent = 'That QR code is not an EventPass guest code.'; beep('warn'); },
  });
  let torchOn = false, wantOn = false;
  torchBtn.onclick = async () => { try { torchOn = !torchOn; await scanner.torch(torchOn); torchBtn.textContent = torchOn ? 'Light off' : 'Light'; } catch { torchOn = false; msg.textContent = 'This camera has no light control.'; } };
  flipBtn.onclick = async () => { try { await scanner.flip(); } catch (e) { msg.textContent = e.message; } };
  stopBtn.onclick = () => stop();

  async function start() {
    msg.textContent = 'Starting the camera…';
    try {
      await scanner.start(); wantOn = true;
      msg.textContent = 'Point the camera at the guest\'s QR code.';
      torchBtn.hidden = !scanner.torchSupported; flipBtn.hidden = false;
    } catch (e) { msg.textContent = e.message; wantOn = false; throw e; }
  }
  function stop() { wantOn = false; scanner.stop(); torchOn = false; torchBtn.textContent = 'Light'; el.dispatchEvent(new CustomEvent('camera:stopped')); }

  // A hidden tab keeps the camera light on for nothing: release it, and take it back when the person returns.
  let resume = false;
  const onVis = () => {
    if (document.hidden && scanner.running) { resume = true; scanner.stop(); }
    else if (!document.hidden && resume) { resume = false; scanner.start().catch((e) => { msg.textContent = e.message; }); }
  };
  document.addEventListener('visibilitychange', onVis);
  return { el, start, stop, get running() { return scanner.running; }, destroy() { document.removeEventListener('visibilitychange', onVis); scanner.stop(); }, wantOn: () => wantOn };
}
