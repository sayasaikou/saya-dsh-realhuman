/**
 * pending 账本 —— 事件流水是唯一真相源，pending.md 只是它的渲染。
 *
 * 为什么这样分（2026-10-28 定）：
 *   · 兑现耗时、续接率都需要「加行时刻」和「勾掉时刻」，markdown 勾选框不带这两个；
 *   · 但又不能把 pending.md 改成数据库 —— 那份文件是给人读的，也是她自己翻的地方；
 *   · 所以：文件保持人读，三个动作（add / check / drop）各落一条事件，文件由事件渲染。
 *
 * 硬约束（她定的，逐条落在这里）：
 *   1. 必须能从流水回放出与 pending.md 等价的文件，逐行比对一致 —— `render(replay(ev))`；
 *   2. 每条事件记：行文本指纹(8 位) + 行号 + 动作 + 时刻 + 轮次 + 佐证 id；
 *      定位靠指纹，**行号只是给人看的**（插行会漂移，指纹不会）；
 *   3. 存量条目先做基线导入，标 at_unknown=true —— 否则它们永远进不了兑现耗时，
 *      还会看起来像「从没兑现过」；
 *   4. 兑现耗时取中位数，成对记录 < 5 条报「样本不足」；
 *   5. 续接率 K=10，按同一会话内轮次算，跨会话不混；分子只算有佐证 id 的勾，
 *      没佐证的记 claimed_done，永不进分子。
 *
 * 这个文件不碰磁盘、不碰 ctx：纯函数，能单独测（见 test/pending.test.mjs）。
 */
import { createHash } from 'node:crypto';

export const K_ROUNDS = 10;
export const MEDIAN_MIN_PAIRS = 5;
export const CONTINUATION_MIN_DENOM = 10;

/** 行文本指纹：8 位。归一化掉首尾空白与内部连续空白，避免同一个意思两个指纹。 */
export function fingerprint(text) {
  const norm = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!norm) return '';
  return createHash('sha1').update(norm, 'utf8').digest('hex').slice(0, 8);
}

/** 空状态 */
export function emptyState() {
  return { items: [] }; // 顺序即渲染顺序
}

function findIndex(state, ref) {
  const r = String(ref ?? '').trim();
  if (!r) return -1;
  const byFp = state.items.findIndex((it) => it.fp === r || it.fp.startsWith(r));
  if (byFp >= 0) return byFp;
  // 行号只是给人看的：真正定位靠指纹，数字只作为兜底入口
  if (/^\d+$/.test(r)) {
    const n = Number(r);
    if (n >= 1 && n <= state.items.length) return n - 1;
  }
  return -1;
}

/** 应用一条事件，返回新状态（不改入参）。非法事件返回 null。 */
export function applyEvent(state, ev) {
  const next = { items: state.items.map((it) => ({ ...it })) };
  const action = String(ev?.action ?? '');
  const fp = String(ev?.fp ?? '') || fingerprint(ev?.text);

  if (action === 'add') {
    if (!fp || !String(ev?.text ?? '').trim()) return null;
    if (next.items.some((it) => it.fp === fp)) return null; // 同一句话不重复进队
    next.items.push({
      fp,
      text: String(ev.text).trim(),
      added_at: String(ev.at ?? ''),
      at_unknown: ev.at_unknown === true,
      checked_at: null,
      claimed_done: false,
      evidence: null,
      turn: Number.isInteger(ev.turn) ? ev.turn : null,
      session: ev.session ?? null,
    });
    return next;
  }

  const i = findIndex(next, ev?.ref ?? fp);
  if (i < 0) return null;

  if (action === 'check') {
    const it = next.items[i];
    if (it.checked_at) return null; // 已经勾过
    it.checked_at = String(ev.at ?? '');
    it.evidence = ev.evidence ? String(ev.evidence) : null;
    it.claimed_done = !it.evidence; // 没佐证的勾：单列，不进续接率分子
    return next;
  }

  if (action === 'drop') {
    next.items.splice(i, 1);
    return next;
  }

  return null;
}

/** 从事件流水回放出状态 */
export function replay(events) {
  let state = emptyState();
  for (const ev of events) {
    const next = applyEvent(state, ev);
    if (next) state = next;
  }
  return state;
}

/** 渲染成人读的 markdown —— 这是 pending.md 的唯一写法 */
export function render(state) {
  if (!state.items.length) return '# 没完的事\n\n（空着。）\n';
  const lines = ['# 没完的事', ''];
  for (const it of state.items) {
    lines.push(`- [${it.checked_at ? 'x' : ' '}] ${it.text}`);
  }
  return lines.join('\n') + '\n';
}

/** 回放校验：渲染结果与磁盘内容逐行一致才算数 */
export function matchesFile(events, fileText) {
  return render(replay(events)) === String(fileText ?? '');
}

// ── 三个量 ──────────────────────────────────────────────────────────────

/** 未完成条数。只报数，不评价。 */
export function unfinishedCount(state) {
  return state.items.filter((it) => !it.checked_at).length;
}

/** 兑现耗时中位数（小时）。样本不足只报样本量。 */
export function fulfillMedian(state) {
  const pairs = [];
  let unknownStart = 0;
  for (const it of state.items) {
    if (!it.checked_at) continue;
    if (it.at_unknown) {
      unknownStart += 1;
      continue;
    }
    const a = Date.parse(it.added_at);
    const b = Date.parse(it.checked_at);
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) continue;
    pairs.push((b - a) / 3600000);
  }
  const out = { unknownStart, n: pairs.length, insufficient: false };
  if (pairs.length < MEDIAN_MIN_PAIRS) {
    out.insufficient = true;
    return out;
  }
  pairs.sort((x, y) => x - y);
  const mid = Math.floor(pairs.length / 2);
  out.medianHours = pairs.length % 2 ? pairs[mid] : (pairs[mid - 1] + pairs[mid]) / 2;
  return out;
}

/**
 * 活着的 add：回放一遍，被 drop 掉的不再计入新增。
 *
 * 2026-10-31：原来直接 rows.filter(e => e.action === 'add')，drop 之后 add 事件
 * 还留在流水里，分母只增不减 —— 测试项自己加的又自己删的，会永久算进「新增」，
 * 把续接率的分母撞起来。drop 可能按 ref 行号定位而不是 fp，所以不能只按 fp 过。
 */
function liveAdds(rows) {
  let state = emptyState();
  const keep = [];
  for (const ev of rows) {
    const next = applyEvent(state, ev);
    if (!next) continue;
    if (ev.action === 'add') keep.push(ev);
    if (ev.action === 'drop') {
      const idx = findIndex(state, ev?.ref ?? String(ev?.fp ?? ''));
      // **只抹没被勾过的**。已经 check 过的那条已经从「新增」走到分子那边了，
      // 事后再 drop 掉不能把分母改小 —— 那等于事后改历史（这条是 2026-10-31 账上定的）。
      if (idx >= 0 && !state.items[idx].checked_at) {
        const fp = String(state.items[idx].fp);
        for (let j = keep.length - 1; j >= 0; j -= 1) {
          if (String(keep[j].fp ?? '') === fp) {
            keep.splice(j, 1);
            break;
          }
        }
      }
    }
    state = next;
  }
  return keep;
}

/**
 * 续接率：K 轮内被勾掉的 ÷ 新增。
 * 只在同一会话内算（跨会话轮次不可比），分子只算有佐证的勾。
 */
export function continuationRate(events, { k = K_ROUNDS, session = null } = {}) {
  const rows = events.filter((e) => (session == null ? true : e.session === session));
  const added = liveAdds(rows);
  const checkedByFp = new Map();
  for (const e of rows) {
    if (e.action !== 'check' || !e.evidence) continue;
    const fpr = String(e.fp ?? '');
    if (fpr) checkedByFp.set(fpr, e);
  }
  let inTime = 0;
  for (const a of added) {
    const c = checkedByFp.get(String(a.fp ?? ''));
    if (!c) continue;
    const ta = Number(a.turn);
    const tc = Number(c.turn);
    if (!Number.isFinite(ta) || !Number.isFinite(tc)) continue;
    if (tc - ta <= k) inTime += 1;
  }
  const claimed = rows.filter((e) => e.action === 'check' && !e.evidence).length;
  const out = { added: added.length, inTime, claimed, k, insufficient: added.length < CONTINUATION_MIN_DENOM };
  if (!out.insufficient) out.rate = inTime / added.length;
  return out;
}

/** 注入用的一段话：只陈述，不给建议、不调行为 */
export function summaryText(state, events, { k = K_ROUNDS } = {}) {
  const lines = ['【没完的事】'];
  lines.push(`未完成 ${unfinishedCount(state)} 条。`);
  const open = state.items.filter((it) => !it.checked_at).slice(-3);
  for (const it of open) {
    const t = Date.parse(it.added_at);
    const ago = Number.isNaN(t) ? '' : `（${Math.max(0, Math.round((Date.now() - t) / 3600000))} 小时前记的）`;
    lines.push(`· ${it.text}${it.at_unknown ? '（起点不明）' : ago}`);
  }
  const med = fulfillMedian(state);
  lines.push(med.insufficient
    ? `兑现耗时：样本不足（n=${med.n}${med.unknownStart ? `，另有 ${med.unknownStart} 条无起点未计入` : ''}）`
    : `兑现耗时中位数：${med.medianHours.toFixed(1)} 小时（n=${med.n}${med.unknownStart ? `，另有 ${med.unknownStart} 条无起点未计入` : ''}）`);
  const rate = continuationRate(events, { k });
  lines.push(rate.insufficient
    ? `续接率：样本不足（新增 ${rate.added} 条，要求 ≥${CONTINUATION_MIN_DENOM}）`
    : `续接率（${k} 轮内）：${(rate.rate * 100).toFixed(0)}%（${rate.inTime}/${rate.added}${rate.claimed ? `，另 ${rate.claimed} 条无佐证的勾不计` : ''}）`);
  lines.push('这些是事实，不是评价。别拿它决定多说话还是少说话。');
  return lines.join('\n');
}
