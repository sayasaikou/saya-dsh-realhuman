import test from 'node:test';
import assert from 'node:assert/strict';

import { instanceTagFrom, lastInjectPaths } from '../lib/instance-tag.mjs';

test('从宿主的 --profile 取标识', () => {
  assert.equal(instanceTagFrom(['node', '/usr/bin/dsh', '--profile', 'qqbot']), 'qqbot');
  assert.equal(instanceTagFrom(['node', 'dsh', '--profile=rh2']), 'rh2');
});

test('取不到就叫 default，不猜', () => {
  assert.equal(instanceTagFrom(['node', 'dsh']), 'default');
  assert.equal(instanceTagFrom([]), 'default');
  assert.equal(instanceTagFrom(null), 'default');
});

test('带路径分隔符或空格的标识一律不认', () => {
  assert.equal(instanceTagFrom(['dsh', '--profile', '../../etc/passwd']), 'default');
  assert.equal(instanceTagFrom(['dsh', '--profile', 'a b']), 'default');
  assert.equal(instanceTagFrom(['dsh', '--profile', '']), 'default');
});

test('两个落点：latest 沿用旧名，perInstance 带标识', () => {
  const a = lastInjectPaths('/state', 'qqbot');
  const b = lastInjectPaths('/state', 'rh2');
  assert.match(a.latest, /last-inject\.md$/);
  assert.match(a.perInstance, /last-inject\.qqbot\.md$/);
  assert.match(b.perInstance, /last-inject\.rh2\.md$/);
  // latest 两张实例共写（旧的读法不能断），perInstance 互不覆盖（这才是修的那一点）
  assert.equal(a.latest, b.latest);
  assert.notEqual(a.perInstance, b.perInstance);
});

test('坏标识也落到 default，不拼出空文件名', () => {
  const p = lastInjectPaths('/state', '../x');
  assert.match(p.perInstance, /last-inject\.default\.md$/);
});
