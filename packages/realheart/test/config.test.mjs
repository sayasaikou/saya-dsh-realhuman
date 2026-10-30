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
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, Config, RANGES, validateConfig, describeConfig, loadUserConfig } from '../lib/config.mjs';

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

test('布尔项写成字符串要被拦（"yes" 是真值，以为关了其实没关）', () => {
  for (const key of ['enabled', 'injectMood', 'servePage', 'announceOnInstall', 'freeTime']) {
    const p = validateConfig({ [key]: 'yes' });
    assert.ok(p.some((x) => x.key === key), `${key} 写成字符串没被拦`);
  }
});

// ── 面板要用的那份描述 ──

test('describeConfig：每一项都得说清「改了会怎样」', () => {
  const d = describeConfig();
  assert.ok(d.fields.length >= 15);
  for (const f of d.fields) {
    assert.ok(f.why && f.why.length > 8, `${f.key} 没写后果`);
    assert.ok(f.range, `${f.key} 没写合法范围`);
    assert.ok(['normal', 'caution', 'danger'].includes(f.level), `${f.key} 级别不对`);
    assert.ok(f.key in DEFAULTS, `${f.key} 不是真的配置项`);
  }
});

test('危险级必须覆盖他点名的那几样（关注入 / 数据目录 / 自由时间）', () => {
  const d = describeConfig();
  const danger = d.fields.filter((f) => f.level === 'danger').map((f) => f.key);
  for (const k of ['injectMood', 'stateDir', 'freeTime', 'freeTimeFrom', 'freeTimeProfile']) {
    assert.ok(danger.includes(k), `${k} 该是危险级`);
  }
});

test('describeConfig：带当前值，不是只给默认值', () => {
  const f = describeConfig({ pagePort: 9000 }).fields.find((x) => x.key === 'pagePort');
  assert.equal(f.current, 9000);
  assert.equal(f.def, DEFAULTS.pagePort);
});

// ── config.user.json（面板写的那个文件）──

test('没有 user 文件：空配置，不报错', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rh-cfg-'));
  try {
    const r = await loadUserConfig(home);
    assert.deepEqual(r.config, {});
    assert.deepEqual(r.problems, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('user 文件不是 JSON：整份忽略，但要报出来', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rh-cfg-'));
  try {
    await mkdir(join(home, 'realheart'), { recursive: true });
    await writeFile(join(home, 'realheart', 'config.user.json'), '{ 坏掉的');
    const r = await loadUserConfig(home);
    assert.deepEqual(r.config, {});
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /不是合法 JSON/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('user 文件里坏的项丢掉、好的项留下（面板填错不该让插件起不来）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rh-cfg-'));
  try {
    await mkdir(join(home, 'realheart'), { recursive: true });
    await writeFile(
      join(home, 'realheart', 'config.user.json'),
      JSON.stringify({ pagePort: 9999, injectMood: 'yes', stateDir: 'work/rel', 乱写的: 1 }),
    );
    const r = await loadUserConfig(home);
    assert.deepEqual(r.config, { pagePort: 9999 });
    assert.equal(r.problems.length, 3);
    assert.ok(r.problems.some((p) => p.includes('injectMood')));
    assert.ok(r.problems.some((p) => p.includes('stateDir')));
    assert.ok(r.problems.some((p) => p.includes('乱写的')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Schema 那一层也会拦：非法端口过不了 Config', () => {
  assert.throws(() => Config({ ...DEFAULTS, pagePort: 99999 }));
  assert.doesNotThrow(() => Config({ ...DEFAULTS }));
});
