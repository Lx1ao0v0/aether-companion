'use strict';
/**
 * friendly.js — 把本地 CLI 的技术性报错翻译成用户可读的友好中文句 · ADR-0149
 *
 * 设计：管家回传给 ARTVAS 的 error 字段必须是脱敏、轻松、可操作的句子（用户在画布上看到的就是它），
 * 原始报错（含 exit code / stderr / URL / 路径）单独走 error_detail 给后端入诊断中心，供运维排障。
 * 不把 stderr 原文甩给终端用户（用户的诉求：别报技术细节，显得专业又减轻焦虑）。
 */

/** 剥离技术噪音：URL / HTTP码 / exit码 / 文件路径，压缩多余空白。 */
function stripTech(s) {
  return String(s || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b(?:HTTP|exit)\s*\d+\b/gi, '')
    .replace(/[A-Za-z]:\\[^\s]+/g, '')
    .replace(/(?:\/[\w.\-]+){2,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** rawMsg → 友好中文句（用户可见）。命中已知类目给可操作引导，否则剥技术细节兜底。 */
function friendlyError(rawMsg) {
  const msg = String(rawMsg || '').trim();
  const low = msg.toLowerCase();
  if (/未登录|登录已过期|\blogin\b|credential|unauthor|\b401\b/.test(low)) {
    return '本地客户端未登录或登录已过期：请在管家所在电脑上重新登录后重试';
  }
  if (/who_am_i|自检失败|可用模型|视频权限|灰度/.test(low)) {
    return '本地账户暂不可用：请确认会员有效且已登录，稍后重试';
  }
  if (/余额|灵感值|不足|insufficient|配额|quota/.test(low)) {
    return '本地账户额度不足：请前往官网充值后重试';
  }
  if (/超时|timeout|timed out|query_tasks|已等待 \d+s|poll/.test(low) || /未完成.*已等待/.test(msg)) {
    return '本地生成还在排队或渲染中，等待时间不够；请稍后重试，或在管家 config.json 把 kling.pollSeconds 调大（单位：秒，建议 600 起）';
  }
  if (/参考图/.test(msg)) {
    return stripTech(msg) || '参考图准备失败，请确认图片有效后重试';
  }
  const cleaned = stripTech(msg);
  // 已是简短中文友好句的保留；否则给通用兜底（不暴露 stderr 原文）
  if (cleaned && /[\u4e00-\u9fa5]/.test(cleaned) && cleaned.length <= 60) return cleaned;
  return '本地生成失败，请重试；若反复失败请检查本地客户端状态';
}

module.exports = { friendlyError, stripTech };
