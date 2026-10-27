#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""问她到底在不在线 —— 只此一处判断。

为什么单独拧出来：2026-10-27 这一天，同一件事判错了两次，两个方向都错过：

  ① 只看 `isLogin / coreReady / loginPhase`
     → 风控踢下线之后，NapCat 进程还在，这三个字段照旧报在线，页面一片绿，
       手机上看不到"登录到 Linux"。误判成「在线」。
  ② 只看 `qrcodeurl` 有没有值
     → 扫码成功之后 NapCat **不会把 qrcodeurl 清空**，于是一直判掉线，
       页面一直在要码。误判成「掉线」。

两个坑叠在一起说明：**任何一个字段单独看都会错。** 所以判据集中在这里，
观测页和救码页都调它，改一处两边一起变。

真实信号里最硬的一个是「最近有没有人说过话」（history 的 mtime）——
那是"人确实在用"，不会骗人。
"""

import hashlib
import json
import os
import time
import urllib.request

WEBUI_CANDIDATES = [
    os.path.expanduser('~/napcatrun/napcat/config/webui.json'),
    os.path.expanduser('~/napcat/config/webui.json'),
]
WEBUI_BASE = 'http://127.0.0.1:6099'
HISTORY_DIR = os.path.expanduser('~/qqbot/data/history')

# 明确的"在等登录"阶段
WAITING_PHASES = ('waiting_qrcode', 'waiting_slider', 'waiting_other')

_CACHE = {'at': 0.0, 'value': None}
CACHE_SECONDS = 60


def _webui_token():
    for path in WEBUI_CANDIDATES:
        if os.path.exists(path):
            with open(path, encoding='utf-8') as fh:
                return str(json.load(fh)['token'])
    raise RuntimeError('找不到 webui.json')


def _post(path, body=None, cred=None, timeout=4):
    data = json.dumps(body if body is not None else {}).encode()
    headers = {'Content-Type': 'application/json'}
    if cred:
        headers['Authorization'] = 'Bearer ' + cred
    req = urllib.request.Request(WEBUI_BASE + path, data=data, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def talked_recently(minutes=30):
    """最近 N 分钟内有没有对话。history 最新文件的 mtime = 人确实在用的硬证据。"""
    newest = 0.0
    try:
        for entry in os.scandir(HISTORY_DIR):
            if not entry.name.endswith('.jsonl'):
                continue
            try:
                newest = max(newest, entry.stat().st_mtime)
            except OSError:
                pass
    except OSError:
        return False
    if newest == 0.0:
        return False
    return (time.time() - newest) < minutes * 60


def _decide(data, recent):
    """拿到 CheckLoginStatus 的 data，判断到底在不在线。返回 (online, why)。"""
    phase = str(data.get('loginPhase') or '')
    has_qr = bool(str(data.get('qrcodeurl') or '').strip())
    is_login = bool(data.get('isLogin'))
    offline = bool(data.get('isOffline'))
    ready = bool(data.get('coreReady'))

    if phase in WAITING_PHASES:
        return False, 'loginPhase=%s' % phase
    if offline:
        return False, 'NapCat 说自己 offline'
    if is_login and ready and not has_qr:
        return True, '字段都在线，且没有待扫的码'
    if is_login and ready and has_qr:
        if recent:
            return True, '有残留的码，但最近有人说过话'
        return False, '有码、且最近没人说话 —— 在等扫码'
    return None, 'isLogin=%s coreReady=%s（说不准）' % (is_login, ready)


def login_state(force=False):
    """→ {online: True/False/None, why, has_qr, phase, recent_talk, note}

    None = 查不到（不是"在线"）。调用方要如实显示"查不到"，别当好的。
    """
    now = time.time()
    if not force and _CACHE['value'] is not None and now - _CACHE['at'] < CACHE_SECONDS:
        return _CACHE['value']

    out = {'online': None, 'why': '', 'has_qr': False, 'phase': '',
           'recent_talk': False, 'note': ''}
    try:
        token = _webui_token()
    except Exception as exc:
        out['note'] = '读不到 webui.json（%s）' % type(exc).__name__
        _CACHE.update({'at': now, 'value': out})
        return out

    try:
        digest = hashlib.sha256((token + '.napcat').encode()).hexdigest()
        login = _post('/api/auth/login', {'hash': digest})
        cred = (login.get('data') or {}).get('Credential')
        if not cred:
            out['note'] = 'WebUI 登录失败'
            _CACHE.update({'at': now, 'value': out})
            return out
        status = _post('/api/QQLogin/CheckLoginStatus', {}, cred)
    except Exception as exc:
        out['note'] = '问不到 NapCat（%s）' % type(exc).__name__
        _CACHE.update({'at': now, 'value': out})
        return out

    data = status.get('data') if isinstance(status.get('data'), dict) else {}
    recent = talked_recently()
    online, why = _decide(data, recent)

    out.update({
        'online': online,
        'why': why,
        'has_qr': bool(str(data.get('qrcodeurl') or '').strip()),
        'phase': str(data.get('loginPhase') or ''),
        'recent_talk': recent,
        'note': '',
    })
    _CACHE.update({'at': now, 'value': out})
    return out
