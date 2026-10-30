/**
 * 删除的留痕（M1-9 定案的落地）
 *
 * 定案是：**她的四个工具里不加删除动作** —— 记账的人不能同时握毁账的权。
 * 能够删的是人，走唯一入口，删之前必写一条标记，而**标记本身也算一种记录**。
 *
 * 关键一点：**标记写在被删内容之外**（`$DSH_HOME/realheart/forget-log.md`）。
 * 写在里面就自相矛盾 —— 删完连「删过什么」都一起没了。
 *
 * 为什么这条值得单独一个文件：删除是不可逆的，而「删除 ≠ 遗忘」这件事
 * 只能靠一条留在删除之外的记录来证明。没有这条记录，删掉就等于篡改历史。
 */

import { mkdir, appendFile, stat, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const FORGET_LOG_NAME = 'forget-log.md';

export function forgetLogPath(dshHome) {
  return join(dshHome, 'realheart', FORGET_LOG_NAME);
}

/** 一条标记长什么样。纯函数 —— 好测，也好让以后别的入口复用。 */
export function renderForgetEntry({ at, scope, target, inventory, why, by = '命令行' }) {
  const lines = [
    '',
    `## ${at} · 删了${scope ? ` ${scope}` : ''}`,
    '',
    `- 范围：\`${target}\``,
    `- 原来有什么：${inventory || '（空目录）'}`,
    `- 为什么：${why && why.trim() ? why.trim() : '（没写）'}`,
    `- 谁删的：${by}`,
    `- ⚠️ 内容是删掉的，这条标记**不在被删的东西里** —— 它是唯一还剩下的一句。`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * 描述「将要删的东西」：文件数、总大小、头几个名字。
 *
 * 为什么记清单而不记内容：记内容是备份，不是留痕 —— 那又是另一件事了。
 * 这里只回答「删掉了什么」，够对账就行。
 */
export async function inventoryOf(target, { head = 8 } = {}) {
  let st;
  try {
    st = await stat(target);
  } catch {
    return '';
  }
  if (st.isFile()) return `1 个文件，${st.size} B`;
  let names = [];
  try {
    names = await readdir(target);
  } catch {
    return '目录（读不全）';
  }
  const shown = names.slice(0, head).join('、');
  const more = names.length > head ? ` 等 ${names.length} 个` : `（共 ${names.length} 个）`;
  return `${names.length} 项${names.length ? `：${shown}${more}` : ''}`;
}

/** 追加一条标记。写不了就抛 —— 删之前写不上标记，就不该删。 */
export async function appendForget(dshHome, entry) {
  const path = forgetLogPath(dshHome);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, entry, 'utf8');
  return path;
}
