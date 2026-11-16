param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('on', 'off')]
  [string]$Mode
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfgPath = Join-Path $root 'config.json'
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json

$cfg.dingtalk.enabled = ($Mode -eq 'on')

# 必须写成无 BOM 的 UTF-8，否则 Node 的 JSON.parse 会报错
$json = $cfg | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("DingTalk listener: {0}" -f $Mode.ToUpper())

& (Join-Path $root 'stop.ps1')
Start-Sleep -Milliseconds 500
& (Join-Path $root 'start.ps1')
