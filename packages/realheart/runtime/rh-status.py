#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""realheart · 只读观测页

一个独立的小服务：把磁盘上真实存在的状态文件读出来，摆成一张网页。
它自己不依赖 dsh —— dsh 挂了它也还在。

只读。没有任何写入口，非 GET/HEAD 一律 405。

安全前提：页面里就是她的私人状态，所以
  · 只有 /<secret>/ 下的路径有响应，其它一律 404（常数时间比较）
  · 页头 no-store / noindex / 禁止被别处内嵌
  · 请求路径不写日志（路径里就是口令）
  · 读不到的文件如实说读不到，不编一个占位值

配置：config.json {"port": 8098, "bind": "127.0.0.1", "secret": "...", "root": "~/qqbot"}
"""

import hmac
import html
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 掉线判据只此一处（和救码页共用）。放在 qqbot/lib/ 下，两个服务都能拿到。
_LIB = HERE  # 打包后 rh_napcat.py 就在同目录
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)
import rh_napcat

# 索引模块单独一份：它只用标准库、不依赖本文件，以后搬进 dsh 插件能直接复用。
try:
    import rh_index
    _INDEX_ERR = ''
except Exception as _exc:      # 索引挂了不能拖垮整张页，但要如实说挂了
    rh_index = None
    _INDEX_ERR = str(_exc)

CONFIG_PATH = os.path.join(HERE, 'config.json')

_cfg = json.load(open(CONFIG_PATH, encoding='utf-8'))
PORT = int(_cfg.get('port', 8098))
BIND = str(_cfg.get('bind', '127.0.0.1'))
SECRET = str(_cfg['secret']).encode('utf-8', 'surrogateescape')
ROOT = os.path.expanduser(str(_cfg.get('root', '~/qqbot')))

MEM = os.path.join(ROOT, 'work', 'MEMORY')
HOME = os.path.join(ROOT, 'home')
AUDIT = os.path.join(ROOT, 'data', 'audit')
MEMES = os.path.join(MEM, 'my-memes')


# ---------------------------------------------------------------- 读文件

def read_text(path):
    """(text, err)。读不到就 err 不是空，不拿空字符串冒充内容。"""
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as fh:
            return fh.read(), ''
    except FileNotFoundError:
        return None, '不存在'
    except IsADirectoryError:
        return None, '是个目录'
    except Exception as exc:
        return None, type(exc).__name__


def stat_of(path):
    try:
        st = os.stat(path)
        return {'size': st.st_size, 'mtime': st.st_mtime}
    except OSError:
        return None


def age_of(ts):
    if not ts:
        return ''
    d = max(0, int(time.time() - ts))
    if d < 60:
        return '%d 秒前' % d
    if d < 3600:
        return '%d 分钟前' % (d // 60)
    if d < 86400:
        return '%d 小时前' % (d // 3600)
    return '%d 天前' % (d // 86400)


def stamp(ts):
    return time.strftime('%m-%d %H:%M', time.localtime(ts)) if ts else ''


# ---------------------------------------------------------------- 解析

def parse_mood(text):
    """mood.md 是 markdown 列表，形如 `- 情绪：...`。取键值，续行并上去。"""
    fields = {}
    order = []
    key = None
    for raw in text.splitlines():
        line = raw.rstrip()
        s = line.strip()
        if not s or s.startswith('#') or s.startswith('>'):
            key = None
            continue
        m = re.match(r'^[-*]\s*([^\uff1a:]{1,12})[\uff1a:]\s*(.*)$', s)
        if m:
            key = m.group(1).strip()
            fields[key] = m.group(2).strip()
            order.append(key)
            continue
        if key:
            fields[key] += s
    return [{'key': k, 'text': fields[k]} for k in order if fields.get(k)]


def mood_intensity(fields):
    for f in fields:
        if f['key'] in ('强度', '浓度'):
            m = re.search(r'(\d+)\s*/\s*(\d+)', f['text'])
            if m:
                return int(m.group(1)), int(m.group(2))
            m = re.search(r'(\d+)', f['text'])
            if m:
                return int(m.group(1)), 10
    return None


def parse_pending(text):
    items = []
    for line in text.splitlines():
        m = re.match(r'^\s*[-*]\s*\[( |x|X)\]\s*(.+)$', line)
        if m:
            items.append({'done': m.group(1).lower() == 'x', 'text': m.group(2).strip()})
    return items


def parse_sections(text):
    """把 markdown 按 ## 切开，给页面做目录用。"""
    out = []
    cur = {'title': '', 'lines': []}
    for line in text.splitlines():
        if line.startswith('## '):
            if cur['title'] or cur['lines']:
                out.append(cur)
            cur = {'title': line[3:].strip(), 'lines': []}
        else:
            cur['lines'].append(line)
    if cur['title'] or cur['lines']:
        out.append(cur)
    return out


def section_items(lines, limit):
    items = []
    for line in lines:
        s = line.strip()
        if s.startswith('- '):
            items.append(s[2:].strip())
        if len(items) >= limit:
            break
    return items


def recent_audit(limit=18):
    day = time.strftime('%Y-%m-%d')
    path = os.path.join(AUDIT, day + '.jsonl')
    text, err = read_text(path)
    if text is None:
        return [], err
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        rows.append({
            'at': str(obj.get('atLocal') or obj.get('at') or ''),
            'tool': str(obj.get('tool') or '?'),
            'source': str(obj.get('source') or ''),
            'ok': obj.get('ok'),
            'peak': _peek_args(obj.get('args')),
        })
    return rows[-limit:], ''


def _peek_args(args):
    """从审计的 args 里挑一条能看懂的一行摘要。只挑，不解析。"""
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


def count_files(path):
    try:
        with os.scandir(path) as it:
            n = 0
            newest = 0.0
            for entry in it:
                if entry.is_file():
                    n += 1
                    try:
                        newest = max(newest, entry.stat().st_mtime)
                    except OSError:
                        pass
            return n, newest
    except FileNotFoundError:
        return None, 0.0
    except OSError:
        return None, 0.0


NAPCAT_WEBUI = os.path.expanduser('~/napcatrun/napcat/config/webui.json')


def napcat_status():
    """薄包装 —— 真正的判断在 `lib/rh_napcat.py`。

    为什么不再自己写一套：2026-10-27 一天里，同一件事在三个地方各判各的，
    两个方向都错过（先误判在线、又误判掉线）。判据只能有一处，
    观测页和救码页共用，改一处两边一起变。
    """
    try:
        return rh_napcat.login_state()
    except Exception as exc:
        return {'online': None, 'why': '', 'has_qr': False, 'phase': '',
                'recent_talk': False, 'note': type(exc).__name__}


def last_talk_mtime():
    """她最后一次说话 / 有人跟她说话是什么时候。取 history 里最新文件的时间。"""
    newest = 0.0
    try:
        with os.scandir(os.path.join(ROOT, 'data', 'history')) as it:
            for entry in it:
                if not entry.name.endswith('.jsonl'):
                    continue
                try:
                    newest = max(newest, entry.stat().st_mtime)
                except OSError:
                    pass
    except OSError:
        return None
    return newest or None


def sysinfo():
    out = {}
    try:
        with open('/proc/uptime') as fh:
            secs = float(fh.read().split()[0])
        out['uptime'] = '%d 天 %d 小时' % (secs // 86400, (secs % 86400) // 3600)
    except Exception:
        out['uptime'] = ''
    out['mem_avail'] = None
    try:
        with open('/proc/meminfo') as fh:
            for line in fh:
                if line.startswith('MemAvailable:'):
                    out['mem_avail'] = int(line.split()[1]) // 1024
                    break
    except Exception:
        pass
    try:
        r = subprocess.run(['systemctl', 'is-active', 'qqbot'], capture_output=True, text=True, timeout=4)
        out['svc'] = r.stdout.strip() or '?'
    except Exception:
        out['svc'] = '?'
    ver, _ = read_text(os.path.join(ROOT, 'VERSION'))
    out['version'] = (ver or '').strip() or '?'
    return out


# ---------------------------------------------------------------- 渲染

CSS = """
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0e1014;color:#e6e8ec;
font:15px/1.65 system-ui,-apple-system,"Segoe UI","Noto Sans CJK SC",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:26px 18px 60px}
header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:22px}
h1{font-size:22px;margin:0;font-weight:650;letter-spacing:.5px}
.sub{color:#8b929c;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}
.card{background:#161920;border:1px solid #222832;border-radius:14px;padding:18px 18px 16px}
.card h2{font-size:13px;margin:0 0 12px;color:#9aa3b0;font-weight:600;letter-spacing:1.2px}
.mood{font-size:26px;font-weight:600;line-height:1.35;margin:2px 0 10px}
.bar{height:6px;border-radius:99px;background:#242a34;overflow:hidden;margin:6px 0 12px}
.bar>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#5a9cf8,#8ad8a8)}
.kv{display:flex;gap:10px;font-size:13.5px;color:#b9c0ca;margin:5px 0}
.kv b{color:#7d8797;font-weight:500;min-width:66px;flex:none}
ul.list{list-style:none;margin:0;padding:0}
ul.list li{display:flex;gap:9px;padding:7px 0;border-bottom:1px solid #1d222b;font-size:14px}
ul.list li:last-child{border-bottom:0}
.box{width:15px;height:15px;border:1.5px solid #3b4453;border-radius:4px;flex:none;margin-top:3px}
.box.done{background:#2f6b48;border-color:#2f6b48;position:relative}
.box.done:after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;
border:2px solid #d6f5e3;border-top:0;border-left:0;transform:rotate(42deg)}
.done-text{color:#6f7885;text-decoration:line-through}
.row{display:flex;justify-content:space-between;gap:12px;font-size:13.5px;padding:6px 0;border-bottom:1px solid #1d222b}
.row:last-child{border-bottom:0}
.row span:last-child{color:#8b929c;text-align:right}
.tag{display:inline-block;font-size:11.5px;padding:1px 6px;border-radius:99px;background:#232a35;color:#9fb0c6;margin-left:6px}
.muted{color:#6f7885;font-size:12.5px}
.err{color:#e0796a;font-size:13px}
p.note{margin:10px 0 0;color:#6f7885;font-size:12.5px}
footer{margin-top:26px;color:#5c6472;font-size:12.5px;text-align:center}
a{color:#6ea8fe;text-decoration:none}
.wide{grid-column:1/-1}
.wk{display:grid;grid-template-columns:52px 1fr 1fr 1fr 1.6fr;gap:8px;
font-size:13.5px;padding:5px 0;border-bottom:1px solid #1d222b;
font-variant-numeric:tabular-nums;align-items:baseline}
.wk span:not(:first-child){text-align:right}
.wk span:last-child{text-align:right}
.wk.head{color:#6f7885;font-size:12px;border-bottom-color:#2a3140}
.wk:last-of-type{border-bottom:0}
.tlrow{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid #1d222b;
font-size:13.5px;align-items:baseline}
.tlrow:last-of-type{border-bottom:0}
.tlwhen{color:#6f7885;font-variant-numeric:tabular-nums;flex:none;width:78px}
.badge{flex:none;font-size:11px;padding:0 7px;border-radius:99px;border:1px solid #2c3441;
color:#8fa0b8;line-height:1.7}
.badge.say{color:#8ad8a8;border-color:#2b4a37}
.badge.hear{color:#8fb4f0;border-color:#2b3f5e}
.badge.tool{color:#c9b079;border-color:#4a3f28}
.tltext{color:#c6ccd6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
"""


def esc(s):
    return html.escape(str(s), quote=True)


def render_mood():
    path = os.path.join(MEM, 'mood.md')
    text, err = read_text(path)
    st = stat_of(path)
    meta = ''
    if st:
        meta = '· 改于 %s（%s）' % (stamp(st['mtime']), age_of(st['mtime']))
    if text is None:
        return ('<div class="card"><h2>她现在 · 状态</h2><p class="err">读不到这个文件：%s</p>'
                '</div>' % esc(err))
    fields = parse_mood(text)
    if not fields:
        return ('<div class="card"><h2>她现在 · 状态</h2>'
                '<p class="err">文件在，但没解析出条目（格式变了？）</p></div>')

    mood_text = ''
    parts = []
    inten = mood_intensity(fields)
    for f in fields:
        k = f['key']
        if k in ('情绪', '状态'):
            mood_text = f['text']
            continue
        if k in ('强度', '浓度'):
            continue
        parts.append('<div class="kv"><b>%s</b><span>%s</span></div>' % (esc(k), esc(f['text'])))

    out = []
    if mood_text:
        out.append('<div class="mood">%s</div>' % esc(mood_text))
    if inten:
        cur, mx = inten
        pct = int(max(0, min(100, cur * 100.0 / max(1, mx))))
        out.append('<div class="bar"><i style="width:%d%%"></i></div>' % pct)
        out.append('<div class="muted">强度 %d / %d</div>' % (cur, mx))
    out.extend(parts)
    return ('<div class="card"><h2>她现在 · 状态</h2>%s'
            '<p class="note">来自 <span class="muted">work/MEMORY/mood.md</span> %s</p></div>' % (
                ''.join(out), meta))


MOOD_LOG = os.path.join(ROOT, 'work', 'realheart', 'mood.jsonl')


def read_mood_ledger():
    """心情帐本：一行一笔，追加式。读不到返回 (None, err)。"""
    text, err = read_text(MOOD_LOG)
    if text is None:
        return None, err
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows, ''


def _fmt_at(value):
    """2026-10-27T13:49:52+08:00 -> 10-27 13:49"""
    s = str(value or '')
    if len(s) >= 16 and s[4] == '-':
        return s[5:10] + ' ' + s[11:16]
    return s


def _lv(row):
    try:
        return int(row.get('level') or 0)
    except (TypeError, ValueError):
        return 0


CONTROL_LOG = os.path.join(ROOT, 'work', 'realheart', 'control.jsonl')


def read_control():
    """控制账本 →(冻结吗, 原因, 作废了哪几笔)。

    没这个文件就是正常状态 —— 不报错、不提示，因为她本来就是自由的。
    """
    text, _err = read_text(CONTROL_LOG)
    if text is None:
        return False, '', {}
    paused, reason, voided = False, '', {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        action = obj.get('action')
        if action == 'pause':
            paused, reason = True, str(obj.get('reason') or '')
        elif action == 'resume':
            paused, reason = False, str(obj.get('reason') or '')
        elif action == 'void':
            try:
                target = int(obj.get('target'))
            except (TypeError, ValueError):
                continue
            voided[target] = str(obj.get('reason') or '')
    return paused, reason, voided


def render_mood_ledger():
    """心情帐本。有数据就看帐本，没数据就说没开张 —— 不拿旧文件冒充新机制。"""
    rows, err = read_mood_ledger()
    paused, pause_reason, voided = read_control()
    src = '<span class="muted">work/realheart/mood.jsonl</span>'

    banner = ''
    if paused:
        banner = ('<p style="margin:0 0 12px;padding:8px 12px;border-radius:8px;'
                  'background:#3a1f1f;color:#ffb3a7;font-size:13px">已冻结%s'
                  '　—— 她写不进心情，也不再被注入心情。</p>' % (
                      ('：' + esc(pause_reason)) if pause_reason else ''))

    if rows is None:
        return ('<div class="card"><h2>心情帐本</h2>%s'
                '<p class="muted">还没开张（%s）。等她第一次用 rh_mood 记一笔。</p>'
                '<p class="note">帐本在 %s，一行一笔，只增不改。写成必须有来处：'
                'why_ref 里那个事件 id 在索引里找不到，就写不进去。</p></div>' % (
                    banner, esc(err), src))
    if not rows:
        return ('<div class="card"><h2>心情帐本</h2>%s'
                '<p class="muted">文件在，还是空的。</p></div>' % banner)

    total = len(rows)
    last = rows[-1]
    level = _lv(last)
    dead_last = total in voided

    out = [banner]
    out.append('<div class="mood">%s</div>' % esc(last.get('feeling') or '—'))
    out.append('<div class="bar"><i style="width:%d%%"></i></div>' % max(0, min(100, level * 10)))
    out.append('<div class="muted">强度 %d / 10　·　第 %d 笔</div>' % (level, total))
    out.append('<div class="kv"><b>来处</b><span>%s</span></div>' % esc(last.get('why_ref') or '—'))
    if last.get('decay'):
        out.append('<div class="kv"><b>什么时候淡</b><span>%s</span></div>' % esc(last['decay']))
    out.append('<div class="kv"><b>记于</b><span>%s</span></div>' % esc(_fmt_at(last.get('at'))))
    if dead_last:
        out.append('<p class="err">这一笔已经作废%s —— 她下次开口不会再看到它，但记录还在。</p>' % (
            ('：' + esc(voided[total])) if voided.get(total) else ''))

    history = rows[-11:-1]
    if history:
        lis = []
        for k, r in enumerate(reversed(history)):
            idx = total - 1 - k
            dead = idx in voided
            lis.append('<div class="row"><span%s>%s　%s</span>'
                       '<span class="muted">%s / %d%s</span></div>' % (
                           ' class="done-text"' if dead else '',
                           esc(_fmt_at(r.get('at'))), esc(r.get('feeling') or ''),
                           esc(r.get('why_ref') or ''), _lv(r),
                           '　已作废' if dead else ''))
        out.append('<p class="note" style="margin-top:14px">之前 %d 笔</p>' % len(history))
        out.extend(lis)

    out.append('<p class="note">共 %d 笔 · 来自 %s</p>' % (total, src))
    return '<div class="card"><h2>心情帐本</h2>%s</div>' % ''.join(out)


FREE_LOG = os.path.join(ROOT, 'work', 'realheart', 'free-time.jsonl')


def read_free_time():
    """自由时间帐本 →(叫醒记录, 她自己记的)。

    两笔分开，因为「叫了她没动」和「根本没叫」是两回事：
    混成一笔就分不出是懒了还是坏了。
    """
    text, err = read_text(FREE_LOG)
    if text is None:
        return None, err
    wakes, dones = [], []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        if obj.get('kind') == 'wake':
            wakes.append(obj)
        elif obj.get('activity') or obj.get('kind') == 'done':
            dones.append(obj)
    return (wakes, dones), ''


_SILENT_CACHE = {'at': 0.0, 'value': None}


def silent_stats():
    """她说过几次「这轮不说」。

    数据来自通道的出站流水（`<会话>/napcat-inbox/_outbound.log`），
    里面每笔静默都带原因。0 次也是一种信息：权力给了，她一次没用过。

    45 秒缓存 —— 那个文件有几百 KB，不能每次请求都全文扫。
    """
    now = time.time()
    if _SILENT_CACHE['value'] is not None and now - _SILENT_CACHE['at'] < 45:
        return _SILENT_CACHE['value']

    total = 0
    fuse = 0
    last_reason = ''
    found = False
    base = os.path.join(ROOT, 'napcat')
    try:
        for entry in os.scandir(base):
            if not entry.is_dir():
                continue
            log = os.path.join(entry.path, 'napcat-inbox', '_outbound.log')
            if not os.path.exists(log):
                continue
            found = True
            try:
                with open(log, encoding='utf-8', errors='replace') as fh:
                    for line in fh:
                        if '[silent]' in line:
                            total += 1
                            last_reason = line.strip()
                        elif '[保险丝]' in line:
                            fuse += 1
            except OSError:
                continue
    except OSError:
        return None

    value = None if not found else {'silent': total, 'fuse': fuse, 'last': last_reason}
    _SILENT_CACHE.update({'at': now, 'value': value})
    return value


def render_free_time():
    got, err = read_free_time()
    if got is None:
        return ('<div class="card"><h2>自由时间</h2>'
                '<p class="muted">还没跑过（%s）。</p>'
                '<p class="note">定时器每天上午随机一个时刻把她叫醒一次。'
                '叫醒归叫醒，干不干是她的事。</p></div>' % esc(err))

    wakes, dones = got
    out = ['<div class="row"><span>被叫醒</span><span>%d 次</span></div>' % len(wakes),
           '<div class="row"><span>自己记下</span><span>%d 次</span></div>' % len(dones)]

    ss = silent_stats()
    if ss is not None:
        line = '<div class="row"><span>选择不说</span><span>%d 次' % ss['silent']
        if ss['fuse']:
            line += ' · 保险丝 %d' % ss['fuse']
        line += '</span></div>'
        out.append(line)

    if dones:
        last = dones[-1]
        out.append('<div class="kv"><b>最近一次</b><span>%s</span></div>' % esc(
            _fmt_at(last.get('ts') or last.get('at'))))
        act = str(last.get('activity') or '').strip()
        if act:
            out.append('<div class="kv"><b>干了什么</b><span>%s</span></div>' % esc(act))
        told = last.get('told_saya')
        if told is True:
            out.append('<div class="kv"><b>说了吗</b><span>说了</span></div>')
        elif told is False:
            why = str(last.get('why_not') or '').strip()
            out.append('<div class="kv"><b>说了吗</b><span>没说%s</span></div>' % (
                ('：' + esc(why)) if why else ''))

    # 她留下的东西
    try:
        files = []
        with os.scandir(os.path.join(ROOT, 'work', 'realheart')) as it:
            for entry in it:
                if entry.is_file() and not entry.name.endswith(('.jsonl', '.log')):
                    try:
                        files.append((entry.stat().st_mtime, entry.name))
                    except OSError:
                        files.append((0.0, entry.name))
        files.sort(reverse=True)
        if files:
            out.append('<p class="note" style="margin-top:12px">她留下的东西</p>')
            for mtime, name in files[:6]:
                out.append('<div class="row"><span>%s</span><span class="muted">%s</span></div>' % (
                    esc(name), esc(stamp(mtime))))
    except OSError:
        pass

    out.append('<p class="note">来自 <span class="muted">work/realheart/free-time.jsonl</span>'
               '　·　叫醒归叫醒，干不干是她的事。</p>')
    return '<div class="card"><h2>自由时间</h2>%s</div>' % ''.join(out)


def render_pending():
    path = os.path.join(MEM, 'pending.md')
    text, err = read_text(path)
    st = stat_of(path)
    meta = ('· 改于 %s（%s）' % (stamp(st['mtime']), age_of(st['mtime']))) if st else ''
    if text is None:
        body = '<p class="err">读不到这个文件：%s</p>' % esc(err)
    else:
        items = parse_pending(text)
        if not items:
            body = '<p class="muted">现在是空的。</p>'
        else:
            li = []
            for it in items:
                li.append('<li><i class="box%s"></i><span class="%s">%s</span></li>' % (
                    ' done' if it['done'] else '',
                    'done-text' if it['done'] else '',
                    esc(it['text'])))
            opened = sum(1 for i in items if not i['done'])
            body = '<ul class="list">%s</ul><p class="note">%d 条未完成 / 共 %d 条</p>' % (
                ''.join(li), opened, len(items))
    return ('<div class="card"><h2>没完的事</h2>%s<p class="note">来自 '
            '<span class="muted">work/MEMORY/pending.md</span> %s</p></div>' % (body, meta))


def render_memes():
    n, newest = count_files(MEMES)
    if n is None:
        body = '<div class="row"><span>表情包</span><span>目录还没建</span></div>'
    else:
        body = '<div class="row"><span>表情包</span><span>%d 张%s</span></div>' % (
            n, (' · 最近 ' + age_of(newest)) if newest else '')

    pieces = os.path.join(ROOT, 'work', 'pieces')
    pn, pnew = count_files(pieces)
    body += '<div class="row"><span>作品</span><span>%s</span></div>' % (
        ('%d 件%s' % (pn, (' · 最近 ' + age_of(pnew)) if pnew else '')) if pn is not None
        else '目录还没建')

    # 私下收着的：只看个数，不看内容。
    # 不用真保密 —— 文件就在磁盘上，谁都能开。这一行守的是"不去看"这个约定。
    priv = os.path.join(pieces, 'private')
    pv, pvnew = count_files(priv)
    if pv:
        body += ('<div class="row"><span>私下收着</span>'
                 '<span>%d 件 · 最近 %s</span></div>' % (pv, age_of(pvnew)))
    elif pv == 0:
        body += '<div class="row"><span>私下收着</span><span class="muted">空着</span></div>'

    snaps = os.path.join(MEM, 'snapshots')
    sn, snew = count_files(snaps)
    body += '<div class="row"><span>记忆快照</span><span>%s</span></div>' % (
        ('%d 份 · 最近 %s' % (sn, age_of(snew))) if sn else '—')

    return ('<div class="card"><h2>她自己的东西</h2>%s'
            '<p class="note">表情包在 <span class="muted">work/MEMORY/my-memes/</span>'
            '　·　「私下收着」那一栏只数个数，不列文件，也不点开。</p>'
            '</div>' % body)


def render_audit():
    rows, err = recent_audit()
    if err:
        body = '<p class="muted">今天还没有审计文件（%s）。</p>' % esc(err)
    elif not rows:
        body = '<p class="muted">今天还没有动作。</p>'
    else:
        out = []
        for r in rows:
            at = r['at'][11:19] if len(r['at']) > 18 else r['at']
            mark = ''
            if r['ok'] is True:
                mark = ' <span class="tag">ok</span>'
            elif r['ok'] is False:
                mark = ' <span class="tag" style="background:#3a1f1f;color:#e0796a">fail</span>'
            out.append('<div class="row"><span>%s %s%s</span><span>%s</span></div>' % (
                esc(at), esc(r['tool']), mark, esc(r['peak'])))
        body = ''.join(out)
    return ('<div class="card"><h2>最近在做什么</h2>%s'
            '<p class="note">来自 <span class="muted">data/audit/今天.jsonl</span></p></div>' % body)


def render_shared():
    path = os.path.join(MEM, 'shared.md')
    text, err = read_text(path)
    st = stat_of(path)
    meta = ('· 改于 %s（%s）' % (stamp(st['mtime']), age_of(st['mtime']))) if st else ''
    if text is None:
        return '<div class="card"><h2>共同记忆</h2><p class="err">读不到：%s</p></div>' % esc(err)
    sections = parse_sections(text)
    idx = None
    for s in sections:
        if '索引' in s['title']:
            idx = s
            break
    if idx is None:
        return '<div class="card"><h2>共同记忆</h2><p class="muted">没找到索引段。</p></div>'
    items = section_items(idx['lines'], 12)
    li = ''.join('<li><span>%s</span></li>' % esc(i) for i in items)
    total = len(section_items(idx['lines'], 9999))
    return ('<div class="card"><h2>共同记忆 · 索引</h2><ul class="list">%s</ul>'
            '<p class="note">共 %d 条 %s</p></div>' % (li, total, meta))


def render_self():
    path = os.path.join(HOME, 'self.md')
    text, err = read_text(path)
    st = stat_of(path)
    if text is None:
        return '<div class="card"><h2>她自己写的</h2><p class="err">读不到：%s</p></div>' % esc(err)
    titles = [s['title'] for s in parse_sections(text) if s['title']]
    meta = ''
    if st:
        meta = '改于 %s（%s）· %d 字节' % (stamp(st['mtime']), age_of(st['mtime']), st['size'])
    chips = ''.join('<span class="tag">%s</span>' % esc(t) for t in titles)
    return ('<div class="card"><h2>她自己写的</h2>'
            '<p class="muted">home/self.md · %s</p>'
            '<p style="margin:12px 0 0">%s</p></div>' % (esc(meta), chips))


def render_machine():
    info = sysinfo()
    svc = info['svc']
    if svc == 'active':
        svc_html = '<span class="tag">active</span>'
    else:
        svc_html = '<span class="tag" style="background:#3a1f1f;color:#e0796a">%s</span>' % esc(svc)

    # QQ 登录：这一行才是「她还在不在」。上面那行只是进程在不在。
    nc = napcat_status()
    if nc['online'] is True:
        qq_html = '<span class="tag">在线</span>'
    elif nc['online'] is False:
        qq_html = '<span class="tag" style="background:#3a1f1f;color:#e0796a">掉线</span>'
    else:
        qq_html = '<span class="tag" style="background:#2b2f38;color:#8b929c">查不到</span>'

    talk = last_talk_mtime()
    talk_html = esc(age_of(talk)) if talk else '—'

    rows = [
        ('版本', 'v' + esc(info['version'])),
        ('QQ 登录', qq_html),
        ('qqbot 进程', svc_html),
        ('最后对话', talk_html),
        ('开机', esc(info['uptime'] or '—')),
        ('可用内存', ('%d MB' % info['mem_avail']) if info.get('mem_avail') else '—'),
    ]
    body = ''.join('<div class="row"><span>%s</span><span>%s</span></div>' % (esc(k), v) for k, v in rows)
    note = ''
    if nc['online'] is False:
        note = ('<p class="err">QQ 登录掉了。进程还在、端口也还在，所以只看服务状态会以为是好的。'
                '救法在 qqbot/rescue/（8099 那个扫码页）。</p>')
    elif nc['online'] is None and nc['note']:
        note = '<p class="note">登录状态查不到：%s</p>' % esc(nc['note'])
    return '<div class="card"><h2>机器</h2>%s%s</div>' % (body, note)


_CACHE_TTL = 45
_WEEK_CACHE = {'at': 0.0, 'rows': [], 'err': ''}
_TL_CACHE = {'at': 0.0, 'rows': [], 'err': ''}


def _week_rows():
    """近 7 天统计。45 秒缓存 —— 页面 60 秒刷一次，不要每次都把几万行重扫一遍。"""
    global _WEEK_CACHE
    now = time.time()
    if _WEEK_CACHE['rows'] and now - _WEEK_CACHE['at'] < _CACHE_TTL:
        return _WEEK_CACHE['rows'], ''
    if rh_index is None:
        return [], '索引模块没加载：' + _INDEX_ERR
    try:
        rows = rh_index.stats(days=7)
    except Exception as exc:
        err = '%s: %s' % (type(exc).__name__, exc)
        _WEEK_CACHE = {'at': now, 'rows': [], 'err': err}
        return [], err
    _WEEK_CACHE = {'at': now, 'rows': rows, 'err': ''}
    return rows, ''


def _timeline_rows(limit=22):
    global _TL_CACHE
    now = time.time()
    if _TL_CACHE['rows'] and now - _TL_CACHE['at'] < _CACHE_TTL:
        return _TL_CACHE['rows'], ''
    if rh_index is None:
        return [], '索引模块没加载：' + _INDEX_ERR
    try:
        events = rh_index.merge_turns(rh_index.collect(days=2))[-limit:]
    except Exception as exc:
        err = '%s: %s' % (type(exc).__name__, exc)
        _TL_CACHE = {'at': now, 'rows': [], 'err': err}
        return [], err
    rows = []
    for e in reversed(events):
        if e.get('injected'):
            # 系统注入不是话。宁可这条线稀一点，也不能把提示词当成他说的。
            continue
        rows.append({
            'at': e['at'].strftime('%m-%d %H:%M'),
            'kind': e['kind'],
            'id': e['id'],
            'text': e['text'].replace('\n', ' ').strip()[:140],
        })
    _TL_CACHE = {'at': now, 'rows': rows, 'err': ''}
    return rows, ''


def render_week():
    rows, err = _week_rows()
    if err:
        return '<div class="card wide"><h2>这一周</h2><p class="err">%s</p></div>' % esc(err)
    if not rows:
        return '<div class="card wide"><h2>这一周</h2><p class="muted">这七天没有可读的记录。</p></div>'
    parts = ['<div class="wk head"><span>天</span><span>听到</span><span>她回</span>'
             '<span>动手</span><span>时段</span></div>']
    for r in rows:
        parts.append('<div class="wk"><span>%s</span><span>%d</span><span>%d</span>'
                     '<span>%d</span><span class="muted">%s–%s</span></div>' % (
                         esc(r['day'][5:]), r['heard'], r['said'], r['tools'],
                         esc(r['first']), esc(r['last'])))
    note = ('<p class="note">听到 = 他真说的（注入已剔除）；她回 = 合并后的回话次数；'
            '动手 = 工具调用次数。他那些没被记下来的话，听到会偏低。</p>')
    return '<div class="card wide"><h2>这一周</h2>%s%s</div>' % (''.join(parts), note)


def render_timeline():
    rows, err = _timeline_rows()
    if err:
        return '<div class="card wide"><h2>时间线</h2><p class="err">%s</p></div>' % esc(err)
    if not rows:
        return '<div class="card wide"><h2>时间线</h2><p class="muted">最近两天没有记录。</p></div>'
    marks = {'say': '她说的', 'hear': '他说的', 'tool': '动手'}
    out = []
    for r in rows:
        text = r['text']
        if r['kind'] == 'tool':
            text = text or '（无描述）'
        elif not text:
            text = '（空）'
        out.append('<div class="tlrow"><span class="tlwhen">%s</span>'
                   '<span class="badge %s">%s</span>'
                   '<span class="tltext" title="%s">%s</span></div>' % (
                       esc(r['at'][5:]), esc(r['kind']), esc(marks.get(r['kind'], '?')),
                       esc(r['id']), esc(text)))
    note = ('<p class="note">鼠标悬停能看到事件 id —— 以后她写“因为什么”要指的就是这个。'
            '「他说的」来自会话包的「本轮消息」，「她说的」只取正文，不含思考过程和工具调用。</p>')
    return '<div class="card wide"><h2>时间线</h2>%s%s</div>' % (''.join(out), note)


PAGE = """<!doctype html><html lang="zh"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>她 · 观测页</title>
<style>%(css)s</style>
<div class="wrap">
<header>
  <h1>她</h1>
  <div class="sub">只读观测页 · v%(version)s · 数据时间 %(now)s</div>
</header>
<div class="grid">
%(cards)s
</div>
<footer>每 60 秒自己刷新一次 · 这一页只看不写</footer>
</div>
<script>setTimeout(function(){location.reload()},60000)</script>
</html>"""


def build_page():
    info = sysinfo()
    cards = ''.join([
        render_mood(),
        render_mood_ledger(),
        render_free_time(),
        render_week(),
        render_timeline(),
        render_pending(),
        render_self(),
        render_audit(),
        render_shared(),
        render_memes(),
        render_machine(),
    ])
    return PAGE % {
        'css': CSS,
        'version': esc(info['version']),
        'now': time.strftime('%m-%d %H:%M:%S'),
        'cards': cards,
    }


# ---------------------------------------------------------------- HTTP

DEBUG_CSS = """
pre{background:#12151b;border:1px solid #222832;border-radius:10px;padding:14px;
overflow:auto;max-height:520px;font-size:12.5px;line-height:1.5;color:#c6ccd6;
white-space:pre-wrap;word-break:break-all}
h3{font-size:13px;color:#9aa3b0;margin:26px 0 8px;font-weight:600;letter-spacing:.8px}
h3:first-of-type{margin-top:0}
"""


def _raw_block(title, path, limit=4000):
    text, err = read_text(path)
    if text is None:
        return '<h3>%s</h3><p class="err">读不到（%s）</p>' % (esc(title), esc(err))
    total = len(text)
    if total > limit:
        text = text[:limit] + '\n…（截了，后面还有 %d 字节）' % (total - limit)
    elif not text.strip():
        text = '（空）'
    return '<h3>%s <span class="muted">· %d 字节</span></h3><pre>%s</pre>' % (
        esc(title), total, esc(text))


def build_debug():
    """多看一层：原文、当前注入、索引统计。

    这些是给开发看的，不是给她看的 —— 她能看的是 changes.md 和三个工具。
    同一套口令，同一个服务，不另起端口。
    """
    base = os.path.join(ROOT, 'work', 'realheart')
    blocks = [
        _raw_block('她上一轮看到的（last-inject.md）', os.path.join(base, 'last-inject.md'), 6000),
        _raw_block('心情账本原样（mood.jsonl）', MOOD_LOG, 4000),
        _raw_block('控制账本（control.jsonl）', CONTROL_LOG, 3000),
        _raw_block('自由时间账本（free-time.jsonl）', FREE_LOG, 3000),
        _raw_block('改动记录（changes.md）', os.path.join(base, 'changes.md'), 12000),
    ]

    # 索引统计：她写心情时能指的那些 id 有多少条
    rows, err = _week_rows()
    if err:
        blocks.append('<h3>事件索引</h3><p class="err">%s</p>' % esc(err))
    else:
        lines = ['%s  heard=%-4d said=%-4d tools=%-4d' % (
            r['day'], r['heard'], r['said'], r['tools']) for r in rows[:10]]
        blocks.append('<h3>事件索引 · 近七天 <span class="muted">· %d 天有记录</span></h3><pre>%s</pre>' % (
            len(rows), esc('\n'.join(lines) or '（空）')))

    info = sysinfo()
    nc = napcat_status()
    head = ('<p class="note">版本 v%s ・ QQ 登录 %s ・ 进程 %s ・ 可用内存 %s ・ 数据时间 %s</p>' % (
        esc(info['version']),
        {True: '<b style="color:#8ad8a8">在线</b>', False: '<b style="color:#e0796a">掉线</b>'}.get(
            nc['online'], '查不到'),
        esc(info['svc']),
        ('%d MB' % info['mem_avail']) if info.get('mem_avail') else '—',
        time.strftime('%m-%d %H:%M:%S'),
    ))
    if nc.get('why'):
        head += '<p class="note">判据：%s</p>' % esc(nc['why'])

    return ('<!doctype html><html lang="zh"><meta charset="utf-8">\n'
            '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
            '<meta name="robots" content="noindex,nofollow">\n'
            '<title>debug · 内部</title>\n'
            '<style>%s%s</style>\n'
            '<div class="wrap"><header><h1>debug</h1>'
            '<div class="sub">原文与中间量 · 只读 · <a href="./">回观测页</a></div></header>\n'
            '%s%s\n'
            '<footer>这一页只在这里能开，她要看得她自己调 rh_changes</footer></div>\n'
            '</html>' % (CSS, DEBUG_CSS, head, ''.join(blocks)))


class Handler(BaseHTTPRequestHandler):
    server_version = 'rh-status'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        return

    def log_request(self, code='-', size='-'):
        sys.stderr.write('%s %s %s %s\n' % (
            time.strftime('%H:%M:%S'), self.command, code, size))
        sys.stderr.flush()

    def _send(self, code, body, ctype='text/html; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _ok_path(self, path):
        """self.path 是 http.server 按 latin-1 解出来的，先还原字节再常数时间比较。"""
        raw = path.split('?', 1)[0]
        try:
            blob = raw.encode('latin-1')
        except UnicodeEncodeError:
            blob = raw.encode('utf-8', 'surrogateescape')
        prefix = b'/' + SECRET
        if len(blob) < len(prefix):
            return None
        if not hmac.compare_digest(blob[:len(prefix)], prefix):
            return None
        return blob[len(prefix):] or b'/'

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        rest = self._ok_path(self.path)
        if rest is None:
            self._send(404, b'not found', 'text/plain; charset=utf-8')
            return
        if rest in (b'/', b''):
            self._send(200, build_page().encode('utf-8'))
            return
        if rest in (b'/healthz',):
            self._send(200, b'ok', 'text/plain; charset=utf-8')
            return
        if rest in (b'/debug',):
            self._send(200, build_debug().encode('utf-8'))
            return
        self._send(404, b'not found', 'text/plain; charset=utf-8')

    def _reject(self):
        self._send(405, b'method not allowed', 'text/plain; charset=utf-8')

    do_POST = _reject
    do_PUT = _reject
    do_DELETE = _reject
    do_PATCH = _reject


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _keep_warm():
    """后台一直把统计和时间线算好。

    为什么要：解压原生会话包要两秒左右（实测 6 秒），页面赶上空缓存就是卡。
    现在请求永远命中缓存，重活挪到后台。
    """
    while True:
        try:
            _week_rows()
            _timeline_rows()
        except Exception:
            pass
        time.sleep(max(20, _CACHE_TTL - 10))


def main():
    srv = Server((BIND, PORT), Handler)
    threading.Thread(target=_keep_warm, daemon=True).start()
    sys.stderr.write('rh-status listening on %s:%d\n' % (BIND, PORT))
    sys.stderr.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()



