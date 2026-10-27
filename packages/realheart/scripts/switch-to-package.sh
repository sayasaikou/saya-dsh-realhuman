#!/bin/sh
# 手工版 realheart-core → 包装的 realheart。一次跑完。
#
# 前提：已经跑过 scripts/backup-before-switch.sh。
# 这个脚本只往前推，出错用 rollback.sh 退。
set -e

PROFILE="$HOME/.dsh/profiles/qqbot"
PKG="$HOME/qqbot/realheart-pkg"
TS=$(date +%Y%m%d-%H%M%S)

echo "== 1. 停掉 systemd 管的旧观测页 =="
# 换过去之后页面由插件自己起。留着会跟插件抢 8098。
sudo -n systemctl disable --now rh-status 2>&1 | tail -1 || echo "  （本来就没在跑）"

echo
echo "== 2. 把包拷进 node_modules =="
# ⚠️ 这里**故意不用** `dsh plugin add`：
#    qqbot 这个 profile 依赖 dsh-napcat，那是个本地包、公网上没有。
#    pnpm add 会重新解析整棵依赖树，卡在 dsh-napcat 上直接 404，
#    而且会把我的包插进它的 lockfile 里。
#    直接 cp 不影响现有依赖树 —— 结果一样（node_modules 里有个 realheart）。
DEST="$PROFILE/node_modules/realheart"
rm -rf "$DEST"
cp -a "$PKG" "$DEST"
echo "  拷到 $DEST"
node --check "$DEST/index.mjs" && echo "  语法 ok"

echo
echo "== 3. 把包加进 profile 的 bundles =="
cd "$PROFILE"
node node_modules/realheart/setup.mjs

echo
echo "== 4. 从 patch 里摘掉 realheart-core 那条 =="
cp cordis.patch.yml "cordis.patch.yml.bak-$TS"
python3 - <<'PY'
import io
p = 'cordis.patch.yml'
t = io.open(p, encoding='utf-8').read()
i = t.find('# ── realheart-core')
if i >= 0:
    io.open(p, 'w', encoding='utf-8').write(t[:i].rstrip() + '\n')
    print('  摘掉了 realheart-core 那一块')
else:
    print('  没找到 realheart-core 那一块（可能已经摘过）')
PY
python3 -c "import yaml;d=yaml.safe_load(open('cordis.patch.yml'));print('  yaml-ok entries=',len(d))"

echo
echo "== 5. 重启 qqbot =="
sudo -n systemctl restart qqbot
sleep 18
echo -n "  qqbot: "; systemctl is-active qqbot

echo
echo "== 6. 等观测页 =="
CFG="$HOME/.dsh/realheart/runtime/config.json"
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 1
  [ -f "$CFG" ] || continue
  S=$(python3 -c "import json;print(json.load(open('$CFG'))['secret'])" 2>/dev/null || echo '')
  [ -n "$S" ] || continue
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8098/$S/" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then echo "  页面 200"; break; fi
  [ "$i" = "12" ] && echo "  页面没通（最后 $CODE），看 ~/.dsh/realheart/rh-status.err.log"
done

echo
echo "== 完成 =="
