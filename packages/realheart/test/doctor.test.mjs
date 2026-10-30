/**
 * rh_doctor 的测试
 *
 * 这台机器上 python3 未必有、也未必有观测页在跑 —— 所以测试不假定环境，
 * 而是**造**环境：临时 DSH_HOME + 一个本地 http 服务冒充观测页。
 *
 * 要证的是四件事：
 *   ① 该绿的绿（healthz 通、pending 一致）
 *   ② 该红的红（端口被别人占、pending 分家）
 *   ③ 不知道的不猜（没有运行时配置时，不拿默认路径去读/去建）
 *   ④ 每条问题都得带「怎么修」
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { runDoctor, formatDoctor } from '../lib/doctor.mjs';
import { fingerprint, replay, render } from '../lib/pending.mjs';

const SECRET = 'test-secret';

async function makeHome(over = {}) {
  const home = await mkdtemp(join(tmpdir(), 'rh-doc-'));
  const rt = join(home, 'realheart', 'runtime');
  await mkdir(rt, { recursive: true });
  const state = join(home, 'state');
  await mkdir(state, { recursive: true });
  await writeFile(
    join(rt, 'config.json'),
    JSON.stringify({ port: 8099, bind: '127.0.0.1', secret: SECRET, root: home, stateDir: state, ...over }),
  );
  return { home, state };
}

function serve(handler) {
  return new Promise((resolve, reject) => {
    const s = createServer(handler);
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const pick = (r, prefix) => r.items.find((i) => i.title.startsWith(prefix));

test('观测页在听、口令对得上 → ok', async () => {
  const s = await serve((req, res) => {
    if (req.url === `/${SECRET}/healthz`) {
      res.writeHead(200);
      res.end('ok');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const h = await makeHome({ port: s.address().port });
  try {
    const r = await runDoctor({ dshHome: h.home });
    assert.equal(pick(r, '端口').level, 'ok');
  } finally {
    s.close();
    await rm(h.home, { recursive: true, force: true });
  }
});

test('端口被别的东西占着 → fail，并给换端口的建议', async () => {
  const s = await serve((req, res) => {
    res.writeHead(404);
    res.end('not me');
  });
  const h = await makeHome({ port: s.address().port });
  try {
    const r = await runDoctor({ dshHome: h.home });
    const item = pick(r, '端口');
    assert.equal(item.level, 'fail');
    assert.match(item.fix, /pagePort|端口/);
  } finally {
    s.close();
    await rm(h.home, { recursive: true, force: true });
  }
});

test('pending.md 与流水一致 → ok', async () => {
  const h = await makeHome();
  const ev = { fp: fingerprint('买菜'), text: '买菜', action: 'add', at: new Date().toISOString(), session: 's1', round: 1 };
  await writeFile(join(h.state, 'pending.jsonl'), `${JSON.stringify(ev)}\n`);
  await writeFile(join(h.state, 'pending.md'), render(replay([ev])));
  try {
    const r = await runDoctor({ dshHome: h.home });
    assert.equal(pick(r, 'pending 一致性').level, 'ok');
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('pending.md 被人手改过 → fail（它显示的不是流水回放出来的样子）', async () => {
  const h = await makeHome();
  const ev = { fp: fingerprint('买菜'), text: '买菜', action: 'add', at: new Date().toISOString(), session: 's1', round: 1 };
  await writeFile(join(h.state, 'pending.jsonl'), `${JSON.stringify(ev)}\n`);
  await writeFile(join(h.state, 'pending.md'), `${render(replay([ev]))}- [ ] 手动加的一条\n`);
  try {
    const r = await runDoctor({ dshHome: h.home });
    assert.equal(pick(r, 'pending 一致性').level, 'fail');
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('账本有坏行 → warn 且报出条数', async () => {
  const h = await makeHome();
  await writeFile(join(h.state, 'mood.jsonl'), '{"a":1}\n这不是 JSON\n{"b":2}\n');
  try {
    const r = await runDoctor({ dshHome: h.home });
    const item = pick(r, 'mood.jsonl');
    assert.equal(item.level, 'warn');
    assert.match(item.detail, /1 行解析不了/);
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('没有运行时配置：不猜路径、不拿默认值冒充真实配置', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rh-doc-empty-'));
  try {
    const r = await runDoctor({ dshHome: home });
    // 配置那项只在读到真实配置时才查 —— 拿默认值查出来的「全对」是假的
    assert.ok(!r.items.some((i) => i.title === '配置'), '没配置却报了「配置 ok」，那是在骗人');
    assert.equal(pick(r, '账本目录').level, 'warn');
    assert.equal(r.stateDir, null);
    // 而且不许去碰默认路径（否则会在别人家里建目录）
    assert.ok(r.items.every((i) => !i.detail.includes(join(process.env.HOME || '', 'qqbot'))));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('错误日志里出现口令 → fail（打码只挡以后，挡不住以前漏过的）', async () => {
  const h = await makeHome();
  await writeFile(
    join(h.home, 'realheart', 'rh-status.err.log'),
    `观测页：http://127.0.0.1:8099/${SECRET}/\n`,
  );
  try {
    const r = await runDoctor({ dshHome: h.home });
    const item = pick(r, '口令泄漏');
    assert.equal(item.level, 'fail');
    assert.match(item.fix, /secret|换掉/);
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('日志干净时说干净（不留言又不报错，两样都不行）', async () => {
  const h = await makeHome();
  await writeFile(join(h.home, 'realheart', 'rh-status.err.log'), '观测页：http://127.0.0.1:8099/<口令>/\n');
  try {
    const r = await runDoctor({ dshHome: h.home });
    assert.equal(pick(r, '口令泄漏').level, 'ok');
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('注入少过段 → warn，并指出是哪个环节（不许静默少一路）', async () => {
  const h = await makeHome();
  await writeFile(
    join(h.state, 'inject-problems.log'),
    '2026-10-30T12:00:00.000Z\tpending\t读不到账本\n2026-10-30T12:05:00.000Z\tall\t炸了\n',
  );
  try {
    const r = await runDoctor({ dshHome: h.home });
    const item = pick(r, '注入失败记录');
    assert.equal(item.level, 'warn');
    assert.match(item.detail, /2 次/);
    assert.match(item.detail, /all/);
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('注入从没少过段就说 ok（不留言又不报错，两样都不行）', async () => {
  const h = await makeHome();
  try {
    const r = await runDoctor({ dshHome: h.home });
    assert.equal(pick(r, '注入失败记录').level, 'ok');
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('总开关开着时第一条就说清「被停用中」（不然后面那些空账本会被当成故障）', async () => {
  const h = await makeHome();
  await mkdir(join(h.home, 'realheart'), { recursive: true });
  await writeFile(join(h.home, 'realheart', 'DISABLED'), 'x\n');
  try {
    const r = await runDoctor({ dshHome: h.home });
    const item = pick(r, '总开关');
    assert.equal(item.level, 'warn');
    assert.match(item.fix, /realheart on/);
    assert.equal(r.items[0].title, '总开关', '总开关那项要排在第一条');
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('删过东西要说出来（内容没了，这句还得在）', async () => {
  const h = await makeHome();
  await writeFile(
    join(h.home, 'realheart', 'forget-log.md'),
    '\n## 2026-10-30 22:50 · 删了整份账本\n\n- 为什么：她说不想留着\n',
  );
  try {
    const r = await runDoctor({ dshHome: h.home });
    const item = pick(r, '删除记录');
    assert.match(item.detail, /删过 1 次/);
    assert.match(item.detail, /22:50/);
  } finally {
    await rm(h.home, { recursive: true, force: true });
  }
});

test('每条不是 ok 的项都得带「怎么修」', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rh-doc-fix-'));
  try {
    const r = await runDoctor({ dshHome: home });
    for (const it of r.items) {
      if (it.level === 'ok') continue;
      assert.ok(it.fix && it.fix.length > 0, `${it.title} 没有修法`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('formatDoctor：有 fail 就给一句总的指导', () => {
  const out = formatDoctor({
    items: [{ level: 'fail', title: '端口 8098', detail: '被占着', fix: '换个端口' }],
    summary: { ok: 0, warn: 0, fail: 1 },
  });
  assert.match(out, /换个端口/);
  assert.match(out, /有 FAIL/);
  assert.match(out, /0 ok · 0 warn · 1 fail/);
});
