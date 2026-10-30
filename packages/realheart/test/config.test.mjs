/**
 * 配置校验的测试
 *
 * 这一份测的不是「心情记不记得住」，是**写错配置时会怎样**。
 * 配置错的表现是「起不来」，起不来就没法在跑着的 dsh 里测 —— 所以只能在这里测。
 *
 * 判据（清单 T0-③）：写个非法端口 → 启动被拒，并说清哪一项。
 * 「启动被拒」这半条由 apply() 里的 throw 保证，这里测的是「说清哪一项」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, Config, RANGES, validateConfig } from '../lib/config.mjs';

test('默认配置必须自己过得了校验', () => {
  assert.deepEqual(validateConfig(DEFAULTS), []);
});

test('端口越界：说清哪一项、范围多少、怎么改', () => {
  const p = validateConfig({ pagePort: 99999 });
  assert.equal(p.length, 1);
  assert.equal(p[0].key, 'pagePort');
  assert.match(p[0].reason, /超出范围/);
  assert.match(p[0].fix, /65535/);
});

test('端口写成 0（越界且要 root）时，怎么改那句话得点出 root', () => {
  const p = validateConfig({ pagePort: 0 });
  assert.equal(p[0].key, 'pagePort');
  assert.match(p[0].fix, /root/);
});

test('端口 80 不拦 —— 它是合法的，只是要权限。拦了等于替人做决定', () => {
  assert.deepEqual(validateConfig({ pagePort: 80 }), []);
});

test('端口写成字符串算坏 —— 不是整数', () => {
  const p = validateConfig({ pagePort: '8098' });
  assert.equal(p[0].key, 'pagePort');
  assert.match(p[0].reason, /不是整数/);
});

test('一次报全部，不是只报第一个（改一个重启一次，每次重启都打断会话）', () => {
  const p = validateConfig({ pagePort: -1, freeTimeFrom: 25, indexTtlMs: 10, stateDir: '' });
  const keys = new Set(p.map((x) => x.key));
  for (const k of ['pagePort', 'freeTimeFrom', 'indexTtlMs', 'stateDir']) {
    assert.ok(keys.has(k), `${k} 没被报出来`);
  }
});

test('目录：空串和相对路径都算坏（它们会随启动目录漂）', () => {
  assert.match(validateConfig({ stateDir: '' })[0].reason, /是空的/);
  assert.equal(validateConfig({ sessionsRoot: 'sessions' })[0].reason, '不是绝对路径');
});

test('绑定地址：常见写法认，域名和空串不认', () => {
  for (const ok of ['127.0.0.1', '0.0.0.0', '::1', '::', 'localhost']) {
    assert.deepEqual(validateConfig({ pageBind: ok }), [], `${ok} 被误判了`);
  }
  for (const bad of ['', 'example.com', '999.1.1.1']) {
    const p = validateConfig({ pageBind: bad });
    assert.equal(p[0]?.key, 'pageBind', `${bad} 没被拦`);
  }
});

test('关了观测页就不再管绑定地址', () => {
  assert.deepEqual(validateConfig({ servePage: false, pageBind: '瞎写的' }), []);
});

test('freeTimeProfile 只能是名字，不能是路径', () => {
  const p = validateConfig({ freeTimeProfile: 'profiles/freetime' });
  assert.equal(p[0].key, 'freeTimeProfile');
  assert.match(p[0].reason, /路径/);
});

test('范围常量只有一份，Schema 和 validateConfig 用的是同一组', () => {
  assert.equal(RANGES.pagePort.max, 65535);
  assert.equal(RANGES.freeTimeFrom.max, 23);
});

test('Schema 那一层也会拦：非法端口过不了 Config', () => {
  assert.throws(() => Config({ ...DEFAULTS, pagePort: 99999 }));
  assert.doesNotThrow(() => Config({ ...DEFAULTS }));
});
