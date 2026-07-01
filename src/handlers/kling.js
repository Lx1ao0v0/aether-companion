'use strict';
/**
 * handlers/kling.js — 可灵 `kling` CLI handler · ADR-0149
 *
 * 把通用工单信封翻译成 kling 子命令（两阶段）：
 *   1) text_to_video / image_to_video 提交（不带 --poll，秒级返回 generation_id + 上传参考图）
 *   2) query_tasks --poll <N> 长轮询直到出片（N = config.kling.pollSeconds，默认 1800s，上限 7200s）
 * 注：可灵 image_to_video 只接受**单张** --image（多图是 image_to_image 的能力），故图生视频只用首帧。
 * 模型动态发现：model_hint（video_kling_byo）对 kling 无意义，必须 who_am_i 取 available_models，
 * 或用 config.kling.defaultModel 覆盖。--model 必填无默认。
 *
 * I-BYO-NOTOKEN：只 spawn kling，凭证由 kling 自管（kling login）；输出里的任何 token 不外传。
 */

const { runCli, extractVideoUrl, extractGenerationId } = require('../cli');
const { whoAmICached } = require('../klingCaps');
const log = require('../logger');

const tool = 'kling';

// who_am_i 真实结构（实机核对 2026-06）：
//   { ok, status, body:{ available_models:{ text_to_video:{models:[{model,alias,arguments:[{name,allowed_values,default}]}]},
//                                          image_to_video:{...}, ... } } }
// 模型按「能力组」分组，每个 model 自带 arguments 声明（duration/aspect_ratio/resolution 的合法值各异）。
function _group(action) {
  return action === 'image2video' ? 'image_to_video' : 'text_to_video';
}

function _availableModels(json) {
  const root = (json && (json.body || json.data || json)) || {};
  return root.available_models || root.availableModels || {};
}

function _extractModels(json, group) {
  const am = _availableModels(json);
  let arr = [];
  if (am && typeof am === 'object' && !Array.isArray(am)) {
    const grp = am[group];
    arr = (grp && Array.isArray(grp.models)) ? grp.models : (Array.isArray(grp) ? grp : []);
  } else if (Array.isArray(am)) {
    arr = am; // 兼容旧扁平结构
  }
  const out = [];
  for (const m of arr) {
    if (typeof m === 'string') out.push(m);
    else if (m && typeof m === 'object') out.push(m.model || m.name || m.id || m.model_name || '');
  }
  return out.filter(Boolean);
}

// 取某模型声明的参数表：{ name -> allowed_values[] | null（null=任意值） }
function _modelSpec(json, group, modelName) {
  const am = _availableModels(json);
  const grp = am && am[group];
  const models = (grp && grp.models) || [];
  const m = models.find((x) => (x.model || x.name) === modelName) || models[0];
  const spec = {};
  for (const a of ((m && m.arguments) || [])) {
    if (a && a.name) spec[a.name] = Array.isArray(a.allowed_values) ? a.allowed_values : null;
  }
  return spec;
}

// 按模型声明钳制透传：模型未声明该参数→不传；值不在 allowed_values→跳过用服务端默认。
// spec=null 表示不校验（如 config.defaultModel 时全透传，用户自负）。
function _pushArg(args, spec, name, value) {
  if (value == null || value === '') return;
  const v = String(value);
  if (spec) {
    const allowed = spec[name];
    if (allowed === undefined) return;
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(v)) return;
  }
  args.push('--' + name, v);
}

/** 可灵 CLI --poll N 的单位是**秒**（非次数）。视频渲染常需数分钟，**排队高峰时更久**，
 *  低于 600 易在仍排队时误报失败。默认 1800（30 分钟），上限 7200（2 小时）。
 *  注：--poll 一到终态（成功/失败）即返回，N 只是"最长等多久"，调大不拖慢正常出片。
 *  服务端心跳每 30s 续 claim（heartbeat_byo_task +1800s），故拉长本轮询不会被僵尸回收误杀。 */
function _pollSeconds(cfg) {
  const n = Number((cfg.kling && cfg.kling.pollSeconds) || 1800);
  if (!Number.isFinite(n) || n < 600) {
    log.warn(`kling.pollSeconds=${cfg.kling && cfg.kling.pollSeconds} 过短（视频排队常需数十分钟），已钳制为 1800`);
    return 1800;
  }
  return Math.min(Math.floor(n), 7200);
}

async function _submitAndPoll({ bin, submitArgs, pollSec, label, onProgress, onLine }) {
  const rSubmit = await runCli(bin, submitArgs, {
    timeoutMs: 8 * 60 * 1000, // 上传参考图 + 提交可能较慢
    label: label + ' submit',
    onLine,
  });
  let genId = extractGenerationId(rSubmit.json) || '';
  if (rSubmit.code !== 0 && !genId) {
    throw new Error(`可灵提交失败（exit ${rSubmit.code}）：${(rSubmit.stderr || rSubmit.stdout || '').slice(0, 200)}`);
  }
  if (rSubmit.code !== 0 && genId) {
    log.warn(`${label} 提交 exit ${rSubmit.code} 但已拿到 generation_id，继续轮询…`);
  }
  if (genId && onProgress) onProgress(genId);

  if (!genId) {
    throw new Error('可灵提交成功但未解析到 generation_id，无法轮询结果');
  }

  const rPoll = await runCli(bin, ['query_tasks', '--poll', String(pollSec), '--quiet', genId], {
    timeoutMs: (pollSec + 120) * 1000,
    label: `${label} poll ${pollSec}s`,
    onLine,
  });
  if (rPoll.code !== 0) {
    throw new Error(
      `可灵生成未完成（query_tasks exit ${rPoll.code}，已等待 ${pollSec}s）：${(rPoll.stderr || rPoll.stdout || '').slice(0, 200)}`
    );
  }
  return { json: rPoll.json, generationId: genId };
}

async function _resolveModel(cfg, group, requestedModel) {
  if (cfg.kling.defaultModel) return { model: cfg.kling.defaultModel, spec: null };
  // 单飞缓存：与能力探测共用一次 who_am_i，避免并发自检撞 exit 1（klingCaps）。
  const r = await whoAmICached(cfg);
  if (!r || r.code !== 0) {
    throw new Error(`可灵自检失败（who_am_i exit ${r ? r.code : '?'}）：${((r && r.stderr) || '').slice(0, 160)}。请确认已 kling login 且账户有视频权限`);
  }
  const models = _extractModels(r.json, group);
  if (!models.length) {
    throw new Error(`可灵未发现 ${group} 可用模型。请确认会员有效且已 kling login`);
  }
  // 用户在画布选定的本机模型（params.model）优先，但必须确在 who_am_i 清单内（防过期/越权）；
  // 不在清单或未指定 → 回退首个可用模型。
  const want = (requestedModel || '').trim();
  let model = models[0];
  if (want && models.includes(want)) {
    model = want;
  } else if (want) {
    log.warn(`请求模型 ${want} 不在可灵 ${group} 清单(${models.join(', ')})，回退 ${model}`);
  }
  log.info(`可灵 ${group} 可用模型: ${models.join(', ')} → 选用 ${model}`);
  return { model, spec: _modelSpec(r.json, group, model) };
}

async function run({ job, files, cfg, onProgress }) {
  const p = (job && job.params) || {};
  const prompt = (p.prompt || '').trim();
  const action = job.action === 'image2video' ? 'image2video' : 'text2video';
  const group = _group(action);
  const pollSec = _pollSeconds(cfg);
  const { model, spec } = await _resolveModel(cfg, group, p.model);

  let reportedGen = '';
  const onLine = (ln) => {
    if (reportedGen) return;
    try {
      const j = JSON.parse(ln);
      const gid = extractGenerationId(j);
      if (gid) { reportedGen = gid; if (onProgress) onProgress(gid); }
    } catch { /* 非 JSON 行忽略 */ }
  };

  let args;
  if (action === 'image2video') {
    if (!files || !files.length) throw new Error('图生视频缺少参考图');
    args = ['image_to_video', '--model', model, '--quiet'];
    const tail = files.find((f) => f.role === 'last');
    const heads = files.filter((f) => f.role !== 'last');
    if (!heads.length) throw new Error('图生视频缺少首帧参考图');
    // 可灵 image_to_video 只接受单张 --image；多张时仅用第一张，其余丢弃并告警
    if (heads.length > 1) {
      log.warn(`可灵图生视频仅支持单张首帧，已用第 1 张，忽略其余 ${heads.length - 1} 张参考图`);
    }
    args.push('--image', heads[0].path); // 本地路径，kling CLI 自动 file_upload
    if (tail) args.push('--tailImage', tail.path);
    // 图生视频比例由首帧决定，不传 aspect_ratio；时长/分辨率按模型声明钳制透传
    _pushArg(args, spec, 'duration', String(p.duration || '').replace(/[^0-9]/g, ''));
    _pushArg(args, spec, 'resolution', p.resolution);
    if (prompt) args.push(prompt);
  } else {
    if (!prompt) throw new Error('文生视频缺少提示词');
    args = ['text_to_video', '--model', model, '--quiet'];
    _pushArg(args, spec, 'duration', String(p.duration || '').replace(/[^0-9]/g, ''));
    _pushArg(args, spec, 'aspect_ratio', p.aspect_ratio);
    _pushArg(args, spec, 'resolution', p.resolution);
    args.push(prompt); // prompt 为位置参数，置于末尾
  }

  const { json, generationId: polledGenId } = await _submitAndPoll({
    bin: cfg.kling.binary,
    submitArgs: args,
    pollSec,
    label: 'kling ' + action,
    onProgress,
    onLine,
  });
  const url = extractVideoUrl(json, { watermarkFree: p.watermark_free !== false });
  if (!url) {
    throw new Error('未从可灵输出解析到视频 URL（可能模型仅返回本地下载，或输出格式变化）');
  }
  return { url, generationId: reportedGen || polledGenId || extractGenerationId(json) || '' };
}

module.exports = { tool, run };
