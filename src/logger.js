'use strict';
/** logger.js — 极简带时间戳日志 · ADR-0149 */

function _ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function _fmt(level, args) {
  return `[${_ts()}] ${level} ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
}

const log = {
  info: (...a) => console.log(_fmt('INFO ', a)),
  warn: (...a) => console.warn(_fmt('WARN ', a)),
  error: (...a) => console.error(_fmt('ERROR', a)),
  ok: (...a) => console.log(_fmt('OK   ', a)),
};

module.exports = log;
