# FX Pulse PWA 1.4.1 — status wydania

- Manifest PWA: zweryfikowany.
- Ikony 192×192 i 512×512: zweryfikowane.
- Ikona maskable 512×512: dodana i zweryfikowana.
- Apple Touch icon 180×180: dodana i zweryfikowana.
- Przycisk instalacji + instrukcja Android/iOS/desktop: dodane.
- Service Worker z aktualizacją powłoki i fallback offline: dodany.
- `/api/*` wyłączone z cache Service Workera.
- Nagłówki HTTP dla manifestu/HTML/SW: no-cache.
- Konfiguracja Docker Compose + Caddy HTTPS: dodana.
- Blueprint Render: dodany.
- Android Studio / APK / Gradle: nie są wymagane w tym wydaniu.

## Testy w środowisku roboczym

`npm run check`: PASS.
`npm test`: PASS — 31 testów, 0 błędów.

Smoke test lokalnego serwera: HTTP 200 dla `/`, `/manifest.webmanifest`, `/sw.js`, `/offline.html`, ikony maskable i `/api/health`. Endpoint API zwraca `Cache-Control: no-store, max-age=0`.

## Ograniczenie wydania

Nie wdrożono aplikacji pod publicznym adresem HTTPS, ponieważ wymaga to dostępu do domeny/hostingu i konta użytkownika. Pakiet zawiera konfigurację wdrożenia. Po publikacji pod HTTPS Chrome/Safari umożliwią dodanie aplikacji do ekranu głównego.


## Serwer Node.js 1.4.1

- Dodano `START-FXPULSE-WINDOWS.bat` dla uruchomienia jednym kliknięciem.
- Dodano `START-FXPULSE-MAC-LINUX.sh`.
- `scripts/setup.mjs` tworzy lokalny `.env`, generuje losowy token administratora i katalog danych; nie nadpisuje istniejącego tokenu.
- Serwer wypisuje adres localhost oraz adresy IPv4 sieci LAN.
- Dodano smoke test serwera `npm run verify:server`.
- Projekt nie wymaga `npm install` — używa wyłącznie wbudowanych modułów Node.js.
- Testy: sprawdzenie składni, PWA, testy jednostkowe oraz smoke test serwera.
