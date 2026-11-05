import assert from 'node:assert/strict';
import { createAppServer } from '../server.js';

const server = createAppServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const checks = [
  ['/', 200, 'text/html'],
  ['/manifest.webmanifest', 200, 'application/manifest+json'],
  ['/sw.js', 200, 'javascript'],
  ['/offline.html', 200, 'text/html'],
  ['/api/health', 200, 'application/json'],
];

try {
  for (const [pathname, expectedStatus, contentTypePart] of checks) {
    const response = await fetch(`${origin}${pathname}`, { cache: 'no-store' });
    const body = await response.text();
    assert.equal(response.status, expectedStatus, `${pathname}: nieprawidłowy status`);
    assert.ok(response.headers.get('content-type')?.includes(contentTypePart), `${pathname}: nieprawidłowy Content-Type`);
    assert.ok(body.length > 0, `${pathname}: pusta odpowiedź`);
    if (pathname === '/api/health') {
      const payload = JSON.parse(body);
      assert.equal(payload.ok, true);
      assert.ok(response.headers.get('cache-control')?.includes('no-store'));
    }
    console.log(`PASS ${pathname} → HTTP ${response.status}`);
  }
  console.log('SERVER SMOKE TEST: PASS');
} finally {
  await new Promise(resolve => server.close(resolve));
}
