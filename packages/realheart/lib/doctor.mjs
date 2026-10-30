/**
 * rh_doctor —— 一条命令回答三个问题：**在不在工作 / 哪坏了 / 怎么修**
 *
 * 为什么要它：这套东西坏起来大多不报错。端口被占、zstd 缺失、账本和渲染分家、
 * 注入被预算裁掉 —— 这些现象都是「页面能开、看起来正常，但少了一路」。
 * 靠人记得去查文档是不行的，得有一条命令把该查的都查一遍。
 *
 * 两条纪律：
 *   ① 每一项都说清「怎么修」，否则等于让人拿个红灯自己猜；
 *   ② 只读不写（除了探可写性时建一个临时文件，立刻删）。
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { join } from 'node:path';
import { DSH_HOME, DEFAULTS, validateConfig } from './config.mjs';
import { findSecretLeak } from './secrets.mjs';
import { replay, matchesFile } from './pending.mjs';

const execFileAsync = promisify(execFile);

async function cmdOk(cmd, args) {
  try {
    await execFileAsync(cmd, args);
    return true;
  } catch {
    return false;
  }
}

/** 读 jsonl，返回 { rows, bad }。坏行不抛错 —— 它本身就是一条要报的结果。 */
async function readJsonl(path) {
  if (!existsSync(path)) return { rows: [], bad: 0, missing: true };
  const text = await readFile(path, 'utf8');
  const rows = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      bad += 1;
    }
  }
  return { rows, bad, missing: false };
}

/** 端口上有没有人在听（不区分是谁）。 */
function portOpen(host, port, ms = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => {
      try { sock.destroy(); } catch { /* 已经断了 */ }
      resolve(v);
    };
    sock.setTimeout(ms, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * 跑全部检查。返回 { items, summary }，items 里每条 { level, title, detail, fix }。
 * level: 'ok' | 'warn' | 'fail'
 */
export async function runDoctor({ dshHome = DSH_HOME } = {}) {
  const items = [];
  const add = (level, title, detail, fix = '') => items.push({ level, title, detail, fix });

  const rtDir = join(dshHome, 'realheart');
  const cfgPath = join(rtDir, 'runtime', 'config.json');
  let rt = null;
  if (existsSync(cfgPath)) {
    try {
      rt = JSON.parse(await readFile(cfgPath, 'utf8'));
    } catch {
      rt = null;
    }
  }
  // stateDir 只认运行时 config.json 里写的那个。
  // 绝不拿默认值去猜 —— 猜错会在别人家里建目录，那是不可逆的。
  const stateDir = rt?.stateDir || null;
  const pagePort = rt?.port ?? DEFAULTS.pagePort;
  const pageBind = rt?.bind ?? DEFAULTS.pageBind;
  const secret = rt?.secret || '';

  // ── 0. 总开关 ──
  // 停用状态要第一条就看见 —— 不然下面那些「没有注入过 / 工具没注册」会被误读成故障。
  const killSwitch = join(dshHome, 'realheart', 'DISABLED');
  if (existsSync(killSwitch)) {
    add('warn', '总开关', '被停用中（DISABLED 文件在）：不注入、不记账、工具未注册',
      `要恢复：npx realheart on（或删掉 ${killSwitch}），然后重启 dsh。下面是停用前留下的状态`);
  }

  // ── 1. 依赖 ──
  const py = await cmdOk('python3', ['-V']);
  const zstd = await cmdOk('zstd', ['--version']);
  add(py ? 'ok' : 'fail', 'python3', py ? '有' : '找不到',
    py ? '' : '观测页和索引是 Python 写的，起不来。apt install python3 / pacman -S python / brew install python');
  add(zstd ? 'ok' : 'warn', 'zstd', zstd ? '有' : '找不到',
    zstd ? '' : '「他说的话」那一路会一直是空的，而且**不报错**。apt install zstd / pacman -S zstd / brew install zstd');

  // ── 2. 运行时与配置 ──
  if (!rt) {
    add('warn', '运行时', `没有 ${cfgPath}`,
      '从没在这台机器上装成过，或者装成过但没启动过。装：npx realheart install --profile <名字>');
  } else {
    add('ok', '运行时', `config.json 在（端口 ${pagePort}，绑定 ${pageBind}）`);
    // 口令的权限：config.json 里是明文 secret，别人可读就等于口令泄漏。
    try {
      const st = await stat(cfgPath);
      const mode = st.mode & 0o777;
      add(mode === 0o600 ? 'ok' : 'warn', '口令文件权限',
        `config.json 是 ${mode.toString(8)}`,
        mode === 0o600 ? '' : '里面有 48 位明文口令。chmod 600 ' + cfgPath);
    } catch {
      add('warn', '口令文件权限', 'stat 不到', 'chmod 600 ' + cfgPath);
    }
  }

  // ── 3. 配置本身合不合规（和启动时同一套判据）──
  // 没有运行时配置就不查：拿默认值查出来的「全对」是假的，默认值当然合法。
  if (rt) {
    const cfgForCheck = { ...DEFAULTS, pagePort, pageBind, ...(stateDir ? { stateDir } : {}) };
    const problems = validateConfig(cfgForCheck);
    if (problems.length) {
      for (const p of problems) add('fail', `配置 ${p.key}`, `${JSON.stringify(p.value)} —— ${p.reason}`, p.fix);
    } else {
      add('ok', '配置', '实际在用的关键项都在合法范围里');
    }
  }

  // ── 4. 账本目录可不可写 ──
  // 「存在但不可写」比「不存在」更难查：写不进去只会在她写心情的时候冒一句「写不进帐本」。
  if (stateDir) {
    try {
      await mkdir(stateDir, { recursive: true });
      const probe = join(stateDir, '.doctor-probe');
      await writeFile(probe, 'x');
      await unlink(probe);
      add('ok', '账本目录', `${stateDir} 可写`);
    } catch (err) {
      add('fail', '账本目录', `${stateDir} 写不进去（${err?.code ?? err?.message ?? err}）`,
        'chmod 或者换到别的盘；目录不在的话插件会自己建，但父目录得可写');
    }
  }

  // ── 5. 端口 ──
  const listening = await portOpen(pageBind === '0.0.0.0' ? '127.0.0.1' : pageBind, pagePort);
  if (!listening) {
    add('warn', `端口 ${pagePort}`, '没有人在听',
      '观测页没起：servePage 关了？还是 python 起不来？看 ' + join(rtDir, 'rh-status.err.log') + ' 末尾');
  } else if (!secret) {
    add('warn', `端口 ${pagePort}`, '有东西在听，但拿不到口令，认不出是不是自己', '看 config.json 里有没有 secret');
  } else {
    let ok = false;
    try {
      const res = await fetch(`http://127.0.0.1:${pagePort}/${secret}/healthz`, { signal: AbortSignal.timeout(2500) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    add(ok ? 'ok' : 'fail', `端口 ${pagePort}`,
      ok ? '观测页在听，口令也对得上' : '有人占着这个端口，但不是 realheart（healthz 不通）',
      ok ? '' : '改 pagePort 换一个端口，或者把占着它的进程停掉');
  }

  // ── 6. 口令有没有漏进日志 ──
  // 这条能查，是因为「口令不进日志」现在是代码不是嘱咐（lib/secrets.mjs + 测试）。
  // 但历史日志里可能已经漏过了 —— 改成打码只挡住以后，挡不住以前。
  if (secret) {
    const scanned = [];
    for (const f of [join(rtDir, 'rh-status.err.log'), join(stateDir ?? '', 'last-inject.md')]) {
      if (!stateDir || !existsSync(f)) continue;
      try {
        const hits = findSecretLeak(await readFile(f, 'utf8'), secret);
        if (hits.length) scanned.push([f, hits.length]);
      } catch {
        /* 读不了就是没有证据，不当失败 */
      }
    }
    if (scanned.length) {
      const [f, n] = scanned[0];
      add('fail', '口令泄漏', `${n} 处口令落进了 ${f}`,
        '换掉口令：删 runtime/config.json 的 secret 字段再重启（会生成新的），然后把那份日志清掉。这个文件别贴出去');
    } else {
      add('ok', '口令泄漏', '错误日志与注入快照里没有口令');
    }
  }

  // ── 7. 账本有没有坏行 ──
  // 走到这里还没有 stateDir，说明运行时配置根本不存在 —— 后面几项（账本、渲染、注入）
  // 都是「不知道该查哪个目录」。**不猜**：猜错会往别人家里建目录或者读别人的账本。
  if (!stateDir) {
    add('warn', '账本目录', '不知道在哪（没有运行时 config.json，不拿默认路径去猜）',
      '先装成一次：npx realheart install --profile <名字>。装成之后启动一次，它会写出 config.json');
    const summary0 = { ok: 0, warn: 0, fail: 0 };
    for (const it of items) summary0[it.level] += 1;
    return { items, summary: summary0, stateDir: null, pagePort };
  }

  const mood = await readJsonl(join(stateDir, 'mood.jsonl'));
  const pend = await readJsonl(join(stateDir, 'pending.jsonl'));
  for (const [name, r] of [['mood.jsonl', mood], ['pending.jsonl', pend]]) {
    if (r.missing) add('warn', name, '文件不存在', '还没写过东西 —— 这不算坏，装完就这么显示');
    else if (r.bad) add('warn', name, `${r.bad} 行解析不了（共 ${r.rows.length + r.bad} 行）`,
      '插件读到坏行会跳过，不影响使用；但坏行说明有人手改过或者写一半断电了。行号：grep -n -v "^{" ' + join(stateDir, name));
    else add('ok', name, `${r.rows.length} 条，没有坏行`);
  }

  // ── 8. 流水与渲染对不对得上 ──
  // 这是这套东西里唯一一处「文件是派生的」：pending.md 必须等于流水回放出来的样子。
  // 分家了它就一直在骗人，而且骗得很自然。
  if (!pend.missing) {
    const mdPath = join(stateDir, 'pending.md');
    if (!existsSync(mdPath)) {
      add('warn', 'pending 一致性', 'pending.md 不存在', '下次写待办时会自己生成；一直不生成就是写入那路没跑过');
    } else {
      const fileText = await readFile(mdPath, 'utf8');
      const same = matchesFile(pend.rows, fileText);
      add(same ? 'ok' : 'fail', 'pending 一致性',
        same ? 'pending.md 与流水回放一致' : 'pending.md 和流水对不上（它现在显示的不是流水回放出来的样子）',
        same ? '' : '插件下次写入时会拒绝覆盖并在日志报错。想看差在哪：拿 pending.jsonl 跑一遍 replay 再对比');
    }
  }

  // ── 9. 今天注入成功过没有 ──
  const liPath = join(stateDir, 'last-inject.md');
  if (!existsSync(liPath)) {
    add('warn', '注入', '没有 last-inject.md', '说明这个插件还没在会话里跑过一轮，或者从不写盘');
  } else {
    const st = await stat(liPath);
    const hours = (Date.now() - st.mtimeMs) / 3600000;
    const text = await readFile(liPath, 'utf8');
    const hasPending = text.includes('【没完的事】');
    const fresh = hours < 24;
    const level = fresh ? 'ok' : 'warn';
    add(level, '注入',
      `${fresh ? '最近一次是 ' + hours.toFixed(1) + ' 小时前' : '最后一次是 ' + (hours / 24).toFixed(1) + ' 天前'}，` +
      `${hasPending ? '带【没完的事】段' : '没有【没完的事】段'}`,
      fresh ? (hasPending ? '' : '注入里没有待办那一段：injectMood 关了？还是被预算裁掉了？') : '一天内没有注入过 —— 没人在说话，或者注入那一路坏了');
  }

  // ── 10. 注入有没有少过段（M1-11：不许静默少一路）──
  const probPath = join(stateDir, 'inject-problems.log');
  if (!existsSync(probPath)) {
    add('ok', '注入失败记录', '没有少过段');
  } else {
    const rows = (await readFile(probPath, 'utf8')).split('\n').filter((x) => x.trim());
    const last = rows[rows.length - 1] ?? '';
    const lastTime = last.split('\t')[0] ?? '';
    add('warn', '注入失败记录', `${rows.length} 次少段，最后一次 ${lastTime}（环节：${last.split('\t')[1] ?? '?'}）`,
      '每一次都是「少了一段但没挡住说话」。哪个环节：mood / pending-change / pending / all —— 对着那个环节查');
  }

  // ── 11. 删过什么（M1-9）──
  // 删掉的内容不会回来，但「删过什么」这句话必须还在 —— 它存在被删内容之外。
  const forgetLog = join(dshHome, 'realheart', 'forget-log.md');
  if (!existsSync(forgetLog)) {
    add('ok', '删除记录', '没有删过东西');
  } else {
    const text = await readFile(forgetLog, 'utf8');
    const entries = (text.match(/^## /gm) || []).length;
    const last = (text.match(/^## (.*)$/m) || [])[1] || '（读不出标题）';
    add('ok', '删除记录', `删过 ${entries} 次，最后一次：${last}`,
      `路径 ${forgetLog} —— 这是唯一能证明「删过什么」的东西，别删它`);
  }

  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const it of items) summary[it.level] += 1;
  return { items, summary, stateDir, pagePort };
}

/** 显示宽度：中文和全角算两格，不然那一列对不齐（对不齐的表格读起来像噪声）。 */
function dispWidth(s) {
  let n = 0;
  for (const ch of s) {
    n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return n;
}

/** 把结果排成人看的样子。 */
export function formatDoctor({ items, summary }) {
  const mark = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' };
  const width = Math.max(...items.map((i) => dispWidth(i.title))) + 2;
  const lines = [];
  for (const it of items) {
    // 对齐靠显示宽度，不靠字符数 —— 汉字在这上面最容易被算错
    const pad = ' '.repeat(Math.max(0, width - dispWidth(it.title)));
    lines.push(`  ${mark[it.level]} ${it.title}${pad}${it.detail}`);
    if (it.fix) lines.push(`          → ${it.fix}`);
  }
  lines.push('');
  lines.push(`  ${summary.ok} ok · ${summary.warn} warn · ${summary.fail} fail`);
  if (summary.fail) lines.push('  有 FAIL：按上面每条 → 后面的命令改，改完重启。配置类的必须重启才生效。');
  else if (summary.warn) lines.push('  没有 FAIL，warn 是「能跑但少了一路」那种，看要不要处理。');
  else lines.push('  全绿。');
  return lines.join('\n');
}
