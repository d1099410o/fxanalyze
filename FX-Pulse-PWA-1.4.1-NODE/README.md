# FX Pulse PWA 1.4.1

**FX Pulse jest teraz aplikacją instalowaną bezpośrednio z przeglądarki.** Nie wymaga Android Studio, Gradle ani pliku APK. Otwierasz publiczny adres HTTPS w Chrome na Androidzie i wybierasz „Zainstaluj aplikację”. Na iPhonie dodajesz ją z menu Udostępnij w Safari.

## Co zawiera

- instalowalny manifest PWA z ikonami 192/512, osobną ikoną maskable i ikoną Apple Touch;
- własny przycisk „Zainstaluj” oraz instrukcję dopasowaną do Androida, iPhone'a i komputera;
- Service Worker z aktualizacją powłoki, cache offline i stroną awaryjną;
- API i backend Node.js na tym samym originie — bez klucza dostawcy w aplikacji;
- kreator Twelve Data LIVE, który testuje OHLC i zapisuje klucz AES-256-GCM na serwerze;
- domyślny DEMO, silnik wskaźników i analiza MTF 5m/15m/30m.

**LIVE i analiza wymagają połączenia z serwerem.** Offline dostępna jest wyłącznie zapisana powłoka aplikacji; Service Worker nigdy nie cache'uje `/api/*` ani kluczy.

## Uruchomienie jako serwer Node.js — Windows / macOS / Linux

Wymagania: Node.js 22 LTS (minimum 20). Projekt nie ma zewnętrznych zależności runtime i nie wymaga `npm install`.

### Windows — najprościej

1. Zainstaluj Node.js 22 LTS z https://nodejs.org/.
2. Rozpakuj cały ZIP do zwykłego folderu, np. `C:\FX-Pulse`.
3. Kliknij dwukrotnie `START-FXPULSE-WINDOWS.bat`.
4. Skrypt przygotuje `.env`, wygeneruje prywatny token administratora, sprawdzi serwer i uruchomi Node.js.
5. Otwórz `http://localhost:3000`. Nie zamykaj okna terminala; `Ctrl+C` zatrzymuje serwer.

### macOS / Linux

```bash
chmod +x START-FXPULSE-MAC-LINUX.sh
./START-FXPULSE-MAC-LINUX.sh
```

### Ręcznie na dowolnym systemie

```bash
node scripts/setup.mjs
npm run check
npm test
npm run verify:server
npm start
```

Otwórz `http://localhost:3000`. Serwer nasłuchuje na `0.0.0.0` i wypisuje także adresy IPv4 LAN. Telefon i komputer muszą być w tej samej sieci Wi-Fi; firewall Windows może wymagać zezwolenia na Node.js w sieci prywatnej.

**Ważne dla PWA:** dostęp po adresie LAN `http://192.168.x.x:3000` jest przeznaczony do podglądu/testów. Instalacja PWA oraz konfiguracja klucza API z telefonu wymagają HTTPS. `localhost` jest bezpiecznym kontekstem na tym samym komputerze; inny telefon potrzebuje publicznego HTTPS przez domenę, reverse proxy TLS lub zaufany tunel.

## Wdrożenie w Internecie — Docker + automatyczne HTTPS

Najprostszy wariant dla własnego serwera VPS z publicznym adresem IP i domeną:

1. Skopiuj zawartość repozytorium na serwer z Docker Engine i Docker Compose.
2. Skopiuj `.env.deploy.example` do `.env`.
3. Ustaw `DOMAIN` na domenę, której rekord A/AAAA wskazuje na serwer.
4. Wygeneruj token administracyjny:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

5. Wklej wynik do `FXPULSE_SETUP_TOKEN` w `.env`. Nie publikuj `.env` i nie wysyłaj go w wiadomościach.
6. Uruchom:

```bash
docker compose up -d --build
```

Caddy automatycznie pobierze certyfikat TLS po skierowaniu DNS na serwer i udostępni aplikację przez HTTPS. Port Node `3000` nie jest wystawiony publicznie — dostęp odbywa się przez Caddy. Dane zaszyfrowanego klucza są trwale przechowywane w wolumenie `fxpulse_data`.

Wymagane porty serwera: TCP 80 i TCP/UDP 443. Upewnij się, że DNS domeny wskazuje prawidłowy adres serwera.

### Wdrożenie Render

W repozytorium znajduje się `render.yaml` jako Blueprint Docker. Po umieszczeniu projektu w repozytorium GitHub wybierz w Render **New → Blueprint**, wskaż repozytorium i zastosuj plan. Blueprint tworzy serwis HTTPS, generuje `FXPULSE_SETUP_TOKEN` i montuje trwały dysk pod `/app/data`. Renderowy trwały dysk wymaga planu obsługującego persistent disk; przed zatwierdzeniem sprawdź aktualne warunki i koszty platformy.

## Instalacja na telefonie

### Android — Chrome

1. Otwórz otrzymany publiczny adres `https://...` w Google Chrome.
2. Poczekaj na załadowanie aplikacji i danych.
3. Dotknij przycisku **Zainstaluj** w nagłówku FX Pulse. Jeśli przeglądarka wyświetli natywne okno instalacji — potwierdź.
4. Gdy okno nie wyskoczy, otwórz menu Chrome `⋮` → **Zainstaluj aplikację** lub **Dodaj do ekranu głównego**.
5. Uruchamiaj FX Pulse z nowej ikony na ekranie głównym.

### iPhone / iPad

1. Otwórz HTTPS w Safari.
2. Dotknij **Udostępnij** → **Dodaj do ekranu początkowego**.
3. Włącz **Otwórz jako aplikację internetową**, jeśli opcja jest widoczna.
4. Dotknij **Dodaj**.

### Komputer

Chrome / Edge: użyj ikony instalacji w pasku adresu albo menu przeglądarki → **Zainstaluj FX Pulse**.

## Kreator danych LIVE

1. Otwórz aplikację pod adresem HTTPS.
2. Wybierz **API**.
3. Wklej klucz Twelve Data z panelu dostawcy i `FXPULSE_SETUP_TOKEN` skonfigurowany na serwerze.
4. Wybierz **Sprawdź i połącz**. Kreator wykona test OHLC EUR/USD 5m.
5. Dopiero po udanym teście tryb LIVE będzie dostępny.

Klucz API nie jest trzymany w `localStorage`, URL ani plikach PWA. Jest wysyłany do backendu przez HTTPS i zapisywany w `/app/data` jako AES-256-GCM. Token setup jest sekretem administratora. Zachowaj kopię zapasową tokenu — jest używany do wyprowadzenia klucza szyfrującego.

## Aktualizacje PWA

Service Worker stosuje network-first dla plików aplikacji, aktualizuje powłokę przy dostępie do sieci i usuwa stare cache po aktywacji nowej wersji. Dane API nigdy nie trafiają do cache przeglądarki. Po wdrożeniu nowej wersji odśwież aplikację; przeglądarka pobierze nowy Service Worker.

## Testy i walidacja

```bash
npm run check
npm test
npm run verify:server
```

`npm run verify:server` uruchamia serwer na losowym porcie i sprawdza HTML, manifest, Service Worker, stronę offline i `/api/health`.

`npm run check` waliduje składnię i instalowalność PWA (manifest, ikony, przycisk, Service Worker, wykluczenie API z cache). `npm test` uruchamia testy silnika i backendu wraz z testami zasobów PWA.

## Ograniczenia

- Nie jest to natywny APK. PWA instalowana z HTTPS zapewnia ikonę i tryb standalone, ale zachowanie instalacji różni się w zależności od przeglądarki i systemu.
- Przeglądarka nie zawsze pokaże automatyczny prompt; własny przycisk prezentuje instrukcję instalacji ręcznej.
- DEMO korzysta z danych syntetycznych i nie generuje zleceń.
- Sygnały LIVE są analizą techniczną, nie gwarancją wyniku ani poradą inwestycyjną.
- Nie ma integracji z brokerem ani handlu automatycznego.
