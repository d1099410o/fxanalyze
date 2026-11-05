import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

let current = '';
try {
  current = await fs.readFile(envPath, 'utf8');
  console.log('Znaleziono istniejący plik .env — zachowuję jego ustawienia.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  current = await fs.readFile(examplePath, 'utf8');
  console.log('Tworzę lokalny plik .env z bezpiecznej konfiguracji DEMO.');
}

const tokenPattern = /^FXPULSE_SETUP_TOKEN[ \t]*=[ \t]*(.*)$/m;
const match = current.match(tokenPattern);
const tokenValue = match?.[1]?.trim() || '';
const placeholder = !tokenValue || /WKLEJ|CHANGE_ME|REPLACE|YOUR_/i.test(tokenValue);
let tokenCreated = false;
if (placeholder) {
  const token = randomBytes(48).toString('hex');
  if (match) current = current.replace(tokenPattern, `FXPULSE_SETUP_TOKEN=${token}`);
  else current = `${current.trimEnd()}\nFXPULSE_SETUP_TOKEN=${token}\n`;
  tokenCreated = true;
}

if (!/^PORT=/m.test(current)) current += '\nPORT=3000\n';
if (!/^DATA_MODE=/m.test(current)) current += '\nDATA_MODE=demo\n';
await fs.writeFile(envPath, current, { encoding: 'utf8', mode: 0o600 });
await fs.mkdir(path.join(root, 'data'), { recursive: true });

console.log(tokenCreated
  ? 'Wygenerowano token administratora i zapisano go w pliku .env. Otwórz .env, aby skopiować FXPULSE_SETUP_TOKEN do kreatora API. Nie udostępniaj tego tokenu.'
  : 'Zachowano istniejący token administratora.');
console.log('Tryb początkowy: DEMO. Klucz Twelve Data można skonfigurować później w kreatorze API.');
console.log('Konfiguracja serwera gotowa. Uruchom: npm start');
