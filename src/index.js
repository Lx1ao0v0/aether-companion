#!/usr/bin/env node
'use strict';
/**
 * index.js — Aether 管家 APP 入口 · ADR-0149
 *
 * 用法：
 *   node src/index.js            常驻轮询执行 BYO 视频工单
 *   node src/index.js --once     只跑一轮（调试）
 *   node src/index.js --doctor   自检：配置 / 服务端连通 / 会员等级 / CLI 是否可用
 *
 * 安全：本程序只用你自己机器上已登录的官方 CLI（kling / dreamina）生成视频，
 * 凭证全程留本机，绝不上传 ARTVAS（I-BYO-NOTOKEN）。
 */

const fs = require('fs');
const path = require('path');
const { spawnCompat } = require('./cli');
const { acquireSingleInstance, parseProtocolUrl, registerProtocol } = require('./protocol');
const { loadConfig, validateConfig, writeConfigPatch } = require('./config');
const { ApiClient } = require('./apiClient');
const { Harness } = require('./harness');
const { supportedTools } = require('./handlers');
const { runSetup, ensureKlingReady, isInteractive } = require('./setup');
const log = require('./logger');

/**
 * 启动前校验 Node 版本（依赖内置 fetch / structuredClone，需 >=18.17）。
 * 启动脚本已做一次 where node 检测，这里防"装了但版本太旧"的二次兜底。
 */
function _checkNodeVersion() {
  const m = /^v?(\d+)\.(\d+)/.exec(process.versions.node || '');
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  const ok = major > 18 || (major === 18 && minor >= 17);
  if (!ok) {
    log.error('================================================');
    log.error(`Node.js 版本过低：当前 v${process.versions.node}，本管家需要 18.17 或更高。`);
    log.error('请到 https://nodejs.org 下载安装 LTS 版本后重试。');
    log.error('================================================');
  }
  return ok;
}

/** 配置缺失/占位时，打印「3 步搞定」的小白引导，而不是只抛一行报错。 */
function _printSetupGuide() {
  const root = path.resolve(__dirname, '..');
  const cfgPath = path.join(root, 'config.json');
  const examplePath = path.join(root, 'config.example.json');
  const hasCfg = fs.existsSync(cfgPath);
  log.error('================== 配置还没填好 ==================');
  if (!hasCfg) {
    log.error('① 还没有 config.json：把 config.example.json 复制一份、改名为 config.json');
    log.error(`   示例文件：${examplePath}`);
  } else {
    log.error('① 打开 config.json，检查下面两项是否填了真实值：');
  }
  log.error('② serverUrl：填 ARTVAS 地址（本地测试填 http://localhost:5000）');
  log.error('③ deskpetToken：到 ARTVAS 个人中心 → 桌面助手，复制 Token 粘进去');
  log.error(`配置文件位置：${cfgPath}`);
  log.error('改完保存后，重新双击「启动管家」即可。');
  log.error('================================================');
}

function _probeBin(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCompat(bin, ['--help'], { windowsHide: true });
    } catch {
      return resolve(false);
    }
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    child.on('error', () => finish(false));
    child.on('close', () => finish(true));
    setTimeout(() => { try { child.kill(); } catch { /* noop */ } finish(true); }, 5000);
  });
}

async function doctor(cfg) {
  log.info('=== 自检开始 ===');
  const errs = validateConfig(cfg);
  if (errs.length) {
    errs.forEach((e) => log.error('配置: ' + e));
    _printSetupGuide();
  } else {
    log.ok(`配置 OK：serverUrl=${cfg.serverUrl}`);
  }

  if (!errs.length) {
    const api = new ApiClient(cfg);
    try {
      const me = await api.me();
      if (me && me.ok) {
        log.ok(`服务端连通 OK：会员等级=${me.membership_tier} mode=${me.mode}`);
        if (!['advanced', 'pro', 'invited'].includes((me.membership_tier || '').toLowerCase()) && me.mode === 'saas') {
          log.warn('当前会员等级可能无 BYO 权限（需 advanced/pro/invited）');
        }
      } else {
        log.error('服务端 /me 返回异常: ' + JSON.stringify(me));
      }
    } catch (e) {
      log.error('服务端连通失败: ' + e.message);
    }
  }

  for (const t of supportedTools()) {
    const bin = (cfg[t] && cfg[t].binary) || t;
    const ok = await _probeBin(bin);
    if (ok) log.ok(`CLI 可用：${t} (${bin})`);
    else log.warn(`CLI 未找到：${t} (${bin})。请安装并确保在 PATH，且已登录`);
  }
  log.info('=== 自检结束 ===');
}

function _configPath() {
  return path.join(path.resolve(__dirname, '..'), 'config.json');
}

const _TOKEN_RE = /^[A-Za-z0-9_-]{8,256}$/;

/**
 * 一键连接：用候选 server+token 验证 /api/deskpet/me，**通过后才**落盘 config.json。
 * 威胁模型（ADR-0149 §5.11）：受限令牌只在真 ARTVAS 上有效，攻击者拿不到受害者的真令牌
 * （令牌只能从已登录的 ARTVAS 页面取，跨源 JS 读不到），故"先 /me 验证再落盘"既挡住把
 * 垃圾令牌写进配置，也不会把真令牌发给伪造 server（伪 server 验不过真令牌→不落盘）。
 * @returns {Promise<boolean>} 是否成功绑定并落盘
 */
async function _bindToken(token, server, cfg) {
  if (!token || !_TOKEN_RE.test(token)) {
    log.warn('连接码缺失或格式非法，已忽略绑定。');
    return false;
  }
  const base = (server || cfg.serverUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    log.warn('未知 ARTVAS 服务地址，无法连接（请先在向导里设置，或用网页「一键连接」按钮）。');
    return false;
  }
  const probe = new ApiClient({ serverUrl: base, deskpetToken: token });
  try {
    const me = await probe.me();
    if (!me || !me.ok) {
      log.warn('连接校验未通过（服务端未确认该连接码），未保存。请重新在网页获取连接码。');
      return false;
    }
  } catch (e) {
    log.warn('连接校验失败: ' + e.message);
    return false;
  }
  try {
    writeConfigPatch({ serverUrl: base, deskpetToken: token });
    log.ok(`已连接 ARTVAS（${base}），连接码已保存。`);
    return true;
  } catch (e) {
    log.error('保存连接配置失败: ' + e.message);
    return false;
  }
}

/** 从 argv 取 `--bind <token>` 与 `--server <url>`（人工/调试用，受信输入）。 */
function _bindArgsFromArgv(argv) {
  const out = {};
  const i = argv.indexOf('--bind');
  if (i >= 0 && argv[i + 1]) out.token = String(argv[i + 1]).trim();
  const j = argv.indexOf('--server');
  if (j >= 0 && argv[j + 1]) out.server = String(argv[j + 1]).trim().replace(/\/+$/, '');
  return out;
}

/**
 * 交互式首启但还没连上账号时：**不退出**，开着窗口轮询 config.json，
 * 等网页「一键连接本机管家」（深链 bind 会 writeConfigPatch 落盘）写入连接码后自动继续。
 * 这是关键 UX：用户选了"用网页一键连接"后，窗口应停在这里等待，而不是报错退出让人以为失败。
 * @returns {Promise<object>} 变为有效后的 config
 */
function _waitForConnection() {
  log.ok('本机管家已就绪，只差把账号「连上」这一步。');
  log.info('请回到 ARTVAS 网页 → 个人中心 → 设置 → 点「一键连接本机管家」。');
  log.info('保持本窗口开着即可，连上后会自动继续、无需关闭（想中止按 Ctrl+C）。');
  log.info('（等待连接中…）');
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      try {
        const next = loadConfig();
        if (validateConfig(next).length === 0) {
          clearInterval(timer);
          log.ok('已收到连接码，正在继续启动…');
          resolve(next);
        }
      } catch (_) { /* 半写入/瞬时错误：下次轮询再看 */ }
    }, 2000);
  });
}

async function main() {
  if (!_checkNodeVersion()) { process.exitCode = 1; return; }
  const argv = process.argv.slice(2);
  let cfg = loadConfig(); // 注：下方 bind 落盘 / 向导返回后会重新赋值，必须 let（曾误用 const 致首启崩溃）

  if (argv.includes('--register-protocol')) {
    // 由「启动管家.bat」每次启动时幂等调用：注册 aether-companion:// 让浏览器可一键唤起。
    registerProtocol();
    return;
  }

  if (argv.includes('--doctor')) {
    await doctor(cfg);
    return;
  }

  // 显式重跑配置向导（用户想重装/重登/改连接码时）。
  if (argv.includes('--setup')) {
    await runSetup(cfg);
    return;
  }

  // 一键连接：来自网页深链 aether-companion://bind?token=&server=，或人工 --bind <token> [--server <url>]。
  const proto = parseProtocolUrl(argv);
  if (proto.action) log.info(`协议唤起：action=${proto.action}`);
  const bindArgs = proto.action === 'bind'
    ? { token: proto.token, server: proto.server }
    : _bindArgsFromArgv(argv);
  if (bindArgs.token) {
    const ok = await _bindToken(bindArgs.token, bindArgs.server, cfg);
    if (ok) cfg = loadConfig(); // 重读，让后续启动用新连接码
  }

  // 单实例锁先占坑（--once 测试模式除外）：已有存活管家在跑时本进程安静退出。
  // bind 深链在上面已 writeConfigPatch 落盘，运行中的实例会经「等待轮询 / config 热重载」自动生效。
  const isOnce = argv.includes('--once');
  const lock = isOnce ? { acquired: true } : acquireSingleInstance();
  if (!lock.acquired) {
    log.ok(`管家已在运行（PID ${lock.holderPid}）；连接码若有更新，运行中的管家会自动生效。本窗口可关闭。`);
    return;
  }
  // 锁的释放由 protocol.js 内 process 'exit' 钩子兜底（shutdown 最终走 process.exit → 触发 exit）。

  // 配置未就绪：交互式 → 进向导（装可灵 / 登录）；仍缺连接码 → 不退出，开着窗口等网页「一键连接」。
  // 非交互（协议唤起无控制台）/ --once → 打印引导后退出。
  let errs = validateConfig(cfg);
  if (errs.length) {
    if (isInteractive() && !isOnce) {
      const r = await runSetup(cfg);
      cfg = r.cfg || cfg;
      errs = validateConfig(cfg);
    }
    if (errs.length) {
      if (isInteractive() && !isOnce) {
        // 关键 UX：别退出。管家已就绪，只差把账号连上——保持窗口开着，等网页一键连接写入连接码后自动继续。
        cfg = await _waitForConnection();
      } else {
        errs.forEach((e) => log.error('配置错误: ' + e));
        _printSetupGuide();
        process.exitCode = 1;
        return;
      }
    }
  } else if (isInteractive()) {
    // 配置已就绪，但仍可能没装/没登录可灵 → 顺手确保就绪（不打扰已就绪用户：内部探测后才提示）。
    await ensureKlingReady(cfg);
  }

  const api = new ApiClient(cfg);
  // 启动前轻量握手，给出友好提示
  try {
    const me = await api.me();
    if (me && me.ok) log.ok(`已连接 ARTVAS（会员等级=${me.membership_tier}）`);
  } catch (e) {
    log.warn('启动握手失败（将继续重试）: ' + e.message);
  }

  const harness = new Harness(api, cfg);

  // 能力上报：启动跑一次 who_am_i 上报视频模型清单 + 在线/登录态，之后每 5 分钟刷新。
  // 让画布视频节点能渲染「厂商/模型/参数」下拉，并在管家未连接/未登录时给出 actionable 提示。
  const reportCaps = async (opts = {}) => {
    try {
      const { collectCapabilities } = require('./capabilities');
      const caps = await collectCapabilities(cfg, { force: !!opts.force });
      const resp = await api.reportCapabilities(caps);
      const k = caps.kling || {};
      // 日志按服务端真实结果区分：上报失败（如端点 404 / 未登录）不再假报"已上报"，避免误导排查。
      if (resp && resp.ok) {
        log.info(`已上报本地视频能力：可灵 online=${k.online} logged_in=${k.logged_in}`);
      } else {
        log.warn(`能力上报未被服务端接受（可能服务端版本过旧或登录态失效）：可灵 online=${k.online} logged_in=${k.logged_in}`);
      }
    } catch (e) {
      log.warn('能力上报跳过: ' + (e && e.message));
    }
  };
  let capsTimer = null;
  const earlyTimers = [];

  const shutdown = () => {
    log.info('收到退出信号，停止轮询…');
    if (capsTimer) clearInterval(capsTimer);
    earlyTimers.forEach((t) => clearTimeout(t));
    harness.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (argv.includes('--once')) {
    await reportCaps();
    try { await harness.tick(); } catch (e) { log.error('单轮拉取失败: ' + e.message); }
    // 等在途任务尽量完成
    let waited = 0;
    while (harness.inflight.size && waited < 26 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 1000));
      waited += 1000;
    }
    return;
  }

  // config.json 热重载：网页「一键连接」（或 --bind）改写连接码/服务地址后，运行中的管家
  // 无需重启即切到新账号。仅在变更生效后才动鉴权，避免空写/抖动。best-effort，监听失败不致命。
  try {
    fs.watchFile(_configPath(), { interval: 2000 }, () => {
      try {
        const next = loadConfig();
        const e2 = validateConfig(next);
        if (e2.length) return; // 半写入/无效态：跳过，等下次稳定
        if (next.serverUrl !== api.base || next.deskpetToken !== api.token) {
          api.updateAuth(next.serverUrl, next.deskpetToken);
          log.ok('检测到连接配置更新，已热重载（无需重启）。');
          reportCaps({ force: true });
        }
      } catch (e) { log.warn('配置热重载失败（忽略）: ' + (e && e.message)); }
    });
  } catch (e) { log.warn('配置监听启动失败（忽略）: ' + (e && e.message)); }

  // 启动即强制上报一次；再在 30s / 90s 各强制刷新一次（force 跳过 60s 单飞缓存），
  // 捕捉"先启动管家、随后才 kling login"的场景，避免画布在 5 分钟周期窗口内一直把
  // 刚登录的管家误判为未登录而拦截提交（caps 新鲜度）。之后回落 5 分钟常规周期。
  reportCaps({ force: true });
  earlyTimers.push(setTimeout(() => reportCaps({ force: true }), 30 * 1000));
  earlyTimers.push(setTimeout(() => reportCaps({ force: true }), 90 * 1000));
  capsTimer = setInterval(reportCaps, 5 * 60 * 1000);
  await harness.runForever();
}

// 顶层兜底：单个工单的异步异常不应整体崩管家（保持轮询韧性）。
// 仅记录，不退出进程；真正致命的启动期错误由 main().catch 处理并置退出码。
process.on('uncaughtException', (e) => {
  log.error('未捕获异常（已隔离，管家继续运行）: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  log.error('未处理的 Promise 拒绝（已隔离，管家继续运行）: ' + (e && e.stack ? e.stack : e));
});

main().catch((e) => {
  log.error('致命错误: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
