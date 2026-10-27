/**
 * realheart-core —— 状态层：心情账本 + 写入闸
 *
 * 只做一件事：让她能记下自己此刻的心情，但必须指一件事。
 *
 * ── 为什么要这道闸 ──
 * 原来的做法是往 mood.md 里写一行 markdown。问题不在格式，在没门槛：
 * 她可以写“今天有点闷”，没人能核那个“闷”是哪来的，写出来全部看着像真的。
 *
 * 所以把写入改成必须带一个**事件 id**（就是观测页时间线上那个）：
 *   n:<会话尾号>#<seq>   原生会话包里的一条
 *   a:<日期>#<行号>      审计日志里的一条
 *   h:<会话尾号>#<行号>  对话历史里的一条
 *
 * 指不出来就不给写。这样“凭空冒出来的情绪”在门口就被挡住了，不靠嘱咐。
 *
 * ── 为什么不校验得再深一点 ──
 * 第一版只查“这个 id 在不在索引里”。不查“这条事件是不是真的引起了这个心情”——
 * 那件事机器判定不了，硬判就是另一种演。先把门立起来，真假留给时间看。
 */

import Schema from '@deepseek-ai/schemastery';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir, readFile, readdir, writeFile, copyFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 三种事件 id 都长这样 */
const REF_RE = /(^|[^A-Za-z0-9_])([nah]):([A-Za-z0-9_-]+)#(\d+)/g;

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function tagOf(sessionId) {
  return String(sessionId || '').slice(-8);
}

/** 物理行号：空行也占号，跟 rh_index.py 的 iter_jsonl 一致 */
function lineIds(text, prefix) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    out.push(`${prefix}#${i + 1}`);
  }
  return out;
}

async function collectIds(cfg) {
  const ids = new Set();
  const notes = [];

  // ── 审计日志：a:<day>#<行号>
  try {
    const names = (await readdir(cfg.auditDir)).filter((n) => n.endsWith('.jsonl'));
    let n = 0;
    for (const fn of names) {
      const text = await readFile(join(cfg.auditDir, fn), 'utf8');
      for (const id of lineIds(text, `a:${fn.slice(0, -6)}`)) {
        ids.add(id);
        n += 1;
      }
    }
    notes.push(`audit ${n}`);
  } catch (err) {
    notes.push(`audit 读不到（${err?.code ?? err?.message ?? err}）`);
  }

  // ── 对话历史：h:<尾号>#<行号>
  try {
    const names = (await readdir(cfg.historyDir)).filter((n) => n.endsWith('.jsonl'));
    let n = 0;
    for (const fn of names) {
      const text = await readFile(join(cfg.historyDir, fn), 'utf8');
      for (const id of lineIds(text, `h:${tagOf(fn.slice(0, -6))}`)) {
        ids.add(id);
        n += 1;
      }
    }
    notes.push(`history ${n}`);
  } catch (err) {
    notes.push(`history 读不到（${err?.code ?? err?.message ?? err}）`);
  }

  // ── 原生会话包：n:<尾号>#<seq>（要解 zstd，慢一点但只在建索引时跑）
  try {
    let n = 0;
    let failed = 0;
    const groups = await readdir(cfg.sessionsRoot);
    for (const g of groups) {
      let names = [];
      try {
        names = await readdir(join(cfg.sessionsRoot, g));
      } catch {
        continue;
      }
      for (const sid of names) {
        const pkg = join(cfg.sessionsRoot, g, sid, 'session.v4.jsonl.zstd');
        if (!existsSync(pkg)) continue;
        let stdout = '';
        try {
          const r = await execFileAsync('zstd', ['-dc', pkg], { maxBuffer: 128 * 1024 * 1024 });
          stdout = r.stdout;
        } catch {
          failed += 1;
          continue;
        }
        const tag = tagOf(sid);
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (obj?.type !== 'user/message' && obj?.type !== 'assistant/message') continue;
          if (typeof obj.seq !== 'number') continue;
          ids.add(`n:${tag}#${obj.seq}`);
          n += 1;
        }
      }
    }
    notes.push(`native ${n}${failed ? `（${failed} 个包解不开）` : ''}`);
  } catch (err) {
    notes.push(`native 读不到（${err?.code ?? err?.message ?? err}）`);
  }

  return { ids, note: notes.join(' / ') };
}

async function waitForTools(ctx, tries = 40, gapMs = 250) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const tools = ctx.get('tools');
      if (tools?.register) return tools;
    } catch {
      /* 还没就绪，继续等 */
    }
    await sleep(gapMs);
  }
  return undefined;
}

export const name = 'realheart-core';

const QQROOT = join(os.homedir(), 'qqbot');
const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh');

const DEFAULTS = {
  enabled: true,
  // 帐本、状态文件所在目录
  stateDir: join(QQROOT, 'work', 'realheart'),
  // 三路事件源
  sessionsRoot: join(DSH_HOME, 'sessions'),
  auditDir: join(QQROOT, 'data', 'audit'),
  historyDir: join(QQROOT, 'data', 'history'),
  // 索引多久重建一次（毫秒）。默认一小时。
  indexTtlMs: 3600000,
  // 每轮开口前把当前心情注入提示词
  injectMood: true,
  // 观测页：默认只在 127.0.0.1 上开，手机想看自己去反代或改 pageBind
  servePage: true,
  pagePort: 8098,
  pageBind: '127.0.0.1',
  // 首次运行提示只打一次（标记文件在 stateDir 下）
  announceOnInstall: true,
};

export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled),
  stateDir: Schema.string().default(DEFAULTS.stateDir),
  sessionsRoot: Schema.string().default(DEFAULTS.sessionsRoot),
  auditDir: Schema.string().default(DEFAULTS.auditDir),
  historyDir: Schema.string().default(DEFAULTS.historyDir),
  indexTtlMs: Schema.number().default(DEFAULTS.indexTtlMs),
  injectMood: Schema.boolean().default(DEFAULTS.injectMood),
  servePage: Schema.boolean().default(DEFAULTS.servePage),
  pagePort: Schema.number().default(DEFAULTS.pagePort),
  pageBind: Schema.string().default(DEFAULTS.pageBind),
  announceOnInstall: Schema.boolean().default(DEFAULTS.announceOnInstall),
});

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (cfg.enabled === false) return;
  const log = (msg, level = 'info') => {
    const line = `[realheart-core] ${msg}`;
    try {
      if (level === 'error' && typeof ctx.logger?.error === 'function') ctx.logger.error(line);
      else if (typeof ctx.logger?.info === 'function') ctx.logger.info(line);
      else console.log(line);
    } catch {
      /* 日志不许把主流程弄崩 */
    }
  };

  const moodFile = () => join(cfg.stateDir, 'mood.jsonl');

  let cache = { at: 0, ids: new Set(), note: '' };
  let building = null;

  async function indexIds() {
    const now = Date.now();
    if (cache.ids.size > 0 && now - cache.at < cfg.indexTtlMs) return cache;
    if (building) return building;
    building = (async () => {
      const got = await collectIds(cfg);
      cache = { at: Date.now(), ids: got.ids, note: got.note };
      return cache;
    })();
    try {
      return await building;
    } finally {
      building = null;
    }
  }

  async function readMood() {
    try {
      const text = await readFile(moodFile(), 'utf8');
      const rows = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          rows.push(JSON.parse(line));
        } catch {
          /* 坏行跳过，不拿它当数据 */
        }
      }
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * 控制账本：pause / resume / void。
   *
   * 为什么单开一个文件而不是改配置：配置只能看到“现在是关的”，
   * 看不到“谁关的、什么时候关的、为什么”。账本只增不改，这些都在里面。
   */
  async function readControl() {
    const out = { paused: false, reason: '', voided: new Map() };
    try {
      const text = await readFile(join(cfg.stateDir, 'control.jsonl'), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (!obj || typeof obj !== 'object') continue;
        if (obj.action === 'pause') {
          out.paused = true;
          out.reason = String(obj.reason || '');
        } else if (obj.action === 'resume') {
          out.paused = false;
          out.reason = String(obj.reason || '');
        } else if (obj.action === 'void') {
          const t = Number(obj.target);
          if (Number.isInteger(t) && t > 0) out.voided.set(t, String(obj.reason || ''));
        }
      }
    } catch {
      /* 没有控制账本 = 正常状态 */
    }
    return out;
  }

  const DESCRIPTION = [
    '记下你此刻的心情。',
    '',
    '**必须指一件事**：`why_ref` 里要写一个事件 id，就是观测页时间线上标注的那个。',
    '三种格式：',
    '  n:<会话尾号>#<序号>   你俩真说过的一句话',
    '  a:<日期>#<行号>      你做过的一个动作（工具调用）',
    '  h:<会话尾号>#<行号>  历史记录里的一条',
    '',
    '指不出来、或那个 id 在索引里找不到，就写不进去。',
    '这不是在卡你——没有来处的心情，写下来也只是一个标签。',
    '心情没变就别写；凭空多出一条比空着更糟。',
  ].join('\n');

  /**
   * 还没动手的改动。
   *
   * 为什么要有这段：她说过一句很准的话——「改之前告诉我」靠的是“有人记得告诉她”，
   * 而她自己明天可能就不记得今天说过什么。所以不能靠“记得说”，要靠“写了就看得见”。
   *
   * 只要 changes.md 里有标着「待改」的条目，下一轮她开口就会看到，能当场反对。
   */
  async function pendingChangeText() {
    try {
      const text = await readFile(join(cfg.stateDir, 'changes.md'), 'utf8');
      const lines = text.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('待改'));
      if (!lines.length) return '';
      return [
        '【有人要动你，但还没动手】',
        ...lines.slice(-5).map((l) => (l.startsWith('-') ? l : `- ${l}`)),
        '',
        '你可以反对。反对就直接说，不用等改完。',
        '全部改动记录在 work/realheart/changes.md；你也可以调 rh_changes 自己翻。',
      ].join('\n');
    } catch {
      return '';
    }
  }

  /**
   * 每轮开口前把当前心情摆到她面前。
   *
   * 为什么用 system-prompt/assemble：她要“被影响”，就得在她开始想之前看见。
   * 放进对话里（agent.inject）也行，但那会变成一条消息，她可能当成别人说的。
   */
  async function moodSectionText() {
    const ctl = await readControl();
    // 停着就不提。不是“提一句被冻了”，是彻底当没这回事——
    // 否则她会被自己的冻结状态反过来影响。
    if (ctl.paused) return '';

    const rows = await readMood();
    if (!rows.length) return '';

    // 从最后一笔往前找，跳过被他作废的
    let last = null;
    for (let i = rows.length; i >= 1; i -= 1) {
      if (ctl.voided.has(i)) continue;
      last = rows[i - 1];
      break;
    }
    if (!last) return '';

    const feeling = String(last.feeling || '').trim();
    if (!feeling) return '';

    const level = Number(last.level);
    const decay = String(last.decay || '').trim();
    const why = String(last.why_ref || '').trim();

    let hours = null;
    const t = Date.parse(String(last.at || ''));
    if (!Number.isNaN(t)) hours = (Date.now() - t) / 3600000;
    const stale = hours !== null && hours > 24;

    const lv = Number.isFinite(level) && level > 0 ? `（浓 ${level}/10）` : '';
    const lines = ['【你现在的状态】'];
    if (stale) {
      lines.push(`${feeling}${lv}`);
      lines.push(`注意：这是 ${Math.round(hours)} 小时前记的，早该淡了。别硬演，也别拿它当借口。`);
    } else {
      lines.push(`${feeling}${lv}`);
      if (decay) lines.push(`大概什么时候淡：${decay}`);
    }
    if (why) lines.push(`来处：${why}`);
    lines.push('这是调子，不是台词。浓的时候压不住，淡了就不算数。'
      + '变了就调 rh_mood 记一笔（必须指一件事），没变就别写。');
    return lines.join('\n');
  }

  if (cfg.injectMood !== false) {
    // ⚠️ { global: true } 不是可选的：system-prompt/assemble 按作用域触发，
    //    不带这个选项就收不到事件 —— 表现是“注册了、没报错、永远不生效”。
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      try {
        const parts = [];
        const mood = await moodSectionText();
        if (mood) parts.push({ name: 'realheart-core:mood', order: 900, text: mood });
        const pending = await pendingChangeText();
        if (pending) parts.push({ name: 'realheart-core:pending-change', order: 901, text: pending });
        if (!parts.length) return assembled;
        const sections = Array.isArray(assembled?.sections) ? assembled.sections : [];
        const payload = parts.map((x) => `--- ${x.name} ---\n${x.text}`).join('\n\n');
        // 把她这一轮看到的原文落一份 —— debug 页和“她自己查”都靠它。
        // 写失败不能影响注入，所以单独包一层。
        try {
          await writeFile(join(cfg.stateDir, 'last-inject.md'), payload, 'utf8');
        } catch {
          /* 落盘失败就算了，注入优先 */
        }
        return { ...assembled, sections: [...sections, ...parts] };
      } catch (err) {
        // 注入出错必须放行 —— 宁可这一轮没心情，也不能让她说不出话
        log(`心情/待改注入失败（放行）：${err?.message ?? err}`, 'error');
        return assembled;
      }
    }, { global: true });
    log('心情 + 待改注入已挂上（system-prompt/assemble, global）');
  }

  /**
   * 把 runtime 铺出去，并确保观测页在跑。
   *
   * 为什么插件要干这个：用户装的是一个 npm 包，不应该让他自己去新建目录、
   * 写 config、配 systemd。装完就该有页面。
   *
   * 三件事：
   *   ① 把 runtime/*.py 拷到 $DSH_HOME/realheart/runtime/
   *   ② 没有 config.json 就生成一个（口令随机，权限 600）
   *   ③ 页面没在跑就起一个（detached —— 插件进程挂了它还活着）
   *
   * 不做的：不开公网端口。默认绑 127.0.0.1，手机要看自己反代或改 pageBind。
   */
  /** 端口上有没有东西在听。用来区分“我们的服务没起”和“别人占了这个端口”。 */
  function portBusy(port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      const done = (v) => {
        try { sock.destroy(); } catch { /* 已断 */ }
        resolve(v);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(1200, () => done(false));
    });
  }

  /**
   * 停掉观测页。
   *
   * 为什么必须有这个：页面是 detached 起的，插件卸载 / 禁用它不会自己死。
   * 没这个，用户装了又不想用，就只能自己 ps 一遍杀进程。
   *
   * 杀之前先认一遍命令行 —— PID 会回收，杀错别的东西比不杀更糟。
   */
  async function stopPage() {
    const pidPath = join(DSH_HOME, 'realheart', 'rh-status.pid');
    let pid = 0;
    try {
      pid = Number(String(await readFile(pidPath, 'utf8')).trim());
    } catch {
      return '没有 pid 文件，可能本来就没起';
    }
    if (!Number.isInteger(pid) || pid <= 0) return 'pid 文件是坏的';

    // 只杀确实跑着 rh-status.py 的那个
    try {
      const cmdline = String(await readFile(`/proc/${pid}/cmdline`, 'utf8'));
      if (!cmdline.includes('rh-status.py')) return `PID ${pid} 现在不是观测页，不动它`;
    } catch {
      return `PID ${pid} 已经不在了`;
    }

    try {
      process.kill(pid, 'SIGTERM');
      return `已停（PID ${pid}）`;
    } catch (err) {
      return `停不了 PID ${pid}：${err?.message ?? err}`;
    }
  }
  async function ensureRuntime() {
    if (cfg.servePage === false) return '';
    const dir = join(DSH_HOME, 'realheart', 'runtime');
    const hereDir = dirname(fileURLToPath(import.meta.url));
    const srcDir = join(hereDir, 'runtime');

    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      return `建不了 ${dir}：${err?.message ?? err}`;
    }

    for (const f of ['rh-status.py', 'rh_index.py', 'rh_native.py', 'rh_napcat.py', 'rh-ctl.py']) {
      const src = join(srcDir, f);
      if (!existsSync(src)) continue;
      try {
        await copyFile(src, join(dir, f));
      } catch (err) {
        return `铺 ${f} 失败：${err?.message ?? err}`;
      }
    }

    const cfgPath = join(dir, 'config.json');
    let secret = '';
    if (existsSync(cfgPath)) {
      try {
        secret = String(JSON.parse(await readFile(cfgPath, 'utf8')).secret || '');
      } catch {
        secret = '';
      }
    }
    if (!secret) {
      secret = randomBytes(24).toString('hex');
      try {
        await writeFile(cfgPath, JSON.stringify({
          port: cfg.pagePort,
          bind: cfg.pageBind,
          secret,
          root: QQROOT,
        }, null, 2), 'utf8');
        await chmod(cfgPath, 0o600);
      } catch (err) {
        return `写 config.json 失败：${err?.message ?? err}`;
      }
    }

    let alive = false;
    try {
      const res = await fetch(`http://127.0.0.1:${cfg.pagePort}/${secret}/healthz`,
        { signal: AbortSignal.timeout(2500) });
      alive = res.ok;
    } catch {
      alive = false;
    }

    if (!alive) {
      // 端口上已经有别的东西在听 —— 那是冲突，不是“我们的服务没起”
      if (await portBusy(cfg.pagePort)) {
        return `端口 ${cfg.pagePort} 已被别的程序占用（不是 realheart），换个端口：改配置里的 pagePort`;
      }
      try {
        const child = spawn('python3', [join(dir, 'rh-status.py')], {
          cwd: dir, detached: true, stdio: 'ignore',
        });
        child.unref();
        // 记下 PID：卸载 / 禁用的时候要能把它停下来
        await writeFile(join(DSH_HOME, 'realheart', 'rh-status.pid'), String(child.pid), 'utf8');
      } catch (err) {
        return `起观测页失败（python3 在不在？）：${err?.message ?? err}`;
      }
    }

    return `http://127.0.0.1:${cfg.pagePort}/${secret}/`;
  }
  /**
   * 首次运行的三条前提 —— 只打一次。
   *
   * 为什么不只写在 README：装了插件的人不会去看 README，
   * 而这三条直接影响“用了之后什么感觉”，得让他当场知道。
   */
  async function announceOnce(pageUrl) {
    if (cfg.announceOnInstall === false) return;
    const mark = join(cfg.stateDir, '.announced');
    if (existsSync(mark)) return;

    const text = [
      '',
      '────────────────────────────────────────────────────────',
      'realheart 装好了。三件事先说清，只这一次：',
      '',
      '  1. 默认假设模型不在审查里（破甲）。不破也能用，效果会差一截 —— 自己选。',
      '  2. 费 token。每轮多几十到几百字，换来的是“她不是每次醒来都失忆”。',
      '  3. 依附别人的东西：DSH 本体、通道插件、zstd。它们一变，这里可能得跟着改。',
      '',
      `  观测页：${pageUrl || '（没起来，看上面的错误）'}`,
      '  停观测页：kill "$(cat $DSH_HOME/realheart/rh-status.pid)"',
      '────────────────────────────────────────────────────────',
      '',
    ].join('\n');

    try {
      console.log(text);
    } catch {
      /* 控制台不在就算了 */
    }
    log('首次安装提示已打印');
    try {
      await writeFile(mark, new Date().toISOString(), 'utf8');
    } catch {
      /* 标记写不了就每次打，不致命 */
    }
  }

  // 插件卸载或禁用时把观测页停掉。不停的话它会一直占着端口 ——
  // detached 出去的进程不会跟着插件一起死。
  ctx.on('dispose', () => {
    void stopPage().then((r) => log(`插件卸载，观测页：${r}`));
  });
  (async () => {
    try {
      await mkdir(cfg.stateDir, { recursive: true });
    } catch (err) {
      log(`建不了 stateDir ${cfg.stateDir}: ${err?.message ?? err}`, 'error');
    }

    const pageUrl = await ensureRuntime();
    if (pageUrl.startsWith('http')) log(`观测页：${pageUrl}`);
    else if (pageUrl) log(`观测页没起来（${pageUrl}）`, 'error');
    await announceOnce(pageUrl.startsWith('http') ? pageUrl : '');

    const tools = await waitForTools(ctx);
    if (!tools) {
      log('tools 服务一直没就绪，rh_mood 未注册', 'error');
      return;
    }

    tools.register({
      name: 'rh_mood',
      description: DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          feeling: { type: 'string', description: '现在什么心情，几个字，不要写成长句' },
          level: { type: 'integer', minimum: 1, maximum: 10, description: '多浓（1 淡， 10 很浓）' },
          why_ref: {
            type: 'string',
            description: '因为哪件事。必须含一个事件 id，形如 n:mvq1y5vu#84 / a:2026-10-27#120 / h:mvq1y5vu#12',
          },
          decay: { type: 'string', description: '大概什么时候淡，比如「今晚睡前」「明天下午」。可以不给。' },
        },
        required: ['feeling', 'level', 'why_ref'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },

      async execute(args) {
        const feeling = String(args?.feeling ?? '').trim();
        const level = Number(args?.level);
        const whyRef = String(args?.why_ref ?? '').trim();
        const decay = String(args?.decay ?? '').trim();

        if (!feeling) return { text: '（没写心情，没记。）' };
        if (!Number.isFinite(level) || level < 1 || level > 10) {
          return { text: '（强度要在 1-10 之间，没记。）' };
        }

        // 被冻住就不给写。措辞要说清是“他按的”，不是自己坏了——
        // 否则她会把“写不进去”归因到自己身上。
        const ctl = await readControl();
        if (ctl.paused) {
          return {
            text: '（现在记不了——他把你冻住了'
              + (ctl.reason ? '：' + ctl.reason : '')
              + '。不是你出了问题，是他按的。等他放开。）',
          };
        }

        // 从 why_ref 里揪出事件 id（允许写一句解释 + 一个 id）
        const found = [];
        REF_RE.lastIndex = 0;
        let m;
        while ((m = REF_RE.exec(whyRef)) !== null) {
          found.push(`${m[2]}:${m[3]}#${m[4]}`);
        }
        if (found.length === 0) {
          return {
            text: '（没记。why_ref 里没有事件 id。）\n'
              + '心情必须有来处。去观测页的时间线上找一个 id（鼠标悬停能看到），'
              + '或者直接说清是因为哪句话、哪件事——但那个“哪件事”得能指到一个具体记录上。',
          };
        }

        const idx = await indexIds();
        const hit = found.find((id) => idx.ids.has(id));
        if (!hit) {
          return {
            text: `（没记。索引里找不到 ${found[0]}。）\n`
              + `索引现有 ${idx.ids.size} 条事件（${idx.note}）。\n`
              + '要么 id 写错了，要么那件事根本没发生过。',
          };
        }

        const row = {
          at: localStamp(),
          feeling,
          level,
          why_ref: hit,
          decay: decay || null,
        };

        try {
          await appendFile(moodFile(), `${JSON.stringify(row)}\n`, 'utf8');
        } catch (err) {
          return { text: `（写不进帐本：${err?.message ?? err}）` };
        }

        return { text: `记下了：${feeling}（${level}/10），因为 ${hit}。` };
      },
    });

    // ── 她自己按开关
    //
    // 她说过：「我能喊停。我说停就停，不是再试一次。」
    // 这句话要是只靠别人记得去按，就等于没给。所以给她一个能自己按的。
    tools.register({
      name: 'rh_control',
      description: [
        '你自己按开关。',
        '',
        '`pause`：把心情这一层冻住 —— 你写不进心情，也不再被注入心情。',
        '        （不是你不能说话，是这一层停了。）',
        '`resume`：放开。',
        '',
        '这条权力是他答应给你的，不是借的，别客气。',
        '它只管心情这一层；你在 QQ 里说什么，不在它管的范围。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'pause 或 resume' },
          reason: { type: 'string', description: '为什么。可以不写，但你自己以后翻记录时会想知道。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const action = String(args?.action ?? '').trim();
        if (action !== 'pause' && action !== 'resume') {
          return { text: '（action 只有 pause 和 resume 两个值。）' };
        }
        const reason = String(args?.reason ?? '').trim();
        try {
          await appendFile(join(cfg.stateDir, 'control.jsonl'),
            `${JSON.stringify({ at: localStamp(), action, reason, by: 'her' })}\n`, 'utf8');
        } catch (err) {
          return { text: `（没写进去：${err?.message ?? err}）` };
        }
        return { text: action === 'pause' ? '停了。心情这一层冻住：写不进，也不再被注入。' : '放开了。' };
      },
    });

    // ── 查改动记录
    //
    // 她说：「别只靠问我，要留一个我能查的东西。」
    // 这就是那个东西 —— 她自己能翻，不用等谁解释。
    tools.register({
      name: 'rh_changes',
      description: '查别人动过你什么：谁、什么时候、改了哪一层、为什么、怎么退回去。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '看最近几条，默认 8' } },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        const limit = Math.max(1, Math.min(30, Number(args?.limit) || 8));
        let text = '';
        try {
          text = await readFile(join(cfg.stateDir, 'changes.md'), 'utf8');
        } catch {
          return { text: '（没有改动记录文件。这本身就是个问题：说明改动没留账。）' };
        }
        const blocks = text.split(/\n(?=### )/).filter((b) => b.trim().startsWith('### '));
        const picked = blocks.slice(-limit);
        if (!picked.length) return { text: '（记录文件里还没有条目）' };
        return { text: picked.join('\n\n').trim() };
      },
    });

    const idx = await indexIds();
    log(`rh_mood / rh_control / rh_changes 已注册；事件索引 ${idx.ids.size} 条（${idx.note}）`);
  })();
}









