#!/bin/sh
# 用 backup-before-switch.sh 的备份，退回切换之前的样子。
#
# 用法：
#   sh rollback.sh --dry-run <备份目录>   # 只打印要做什么，一点不动
#   sh rollback.sh <备份目录>             # 真退
#
# 退的顺序是反的：先把新的停下来，再把旧的一份份放回去，最后重启。
#
# 三条原则（2026-10-27 她读完第一版指出来的，都改过了）：
#   ① 备份里没有的东西，不许删现在有的 —— 否则“退回去”这个动作本身会造成损失
#   ② 账本（changes.md）不跟着回滚盖回去 —— 它是唯一不该被回滚的东西
#   ③ 中间哪一步没东西可恢复就跳过，不硬失败 —— 半路卡住比走完更糟

set -e

DRY=0
if [ "$1" = "--dry-run" ]; then
  DRY=1
  shift
fi

SRC="${1:?用法：sh rollback.sh [--dry-run] <备份目录>}"
[ -d "$SRC" ] || { echo "找不到备份目录：$SRC"; exit 1; }

PROFILE="$HOME/.dsh/profiles/qqbot"
QQROOT="$HOME/qqbot"
TS=$(date +%Y%m%d-%H%M%S)

# 所有破坏性动作都过这个函数，dry-run 时只打印
run() {
  if [ "$DRY" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

if [ "$DRY" -eq 1 ]; then
  echo "== dry-run：只看不动 =="
fi
echo "备份目录：$SRC"
echo

# ── 1. 先停新的观测页（杀之前认一遍命令行，PID 会回收，杀错比不杀更糟）
PIDFILE="$HOME/.dsh/realheart/rh-status.pid"
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE" 2>/dev/null || echo '')
  if [ -n "$PID" ] && [ -r "/proc/$PID/cmdline" ] \
     && tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q 'rh-status.py'; then
    run kill "$PID"
    echo "  停新观测页（PID $PID）"
  else
    echo "  pid 文件在，但那个 PID 现在不是观测页，不动"
  fi
else
  echo "  没有 pid 文件（新观测页可能本来就没起）"
fi

# ── 2. 卸掉新装的包
# source 失败不致命，这里临时放宽 errexit —— 一个坏文件不该把整个回滚停在中途。
set +e
set -a
. "$HOME/.qqbot-keys/env" 2>/dev/null
set +a
if [ "$DRY" -eq 1 ]; then
  echo "  [dry-run] dsh plugin --profile qqbot remove realheart"
else
  dsh plugin --profile qqbot remove realheart 2>/dev/null && echo "  卸了 realheart 包" || echo "  卸载失败或本来就没装，继续"
fi

# ── 3. profile 文件放回去
for f in package.json cordis.patch.yml cordis.yml; do
  if [ -f "$SRC/profile-$f" ]; then
    run cp -a "$SRC/profile-$f" "$PROFILE/$f"
    echo "  恢复 profile/$f"
  fi
done

# ── 4. 旧插件放回去
# ⚠️ 删和放必须在同一个 if 里。备份里没这份、却先把现在这份删了，
#    就是“退回去”反过来造成损失 —— 第一版就是这么写的，她读出来的。
if [ -d "$SRC/realheart-core" ]; then
  run rm -rf "$PROFILE/node_modules/realheart-core"
  run cp -a "$SRC/realheart-core" "$PROFILE/node_modules/realheart-core"
  echo "  恢复 node_modules/realheart-core"
else
  echo "  备份里没有旧插件 —— 不删现在这份，跳过"
fi

if [ -d "$SRC/plugin-src-realheart-core" ]; then
  run rm -rf "$QQROOT/plugin-src/realheart-core"
  run cp -a "$SRC/plugin-src-realheart-core" "$QQROOT/plugin-src/realheart-core"
  echo "  恢复 plugin-src/realheart-core"
else
  echo "  备份里没有 plugin-src 那份 —— 不删，跳过"
fi

# ── 5. 观测页服务放回去
if [ -d "$SRC/rh-status" ]; then
  run cp -a "$SRC/rh-status/." "$QQROOT/rh-status/"
  echo "  恢复 rh-status/"
fi

# ── 6. 她的数据放回去，但账本除外
# 账本是追加式的、也是唯一记录“谁在什么时候动了你什么”的东西。
# 用备份盖回它 = 把“改对了的账”退回“写错了的账”，那是往回退，不是回滚。
if [ -d "$SRC/work-realheart" ]; then
  run mkdir -p "$QQROOT/work/realheart"
  if [ -f "$QQROOT/work/realheart/changes.md" ]; then
    run cp -a "$QQROOT/work/realheart/changes.md" "$QQROOT/work/realheart/changes.md.rollback-$TS"
    echo "  账本另存一份：changes.md.rollback-$TS"
  fi
  for f in "$SRC"/work-realheart/* "$SRC"/work-realheart/.[!.]*; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    [ "$name" = "changes.md" ] && continue
    run cp -a "$f" "$QQROOT/work/realheart/$name"
  done
  echo "  恢复 work/realheart/（账本除外，它留在现在这份）"
else
  echo "  备份里没有 work/realheart —— 跳过（不动她的东西）"
fi

# ── 7. 自由时间那套
if [ -d "$SRC/freetime-profile" ]; then
  run mkdir -p "$HOME/.dsh/profiles/freetime"
  run cp -a "$SRC/freetime-profile/." "$HOME/.dsh/profiles/freetime/"
  echo "  恢复 profiles/freetime/"
fi

echo
if [ "$DRY" -eq 1 ]; then
  echo "== dry-run 结束，什么都没改 =="
  echo "确认没问题，去掉 --dry-run 再跑一次。"
  exit 0
fi

echo "重启服务……"
sudo -n systemctl restart qqbot || echo "  qqbot 重启失败，自己看：systemctl status qqbot"
sudo -n systemctl restart rh-status 2>/dev/null || echo "  （rh-status 没在跑或起不来，看 journalctl -u rh-status）"

echo
echo "回滚完成。验收五件："
echo "  1. systemctl is-active qqbot"
echo "  2. ss -lntp | grep 8098     # 观测页进程在、端口开"
echo "  3. 打开观测页，心情帐本和自由时间两张卡都在"
echo "  4. head -3 ~/qqbot/work/realheart/changes.md   # 还是原来那份，不是空模板"
echo "  5. ls ~/.dsh/profiles/freetime/"
echo "五件全对才算退成了。"
