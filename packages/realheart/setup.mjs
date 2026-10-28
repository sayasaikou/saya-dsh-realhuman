#!/usr/bin/env node
/**
 * realheart 装配脚本
 *
 * 为什么需要它：`dsh plugin add` 只是 pnpm 的转发器（`dsh plugin --help` 自己写的），
 * 装完**不会**把包名加进 profile 的 `dsh.profile.bundles`。
 * 不在那个列表里，插件自带的 cordis.patch.yml 就不会被应用 ——
 * 表现是"装了、没报错、一点反应没有"，这是排查里最容易浪费时间的一种。
 *
 * 用法：
 *   node node_modules/realheart/setup.mjs                    # 当前目录的 profile
 *   node node_modules/realheart/setup.mjs ~/.dsh/profiles/xx # 指定 profile
 *
 * 安全边界：只改带 `dsh.profile` 字段的 package.json。改到别的文件上比不改更糟。
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const PKG = 'realheart';

function fail(msg) {
  console.error(`[realheart] ${msg}`);
  process.exit(1);
}

const dir = resolve(process.argv[2] || process.env.INIT_CWD || process.cwd());
const pkgPath = join(dir, 'package.json');

if (!existsSync(pkgPath)) {
  fail(`这个目录里没有 package.json：${dir}\n（应该在 dsh profile 目录里跑，或者把路径当参数传进来）`);
}

let data;
try {
  data = JSON.parse(await readFile(pkgPath, 'utf8'));
} catch (err) {
  fail(`package.json 解析失败：${err?.message ?? err}`);
}

if (!data?.dsh?.profile) {
  fail(`${pkgPath} 里没有 dsh.profile —— 这看起来不是个 dsh profile 目录，不动它。`);
}

data.dsh.profile.bundles = Array.isArray(data.dsh.profile.bundles) ? data.dsh.profile.bundles : [];

if (data.dsh.profile.bundles.includes(PKG)) {
  console.log(`[realheart] 已经在 bundles 里了：${pkgPath}`);
} else {
  data.dsh.profile.bundles.push(PKG);
  await writeFile(pkgPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`[realheart] 已加进 bundles：${pkgPath}`);
}

console.log('[realheart] 重启 dsh 生效。装好之后第一次启动会打印三条前提，只打一次。');

// ── 依赖自检（2026-10-28 加）──
//
// 为什么放进装配脚本，而不是只写在 README 里：
// 缺 zstd 的后果是**静默的** —— 页面照常开、心情照常记，只有「他说的话」那一路永远空着。
// 这种事不能靠人记得去查文档，得在装的那一刻当面说出来。
// 缺了不挡安装：插件本体（工具 + 注入）不依赖这两样。
function has(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const py = has('python3', ['-V']);
const zstd = has('zstd', ['--version']);
console.log(`[realheart] 依赖自检：python3 ${py ? '有' : '缺'} · zstd ${zstd ? '有' : '缺'}`);
if (!py) console.log('[realheart]   没有 python3 ⇒ 观测页起不来（她自己的工具和每轮注入照常工作）');
if (!zstd) {
  console.log('[realheart]   没有 zstd ⇒ 观测页里「他说的话」那一路全空。');
  console.log('[realheart]   注意这个是静默的：页面照常显示、不报错。装：apt install zstd / pacman -S zstd / brew install zstd');
}
