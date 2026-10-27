#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""realhuman · 原生会话读取

读 dsh 自己的会话包，把「他说的」和「她说的」抽出来。

为什么不读 `data/history/*.jsonl`：那份只记下了系统注入（Time sampled / runtime context），
他说的话一句都没有。而原生会话包里全都在。

包的位置：`~/.dsh/sessions/--<cwd 转义>--/<session-id>/session.v4.jsonl.zstd`
（zstd 压缩的 jsonl，一行一个事件）

关键格式（实测）：napcat 通道投递的消息是「前情 + 新话」拼在一起的：

    [这一段的前情（同一个会话，刚断过；接着上面聊，别当新话题）]
    · 你：…… ／ 本鱼：……
    ……
    [本轮消息]
    <他这次说的话>

所以取最后一处 `[本轮消息]` 之后的部分。没有这个标记的就不是新话，跳过。

用法：
  python3 rh_native.py --probe      看抽出了什么
  python3 rh_native.py --count 7    近 7 天各抽到多少条
"""

import argparse
import datetime as dt
import json
import os
import subprocess

SESS_ROOT = os.path.expanduser('~/.dsh/sessions')

HEAR_MARK = '[本轮消息]'
HEAR_KIND = 'plugin:dsh-napcat'


def session_packages(days=None):
    """(会话 id, 包路径, mtime)。只收 mtime 在窗口内的。"""
    if not os.path.isdir(SESS_ROOT):
        return []
    cutoff = None
    if days is not None:
        cutoff = dt.datetime.now().timestamp() - days * 86400
    out = []
    for group in os.listdir(SESS_ROOT):
        gdir = os.path.join(SESS_ROOT, group)
        if not os.path.isdir(gdir):
            continue
        try:
            names = os.listdir(gdir)
        except OSError:
            continue
        for name in names:
            path = os.path.join(gdir, name, 'session.v4.jsonl.zstd')
            if not os.path.exists(path):
                continue
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if cutoff is not None and mtime < cutoff:
                continue
            out.append((name, path, mtime))
    out.sort(key=lambda x: x[2], reverse=True)
    return out


def rows_of(path):
    """解 zstd 并逐行解析。zstd 不在就返回空 —— 不拿假数据充数。"""
    try:
        proc = subprocess.run(['zstd', '-dc', path], capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0:
        return []
    out = []
    for raw in proc.stdout.decode('utf-8', 'replace').splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            out.append(json.loads(raw))
        except Exception:
            continue
    return out


def content_list(obj):
    """user 的在 data.content；assistant 的多包一层 —— data.message.content。"""
    data = obj.get('data') or {}
    content = data.get('content')
    if isinstance(content, list):
        return content
    msg = data.get('message')
    if isinstance(msg, dict):
        inner = msg.get('content')
        if isinstance(inner, list):
            return inner
    return []


def text_of(obj):
    """只取 type=text 段。reasoning / tool-call 一律不取 —— 那是过程，不是说的话。"""
    parts = []
    for c in content_list(obj):
        if not isinstance(c, dict):
            continue
        if c.get('type') == 'text':
            parts.append(str(c.get('text') or ''))
        elif c.get('type') in ('image', 'file'):
            parts.append('[图片]')
    return '\n'.join(parts).strip()


def source_kind(obj):
    return str(((obj.get('data') or {}).get('source') or {}).get('kind') or '')


def turn_message(text):
    """取最后一处「本轮消息」之后的部分。没标记就是 None（那是前情，不是新话）。"""
    idx = text.rfind(HEAR_MARK)
    if idx < 0:
        return None
    body = text[idx + len(HEAR_MARK):].strip()
    return body or None


def to_dt(ms):
    if not isinstance(ms, (int, float)):
        return None
    try:
        return dt.datetime.fromtimestamp(ms / 1000.0).astimezone()
    except (ValueError, OSError, OverflowError):
        return None


def read_native(days=7):
    """返回事件列表，kind ∈ {hear, say}。id 形如 n:<会话尾号>#<seq>。"""
    events = []
    for sid, path, _mtime in session_packages(days=days):
        tag = sid[-8:]
        for obj in rows_of(path):
            typ = obj.get('type')
            seq = obj.get('seq')
            at = to_dt(obj.get('time'))
            if at is None:
                continue
            if typ == 'user/message':
                if source_kind(obj) != HEAR_KIND:
                    continue
                body = turn_message(text_of(obj))
                if body is None:
                    continue
                events.append({
                    'id': 'n:%s#%s' % (tag, seq),
                    'sid': tag,
                    'at': at,
                    'kind': 'hear',
                    'injected': False,
                    'chars': len(body),
                    'text': body,
                })
            elif typ == 'assistant/message':
                body = text_of(obj)
                if not body:
                    continue
                events.append({
                    'id': 'n:%s#%s' % (tag, seq),
                    'sid': tag,
                    'at': at,
                    'kind': 'say',
                    'injected': False,
                    'chars': len(body),
                    'text': body,
                })
    events.sort(key=lambda e: e['at'])
    return events


def probe():
    events = read_native(days=7)
    print('events: %d' % len(events))
    print('hear: %d   say: %d' % (
        sum(1 for e in events if e['kind'] == 'hear'),
        sum(1 for e in events if e['kind'] == 'say')))
    print()
    print('last 6 listen:')
    for e in [x for x in events if x['kind'] == 'hear'][-6:]:
        print('  [%s] %s  %s' % (e['id'], e['at'].strftime('%m-%d %H:%M'), repr(e['text'][:110])))
    print()
    print('last 3 said:')
    for e in [x for x in events if x['kind'] == 'say'][-3:]:
        print('  [%s] %s  %s' % (e['id'], e['at'].strftime('%m-%d %H:%M'), repr(e['text'][:90])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--probe', action='store_true')
    ap.add_argument('--count', type=int, default=0)
    args = ap.parse_args()
    if args.count:
        events = read_native(days=args.count)
        buckets = {}
        for e in events:
            day = e['at'].date().isoformat()
            b = buckets.setdefault(day, {'hear': 0, 'say': 0})
            b[e['kind']] += 1
        for day in sorted(buckets, reverse=True):
            print('%s  hear=%-3d say=%-3d' % (day, buckets[day]['hear'], buckets[day]['say']))
        return
    probe()


if __name__ == '__main__':
    main()
