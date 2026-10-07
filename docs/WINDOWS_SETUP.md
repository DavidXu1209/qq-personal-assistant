# Windows 本机部署

这是 Windows / Codex 个人助理部署路径。电脑需要开机、联网，且网关与 OneBot QQ 桥接都在运行，机器人才能实时回复。需要用户参与的步骤见 [USER_ACTIONS.md](USER_ACTIONS.md)。本机已配置时，使用根目录的 CMD 入口；`04-status.cmd` 可查询服务状态。

## 前置条件

- Windows 10/11、Node.js 20.6 或更新版本、已登录 ChatGPT 订阅的 Codex CLI。
- 一个单独的机器人 QQ 号，以及已安装并登录的 OneBot 桥接程序。此仓库不包含 QQ 登录桥；`ONEBOT_API_BASE` 默认指向本机 `127.0.0.1:3000`。
- 若要写 iCloud 日历，需要 Apple ID 已启用双重认证，并创建专用密码。没有 Apple 凭据时，摘要和 QQ 提醒可使用，日历写入会明确报告失败。

## 配置

1. 将 `config/windows-personal.env.example` 复制为 `config/qq-only.env`。填入自己的 OWNER 与机器人 QQ 号、两个独立随机令牌（`ONEBOT_ACCESS_TOKEN`、`CODEX_REMOTE_CONTACT_API_TOKEN`）和 OneBot API 地址。管理面板绑定 `127.0.0.1` 并验证令牌；不要将管理面板或 OneBot API 暴露到公网。
2. 登录 Codex CLI。启动脚本先查 PATH，再查当前 Windows 用户的 Codex 应用目录，并选择 Codex 引擎。
3. 运行 `powershell -ExecutionPolicy Bypass -File scripts/setup-windows-icloud.ps1`。按终端提示输入 Apple 账户和 App 专用密码，密码隐藏输入。Windows 用当前用户的 DPAPI 加密保存凭据，脚本不会将密码写入普通环境配置文件。
4. 确认 QQ 桥接已登录机器人 QQ，并开放本机 OneBot HTTP API；将事件上报地址设为 `http://127.0.0.1:3789/api/onebot/event`，API 令牌与 `ONEBOT_ACCESS_TOKEN` 一致；事件上报令牌使用 `CODEX_REMOTE_CONTACT_API_TOKEN`。
5. 运行 `powershell -ExecutionPolicy Bypass -File scripts/start-windows.ps1`。

网关会把 OWNER 私聊中的文字、转发消息和公开链接交给 Codex 摘要；明确事项先排入本地 QQ 提醒队列，再尝试写入 iCloud「QQ提醒」日历，分别报告实际结果。日期没有时刻时使用当天 09:00；有开始时间时 QQ 提前 10 分钟提醒。

## 离线行为

- 电脑关机、睡眠或网关未运行时不能实时收消息或发送 QQ 提醒。
- 已写入本地队列的到期提醒会在网关下次启动时补发。网关只能补处理已收到并保存的 QQ 消息；QQ 桥接是否补交离线期间的私聊消息取决于桥接和 QQ，不能保证。
- CalDAV 支持国际区和国区 iCloud 地址。每位使用者仍需用自己的账户添加一条测试事项，并在手机日历中确认同步。

## 启动入口与 QQ 桥接

`scripts/start-windows.ps1` 可配合任意已经配置好的 OneBot HTTP 桥接使用。便捷入口 `01-start.cmd` 和 `02-qq-login.cmd` 当前按 NapCat 4.18.33 / QQ 9.9.33-52230 的便携目录布局编写，安装文件不随仓库发布。若使用不同版本，请调整两个脚本内的相对路径；便携目录内的 `start-bot.cmd` 应填写使用者自己的机器人 QQ 号。

## 凭据管理

- `config/qq-only.env` 与 `config/private/` 已被 Git 忽略；不要提交或分享。
- Apple 专用密码只用于日历连接，可在 Apple 账户中撤销。停止使用后删除本机 XML 凭据并撤销该专用密码。
- QQ 桥接登录状态与令牌只保存在本机；不要把二维码、Cookie、令牌或专用密码发到聊天里。
