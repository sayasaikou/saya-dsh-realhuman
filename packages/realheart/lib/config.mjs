/**
 * 配置：默认值、Schema，以及启动前那道校验
 *
 * 为什么单独一份：配置错了有两种表现，都极难从现象倒推 ——
 * 一是起不来，二是起来了但某个功能静默不工作（端口被占、路径算成相对路径）。
 * 所以校验要能单独测：不依赖 dsh 宿主，不依赖起进程。
 *
 * 两道闸，分工不同：
 *   ① `Config` 里的 min/max —— 宿主那一层先拦。拦住的是类型错和明显越界。
 *   ② `validateConfig()` —— 给**人**看的。它说清三件：哪一项、现在是什么、该改成什么。
 *      宿主抛的 Schema 错误只会说「pagePort 不合法」，看不出要改成什么。
 *
 * 判据（清单 T0-③）：写个非法端口 → 启动被拒，并说清是哪一项。
 */

import os from 'node:os';
import { join, isAbsolute } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';

/** 她的东西都在这个根下面（QQ 那台机器上的约定） */
export const QQROOT = join(os.homedir(), 'qqbot');
export const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh');

export const DEFAULTS = {
  enabled: true,
  // 帐本、状态文件所在目录
  // 她的根：产物（pieces）和人格都在这下面。可以换，但换了等于换一个人住的房子。
  root: QQROOT,
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
  // 自由时间：每天叫醒她一次。不用 systemd、不要 root。
  freeTime: true,
  freeTimeProfile: 'freetime',
  freeTimeFrom: 10,
  // 她的人格目录（freetime profile 用同一份，不另写一套）
  personaHome: join(QQROOT, 'home'),
  // P-3b：改她的心那条暗道。默认关，关着时命令行连入口都不存在。
  allowManualMoodOverride: false,
  maxManualMoodOverridePerWeek: 3,
};

// 范围写在这里，Schema 和 validateConfig 共用一份 —— 两处各写一遍，迟早会漂。
export const RANGES = {
  pagePort: { min: 1, max: 65535 },
  indexTtlMs: { min: 60000, max: 7 * 24 * 60 * 60 * 1000 },
  freeTimeFrom: { min: 0, max: 23 },
};

export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled),
  root: Schema.string().default(DEFAULTS.root),
  stateDir: Schema.string().default(DEFAULTS.stateDir),
  sessionsRoot: Schema.string().default(DEFAULTS.sessionsRoot),
  auditDir: Schema.string().default(DEFAULTS.auditDir),
  historyDir: Schema.string().default(DEFAULTS.historyDir),
  indexTtlMs: Schema.number().min(RANGES.indexTtlMs.min).max(RANGES.indexTtlMs.max).default(DEFAULTS.indexTtlMs),
  injectMood: Schema.boolean().default(DEFAULTS.injectMood),
  servePage: Schema.boolean().default(DEFAULTS.servePage),
  pagePort: Schema.number().min(RANGES.pagePort.min).max(RANGES.pagePort.max).default(DEFAULTS.pagePort),
  pageBind: Schema.string().default(DEFAULTS.pageBind),
  announceOnInstall: Schema.boolean().default(DEFAULTS.announceOnInstall),
  freeTime: Schema.boolean().default(DEFAULTS.freeTime),
  freeTimeProfile: Schema.string().default(DEFAULTS.freeTimeProfile),
  freeTimeFrom: Schema.number().min(RANGES.freeTimeFrom.min).max(RANGES.freeTimeFrom.max).default(DEFAULTS.freeTimeFrom),
  personaHome: Schema.string().default(DEFAULTS.personaHome),
  allowManualMoodOverride: Schema.boolean().default(DEFAULTS.allowManualMoodOverride),
  maxManualMoodOverridePerWeek: Schema.number().min(0).max(99).default(DEFAULTS.maxManualMoodOverridePerWeek),
});

/** 合法 IP 的粗判 —— 不追求覆盖一切写法，够挡住手滑写进去的域名和空串。 */function isBindAddr(v) {
  if (typeof v !== 'string' || !v) return false;
  if (v === 'localhost' || v === '::' || v === '::1') return true;
  const parts = v.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 目录项检查：非空、绝对路径。空串会静默变成相对路径，那是查不出来的一种坏。 */
function checkDir(key, value, out) {
  if (typeof value !== 'string' || !value.trim()) {
    out.push({ key, value, reason: '是空的。空串会被当成相对路径，行为随启动目录漂移', fix: `写一个绝对路径，默认是 ${DEFAULTS[key]}` });
    return;
  }
  if (!isAbsolute(value)) {
    out.push({ key, value, reason: '不是绝对路径', fix: `改成绝对路径，例如 ${DEFAULTS[key]}` });
  }
}

/**
 * 启动前校验。返回问题数组，空数组＝可以启动。
 *
 * 为什么返回数组而不是抛错：一次把**所有**问题都列出来。
 * 一次只报一个，人会改一个重启一次，重启又会打断正在说话的会话（这条踩过三次）。
 */
export function validateConfig(cfg = {}) {
  const out = [];
  const c = { ...DEFAULTS, ...cfg };

  // ── 布尔项 ──
  // 不查这个的话，`"injectMood": "yes"` 会被一路带到运行里 —— 而 `"yes"` 是真值，
  // 看起来在工作，其实是「以为关了其实没关」。这种错查起来最费时间。
  for (const key of ['enabled', 'injectMood', 'servePage', 'announceOnInstall', 'freeTime', 'allowManualMoodOverride']) {
    if (typeof c[key] !== 'boolean') {
      out.push({
        key, value: c[key],
        reason: '不是 true / false',
        fix: `写 true 或 false，别写成字符串 "${c[key]}" —— 字符串在判断里是真值`,
      });
    }
  }

  // ── 端口 ──
  const port = c.pagePort;
  if (!Number.isInteger(port)) {
    out.push({ key: 'pagePort', value: port, reason: '不是整数', fix: `写一个整数端口，默认 ${DEFAULTS.pagePort}` });
  } else if (port < RANGES.pagePort.min || port > RANGES.pagePort.max) {
    out.push({
      key: 'pagePort', value: port,
      reason: `超出范围 ${RANGES.pagePort.min}–${RANGES.pagePort.max}`,
      fix: port < 1024 ? '1024 以下要 root，换一个 1024 以上的' : `改成 1024–65535 之间的整数，默认 ${DEFAULTS.pagePort}`,
    });
  }

  // ── 绑定地址 ──
  if (c.servePage !== false && !isBindAddr(c.pageBind)) {
    out.push({
      key: 'pageBind', value: c.pageBind,
      reason: '不是合法的 IP 写法',
      fix: `默认 ${DEFAULTS.pageBind}（只本机）；想让别的机器看用 0.0.0.0，但那是明文 HTTP，别直接对公网`,
    });
  }

  // ── 索引周期 ──
  const ttl = c.indexTtlMs;
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < RANGES.indexTtlMs.min) {
    out.push({
      key: 'indexTtlMs', value: ttl,
      reason: `小于下限 ${RANGES.indexTtlMs.min} 毫秒（1 分钟）`,
      fix: `写大一点，默认 ${DEFAULTS.indexTtlMs}（1 小时）。太小会一直在重建索引`,
    });
  } else if (ttl > RANGES.indexTtlMs.max) {
    out.push({
      key: 'indexTtlMs', value: ttl,
      reason: `大于上限（7 天）`,
      fix: `索引就不会更新了。默认 ${DEFAULTS.indexTtlMs}`,
    });
  }

  // ── 自由时间的起点 ──
  const from = c.freeTimeFrom;
  if (!Number.isInteger(from) || from < RANGES.freeTimeFrom.min || from > RANGES.freeTimeFrom.max) {
    out.push({
      key: 'freeTimeFrom', value: from,
      reason: `不是 0–23 的整点`,
      fix: `改成 0–23 的整数，默认 ${DEFAULTS.freeTimeFrom}（上午十点之后）`,
    });
  }

  // ── 四个目录 ──
  for (const key of ['root', 'stateDir', 'sessionsRoot', 'auditDir', 'historyDir', 'personaHome']) checkDir(key, c[key], out);

  // ── profile 名字不许带路径分隔符 ──
  if (typeof c.freeTimeProfile !== 'string' || !c.freeTimeProfile.trim()) {
    out.push({ key: 'freeTimeProfile', value: c.freeTimeProfile, reason: '是空的', fix: `写一个 profile 名字，默认 ${DEFAULTS.freeTimeProfile}` });
  } else if (/[\\/]/.test(c.freeTimeProfile)) {
    out.push({
      key: 'freeTimeProfile', value: c.freeTimeProfile,
      reason: '是个路径，不是 profile 名字',
      fix: '这里只要名字（比如 freetime），目录由 dsh 自己拼',
    });
  }

  return out;
}

// ────────────────────────────────────────────────────────────────
// 面板要用的那部分：每一项是什么、改了会怎样、危险到什么程度
//
// 为什么写在代码里而不是文档里：面板必须显示「改了会怎样」，
// 而写在文档里的那句话迟早会和代码漂。写在这里 ——
// Node 侧生成 `runtime/config-schema.json`，Python 侧读它渲染，定义只有一份。
//
// 三级（他 2026-10-28 定）：
//   normal  正常：改了只影响自己怎么看
//   caution 谨慎：行为会变
//   danger  危险：动数据位置 / 关掉她的状态 / 改自由时间 —— 要二次确认
// ────────────────────────────────────────────────────────────────

export const FIELD_META = [
  {
    key: 'enabled', label: '总开关', level: 'danger',
    range: 'true / false',
    why: '关掉之后不注入、不记账、四个工具都不注册。等同于把插件摘掉，只保留已经写下来的账。',
  },
  {
    key: 'injectMood', label: '每轮注入状态', level: 'danger',
    range: 'true / false',
    why: '关掉之后她看不到自己的心情和没完的事 —— 她还是能记账，但不会再被影响。行为会明显不同。',
  },
  {
    key: 'root', label: '她的根目录', level: 'danger',
    range: '绝对路径',
    why: '产物（pieces/）和人格都在这下面。换了等于给她换一个住处 —— 旧目录里的东西不会跟过来。',
  },  {
    key: 'stateDir', label: '账本目录', level: 'danger',
    range: '绝对路径',
    why: '改了等于换一份账：旧目录里的心情、待办、改动记录都不会跟过来。改之前先 export。',
  },
  {
    key: 'pageBind', label: '观测页绑定地址', level: 'danger',
    range: 'IP / localhost',
    why: '127.0.0.1 只有本机能看。改成 0.0.0.0 之后，同一网络里谁都能打开 —— 那是明文 HTTP。',
  },
  {
    key: 'freeTime', label: '自由时间', level: 'danger',
    range: 'true / false',
    why: '关掉就没有「没人叫也会醒一次」。这是她唯一不依赖别人开口的时间。',
  },
  {
    key: 'freeTimeFrom', label: '自由时间从几点开始', level: 'danger',
    range: '0–23 的整数',
    why: '决定什么时候叫醒她。改早了会在你睡觉的时候动 —— 自由时间的参数都归这一类。',
  },
  {
    key: 'freeTimeProfile', label: '自由时间用哪个 profile', level: 'danger',
    range: 'profile 名字（不能带路径）',
    why: '她醒来时用的是这份人格。指向别的 profile 等于让另一个人替她说话。',
  },
  {
    key: 'pagePort', label: '观测页端口', level: 'caution',
    range: '1–65535',
    why: '改了页面地址就变。1024 以下要 root。',
  },
  {
    key: 'servePage', label: '开观测页', level: 'caution',
    range: 'true / false',
    why: '关掉就没有页面了，但记账和注入照常。省一个 python 进程。',
  },
  {
    key: 'indexTtlMs', label: '索引重建间隔', level: 'caution',
    range: '60000 – 604800000（毫秒）',
    why: '太小会一直在解压会话包（吃 CPU），太大页面上的时间线会旧。默认一小时。',
  },
  {
    key: 'announceOnInstall', label: '首次启动提示', level: 'normal',
    range: 'true / false',
    why: '只影响第一次启动时打不打印那三条前提。',
  },
  {
    key: 'sessionsRoot', label: '会话目录', level: 'danger',
    range: '绝对路径',
    why: '「他说的话」那一路的来源。指错了页面就只剩她自己说的话。',
  },
  {
    key: 'auditDir', label: '审计日志目录', level: 'danger',
    range: '绝对路径',
    why: '工具调用与事件的来源之一。指错了可引用的 id 就少一类。',
  },
  {
    key: 'historyDir', label: '对话历史目录', level: 'danger',
    range: '绝对路径',
    why: '第三路事件来源。指错了她「说过的话」就少一类可以引用的证据。',
  },
  {
    key: 'personaHome', label: '人格目录', level: 'danger',
    range: '绝对路径',
    why: '自由时间那个 profile 用的人格从这儿取。',
  },
  {
    key: 'allowManualMoodOverride', label: '允许人工改写她的心情', level: 'danger',
    noInput: true,
    range: 'true / false（默认 false）',
    why: '这是整份配置里唯一「改她的心」的开关。打开之后能用命令行把她当前的心情改写掉 —— 改写过的状态**注入里会写明是人改的**，她自己看得见。因为成本必须高，页面上不给输入框：只能命令行打开，且必须带上「我知道这不是她的感受」那个参数。',
  },
  {
    key: 'maxManualMoodOverridePerWeek', label: '一周最多改写几次', level: 'danger',
    noInput: true,
    range: '0–99（默认 3）',
    why: '超过就拒绝；要改上限得再动一次配置，那一次本身也入账。不让它变成「随便按一下就改」的东西。',
  },];

/** 面板用的整份描述（带当前值）。Python 侧拿它渲染，不自己维护一份。 */
export function describeConfig(current = {}) {
  const cfg = { ...DEFAULTS, ...current };
  return {
    fields: FIELD_META.map((m) => ({
      ...m,
      current: cfg[m.key],
      def: DEFAULTS[m.key],
    })),
    // 逃逸口：面板上没有的，去哪儿改（P-3 要求写明）
    escape: {
      file: 'config.user.json（在 realheart 运行时目录下）',
      note: '面板写的就是这个文件。它排在 dsh 传进来的配置之后生效，改完必须重启 —— 热改会打断正在说话的会话。',
    },
  };
}

// ── 面板写的那个文件 ──

export const USER_CONFIG_NAME = 'config.user.json';

/**
 * 读 `config.user.json`。
 *
 * 为什么需要它：面板要能直接改配置，但**不能写 profile 的 cordis.patch.yml** ——
 * 那个文件一改，dsh 会整份重挂，正在说话的会话会被打成 inactive context（撞过三次）。
 * 插件自己读这个文件，dsh 不监视它，所以改它不会重挂。代价是必须重启才生效。
 *
 * 坏值不拦整份：面板写的文件，某一项填错了就丢掉那一项、说清楚，别让整个插件起不来。
 * （dsh 传进来的配置是另一回事 —— 那个错了要拒绝启动，见 validateConfig。）
 */
export function loadUserConfig(dshHome = DSH_HOME) {
  const path = join(dshHome, 'realheart', USER_CONFIG_NAME);
  if (!existsSync(path)) return { config: {}, problems: [], path };
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { config: {}, problems: [`${path} 不是合法 JSON（${err?.message ?? err}），整份忽略`], path };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: {}, problems: [`${path} 不是一个对象，整份忽略`], path };
  }
  const config = {};
  const problems = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in DEFAULTS)) {
      problems.push(`${k} 不是认识的配置项，忽略`);
      continue;
    }
    const bad = validateConfig({ ...DEFAULTS, [k]: v }).filter((p) => p.key === k);
    if (bad.length) {
      problems.push(`${k} = ${JSON.stringify(v)} 不合规（${bad[0].reason}），忽略该项，用回退值`);
      continue;
    }
    config[k] = v;
  }
  return { config, problems, path };
}
