// pending 账本的纯函数测试：回放一致性 + 三个量的边界。
// 跑：node --test packages/realheart/test/pending.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprint, emptyState, applyEvent, replay, render, matchesFile,
  unfinishedCount, fulfillMedian, continuationRate, summaryText, K_ROUNDS,
} from '../lib/pending.mjs';

const add = (text, at, extra = {}) => ({
  action: 'add', text, fp: fingerprint(text), at, ...extra,
});

test('指纹：空白差异不算两条', () => {
  assert.equal(fingerprint('  回她消息 '), fingerprint('回她消息'));
  assert.equal(fingerprint('回她 消息'), fingerprint('回她 消息'));
  assert.notEqual(fingerprint('回她消息'), fingerprint('回她消息。'));
  assert.equal(fingerprint('回她消息').length, 8);
});

test('回放：渲染结果与文件逐字节一致才算数', () => {
  const events = [
    add('把 rescue 的两个报错补上', '2026-10-28T10:00:00+08:00'),
    add('写状态层那半', '2026-10-28T10:05:00+08:00'),
    { action: 'check', fp: fingerprint('写状态层那半'), at: '2026-10-28T12:00:00+08:00', evidence: 'a:2026-10-28#1201' },
  ];
  const state = replay(events);
  const file = render(state);
  assert.ok(matchesFile(events, file), '回放出来的文件必须与磁盘一致');
  assert.equal(unfinishedCount(state), 1);
  // 少一行就不一致 —— 这条判据要能失败
  assert.equal(matchesFile(events, file.replace('- [x] 写状态层那半\n', '')), false);
});

test('同一句话不重复进队', () => {
  const a = add('同一件事', '2026-10-28T10:00:00+08:00');
  let s = applyEvent(emptyState(), a);
  s = applyEvent(s, a) ?? s;
  assert.equal(s.items.length, 1);
});

test('没有佐证的勾记 claimed_done，不进续接率分子', () => {
  const fp = fingerprint('无佐证的事');
  const events = [
    add('无佐证的事', '2026-10-28T10:00:00+08:00', { turn: 1, session: 's1' }),
    { action: 'check', fp, at: '2026-10-28T10:30:00+08:00', turn: 3, session: 's1' },
  ];
  const s = replay(events);
  assert.equal(s.items[0].claimed_done, true);
  const r = continuationRate(events, { session: 's1' });
  assert.equal(r.inTime, 0);
  assert.equal(r.claimed, 1);
});

test('兑现耗时：样本不足不报中位数；at_unknown 不进中位数但要说出来', () => {
  const fp1 = fingerprint('a');
  const fp2 = fingerprint('b');
  const events = [
    add('a', '2026-10-28T10:00:00+08:00'),
    add('b', '2026-10-28T10:00:00+08:00', { at_unknown: true }),
    { action: 'check', fp: fp1, at: '2026-10-28T12:00:00+08:00', evidence: 'a:2026-10-28#1' },
    { action: 'check', fp: fp2, at: '2026-10-28T12:00:00+08:00', evidence: 'a:2026-10-28#2' },
  ];
  const m = fulfillMedian(replay(events));
  assert.equal(m.n, 1, '只有一条有起点');
  assert.equal(m.unknownStart, 1);
  assert.equal(m.insufficient, true);
  assert.equal(m.medianHours, undefined);
});

test('中位数：5 对才报，取中位不取平均', () => {
  const events = [];
  [1, 2, 3, 4, 100].forEach((h, i) => {
    const text = `任务${i}`;
    events.push(add(text, '2026-10-28T10:00:00+08:00'));
    const at = new Date(Date.parse('2026-10-28T10:00:00+08:00') + h * 3600000).toISOString();
    events.push({ action: 'check', fp: fingerprint(text), at, evidence: `a:2026-10-28#${i}` });
  });
  const m = fulfillMedian(replay(events));
  assert.equal(m.n, 5);
  assert.equal(m.insufficient, false);
  assert.equal(m.medianHours, 3, '中位数是 3，不是被 100 拖歪的平均值');
});

test('续接率：K 轮内 + 同会话', () => {
  const events = [];
  for (let i = 0; i < 10; i += 1) {
    const text = `事${i}`;
    events.push(add(text, '2026-10-28T10:00:00+08:00', { turn: i * 2, session: 's1' }));
    if (i < 3) {
      events.push({
        action: 'check', fp: fingerprint(text), at: '2026-10-28T10:10:00+08:00',
        turn: i * 2 + 5, session: 's1', evidence: `a:2026-10-28#${i}`,
      });
    }
  }
  const r = continuationRate(events, { session: 's1' });
  assert.equal(r.added, 10);
  assert.equal(r.inTime, 3);
  assert.equal(r.insufficient, false);
  assert.equal(r.rate, 0.3);
  assert.equal(K_ROUNDS, 10);
});

test('注入文本：只陈述，不给建议', () => {
  const state = replay([add('一件事', '2026-10-28T10:00:00+08:00')]);
  const text = summaryText(state, [add('一件事', '2026-10-28T10:00:00+08:00')]);
  assert.match(text, /未完成 1 条/);
  assert.match(text, /样本不足/);
  assert.doesNotMatch(text, /建议|应该|加油/);
});

// ── 2026-10-31：drop 之后「新增」要减掉，但兑现过的不动 ──
function evDated(action, text, extra = {}) {
  return { action, text, fp: fingerprint(text), at: '2026-10-31T10:00:00+08:00', session: 's', ...extra };
}

test('续接率：自己加又自己删的那条，不算进新增', () => {
  const fp = fingerprint('测试项');
  const rows = [
    evDated('add', '真事一', { turn: 1 }),
    evDated('add', '测试项', { turn: 2 }),
    { action: 'drop', fp, ref: fp, at: '2026-10-31T10:01:00+08:00', session: 's' },
    evDated('add', '真事二', { turn: 3 }),
  ];
  const r = continuationRate(rows, { session: 's' });
  assert.equal(r.added, 2);
});

test('续接率：兑现过再删掉，分母不许改小（drop 不能事后改历史）', () => {
  const fp = fingerprint('做完的活');
  const rows = [
    evDated('add', '做完的活', { turn: 1 }),
    { action: 'check', fp, ref: fp, at: '2026-10-31T10:05:00+08:00', turn: 3, session: 's', evidence: 'a:2026-10-31#1' },
    { action: 'drop', fp, ref: fp, at: '2026-10-31T10:06:00+08:00', session: 's' },
  ];
  const r = continuationRate(rows, { session: 's' });
  assert.equal(r.added, 1);
});

