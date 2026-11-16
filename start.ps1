$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root 'server.pid'

if (Test-Path $pidFile) {
  $existing = 0
  [int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$existing) | Out-Null
  if ($existing -gt 0 -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
    Write-Host "already running (pid $existing)"
    exit 0
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $root 'server.mjs'
Start-Process -FilePath $node -ArgumentList ('"{0}"' -f $entry) -WorkingDirectory $root -WindowStyle Hidden
Start-Sleep -Milliseconds 1500

if (Test-Path $pidFile) {
  Write-Host ("started (pid {0})" -f (Get-Content $pidFile -Raw).Trim())
  Write-Host "run status.bat to check channel status"
} else {
  Write-Host "start issued, but no pid file yet. check bridge.log"
}
