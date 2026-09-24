# my12306

TypeScript / Fastify / Vue 3 实现的 12306 购票管理台。支持车票日历、余票查询、周期购票计划和多通道通知。自动购票成功后由用户在 12306 完成支付。

## 最近更新

- 桌面流水线通过后自动发布到 GitHub Releases（未签名内测包标为预发布）。Mac 只提供包含 DMG 和简短说明的内测 ZIP，Windows 提供 EXE，不再重复上传多份应用；附 SHA-256 校验文件。

- **桌面版**：支持 macOS / Windows 独立运行、托盘后台运行、登录电脑后自动后台启动；通过私有 IPC 通信，不监听服务端口。
- **计划日历**：详情支持日历 / 列表切换；首页、计划预览和详情统一显示工作日、休息日、补班及节日名称，均从周一开始排列。
- **按日跳过**：可跳过或恢复某个乘车日期，重启和日期重算后仍保留。待支付订单可确认取消整单并跳过；取消结果不确定时暂停该日自动购票，避免重复下单。
- **购票修复**：按有效日期及出发时间段查询；同车次不同乘降站独立选择；修正席别显示、页面跳转和中断任务状态。失败任务不会因打开详情而重试。
- **登录与通知**：二维码支持自动 / 手动刷新；修复通知编辑保存、官方通知接口的代理 Fake-IP 兼容，以及桌面端同步乘车人等无参数操作的 `415 Unsupported Media Type` 错误。
- **安装包瘦身**：内置 Chromium Headless Shell 和中英文资源，Mac DMG 使用 LZFSE 压缩；当前 Apple 芯片内测整包约 223 MB。

## 安装包打包

在目标平台和对应架构的电脑上构建。需要 Node.js ≥ 22.12（建议 24 LTS）；Mac 内测整包还需要 Python 3。以下命令在仓库根目录执行。

首次准备依赖：

```sh
npm ci
npm run desktop:install
```

每次修改代码后，先构建并检查：

```sh
npm test
npm run desktop:prepare
```

**macOS 内测包（无需开发者证书）**：

```sh
npm --prefix desktop run dist:unsigned -- --mac dmg
npm --prefix desktop run smoke -- --packaged
npm --prefix desktop run bundle:macos
```

输出：`desktop/release/my12306-<版本>-mac-<架构>-unsigned-bundle.zip`。把整个 ZIP 发给测试用户，里面包含 DMG、简短使用说明、应用打不开时的辅助脚本及校验清单；ZIP 旁另有 `.sha256` 文件。Apple 芯片为 `arm64`，Intel 为 `x64`，默认使用构建机架构。

**Windows 内测包**（在 Windows 上执行）：

```sh
npm --prefix desktop run dist:unsigned -- --win nsis
npm --prefix desktop run smoke -- --packaged
```

安装程序位于 `desktop/release/`，文件名带 `-unsigned.exe`。用户无需安装 Node.js 或浏览器。

正式签名构建使用 `dist:signed`，需配置平台证书，macOS 还需公证凭据。也可在 GitHub **Actions → Desktop installers → Run workflow** 选择签名模式，下载构建产物。具体配置、数据目录及后台运行说明见 [桌面版说明](desktop/README.md)。

## 服务版启动

```sh
npm install
npx playwright install chromium
./start.sh build
./start.sh
```

访问 `http://127.0.0.1:7788`。默认是本地单用户模式，无需管理台密码；点击顶栏「连接 12306」，使用 12306 APP 扫码。登录后点击账号菜单可检查连接、同步乘车人或断开账号。

`./start.sh -d` 后台启动，`./start.sh stop` 停止，`./start.sh restart` 后台重启。修改代码后执行 `./start.sh build` 再重启。需要 Node.js 22.12 或更新版本；CI 使用 Node 24。服务端与桌面端统一使用 `better-sqlite3` 13.0.3，避免旧版原生模块在 Node 24 下崩溃。

## 可选管理员模式

首次启动前设置以下环境变量（密码至少 12 字符，最多 72 字节）：

```sh
export MY12306_ADMIN_USER=admin
# 安全地设置 MY12306_ADMIN_PASSWORD，不要将真实密码提交到仓库。
# 例如 Bash 中隐藏输入：
read -rs -p '初始管理员密码: ' MY12306_ADMIN_PASSWORD
export MY12306_ADMIN_PASSWORD
./start.sh --multi-user
```

也可设置 `MY12306_MULTI_USER=1` 后使用原有启动命令。**每次启动都需要此开关**；首次初始化后可移除密码环境变量，后续启动不会覆盖已有密码。没有默认管理台密码。

管理员可创建用户、调整显示名称和角色、重置密码、停用与启用账号；不能停用或降级自己。所有用户均可在顶栏管理台账号菜单修改自己的密码。停用、编辑权限或重置密码后原登录失效；停用用户不再执行后续任务。已提交给 12306 的订单仍需在 12306 处理。

计划、乘车人、车票查询、12306 会话、通知配置按用户隔离。管理员可以查询全部过程日志，但不冒用其他用户的 12306 登录。管理台使用服务端会话及 HttpOnly / SameSite=Strict Cookie，7 天过期；WebSocket 复用 Cookie 鉴权，URL 不携带令牌。

首次启用时保留本地用户的数据及 12306 登录态并归属初始管理员。两种模式之间切换**不会合并、删除其他用户的数据**。切回单用户后只执行内置用户的计划。

## 购票、日志和图片分享

- 在「购票计划」选择乘车人、车站、日期规则、车次、席别与时间范围。工作周规则根据节假日与调休推算，可先预览日期。
- 根据起售时间触发任务，暂停计划会阻止后续购票。购票成功后不会自动付款；取消待支付订单会影响该订单的全部乘车人，操作前会明确确认。
- 「过程日志」支持级别、分类、关键词、时间范围查询，管理员还可筛选用户。默认每页 30 条，可一键导出筛选结果 CSV（最多 5 万条，请按日期分批）。导出时间为北京时间。API `/api/logs/export?format=json` 也可下载 JSON。
- 记录、展示和导出时隐藏密钥、链接、手机号、证件字段。日志保存在 SQLite 中，无自动清理策略。
- 日历「分享日历」、已购车票「分享到微信」、车票详情均可生成 PNG 图片。图片在浏览器本地生成，默认隐藏乘车人和座位；订单号、证件号与手机号不进入图片。
- 保存 PNG 后在微信中选择发送，或在支持文件分享的浏览器中使用「系统分享」。是否出现微信由设备与浏览器决定；不依赖微信 JS SDK，也不会自动向微信发送消息。

## 五种通知通道

在「通知通道」中添加一个或多个通道，选择接收购票成功、已有车票查重、登录失效和购票失败事件。支持独立启停、编辑、删除与发送测试。旧飞书配置首次启动时自动迁移一次；新配置不会回显密钥，编辑时留空表示保留，可显式清除可选密钥。

| 通道 | 配置 |
| --- | --- |
| 飞书 | 自定义群机器人 Webhook，可选签名密钥 |
| 企业微信 | 群机器人 Webhook |
| 钉钉 | 自定义机器人 Webhook，可选加签密钥 |
| Telegram | Bot Token 和 Chat ID；用户先发送 `/start` 或将机器人加入群组 |
| 通用 Webhook | 公网 HTTPS 地址，可选 Bearer Token |

通用 Webhook 收到 `{ source: "my12306", event, text, urgent, timestamp }` JSON；HTTP 2xx 视为成功。其他平台还检查响应中的业务成功码。每通道独立发送，某通道失败不会阻止其他通道；页面和日志记录发送结果。不会自动重试通知，避免重复消息。

地址必须为标准 443 端口的 HTTPS，发送时固定解析到的 IPv4，不允许内网、本机地址和重定向。官方通知接口兼容代理的 `198.18.0.0/15` Fake-IP，仍校验原始域名的 HTTPS 证书；通用 Webhook 必须解析到公网地址。仅 IPv6 的 Webhook 暂不支持。平台若启用关键词，请允许 `12306`，签名密钥与平台配置保持一致。购票成功等紧急消息在飞书、企业微信和钉钉尝试群内 @所有人，实际提醒效果由平台和群权限决定。

设计参考 [AstrBot 的 Platform 抽象](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/platform/platform.py) 中的通道分离思路。本项目独立实现 TypeScript 发送适配器，没有引入 AstrBot、模型、LLM 或插件运行时。

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `MY12306_PORT` / `PORT` | `7788` | 后端端口 |
| `MY12306_HOST` | `127.0.0.1` | 监听地址 |
| `MY12306_MULTI_USER` | `0` | 设置为 `1` 启用管理台鉴权与用户管理 |
| `MY12306_ADMIN_USER` | `admin` | 首次启用时管理员名，3–40 位字母、数字、点、下划线或短横线 |
| `MY12306_ADMIN_PASSWORD` | 无 | 首次启用的管理员密码 |
| `MY12306_SECURE_COOKIE` | `0` | HTTPS 反向代理部署时设 `1`，Cookie 只通过 HTTPS 发送 |
| `MY12306_DATA_DIR` | `server/data` | SQLite、浏览器 profile、会话与节假日缓存 |
| `MY12306_NO_OPEN` | `0` | 启动脚本不自动打开浏览器 |
| `MY12306_PRESALE_DAYS` | `14` | 起售查询的兜底预售期 |
| `MY12306_PRE_TRIGGER_MS` | `3000` | 调度提前量 |
| `MY12306_HEADLESS` | `true` | 无头浏览器开关 |

远程多用户部署应启用管理员模式并通过 HTTPS 反向代理访问，代理须保留原始 Host 并转发 WebSocket。设置 `MY12306_SECURE_COOKIE=1`。默认单用户模式用于本机访问。运行数据包含登录态和通知密钥，位于 gitignored 的数据目录，不应提交仓库或公开。

## 开发与验证

```sh
npm run dev:server
npm run dev:web
npm run build:server
npm run build:web
npm test
npm run test:regression
npm run test:features
# 独立 UI 测试服务：模拟车票，无调度器，无真实通知
node --import tsx server/src/__test__/ui-fixture.ts
```

自动回归测试使用固定日历、独立临时数据库和模拟通知 / 订单响应；桌面冒烟测试也使用隔离数据，不执行真实购票或取消订单。测试范围见 [TESTING.md](TESTING.md)。

请遵守 12306 的使用规则；自动化不会付款，支付与订单确认仍由用户在 12306 完成。

### 远程服务与 Light 客户端

支持在服务器运行购票后台，桌面只连接远程服务。Light 安装包名称包含 `light`，不含本地后端、SQLite 或 Playwright；退出客户端不影响服务器购票。普通安装包继续支持本机独立运行。

Light 首次启动填写 HTTPS 服务地址（例如 `https://etl-workflow.atominnolab.com:4200/my12306/`），如公网入口要求认证，填写原入口账号密码，再登录 my12306 管理台。菜单支持连接设置、后台运行和开机自动后台启动。入口密码不写入配置文件。

[fd62 / Nginx 部署说明](deploy/README.md)。网关根路径为入口页，Prefect 使用 `/prefect/`，my12306 使用 `/my12306/`。

```sh
node desktop/scripts/prepare-light.mjs
cd desktop
MY12306_SIGNING=unsigned node node_modules/electron-builder/cli.js --config electron-builder-light.cjs --publish never
```

Light 产物位于 `desktop/light-release/`。桌面流水线同时构建普通版和 Light 版，发布到同一个 Release。
