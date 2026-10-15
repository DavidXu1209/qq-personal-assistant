# Limited group chat: recover from Gemini API failures

This patch targets deployments that already route selected groups through
`createLimitedGroupChat` in `src/server.js`. It does not install or replace the
Gemini engine. Local Codex/WorkBuddy deployments must not be copied over a remote
Gemini deployment. The installer refuses an incompatible server before changing files.

## What changes

- Retry transient generation failures once; then try at most two explicitly configured
  text Flash backups. Missing models (404) skip their duplicate attempt. Authentication
  failures (401/403) and bad requests (400) stop without cycling through models.
- Each API attempt has a 30-second timeout. No unlimited retry loop.
- Keep failed generation input in bounded memory until another new message arrives.
  Restarting clears this in-memory context. Ambiguous QQ sends are never resent automatically.
- Log only fixed error codes, attempt counts and delivery status, not keys, provider
  error bodies or group text. Silent/safety decisions are not failures.
- The model receives only the current group's text and no computer, calendar,
  reminder, file, private-chat or administrative tools. Message batching and a
  minimum 20-second attempt interval reduce repeated calls during busy conversations.

## Deploy once on the target Windows computer

Extract the patch ZIP into Downloads (outside the running project). In PowerShell:

```powershell
$patch = Join-Path $env:USERPROFILE 'Downloads\group-chat-fix-20261015'
& "$patch\scripts\install-group-chat-fix.ps1" -RestartGateway
```

If PowerShell blocks script execution, use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$patch\scripts\install-group-chat-fix.ps1" -RestartGateway
```

This replaces only `src/groups/limited-chat.js`, backs up that file and the target's
`config/qq-only.env`, and restarts only the project through its existing launcher.
The original account settings, keys, NapCat, QQ installation and server code are
preserved. Supply `-ProjectRoot` if the project is elsewhere.

## Optional fallback

Default: no new backup model selected and no billing changes. Once a text Flash
model has been confirmed available to your API project, explicitly opt in with:

```powershell
& "$patch\scripts\install-group-chat-fix.ps1" -FallbackModel 'gemini-3.1-flash-lite' -RestartGateway
```

The name above is an example, not a promise that the account can generate with it.
A models-list response alone is insufficient; test actual generation. Model names
do not prove free-tier eligibility. This patch does not activate billing or create
keys. On an already paid project, existing API billing rules still apply.

## Verify after deployment

Send one fresh question in a configured group. Allow time for generation and bounded
retries. Run `scripts/status.ps1` if available and inspect the newest
`runtime/gateway-*.stderr.log` and `*.stdout.log` locally. Look for
`Limited group chat attempt`, `Limited group chat failed`, or
`Limited group chat reply delivered`. Do not publish raw logs or account files.

Offline tests use a fake provider; they do not prove production model availability
or delivery to a real QQ group. Do not overwrite the entire remote project using a
local Git checkout just to install this small patch.
