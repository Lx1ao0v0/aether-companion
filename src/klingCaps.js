'use strict';
/**
 * klingCaps.js — kling who_am_i 单飞(single-flight) + TTL 缓存 · ADR-0149
 *
 * 背景：能力探测(capabilities.js::probeKling)与任务执行(handlers/kling.js::_resolveModel)
 * 都要跑 `kling who_am_i` 取可用模型清单。两者并发时官方 CLI 偶发 exit 1
 * （疑似自身不耐并发自检），表现为"管家一启动就报错 / 本地账户暂不可用"。
 *
 * 本模块把并发的 who_am_i 调用合流成一次实际 spawn（单飞），并对**成功结果**做短 TTL 缓存。
 *
 * 关键纪律（对抗式审查结论）：
 *   只缓存成功(code===0)结果；失败(非零退出 / spawn 拒绝)一律不缓存、放行下次重试，
 *   避免一次偶发失败毒化缓存、在 TTL 窗口内堵死真实任务。
 */

const { runCli } = require('./cli');

let _cache = null;        // { at:ms, result }
let _inflight = null;     // Promise<result> | null（飞行中的单次调用）
const TTL_MS = 60 * 1000; // who_am_i 变化极慢，成功结果缓存 60s 足够

/**
 * 取 who_am_i 结果（{code,stdout,stderr,json}）。并发调用复用同一次 spawn。
 * @param {object} cfg
 * @param {object} [opts] { ttlMs, force } force=true 跳过缓存强制重跑（登录态可能刚变）
 */
async function whoAmICached(cfg, opts = {}) {
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : TTL_MS;
  const force = !!opts.force;
  const now = Date.now();
  if (!force && _cache && (now - _cache.at) < ttlMs) {
    return _cache.result;
  }
  if (_inflight) return _inflight; // 单飞：合并并发调用，杜绝并发 who_am_i 撞 exit 1
  const bin = (cfg.kling && cfg.kling.binary) || 'kling';
  _inflight = (async () => {
    const r = await runCli(bin, ['who_am_i', '--quiet'], {
      timeoutMs: 60000, label: 'kling who_am_i',
    });
    // 只缓存成功；失败不污染缓存（下次仍重试）
    if (r && r.code === 0) _cache = { at: Date.now(), result: r };
    return r;
  })();
  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

function clearCache() { _cache = null; }

module.exports = { whoAmICached, clearCache };
