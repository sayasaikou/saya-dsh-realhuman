#!/usr/bin/env node
/**
 * realheart 的命令行入口
 *
 *   npx realheart install --profile qqbot
 *
 * 为什么要这个：在这之前装它是两条命令 —— `dsh plugin add` 然后 `node setup.mjs`。
 * 第二条不是可选项（`dsh plugin` 只是 pnpm 的转发器，它不写 bundles），
 * 所以只要有人漏了第二条，看到的就是「装了、没报错、没反应」。
 * 一条命令的意义不是省一次敲键盘，是**不给漏的机会**。
 *
 * 它只做编排，逻辑不重写：
 *   - 装包：调 `dsh plugin add`
 *   - 加 bundles / 备份：调 setup.mjs（唯一知道包名和格式的地方）
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { readdir, copyFile, rm, stat, readFile } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { extractVersion, satisfies } from '../lib/version.mjs';
import { renderForgetEntry, inventoryOf, appendForget } from '../lib/forget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const PKG = 'realheart';
const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh');

function say(msg) {
  console.log(`[realheart] ${msg}`);
}
function fail(msg) {
  console.error(`[realheart] ${msg}`);
  process.exit(1);
}

function usage() {
  console.log(`realheart —— 给她一个能记账的心情层

用法：
  npx ${PKG} install [--profile <名字|路径>] [--dry-run]   装上
  npx ${PKG} doctor                                        自检：在不在工作 / 哪坏了 / 怎么修
  npx ${PKG} off | on                                      总开关（停 / 恢复，都要重启才生效）
  npx ${PKG} export [--state-dir <目录>] [--out <目录>]      把账本原文导出来
  npx ${PKG} wipe   --state-dir <目录> [--yes] [--why "…"]   删整份账本（要先给目录，再确认）
  npx ${PKG} forget --path <文件或目录> --why "…" [--yes]    删单个产物（留标记）

选项：
  --profile    装到哪个 profile。省掉就用当前目录（当前目录得正好是 profile）
  --dry-run    只说要做什么，不动手
  --state-dir  账本目录。不给就试着从运行时 config.json 读；读不到时**不猜**，直接让你给
  --out        导出的目标目录
  --path       要删的东西（只能是账本目录或 work/pieces 底下的）
  --why        为什么删。会写进 forget-log.md —— 不写就留「（没写）」，但那是个洞
  --yes        非交互环境里表示「确实要删/要做」

几个规矩：
  · 一个文件管全停：off 建 $DSH_HOME/realheart/DISABLED，apply 一看到它就不做任何事。
    它比改配置可靠 —— 改配置要动 profile 的 YAML（热改会打断正在说话的会话）。
  · export 出来的是**原文**，给出去之前自己先看一眼。
  · wipe 不会猜目录，也不会不问就删。

想卸整个插件：sh scripts/uninstall.sh --profile <名字> --dry-run 先看一眼。`);
}

async function doctor() {
  const { runDoctor, formatDoctor } = await import('../lib/doctor.mjs');
  const r = await runDoctor({ dshHome: DSH_HOME });
  console.log('');
  console.log(`realheart doctor · DSH_HOME=${DSH_HOME}`);
  console.log('');
  console.log(formatDoctor(r));
  // 有 FAIL 就非零退出 —— 这样脚本里可以直接 if npx realheart doctor; then ...
  process.exit(r.summary.fail ? 1 : 0);
}

/** 三个来源：显式路径 → profile 名字 → 当前目录。不猜。 */
function resolveProfile(arg) {
  if (!arg) {
    if (existsSync(join(process.cwd(), 'package.json'))) return process.cwd();
    fail('没给 --profile，当前目录也不是 profile。用 --profile <名字> 或在 profile 目录里跑。');
  }
  if (arg.includes('/') || arg.includes('\\')) return resolve(arg);
  return join(DSH_HOME, 'profiles', arg);
}

function dshVersion() {
  // Windows 下 dsh 是 .cmd，只能经 shell 起；经 shell 时别同时传 args 数组
  // （Node 会警告「args 未转义」—— 那个警告是对的，不该当噪声压掉，该改成不带 args）。
  const r = process.platform === 'win32'
    ? spawnSync('dsh --version', { encoding: 'utf8', shell: true })
    : spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return '';
  return extractVersion(`${r.stdout ?? ''}${r.stderr ?? ''}`);
}

/**
 * engines 校验。
 *
 * 写在 package.json 里的 `engines.dsh` 只是个声明 —— 装的时候没人看它。
 * 宿主版本低于要求的表现是**加载失败或者行为不对**，而且报错看不懂。
 * 所以这里主动问一次宿主版本，对不上就说清楚。
 *
 * ⚠️ **不拦**：拿不到版本（没有 dsh 命令 / 输出格式变了）时只说一句「没法确认」。
 * 拦下来就是把「我不知道」变成「你不许装」，那是两件事。
 */
function checkEngines() {
  const want = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))?.engines?.dsh;
  if (!want) return;
  const got = dshVersion();
  if (!got) {
    say(`宿主版本没法确认（没拿到 dsh --version 的输出）。这个包要求 dsh ${want}，自己核一下。`);
    return;
  }
  const ok = satisfies(got, want);
  if (ok === false) {
    say(`⚠ 宿主是 dsh ${got}，这个包要求 ${want} —— 版本低了。`);
    say('  装上可能加载失败，或者行为不对。先升 dsh 再装，或者装完不行就回滚。');
  } else if (ok === true) {
    say(`宿主 dsh ${got}，满足要求 ${want}`);
  } else {
    say(`宿主 dsh ${got}，要求 ${want} 这种写法我认不出来，自己核一下。`);
  }
}

function install(opts) {
  const profileDir = resolveProfile(opts.profile);
  if (!existsSync(join(profileDir, 'package.json'))) {
    fail(`那个目录里没有 package.json：${profileDir}\n（profile 名字写错了，或者这个 profile 还没建过）`);
  }
  const profileName = profileDir.split(/[\\/]/).filter(Boolean).pop();
  // Windows 上调 dsh 得经过 shell（dsh 是 .cmd，Node 从 18.20 起不允许直接 spawn .bat/.cmd）。
  // 经 shell 就意味着参数会被拼接，所以名字必须干净 —— 只允许目录名里正常存在的字符。
  if (!/^[A-Za-z0-9._-]+$/.test(profileName)) {
    fail(`profile 目录名里有不安全的字符，不敢拼进命令行：${profileName}\n（名字里带空格/引号/符号的，请把 dsh plugin add 手动跑一次，再用 --profile 跑这个脚本）`);
  }
  say(`profile：${profileDir}`);
  if (!opts.dryRun) checkEngines();

  // ① 包本身。已经装过就跳过 —— 这一步重复跑的代价是几十秒的 pnpm 解析，不是错误。
  const installed = existsSync(join(profileDir, 'node_modules', PKG, 'package.json'));
  if (installed) {
    say(`包已经在 node_modules 里了，跳过 add`);
  } else if (opts.dryRun) {
    say(`[dry-run] dsh plugin --profile ${profileName} add ${PKG}`);
  } else {
    if (!dshVersion()) {
      // 没有 dsh CLI 不等于装不了 —— 但那两条替代路径得说清楚，不然人卡在这儿。
      fail(`这台机器上没有 dsh 命令，装不了包。
两条替代路径（README「云端部署」有前因后果）：
  a) 有 dsh 但不在 PATH：把 dsh 放进 PATH 再跑一次
  b) 直接铺：cp -a <包目录> ${join(profileDir, 'node_modules', PKG)}
     然后 node ${join(profileDir, 'node_modules', PKG, 'setup.mjs')} ${profileDir}`);
    }
    say(`dsh plugin --profile ${profileName} add ${PKG} ……`);
    const line = `dsh plugin --profile ${profileName} add ${PKG}`;
    const r = process.platform === 'win32'
      ? spawnSync(line, { cwd: profileDir, stdio: 'inherit', shell: true })
      : spawnSync('dsh', ['plugin', '--profile', profileName, 'add', PKG], { cwd: profileDir, stdio: 'inherit' });
    if (r.status !== 0) {
      // 这一步失败不该把整件事判死：最常见的两种失败都跟包本身无关
      // （本地包挡路的 404、profile 被桌面端独占），而 bundles 那一步照样得做完。
      say('add 没成功。两种常见原因，跟这个包无关：');
      say('  ① 报 404 + “No authorization header” —— 不是认证问题，是这棵依赖树里有本地包，pnpm 重新解析时撞上了');
      say(`  ② profile 被桌面端独占 —— 那时 CLI 连不上，只能手动铺：cp -a <包目录> ${join(profileDir, 'node_modules', PKG)}`);
      say('继续做下一件（bundles）—— 它才是「装了没反应」的真正原因。');
    }
  }

  // ② bundles。这一步没有「失败就算了」这一说：漏了它整件事等于没做。
  const setup = join(PKG_ROOT, 'setup.mjs');
  if (!existsSync(setup)) fail(`包里找不到 setup.mjs：${setup}`);
  const args = [setup, profileDir];
  if (opts.dryRun) args.push('--dry-run');
  const r2 = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r2.status !== 0) fail('往 bundles 里写失败 —— 上面有原因。这一步没做成，装了也没有任何行为变化。');

  if (opts.dryRun) {
    say('[dry-run] 到此为止，什么都没改。');
    return;
  }

  // ③ 装完之后先干什么。用户大概率不看 README，这四句就是他能拿到的全部指引。
  //    免责那两条紧跟在后面 —— 不是法律条款，是「装上之后你会发现什么」。
  console.log('');
  say('装好了。接着做这四件：');
  say('  1. 重启 dsh —— 配置不热生效（重启会打断正在说话的会话，挑个没人用的时候）');
  say('  2. 重启后先验一条：日志里出现 rh_mood / rh_pending / rh_control / rh_changes 已注册');
  say('  3. 头一周只开观测：把 injectMood 设成 false，先看它记了什么，别急着让它影响说话');
  say('  4. 出事一条命令退：sh scripts/uninstall.sh --profile ' + profileName + ' --dry-run');
  console.log('');
  say('三件得先说清楚：');
  say('  · 适用范围：只推荐私聊与少数固定人员。群聊没做深，效果和后果不作保证。');
  say('  · 它每轮都会往系统提示里塞状态（花 token）；账本只记她自己写的短句和事件 id，不抄对话原文。');
  say('  · 它只注入状态，不注入人格 —— 人格是装它的人的责任，它不替那份人格担保。');
  say('随时自检：npx realheart doctor');
}

// ── 总开关（P-3 kill switch）──
//
// 一个文件管全停。为什么不是「改配置里的 enabled」：改配置要么动 profile 的 YAML
// （热改会整份重挂，正在说话的会话被打断），要么指望宿主把配置正确传进来。
// 「一条命令全停」不该依赖任何一层能不能传对。
const KILL = join(DSH_HOME, 'realheart', 'DISABLED');

function switchOff() {
  mkdirSync(dirname(KILL), { recursive: true });
  writeFileSync(KILL, `${new Date().toISOString()} 由 realheart off 停用\n`, 'utf8');
  say(`已停用：建了 ${KILL}`);
  say('不注入、不记账、四个工具都不注册。');
  say('⚠️ 重启 dsh 之后才生效（apply 只在启动时跑一次）—— 重启会打断正在说话的会话。');
}

function switchOn() {
  if (!existsSync(KILL)) {
    say('本来就是开着的（没有 DISABLED 文件）');
    return;
  }
  unlinkSync(KILL);
  say(`已恢复：删了 ${KILL}。同样要重启才生效。`);
}

/** 账本目录：只认运行时 config.json。不猜 —— 猜错会读/删别人的东西。 */
async function resolveStateDir(opts) {
  if (opts.stateDir) return opts.stateDir;
  const cfgPath = join(DSH_HOME, 'realheart', 'runtime', 'config.json');
  if (!existsSync(cfgPath)) return '';
  try {
    const c = JSON.parse(await readFileSync(cfgPath, 'utf8'));
    return c.stateDir || '';
  } catch {
    return '';
  }
}

/** 她那台机器上的根（pieces 在它下面）。同样只认运行时 config.json。 */
async function resolveRoot() {
  const cfgPath = join(DSH_HOME, 'realheart', 'runtime', 'config.json');
  if (!existsSync(cfgPath)) return '';
  try {
    return JSON.parse(await readFile(cfgPath, 'utf8')).root || '';
  } catch {
    return '';
  }
}
const DATA_RE = /\.(jsonl|md|log|txt)$/;

// ── 数据主权（P-3）──
async function exportData(opts) {
  const stateDir = await resolveStateDir(opts);
  if (!stateDir || !existsSync(stateDir)) {
    fail(`不知道账本在哪（既没给 --state-dir，运行时 config.json 里也没有）。\n  试用：npx realheart export --state-dir <账本目录> --out <目标目录>`);
  }
  const out = opts.out || join(process.cwd(), `realheart-export-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  let n = 0;
  for (const f of await readdir(stateDir)) {
    if (!DATA_RE.test(f)) continue;
    await copyFile(join(stateDir, f), join(out, f));
    n += 1;
  }
  say(`导出 ${n} 个文件：${stateDir} → ${out}`);
  say('里面是**原文**。给出去之前自己先看一眼 —— 那是她写过的话，不是日志。');
}

async function wipe(opts) {
  const stateDir = await resolveStateDir(opts);
  if (!stateDir) {
    // 删账本这条路上不猜。和 uninstall.sh --purge 同一条规矩。
    fail('不知道账本在哪，拒绝执行。明说：npx realheart wipe --state-dir <账本目录>');
  }
  if (!existsSync(stateDir)) {
    say(`目录不存在（${stateDir}），没什么可删`);
    return;
  }
  const files = await readdir(stateDir);
  console.log(`[realheart] 将要删除 ${stateDir} 下的这些（这是唯一的确认依据）：`);
  for (const f of files) {
    let size = '?';
    try {
      size = `${(await stat(join(stateDir, f))).size} B`;
    } catch {
      /* 读不到就不报大小 */
    }
    console.log(`  ${f}  (${size})`);
  }
  say('删了就真没了 —— 里面是她的账本，不是缓存。');
  if (!opts.yes) {
    if (process.stdin.isTTY) fail('没确认，什么都没删。加 --yes 表示你确实要删');
    fail('非交互环境，要真删必须加 --yes。什么都没删');
  }
  // 先留标记，再删。顺序反了就自相矛盾 —— 标记写在被删的东西里，删完一起没了。
  const entry = renderForgetEntry({
    at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    scope: '整份账本',
    target: stateDir,
    inventory: await inventoryOf(stateDir),
    why: opts.why,
    by: `命令行 realheart wipe（${os.hostname()}）`,
  });
  const logPath = await appendForget(DSH_HOME, entry);
  say(`标记写在 ${logPath}（在被删的东西之外）`);
  await rm(stateDir, { recursive: true, force: true });
  say(`已删：${stateDir}`);
}

/**
 * 删单个产物 / 单个文件 —— 这就是 M1-9 定案里「人是唯一能删的那一方」的入口。
 *
 * 两条硬边界：
 *   ① 只允许删账本目录和 `work/pieces` 底下的东西，别的一律拒绝；
 *   ② 删之前必须写下标记（写在被删内容之外），写不上就不删。
 *
 * 她的四个工具里**没有**删除动作 —— 记账的人不能同时握毁账的权。
 */
async function forget(opts) {
  if (!opts.path) {
    fail('要删什么？用 --path <文件或目录> 指出来，再加 --why "为什么"');
  }
  const stateDir = await resolveStateDir(opts);
  const root = await resolveRoot();
  const allowed = [stateDir, root ? join(root, 'work', 'pieces') : ''].filter(Boolean);
  if (!allowed.length) {
    fail('既不知道账本目录也不知道 pieces 在哪 —— 明说 --state-dir，别让它猜');
  }
  const target = resolve(opts.path);
  const inside = allowed.some((dir) => {
    const rel = relative(resolve(dir), target);
    return rel && !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!inside) {
    fail(`拒绝：${target} 不在允许删除的范围内。\n只允许删：${allowed.join('\n        ')}\n（这条边界是硬的 —— 一个能删任意路径的入口，等于把整台机器交出去）`);
  }
  if (!existsSync(target)) {
    say(`不存在：${target}，没什么可删`);
    return;
  }
  const inv = await inventoryOf(target);
  say(`将要删除：${target}`);
  say(`内容：${inv}`);
  say('删了就真没了。这不是缓存。');
  if (!opts.yes) {
    if (process.stdin.isTTY) fail('没确认，什么都没删。加 --yes 表示你确实要删');
    fail('非交互环境，要真删必须加 --yes。什么都没删');
  }
  const entry = renderForgetEntry({
    at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    scope: '',
    target,
    inventory: inv,
    why: opts.why,
    by: `命令行 realheart forget（${os.hostname()}）`,
  });
  const logPath = await appendForget(DSH_HOME, entry);
  say(`标记写在 ${logPath}（在被删的东西之外）`);
  await rm(target, { recursive: true, force: true });
  say(`已删：${target}`);
}

const argv = process.argv.slice(2);
const opts = { profile: '', dryRun: false, stateDir: '', out: '', yes: false, path: '', why: '' };
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--yes') opts.yes = true;
  else if (a === '--profile') opts.profile = argv[++i] ?? '';
  else if (a === '--state-dir') opts.stateDir = argv[++i] ?? '';
  else if (a === '--out') opts.out = argv[++i] ?? '';
  else if (a === '--path') opts.path = argv[++i] ?? '';
  else if (a === '--why') opts.why = argv[++i] ?? '';
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.startsWith('--profile=')) opts.profile = a.slice('--profile='.length);
  else if (a.startsWith('--state-dir=')) opts.stateDir = a.slice('--state-dir='.length);
  else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
  else if (a.startsWith('--path=')) opts.path = a.slice('--path='.length);
  else if (a.startsWith('--why=')) opts.why = a.slice('--why='.length);
  else rest.push(a);
}

const cmd = rest[0] || 'install';
if (cmd === 'install') install(opts);
else if (cmd === 'doctor') doctor();
else if (cmd === 'off') switchOff();
else if (cmd === 'on') switchOn();
else if (cmd === 'export') await exportData(opts);
else if (cmd === 'wipe') await wipe(opts);
else if (cmd === 'forget') await forget(opts);
else if (cmd === 'help') usage();
else {
  console.error(`[realheart] 不认识这个子命令：${cmd}`);
  usage();
  process.exit(1);
}
