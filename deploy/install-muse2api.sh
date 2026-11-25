#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IFS=' ' read -r revision checksum < "$script_dir/muse2api-release"
service=lumavision-muse2api
unit=$service.service
install_root=/opt/lumavision/upstream/muse2api
state=/var/lib/$service
release=$install_root/releases/$revision
current=$install_root/current

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail '请以 root 身份运行此可选安装脚本。'
for program in curl sha256sum tar python3 ss systemctl systemd-analyze; do
  command -v "$program" >/dev/null || fail "缺少 $program，请先按部署文档安装依赖。"
done
[ -x /usr/bin/chromium ] && command -v ffmpeg >/dev/null || fail '请先安装 Debian 的 chromium 和 ffmpeg。'

if systemctl is-active --quiet "$unit"; then
  [ "$(readlink -f "$current")" = "$release" ] || fail '现有引擎正在使用其他版本，请先等待任务结束并停用引擎。'
  printf '%s\n' '固定版本的 Muse 引擎已运行。'
  exit 0
fi

listeners=$(ss -H -ltn '( sport = :18610 or sport = :19210 )')
[ -z "$listeners" ] || fail '端口 18610 或 19210 已被占用。请复用现有引擎，或先确认可以停用占用端口的服务。'

install -d -m 0755 "$install_root/releases"
stage=$(mktemp -d "$install_root/.install.XXXXXX")
trap 'rm -rf -- "$stage"' 0
trap 'exit 1' HUP INT TERM
if [ ! -f "$release/.prepared" ]; then
  curl --fail --silent --show-error --location --proto '=https' --output "$stage/source.tar.gz" \
    "https://codeload.github.com/czg86389-hub/muse2api/tar.gz/$revision"
  printf '%s  %s\n' "$checksum" "$stage/source.tar.gz" | sha256sum --check --status || fail 'Muse 源码包 SHA-256 不匹配。'
  install -d -m 0755 "$release"
  tar -xzf "$stage/source.tar.gz" --no-same-owner --no-same-permissions --strip-components=1 -C "$release"
  python3 -m venv --clear "$release/.venv"
  "$release/.venv/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: -r "$release/requirements.txt"
  touch "$release/.prepared"
fi

if ! id "$service" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$state" --shell /usr/sbin/nologin "$service"
fi
install -d -m 0700 -o "$service" -g "$service" "$state"
if [ ! -e "$state/.env" ]; then
  (umask 077; python3 -c 'import secrets; print("MUSE2API_KEY=m2a_" + secrets.token_hex(24))' > "$stage/engine.env")
  install -m 0600 -o "$service" -g "$service" "$stage/engine.env" "$state/.env"
fi

ln -sfnT "$release" "$current"
install -m 0644 "$script_dir/$unit" "/etc/systemd/system/$unit"
systemd-analyze verify "/etc/systemd/system/$unit"
systemctl daemon-reload
systemctl enable --now "$unit"

attempt=0
while [ "$attempt" -lt 15 ]; do
  status=$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
    'http://127.0.0.1:18610/v1/models' || true)
  if [ "$status" = 401 ] && systemctl is-active --quiet "$unit"; then
    printf '%s\n' 'Muse 引擎已启动，监听 http://127.0.0.1:18610/v1。Key 保存在私有状态目录的 .env。'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done
fail "Muse API 未通过启动检查。请查看 journalctl -u $unit。"
