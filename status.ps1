$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$pidFile = Join-Path $root 'server.pid'

$procId = 0
if (Test-Path $pidFile) {
  [int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$procId) | Out-Null
}
$running = ($procId -gt 0 -and (Get-Process -Id $procId -ErrorAction SilentlyContinue))

if ($running) {
  $busy = $false
  if ($cfg.webEnabled -eq $true) {
    try {
      $r = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/ping" -f $cfg.port) -TimeoutSec 3
      $busy = $r.busy
    } catch {}
  }
  Write-Host ("RUNNING  pid={0}  busy={1}" -f $procId, $busy) -ForegroundColor Green
} else {
  Write-Host "NOT RUNNING" -ForegroundColor DarkGray
}

Write-Host ("DingTalk channel: {0}" -f $(if ($cfg.dingtalk.enabled) { "ON" } else { "OFF" }))
if ($cfg.webEnabled -eq $true) {
  Write-Host "Web channel: ON"
} else {
  Write-Host "Web channel: OFF (DingTalk only)"
}

$log = Join-Path $root 'bridge.log'
if (Test-Path $log) {
  Write-Host ""
  Write-Host "last log lines:"
  Get-Content $log -Tail 6 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

if ($running -and $cfg.webEnabled -eq $true) {
  Write-Host ""
  Write-Host "Open on phone (same Wi-Fi / LAN), try 10./192.168. first:"
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
  if (-not $ips) { Write-Host "  (no LAN address found)" -ForegroundColor DarkYellow }
  foreach ($ip in $ips) {
    Write-Host ("  http://{0}:{1}/?t={2}" -f $ip, $cfg.port, $cfg.token) -ForegroundColor Cyan
  }
}
