# 本地部署与可编辑结构

公开源码和自己的部署使用同一套代码。不要把账号、私人画像或运行数据写回公开模板；升级只同步源码，不覆盖实际配置与会话。

## 修改入口

| 想修改什么 | 编辑位置 | 何时生效 |
| --- | --- | --- |
| 网关网页与 Mac 客户端界面 | `modules/web-console/public/client.html`、`client.css`、`client.js` | 网页刷新；原生客户端重新构建 |
| 模型、模式、权限、通知订阅 | 网关面板 | 由后台保存；通常下一轮生效 |
| 私人身份、部署路径 | `config/qq-only.env` | 重启 Hub 与相关恢复服务 |
| 稳定人格与情境示例 | `config/private/persona/core.json`、`examples.json` | 重启 Hub，后续轮次重新注入 |
| 通用人格模板 | `persona/core.json`、`examples.json` | 仅对未配置私人覆盖目录的部署生效 |
| QQ 工具与行为权限 | `src/qq`、`src/security` | 测试通过后重启 Hub |
| WorkBuddy 桥与执行参数 | `src/workbuddy`、`modules/workbuddy-agent/bridge.py` | 测试通过后重启 Hub |
| 日历 / 提醒事项动作 | `src/automation`、`scripts/macos-notification-action.js` | 相应脚本与权限检查生效 |

浏览器与原生客户端不再各存一份前端源文件。客户端构建只从网页目录复制资源到产物，不能反向覆盖源码。

## 私人人格覆盖

先创建以下文件，将自己的内容填进去：

~~~bash
mkdir -p config/private/persona
cp persona/core.json config/private/persona/core.json
cp persona/examples.json config/private/persona/examples.json
~~~

再在 `config/qq-only.env` 加入：

~~~bash
CODEX_REMOTE_CONTACT_PERSONA_DIR=config/private/persona
~~~

路径相对于项目根目录，也可用绝对路径。`core.json` 必须是包含非空 `name` 的 JSON 对象，`examples.json` 必须包含 `examples` 数组。配置缺失或损坏时拒绝启动，不悄悄回退至通用人格。

实际 env 按 Node 的 dotenv 格式读取，不执行 shell 命令或展开变量；路径应填写实际值。外部注入的同名环境变量优先。后台恢复与 Hub 均通过 Node 读取配置，避免 launchd shell 直接读取 Documents 时被 macOS 隐私保护拦截；这不绕过系统权限，Node 运行时本身仍需获得相应目录的读取授权。

PRIVATE 目录及实际 env 被 Git 忽略，公开发布审计也会拒绝收录。不要 `git add -f`。人格中的学习统计、群关系和 OWNER 长期规则仍独立保存在 `runtime/qq-only-data`，更新模板不应清空这些数据。

## 目录边界

~~~text
项目根目录
├── src / modules / scripts / test    可发布、可编辑的程序
├── persona                          可发布的通用人格模板
├── config/*.example                 可发布的配置模板
├── config/qq-only.env                私人实际配置，不发布
├── config/private/persona           私人人格，不发布
├── runtime/qq-only-data              当前群、私聊、订阅与学习状态
├── runtime/group-workspaces          各群工作区
├── runtime/qq-media / qq-stickers    活动消息附件和表情库
├── modules/workbuddy-agent/.venv     本机 SDK 环境
└── modules/workbuddy-agent/.session-map.json  本机持久会话映射
~~~

在已有部署升级时，不重新复制 `settings.example.json` 覆盖真实 settings，不删除运行目录、SDK 环境、会话映射或 QQ 容器。`vendor`、`build` 和旧项目 Git 历史不是公开发布内容，但不代表可随意删除正在使用的文件。

清理旧会话必须先以群与私聊的真实 `threadId` 为保护名单，再核对 SDK 映射。不能按日期或“看起来像测试”删除其他 WorkBuddy / Codex 会话。发现未引用的网关会话时，停止对应写入进程后，将明确的文件移到项目外的私人备份目录；验证当前 thread 仍能续接后再恢复调度。

## 更新与验收

1. 先关闭面板总开关：仍接收 QQ 消息，不触发模型。等待当前任务完成。
2. 私人备份代码、配置、运行状态和 SDK 映射；同步公开源码，排除上述私人目录。
3. 运行 `npm test` 与 Python 桥离线测试。Hub 停止期间不要并行启动第二份实例。
4. 用现有登录后自启动配置重启，核对 QQ 登录、所有原 thread、pending 和人格；再恢复总开关。

公开发布从独立脱敏 checkout 进行，运行 `npm run audit:public`。旧本地仓库可能已在历史中追踪私人数据：新增 `.gitignore` 无法消除旧历史，不能直接推送它作为公开仓库。
