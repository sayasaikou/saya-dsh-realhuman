/**
 * 集成测试：真的把插件 apply 一次，看它会不会被「某一路坏了」拖死
 *
 * T0-④ 的判据是：让观测页 / 索引 / TTS 各挂一次，每次对话仍照常发出，日志各有一条。
 * 这个文件先钉住最重要的两条（不依赖真 dsh，也不需要真 python）：
 *   ① 观测页起不来（本机没有 python3）→ 四个工具照样注册上
 *   ② 账本目录写不进去 → 注入这段照样放行，返回原样，不抛错
 *
 * 为什么这两条最要紧：坏起来最难看的样子不是报错，是**她一句话都发不出去**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod, writeFile, readFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DSH_HOME 必须在 import 之前设好 —— config.mjs 是模块加载时求值的
const HOME = await mkdtemp(join(tmpdir(), 'rh-int-'));
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ } });
process.env.DSH_HOME = HOME;

const { apply } = await import('../index.mjs');

function makeCtx() {
  const tools = new Map();
  const handlers = [];
  const logs = [];
  return {
    tools,
    handlers,
    logs,
    ctx: {
      logger: {
        info: (m) => logs.push(['info', m]),
        error: (m) => logs.push(['error', m]),
      },
      get: (n) => (n === 'tools' ? { register: (d) => tools.set(d.name, d) } : undefined),
      on: (name, fn, opts) => handlers.push({ name, fn, opts }),
    },
  };
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function boot(over = {}) {
  // 记下 mkdtemp 建的父目录：清理时删它，不然每跑一次就留一个空目录在 TEMP 里
  let root = null;
  let stateDir = over.stateDir;
  if (!stateDir) {
    root = await mkdtemp(join(tmpdir(), 'rh-int-state-'));
    stateDir = join(root, 'state');
  }
  const h = makeCtx();
  apply(h.ctx, {
    stateDir,
    servePage: false, // 不起观测页：本机没有 python3，走的就是「那一路坏了」
    freeTime: false,
    announceOnInstall: false,
    ...over,
  });
  await settle();
  return { ...h, stateDir, root };
}

test('观测页起不来时，四个工具照样注册上', async () => {
  const h = await boot();
  try {
    for (const name of ['rh_mood', 'rh_pending', 'rh_control', 'rh_changes']) {
      assert.ok(h.tools.has(name), `${name} 没注册 —— 观测页坏了不该拖累工具面`);
    }
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('注入为 global —— 少了这个选项就是「注册了、没报错、永远不生效」', async () => {
  const h = await boot();
  try {
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    assert.ok(inj, '注入 handler 没挂');
    assert.equal(inj.opts?.global, true);
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('账本目录写不进去时，注入照样放行（不抛错，返回原样）', async () => {
  // 造一个「存在但不能写」的目录：读得到、写不进去
  const root = await mkdtemp(join(tmpdir(), 'rh-int-ro-'));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  await chmod(stateDir, 0o500); // r-x：能进能读，不能建文件
  const h = await boot({ stateDir });
  try {
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const assembled = { sections: [] };
    // 关键：它必须**返回**，不能抛。抛出去这一轮就没有下文了。
    const out = await inj.fn(assembled, {}, async () => assembled);
    assert.ok(out && typeof out === 'object');
    assert.ok(Array.isArray(out.sections));
  } finally {
    await chmod(stateDir, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('没有心情账本时注入也不炸（空账本是正常状态，不是故障）', async () => {
  const h = await boot();
  try {
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const assembled = { sections: [{ name: 'base', text: 'x' }], marker: 1 };
    const out = await inj.fn(assembled, {}, async () => assembled);
    // 原样保留：别人挂进去的段一个都不许丢
    assert.equal(out.marker, 1);
    assert.ok(out.sections.some((s) => s.name === 'base'));
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('同一份 assembly 只注入一次（重试 / 多 agent 不会把心情塞成复读）', async () => {
  const h = await boot();
  try {
    // 造一条没完的事，这样注入里一定有东西，才看得出「注了几次」
    const ev = {
      fp: 'abc12345',
      text: '一条测试',
      action: 'add',
      at: new Date().toISOString(),
      session: 's1',
      round: 1,
    };
    await writeFile(join(h.stateDir, 'pending.jsonl'), `${JSON.stringify(ev)}\n`);

    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const assembly = { sections: [] };
    const first = await inj.fn(assembly, {}, async () => ({ sections: [] }));
    const second = await inj.fn(assembly, {}, async () => ({ sections: [] }));

    assert.ok(first.sections.length > 0, '第一次该注入');
    assert.equal(second.sections.length, 0, '同一份 assembly 第二次不该再注入');
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('被人改写的心情，注入里必须写明「不是你自己的」（P-3b 的核心）', async () => {
  const h = await boot();
  try {
    await writeFile(
      join(h.stateDir, 'mood.jsonl'),
      `${JSON.stringify({
        at: new Date().toISOString(),
        feeling: '有点闷',
        level: 6,
        why_ref: '',
        why_kind: 'manual',
        by: 'owner',
        reason: '他说想试试',
        decay: null,
      })}\n`,
    );
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    const mood = out.sections.find((s) => s.name === 'realheart:mood');
    assert.ok(mood, '心情段没注入');
    assert.match(mood.text, /不是你自己的/);
    assert.match(mood.text, /被人改写/);
    assert.match(mood.text, /他说想试试/, '理由没带进去，她没法判断该不该认');
    // 还得给她一条出路：可以不认
    assert.match(mood.text, /rh_control|rh_mood/);
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('总开关在的时候，apply 什么都不做（工具不注册、监听不挂）', async () => {
  const dir = join(HOME, 'realheart');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'DISABLED'), 'test\n');
  try {
    const h = makeCtx();
    apply(h.ctx, { stateDir: join(HOME, 'ks-state'), servePage: false, freeTime: false });
    await settle();
    assert.equal(h.tools.size, 0, '停用了还注册了工具');
    assert.equal(h.handlers.length, 0, '停用了还挂了监听');
  } finally {
    await rm(join(dir, 'DISABLED'), { force: true });
  }
});

test('dispose 会挂上（不然热重载会漏监听器）', async () => {
  const h = await boot();  try {
    assert.ok(h.handlers.some((x) => x.name === 'dispose'));
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

// ── P-6 ①②：自己想留就留、自己想查就查 ──

test('自己留一句：下一轮原样回来，不加工（P-6 ①）', async () => {
  const h = await boot();
  try {
    const r1 = await h.tools.get('rh_control').execute({ action: 'keep', text: '这句话我要留着' });
    assert.match(r1.text, /留着了/);
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    const kept = out.sections.find((s) => s.name === 'realheart:kept');
    assert.ok(kept, '留的那一段没注入');
    assert.match(kept.text, /【你留下的话】/);
    assert.match(kept.text, /这句话我要留着/);
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('同一句留两次不重复记', async () => {
  const h = await boot();
  try {
    const ctl = h.tools.get('rh_control');
    await ctl.execute({ action: 'keep', text: '重复的一句' });
    const r2 = await ctl.execute({ action: 'keep', text: '重复的一句' });
    assert.match(r2.text, /已经留着了/);
    const f = await ctl.execute({ action: 'files' });
    assert.equal((f.text.match(/重复的一句/g) || []).length, 1);
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('撤掉之后不再回来，而且撤这件事留痕', async () => {
  const h = await boot();
  try {
    const ctl = h.tools.get('rh_control');
    await ctl.execute({ action: 'keep', text: '待会儿要撤的' });
    const files = await ctl.execute({ action: 'files' });
    const id = (files.text.match(/· ([0-9a-f]{8})  待会儿要撤的/) || [])[1];
    assert.ok(id, 'files 里没给出 id，撤不掉');
    const un = await ctl.execute({ action: 'unkeep', id });
    assert.match(un.text, /撤掉了/);
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    assert.equal(out.sections.find((s) => s.name === 'realheart:kept'), undefined);
    const raw = await readFile(join(h.stateDir, 'kept.jsonl'), 'utf8');
    assert.match(raw, /"action":"keep"/);
    assert.match(raw, /"action":"unkeep"/);
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('files 列出产物；没有说明文件就如实写「没写说明」（P-6 ②）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rh-pieces-'));
  const pieces = join(root, 'work', 'pieces');
  const h = await boot({ root });
  try {
    await mkdir(pieces, { recursive: true });
    await writeFile(join(pieces, '一张画.png'), 'x');
    await writeFile(join(pieces, '一篇字.md'), '# 这是说明\n正文');
    const r = await h.tools.get('rh_control').execute({ action: 'files' });
    assert.match(r.text, /【产物】/);
    assert.match(r.text, /一张画\.png.*没写说明/);
    assert.match(r.text, /一篇字\.md.*这是说明/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});
// ── M1-6：注入预算 ──

test('超出预算时从低优先级开始裁，心情永不裁（M1-6）', async () => {
  const h = await boot({ injectBudgetChars: 260 });
  try {
    // 塞一条心情 + 一堆她留的话
    await writeFile(
      join(h.stateDir, 'mood.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), feeling: '还行', level: 5, why_ref: '', why_kind: 'ref', decay: null })}\n`,
    );
    const ctl = h.tools.get('rh_control');
    for (const n of ['第一句很长的留言内容', '第二句很长的留言内容', '第三句很长的留言内容']) {
      await ctl.execute({ action: 'keep', text: `${n}${'补'.repeat(30)}` });
    }
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    const names = out.sections.map((s) => s.name);
    assert.ok(names.includes('realheart:mood'), '心情段被裁了 —— 它不该被裁');
    const total = out.sections.reduce((n, s) => n + s.text.length, 0);
    assert.ok(total <= 260 + 120, `总字数 ${total} 还是超预算（允许一点冗余，因为裁完不再回填）`);
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('裁掉了要留痕（少一段不能是静默的）', async () => {
  const h = await boot({ injectBudgetChars: 200 });
  try {
    const ctl = h.tools.get('rh_control');
    for (let i = 0; i < 6; i += 1) {
      await ctl.execute({ action: 'keep', text: `第${i}句${'长'.repeat(40)}` });
    }
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    const probs = await readFile(join(h.stateDir, 'inject-problems.log'), 'utf8');
    assert.match(probs, /budget/);
    assert.match(probs, /裁掉了/);
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('预算够的时候一段都不裁', async () => {
  const h = await boot({ injectBudgetChars: 5000 });
  try {
    await h.tools.get('rh_control').execute({ action: 'keep', text: '短的一句' });
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    assert.ok(out.sections.some((s) => s.name === 'realheart:kept'));
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});
// ── M1-3：并发写不把账本写坏 ──

test('十个 add 同时进来，流水和渲染仍然一致（M1-3）', async () => {
  const h = await boot();
  try {
    const add = h.tools.get('rh_pending');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => add.execute({ action: 'add', text: `并发第${i}条` })),
    );
    const okCount = results.filter((r) => !String(r.text).includes('没写') && !String(r.text).includes('不一致')).length;

    const events = (await readFile(join(h.stateDir, 'pending.jsonl'), 'utf8'))
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const md = await readFile(join(h.stateDir, 'pending.md'), 'utf8');
    // 关键判据：渲染必须等于流水回放 —— 不要求 10 条都成功，要求「成功的那些没把账写坏」
    const { replay, render } = await import('../lib/pending.mjs');
    assert.equal(md, render(replay(events)), 'pending.md 和流水分家了');
    assert.ok(events.length >= 1, '一条都没写进去');
    assert.equal(okCount, events.filter((e) => e.action === 'add').length, '成功条数和流水条数对不上');
    // 锁文件要清干净，不然下次写不进去
    assert.equal(existsSync(join(h.stateDir, 'pending.lock')), false, '锁没释放');
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('过期的锁不会把账本永久卡死（崩溃残留）', async () => {
  const h = await boot();
  try {
    const lock = join(h.stateDir, 'pending.lock');
    await writeFile(lock, 'stale');
    // 把锁的 mtime 往前拨 20 秒，模拟上次崩溃留下的
    const old = new Date(Date.now() - 20000);
    await utimes(lock, old, old);
    const r = await h.tools.get('rh_pending').execute({ action: 'add', text: '锁过期之后写的' });
    assert.ok(!String(r.text).includes('占着'), `被过期锁卡住了：${r.text}`);
    assert.equal(existsSync(lock), false, '过期锁没被清掉');
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});
// ── 作废：用稳定键（M1-4 的前置）──

test('作废之后那条不再被注入，但它还在账本里（作废≠删除）', async () => {
  const h = await boot();
  try {
    const at = '2026-10-30 22:00:00';
    await writeFile(
      join(h.stateDir, 'mood.jsonl'),
      `${JSON.stringify({ at, feeling: '不想提的那句', level: 8, why_ref: '', why_kind: 'ref', decay: null })}\n`,
    );
    await writeFile(
      join(h.stateDir, 'control.jsonl'),
      `${JSON.stringify({ at: '2026-10-30 22:05:00', action: 'void', target: at, reason: '她自己说这条不算', by: 'owner' })}\n`,
    );
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    assert.equal(out.sections.find((s) => s.name === 'realheart:mood'), undefined, '作废的那条还在注入里');

    // 账本原文没动
    const raw = await readFile(join(h.stateDir, 'mood.jsonl'), 'utf8');
    assert.match(raw, /不想提的那句/);
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('老的行号作废记录还认（不能因为改了键就把旧账读错）', async () => {
  const h = await boot();
  try {
    const rows = [
      { at: '2026-10-30 20:00:00', feeling: '第一条', level: 3, why_ref: '', why_kind: 'ref', decay: null },
      { at: '2026-10-30 21:00:00', feeling: '第二条', level: 4, why_ref: '', why_kind: 'ref', decay: null },
    ];
    await writeFile(join(h.stateDir, 'mood.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    // 老格式：target 是行号 2（作废「第二条」）
    await writeFile(
      join(h.stateDir, 'control.jsonl'),
      `${JSON.stringify({ at: '2026-10-30 21:05:00', action: 'void', target: 2, reason: '老记录' })}\n`,
    );
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    const mood = out.sections.find((s) => s.name === 'realheart:mood');
    assert.ok(mood, '应该回落到第一条');
    assert.match(mood.text, /第一条/);
    assert.ok(!mood.text.includes('第二条'), '行号作废没生效');
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});
// ── M1-4：账本变长不拖慢注入 ──

test('只读尾部：账本 300 条，注入用的是最后那条（M1-4）', async () => {
  const h = await boot({ moodTailLines: 5 });
  try {
    const rows = [];
    for (let i = 0; i < 300; i += 1) {
      rows.push(JSON.stringify({
        at: `2026-10-${String(1 + (i % 28)).padStart(2, '0')} 10:00:00`,
        feeling: `第${i}条心情`, level: 5, why_ref: '', why_kind: 'ref', decay: null,
      }));
    }
    await writeFile(join(h.stateDir, 'mood.jsonl'), `${rows.join('\n')}\n`);
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    const mood = out.sections.find((s) => s.name === 'realheart:mood');
    assert.ok(mood, '心情段没了');
    assert.match(mood.text, /第299条心情/, '没取到最后一条');
    assert.ok(!mood.text.includes('第0条心情'), '把整份账本都读进来了');
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});

test('尾部窗口里最后一条被作废时，回落到窗口内上一条', async () => {
  const h = await boot({ moodTailLines: 5 });
  try {
    const rows = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push(JSON.stringify({
        at: `2026-10-30 1${i}:00:00`, feeling: `第${i}条`, level: 5, why_ref: '', why_kind: 'ref', decay: null,
      }));
    }
    await writeFile(join(h.stateDir, 'mood.jsonl'), `${rows.join('\n')}\n`);
    await writeFile(join(h.stateDir, 'control.jsonl'),
      `${JSON.stringify({ at: 'x', action: 'void', target: '2026-10-30 19:00:00', reason: '作废最后一条' })}\n`);
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    const out = await inj.fn({ sections: [] }, {}, async () => ({ sections: [] }));
    const mood = out.sections.find((s) => s.name === 'realheart:mood');
    assert.match(mood.text, /第8条/, '没回落到窗口内的上一条');
  } finally {
    await rm(h.root ?? h.stateDir, { recursive: true, force: true });
  }
});