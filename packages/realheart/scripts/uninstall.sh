#!/bin/sh
# 把 realheart 从这台机器上摘干净。
#
# 用法：
#   sh scripts/uninstall.sh --dry-run                     # 只打印要做什么，一个字节都不动
#   sh scripts/uninstall.sh                               # 摘掉，保留她的东西
#   sh scripts/uninstall.sh --profile qqbot               # 指定 profile（名字或完整路径）
#   sh scripts/uninstall.sh --purge                       # 连 stateDir 一起删（要确认）
#   sh scripts/uninstall.sh --purge --yes                 # 非交互环境用这个
#
# 为什么要有这个脚本（而不是 README 里那几行手敲命令）：
#   手敲的版本漏了三步 —— bundles 里那行、pid 文件、运行时目录里的 secret。
#   漏了哪一步都不是当场报错，是**下次启动**才炸，而且炸的姿势看不懂。
#
# 三条原则（和 rollback.sh 同一套，别改）：
#   ① 默认不删她的东西 —— stateDir 是账本，不是缓存。要删得自己开口（--purge）。
#   ② 中途哪一步没东西可做就跳过，不硬失败 —— 半路卡住比走完更糟。
#   ③ 破坏性动作全过 run()，--dry-run 时只打印，保证“说要看一眼”真的什么都不改。

set -e

DRY=0
PURGE=0
YES=0
KILL=1
CLI=1
PROFILE_ARG=''
STATE_ARG=''

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --purge)   PURGE=1; shift ;;
    --yes)     YES=1; shift ;;
    --no-kill) KILL=0; shift ;;
    --no-cli)  CLI=0; shift ;;
    --profile) PROFILE_ARG="${2:?--profile 后面要跟 profile 名字或路径}"; shift 2 ;;
    --state-dir) STATE_ARG="${2:?--state-dir 后面要跟账本目录}"; shift 2 ;;
    -h|--help)
      # 把开头那段注释原样当用法打出来：连注释一起维护，就不会有两份说明书对不上
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
      exit 0 ;;
    *) echo "不认识的参数：$1（--help 看用法）"; exit 1 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PKG=realheart
TS=$(date +%Y%m%d-%H%M%S)

# 所有破坏性动作都过这里
run() {
  if [ "$DRY" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

echo "== realheart 卸载 =="
if [ "$DRY" -eq 1 ]; then echo "（dry-run：只看不动）"; fi
echo

# ── 1. 定位 profile ──
# 三个来源，优先级从上到下。找不到就明说怎么给，不猜。
if [ -n "$PROFILE_ARG" ]; then
  case "$PROFILE_ARG" in
    /*|./*|../*|*/*) PROFILE="$PROFILE_ARG" ;;
    *) PROFILE="$DSH_HOME/profiles/$PROFILE_ARG" ;;
  esac
elif [ -f "./package.json" ] && grep -q '"profile"' "./package.json" 2>/dev/null; then
  PROFILE=$(pwd)
else
  echo "找不到 profile。这个脚本得知道插件装在哪个 profile 里。"
  echo "  sh scripts/uninstall.sh --profile <名字>      # 例：--profile qqbot"
  echo "  sh scripts/uninstall.sh --profile <完整路径>"
  echo "现有 profile："
  ls -1 "$DSH_HOME/profiles" 2>/dev/null | grep -v '^_build$' | sed 's/^/  /' || echo "  （$DSH_HOME/profiles 不存在）"
  exit 1
fi

if [ ! -f "$PROFILE/package.json" ]; then
  echo "那个目录里没有 package.json：$PROFILE"
  echo "现有 profile："
  ls -1 "$DSH_HOME/profiles" 2>/dev/null | grep -v '^_build$' | sed 's/^/  /' || echo "  （$DSH_HOME/profiles 不存在）"
  exit 1
fi
echo "profile：$PROFILE"
echo "DSH_HOME：$DSH_HOME"

RUNTIME_DIR="$DSH_HOME/realheart"
PIDFILE="$RUNTIME_DIR/rh-status.pid"
CFGJSON="$RUNTIME_DIR/runtime/config.json"

# stateDir：三个来源，优先级从上到下。
# ① --state-dir（人说的最算数）② 运行时 config.json（实际生效的那份）③ 默认路径（**猜的**）。
# 为什么要分“猜的”：卸过一次之后运行时目录就没了，config.json 也跟着没了。
# 这时再跑 --purge，脚本手里没有任何依据 —— 不标注出来，就有可能在“删账本”这种事上瞎猜。
STATE_DIR=''
STATE_FROM=''
if [ -n "$STATE_ARG" ]; then
  STATE_DIR="$STATE_ARG"
  STATE_FROM='命令行 --state-dir'
elif [ -f "$CFGJSON" ]; then
  STATE_DIR=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c.stateDir||""))}catch{}' "$CFGJSON" 2>/dev/null || true)
  if [ -n "$STATE_DIR" ]; then STATE_FROM='运行时 config.json'; fi
fi
if [ -z "$STATE_DIR" ]; then
  STATE_DIR="$HOME/qqbot/work/realheart"
  STATE_FROM='默认路径（猜的）'
fi
echo "stateDir：$STATE_DIR  〔来源：$STATE_FROM〕"
echo

# ── 2. 停观测页 ──
# 插件卸载时会自己停一次；这里做的是“卸之前先停”，因为下面要删它的运行时目录，
# 让一个进程攥着已经被删掉的文件跑，比直接停掉更乱。
#
# 杀之前认一遍命令行：PID 会回收，杀错一个别人的进程比不杀更糟。
if [ "$KILL" -eq 0 ]; then
  echo "跳过停观测页（--no-kill）"
elif [ ! -f "$PIDFILE" ]; then
  echo "没有 pid 文件 —— 观测页本来就没在跑，或者已经停过"
else
  PID=$(cat "$PIDFILE" 2>/dev/null || true)
  case "$PID" in
    ''|*[!0-9]*) echo "pid 文件里不是数字（$PID），不拿它去 kill"; PID='' ;;
  esac
  if [ -n "$PID" ]; then
    MATCH=0
    if [ -r "/proc/$PID/cmdline" ]; then
      # Linux：最准的一路
      tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q 'rh-status.py' && MATCH=1
    elif command -v ps >/dev/null 2>&1 && ps -p "$PID" -o args= >/dev/null 2>&1; then
      # MSYS / macOS：ps 能不能用不确定，能拿到比不拿好
      ps -p "$PID" -o args= 2>/dev/null | grep -q 'rh-status.py' && MATCH=1
      [ "$MATCH" -eq 0 ] && ps -p "$PID" -o args= 2>/dev/null | grep -q . && MATCH=2
    elif kill -0 "$PID" 2>/dev/null; then
      MATCH=2
    fi
    case "$MATCH" in
      1) if [ "$DRY" -eq 1 ]; then
           echo "  [dry-run] 停观测页（PID $PID，已核对命令行是 rh-status.py）"
         else
           run kill "$PID" && echo "停了观测页（PID $PID）"
         fi ;;
      2) echo "⚠ PID $PID 还活着，但这台机器上没法确认它是观测页（没有 /proc）。"
         echo "  确认了再停：kill $PID    或者加 --no-kill 自己处理"
         if [ "$DRY" -eq 0 ]; then exit 2; fi ;;
      *) echo "pid 文件在，但那个进程已经不在了（正常：重启过或早停过）" ;;
    esac
  fi
fi
echo

# ── 3. 卸包（尽力而为）──
# 为什么不能因为这一步失败就整体退出：README 里那个 404 假象（本地包挡路），
# 以及 desktop profile 被 Electron 独占时 CLI 根本连不上 —— 包没删掉，但 bundles 行
# 和运行时该收拾的还得收拾。真正的判据在后面，不在这一步。
if [ "$CLI" -eq 0 ]; then
  echo "跳过 dsh plugin remove（--no-cli）"
elif [ "$DRY" -eq 1 ]; then
  echo "  [dry-run] dsh plugin --profile $(basename "$PROFILE") remove $PKG"
else
  PROFILE_NAME=$(basename "$PROFILE")
  if command -v dsh >/dev/null 2>&1; then
    dsh plugin --profile "$PROFILE_NAME" remove "$PKG" >/dev/null 2>&1 \
      && echo "卸了 $PKG 包" \
      || echo "dsh plugin remove 没成功（本地包挡路 / profile 被独占 / 本来就没装）—— 继续，后面照收拾"
  else
    echo "这台机器上没有 dsh 命令 —— 跳过卸包，继续收拾文件"
  fi
fi
echo

# ── 4. 摘 bundles 那一行 ──
# 这是最容易漏、后果最难看的一步：包没了但那行还挂着 → 下次启动报错。
# 交给 setup.mjs（唯一知道包名和格式的地方），幂等，摘不到也不报错。
SETUP="$PROFILE/node_modules/$PKG/setup.mjs"
if [ -f "$SETUP" ]; then
  if [ "$DRY" -eq 1 ]; then
    echo "  [dry-run] node $SETUP --remove $PROFILE"
  else
    node "$SETUP" --remove "$PROFILE" || echo "  摘行失败 —— 手动看 $PROFILE/package.json 的 dsh.profile.bundles"
  fi
else
  # 包已经被 remove 掉了、setup.mjs 也就跟着没了。这种情况得自己摘。
  echo "包里找不到 setup.mjs（包可能已经删了）—— 直接改 JSON"
  if [ "$DRY" -eq 1 ]; then
    echo "  [dry-run] 从 $PROFILE/package.json 的 bundles 里摘掉 \"$PKG\""
  else
    node -e '
      const fs=require("fs");
      const p=process.argv[1], name=process.argv[2];
      const d=JSON.parse(fs.readFileSync(p,"utf8"));
      const b=d?.dsh?.profile?.bundles;
      if(!Array.isArray(b)){console.log("  没有 bundles 字段，跳过");process.exit(0)}
      if(!b.includes(name)){console.log("  bundles 里本来就没有，跳过");process.exit(0)}
      const bak=p+".bak-"+"'"$TS"'";
      fs.copyFileSync(p,bak);
      d.dsh.profile.bundles=b.filter(x=>x!==name);
      fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");
      console.log("  已摘掉，备份："+bak);
    ' "$PROFILE/package.json" "$PKG"
  fi
fi
echo

# ── 5. 删运行时 ──
# 这里有 config.json，里面有 48 位 secret。不删掉等于把“观测页口令”留在盘上。
#
# 🔴 2026-10-31：这个目录**是所有 profile 共用的一份**（$DSH_HOME/realheart，不按 profile 分）。
#    所以删之前必须先问一句：还有没有别的 profile 装着 realheart？
#    不问就删，就是「卸 A 把 B 一起弄坏」—— 这一天真的发生过：卸一个测试 profile，
#    把生产那台的观测页、口令、运行时全删了。
#
# 判据（不是猜）：扫 profiles/*/package.json 的 bundles，看还有谁写着 realheart。
#   有人用 → 不删，把是谁打出来
#   没人用 → 删（最后一个用它的已经卸了，口令不该留在盘上）
if [ -d "$RUNTIME_DIR" ]; then
  OTHER=""
  for pkg in "$DSH_HOME"/profiles/*/package.json; do
    [ -f "$pkg" ] || continue
    [ "$pkg" = "$PROFILE/package.json" ] && continue
    grep -q '"realheart"' "$pkg" 2>/dev/null && OTHER="$OTHER $(basename "$(dirname "$pkg")")"
  done
  if [ -n "$OTHER" ]; then
    echo "运行时目录先不删：还有别的 profile 在用它 ——$OTHER"
    echo "  （$RUNTIME_DIR 是所有 profile 共用的一份，删了它们会一起没观测页）"
    echo "  真要让它们都停：先把上面那几个也卸了，或者自己 rm -rf $RUNTIME_DIR"
  else
    run rm -rf "$RUNTIME_DIR"
    if [ "$DRY" -eq 1 ]; then
      echo "  ↑ 这一步删的是运行时目录（里面有 48 位口令 config.json）"
    else
      echo "删了运行时（含口令）：$RUNTIME_DIR"
    fi
  fi
else
  echo "没有运行时目录，跳过"
fi
echo

# ── 6. 她的东西：默认留着，且把位置打在屏幕上 ──
# 心情账本、pending 流水、改动记录、她自由时间写的东西都在这里。
# 删了不会重建 —— 那是唯一的副本，不是缓存。
if [ -d "$STATE_DIR" ]; then
  echo "她的东西还在（默认不删）：$STATE_DIR"
  ls -1 "$STATE_DIR" 2>/dev/null | sed 's/^/  /' || true
else
  echo "stateDir 不存在（$STATE_DIR）—— 没什么可留的"
fi
echo

if [ "$PURGE" -eq 1 ]; then
  # --purge 不许猜。删账本这条路上一旦猜错，删掉的是别人的东西，而且不可逆。
  if [ "$STATE_FROM" = '默认路径（猜的）' ]; then
    echo "--purge 拒绝执行：手里没有依据，不知道该删哪个目录。"
    echo "  运行时 config.json 已经不在了（多半是这脚本之前跑过一次），"
    echo "  现在只剩一个默认路径可猜 —— 而这个脚本不在「删账本」这件事上猜。"
    echo "  明说要删哪个：sh scripts/uninstall.sh --purge --state-dir <账本目录>"
    exit 1
  fi
  if [ ! -d "$STATE_DIR" ]; then
    echo "--purge：目录本来就不在，没什么可删"
  else
    echo "--purge：准备删 $STATE_DIR"
    echo "将要删除（这份清单是唯一的确认依据，看清楚再继续）："
    ls -1la "$STATE_DIR" 2>/dev/null | sed 's/^/  /' || true
    echo "  ↑ 这些删了就真没了。里面是她的账本，不是缓存。"
    if [ "$YES" -ne 1 ]; then
      if [ -t 0 ]; then
        printf '确认请输入 DELETE（别的大写小写都不算）：'
        read -r ANS
        [ "$ANS" = "DELETE" ] || { echo "没确认，什么都没删"; exit 1; }
      else
        echo "非交互环境，要真删必须显式加 --yes。什么都没删。"
        exit 1
      fi
    fi
    run rm -rf "$STATE_DIR"
    echo "已删：$STATE_DIR"
  fi
  echo
fi

if [ "$DRY" -eq 1 ]; then
  echo "== dry-run 结束，什么都没改 =="
  echo "确认没问题，去掉 --dry-run 再跑一次。"
  exit 0
fi

# ── 验收三条（判据，不是建议）──
echo "== 验收三条 =="
echo "  1. 观测页进程没了 —— 端口不该再有人听："
echo "       ss -lntp 2>/dev/null | grep 8098   # 没输出就是没了（端口按你的配置改）"
echo "  2. bundles 里没有 $PKG 那一行："
echo "       grep -n '$PKG' $PROFILE/package.json   # 只剩 .bak 里有，正文里没有"
echo "  3. 她的东西还在，位置对上："
echo "       ls $STATE_DIR"
echo
echo "三条全对才算卸干净。少一条都别当它卸完了 —— 反着来时，"
echo "它和『根本没装上』在她眼里长得一模一样。"
