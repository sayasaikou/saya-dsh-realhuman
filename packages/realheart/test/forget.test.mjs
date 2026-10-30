/**
 * 删除留痕的测试（M1-9）
 *
 * 定案的两句：**记账的人不能同时握毁账的权**；**标记写在被删的东西之外**。
 * 这个文件测的就是第二句能不能成立 —— 删完之后，还剩下什么能对账。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  forgetLogPath,
  renderForgetEntry,
  inventoryOf,
  appendForget,
  FORGET_LOG_NAME,
} from '../lib/forget.mjs';

test('标记里有四件必须有的：什么时候、删了什么、原来有什么、为什么', () => {
  const e = renderForgetEntry({
    at: '2026-10-30 23:00',
    scope: '整份账本',
    target: '/home/x/qqbot/work/realheart',
    inventory: '12 项：mood.jsonl、pending.jsonl 等',
    why: '她说不想留着这段',
    by: '命令行 realheart wipe（host1）',
  });
  assert.match(e, /2026-10-30 23:00/);
  assert.match(e, /整份账本/);
  assert.match(e, /12 项/);
  assert.match(e, /她说不想留着这段/);
  assert.match(e, /host1/);
  assert.match(e, /不在被删的东西里/);
});

test('没写为什么也要留一行「（没写）」—— 空着比不写更糟，看不出漏了', () => {
  const e = renderForgetEntry({ at: 'x', target: '/p', inventory: '1 个', why: '' });
  assert.match(e, /为什么：（没写）/);
});

test('标记路径在被删内容之外（realheart/ 下，不在 stateDir 里）', () => {
  const p = forgetLogPath('/home/x/.dsh');
  assert.equal(p, join('/home/x/.dsh', 'realheart', FORGET_LOG_NAME));
  assert.ok(!p.includes('work/realheart'));
});

test('inventoryOf：文件报大小，目录报项数和头几个名字', async () => {
  const d = await mkdtemp(join(tmpdir(), 'rh-forget-'));
  try {
    const f = join(d, 'a.jsonl');
    await writeFile(f, 'x'.repeat(123));
    assert.match(await inventoryOf(f), /1 个文件，123 B/);

    await mkdir(join(d, 'sub'));
    for (const n of ['a', 'b', 'c']) await writeFile(join(d, 'sub', n), 'x');
    assert.match(await inventoryOf(join(d, 'sub')), /3 项：a、b、c/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('inventoryOf 对不存在的东西返回空串（不抛）', async () => {
  assert.equal(await inventoryOf('/绝对不存在的路径/xyz'), '');
});

test('appendForget 会自己建目录，并且是追加不是覆盖', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rh-forget-log-'));
  try {
    await appendForget(home, '# 第一条\n');
    await appendForget(home, '# 第二条\n');
    const text = await readFile(forgetLogPath(home), 'utf8');
    assert.match(text, /第一条/);
    assert.match(text, /第二条/);
    const st = await stat(forgetLogPath(home));
    assert.ok(st.size > 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
