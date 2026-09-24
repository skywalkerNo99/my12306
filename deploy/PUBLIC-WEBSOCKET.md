# 给运维：开通公网 WebSocket

目标：`wss://etl-workflow.atominnolab.com:4200/my12306/ws`。

无需增加端口或申请新证书。fd62 的 Nginx 已支持 WebSocket；请在公网 Nginx **现有转发到 fd62:4200 的 location** 中加入以下设置，保留现有 `proxy_pass`、SSL 和认证配置：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 300s;
```

若已有同名指令，修改原指令，避免重复定义。若有多层反向代理，每层都需透传 Upgrade / Connection。

检查并热加载：

```sh
nginx -t && nginx -s reload
```

容器部署则在 Nginx 容器内执行这两个命令，并将配置保存到持久化挂载目录。

验证：登录 my12306 管理台，浏览器开发者工具 Network → WS 中 `/my12306/ws` 返回 **101 Switching Protocols**，页面显示“实时在线”。401 表示入口或管理台尚未登录；目前外层不透传时返回 404。

参考：[Nginx 官方 WebSocket 代理说明](https://nginx.org/en/docs/http/websocket.html)。
