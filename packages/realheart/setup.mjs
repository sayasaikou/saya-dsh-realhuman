#!/usr/bin/env node
/**
 * realheart 装配脚本（也负责摘下来）
 *
 * 为什么需要它：`dsh plugin add` 只是 pnpm 的转发器（`dsh plugin --help` 自己写的），
 * 装完**不会**把包名加进 profile 的 `dsh.profile.bundles`。
 * 不在那个列表里，插件自带的 cordis.patch.yml 就不会被应用 ——
 * 表现是"装了、没报错、一点反应没有"，这是排查里最容易浪费时间的一种。
 *
 * 卸的时候同一个坑反着来：`dsh plugin remove` 把包删了，那行**可能还挂着**。
 * 挂着但包不在 → 启动时报一个看不懂的错。所以摘行也得有个正经入口，
 * 不能靠人记得去手改 JSON。
 *
 * 用法：
 *   node node_modules/realheart/setup.mjs                     # 加进当前目录的 profile
 *   node node_modules/realheart/setup.mjs ~/.dsh/profiles/xx  # 指定 profile
 *   node node_modules/realheart/setup.mjs --remove <profile>   # 从 bundles 摘掉
 *
 * 选项：
 *   --remove   摘掉，不是装上
 *   --dry-run  只打印要做什么，一个字节都不写
 *
 * 安全边界：只改带 `dsh.profile` 字段的 package.json。改到别的文件上比不改更糟。
 * 写之前一定先备份 —— 「改一次配置多一个 .bak」是发布判据之一，不能靠人工记得。
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const PKG = 'realheart';

function fail(msg) {
  console.error(`[realheart] ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const REMOVE = args.includes('--remove');
const DRY = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('--'));

const dir = resolve(positional[0] || process.env.INIT_CWD || process.cwd());
const pkgPath = join(dir, 'package.json');

if (!existsSync(pkgPath)) {
  fail(`这个目录里没有 package.json：${dir}\n（应该在 dsh profile 目录里跑，或者把路径当参数传进来）`);
}

let data;
let raw;
try {
  raw = await readFile(pkgPath, 'utf8');
  data = JSON.parse(raw);
} catch (err) {
  fail(`package.json 解析失败：${err?.message ?? err}`);
}

if (!data?.dsh?.profile) {
  fail(`${pkgPath} 里没有 dsh.profile —— 这看起来不是个 dsh profile 目录，不动它。`);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261030-140349
const bakPath = `${pkgPath}.bak-${stamp}`;

data.dsh.profile.bundles = Array.isArray(data.dsh.profile.bundles) ? data.dsh.profile.bundles : [];
const has = data.dsh.profile.bundles.includes(PKG);

/** 写回。只在真的要改的时候调用，且一定先备份。 */
async function commit(note) {
  if (DRY) {
    console.log(`[realheart] [dry-run] 会写 ${pkgPath}（${note}），备份到 ${bakPath}`);
    return;
  }
  await copyFile(pkgPath, bakPath);
  await writeFile(pkgPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`[realheart] ${note}：${pkgPath}`);
  console.log(`[realheart] 原文件已备份：${bakPath}`);
}

if (REMOVE) {
  if (!has) {
    console.log(`[realheart] bundles 里本来就没有 ${PKG}，不用摘：${pkgPath}`);
  } else {
    data.dsh.profile.bundles = data.dsh.profile.bundles.filter((x) => x !== PKG);
    await commit(`已从 bundles 摘掉 ${PKG}`);
  }
} else {
  if (has) {
    console.log(`[realheart] 已经在 bundles 里了：${pkgPath}`);
  } else {
    data.dsh.profile.bundles.push(PKG);
    await commit(`已加进 bundles`);
  }
  if (DRY) {
    console.log('[realheart] [dry-run] 什么都没写。真跑的话这一步之后要重启 dsh 才生效。');
  } else {
    console.log('[realheart] 重启 dsh 生效。装好之后第一次启动会打印三条前提，只打一次。');
  }
}

// ── 依赖自检（2026-10-28 加）──
//
// 为什么放进装配脚本，而不是只写在 README 里：
// 缺 zstd 的后果是**静默的** —— 页面照常开、心情照常记，只有「他说的话」那一路永远空着。
// 这种事不能靠人记得去查文档，得在装的那一刻当面说出来。
// 缺了不挡安装：插件本体（工具 + 注入）不依赖这两样。
//
// 卸的时候不查 —— 卸载不需要 python，别在拆东西的时候拦一道无用的检查。
if (!REMOVE) {
  function has2(cmd, argv) {
    try {
      execFileSync(cmd, argv, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  const py = has2('python3', ['-V']);
  const zstd = has2('zstd', ['--version']);
  console.log(`[realheart] 依赖自检：python3 ${py ? '有' : '缺'} · zstd ${zstd ? '有' : '缺'}`);
  if (!py) console.log('[realheart]   没有 python3 ⇒ 观测页起不来（她自己的工具和每轮注入照常工作）');
  if (!zstd) {
    console.log('[realheart]   没有 zstd ⇒ 观测页里「他说的话」那一路全空。');
    console.log('[realheart]   注意这个是静默的：页面照常显示、不报错。装：apt install zstd / pacman -S zstd / brew install zstd');
  }
}
