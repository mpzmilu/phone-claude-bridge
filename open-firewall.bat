@echo off
net session >nul 2>&1
if errorlevel 1 (
  echo [!] Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="PhoneClaudeBridge" >nul 2>&1
netsh advfirewall firewall add rule name="PhoneClaudeBridge" dir=in action=allow protocol=TCP localport=8787 profiles=private,domain
echo [OK] inbound TCP 8787 allowed on private/domain networks
pause
