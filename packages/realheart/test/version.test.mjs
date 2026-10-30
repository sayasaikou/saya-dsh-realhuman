/**
 * 版本比较的测试
 *
 * 这条最要紧的一句：**拿不到版本时返回 null，不是 false。**
 * 把「我不知道」当成「不满足」，就会把能装的东西拦在门外。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, extractVersion, satisfies } from '../lib/version.mjs';

test('比大小：主次修订逐个比', () => {
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1);
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
});

test('预发布版比正式版小（0.2.1-0 < 0.2.1）', () => {
  assert.equal(compareVersions('0.2.1-0', '0.2.1'), -1);
  assert.equal(compareVersions('0.2.1', '0.2.1-0'), 1);
});

test('补位：0.2 当 0.2.0，v 前缀能吃', () => {
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
});

test('看不懂的就返回 null，不瞎比', () => {
  assert.equal(compareVersions('latest', '1.0.0'), null);
  assert.equal(compareVersions('', '1.0.0'), null);
});

test('engines 用的 >= 判据', () => {
  assert.equal(satisfies('0.2.1', '>=0.2.1-0'), true);
  assert.equal(satisfies('0.2.1-0', '>=0.2.1-0'), true);
  assert.equal(satisfies('0.2.0', '>=0.2.1-0'), false);
  assert.equal(satisfies('0.1.9', '>=0.2.1-0'), false);
  assert.equal(satisfies('1.0.0', '>=0.2.1-0'), true);
});

test('拿不到版本 / 范围写法不认识 → null（不知道就不拦）', () => {
  assert.equal(satisfies('', '>=0.2.1-0'), null);
  assert.equal(satisfies('0.2.1', ''), null);
  assert.equal(satisfies('0.2.1', '^0.2.1'), null, '^ 这种写法这里不支持，要说不知道而不是不满足');
  assert.equal(satisfies('0.2.1', '>=0.2.1 || <1.0.0'), null);
});

test('从乱糟糟的输出里抠版本号', () => {
  assert.equal(extractVersion('0.2.1'), '0.2.1');
  assert.equal(extractVersion('dsh 0.2.1 (build abc)\n'), '0.2.1');
  assert.equal(extractVersion('v0.2.1-beta.2'), '0.2.1-beta.2');
  assert.equal(extractVersion('no version here'), '');
});
