'use strict';
/**
 * capabilities.js — 本地视频能力清单采集 + 脱敏上报 · ADR-0149
 *
 * 跑 `kling who_am_i --quiet` 解析 available_models，整理成「按能力组分模型 + 每模型参数白名单」，
 * 上报 ARTVAS 供画布视频节点渲染「厂商 / 模型 / 细节参数」下拉。
 *
 * I-BYO-CAP-SANITIZE：who_am_i 输出含灵感值 / 账号 / membership / token 等敏感字段，
 * 本模块**只透传**模型名 / 别名 / 参数名 / allowed_values / default 这几类字段，
 * 其余一律丢弃，绝不把账户/凭证信息回传 ARTVAS（I-BYO-NOTOKEN 延伸）。
 */

const { whoAmICached } = require('./klingCaps');
const log = require('./logger');

// who_am_i 结构（实机核对 2026-06）：
//   { ok, body:{ available_models:{ text_to_video:{models:[{model,alias,arguments:[{name,allowed_values,default}]}]},
//                                   image_to_video:{...} } } }
function _availableModels(json) {
  const root = (json && (json.body || json.data || json)) || {};
  return root.available_models || root.availableModels || {};
}

// 单个参数白名单脱敏：仅保留 name / allowed_values / default。allowed_values 限长防爆。
function _cleanArg(a) {
  if (!a || !a.name) return null;
  const clean = { name: String(a.name) };
  if (Array.isArray(a.allowed_values)) {
    clean.allowed_values = a.allowed_values.map((v) => String(v)).slice(0, 40);
  }
  if (a.default !== undefined && a.default !== null && a.default !== '') {
    clean.default = String(a.default);
  }
  return clean;
}

// 单个模型白名单脱敏：仅保留 model / alias / args。
function _cleanModel(m) {
  if (typeof m === 'string') return { model: m, alias: '', args: [] };
  if (!m || typeof m !== 'object') return null;
  const name = m.model || m.name || m.id || m.model_name || '';
  if (!name) return null;
  const args = [];
  for (const a of (m.arguments || m.inputs || [])) {
    const c = _cleanArg(a);
    if (c) args.push(c);
  }
  return { model: String(name), alias: m.alias ? String(m.alias) : '', args };
}

function _cleanGroup(grp) {
  const arr = (grp && Array.isArray(grp.models)) ? grp.models : (Array.isArray(grp) ? grp : []);
  const out = [];
  for (const m of arr) {
    const c = _cleanModel(m);
    if (c) out.push(c);
  }
  return out;
}

/**
 * 探测可灵能力。返回：
 *   { online:false }                       —— CLI 不在/无法启动（未安装）
 *   { online:true, logged_in:false }       —— CLI 在但未登录/无视频权限/who_am_i 失败
 *   { online:true, logged_in:true, models:{ text2video:[...], image2video:[...] } }
 */
async function probeKling(cfg, opts = {}) {
  let r;
  try {
    // 与 handlers/kling.js 共用单飞缓存：并发探测/执行不再各自 spawn who_am_i（消除 exit 1）。
    r = await whoAmICached(cfg, { force: !!opts.force });
  } catch (e) {
    log.info(`可灵能力探测：CLI 不可用（${(e && e.message || '').slice(0, 80)}）`);
    return { online: false, logged_in: false };
  }
  if (!r || r.code !== 0) {
    return { online: true, logged_in: false };
  }
  const am = _availableModels(r.json);
  const t2v = _cleanGroup(am.text_to_video);
  const i2v = _cleanGroup(am.image_to_video);
  const loggedIn = !!(t2v.length || i2v.length);
  return { online: true, logged_in: loggedIn, models: { text2video: t2v, image2video: i2v } };
}

/** 汇总所有支持工具的能力清单（当前仅可灵；即梦 who_am_i 形态待实机后接入）。
 *  opts.force=true 时跳过单飞缓存强制重探（启动首报 / 任务结束后刷新登录态用）。 */
async function collectCapabilities(cfg, opts = {}) {
  const caps = {};
  caps.kling = await probeKling(cfg, { force: !!opts.force });
  return caps;
}

module.exports = { collectCapabilities, probeKling };
