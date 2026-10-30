// 验一件事：PATH 里没有 python3 的时候，插件会不会把宿主崩掉。
//
// 她的判断：spawn 的 ENOENT 是异步 error 事件，try/catch 抓不到；
// 没挂 'error' 监听器时 Node 会把它当未捕获错误抛出 —— 崩的是宿主。
// 这个脚本把 PATH 清空来制造 ENOENT，然后看两件事：
//   ① 进程会不会 survive
//   ② 日志里有没有「找不到 python3」

import { mkdir, rm } from 'node:fs/promises';

const ROOT = '/tmp/rh-nopy';
await rm(ROOT, { recursive: true, force: true });
await mkdir(`${ROOT}/state`, { recursive: true });
await mkdir(`${ROOT}/persona`, { recursive: true });
process.env.DSH_HOME = ROOT;

let crashed = null;
process.on('uncaughtException', (err) => {
  crashed = err?.code || err?.message || String(err);
  console.log('UNCAUGHT:', crashed);
  process.exit(2);
});

const logs = [];
const ctx = {
  logger: {
    info: (m) => logs.push(m),
    error: (m) => logs.push('ERR ' + m),
  },
  get: (n) => (n === 'tools' ? { register: () => {} } : undefined),
  on: () => {},
};

const mod = await import('/tmp/realheart-pkg/index.mjs');
mod.apply(ctx, {
  stateDir: `${ROOT}/state`,
  pagePort: 8096,
  personaHome: `${ROOT}/persona`,
  freeTimeProfile: 'rh-nopy-free',
});

await new Promise((r) => setTimeout(r, 6000));

console.log('--- 日志 ---');
for (const l of logs) console.log('  ', l);

const found = logs.some((l) => l.includes('找不到 python3'));
console.log('');
console.log('进程还活着：', crashed ? '否（崩了）' : '是');
console.log('报出了「找不到 python3」：', found ? '是' : '否');
console.log('');
console.log(!crashed && found ? 'PASS 该报的报了出来，宿主没崩' : 'FAIL');
process.exit(!crashed && found ? 0 : 1);
