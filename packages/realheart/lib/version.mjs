/**
 * 版本比较（只为 engines 校验服务，不追求完整 semver）
 *
 * 为什么自己写：包里只有一个需要比较的地方（`engines.dsh`），
 * 为它引一个依赖不值得 —— 而且依赖越多，装的时候出错的面越大。
 *
 * 支持的就一种范围写法：`>=x.y.z`（可以带 `-pre`），这也是 dsh 插件约定的写法。
 * 别的写法一律当「不知道」，返回 null —— **不知道就不拦**，不拿猜测去阻止人装东西。
 *
 * 已知不准的地方（够用就不修，写下来免得以后被当成 bug 查）：
 * 预发布标识之间按字符串比，所以 `-rc.10` 会被当成比 `-rc.9` 小。
 * dsh 的 prerelease 目前是 `-0` / `-rc.N` 这种，撞不上这个坑。
 */

function split(v) {
  const s = String(v ?? '').trim().replace(/^v/, '');
  const [main, pre = ''] = s.split('-');
  const nums = main.split('.').map((x) => Number.parseInt(x, 10));
  if (nums.some((n) => Number.isNaN(n))) return null;
  while (nums.length < 3) nums.push(0);
  return { nums: nums.slice(0, 3), pre };
}

/** a<b 返回 -1，相等 0，a>b 返回 1。任一侧解析不了返回 null。 */
export function compareVersions(a, b) {
  const A = split(a);
  const B = split(b);
  if (!A || !B) return null;
  for (let i = 0; i < 3; i += 1) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  // 主版本相同时：带预发布标识的比正式版小（0.2.1-0 < 0.2.1）
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre === B.pre) return 0;
  return A.pre < B.pre ? -1 : 1;
}

/** 从一段乱七八糟的输出里抠出版本号（`dsh --version` 的格式不保证）。 */
export function extractVersion(text) {
  const m = String(text ?? '').match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return m ? m[1] : '';
}

/**
 * true / false / null（不知道）。
 * null 的用法：调用方**不要**因为 null 就拦下安装，只提示一句「没法确认」。
 */
export function satisfies(version, range) {
  const r = String(range ?? '').trim();
  const m = r.match(/^(>=|>|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/);
  if (!m || !version) return null;
  const op = m[1] || '>=';
  const c = compareVersions(version, m[2]);
  if (c === null) return null;
  if (op === '>=') return c >= 0;
  if (op === '>') return c > 0;
  return c === 0;
}
