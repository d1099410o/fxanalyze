import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file));
const manifest = JSON.parse(read('public/manifest.webmanifest').toString('utf8'));
assert.ok(manifest.name && manifest.short_name, 'Manifest musi zawierać name i short_name');
assert.equal(manifest.start_url, '/?source=pwa');
assert.equal(manifest.scope, '/');
assert.ok(['standalone', 'minimal-ui', 'fullscreen'].includes(manifest.display));
assert.equal(manifest.prefer_related_applications, false);
for (const size of [192, 512]) {
  assert.ok(manifest.icons.some(icon => icon.sizes === `${size}x${size}` && icon.type === 'image/png'), `Brak ikony ${size}x${size}`);
}
for (const icon of manifest.icons) {
  assert.ok(fs.existsSync(path.join(root, 'public', icon.src.replace(/^\//, ''))), `Brak pliku ikony: ${icon.src}`);
}
const checkPng = (file, expected) => {
  const bytes = read(file);
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(bytes.readUInt32BE(16), expected, `${file}: nieprawidłowa szerokość`);
  assert.equal(bytes.readUInt32BE(20), expected, `${file}: nieprawidłowa wysokość`);
};
checkPng('public/icons/icon-192.png', 192);
checkPng('public/icons/icon-512.png', 512);
checkPng('public/icons/icon-maskable-512.png', 512);
checkPng('public/icons/apple-touch-icon.png', 180);
const html = read('public/index.html').toString('utf8');
assert.match(html, /rel="manifest"/);
assert.match(html, /apple-touch-icon/);
assert.match(html, /id="installBtn"/);
assert.match(html, /id="installGuide"/);
const sw = read('public/sw.js').toString('utf8');
assert.match(sw, /fx-pulse-pwa-v5/);
assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/, 'API musi być wyłączone z cache');
assert.match(sw, /offline\.html/);
console.log('PWA CHECK: OK — manifest, ikony, install UI, Service Worker i wykluczenie API z cache.');
