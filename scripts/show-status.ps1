$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$values = @{}
Get-Content -LiteralPath (Join-Path $repoRoot 'config\qq-only.env') | ForEach-Object {
 if ($_ -match '^([^#=]+)=(.*)$') { $values[$Matches[1].Trim()] = $Matches[2].Trim() }
}
try {
 $result = Invoke-RestMethod -Uri 'http://127.0.0.1:3789/api/personal/status' -Headers @{ Authorization = 'Bearer ' + $values['CODEX_REMOTE_CONTACT_API_TOKEN'] } -TimeoutSec 30
 Write-Host $result.status
} catch { Write-Host '无法读取机器人状态，请先启动 01-start.cmd；若仍失败，检查 runtime 中的网关日志。' }
