import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptProviderKey, encryptProviderKey, isSetupTokenValid } from '../src/provider-config.js';

const TOKEN = 'fxpulse-test-admin-token-that-is-long-enough-123456';

test('provider API key is encrypted and can only be decrypted with the setup token', () => {
  const secret = 'twelve-data-api-key-example-abc123';
  const encrypted = encryptProviderKey(secret, TOKEN);
  assert.equal(encrypted.algorithm, 'aes-256-gcm');
  assert.equal(encrypted.kdf, 'scrypt');
  assert.ok(!JSON.stringify(encrypted).includes(secret));
  assert.equal(decryptProviderKey(encrypted, TOKEN), secret);
  assert.throws(() => decryptProviderKey(encrypted, `${TOKEN}-wrong`));
});

test('setup token comparison rejects absent and altered tokens', () => {
  assert.equal(isSetupTokenValid(TOKEN, TOKEN), true);
  assert.equal(isSetupTokenValid('', TOKEN), false);
  assert.equal(isSetupTokenValid(TOKEN.slice(1), TOKEN), false);
  assert.equal(isSetupTokenValid(`${TOKEN}x`, TOKEN), false);
});
