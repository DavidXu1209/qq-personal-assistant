param(
  [string]$ProjectRoot = (Join-Path $env:USERPROFILE 'bots\qq-personal-assistant'),
  [ValidatePattern('^(gemini-[A-Za-z0-9.-]*flash[A-Za-z0-9.-]*)?$')][string]$FallbackModel = '',
  [switch]$RestartGateway
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectRoot).Path
$bundle = Split-Path $PSScriptRoot -Parent
$source = Join-Path $bundle 'src\groups\limited-chat.js'
$destination = Join-Path $project 'src\groups\limited-chat.js'
$server = Join-Path $project 'src\server.js'
$envFile = Join-Path $project 'config\qq-only.env'
if (-not (Test-Path -LiteralPath $source)) { throw 'Repair module is missing.' }
if ($FallbackModel -match 'image|tts|audio|live') { throw 'Only text Flash fallback is supported.' }
$serverText = [IO.File]::ReadAllText($server)
if (-not $serverText.Contains('createLimitedGroupChat') -or -not $serverText.Contains('handleOneBotEvent.limitedChat(payload)')) {
  throw 'This patch requires the existing limited group-chat route. No files changed; do not replace server.js with another computer version.'
}
$config = [IO.File]::ReadAllText($envFile)
$key = 'CODEX_REMOTE_CONTACT_GROUP_FLASH_FALLBACKS'
$matches = [regex]::Matches($config, "(?m)^$key=.*$")
if ($matches.Count -gt 1) { throw 'Duplicate fallback settings; no files changed.' }
$backup = Join-Path $project ('backups\group-chat-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item -LiteralPath $destination -Destination (Join-Path $backup 'limited-chat.js')
Copy-Item -LiteralPath $envFile -Destination (Join-Path $backup 'qq-only.env')
try {
  if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($destination)) { Copy-Item -LiteralPath $source -Destination $destination -Force }
  & node --check $destination
  if ($LASTEXITCODE -ne 0) { throw 'Module syntax check failed.' }
  # No fallback is selected unless explicitly requested by the operator.
  if ($FallbackModel) {
    $line = "$key=$FallbackModel"
    if ($matches.Count -eq 1) { $config = [regex]::Replace($config, "(?m)^$key=.*$", $line) }
    else { $config += "`r`n$line`r`n" }
    [IO.File]::WriteAllText($envFile, $config, (New-Object Text.UTF8Encoding($false)))
  }
} catch {
  Copy-Item -LiteralPath (Join-Path $backup 'limited-chat.js') -Destination $destination -Force
  Copy-Item -LiteralPath (Join-Path $backup 'qq-only.env') -Destination $envFile -Force
  throw
}
Write-Host "Installed. Backup: $backup"
if ($RestartGateway) {
  $launcher = Join-Path $project 'scripts\start-local.ps1'
  if (-not (Test-Path -LiteralPath $launcher)) { throw 'Gateway launcher missing. Patch installed; gateway not restarted.' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -RestartGateway
  if ($LASTEXITCODE -ne 0) { throw 'Gateway restart failed. Files remain installed; inspect runtime logs.' }
} else { Write-Host 'Gateway was not restarted. Restart this project when convenient.' }
