#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""realhuman · 事件索引

只读。把磁盘上已有的两路记录归并成一条可引用的时间线：

  · `data/history/*.jsonl`  —— 对话（user / assistant 两侧，由通道插件写）
  · `data/audit/<day>.jsonl` —— 工具调用（由 qqbot 的审计钩子写）

不新建采集器、不落第二份数据。理由：一份数据只能有一个真相源，
再抄一遍就会出现「索引和原记录对不上」这类没法排的账。

每条事件有个稳定 id（会话尾号 + 行号 / 日期 + 行号），后面给
「心情必须指一件事」当引用池用。文件只追加，行号不会漂。

用法：
  python3 rh_index.py --probe              看两路数据的真实形状
  python3 rh_index.py --dump <会话尾号>    逐行看一个会话
  python3 rh_index.py --stats 7            近 7 天统计
  python3 rh_index.py --events 20          最近 20 条时间线
"""

import argparse
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

try:
    import rh_native          # 原生会话包：他说的话只在这里
    _NATIVE_ERR = ''
except Exception as _exc:
    rh_native = None
    _NATIVE_ERR = str(_exc)

ROOT = os.path.expanduser('~/qqbot')
HISTORY = os.path.join(ROOT, 'data', 'history')
AUDIT = os.path.join(ROOT, 'data', 'audit')

# 这些串只在「系统注入」里出现，真人的话不会这么写。
INJECT_MARKS = (
    'Time sampled while preparing',
    'system-reminder',
    '<available_skills>',
    'Current runtime context',
    'Instructions from:',
    'Elapsed since the preceding',
    'Browser time zone for this request',
)

LATE_FROM = 23   # 23:00 以后算深夜
LATE_TO = 6


def iter_jsonl(path):
    """(行号, 对象)。坏行跳过，但不假装它不存在。"""
    try:
        fh = open(path, 'r', encoding='utf-8', errors='replace')
    except OSError:
        return
    with fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict):
                yield n, obj


def parse_ts(value):
    """吃 ISO（带 Z / 带偏移）或毫秒数，一律返回本地时区的 datetime。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return dt.datetime.fromtimestamp(value / 1000.0 if value > 1e11 else value)
    s = str(value).strip()
    if not s:
        return None
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    try:
        parsed = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed
    return parsed.astimezone()


def looks_injected(text):
    """系统注入冒充成人话，就把它标出来。宁可错标，也不能把注入当成他说的。"""
    if not text:
        return False
    head = text.lstrip()[:400]
    for mark in INJECT_MARKS:
        if mark in head:
            return True
    return False


def short_sid(sid):
    """会话尾号。取末 8 位 —— 前段（napcat-private-<你的QQ号>-）全都一样，
    拿它做 id 前缀会让不同会话撞成同一个。"""
    return sid[-8:]


def session_files(days=None):
    try:
        names = [n for n in os.listdir(HISTORY) if n.endswith('.jsonl')]
    except OSError:
        return []
    cutoff = None
    if days is not None:
        cutoff = dt.datetime.now().timestamp() - days * 86400
    out = []
    for name in names:
        path = os.path.join(HISTORY, name)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if cutoff is not None and mtime < cutoff:
            continue
        out.append((name[:-6], path, mtime))
    out.sort(key=lambda x: x[2], reverse=True)
    return out


def read_history(days=7):
    events = []
    for sid, path, _mtime in session_files(days=days):
        tag = short_sid(sid)
        for n, obj in iter_jsonl(path):
            role = obj.get('role')
            if role not in ('user', 'assistant'):
                continue
            text = obj.get('text')
            if not isinstance(text, str):
                continue
            at = parse_ts(obj.get('ts') or obj.get('at'))
            if at is None:
                continue
            events.append({
                'id': 'h:%s#%d' % (tag, n),
                'sid': tag,
                'line': n,
                'at': at,
                'kind': 'say' if role == 'assistant' else 'hear',
                'injected': role == 'user' and looks_injected(text),
                'chars': len(text),
                'text': text,
            })
    return events


def read_audit(days=7):
    events = []
    for offset in range(days):
        day = (dt.date.today() - dt.timedelta(days=offset)).isoformat()
        path = os.path.join(AUDIT, day + '.jsonl')
        for n, obj in iter_jsonl(path):
            at = parse_ts(obj.get('atLocal') or obj.get('at'))
            if at is None:
                continue
            events.append({
                'id': 'a:%s#%d' % (day, n),
                'at': at,
                'kind': 'tool',
                'tool': str(obj.get('tool') or '?'),
                'ok': obj.get('ok'),
                'source': str(obj.get('source') or ''),
                'text': peek_args(obj.get('args')),
            })
    return events


def peek_args(args):
    if not isinstance(args, dict):
        return ''
    kept = args.get('kept')
    if isinstance(kept, dict):
        for k in ('description', 'command', 'path', 'file_path', 'query', 'url'):
            v = kept.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip().replace('\n', ' ')[:110]
    for k in ('description', 'path', 'file_path', 'query'):
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip().replace('\n', ' ')[:110]
    return ''


def collect(days=7):
    """三路合并，原生包优先。

    为什么原生包优先：`data/history` 那份只记下了系统注入，他说的话一句都没有（
    2026-10-27 实测）。原生会话包里才有真对话。

    去重口径：时间到分钟 + 类型 + 文本前 100 字。两路对同一条消息可能差几秒，
    所以不比到秒 —— 宁可多合并一条，也不能让同一句话在页面上出现两遍。
    """
    native = []
    if rh_native is not None:
        try:
            native = rh_native.read_native(days=days)
        except Exception:
            native = []
    merged = []
    seen = set()
    for e in native + read_history(days=days) + read_audit(days=days):
        key = (e['at'].strftime('%Y-%m-%dT%H:%M'), e['kind'], (e.get('text') or '')[:100])
        if key in seen:
            continue
        seen.add(key)
        merged.append(e)
    merged.sort(key=lambda e: e['at'])
    return merged


def merge_turns(events):
    """把同一个会话里连续的 assistant 行并成一个「一次回话」。

    为什么需要：assistant 在 history 里不是一回合一行 —— 带工具调用的回合会落多行，
    直接数行会把「她回了几句」数成几倍。合并口径：同一会话、相邻 assistant 行、
    间隔短于 10 分钟，算一次。
    """
    out = []
    for e in events:
        prev = out[-1] if out else None
        if (prev is not None and e['kind'] == 'say' and prev.get('kind') == 'say'
                and prev.get('sid') == e.get('sid')
                and (e['at'] - prev['last_at']).total_seconds() < 600):
            prev['chars'] += e['chars']
            prev['parts'] += 1
            prev['last_at'] = e['at']
            prev['last_id'] = e['id']
            continue
        item = dict(e)
        item['parts'] = 1
        item['last_at'] = e['at']
        item['last_id'] = e['id']
        out.append(item)
    return out


def stats(days=7):
    """按天：他的原话、她回了几次、她动了几次手、从几点到几点。

    先按事件自己的时间过一遍，再按天分桶 —— 只按文件 mtime 过滤不够：
    一个老会话文件可能被追加过，里面既有今天的行，也有上周的行。
    """
    cutoff = dt.datetime.now().astimezone() - dt.timedelta(days=days)
    buckets = {}
    for e in merge_turns(collect(days=days)):
        if e['at'] < cutoff:
            continue
        day = e['at'].date().isoformat()
        bucket = buckets.setdefault(day, {
            'day': day, 'heard': 0, 'said': 0, 'tools': 0, 'injected': 0,
            'first': None, 'last': None, 'late': 0, 'said_chars': 0, 'tool_fail': 0,
        })
        hour = e['at'].hour
        if hour >= LATE_FROM or hour < LATE_TO:
            bucket['late'] += 1
        if bucket['first'] is None or e['at'] < bucket['first']:
            bucket['first'] = e['at']
        if bucket['last'] is None or e['at'] > bucket['last']:
            bucket['last'] = e['at']
        if e['kind'] == 'tool':
            bucket['tools'] += 1
            if e.get('ok') is False:
                bucket['tool_fail'] += 1
        elif e['kind'] == 'say':
            bucket['said'] += 1
            bucket['said_chars'] += e['chars']
        else:
            if e.get('injected'):
                bucket['injected'] += 1
            else:
                bucket['heard'] += 1
    rows = [buckets[k] for k in sorted(buckets, reverse=True)]
    for row in rows:
        row['first'] = row['first'].strftime('%H:%M') if row['first'] else ''
        row['last'] = row['last'].strftime('%H:%M') if row['last'] else ''
    return rows


def probe(dump_tag=None):
    if dump_tag:
        for sid, path, mtime in session_files():
            if not sid.endswith(dump_tag) and dump_tag not in sid:
                continue
            print('== %s (%s)' % (sid, dt.datetime.fromtimestamp(mtime).strftime('%m-%d %H:%M')))
            for n, obj in iter_jsonl(path):
                at = parse_ts(obj.get('ts') or obj.get('at'))
                role = obj.get('role')
                text = obj.get('text')
                text = text if isinstance(text, str) else ''
                inject = 'INJ' if looks_injected(text) else '   '
                print('  #%-4d %s %-9s %s %4d  %s' % (
                    n,
                    at.strftime('%m-%d %H:%M') if at else '??',
                    role,
                    inject,
                    len(text),
                    repr(text[:70])))
        return

    print('root:', ROOT)
    print('history files:')
    for sid, path, mtime in session_files()[:10]:
        n = 0
        roles = {}
        for _n, obj in iter_jsonl(path):
            n += 1
            r = obj.get('role')
            roles[r] = roles.get(r, 0) + 1
        print('  %-48s tag=%-8s lines=%-5d %s' % (sid, short_sid(sid), n, roles))
    print()
    ids = {}
    for e in collect(days=3):
        ids[e['id']] = ids.get(e['id'], 0) + 1
    dup = [k for k, v in ids.items() if v > 1]
    print('event ids: %d total, %d duplicated' % (len(ids), len(dup)))
    if dup:
        print('  dup sample:', dup[:5])
    print()
    print('stats:')
    for row in stats(days=7):
        print('  %s heard=%-3d said=%-3d tools=%-3d inject=%-3d late=%-3d %s-%s' % (
            row['day'], row['heard'], row['said'], row['tools'],
            row['injected'], row['late'], row['first'], row['last']))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe', action='store_true')
    ap.add_argument('--dump', default='')
    ap.add_argument('--stats', type=int, default=0)
    ap.add_argument('--events', type=int, default=0)
    args = ap.parse_args()

    if args.dump:
        probe(dump_tag=args.dump)
        return
    if args.probe:
        probe()
        return
    if args.stats:
        for row in stats(days=args.stats):
            print(json.dumps(row, ensure_ascii=False))
        return
    if args.events:
        for e in merge_turns(collect(days=3))[-args.events:]:
            print(json.dumps({
                'id': e['id'],
                'at': e['at'].strftime('%m-%d %H:%M'),
                'kind': e['kind'],
                'parts': e.get('parts', 1),
                'text': e['text'][:100],
            }, ensure_ascii=False))
        return
    ap.print_help()


if __name__ == '__main__':
    main()

