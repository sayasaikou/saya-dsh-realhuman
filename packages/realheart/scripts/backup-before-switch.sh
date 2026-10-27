#!/bin/sh
# 换插件之前先跑：把要动的东西原样打一份，出事了能退。
#
# 用法：
#   sh backup-before-switch.sh              # 备份到 ~/realheart-switch-<时间戳>
#   sh backup-before-switch.sh /某个/目录    # 自己指定
#
# 备份的全是“换了就找不回来”的东西：配置、旧插件、她的账本和她写的东西。
# 不备份能从包重装的东西（node_modules 里那堆依赖）。
set -e

TS_KEEP=$(date +%Y%m%d-%H%M%S)
DEST="${1:-$HOME/realheart-switch-$TS_KEEP}"
PROFILE="$HOME/.dsh/profiles/qqbot"
QQROOT="$HOME/qqbot"

mkdir -p "$DEST"
echo "备份到：$DEST"
echo

# ── 1. profile 的三个文件（插件清单 / patch / cordis）
for f in package.json cordis.patch.yml cordis.yml; do
  if [ -f "$PROFILE/$f" ]; then
    cp -a "$PROFILE/$f" "$DEST/profile-$f"
    echo "  profile/$f"
  fi
done

# ── 2. 旧插件本体（手工装的那份）
if [ -d "$PROFILE/node_modules/realheart-core" ]; then
  cp -a "$PROFILE/node_modules/realheart-core" "$DEST/realheart-core"
  echo "  node_modules/realheart-core"
fi
if [ -d "$QQROOT/plugin-src/realheart-core" ]; then
  cp -a "$QQROOT/plugin-src/realheart-core" "$DEST/plugin-src-realheart-core"
  echo "  plugin-src/realheart-core"
fi

# ── 3. 观测页服务（Python 那几个文件和 config.json 里的口令）
if [ -d "$QQROOT/rh-status" ]; then
  cp -a "$QQROOT/rh-status" "$DEST/rh-status"
  echo "  rh-status/"
fi

# ── 4. 她的数据：账本、改动记录、自由时间产物
if [ -d "$QQROOT/work/realheart" ]; then
  cp -a "$QQROOT/work/realheart" "$DEST/work-realheart"
  echo "  work/realheart/（账本 + 改动记录 + 她写的东西）"
fi

# ── 5. 自由时间那套
if [ -d "$HOME/.dsh/profiles/freetime" ]; then
  cp -a "$HOME/.dsh/profiles/freetime" "$DEST/freetime-profile"
  echo "  profiles/freetime/"
fi
for u in qqbot-freetime.service qqbot-freetime.timer; do
  if systemctl cat "$u" > /dev/null 2>&1; then
    systemctl cat "$u" > "$DEST/$u.unit"
    echo "  $u（systemd 单元）"
  fi
done

echo
echo "好了。"
echo "出问题就退回去："
echo "  sh rollback.sh \"$DEST\""
