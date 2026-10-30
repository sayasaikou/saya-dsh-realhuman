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
import Schema from '@deepseek-ai/schemastery';

/** 她的东西都在这个根下面（QQ 那台机器上的约定） */
export const QQROOT = join(os.homedir(), 'qqbot');
export const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh');

export const DEFAULTS = {
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
  // 自由时间：每天叫醒她一次。不用 systemd、不要 root。
  freeTime: true,
  freeTimeProfile: 'freetime',
  freeTimeFrom: 10,
  // 她的人格目录（freetime profile 用同一份，不另写一套）
  personaHome: join(QQROOT, 'home'),
};

// 范围写在这里，Schema 和 validateConfig 共用一份 —— 两处各写一遍，迟早会漂。
export const RANGES = {
  pagePort: { min: 1, max: 65535 },
  indexTtlMs: { min: 60000, max: 7 * 24 * 60 * 60 * 1000 },
  freeTimeFrom: { min: 0, max: 23 },
};

export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled),
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
});

/** 合法 IP 的粗判 —— 不追求覆盖一切写法，够挡住手滑写进去的域名和空串。 */
function isBindAddr(v) {
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
  for (const key of ['stateDir', 'sessionsRoot', 'auditDir', 'historyDir', 'personaHome']) checkDir(key, c[key], out);

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
