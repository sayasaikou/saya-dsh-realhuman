/**
 * 两条红线，用测试钉住，不靠记性（P-4）
 *
 * ① **插件不碰凭据** —— 永不读 `.credentials.yaml` / `settings.yaml` / `.anonymous-user-id`。
 *    这条写进 README 是承诺，写进测试才是保证 —— 以后谁手滑加一行 `readFile(credentials)`
 *    都会在这里红。
 *
 * ② **插件不碰界面** —— 不改 `ui.yaml`、不动主题与面板结构。
 *    这份东西是给别人装的，动了界面就等于替宿主做决定。
 *
 * 为什么用「扫源码」这种笨办法：这两条没有运行时的可观测痕迹 ——
 * 读了凭据也不会有任何表现，只能从代码里挡。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const SRC = [
  'index.mjs',
  'setup.mjs',
  'bin/realheart.mjs',
  'lib/config.mjs',
  'lib/doctor.mjs',
  'lib/forget.mjs',
  'lib/pending.mjs',
  'lib/secrets.mjs',
  'lib/version.mjs',
];

async function readAll() {
  const out = [];
  for (const rel of SRC) {
    out.push([rel, await readFile(new URL(rel, ROOT), 'utf8')]);
  }
  for (const f of await readdir(new URL('runtime/', ROOT))) {
    if (!f.endsWith('.py')) continue;
    out.push([`runtime/${f}`, await readFile(new URL(`runtime/${f}`, ROOT), 'utf8')]);
  }
  return out;
}

test('一份源码都不许提凭据文件名（提了就有可能在读它）', async () => {
  const files = await readAll();
  const banned = ['.credentials.yaml', 'settings.yaml', '.anonymous-user-id'];
  for (const [rel, src] of files) {
    for (const b of banned) {
      assert.ok(!src.includes(b), `${rel} 里出现了 ${b} —— 插件不该碰凭据`);
    }
  }
});

test('不许碰宿主的界面文件', async () => {
  const files = await readAll();
  for (const [rel, src] of files) {
    for (const b of ['ui.yaml', 'localStorage']) {
      assert.ok(!src.includes(b), `${rel} 里出现了 ${b} —— 插件不该动宿主界面`);
    }
  }
});

test('扫的是真文件（不然上面两条永远是绿的，等于没测）', async () => {
  const files = await readAll();
  assert.ok(files.length >= 9, `只扫到 ${files.length} 个文件，路径是不是错了`);
  assert.ok(files.some(([rel]) => rel === 'index.mjs'));
  assert.ok(files.some(([rel]) => rel.endsWith('rh-status.py')));
});
