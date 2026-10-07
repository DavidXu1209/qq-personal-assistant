$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot "config\qq-only.env"
$credentialPath = Join-Path $repoRoot "config\private\icloud-credential.xml"
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "缺少 config\qq-only.env。请先复制 config\qq-only.env.example 并填写 QQ / OneBot 配置。"
}
$node = Get-Command node -ErrorAction Stop
$codex = Get-Command codex -ErrorAction SilentlyContinue
$codexPath = if ($codex) { $codex.Source } else {
  Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin") -Filter codex.exe -Recurse |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $codexPath) { throw "Codex executable not found" }
$env:CODEX_CLI_PATH = $codexPath
$env:CODEX_REMOTE_CONTACT_ENGINE = "codex"
$env:CODEX_REMOTE_CONTACT_HOST = "127.0.0.1"
$env:CODEX_REMOTE_CONTACT_DISABLE_AUTH = "0"
if (Test-Path -LiteralPath $credentialPath) {
  $credential = Import-Clixml -LiteralPath $credentialPath
  $env:ICLOUD_USERNAME = $credential.UserName
  $env:ICLOUD_APP_PASSWORD = $credential.GetNetworkCredential().Password
}
Set-Location -LiteralPath $repoRoot
& $node.Source --env-file="$configPath" src/server.js
exit $LASTEXITCODE
