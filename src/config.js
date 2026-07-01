'use strict';
/**
 * config.js — 配置加载（config.json + 环境变量覆盖）· ADR-0149
 *
 * 安全铁律（I-BYO-NOTOKEN）：本配置只存「ARTVAS 服务地址 + Deskpet Token」。
 * 严禁在此存放可灵/即梦的账号密码或 cookie —— 那些凭证由官方 CLI（kling / dreamina）
 * 自己在本机管理（~/.kling、~/.dreamina_cli 等），本程序从不读取、从不上传。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  serverUrl: '',
  deskpetToken: '',
  pollIntervalMs: 5000,
  heartbeatIntervalMs: 30000,
  // 默认允许 2 条本地任务并行（多节点场景小步并行）；单节点批量×N 前端本就 await 串行、
  // 不吃并发。上限钳 4（loadConfig）。真正的天花板是用户可灵账号自身的并发/额度，
  // 服务端另有单用户在途软闸（_BYO_MAX_INFLIGHT）兜底，双向防止失控。
  maxConcurrent: 2,
  kling: { binary: 'kling', defaultModel: '', pollSeconds: 1800 },
  jimeng: { binary: 'dreamina', defaultModelVersion: 'seedance1.0', pollSeconds: 1800 },
};

function _readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
      out[k] = _merge(base[k] || {}, over[k]);
    } else if (over[k] !== undefined && over[k] !== null) {
      out[k] = over[k];
    }
  }
  return out;
}

/**
 * 收紧 config.json 权限（内含明文 Deskpet Token，ADR-0149 §5.10 C3）。
 * POSIX：chmod 600（仅属主可读写）。Windows：fs.chmod 仅切只读位、无实义 → no-op，
 * 靠用户 profile 目录 ACL；Token 本身已是受限作用域 + 短 TTL + 可吊销，泄露面有限。
 * best-effort：失败仅吞，不阻塞启动。
 */
function _hardenConfigPerms(file) {
  try {
    if (process.platform !== 'win32' && fs.existsSync(file)) {
      fs.chmodSync(file, 0o600);
    }
  } catch { /* 权限收紧失败不致命 */ }
}

function loadConfig() {
  const root = path.resolve(__dirname, '..');
  const cfgFile = path.join(root, 'config.json');
  _hardenConfigPerms(cfgFile);
  const fileCfg = _readJson(cfgFile) || {};
  let cfg = _merge(DEFAULTS, fileCfg);

  // 环境变量覆盖（便于打包后无文件运行）
  const env = process.env;
  if (env.AETHER_SERVER_URL) cfg.serverUrl = env.AETHER_SERVER_URL;
  if (env.AETHER_DESKPET_TOKEN) cfg.deskpetToken = env.AETHER_DESKPET_TOKEN;
  if (env.AETHER_POLL_MS) cfg.pollIntervalMs = parseInt(env.AETHER_POLL_MS, 10) || cfg.pollIntervalMs;
  if (env.KLING_BIN) cfg.kling.binary = env.KLING_BIN;
  if (env.DREAMINA_BIN) cfg.jimeng.binary = env.DREAMINA_BIN;

  cfg.serverUrl = String(cfg.serverUrl || '').replace(/\/+$/, '');
  cfg.pollIntervalMs = Math.max(2000, cfg.pollIntervalMs | 0);
  cfg.heartbeatIntervalMs = Math.max(10000, cfg.heartbeatIntervalMs | 0);
  cfg.maxConcurrent = Math.max(1, Math.min(4, cfg.maxConcurrent | 0));
  return cfg;
}

/**
 * 把局部补丁合并写回 config.json（向导/一键绑定用）。原子写（tmp + rename）+ chmod 600。
 * 只动传入字段，保留用户既有其它配置（pollIntervalMs / kling.defaultModel 等不被覆盖）。
 * 返回写入后的完整对象。失败抛错（调用方决定如何提示）。
 */
function writeConfigPatch(patch) {
  const root = path.resolve(__dirname, '..');
  const cfgFile = path.join(root, 'config.json');
  const cur = _readJson(cfgFile) || {};
  const next = _merge(cur, patch || {});
  const tmp = cfgFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, cfgFile);
  _hardenConfigPerms(cfgFile);
  return next;
}

function validateConfig(cfg) {
  const errs = [];
  if (!cfg.serverUrl || !/^https?:\/\//.test(cfg.serverUrl)) {
    errs.push('serverUrl 缺失或非法（需以 http(s):// 开头）');
  }
  if (!cfg.deskpetToken || cfg.deskpetToken.length < 8 || /复制你的/.test(cfg.deskpetToken)) {
    errs.push('deskpetToken 缺失（请在 ARTVAS 个人中心复制 Deskpet Token）');
  }
  const kPoll = Number(cfg.kling && cfg.kling.pollSeconds);
  if (Number.isFinite(kPoll) && kPoll < 600) {
    errs.push(`kling.pollSeconds=${kPoll} 过短（可灵 --poll 单位是秒，视频常需数分钟；建议 ≥600）`);
  }
  return errs;
}

module.exports = { loadConfig, validateConfig, writeConfigPatch, DEFAULTS };
