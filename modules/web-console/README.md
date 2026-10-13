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

The macOS client reuses the same frontend assets. It loads them from a local file, so its browser origin is `null` / `file://`. The hub allows that origin by default. Fetch calls send the hub token in `Authorization`. Live updates and sticker images cannot set headers, so the page first exchanges the hub token for a short-lived read-only grant and puts only that grant in the URL.

macOS 客户端复用同一套前端资源。客户端从本地文件加载页面，浏览器来源是 `null` / `file://`，网关默认允许该来源。普通请求使用 `Authorization` 携带长期令牌。实时连接和表情图片无法设置请求头，页面会先换成短期只读令牌，URL 里只放这张临时令牌。

左侧的“Agent 群聊”可从机器人已加入、且未被设为只读通知源的群中加入白名单；“Agent 私聊”可输入 QQ 号加入。两种添加都会即时保存到本机私有 settings.json，刷新和重启后仍有效。

唯一可编辑源为此目录的 `client.html`、`client.css`、`client.js`。
构建客户端时单向复制至 app bundle，不在 Mac 客户端 Resources 中维护第二份源码。
