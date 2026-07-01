# Aether 管家 APP（自带视频 CLI 本地桥 · BYO）

> 配套 ADR-0149。把你**自己**的可灵 / 即梦官网订阅接进 ARTVAS 画布视频节点：
> ARTVAS 只下发「提示词 + 参数 + 参考图链接」，真正的生成在你本机用官方 CLI 跑，
> **凭证和命令执行全程留在你电脑上，绝不上传 ARTVAS**（I-BYO-NOTOKEN）。

---

## 它是什么

一个零第三方依赖的 Node 常驻程序。它不断向 ARTVAS 轮询「待执行的自带订阅视频工单」，
认领后翻译成官方 CLI 命令（`kling` / `dreamina`）在本机执行，再把生成好的视频
**远端 CDN 链接**回传给 ARTVAS 归档落库。你在画布里照常看到视频节点出片，
但这一单 ARTVAS **不收生成费**（`system_free`）。

三层架构（解耦、易扩展）：

- **harness（通用外壳）** `src/harness.js`：认领 / 心跳 / 回传 / 清理，与具体 CLI 无关。
- **brain（决策层，可空）** `src/brain.js`：v1 直通；未来可加本地智能体改写/挑模型/自愈。
- **handler（per-CLI 翻译）** `src/handlers/*.js`：把通用工单翻成 kling / dreamina 子命令。

新增第三方 CLI（如 runway/pika）只需加一个 handler，harness / brain 不动。

---

## 为什么可以放心运行（可自行核验）

这个管家跑在**你自己的电脑**上、还要用到**你付费的可灵 / 即梦订阅**，所以它的每一条行为都摆在明面上供你核验：

- **纯源码、无编译**：你下载的 zip 就是本仓库的源码本身（没有任何二进制/编译产物）。可**逐行对照**，也可用 release 附带的 `SHA256SUMS` 核验「下载的包 == 公开源码打的包」：
  ```bash
  sha256sum aether-companion.zip   # 与 release 里的 SHA256SUMS 比对
  ```
- **绝不碰你的可灵/即梦凭证**：全程只 `spawn` 官方 CLI（`kling` / `dreamina`）并读它的 JSON 输出，**从不读取 `~/.kling` / `~/.dreamina_cli` 凭证文件、从不上传任何 token**。想确认？在 `src/` 里搜 `.kling` / `credentials`，只会在注释里出现「不读取」的声明。
- **只跟你配置的 ARTVAS 通信**：参考图下载**仅在同源时**才附带连接码（`src/download.js`），产物只回传你自己的 server（`src/apiClient.js` 全部端点都在 `/api/deskpet/*`）。
- **连接码是受限令牌**：只授权 `/api/deskpet/*` 一个作用域，约 30 天过期、可在 ARTVAS 个人中心随时**一键吊销**；它拿不到你的登录态、动不了任何他人数据。
- **协议唤起直调 node、不过 shell**：一键连接用的自定义协议把参数作为单一 `%1` 走 CreateProcess（`src/protocol.js`），配严格白名单，杜绝「URL 里塞命令被执行」这类注入。
- **全程本机执行**：视频在你电脑上、用你自己的订阅生成；ARTVAS 只下发「提示词 + 参数 + 参考图链接」。

> 源码可读 ≠ 你必须读——但**任何人都能读、能核验**，这正是它值得信任的原因。

---

## 快速开始（推荐 · 跟着向导走）

1. **装 Node.js（只需一次）**：到 [nodejs.org](https://nodejs.org) 装 LTS（推荐 20.x）。
   （可灵 CLI 本身就需要 Node，所以这步绕不开。）
2. **启动管家**：双击 `启动管家.bat`（Windows）/ `启动管家.command`（macOS）/ `./start.sh`（Linux）。
   首次运行会进入**配置向导**，自动带你：
   - 检测并（征得同意后）**自动 `npm i -g` 安装可灵命令行**（会先问你「国内站 / 海外站」）；
   - 拉起 **`kling login`** 打开浏览器完成登录授权（可灵官方唯一登录方式，只需一次）。
3. **一键连接账号**：回到 ARTVAS 网页 → 个人中心 → 设置 → 点「**一键连接本机管家**」。
   连接码会自动送进管家（无需手动复制粘贴）；运行中的管家会**热重载**立即生效。
4. **开始生成**：画布视频节点把「计费」切到 **自带可灵**，正常点生成即可。

> 「一键连接」点了没反应？说明本机还没装/启动过管家（协议未注册）。先完成第 1-2 步，
> 或退一步用设置页的「**复制连接码（备用）**」把连接码粘进管家窗口。

ARTVAS 账号需为 **高级版 / 专业版 / 受邀** 会员（BYO 是会员权益）。

---

## 手动配置（进阶 / 自托管 / 本地测试）

不想走向导，也可手动配置：

```bash
cp config.example.json config.json   # 启动器会自动帮你建，通常无需手动
```

| 字段 | 说明 |
|---|---|
| `serverUrl` | ARTVAS 站点地址，如 `https://your-artvas-domain.com`（本地测试 `http://localhost:5000`） |
| `deskpetToken` | ARTVAS 个人中心「获取连接码」复制的连接码（受限作用域，约 30 天，可随时吊销） |
| `pollIntervalMs` | 轮询间隔（默认 5000） |
| `maxConcurrent` | 同时处理几单（默认 1，建议 1~2） |
| `kling.defaultModel` | 留空 = 自动 `who_am_i` 选第一个可用模型；填写则固定用它 |
| `jimeng.defaultModelVersion` | 即梦模型版本，如 `seedance1.0` / `seedance2.0vip` |

也支持环境变量覆盖：`AETHER_SERVER_URL` / `AETHER_DESKPET_TOKEN` / `KLING_BIN` / `DREAMINA_BIN`。

命令行开关：

```bash
node src/index.js --doctor                  # 自检：配置 / 服务端连通 / 会员等级 / CLI 是否可用
node src/index.js --setup                   # 重新进配置向导（重装/重登/改连接码）
node src/index.js --bind <连接码> --server <ARTVAS地址>   # 命令行直接绑定连接码
node src/index.js --once                    # 只跑一轮（调试）
node src/index.js                           # 常驻轮询（正式使用）
```

启动后，在 ARTVAS 画布的视频节点把「计费」切到 **自带可灵 / 自带即梦**，点生成即可。
本程序认领到工单后会在终端打印进度，完成后画布节点自动出片。

---

## 安全与合规

- **凭证零接触**：本程序只 `spawn` 官方 CLI 二进制并解析其 JSON 输出，
  从不读取 `~/.kling` / `~/.dreamina_cli` 等凭证文件，从不把任何 token 回传 ARTVAS。
  回传给 ARTVAS 的只有「上游 CDN 视频链接」或「错误信息」。
- **参考图**：ARTVAS 下发的是匿名可读能力链接（`/api/images/file/...`），
  本程序下载到系统临时目录喂给 CLI，执行完即删。
- **即梦合规**：若遇 `AigcComplianceConfirmationRequired`，请先去即梦 Web 端完成一次
  内容授权确认再重试。
- **责任自负**：使用自带订阅即代表你以**个人账号**生成内容，须遵守可灵 / 即梦各自的服务条款。

---

## 常见问题

| 现象 | 排查 |
|---|---|
| `鉴权失败（HTTP 401）` | Deskpet Token 失效，重新在 ARTVAS 复制 |
| `无权使用自带 CLI 通道（403）` | 当前会员等级无 BYO 权限（需 advanced/pro/invited） |
| `CLI 未找到` | 官方 CLI 未安装或不在 PATH；用 `KLING_BIN` / `DREAMINA_BIN` 指定绝对路径 |
| `可灵未发现可用模型` | 未 `kling login` 或账户无视频权限 |
| `未从输出解析到视频 URL` | CLI 版本输出格式变化；把 `--once` 终端日志反馈给我们适配 |
| 任务一直「等待本地」 | 本程序未运行 / 未认领；确认 `node src/index.js` 在跑且 `--doctor` 全绿 |

---

## 目录结构

```
aether-companion/
├─ src/
│  ├─ index.js        入口（--doctor / --setup / --bind / --once / 常驻）
│  ├─ setup.js        首次配置向导（装可灵 / 登录 / 连接码引导）
│  ├─ protocol.js     单实例锁 + aether-companion:// 协议（一键连接 bind 深链）
│  ├─ config.js       配置加载 + 写回（writeConfigPatch）
│  ├─ apiClient.js    ARTVAS deskpet BYO 端点封装（含 updateAuth 热重载）
│  ├─ harness.js      通用执行外壳（认领/心跳/回传/清理）
│  ├─ brain.js        决策层（v1 直通）
│  ├─ cli.js          CLI 子进程 + JSON/URL 解析
│  ├─ download.js     参考图下载 + 成片下载（管家上传用）
│  ├─ upload.js       成片下载并上传回 ARTVAS（管家上传主路径）
│  ├─ capabilities.js who_am_i 能力清单采集 + 脱敏上报
│  ├─ klingCaps.js    who_am_i 单飞 + TTL 缓存
│  ├─ logger.js       日志
│  └─ handlers/
│     ├─ index.js     handler 注册表
│     ├─ kling.js     可灵 handler
│     └─ jimeng.js    即梦 handler
├─ config.example.json
├─ 启动管家.bat / .command / start.sh   启动器（首跑直接进向导）
├─ .github/workflows/release.yml        打 tag 自动打包 + 出 SHA256 + 发 Release
├─ LICENSE                              源码可见许可证（可审计，保留控制权）
├─ package.json
└─ README.md
```

---

## 打包与分发

两种打包路径，产物等价（都会附 SHA256 供核验）：

- **本地打包**：仓库根目录跑
  ```bash
  python scripts/build_companion_dist.py
  ```
  生成 `dist/aether-companion.zip` + `dist/aether-companion.zip.sha256`
  （已剔除 `config.json` / `.companion.lock` / `node_modules` / `.github`）。
- **GitHub 自动发布**：给公开仓库打一个 `v*` tag（如 `v0.1.0`）推上去，
  `.github/workflows/release.yml` 会自动打包、生成 `SHA256SUMS`、创建同名 Release 并挂上产物。
  用户即可从 Release 页稳定下载并**逐条核验校验和**。

上传/发布后，在后台把下载地址填进 `system_config.byo_companion_download_url`，
前端「下载本机管家」按钮即生效。

---

## 许可证

采用 **源码可见（Source-Available）许可证**（见 [LICENSE](LICENSE)）：任何人都可**阅读、审计、核验**源码，
也可下载后在自己电脑上运行以连接 ARTVAS；但不授予再分发 / 二次分发衍生品 / 用于搭建竞品的权利。
这样既让你能亲眼确认「它到底对你的电脑和凭证做了什么」，又保留了品牌与产品控制权。
