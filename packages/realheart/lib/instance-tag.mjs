/**
 * 实例标识：多个 dsh 实例共跑时，分清「这份取证是谁写的」。
 *
 * 为什么需要：`last-inject.md` 原来按「只有一个实例」写 —— 后起的实例一覆盖，
 * 上一个实例那一轮「她到底看到什么」就没了。2026-10-31 云端实测撞到：
 * 主实例 qqbot 与临时起的 rh2 共用一份账本，`last-inject.md` 从 1019 字节被改成 782。
 *
 * 标识从宿主的 `--profile` 取 —— 插件跑在宿主进程里，`process.argv` 就是宿主的。
 * 取不到就叫 `default`，不猜。
 */

import { join } from 'node:path';

/** 只允许这种字符 —— 标识会拼进文件名，不能让它带路径分隔符或 `..` */
const SAFE = /^[A-Za-z0-9._-]+$/;

/**
 * @param {string[]} argv 宿主进程的 argv
 * @returns {string} profile 名；无法确定时 'default'
 */
export function instanceTagFrom(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--profile' || a === '-p') {
      const v = list[i + 1];
      return v && SAFE.test(v) ? v : 'default';
    }
    if (a.startsWith('--profile=')) {
      const v = a.slice('--profile='.length);
      return v && SAFE.test(v) ? v : 'default';
    }
  }
  return 'default';
}

/**
 * 注入原文的两个落点：
 *   - latest：永远是最新的那一份（跟以前一样，doctor 和页面读它）
 *   - perInstance：这一份只归这个实例写，别的实例碰不到
 *
 * 两个都写。只写 perInstance 会让原有读 `last-inject.md` 的地方一下子读空；
 * 只写 latest 就是现在的 bug。
 *
 * @param {string} stateDir 账本目录
 * @param {string} tag instanceTagFrom() 的结果
 */
export function lastInjectPaths(stateDir, tag) {
  const safe = typeof tag === 'string' && SAFE.test(tag) ? tag : 'default';
  return {
    latest: join(stateDir, 'last-inject.md'),
    perInstance: join(stateDir, `last-inject.${safe}.md`),
  };
}
