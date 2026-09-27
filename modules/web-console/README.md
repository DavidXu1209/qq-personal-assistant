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

唯一可编辑源为此目录的 `client.html`、`client.css`、`client.js`。
构建客户端时单向复制至 app bundle，不在 Mac 客户端 Resources 中维护第二份源码。
