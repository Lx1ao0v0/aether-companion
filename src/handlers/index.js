'use strict';
/**
 * handlers/index.js — handler 注册表 · ADR-0149
 *
 * 通用 harness 按工单 tool 字段路由到对应 CLI handler。新增第三方 CLI（如 runway/pika）
 * 只需在此注册一个 { tool, run } handler，harness 不改。
 */

const kling = require('./kling');
const jimeng = require('./jimeng');

const REGISTRY = {
  [kling.tool]: kling,
  [jimeng.tool]: jimeng,
};

function getHandler(tool) {
  return REGISTRY[(tool || '').toLowerCase()] || null;
}

function supportedTools() {
  return Object.keys(REGISTRY);
}

module.exports = { getHandler, supportedTools, REGISTRY };
