# LumaVision 单机部署

适用于 Debian、Node.js 24 LTS、systemd，以及 443 由 Nginx stream 按 SNI 分流到 8443 的服务器；部署目标为域名根路径的独立 HTTPS 站点。部署流程从空数据目录开始，画廊在有作品发布后才会出现内容。共享域名的子路径部署需要另行处理静态资源、API 与 JSON 媒体地址，不能直接使用本模板的独立站点配置。

共享域名子路径部署的额外约束：发布副本要把四个前端模块（`app.js`、`auth-ui.js`、`generation-ui.js`、`media.js`）里的 `/api/` 换成 `/lumavision-api/` 标记，交由 Nginx `sub_filter` 改写成 `/LumaVision/api/`；同时所有依赖 `sub_filter` 的 location 都要写 `proxy_set_header Accept-Encoding "";`，因为应用会对文本响应做 Brotli/Gzip，压缩过的响应体无法被 `sub_filter` 改写。

```text
浏览器 → Nginx :443 SNI → :8443 HTTPS → Node 127.0.0.1:5173
                                           └─ /var/lib/lumavision
```

1. 准备 Node.js 24 LTS 和 Linux ffmpeg。创建无登录权限的 `lumavision` 系统用户及同名组，准备由 root 管理、服务账号可读的 `/opt/lumavision`。发布根目录的 `*.mjs`、`*.js`、`*.css`、`index.html`、`favicon.svg`、`package.json` 即可；当前 `data.js` 无示例作品，`assets/` 参考图片也可省略。不要复制本地 `data/`、`mail.local.json`、`tools/` 或测试文件。
2. 将 [环境模板](lumavision.env.example) 复制到 `/etc/lumavision/lumavision.env`，设为 root 所有且权限为 0600。填入实际 HTTPS 来源和管理员邮箱，再选择 Gmail SMTP 或 Resend 并配置凭据。管理员用名单中的邮箱正常注册，邮箱须符合当前注册域名规则；首位普通注册者不会自动取得管理员权限。邮件未配置时验证码接口返回 503。公网模式只读服务环境中的邮件设置。
3. 将 [systemd unit](lumavision.service) 安装为 `/etc/systemd/system/lumavision.service`，核对 Node 与 ffmpeg 的绝对路径。systemd 会创建 `/var/lib/lumavision`，以后更新源码时不覆盖该目录。先执行 `systemd-analyze verify /etc/systemd/system/lumavision.service`，再执行 `systemctl daemon-reload` 和 `systemctl enable --now lumavision.service`。用 `curl -H 'Host: gallery.example.com' http://127.0.0.1:5173/api/auth/me` 验证本机服务，记得替换域名。生产模式拒绝未配置的 Host。
4. 确认 DNS 已指向目标服务器。在启用 [HTTP 站点](lumavision-http.conf) 前创建 ACME webroot `/var/www/lumavision-acme`；替换域名并用 `nginx -t` 检查，reload 后用 HTTP-01 webroot 签发证书。再启用 [HTTPS 站点](lumavision-https.conf)，在现有 stream 的 SNI map 中新增 `gallery.example.com 127.0.0.1:8443;`（使用实际域名）。保留现有映射和默认分支，检查配置后 reload。外部访问使用标准 HTTPS 443，应用端口 5173 保持回环监听。配置证书续期后 reload Nginx。
5. 验收域名访问、实际发信、普通用户与管理员注册、登录和退出、文件发布审核、图片与视频缩略图、视频 Range 播放、私有媒体权限，以及应用重启后的持久化。启用生图时，管理员在后台设置上游并单独验证。确认现有站点正常、系统时间同步，再为数据目录安排定期备份与恢复验证。

后续更新只替换发布目录中的应用文件，先校验源码包，再重启 `lumavision.service`。保留 `/opt/lumavision/upstream/muse2api`、状态目录、邮件配置和 Nginx 配置。改动 Nginx 前保留原配置。回退时撤掉本站的 SNI 映射及独立站点配置，经 `nginx -t` 后 reload；需要时停用本站 systemd unit，保留状态目录。上传、缩略图和媒体继续通过 Node 路由，由应用检查权限和限制。

## 可选部署 Muse 图片和视频

完成上述 Node 部署即可运行网站。需要 Muse 时，在同一台 Debian 主机加装一个独立的 `lumavision-muse2api.service`，图片和视频共用该引擎及 Muse 账号池。Python、Chromium 和引擎都只在启用此部署选项时安装。以下命令从包含 `deploy/` 的源码目录运行。

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends ca-certificates curl iproute2 python3 python3-venv chromium ffmpeg
sudo sh deploy/install-muse2api.sh
```

安装脚本使用固定的 [muse2api 1.6.12 发行提交](https://github.com/czg86389-hub/muse2api/commit/f7f5be5fce4d4e3a4f7240a09ac95c02ed60ff46)，校验源码包 SHA-256，将引擎和独立 venv 安装到 `/opt/lumavision/upstream/muse2api`。安装后，启动 `lumavision.service` 会同时启动独立的 [lumavision-muse2api.service](lumavision-muse2api.service)。服务账号为 `lumavision-muse2api`，API 监听 `127.0.0.1:18610`，Chromium CDP 使用回环端口 `19210`，引擎并发为 1。Nginx 只代理 Node。脚本发现端口已被其他服务占用时会退出。

引擎 Key、登录态、任务、浏览器配置及媒体保存在私有 `/var/lib/lumavision-muse2api`，备份时保留整个目录。首次安装将生成 Key，保存到该目录权限为 `0600` 的 `.env`。通过 SSH 本地转发访问引擎管理页，命令中的用户和主机使用实际值。

```sh
ssh -N -L 127.0.0.1:28610:127.0.0.1:18610 -l deploy example.net
```

在本机打开 `http://127.0.0.1:28610/admin`，在页面中输入私有 `.env` 里的引擎 Key，然后导入已获授权的 Muse 登录态并确认账号可用。接着在 lumavision「管理后台 → 生成服务」分别打开「Muse 生图配置」和「视频配置」，填入服务器侧地址 `http://127.0.0.1:18610/v1` 与同一个**引擎 Key**。测试连接后，在隔离验证实例保存并启用两个开关，再验证实际生图、视频、私有媒体访问和投稿流程。生产实例可按需启用两项管理员开关。

已有 MuseAPI-Video 部署可直接复用其正在运行的 `18610` 引擎和账号池，跳过安装脚本。切换现有视频配置前等待在途任务结束，用引擎地址和引擎 Key 测试连接，再保存。确认真实成片可提交、查询和下载后，可停用没有其他使用者的 `8787` 平台。保留原引擎的配置和状态目录，已有平台代理配置也可继续使用。

若旧版安装脚本曾把此独立引擎安装到 `/opt/lumavision-muse2api`，等在途任务结束后先运行 `sudo systemctl disable --now lumavision-muse2api.service`，再运行新版安装脚本。新版会继续使用现有的 `/var/lib/lumavision-muse2api` 和 Key。

停用独立引擎前，先在 lumavision 关掉两项 Muse 开关并等在途任务结束，再运行 `sudo systemctl disable --now lumavision-muse2api.service`。保留状态目录供下次启用或恢复使用。
