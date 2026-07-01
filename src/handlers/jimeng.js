'use strict';
/**
 * handlers/jimeng.js — 即梦 `dreamina` CLI handler · ADR-0149
 *
 * 把通用工单信封翻译成 dreamina 子命令（参数为 --key=value 形式）：
 *   text2video     → dreamina text2video --prompt="..." --duration=5 --ratio=16:9 --video_resolution=720p --poll=30
 *   image2video    → dreamina image2video --image ./first.png --prompt="..." --duration=5 --poll=30
 *   multiframe2video → dreamina multiframe2video --images a.png,b.png --prompt="..." --duration=3
 * 即梦强制本地路径（harness 已把 refs 下载成本机文件）。model_version 来自 config（model_hint 无意义）。
 *
 * 合规：遇 AigcComplianceConfirmationRequired 须原样把错误码回传用户
 * （需先去即梦 Web 完成授权确认再重试）。I-BYO-JIMENG-FLAG：服务端已 flag 把关，默认关。
 */

const { runCli, extractVideoUrl, extractGenerationId } = require('../cli');

const tool = 'jimeng';
const COMPLIANCE_CODE = 'AigcComplianceConfirmationRequired';

async function run({ job, files, cfg, onProgress }) {
  const p = (job && job.params) || {};
  const prompt = (p.prompt || '').trim();
  const action = job.action === 'image2video' ? 'image2video' : 'text2video';
  const poll = String((cfg.jimeng && cfg.jimeng.pollSeconds) || 30);
  const mv = (cfg.jimeng && cfg.jimeng.defaultModelVersion) || '';
  const duration = String(p.duration || '5').replace(/[^0-9]/g, '') || '5';
  const ratio = p.aspect_ratio || '16:9';
  const res = p.resolution || '';

  let reportedGen = '';
  const onLine = (ln) => {
    if (reportedGen) return;
    try {
      const j = JSON.parse(ln);
      const gid = extractGenerationId(j);
      if (gid) { reportedGen = gid; if (onProgress) onProgress(gid); }
    } catch { /* noop */ }
  };

  let args;
  if (action === 'image2video') {
    if (!files || !files.length) throw new Error('图生视频缺少参考图');
    if (files.length >= 2) {
      const list = files.map((f) => f.path).join(',');
      args = ['multiframe2video', `--images=${list}`, `--duration=${duration}`, `--poll=${poll}`];
      if (prompt) args.push(`--prompt=${prompt}`);
    } else {
      args = ['image2video', `--image=${files[0].path}`, `--duration=${duration}`, `--poll=${poll}`];
      if (prompt) args.push(`--prompt=${prompt}`);
    }
  } else {
    if (!prompt) throw new Error('文生视频缺少提示词');
    args = ['text2video', `--prompt=${prompt}`, `--duration=${duration}`, `--ratio=${ratio}`, `--poll=${poll}`];
    if (res) args.push(`--video_resolution=${res}`);
  }
  if (mv) args.push(`--model_version=${mv}`);

  const r = await runCli(cfg.jimeng.binary, args, {
    timeoutMs: 25 * 60 * 1000, label: 'dreamina ' + action, onLine,
  });

  const blob = (r.stdout || '') + '\n' + (r.stderr || '');
  if (blob.includes(COMPLIANCE_CODE)) {
    throw new Error(`即梦需先在 Web 端完成内容授权确认（${COMPLIANCE_CODE}）：请打开即梦网站完成一次授权后重试`);
  }
  if (r.code !== 0) {
    throw new Error(`即梦生成失败（exit ${r.code}）：${(r.stderr || r.stdout || '').slice(0, 200)}`);
  }
  const url = extractVideoUrl(r.json, { watermarkFree: p.watermark_free !== false });
  if (!url) {
    throw new Error('未从即梦输出解析到视频 URL（可能仅本地下载或输出格式变化）');
  }
  const generationId = reportedGen || extractGenerationId(r.json) || '';
  return { url, generationId };
}

module.exports = { tool, run, COMPLIANCE_CODE };
