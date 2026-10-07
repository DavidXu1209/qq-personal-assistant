# QQ 个人 AI 助理

通过 QQ 整理通知、提取事项、发送提醒，并同步到 iPhone 的 iCloud 日历。面向 Windows 10/11，使用本机已登录的 Codex 和独立 QQ 机器人小号。

## 下载

- [下载源码 ZIP](https://github.com/DavidXu1209/qq-personal-assistant/archive/refs/heads/main.zip)
- [项目主页](https://github.com/DavidXu1209/qq-personal-assistant)
- [Windows 配置与启动说明](docs/WINDOWS_SETUP.md)
- [扫码登录、日历授权和使用步骤](docs/USER_ACTIONS.md)

这是源码下载，不是一键安装包。需要自行准备 Node.js、Codex 和兼容 OneBot 的 QQ 桥接程序（如 NapCat）。当前仓库为私有，下载者需要访问权限；仓库公开后这些链接可直接使用。

也可以下载到本机：

```powershell
git clone https://github.com/DavidXu1209/qq-personal-assistant.git
cd qq-personal-assistant
Copy-Item config/windows-personal.env.example config/qq-only.env
```

填写自己的 QQ 号和独立随机令牌，配置 QQ 桥接后，按部署说明启动。

## 功能

- **通知摘要**：私聊发送或转发通知，整理重点、时间、地点和准备事项，支持合并转发。
- **自动创建事项**：日期和时间明确时创建提醒；信息不明确时先追问，支持多轮补充。
- **QQ 私聊提醒**：有开始时刻的事项默认提前 10 分钟提醒；只有日期则当天 09:00 提醒，使用北京时间。
- **iCloud 日历同步**：写入独立的“QQ提醒”日历，支持国际区和国区账户，使用 Apple App 专用密码。
- **查看、修改和取消**：通过编号管理事项，修改和取消同时尝试更新 iCloud，分别报告实际结果。
- **重复通知去重**：相同标题、时间和地点保留原事项，重复转发不会把已修改时间覆盖回去。
- **重启恢复与补发**：已保存事项持久化，服务恢复后补发到期提醒。
- **运行状态查询**：查询 QQ 连接、待发提醒及日历失败情况；管理命令不调用模型。
- **转发内容隔离**：转发材料和网页内容不作为用户操作指令，个人助理模式限制模型的本机执行权限。

## 使用示例

发送：

```text
10月9日下午2点在图书馆二楼讨论项目，预计30分钟，请提醒我带电脑。
```

机器人会摘要通知、保存事项，并报告 QQ 提醒和日历同步结果。

管理命令：

```text
查看提醒
查看提醒 全部
修改提醒 编号 2026-10-09 15:00
取消提醒 编号
状态
```

## 已验证与限制

Windows 实际部署中已验证 QQ 定时送达、iPhone 日历同步、去重、修改、取消、多轮补充、日期默认时间、合并转发、转发指令隔离、重启保留与过期补发。新使用者仍需用自己的账户验证收发和同步。

- 实时服务需要电脑开机、联网、不睡眠。手机日历已同步的事件不依赖电脑持续运行。
- 只整理机器人实际收到的消息，不自动读取用户主号全部聊天。未送达网关的离线消息不能保证恢复。
- 去重按标题、时间和地点判断，不保证识别所有改写；发送瞬间崩溃等极端情况可能重复补发。
- 个人助理每轮最多提取 8 个事项；合并转发展开最多 40 条，链接读取最多 3 个。大量材料需分批发送。
- X 链接读取未完成真实验收，登录墙内容应提供正文；不提供主动监测 X 或周期性提醒。
- 本版本不把图片识别列为已完成能力。模型用量取决于使用者自己的订阅，不能保证无限或免费调用。
- QQ 登录和接口可用性取决于所用桥接程序。便捷启动脚本目前对应固定的 NapCat 便携目录，其他版本按部署说明调整。

## 隐私

公开配置示例不包含个人 QQ 号、账户或密码。实际配置、Apple 加密凭据、聊天记录、登录状态、日志和运行数据不随源码发布。分享项目请分享仓库或源码 ZIP，不要打包整个本机运行目录。

## 来源与许可

此版本在 [DrivingGodJ/workbuddy-qq-agent-gateway](https://github.com/DrivingGodJ/workbuddy-qq-agent-gateway) 基础上增加 Windows / Codex 个人助理与 iCloud CalDAV 功能；更早代码来源包括 [Epic0522/Codex-Remote-Contact](https://github.com/Epic0522/Codex-Remote-Contact)。保留原作者署名及来源说明。

来源文档记录的是原项目快照，非当前版本的文件盘点。详见 [来源清单](docs/PROVENANCE.md) 和 [许可说明](LICENSE-NOTICE.md)。仓库可访问不代表获得无限制再分发许可，当前不为整仓新增 MIT 或 Apache 授权。
