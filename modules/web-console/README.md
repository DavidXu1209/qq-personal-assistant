# Web Console Module / Web 控制台模块

Static assets served by Hub:

Hub 提供的静态资源目录：

```text
modules/web-console/public/
```

The Hub serves the WebUI at:

Hub 的 WebUI 地址：

```text
http://localhost:3789
```

The macOS client reuses the same frontend assets.

macOS 客户端复用同一套前端资源。

左侧的“Agent 群聊”可从机器人已加入、且未被设为只读通知源的群中加入白名单；“Agent 私聊”可输入 QQ 号加入。两种添加都会即时保存到本机私有 settings.json，刷新和重启后仍有效。

唯一可编辑源为此目录的 `client.html`、`client.css`、`client.js`。
构建客户端时单向复制至 app bundle，不在 Mac 客户端 Resources 中维护第二份源码。
