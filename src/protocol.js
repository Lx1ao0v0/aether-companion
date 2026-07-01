'use strict';
/**
 * protocol.js — 单实例锁 + 自定义协议(aether-companion://) 注册 · ADR-0149
 *
 * 解决两类「打开管家就报错 / 行为错乱」：
 *  1) 双开：重复双击启动、或协议唤起与已运行实例并存 → 两个进程各跑 who_am_i、各认领工单互相打架
 *     （单进程内已有 klingCaps 单飞，但跨进程拦不住）。单实例锁让后启动者发现已有存活实例即安静退出。
 *  2) 一键启动：画布视频节点点「一键启动管家」会发 aether-companion://start，
 *     需本机注册过该协议才会被系统唤起。仅 Windows 用户级 HKCU（免管理员）；mac/Linux 暂留接口。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const log = require('./logger');

function _lockPath() { return path.join(path.resolve(__dirname, '..'), '.companion.lock'); }

// 判断 pid 是否存活：kill(pid,0) 不发信号只探测；EPERM 表示存在但无权（仍算存活）。
function _alive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * 尝试获得单实例锁。返回 { acquired, holderPid, release }。
 * 已有存活实例 → acquired:false（调用方应安静退出）。陈旧锁（持有进程已死）→ 抢占。
 * 写锁失败（只读目录等）→ 退化为「无锁保护」继续运行（acquired:true，不阻塞主流程）。
 */
function acquireSingleInstance() {
  const lp = _lockPath();
  try {
    const j = JSON.parse(fs.readFileSync(lp, 'utf8'));
    if (j && _alive(j.pid)) return { acquired: false, holderPid: j.pid, release: () => {} };
  } catch { /* 无锁 / 坏锁 / 陈旧 → 抢占 */ }
  try {
    fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  } catch (e) {
    log.warn('单实例锁写入失败（将不做双开保护）: ' + (e && e.message));
    return { acquired: true, holderPid: process.pid, release: () => {} };
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(fs.readFileSync(lp, 'utf8'));
      if (cur && cur.pid === process.pid) fs.unlinkSync(lp);
    } catch { /* noop */ }
  };
  process.on('exit', release);
  return { acquired: true, holderPid: process.pid, release };
}

// 协议 action 白名单：只认这些已知动作。即便 action 当前仅用于日志（不驱动任何命令），
// 也用白名单早闸门收口，杜绝未来代码盲信 protoAction（防御纵深，ADR-0149 §5.10 C1）。
//   bind：网页「一键连接本机管家」携带连接码 → aether-companion://bind?token=...&server=...
const _KNOWN_PROTO_ACTIONS = new Set(['start', 'login', 'open', 'wake', 'bind']);

// 连接码 / 服务地址的严格格式（即便 CreateProcess 已非 shell、注入面已堵，仍做白名单字符校验
// 作纵深防御；不匹配一律丢弃，绝不把任意串写进 config 或拼进请求）。
const _TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/;          // 受限令牌 byo_ 前缀，纯 url-safe 字符
const _SERVER_RE = /^https?:\/\/[A-Za-z0-9.\-]+(?::\d{1,5})?(?:\/[^\s]*)?$/;

/**
 * 解析 argv 里第一个 aether-companion:// 深链 → { action, token, server }。
 * 非法 / 非本协议 → { action:'' }。
 * 安全：用 URL 解析取 host 作 action（严格白名单）+ query 取 token/server（严格正则）；
 * 任何不合规字段直接丢弃为 ''（防协议参数注入 / 把垃圾写进配置）。
 */
function parseProtocolUrl(argv) {
  for (const a of (argv || [])) {
    const raw = String(a || '').trim();
    if (!/^aether-companion:\/\//i.test(raw)) continue;
    let u;
    try { u = new URL(raw); } catch { log.warn('协议唤起 URL 解析失败（已忽略）'); return { action: '' }; }
    const action = String(u.hostname || '').toLowerCase();
    if (!_KNOWN_PROTO_ACTIONS.has(action)) {
      log.warn(`协议唤起 action 非白名单（已忽略）: ${action}`);
      return { action: '' };
    }
    const out = { action };
    const tok = u.searchParams.get('token') || '';
    const srv = (u.searchParams.get('server') || '').replace(/\/+$/, '');
    if (tok && _TOKEN_RE.test(tok)) out.token = tok;
    else if (tok) log.warn('协议唤起 token 格式非法（已忽略）');
    if (srv && _SERVER_RE.test(srv)) out.server = srv;
    else if (srv) log.warn('协议唤起 server 格式非法（已忽略）');
    return out;
  }
  return { action: '' };
}

/**
 * 向后兼容：仅返回 action 字符串（旧调用方用）。新代码用 parseProtocolUrl 取 token/server。
 */
function parseProtocolArg(argv) {
  return parseProtocolUrl(argv).action || '';
}

/**
 * 注册 aether-companion:// 协议（幂等）。仅 Windows 用户级 HKCU（免管理员）。
 *
 * 唤起命令：直调 "<node.exe>" "<src\index.js>" "%1"（ADR-0149 §5.10 C1 修复）。
 * 关键：**不经 cmd /c start / 启动管家.bat 包裹**——老写法 `cmd /c start "" "...bat" "%1"`
 * 会让 OS 把浏览器传来的 URL（%1）先后过 cmd.exe 与 .bat(%*) 两道 shell 解析，
 * 形如 `aether-companion://start" & calc.exe & "` 可越权拼出新进程 → 本地 RCE。
 * 直调 node.exe 走 CreateProcess（非 shell），`& | &&` 等元字符不被解释；
 * URL 作单一 %1 进 argv，再由 parseProtocolArg 严格正则 + 白名单兜底，注入串落空。
 *
 * 返回 true=已注册/更新；false=不支持/失败（best-effort，绝不抛，注册失败不影响管家运行）。
 */
function registerProtocol() {
  if (process.platform !== 'win32') {
    log.info('协议注册：当前平台暂不支持一键唤起（mac/Linux 留接口），请手动启动管家。');
    return false;
  }
  const root = path.resolve(__dirname, '..');
  const node = process.execPath; // 当前运行的 node.exe 绝对路径（打包成 exe 后即该 exe）
  const entry = path.join(root, 'src', 'index.js');
  const open = `"${node}" "${entry}" "%1"`;
  const base = 'HKCU\\Software\\Classes\\aether-companion';
  const calls = [
    [base, '/ve', '/d', 'URL:Aether Companion', '/f'],
    [base, '/v', 'URL Protocol', '/d', '', '/f'],
    [`${base}\\shell\\open\\command`, '/ve', '/d', open, '/f'],
  ];
  try {
    for (const args of calls) {
      const r = spawnSync('reg', ['add', ...args], { windowsHide: true, encoding: 'utf8' });
      if (r.status !== 0) {
        log.warn('协议注册失败（reg add 返回 ' + r.status + '）: ' + ((r.stderr || r.stdout || '').slice(0, 160)));
        return false;
      }
    }
    log.ok('已注册 aether-companion:// 协议（浏览器视频节点可一键唤起本管家）');
    return true;
  } catch (e) {
    log.warn('协议注册异常（忽略，可手动启动）: ' + (e && e.message));
    return false;
  }
}

module.exports = { acquireSingleInstance, parseProtocolArg, parseProtocolUrl, registerProtocol };
