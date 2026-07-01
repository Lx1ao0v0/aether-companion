'use strict';
/**
 * download.js — 统一参考图策略 · ADR-0149
 *
 * harness 统一把工单 refs（ARTVAS 匿名能力 URL /api/images/file/xxx）下载成本机临时文件，
 * 再把本地路径喂给 CLI：即梦强制本地路径，可灵接受本地路径（自动 file_upload）。
 * 一套逻辑通吃两端。执行完由调用方 cleanup。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

function _tmpRoot() {
  const dir = path.join(os.tmpdir(), 'aether-companion');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  return dir;
}

function _extFromUrlOrType(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  const m = /\.(png|jpe?g|webp|gif)(\?|$)/i.exec(url || '');
  if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  return '.png';
}

/** 相对路径（/api/images/file/xxx）补全为 ARTVAS 绝对 URL。 */
function _absolutize(url, serverBase) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url && url.startsWith('/') && serverBase) return serverBase + url;
  return url;
}

function _hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/**
 * loopback 归一：把 localhost / 127.0.0.1 / [::1] 视为同一主机（仅按端口区分）。
 * 防御 config.serverUrl 写 localhost、而 ARTVAS 下发 / 浏览器用 127.0.0.1 时，
 * 同源参考图被误判跨域 → 漏带 X-Deskpet-Token → 本地 fallback 401（ADR-0149 §5.7）。
 * 注：仅对本机回环放宽，公网 host 仍严格逐字比较，不会把 token 泄露给真实 CDN。
 */
function _normLoopback(hostport) {
  if (!hostport) return '';
  const lower = String(hostport).toLowerCase();
  let host = lower;
  let port = '';
  const ipv6 = /^\[(.+)\](?::(\d+))?$/.exec(lower); // [::1]:5000
  if (ipv6) { host = ipv6[1]; port = ipv6[2] || ''; }
  else {
    const m = /^([^:]+)(?::(\d+))?$/.exec(lower); // 127.0.0.1:5000 / localhost
    if (m) { host = m[1]; port = m[2] || ''; }
  }
  const isLoop = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const canon = isLoop ? 'loopback' : host;
  return port ? `${canon}:${port}` : canon;
}

function _sameOrigin(url, baseHost) {
  const h = _hostOf(url);
  if (!h || !baseHost) return false;
  if (h === baseHost) return true;
  return _normLoopback(h) === _normLoopback(baseHost);
}

/**
 * 安全跟随重定向下载。
 *
 * I-BYO-NOTOKEN 延伸：参考图托管在 ARTVAS（同源，需带 X-Deskpet-Token 鉴权），
 * 但 ARTVAS 媒体端点经常 302 跳到 OSS/CDN（跨域）。若沿用 fetch redirect:'follow'，
 * 浏览器/undici 会把同样的请求头透传给重定向目标 → 把 Deskpet Token 泄露给 OSS。
 * 因此这里用 redirect:'manual' 逐跳手动跟随：仅当**当前跳目标 host 与 ARTVAS 同源**时
 * 才附带 token，任何跨域跳转（含 OSS/CDN）一律裸请求。
 */
async function _fetchFollow(initialUrl, opts, maxRedirects) {
  const { deskpetToken, serverBase } = opts || {};
  const baseHost = serverBase ? _hostOf(serverBase) : null;
  let url = initialUrl;
  for (let i = 0; i <= (maxRedirects || 5); i++) {
    const headers = {};
    const sameOrigin = _sameOrigin(url, baseHost);
    if (sameOrigin && deskpetToken) headers['X-Deskpet-Token'] = deskpetToken;
    let resp;
    try {
      resp = await fetch(url, { redirect: 'manual', headers });
    } catch (e) {
      throw new Error(`参考图下载失败 ${url.slice(0, 80)}: ${e.message}`);
    }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) throw new Error(`参考图下载重定向缺少 Location（HTTP ${resp.status}）`);
      url = new URL(loc, url).toString();
      continue;
    }
    return { resp, finalUrl: url };
  }
  throw new Error('参考图下载重定向次数过多');
}

/** 下载单个 URL 到临时文件，返回本地绝对路径。 */
async function downloadToTemp(url, opts) {
  const abs = _absolutize(url, opts && opts.serverBase);
  const { resp } = await _fetchFollow(abs, opts, 5);
  if (!resp.ok) throw new Error(`参考图下载 HTTP ${resp.status}: ${abs.slice(0, 80)}`);
  const ab = await resp.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) throw new Error(`参考图为空: ${abs.slice(0, 80)}`);
  const ext = _extFromUrlOrType(abs, resp.headers.get('content-type'));
  const name = crypto.randomBytes(8).toString('hex') + ext;
  const fp = path.join(_tmpRoot(), name);
  fs.writeFileSync(fp, buf);
  log.info(`参考图已下载 → ${fp} (${buf.length} bytes)`);
  return fp;
}

/** 厂商产物视频扩展名推断（默认 .mp4）。 */
function _videoExt(url, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('webm')) return '.webm';
  if (ct.includes('quicktime') || ct.includes('x-msvideo')) return '.mov';
  const m = /\.(mp4|mov|webm|m4v|mkv)(\?|$)/i.exec(url || '');
  if (m) return '.' + m[1].toLowerCase();
  return '.mp4';
}

// 产物本地落地上限（与服务端 _VIDEO_PERSIST_MAX_BYTES / _BYO_UPLOAD_MAX 对齐），防打满用户磁盘。
const _RESULT_MAX_BYTES = 500 * 1024 * 1024;

/**
 * 流式下载厂商 CDN 成片到临时文件（ADR-0149 §5.9 上传主路径用）。
 * 厂商 CDN 跨域：opts 默认空 → 不带任何 ARTVAS token（I-BYO-NOTOKEN）。
 * 流式写盘 + 体积上限，避免 500MB 全进内存。返回 { path, bytes }。失败抛错。
 */
async function downloadVideoToTemp(url, opts) {
  const { resp, finalUrl } = await _fetchFollow(url, opts || {}, 5);
  if (!resp.ok) throw new Error(`产物下载 HTTP ${resp.status}: ${String(url).slice(0, 80)}`);
  const maxBytes = (opts && opts.maxBytes) || _RESULT_MAX_BYTES;
  const ext = _videoExt(finalUrl, resp.headers.get('content-type'));
  const name = crypto.randomBytes(8).toString('hex') + ext;
  const fp = path.join(_tmpRoot(), name);
  const out = fs.createWriteStream(fp);
  let total = 0;
  try {
    for await (const chunk of resp.body) {
      total += chunk.length;
      if (total > maxBytes) {
        throw new Error(`产物超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
      }
      if (!out.write(chunk)) {
        await new Promise((r) => out.once('drain', r));
      }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  } catch (e) {
    try { out.destroy(); } catch { /* noop */ }
    try { fs.unlinkSync(fp); } catch { /* noop */ }
    throw e;
  }
  if (total === 0) {
    try { fs.unlinkSync(fp); } catch { /* noop */ }
    throw new Error('产物为空');
  }
  log.info(`产物已下载 → ${fp} (${total} bytes)`);
  return { path: fp, bytes: total };
}

/**
 * 把工单 refs（[{role,url}]）全部下载成本地文件。
 * opts: { deskpetToken, serverBase } —— 用于对 ARTVAS 同源参考图鉴权（见 _fetchFollow）。
 * 返回 { files: [{role, path}], cleanup: fn }。
 */
async function materializeRefs(refs, opts) {
  const files = [];
  for (const r of refs || []) {
    if (!r || !r.url) continue;
    const fp = await downloadToTemp(r.url, opts);
    files.push({ role: r.role || 'image', path: fp });
  }
  const cleanup = () => {
    for (const f of files) {
      try { fs.unlinkSync(f.path); } catch { /* noop */ }
    }
  };
  return { files, cleanup };
}

module.exports = { materializeRefs, downloadToTemp, downloadVideoToTemp };
