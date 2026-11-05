import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file));

test('PWA manifest has installability fields and required icon sizes', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest').toString('utf8'));
  assert.ok(manifest.name && manifest.short_name);
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
});

test('install guide and Apple touch icon are included', () => {
  const html = read('public/index.html').toString('utf8');
  assert.match(html, /id="installBtn"/);
  assert.match(html, /id="installGuide"/);
  assert.match(html, /apple-touch-icon/);
  assert.ok(fs.existsSync(path.join(root, 'public/icons/apple-touch-icon.png')));
});

test('service worker caches app shell but never handles API responses', () => {
  const sw = read('public/sw.js').toString('utf8');
  assert.match(sw, /fx-pulse-pwa-v5/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /offline\.html/);
});
