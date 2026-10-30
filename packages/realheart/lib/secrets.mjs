/**
 * 口令相关的三件小事
 *
 * 为什么单独一份：口令泄漏这件事，靠「记得别打出来」是守不住的 ——
 * 日志会被贴进 issue、聊天、截图里，而写日志的人通常不觉得自己在泄漏。
 * 所以要有一个地方把规则写成代码，再有测试盯着它。
 *
 * 三条规矩：
 *   ① 日志、报错、工具返回里，**不出现口令原文** —— 一律 `<口令>`；
 *   ② 想看页面的人自己从 `runtime/config.json` 取（README 写了在哪）；
 *   ③ 这条规矩本身要有测试，否则它只是注释。
 */

/** 48 位十六进制。secret 是 randomBytes(24).toString('hex')，但允许更短的被误伤。 */
const SECRET_RE = /[0-9a-f]{24,}/g;

/** 把任何文本里的口令换成占位符。不是给日志用的，是给「一切会被复制走的地方」用的。 */
export function maskSecret(text) {
  return String(text ?? '').replace(SECRET_RE, '<口令>');
}

/**
 * 观测页地址的那一行。
 *
 * 为什么不直接给完整地址：地址里带着口令，而这一行一定会进日志。
 * 进了日志就等于进了「以后可能被贴出去的所有地方」。
 */
export function pageHint(port) {
  return `http://127.0.0.1:${port}/<口令>/`;
}

/** 口令在哪儿取 —— 每次打地址都跟着这一句，省得人去翻源码。 */
export function whereSecret(configPath) {
  return `口令在 ${configPath} 的 secret 字段（别贴进聊天/issue/截图）`;
}

/**
 * 自检：这段文本里不该出现 secret。
 * 返回命中的地方，空数组＝干净。
 *
 * 用法（测试和 doctor 都用得上）：
 *   assert.deepEqual(findSecretLeak(logText, secret), [])
 */
export function findSecretLeak(text, secret) {
  const s = String(text ?? '');
  const needle = String(secret ?? '');
  if (!needle) return [];
  const hits = [];
  let i = s.indexOf(needle);
  while (i !== -1) {
    const from = Math.max(0, i - 20);
    hits.push(s.slice(from, i + needle.length + 6));
    i = s.indexOf(needle, i + needle.length);
  }
  return hits;
}
