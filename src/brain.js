'use strict';
/**
 * brain.js — 「脑子」接口预留 · ADR-0149
 *
 * v1 = 直通（null brain）：harness 把服务端工单原样交给 CLI handler。
 * 未来若要在本机加「智能体大脑」（如本地 LLM 改写 prompt、自动挑模型、失败自愈重试、
 * 多 CLI 编排），实现 plan(job, ctx) 返回改写后的 job 即可，harness 不必改。
 *
 * 设计意图：harness 是通用执行外壳（认领/心跳/回传/清理），brain 是可选决策层，
 * handler 是 per-CLI 翻译层。三层解耦，便于后续把「通用 agent harness」能力下沉到本机。
 */

/**
 * @param {object} job  服务端工单信封 {tool, action, params, refs}
 * @param {object} ctx  { cfg }
 * @returns {object} 可能改写后的 job（v1 原样返回）
 */
async function plan(job /*, ctx */) {
  return job;
}

module.exports = { plan };
