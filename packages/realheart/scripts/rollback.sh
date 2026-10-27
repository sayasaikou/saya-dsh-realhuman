#!/bin/sh
# 用 backup-before-switch.sh 的备份，退回切换之前的样子。
#
# 用法：
#   sh rollback.sh ~/realheart-switch-20261027-190000
#
# 退的顺序是反的：先把新的停下来，再把旧的一份份放回去，最后重启。
# 中途哪一步没东西可恢复就跳过，不硬失败 —— 半路卡住比走完更糟。
set -e

SRC="${1:?用法：sh rollback.sh <备份目录>}"
[ -d "$SRC" ] || { echo "找不到备份目录：$SRC"; exit 1; }

PROFILE="$HOME/.dsh/profiles/qqbot"
QQROOT="$HOME/qqbot"

echo "从 $SRC 回滚"
echo

# ── 1. 先停新的观测页（它有自己的 pid 文件，杀之前认一遍命令行）
PIDFILE="$HOME/.dsh/realheart/rh-status.pid"
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null || echo '')
  if [ -n "$PID" ] && [ -r "/proc/$PID/cmdline" ] \
     && tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q 'rh-status.py'; then
    kill "$PID" 2>/dev/null || true
    echo "  停了新观测页（PID $PID）"
  fi
fi

# ── 2. 卸掉新装的包（失败也继续，下一步的 package.json 会盖掉它）
set +a
. "$HOME/.qqbot-keys/env" 2>/dev/null || true
set -a
dsh plugin --profile qqbot remove realheart 2>/dev/null && echo "  卸了 realheart 包" || true

# ── 3. profile 文件放回去
cd "$PROFILE"
for f in package.json cordis.patch.yml cordis.yml; do
  if [ -f "$SRC/profile-$f" ]; then
    cp -a "$SRC/profile-$f" "$f"
    echo "  恢复 profile/$f"
  fi
done

# ── 4. 旧插件放回去
rm -rf "$PROFILE/node_modules/realheart-core"
if [ -d "$SRC/realheart-core" ]; then
  cp -a "$SRC/realheart-core" "$PROFILE/node_modules/"
  echo "  恢复 node_modules/realheart-core"
fi
if [ -d "$SRC/plugin-src-realheart-core" ]; then
  rm -rf "$QQROOT/plugin-src/realheart-core"
  cp -a "$SRC/plugin-src-realheart-core" "$QQROOT/plugin-src/realheart-core"
  echo "  恢复 plugin-src/realheart-core"
fi

# ── 5. 观测页服务放回去
if [ -d "$SRC/rh-status" ]; then
  cp -a "$SRC/rh-status/." "$QQROOT/rh-status/"
  echo "  恢复 rh-status/"
fi

# ── 6. 她的数据放回去（账本是追加式的，盖回去等于回到备份那一刻）
if [ -d "$SRC/work-realheart" ]; then
  mkdir -p "$QQROOT/work/realheart"
  cp -a "$SRC/work-realheart/." "$QQROOT/work/realheart/"
  echo "  恢复 work/realheart/（账本 + 改动记录 + 她写的东西）"
fi

# ── 7. 自由时间那套
if [ -d "$SRC/freetime-profile" ]; then
  mkdir -p "$HOME/.dsh/profiles/freetime"
  cp -a "$SRC/freetime-profile/." "$HOME/.dsh/profiles/freetime/"
  echo "  恢复 profiles/freetime/"
fi

echo
echo "重启服务……"
sudo -n systemctl restart qqbot || echo "  qqbot 重启失败，自己看一下：systemctl status qqbot"
sudo -n systemctl restart rh-status 2>/dev/null || echo "  （rh-status 没在跑或起不来，看 journalctl -u rh-status）"

echo
echo "回滚完成。看一眼："
echo "  systemctl is-active qqbot rh-status"
echo "  tail -5 ~/qqbot/work/realheart/changes.md"
