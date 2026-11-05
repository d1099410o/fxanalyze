import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_DIR = path.join(ROOT, '..', 'data');
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, 'provider-key.enc.json');
const FORMAT_VERSION = 1;

export function isSetupTokenValid(candidate, expected = process.env.FXPULSE_SETUP_TOKEN || '') {
  if (typeof candidate !== 'string' || !expected || candidate.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

function deriveKey(setupToken, salt) {
  if (typeof setupToken !== 'string' || setupToken.length < 32) {
    throw new Error('FXPULSE_SETUP_TOKEN must contain at least 32 characters.');
  }
  return scryptSync(setupToken, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptProviderKey(apiKey, setupToken) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(setupToken, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return {
    version: FORMAT_VERSION,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    updatedAt: new Date().toISOString(),
  };
}

export function decryptProviderKey(payload, setupToken) {
  if (!payload || payload.version !== FORMAT_VERSION || payload.algorithm !== 'aes-256-gcm' || payload.kdf !== 'scrypt') {
    throw new Error('Unsupported encrypted provider-key format.');
  }
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ciphertext.length < 8 || ciphertext.length > 1024) {
    throw new Error('Invalid encrypted provider-key payload.');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(setupToken, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function saveProviderKey(apiKey, setupToken) {
  const payload = encryptProviderKey(apiKey, setupToken);
  mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  const temporaryPath = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, CREDENTIALS_FILE);
  chmodSync(CREDENTIALS_FILE, 0o600);
  return payload.updatedAt;
}

export function loadProviderKey(setupToken = process.env.FXPULSE_SETUP_TOKEN || '') {
  try {
    const payload = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8'));
    return decryptProviderKey(payload, setupToken);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    // A wrong/missing master token must fail closed. Never return the ciphertext as a key.
    return '';
  }
}

export function removeProviderKey() {
  try { unlinkSync(CREDENTIALS_FILE); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return true;
}
