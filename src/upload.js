'use strict';
/**
 * upload.js — BYO 产物上传主路径 · ADR-0149 §5.9 / I-BYO-COMPANION-UPLOAD
 *
 * 管家本机下载厂商 CDN 成片字节 → multipart 上传 ARTVAS /api/deskpet/byo/upload。
 * 相对老的 server-pull（/complete 报 URL，服务端自己抓）：
 *   - 抓字节放在已证明可达的管家上（厂商 CDN 管家刚取过），不赌服务器可达；
 *   - 服务器主路径不再抓客户端给的 URL → 消除 SSRF 一整类风险。
 * 任一步失败抛错，由 harness 回落 server-pull（completeOk 报 result_url）。
 *
 * I-BYO-NOTOKEN：下载厂商产物不带任何 ARTVAS / CLI 凭证；上传只带 ARTVAS 受限令牌。
 */

const fs = require('fs');
const { downloadVideoToTemp } = require('./download');
const log = require('./logger');

/** 用文件构造上传 Blob：优先 fs.openAsBlob（懒读不进内存），回退 readFileSync。 */
async function _fileBlob(fp) {
  if (typeof fs.openAsBlob === 'function') {
    try {
      return await fs.openAsBlob(fp, { type: 'video/mp4' });
    } catch { /* 回退 */ }
  }
  return new Blob([fs.readFileSync(fp)], { type: 'video/mp4' });
}

/**
 * 上传主路径：下载厂商产物 → multipart 上传。
 * @returns 服务端 json（含 status:'SUCCESS'）；任一步失败抛错。
 */
async function uploadResult(cfg, { taskId, url, setStage }) {
  const _stage = (s) => { try { setStage && setStage(s); } catch { /* noop */ } };

  _stage('downloading_result');
  const dl = await downloadVideoToTemp(url, {}); // 厂商 CDN：opts 空 → 不带任何 token

  try {
    _stage('uploading');
    const blob = await _fileBlob(dl.path);
    const form = new FormData();
    form.append('task_id', taskId);
    form.append('file', blob, `${taskId}.mp4`);

    let resp;
    try {
      resp = await fetch(cfg.serverUrl + '/api/deskpet/byo/upload', {
        method: 'POST',
        headers: { 'X-Deskpet-Token': cfg.deskpetToken },
        body: form,
      });
    } catch (e) {
      throw new Error(`上传请求失败: ${e.message}`);
    }
    const text = await resp.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!resp.ok || !json.ok) {
      const detail = (json && json.error) || text.slice(0, 120);
      throw new Error(`上传被服务端拒绝 HTTP ${resp.status}: ${detail}`);
    }
    log.info(`产物已上传工作台 task=${taskId} (${dl.bytes} bytes)`);
    return json;
  } finally {
    try { fs.unlinkSync(dl.path); } catch { /* noop */ }
  }
}

module.exports = { uploadResult };
