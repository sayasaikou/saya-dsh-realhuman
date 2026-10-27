#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rh-ctl —— 她的控制开关

给你用的。不是网页上的按钮 —— 写操作不走那个明文页面（口令在 URL 里），
走命令行，你能看到自己敲了什么，也能被 shell 历史记住。

用法：
  python3 rh-ctl.py status                 看现在是什么状态
  python3 rh-ctl.py pause --reason "..."   停：冻结心情（她写不进去，也不再注入）
  python3 rh-ctl.py resume --reason "..."  继续
  python3 rh-ctl.py void 3 --reason "..."  作废第 3 笔心情（行号从 1 开始）
  python3 rh-ctl.py log                    看全部操作记录

为什么是账本而不是改配置：
  账本只增不改，谁在什么时候按了什么、为什么，全在文件里。
  改配置只能看到"现在是关的"，看不到"谁关的、什么时候关的"。

为什么作废不是删除：
  删除就把“她当时为什么这么想”也一起抹掉了。
  作废是“这笔我不认”，原记录留着，只是不算数。
"""

import argparse
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

STATE_DIR = os.environ.get('RH_STATE_DIR', os.path.expanduser('~/qqbot/work/realheart'))
CONTROL = os.path.join(STATE_DIR, 'control.jsonl')
MOOD_LOG = os.path.join(STATE_DIR, 'mood.jsonl')


def now_stamp():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def read_lines(path):
    out = []
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            for n, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if isinstance(obj, dict):
                    out.append((n, obj))
    except FileNotFoundError:
        return []
    except OSError as exc:
        print('读不到 %s：%s' % (path, exc), file=sys.stderr)
        return []
    return out


def state():
    """（冻结吗, 为什么, 什么时候, 作废了哪几笔）"""
    entries = read_lines(CONTROL)
    paused = False
    reason = ''
    at = ''
    voided = {}
    for _n, obj in entries:
        action = obj.get('action')
        if action == 'pause':
            paused, reason, at = True, str(obj.get('reason') or ''), str(obj.get('at') or '')
        elif action == 'resume':
            paused, reason, at = False, str(obj.get('reason') or ''), str(obj.get('at') or '')
        elif action == 'void':
            try:
                target = int(obj.get('target'))
            except (TypeError, ValueError):
                continue
            voided[target] = str(obj.get('reason') or '')
    return paused, reason, at, voided


def append(entry):
    os.makedirs(STATE_DIR, exist_ok=True)
    entry = {'at': now_stamp(), **entry}
    with open(CONTROL, 'a', encoding='utf-8') as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + '\n')
    return entry


def mood_count():
    return len(read_lines(MOOD_LOG))


def cmd_status(_args):
    paused, reason, at, voided = state()
    print('状态：%s' % ('已冻结' if paused else '正常'))
    if at:
        print('  最后一次操作：%s　%s' % (at, reason or '（没写原因）'))
    print('心情帐本：%d 笔' % mood_count())
    if voided:
        print('已作废：%s' % '、'.join('第 %d 笔' % k for k in sorted(voided)))
        for k in sorted(voided):
            print('  第 %d 笔：%s' % (k, voided[k] or '（没写原因）'))


def cmd_pause(args):
    entry = append({'action': 'pause', 'reason': args.reason or '', 'by': 'owner'})
    print('停了。她写不进心情，也不再被注入心情。')
    print('账本记了一笔：%s' % entry['at'])


def cmd_resume(args):
    append({'action': 'resume', 'reason': args.reason or '', 'by': 'owner'})
    print('恢复了。')


def cmd_void(args):
    total = mood_count()
    if total == 0:
        print('心情帐本是空的，没东西可作废。', file=sys.stderr)
        return 2
    if args.index < 1 or args.index > total:
        print('行号要落在 1-%d 之间（现在共 %d 笔）。' % (total, total), file=sys.stderr)
        return 2
    append({'action': 'void', 'target': args.index, 'reason': args.reason or '', 'by': 'owner'})
    print('第 %d 笔作废了。原记录还在，只是不算数。' % args.index)


def cmd_log(_args):
    entries = read_lines(CONTROL)
    if not entries:
        print('还没有任何操作记录。')
        return
    for n, obj in entries:
        print('%s  %-7s %s  %s' % (
            obj.get('at', ''), obj.get('action', ''),
            ('第 %s 笔' % obj.get('target')) if obj.get('target') is not None else '',
            obj.get('reason') or ''))


def main():
    ap = argparse.ArgumentParser(description='她的控制开关')
    sub = ap.add_subparsers(dest='cmd')

    p = sub.add_parser('status', help='看状态')
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser('pause', help='停')
    p.add_argument('--reason', default='')
    p.set_defaults(fn=cmd_pause)

    p = sub.add_parser('resume', help='继续')
    p.add_argument('--reason', default='')
    p.set_defaults(fn=cmd_resume)

    p = sub.add_parser('void', help='作废某一笔心情')
    p.add_argument('index', type=int)
    p.add_argument('--reason', default='')
    p.set_defaults(fn=cmd_void)

    p = sub.add_parser('log', help='看操作记录')
    p.set_defaults(fn=cmd_log)

    args = ap.parse_args()
    if not getattr(args, 'fn', None):
        ap.print_help()
        return 1
    return args.fn(args) or 0


if __name__ == '__main__':
    sys.exit(main())

