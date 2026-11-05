@echo off
setlocal
cd /d "%~dp0"

echo ================================================
echo            FX PULSE 1.4.1 - NODE SERVER
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo BLAD: Nie znaleziono Node.js.
  echo Zainstaluj Node.js 22 LTS z https://nodejs.org/ i uruchom ten plik ponownie.
  pause
  exit /b 1
)

node -e "const v=Number(process.versions.node.split('.')[0]); if(v<20){console.error('Wymagany Node.js 20 lub nowszy. Wykryto '+process.version); process.exit(1)}"
if errorlevel 1 (
  pause
  exit /b 1
)

echo [1/3] Konfiguracja serwera...
node scripts\setup.mjs
if errorlevel 1 (
  echo BLAD konfiguracji. Zobacz komunikat powyzej.
  pause
  exit /b 1
)

echo.
echo [2/3] Test endpointow serwera...
node scripts\smoke-test.mjs
if errorlevel 1 (
  echo BLAD testu serwera. Nie uruchamiam aplikacji.
  pause
  exit /b 1
)

echo.
echo [3/3] Uruchamiam FX Pulse. Nie zamykaj tego okna.
echo Aby zatrzymac serwer, nacisnij Ctrl+C.
echo.
node server.js
set EXITCODE=%ERRORLEVEL%
echo.
echo Serwer zakonczyl prace z kodem %EXITCODE%.
pause
exit /b %EXITCODE%
