# Codex CLI Module / Codex CLI 模块

Codex app-server integration is implemented in `src/codex/client.js`.

Codex app-server 集成逻辑位于 `src/codex/client.js`。

Default CLI path / 默认 CLI 路径：

```text
/Applications/Codex.app/Contents/Resources/codex
```

Override with / 可通过环境变量覆盖：

```bash
CODEX_CLI_PATH=/path/to/codex
```

Persistent QQ group threads run from / QQ 群持久会话工作目录：

```text
workspaces/codex-cli/
```

Each QQ group maps to one persistent Codex thread. Thread IDs and pending
messages are stored in `runtime/qq-only-data/group-sessions.json`.

每个 QQ 群绑定一条持久 Codex thread；threadId 与 pending 消息保存在
`runtime/qq-only-data/group-sessions.json`。
