# LumaVision 单机部署

适用于 Debian、Node.js 24 LTS、systemd，以及 443 由 Nginx stream 按 SNI 分流到 8443 的服务器；部署目标为域名根路径的独立 HTTPS 站点。部署流程从空数据目录开始，画廊在有作品发布后才会出现内容。共享域名的子路径部署需要另行处理静态资源、API 与 JSON 媒体地址，不能直接使用本模板的独立站点配置。

```text
浏览器 → Nginx :443 SNI → :8443 HTTPS → Node 127.0.0.1:5173
                                           └─ /var/lib/lumavision
```

1. 准备 Node.js 24 LTS 和 Linux ffmpeg。创建无登录权限的 `lumavision` 系统用户及同名组，准备由 root 管理、服务账号可读的 `/opt/lumavision`。发布根目录的 `*.mjs`、`*.js`、`*.css`、`index.html`、`favicon.svg`、`package.json` 即可；当前 `data.js` 无示例作品，`assets/` 参考图片也可省略。不要复制本地 `data/`、`mail.local.json`、`tools/` 或测试文件。
2. 将 [环境模板](lumavision.env.example) 复制到 `/etc/lumavision/lumavision.env`，设为 root 所有且权限为 0600。填入实际 HTTPS 来源和管理员邮箱，再选择 Gmail SMTP 或 Resend 并配置凭据。管理员用名单中的邮箱正常注册，邮箱须符合当前注册域名规则；首位普通注册者不会自动取得管理员权限。邮件未配置时验证码接口返回 503。公网模式只读服务环境中的邮件设置。
3. 安装 [systemd unit](lumavision.service) 到 `/etc/systemd/system/`，核对 Node 与 ffmpeg 的绝对路径。systemd 会创建 `/var/lib/lumavision`，以后更新源码时不覆盖该目录。先执行 `systemd-analyze verify`，再执行 `systemctl daemon-reload` 和 `systemctl enable --now lumavision`。用 `curl -H 'Host: gallery.example.com' http://127.0.0.1:5173/api/auth/me` 验证本机服务，记得替换域名。生产模式拒绝未配置的 Host。
4. 确认 DNS 已指向目标服务器。在启用 [HTTP 站点](lumavision-http.conf) 前创建 ACME webroot `/var/www/lumavision-acme`；替换域名并用 `nginx -t` 检查，reload 后用 HTTP-01 webroot 签发证书。再启用 [HTTPS 站点](lumavision-https.conf)，在现有 stream 的 SNI map 中新增 `gallery.example.com 127.0.0.1:8443;`（使用实际域名）。保留现有映射和默认分支，检查配置后 reload。外部访问使用标准 HTTPS 443，应用端口 5173 保持回环监听。配置证书续期后 reload Nginx。
5. 验收域名访问、实际发信、普通用户与管理员注册、登录和退出、文件发布审核、图片与视频缩略图、视频 Range 播放、私有媒体权限，以及应用重启后的持久化。启用生图时，管理员在后台设置上游并单独验证。确认现有站点正常、系统时间同步，再为数据目录安排定期备份与恢复验证。

后续更新只替换发布目录中的应用文件，先校验源码包，再重启 `lumavision`；不要覆盖状态目录、邮件配置或 Nginx 配置。改动 Nginx 前保留原配置。回退时撤掉本站的 SNI 映射及独立站点配置，经 `nginx -t` 后 reload；需要时停用本站 systemd unit，保留状态目录。上传、缩略图和媒体继续通过 Node 路由，由应用检查权限和限制。
