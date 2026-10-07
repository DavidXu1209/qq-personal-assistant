$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$credentialPath = Join-Path $repoRoot "config\private\icloud-credential.xml"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $credentialPath) | Out-Null
$appleAccount = (Read-Host "请输入 Apple 账户（输入后按回车）").Trim()
if (-not $appleAccount) { throw "Apple account is required" }
$appleSecret = Read-Host "请输入新的 App 专用密码（隐藏输入，完成后按回车）" -AsSecureString
if ($appleSecret.Length -eq 0) { throw "App-specific password is required" }
$credential = [System.Management.Automation.PSCredential]::new($appleAccount, $appleSecret)
if (-not $credential -or -not $credential.UserName -or -not $credential.GetNetworkCredential().Password) { throw "Apple account and app-specific password are required" }
$credential | Export-Clixml -LiteralPath $credentialPath
Write-Host "已保存加密凭据：$credentialPath"
& (Join-Path $PSScriptRoot "start-local.ps1") -RestartGateway
