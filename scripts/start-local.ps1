param([switch]$RestartGateway)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$napcatRoot = Join-Path $repoRoot 'runtime\napcat-installer\NapCat.52230.Shell'
$bridgeRunning = Get-Process NapCatWinBootMain -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $napcatRoot 'NapCatWinBootMain.exe') }
if (-not $bridgeRunning) {
 Start-Process cmd.exe -ArgumentList ('/c ""' + (Join-Path $napcatRoot 'start-bot.cmd') + '""') -WorkingDirectory $napcatRoot -WindowStyle Hidden
}
$gatewayRunning = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like ('*' + (Join-Path $repoRoot 'config\qq-only.env') + '*') -and $_.CommandLine -like '*src/server.js*' }
if ($RestartGateway -and $gatewayRunning) {
 $gatewayRunning | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
 $gatewayRunning = $null
}
if (-not $gatewayRunning) {
 Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $repoRoot 'scripts\start-windows.ps1') + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $repoRoot 'runtime\gateway.stdout.log') -RedirectStandardError (Join-Path $repoRoot 'runtime\gateway.stderr.log')
}
