@echo off
rem Khoi dong VN Stock Advisor: Docker Desktop -> database (docker compose) -> Tailscale (ket noi + mo duong) -> app (node server.js)
rem Nhap dup file nay. App chay ngam (dong cmd khong tat app); tat app bang stop-app.bat.
chcp 65001 >nul
title Khoi dong VN Stock Advisor
cd /d "%~dp0"

echo [1/4] Kiem tra Docker...
docker info >nul 2>&1
if %errorlevel%==0 goto docker_ok
if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
  echo       Dang mo Docker Desktop, cho khoi dong...
  start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
) else (
  echo       Khong tim thay Docker Desktop. App van chay nhung khong luu database.
  goto start_app
)
set /a tries=0
:wait_docker
timeout /t 5 /nobreak >nul
docker info >nul 2>&1
if %errorlevel%==0 goto docker_ok
set /a tries+=1
if %tries% lss 36 goto wait_docker
echo       Docker chua san sang sau 3 phut. App van chay nhung khong luu database.
goto start_app

:docker_ok
echo [2/4] Bat database...
docker compose up -d
if not %errorlevel%==0 echo       Loi khi bat database, xem thong bao o tren.

:start_app
echo [3/4] Khoi dong Tailscale...
set "TSDIR=C:\Program Files\Tailscale"
if not exist "%TSDIR%\tailscale.exe" (
  echo       Chua cai Tailscale, bo qua truy cap tu dien thoai.
  goto run_app
)
rem Mo ung dung Tailscale (khay he thong) neu chua chay. Mo qua explorer de tach khoi cua so nay:
rem "start" truc tiep lam tailscale-ipn bam vao console (in log "ui: ...") va cua so khong tu dong duoc
tasklist /fi "imagename eq tailscale-ipn.exe" | find /i "tailscale-ipn.exe" >nul
if not %errorlevel%==0 explorer.exe "%TSDIR%\tailscale-ipn.exe"
rem Ket noi neu dang ngat (dung tai khoan da dang nhap truoc do)
"%TSDIR%\tailscale.exe" status >nul 2>&1
if not %errorlevel%==0 "%TSDIR%\tailscale.exe" up >nul 2>&1
set /a tstries=0
:wait_ts
"%TSDIR%\tailscale.exe" status >nul 2>&1
if %errorlevel%==0 goto ts_ok
set /a tstries+=1
if %tstries% geq 12 (
  echo       Tailscale chua ket noi. Bam bieu tuong Tailscale o khay he thong ^> Connect ^(hoac dang nhap lai^).
  goto run_app
)
timeout /t 5 /nobreak >nul
goto wait_ts
:ts_ok
rem Mo duong vao app qua Tailscale: https (ten mien) va cong 8080 (dung IP khi dien thoai loi DNS)
"%TSDIR%\tailscale.exe" serve --bg 3000 >nul 2>&1
"%TSDIR%\tailscale.exe" serve --bg --tcp=8080 tcp://127.0.0.1:3000 >nul 2>&1
for /f "delims=" %%i in ('"%TSDIR%\tailscale.exe" ip -4') do set "TSIP=%%i"
echo       Tailscale da ket noi: https://wolf.tailcdd8b1.ts.net  ^|  http://%TSIP%:8080

:run_app
echo [4/4] Chay app...
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if %errorlevel%==0 (
  echo       App da dang chay san tren cong 3000.
  goto done
)
if not exist node_modules (
  echo       Cai thu vien lan dau...
  call npm install
)
rem Chay an o nen (khong gan vao cua so nao): dong cmd khong tat app. Log: logs\app.log, logs\app-error.log
if not exist logs mkdir logs
powershell -NoProfile -Command "Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory '%CD%' -WindowStyle Hidden -RedirectStandardOutput '%CD%\logs\app.log' -RedirectStandardError '%CD%\logs\app-error.log'"
set /a apptries=0
:wait_app
timeout /t 2 /nobreak >nul
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if %errorlevel%==0 (
  echo       App da chay ngam. Dong cua so nay KHONG tat app.
  echo       Xem log: logs\app.log  ^|  Tat app: nhap dup stop-app.bat
  goto done
)
set /a apptries+=1
if %apptries% lss 15 goto wait_app
echo       App chua len sau 30 giay, xem loi trong logs\app-error.log

:done
start "" http://localhost:3000
echo.
echo Xong. App: http://localhost:3000  ^|  Database: http://localhost:8081
if defined TSIP echo Dien thoai (Tailscale): https://wolf.tailcdd8b1.ts.net  ^|  http://%TSIP%:8080
echo Cua so nay tu dong sau 10 giay.
timeout /t 10 >nul
exit
