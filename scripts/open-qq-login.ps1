$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$webConfigPath = Join-Path $repoRoot 'runtime\napcat-installer\NapCat.52230.Shell\versions\9.9.33-52230\resources\app\napcat\config\webui.json'
$webConfig = Get-Content -LiteralPath $webConfigPath -Raw | ConvertFrom-Json
if (-not $webConfig.token -or -not $webConfig.port) { throw 'NapCat login configuration is not ready' }
Start-Process ('http://127.0.0.1:' + $webConfig.port + '/webui?token=' + [Uri]::EscapeDataString($webConfig.token))
