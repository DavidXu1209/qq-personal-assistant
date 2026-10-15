# Windows 服务器部署（Gemini，中文）

这份说明给第一次在 Windows 上部署的人。目标机器是一台用 **UU 远程** 操作的 Windows 10/11 电脑：工作日白天开着，晚上关机。模型用本分支的 **Gemini**，不占用 Codex 额度。

所有安装、扫码和打开网页，都在那台 Windows 的桌面里做。家里的电脑只负责通过 UU 连上去。管理面板只监听本机 `127.0.0.1`，不要从家里的浏览器直接访问服务器的公网地址。

晚上关机后，机器人不会收消息，也不会发提醒。第二天开机并登录同一个 Windows 用户后，已保存的到期提醒会补发。QQ 在关机期间的离线消息能不能补交，取决于 QQ 和桥接，不能保证。锁屏可以，睡眠和关机不行。

## 你需要准备

- Windows 10 或 11，能上网。
- 一个主号（你自己），一个机器人小号（只给机器人用）。两个号码不能相同。
- Google 账号，用来在 [Google AI Studio](https://aistudio.google.com/apikey) 创建 API 密钥。
- 安装 [Git for Windows](https://git-scm.com/download/win)。
- 安装 [Node.js 22 LTS](https://nodejs.org/)。本仓库要求 **Node.js 20.6 或更高**；GitHub 检查用的是 22。安装时勾选加入 PATH。装好后新开一个 PowerShell，执行 `node -v`，应看到 `v20.6` 或更高，`npm -v` 也能打出版本。
- **运行 Gemini 不需要 Python，也不需要 Codex。** Python 只在你想额外跑 WorkBuddy 桥的离线测试时才要：CI 使用 **Python 3.13**，依赖文件是 `modules/workbuddy-agent/requirements.txt`（`codebuddy-agent-sdk==0.3.261`）。日常回复 QQ 可以不装。

本仓库的网关没有第三方 npm 包。`package.json` 里没有 `dependencies`。克隆之后可以直接启动，不必先 `npm install`。

## 1. 克隆本分支

Gemini 引擎在分支 `cursor/gemini-model-backend-6dc0`（Pull Request #2）。合并进 `main` 之前，请检出这个分支。

在 PowerShell 里选一个你有写权限的目录，例如 `C:\apps`：

```powershell
cd C:\apps
git clone -b cursor/gemini-model-backend-6dc0 https://github.com/DavidXu1209/qq-personal-assistant.git
cd qq-personal-assistant
```

后面把 `C:\apps\qq-personal-assistant` 换成你的实际路径。

## 2. 填写配置

```powershell
Copy-Item config\windows-personal.env.example config\qq-only.env
New-Item -ItemType Directory -Force -Path config\private
notepad config\qq-only.env
```

`config\qq-only.env` 和 `config\private\` 已被 Git 忽略。不要把它们提交，也不要截图发到聊天里。

用记事本改这些项（行首的 `#` 表示注释，要生效就删掉 `#`）：

```text
CODEX_REMOTE_CONTACT_HOST=127.0.0.1
CODEX_REMOTE_CONTACT_PORT=3789
CODEX_REMOTE_CONTACT_DISABLE_AUTH=0
CODEX_REMOTE_CONTACT_OWNER_QQ_ID=你的主号
CODEX_REMOTE_CONTACT_BOT_QQ_ID=机器人小号
CODEX_REMOTE_CONTACT_ENGINE=gemini
GEMINI_API_KEY=在 AI Studio 创建的密钥
GEMINI_PERSONA_FILE=config/private/gemini-persona.txt
GEMINI_PERSONA_MODE=append
CODEX_REMOTE_CONTACT_PERSONAL_MODE=1
CODEX_REMOTE_CONTACT_API_TOKEN=一长串随机字符
ONEBOT_ACCESS_TOKEN=另一长串随机字符
ONEBOT_API_BASE=http://127.0.0.1:3000
```

说明：

- `CODEX_REMOTE_CONTACT_HOST` 保持 `127.0.0.1`。`scripts\start-windows.ps1` 启动时也会把监听地址固定成 `127.0.0.1`，并强制开启登录验证（`CODEX_REMOTE_CONTACT_DISABLE_AUTH=0`）。不要改成 `0.0.0.0`。
- 两个令牌必须不同，而且要足够长。可以在 PowerShell 里生成两次，分别粘贴：

  ```powershell
  [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
  ```

- `ONEBOT_ACCESS_TOKEN` 要和 QQ 桥的 HTTP API 令牌一致。事件上报令牌用 `CODEX_REMOTE_CONTACT_API_TOKEN`。
- `GEMINI_API_KEY` 的别名是 `CODEX_REMOTE_CONTACT_GEMINI_API_KEY`。密钥只放在这个文件里。
- 示例里的引擎默认是 `codex`。用 Gemini 时必须写成 `CODEX_REMOTE_CONTACT_ENGINE=gemini`，并取消 `GEMINI_API_KEY` 那一行的注释。Windows 启动脚本看到 `gemini` 后不再要求本机安装 Codex。

### 人格文件

不设置 Gemini 专用人格时，Gemini 使用和其他引擎相同的系统提示词（人格、口头禅、已发布的说话习惯，以及 QQ 网关规则）。

如果要加一段只有 Gemini 使用的补充，把文字写进 `config\private\gemini-persona.txt`。记事本另存为时选 **UTF-8**。文件必须存在，而且不能是空的，否则网关拒绝启动。

```powershell
notepad config\private\gemini-persona.txt
```

- `GEMINI_PERSONA_MODE=append`（默认）：共用提示词在前，文件内容接在后面。
- `GEMINI_PERSONA_MODE=replace`：只发送这个文件，共用人格和网关规则都不会放进系统提示词。日常使用保持 `append`。
- 也可以用 `GEMINI_PERSONA` 把短文字直接写进环境变量。文件和环境变量都填时，文件接在环境变量文字后面。
- 改人格文件或这几项环境变量后要重启网关。面板不能编辑这个文件。

### 模型名

本分支默认模型是 **`gemini-3.8-flash`**。Google 文档里的模型代码就是这个字符串，页面标明为稳定版，最近更新日期为 2026 年 9 月：[Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)。不写 `GEMINI_MODEL` 时就用它。

模型可以改，不必改代码。在 [Google AI Studio](https://aistudio.google.com/) 的模型下拉里看到的 id，或在 [模型列表](https://ai.google.dev/gemini-api/docs/models) 里复制，写到配置里：

```text
GEMINI_MODEL=gemini-3.8-flash
```

只要 id，不要带 `models/` 前缀（写了也会被去掉）。别名是 `CODEX_REMOTE_CONTACT_GEMINI_MODEL`。改完重启。

启动成功后，日志里会有一行 `agent engine: gemini (model=你写的模型名)`。面板里的模型下拉，是网关用你的密钥向 Google 拉到的、支持 `generateContent` 的模型。进程启动时如果设置了 `GEMINI_MODEL`，以环境变量为准。留空时，才会使用面板里已经保存的、以 `gemini-` 开头的模型名；保存的 `gpt-*` 名称会被忽略，仍回落到 `gemini-3.8-flash`。

## 3. 先跑测试

在项目目录：

```powershell
npm test
```

这是离线测试，不会使用你的 API 密钥。结束时应为通过（可能有个别跳过）。失败时先确认 `node -v` 至少是 20.6，并且当前目录是仓库根目录。

## 4. QQ 小号桥接和登录

仓库里没有 QQ 登录程序。机器人通过本机的 OneBot HTTP 桥收发消息，默认地址是 `http://127.0.0.1:3000`。

一键脚本按这个便携目录编写（安装包不在仓库里）：

```text
runtime\napcat-installer\NapCat.52230.Shell\
```

对应 NapCat 4.18.33 / QQ 9.9.33-52230。这个目录里要有 `NapCatWinBootMain.exe` 和 `start-bot.cmd`。`start-bot.cmd` 里填你自己的机器人小号。`02-qq-login.cmd` 会读取：

```text
runtime\napcat-installer\NapCat.52230.Shell\versions\9.9.33-52230\resources\app\napcat\config\webui.json
```

版本或目录不同时，改 `scripts\start-local.ps1` 和 `scripts\open-qq-login.ps1` 里的路径。也可以不用一键脚本：自己先把任意 OneBot HTTP 桥开在 `127.0.0.1:3000`，再只运行下面的网关脚本。

桥接里要设置：

- HTTP API 地址：`http://127.0.0.1:3000`，令牌等于 `ONEBOT_ACCESS_TOKEN`。
- 事件上报地址：`http://127.0.0.1:3789/api/onebot/event`，令牌等于 `CODEX_REMOTE_CONTACT_API_TOKEN`。
- 不要把 3000 或 3789 端口映射到公网。

登录：

1. 双击项目根目录的 `01-start.cmd`。它会在后台尝试启动上述 NapCat 目录，并启动网关。第一次如果目录还没放好，网关仍可能单独起来，QQ 会显示未连接。
2. 双击 `02-qq-login.cmd`。它用本机浏览器打开 NapCat 的登录页。
3. 手机 QQ 切到 **机器人小号**，扫描网页上的二维码并确认。不要扫成主号。
4. 二维码、Cookie、登录令牌只留在这台电脑上。

## 5. 确认网关和面板

第一次建议先看得到报错。NapCat 已登录后，在项目目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-windows.ps1
```

这个窗口不要关。成功时会打印类似：

```text
agent engine: gemini (model=gemini-3.8-flash)
codexremotecontact QQ Agent gateway: http://127.0.0.1:3789
```

缺 `GEMINI_API_KEY`、人格文件为空或路径错了，窗口里会直接抛错并退出。

用一键启动时，网关输出写到：

- `runtime\gateway.stdout.log`
- `runtime\gateway.stderr.log`

查看最后几行：

```powershell
Get-Content runtime\gateway.stdout.log -Tail 40
Get-Content runtime\gateway.stderr.log -Tail 40
```

这些日志可能含有聊天内容。不要上传，也不要提交。`runtime\` 已被 Git 忽略。

在 **这台 Windows 的浏览器** 打开：

```text
http://127.0.0.1:3789/
```

面板的接口需要令牌。页面本身读的是浏览器本地存储 `crc-hub-token`。按 F12，打开控制台，粘贴下面这一行（换成你的 `CODEX_REMOTE_CONTACT_API_TOKEN`），回车后再刷新页面：

```javascript
localStorage.setItem("crc-hub-token", "这里换成配置里的 API 令牌")
```

连接正常时，角标会变成「已连接」。令牌不要出现在书签或截图里。

也可以不打开面板，在项目目录双击 `04-status.cmd`。它用配置里的令牌请求 `http://127.0.0.1:3789/api/personal/status`。打不开时，先看上面的两份日志。

最后用主号给小号发一句，例如：`请总结：本周要完成 Java 集合练习。` 收到摘要，才说明 QQ 和 Gemini 都通了。只看到测试通过或面板能开，还不算接通。

iCloud 日历是可选的。要同步到 iPhone，再双击 `03-icloud-setup.cmd`，按提示输入 Apple 账号和 App 专用密码。不配置时，摘要和本机 QQ 提醒仍然可用，日历写入会在回复里说明失败。

## 6. 开机自动启动（任务计划程序）

QQ 窗口需要登录后的桌面。计划任务要选 **只在用户登录时运行**，用你平时通过 UU 登录的那个 Windows 用户。不要选「不管用户是否登录都要运行」，也不要改成 SYSTEM。

`01-start.cmd` 会调用 `scripts\start-local.ps1`：NapCat 或网关已经在跑时，不会再开第二份。任务本身很快结束，真正的程序在后台。

1. 按 `Win + R`，输入 `taskschd.msc`，回车。
2. 右侧点 **创建任务**（不要用「创建基本任务」）。
3. **常规**
   - 名称：`QQ个人助理`
   - 选「只在用户登录时运行」
   - 不要勾选「使用最高权限运行」
4. **触发器** → **新建**
   - 开始任务：**登录时**
   - 特定用户：当前这个 Windows 用户
   - 勾选「延迟任务时间」，填 **30 秒**，给开机后的网络留时间
   - 确定
5. 如果希望工作日白天断线后还能拉起来，再 **新建** 一个触发器：
   - 开始任务：**按计划**
   - 每天，开始时间填你白天开机的时间，例如 `08:30:00`
   - 勾选「重复任务间隔」：**30 分钟**，持续时间 **12 小时**
   - 勾选周一到周五。周末不开机就不会跑；这只是白天的补启动
6. **操作** → **新建**
   - 操作：启动程序
   - 程序或脚本：`C:\apps\qq-personal-assistant\01-start.cmd`（换成你的路径）
   - 起始于：`C:\apps\qq-personal-assistant`
7. **条件**
   - 取消「只有在计算机使用交流电源时才启动以下任务」
   - 取消「如果计算机改用电池电源，则停止」
   - 不要勾选「只有在以下网络连接可用时才启动」，避免 UU 连上之前任务被跳过
8. **设置**
   - 「如果任务已在运行，则以下规则适用」选 **请勿启动新实例**
   - 可以勾选失败后每隔 1 分钟重试，最多 3 次

晚上直接关机即可，不必再做一条「停止」任务。第二天开机，用 UU 连上并登录同一用户后，任务会启动。登录后等一两分钟，双击 `04-status.cmd` 或看 `runtime\gateway.stdout.log` 里是否出现 `agent engine: gemini`。

计划任务里不要写 API 密钥。密钥只留在 `config\qq-only.env`。

## 7. 以后更新

在项目目录：

```powershell
git status
git pull origin cursor/gemini-model-backend-6dc0
npm test
```

`git status` 里不应出现 `config\qq-only.env`、`config\private\` 或 `runtime\`。如果出现，不要 `git add` 它们。

更新前先关掉旧网关，避免两份同时占用 3789 端口。可以在任务管理器里结束命令行包含 `src/server.js` 的 `node.exe`，NapCat 若要一起更新登录状态再结束 `NapCatWinBootMain.exe`。然后重新双击 `01-start.cmd`，或等下一次登录触发。

换过引擎之后，已有会话发「/新会话」。Gemini 的会话文件在 `runtime\gemini-threads`，和 Codex、WorkBuddy 的会话不通用。

合并进 `main` 之后，再改成跟踪 `main`。在那之前一直停在本分支。

## 安全

- 管理面板和 OneBot 都只放在本机。保持 `127.0.0.1`。不要做端口转发，不要在路由器或云服务器安全组里开放 3789、3000。
- 通过 UU 看这台电脑的桌面，再在桌面里打开 `http://127.0.0.1:3789/`。
- 不要提交密钥、令牌、二维码、Cookie、Apple 专用密码、人格私人文件和日志。公开前先看 `git status`。
- `config\qq-only.env`、`config\private\`、`runtime\`、`*.log` 已在 `.gitignore` 里。人格补充放在 `config\private\gemini-persona.txt`。
- 日志里可能有私人聊天。排查时只在这台电脑上看。
- 发给 Gemini 的对话会送到 Google 的 API。用量和数据保留以 [Google AI Studio](https://aistudio.google.com/) 的条款为准。这个仓库不提供密钥或额度。

## 常见情况

| 现象 | 可以先看 |
| --- | --- |
| 启动立刻退出，提示需要 `GEMINI_API_KEY` | `config\qq-only.env` 里引擎是否为 `gemini`，密钥那一行是否去掉了 `#` |
| 提示人格文件不能读或是空的 | `GEMINI_PERSONA_FILE` 是否为 `config/private/gemini-persona.txt`，文件是否 UTF-8 且有内容 |
| 面板一直连不上 | 是否在服务器本机打开 `127.0.0.1:3789`；F12 是否写入了 `crc-hub-token`；`04-status.cmd` 的输出 |
| QQ 没有回复 | NapCat 是否登录的是小号；上报地址和两个令牌是否一致；`runtime\gateway.stderr.log` |
| 模型报错或额度错误 | 日志里的 HTTP 状态。在 AI Studio 换一个支持生成内容的模型 id，写入 `GEMINI_MODEL` 后重启 |
| 更新后端口被占用 | 已经有一份 `node.exe` 在跑 `src/server.js`。结束旧进程再启动 |
