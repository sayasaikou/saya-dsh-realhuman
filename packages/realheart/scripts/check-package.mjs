// 验证打包后的插件能自举：铺文件、生成口令、起观测页、连上工具。
// 用独立端口和独立 DSH_HOME，不碰生产。

import { mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const TEST_HOME = '/tmp/rh-pkg-test';
const PORT = 8097;

await rm(TEST_HOME, { recursive: true, force: true });
await mkdir(TEST_HOME, { recursive: true });
process.env.DSH_HOME = TEST_HOME;

const mod = await import('/tmp/realheart-pkg/index.mjs');

const tools = new Map();
const handlers = [];
const logs = [];
const ctx = {
  logger: { info: (m) => logs.push(m), error: (m) => logs.push('ERR ' + m) },
  get: (n) => (n === 'tools' ? { register: (d) => tools.set(d.name, d) } : undefined),
  on: (n, fn, opts) => handlers.push({ name: n, fn, opts }),
};

mod.apply(ctx, { pagePort: PORT, pageBind: '127.0.0.1' });

// 等自举 + 注册
for (let i = 0; i < 60 && tools.size < 3; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
}

console.log('--- 日志 ---');
for (const l of logs) console.log(' ', l);

console.log('\n--- 铺出去的文件 ---');
const rtDir = join(TEST_HOME, 'realheart', 'runtime');
if (existsSync(rtDir)) {
  for (const f of await readdir(rtDir)) console.log('  ', f);
} else {
  console.log('  （没有 runtime 目录 —— 自举失败）');
}

console.log('\n--- config.json ---');
try {
  const cfg = JSON.parse(await readFile(join(rtDir, 'config.json'), 'utf8'));
  console.log('   port=%s bind=%s secret_len=%d root=%s',
    cfg.port, cfg.bind, String(cfg.secret || '').length, cfg.root);
} catch (e) {
  console.log('   读不到:', e.message);
}

console.log('\n--- 工具 ---');
console.log('  ', [...tools.keys()].join(', ') || '（无）');

console.log('\n--- 观测页 ---');
try {
  const cfg = JSON.parse(await readFile(join(rtDir, 'config.json'), 'utf8'));
  const url = `http://127.0.0.1:${PORT}/${cfg.secret}/`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await res.text();
  console.log('   GET', url.replace(cfg.secret, '<secret>'));
  console.log('   http=%d bytes=%d', res.status, body.length);
  const marks = ['心痛帐本', '心情帐本', '自由时间', 'QQ 登录', 'realheart'];
  console.log('   命中:', marks.filter((m) => body.includes(m)).join(' / ') || '（无）');
} catch (e) {
  console.log('   打不开:', e.message);
}

const ok = tools.size === 3 && existsSync(join(rtDir, 'rh-status.py'));
console.log('\n' + (ok ? 'PASS 装完就能用' : 'FAIL 还有没跑通的'));
process.exit(ok ? 0 : 1);
