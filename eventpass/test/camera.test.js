import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { extractCode } from '../public/js/lib/camera.js';
import { randomCode } from '../server/lib/tokens.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

test('what a scanned QR is allowed to mean', async (t) => {
  await t.test('a bare code is accepted in any case, with stray whitespace', () => {
    assert.equal(extractCode('k7m2p9qx'), 'K7M2P9QX');
    assert.equal(extractCode('  K7M2P9QX\r\n'), 'K7M2P9QX');
  });
  await t.test('the invitation link inside a message also works', () => {
    assert.equal(extractCode('https://events.example.co.tz/i/K7M2P9QX'), 'K7M2P9QX');
    assert.equal(extractCode('https://events.example.co.tz/i/k7m2p9qx/?utm=x#top'), 'K7M2P9QX');
  });
  await t.test('anything else is rejected rather than guessed at', () => {
    for (const bad of ['', '   ', 'hello world', 'K7M2', 'K7M2P9QXZZZZZ', 'javascript:alert(1)', 'https://evil.example/login', 'https://x/i/', 'https://x/i/AB', 'K7M2 P9QX', null, undefined, 42]) assert.equal(extractCode(bad), null, String(bad));
  });
});

// The scanner falls back to the bundled jsQR where the browser has no native QR detector (iPhones, Firefox).
// Prove it can read the very QR codes the server hands out, at several sizes and colour contrasts.
test('the bundled decoder reads the server\'s QR codes', async (t) => {
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, 'vendor', 'jsqr.js'), 'utf8'), sandbox);
  const jsQR = sandbox.self.jsQR || sandbox.jsQR || sandbox.module?.exports;
  assert.equal(typeof jsQR, 'function', 'the vendored file exposes jsQR');

  function render(text, { scale = 6, dark = [28, 24, 20], light = [255, 255, 255], margin = 4 } = {}) {
    const q = QRCode.create(text, { errorCorrectionLevel: 'H' }).modules;
    const size = (q.size + margin * 2) * scale;
    const px = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin, my = Math.floor(y / scale) - margin;
      const on = mx >= 0 && my >= 0 && mx < q.size && my < q.size && q.get(mx, my);
      const c = on ? dark : light; const i = (y * size + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
    return { px, size };
  }

  await t.test('at phone-camera-ish sizes', () => {
    for (const scale of [3, 5, 8]) {
      const code = randomCode(8); const { px, size } = render(code, { scale });
      assert.equal(jsQR(px, size, size)?.data, code, `scale ${scale}`);
    }
  });
  await t.test('with the low contrast of a dim, dusty screen', () => {
    const code = randomCode(8); const { px, size } = render(code, { dark: [90, 90, 96], light: [200, 198, 190] });
    assert.equal(jsQR(px, size, size)?.data, code);
  });
  await t.test('when part of the code is damaged (error correction level H)', () => {
    const code = randomCode(8); const { px, size } = render(code, { scale: 6 });
    for (let y = size - 60; y < size - 20; y++) for (let x = size - 60; x < size - 20; x++) { const i = (y * size + x) * 4; px[i] = px[i + 1] = px[i + 2] = 255 - px[i]; }
    assert.equal(jsQR(px, size, size)?.data, code);
  });
  await t.test('and finds nothing in a blank frame', () => {
    const px = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    assert.equal(jsQR(px, 200, 200), null);
  });
});
