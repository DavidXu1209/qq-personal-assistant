$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $repoRoot "config\qq-only.env"
$credentialPath = Join-Path $repoRoot "config\private\icloud-credential.xml"
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "缺少 config\qq-only.env。请先复制 config\qq-only.env.example 并填写 QQ / OneBot 配置。"
}
$node = Get-Command node -ErrorAction Stop
function Read-DotEnvValue([string]$Path, [string]$Name) {
  $pattern = "^\s*" + [regex]::Escape($Name) + "\s*="
  $line = Select-String -LiteralPath $Path -Pattern $pattern | Select-Object -Last 1
  if (-not $line) { return "" }
  $value = ($line.Line -split "=", 2)[1].Trim()
  if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value.Trim()
}
$engine = (Read-DotEnvValue $configPath "CODEX_REMOTE_CONTACT_ENGINE").ToLower()
if (-not $engine) { $engine = "codex" }
if ($engine -eq "gemini") {
  $geminiKey = Read-DotEnvValue $configPath "GEMINI_API_KEY"
  if (-not $geminiKey) { $geminiKey = Read-DotEnvValue $configPath "CODEX_REMOTE_CONTACT_GEMINI_API_KEY" }
  if (-not $geminiKey) {
    throw "CODEX_REMOTE_CONTACT_ENGINE=gemini 需要 GEMINI_API_KEY。请在 https://aistudio.google.com/apikey 创建密钥，写入 config\qq-only.env，不要提交到 Git。"
  }
  $env:CODEX_REMOTE_CONTACT_ENGINE = "gemini"
} else {
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  $codexPath = if ($codex) { $codex.Source } else {
    Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin") -Filter codex.exe -Recurse |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $codexPath) { throw "Codex executable not found" }
  $env:CODEX_CLI_PATH = $codexPath
  $env:CODEX_REMOTE_CONTACT_ENGINE = "codex"
}
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
