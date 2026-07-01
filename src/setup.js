'use strict';
/**
 * setup.js — 首次运行引导向导 · ADR-0149 §5.11（填平技术难度，人人会用）
 *
 * 目标：把「装 Node → 装可灵 CLI → 登录 → 填连接码」这串技术活，
 * 降成「双击 → 跟着提示按几下回车 → 浏览器点登录」。剩下唯一不可省的人工是
 * `kling login`（可灵 OAuth 浏览器授权，官方唯一合法取凭据方式，见 kling-cli skill）。
 *
 * 纪律（遵 kling-cli skill 排他约束）：
 *   - 安装只用区域对应 npm 包，必须先问用户「国内站 / 海外站」，绝不默认/猜测/两个都装。
 *   - 取凭据只能 `kling login`，本向导从不读 .credentials、从不让用户粘贴可灵 token。
 *   - 所有改动用户全局环境的动作（npm i -g / kling login）前，先征得同意（y/n）。
 *
 * 闸门：仅在交互式 TTY 下提问；非 TTY（协议唤起 / 无控制台）只打印 actionable 引导不阻塞。
 */

const readline = require('readline');
const { spawnCompat } = require('./cli');
const { probeKling } = require('./capabilities');
const { clearCache } = require('./klingCaps');
const { validateConfig, writeConfigPatch } = require('./config');
const log = require('./logger');

function isInteractive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

function _ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => { rl.close(); resolve(String(ans || '').trim()); });
  });
}

async function _askYesNo(question, defYes = true) {
  const hint = defYes ? '（回车=是 / n=否）' : '（y=是 / 回车=否）';
  const ans = (await _ask(`${question} ${hint} `)).toLowerCase();
  if (ans === '') return defYes;
  return ans === 'y' || ans === 'yes' || ans === '是';
}

const _KLING_PKG = { cn: '@klingai/cli-cn', global: '@klingai/cli-global' };

/** 自动 npm i -g 区域可灵包。继承 stdio 让用户看到安装进度。返回是否成功。 */
function _installKlingPkg(region) {
  const pkg = _KLING_PKG[region];
  return new Promise((resolve) => {
    log.info(`正在安装可灵命令行（${pkg}）… 首次约 1-2 分钟，请耐心等待`);
    let child;
    try {
      child = spawnCompat('npm', ['i', '-g', pkg, '--registry=https://registry.npmjs.org'],
        { stdio: 'inherit' });
    } catch (e) {
      log.error('启动 npm 失败（是否已安装 Node.js？）: ' + e.message);
      return resolve(false);
    }
    child.on('error', (e) => { log.error('npm 安装出错: ' + e.message); resolve(false); });
    child.on('close', (code) => resolve(code === 0));
  });
}

/** 拉起 `kling login` 浏览器 OAuth。继承 stdio 让 CLI 自行打印授权链接/提示。 */
function _klingLogin(cfg) {
  const bin = (cfg.kling && cfg.kling.binary) || 'kling';
  log.info('即将打开浏览器完成可灵登录授权，请在弹出的页面里登录你的可灵账号…');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCompat(bin, ['login'], { stdio: 'inherit' });
    } catch (e) {
      log.error('启动 kling login 失败: ' + e.message);
      return resolve(false);
    }
    let done = false;
    const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
    child.on('error', () => fin(false));
    child.on('close', (code) => fin(code === 0));
    // OAuth 最多等 6 分钟（官方超时 5min），超时不杀死浏览器、仅放行向导继续
    setTimeout(() => fin(false), 6 * 60 * 1000);
  });
}

/** 确保可灵 CLI 已安装且已登录。返回最终 caps（{online, logged_in, ...}）。 */
async function ensureKlingReady(cfg) {
  let caps = await probeKling(cfg, { force: true });

  if (!caps.online) {
    log.warn('未检测到「可灵命令行（kling）」。它是用你自己的可灵订阅生成视频的官方工具。');
    if (!(await _askYesNo('是否现在自动安装可灵命令行？'))) {
      log.info('已跳过安装。你也可以稍后手动安装：npm i -g @klingai/cli-cn（海外站用 -global）。');
      return caps;
    }
    log.info('你的可灵账号属于哪个区域？  1 = 国内站(klingai.com)   2 = 海外站(kling.ai)');
    const r = (await _ask('请输入 1 或 2： ')).trim();
    const region = r === '2' ? 'global' : (r === '1' ? 'cn' : '');
    if (!region) {
      log.warn('未识别区域选择，已跳过安装（避免装错区域包导致登录反复失败）。');
      return caps;
    }
    const ok = await _installKlingPkg(region);
    if (!ok) {
      log.error('可灵命令行安装失败。请检查网络后重试，或手动执行：');
      log.error(`  npm i -g ${_KLING_PKG[region]} --registry=https://registry.npmjs.org`);
      return caps;
    }
    log.ok('可灵命令行安装完成。');
    clearCache();
    caps = await probeKling(cfg, { force: true });
    if (!caps.online) {
      log.warn('安装后仍未检测到 kling 命令——可能 npm 全局目录不在 PATH。');
      log.warn('请关闭本窗口、重新双击「启动管家」重试；若仍不行，重启电脑后再试。');
      return caps;
    }
  }

  if (caps.online && !caps.logged_in) {
    log.warn('可灵命令行已安装，但尚未登录（或该账号暂无视频权限）。');
    if (!(await _askYesNo('是否现在登录可灵？将打开浏览器授权'))) {
      log.info('已跳过登录。稍后可在本窗口手动运行：kling login');
      return caps;
    }
    await _klingLogin(cfg);
    clearCache();
    caps = await probeKling(cfg, { force: true });
    if (caps.logged_in) log.ok('可灵登录成功。');
    else log.warn('仍未检测到登录态。若浏览器授权已完成，可重启管家再试；或确认账号有视频权限。');
  }

  return caps;
}

/**
 * 引导填写「服务地址 + 连接码」。优先建议走网页「一键连接」（免手填），
 * 也支持在此粘贴连接码（serverUrl 缺失时一并询问，默认用于本地测试可填 http://localhost:5000）。
 */
async function ensureConfigBound(cfg) {
  const errs = validateConfig(cfg);
  if (!errs.length) return cfg;

  log.warn('还差最后一步：把本机管家和你的 ARTVAS 账号「连上」。');
  log.info('推荐做法（最省事）：回到 ARTVAS 网页 → 个人中心 → 设置 → 点「一键连接本机管家」。');
  log.info('它会自动把连接码送进来，无需手动复制粘贴。');

  if (!(await _askYesNo('想现在手动粘贴连接码吗？（不想就直接回车，去网页点一键连接）', false))) {
    return cfg;
  }

  const patch = {};
  if (!cfg.serverUrl || !/^https?:\/\//.test(cfg.serverUrl)) {
    const s = (await _ask('请输入 ARTVAS 网址（本地测试填 http://localhost:5000）： ')).replace(/\/+$/, '');
    if (/^https?:\/\//.test(s)) patch.serverUrl = s;
  }
  const tok = await _ask('请粘贴连接码（个人中心「获取连接码」复制的那串）： ');
  if (tok && /^[A-Za-z0-9_-]{8,256}$/.test(tok)) patch.deskpetToken = tok;
  else if (tok) log.warn('连接码格式看起来不对，已忽略（请确认从「获取连接码」复制完整）。');

  if (patch.deskpetToken || patch.serverUrl) {
    try {
      const next = writeConfigPatch(patch);
      log.ok('已保存配置。');
      return next;
    } catch (e) {
      log.error('保存配置失败: ' + e.message);
    }
  }
  return cfg;
}

/**
 * 完整向导：CLI 就绪（装+登录）→ 账号连接。仅交互式 TTY 下运行。
 * 返回 { interactive, cfg, caps }。非 TTY 时 interactive:false（调用方退回打印引导）。
 */
async function runSetup(cfg) {
  if (!isInteractive()) {
    return { interactive: false, cfg, caps: null };
  }
  log.info('================ 首次配置向导 ================');
  log.info('跟着提示按几下回车即可，全程只在你这台电脑上操作。');
  const caps = await ensureKlingReady(cfg);
  const cfg2 = await ensureConfigBound(cfg);
  log.info('================ 向导结束 ================');
  return { interactive: true, cfg: cfg2, caps };
}

module.exports = { runSetup, ensureKlingReady, ensureConfigBound, isInteractive };
