/**
 * 「口令不进日志」的自检
 *
 * 这条规矩靠注释是守不住的 —— 写日志的人当时不觉得自己在泄漏。
 * 所以它得有两半：一半是打码的函数，一半是**能抓住泄漏的检查**。
 * 这个文件就是那另一半：故意把口令塞进各种地方，看能不能被抓出来。
 *
 * 对应清单 P-4「口令不进日志 —— 配自检脚本；故意往错误分支塞口令，能被抓出来」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret, pageHint, whereSecret, findSecretLeak } from '../lib/secrets.mjs';

// 真的 secret 是 randomBytes(24).toString('hex')，48 位
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

test('打码：地址里的口令变成 <口令>', () => {
  const url = `http://127.0.0.1:8098/${SECRET}/`;
  const masked = maskSecret(url);
  assert.equal(masked, 'http://127.0.0.1:8098/<口令>/');
  assert.deepEqual(findSecretLeak(masked, SECRET), []);
});

test('打码：一行里出现两次也要全打掉', () => {
  const line = `开 ${SECRET} 然后又说了一遍 ${SECRET}`;
  assert.equal((maskSecret(line).match(/<口令>/g) || []).length, 2);
});

test('地址提示本身就不含口令（不是「打了码才安全」，是本来就没有）', () => {
  const hint = pageHint(8098);
  assert.ok(!hint.includes(SECRET));
  assert.match(hint, /<口令>/);
});

test('取口令那句话里给的是路径，不是口令', () => {
  const line = whereSecret('/home/x/.dsh/realheart/runtime/config.json');
  assert.ok(line.includes('config.json'));
  assert.match(line, /别贴进/);
});

test('自检真能抓住泄漏 —— 故意塞进去的三处都要被点名', () => {
  const leaky = [
    `观测页：http://127.0.0.1:8098/${SECRET}/`,
    `spawn 失败 secret=${SECRET}`,
    `工具返回里带了 ${SECRET}`,
  ].join('\n');
  const hits = findSecretLeak(leaky, SECRET);
  assert.equal(hits.length, 3, '有三处泄漏，只抓到一处就是自检本身不可靠');
});

test('自检不会冤枉正常日志（没有口令就返回空）', () => {
  const clean = [
    '观测页：http://127.0.0.1:8098/<口令>/',
    '事件索引 12 条（native 3 / audit 9）',
    '配置有 2 处不对，拒绝启动',
  ].join('\n');
  assert.deepEqual(findSecretLeak(clean, SECRET), []);
});

test('空 secret 不算泄漏（否则「没配口令」会被误报成泄漏）', () => {
  assert.deepEqual(findSecretLeak('随便写点什么', ''), []);
});

test('16 位短串不该被打码误伤（正常 id 可能就那么长）', () => {
  // 只有 24 位以上才认作口令；短 id 打了码反而看不清日志
  assert.equal(maskSecret('id=deadbeefcafe1234'), 'id=deadbeefcafe1234');
});
