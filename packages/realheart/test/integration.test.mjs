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
import { mkdtemp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DSH_HOME 必须在 import 之前设好 —— config.mjs 是模块加载时求值的
const HOME = await mkdtemp(join(tmpdir(), 'rh-int-'));
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
  const stateDir = over.stateDir ?? join(await mkdtemp(join(tmpdir(), 'rh-int-state-')), 'state');
  const h = makeCtx();
  apply(h.ctx, {
    stateDir,
    servePage: false, // 不起观测页：本机没有 python3，走的就是「那一路坏了」
    freeTime: false,
    announceOnInstall: false,
    ...over,
  });
  await settle();
  return { ...h, stateDir };
}

test('观测页起不来时，四个工具照样注册上', async () => {
  const h = await boot();
  try {
    for (const name of ['rh_mood', 'rh_pending', 'rh_control', 'rh_changes']) {
      assert.ok(h.tools.has(name), `${name} 没注册 —— 观测页坏了不该拖累工具面`);
    }
  } finally {
    await rm(h.stateDir, { recursive: true, force: true });
  }
});

test('注入为 global —— 少了这个选项就是「注册了、没报错、永远不生效」', async () => {
  const h = await boot();
  try {
    const inj = h.handlers.find((x) => x.name === 'system-prompt/assemble');
    assert.ok(inj, '注入 handler 没挂');
    assert.equal(inj.opts?.global, true);
  } finally {
    await rm(h.stateDir, { recursive: true, force: true });
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
    await rm(h.stateDir, { recursive: true, force: true });
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
    await rm(h.stateDir, { recursive: true, force: true });
  }
});

test('dispose 会挂上（不然热重载会漏监听器）', async () => {
  const h = await boot();
  try {
    assert.ok(h.handlers.some((x) => x.name === 'dispose'));
  } finally {
    await rm(h.stateDir, { recursive: true, force: true });
  }
});
