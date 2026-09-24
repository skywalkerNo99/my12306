# fd62 服务部署

公网入口保留现有 HTTPS 和入口认证，fd62 上 Nginx 监听 HTTP 4200：

- `/`：入口页
- `/prefect/`：Prefect 页面；`/prefect/api/` 转内部 `/api/`
- `/my12306/`：my12306 页面、API、WebSocket
- `/api/`：保留旧 Prefect API 客户端兼容入口

Prefect worker 继续使用 `http://prefect-server:4200/api`。不要修改 worker、数据库、Redis 或后台服务。

## my12306

在仓库目录运行（fd62 的命令为 `docker-compose`）：

```sh
# deploy/.env 权限设为 600，填入以下配置，密码至少 12 字符
# MY12306_ADMIN_USER=admin
# MY12306_ADMIN_PASSWORD=自行设置强密码
# GATEWAY_BIND=10.176.51.62
mkdir -p deploy/data
# 数据目录需允许容器 uid 1000 写入

docker compose --env-file deploy/.env -f deploy/compose.yml build my12306
docker compose --env-file deploy/.env -f deploy/compose.yml up -d my12306
```

先验证服务，再切换网关。`deploy/data` 含用户、计划和 12306 会话，应备份且禁止公开。公网服务固定启用多用户模式和 Secure Cookie。首次登录管理员后添加用户；各用户自行扫码，不迁移本机登录凭据。

## Prefect 切换与回滚

备份原 Compose 文件。将 `prefect-path.override.yml` 的设置合入现有 `prefect-server`：移除 host 4200 映射，设置 UI base 和 UI API URL；内部 API 和网络别名不变。只执行 `up -d --no-deps prefect-server`，健康检查通过后启动本项目 `gateway`。

回滚时先停止本项目 `gateway`，恢复备份 Compose，再对 `prefect-server` 执行 `up -d --no-deps`。my12306 的数据不受影响。

不要运行整个 Prefect 项目的 `down`。网关和 Prefect 通过 `awpipeline-prefect_default` 网络互通。若更换域名，同时更新 Prefect UI API URL 和 Light 连接设置。本例代理 Host 固定为公网域名和 4200 端口，更换域名时还需修改 `gateway/proxy-common.conf`。公网证书仍由原入口续期，fd62 不保存其私钥。

公网入口必须透传 WebSocket 的 Upgrade / Connection 请求头；fd62 已配置，外层入口需由运维配置。前端保留 WebSocket，不使用 HTTP 轮询替代。
