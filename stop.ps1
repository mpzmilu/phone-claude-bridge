$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'server.pid'
$stopped = $false

if (Test-Path $pidFile) {
  $target = 0
  [int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$target) | Out-Null
  if ($target -gt 0) {
    $p = Get-Process -Id $target -ErrorAction SilentlyContinue
    if ($p) { Stop-Process -Id $target -Force; Write-Host "stopped (pid $target)"; $stopped = $true }
    else { Write-Host "process $target was not running" }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

if (-not $stopped) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*PhoneClaudeBridge*server.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ("stopped (pid {0})" -f $_.ProcessId); $stopped = $true }
}

if (-not $stopped) { Write-Host "not running" }
