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

import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

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
  npx ${PKG} install [--profile <名字|路径>] [--dry-run]
  npx ${PKG} doctor
  node node_modules/${PKG}/bin/${PKG}.mjs install --profile qqbot

选项：
  --profile   装到哪个 profile。省掉就用当前目录（当前目录得正好是 profile）
  --dry-run   只说要做什么，不动手

doctor：一条命令回答「在不在工作 / 哪坏了 / 怎么修」。只读，不改任何东西。

装完之后：重启 dsh。想卸：sh scripts/uninstall.sh --profile <名字>`);
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

function hasDsh() {
  // Windows 下 dsh 是 .cmd，只能经 shell 起；经 shell 时别同时传 args 数组
  // （Node 会警告「args 未转义」—— 那个警告是对的，不该当噪声压掉，该改成不带 args）。
  const r = process.platform === 'win32'
    ? spawnSync('dsh --version', { stdio: 'ignore', shell: true })
    : spawnSync('dsh', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
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

  // ① 包本身。已经装过就跳过 —— 这一步重复跑的代价是几十秒的 pnpm 解析，不是错误。
  const installed = existsSync(join(profileDir, 'node_modules', PKG, 'package.json'));
  if (installed) {
    say(`包已经在 node_modules 里了，跳过 add`);
  } else if (opts.dryRun) {
    say(`[dry-run] dsh plugin --profile ${profileName} add ${PKG}`);
  } else {
    if (!hasDsh()) {
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
  console.log('');
  say('装好了。接着做这四件：');
  say('  1. 重启 dsh —— 配置不热生效（重启会打断正在说话的会话，挑个没人用的时候）');
  say('  2. 重启后先验一条：日志里出现 rh_mood / rh_pending / rh_control / rh_changes 已注册');
  say('  3. 头一周只开观测：把 injectMood 设成 false，先看它记了什么，别急着让它影响说话');
  say('  4. 出事一条命令退：sh scripts/uninstall.sh --profile ' + profileName + ' --dry-run');
}

const argv = process.argv.slice(2);
const opts = { profile: '', dryRun: false };
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--profile') opts.profile = argv[++i] ?? '';
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.startsWith('--profile=')) opts.profile = a.slice('--profile='.length);
  else rest.push(a);
}

const cmd = rest[0] || 'install';
if (cmd === 'install') install(opts);
else if (cmd === 'doctor') doctor();
else if (cmd === 'help') usage();
else {
  console.error(`[realheart] 不认识这个子命令：${cmd}`);
  usage();
  process.exit(1);
}
