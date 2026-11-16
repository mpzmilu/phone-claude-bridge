$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'PhoneClaudeBridge.lnk'

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$sc.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'start.ps1') + '"'
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7
$sc.Description = 'Phone Claude Bridge'
$sc.Save()

Write-Host "autostart installed:"
Write-Host "  $lnk"
