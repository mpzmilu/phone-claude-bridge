$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'PhoneClaudeBridge.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "autostart removed" }
else { Write-Host "autostart was not installed" }
