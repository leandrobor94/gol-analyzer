@echo off
cd /d "%~dp0"
if not exist alertas.json goto :off
findstr "true" alertas.json >nul && goto :off || goto :on

:off
echo {"enabled":false}> alertas.json
echo  ALERTAS APAGADAS
git add alertas.json >nul 2>nul
git commit -m "alertas off" >nul 2>nul
git push >nul 2>nul
goto :end

:on
echo {"enabled":true}> alertas.json
echo  ALERTAS ENCENDIDAS
git add alertas.json >nul 2>nul
git commit -m "alertas on" >nul 2>nul
git push >nul 2>nul
goto :end

:end
pause