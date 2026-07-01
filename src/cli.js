'use strict';
/**
 * cli.js — 官方 CLI 子进程封装 · ADR-0149
 *
 * I-BYO-NOTOKEN：本模块只 spawn 官方二进制（kling / dreamina）并解析其 stdout JSON，
 * 从不读取 CLI 的凭证文件、从不把 stdout 里的任何 token 字段回传 ARTVAS。
 */

const { spawn } = require('child_process');
const log = require('./logger');

/**
 * 运行一条 CLI 命令，返回 { code, stdout, stderr, json }。
 * @param {string} bin   二进制名（kling / dreamina）
 * @param {string[]} args 参数数组（已分好词，避免 shell 注入）
 * @param {object} opts  { timeoutMs, label, onLine }
 */
function runCli(bin, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20 * 60 * 1000; // 默认 20min，覆盖长生成
  const label = opts.label || bin;
  return new Promise((resolve, reject) => {
    log.info(`$ ${bin} ${args.map(_q).join(' ')}`);
    let child;
    try {
      child = spawnCompat(bin, args, { windowsHide: true });
    } catch (e) {
      return reject(new Error(`无法启动 ${bin}（是否已安装并在 PATH？）: ${e.message}`));
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (opts.onLine) {
        s.split(/\r?\n/).forEach((ln) => { if (ln.trim()) opts.onLine(ln); });
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${label} 执行出错: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        return reject(new Error(`${label} 超时（>${Math.round(timeoutMs / 60000)}min）已终止`));
      }
      resolve({ code, stdout, stderr, json: extractLastJson(stdout) });
    });
  });
}

function _q(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * 跨平台 spawn 兼容封装。
 * Windows 必须经 shell 才能跑 .cmd/.bat 形态的 CLI（如 npm 安装的 kling.cmd）：
 *   1) spawn('kling') 无 shell 时 Node 不补 PATHEXT → ENOENT（doctor 误报"未找到"的真因）
 *   2) spawn('kling.cmd') 无 shell 被 Node 18.20+/20.12+/22（CVE-2024-27980）拒绝执行
 * 故 Windows 下走 shell:true 让 cmd 解析 PATH+PATHEXT，并对每个 arg 做 cmd 安全引用（含用户 prompt）。
 */
function spawnCompat(bin, args, opts = {}) {
  if (process.platform === 'win32') {
    return spawn(bin, (args || []).map(_winArg), Object.assign({ windowsHide: true }, opts, { shell: true }));
  }
  return spawn(bin, args || [], Object.assign({ windowsHide: true }, opts));
}

/**
 * Windows cmd 命令行参数安全引用（shell:true 场景）。
 * 双引号包裹 + 内部 " → ""（cmd 与 MSVCRT argv 解析双重兼容），去裸换行。
 * 元字符 & | < > ^ ( ) 在双引号内被 cmd 保护，无需额外转义。
 *
 * %VAR% 环境变量展开阻断（ADR-0149 §5.10 C2）：cmd /c（shell:true 用 `cmd /d /s /c`）会把
 * 参数里成对的 %NAME% 展开成本机环境变量值（如 prompt 写 "%USERNAME% 的家" 会被替换）。
 * cmd /c 非 batch 上下文 `%%` 不折叠（加倍会让 CLI 收到双 %，反而破坏文案），且无法彻底转义 %，
 * 故改为「拆对」：把形如 %NAME% 的成对 token 去掉收尾 % 令其无法解析为变量；孤立 %（如 "50%"）
 * 保持原样不影响文案。循环到收敛，杜绝相邻 token 残留可解析对。这是本机自用数据（无跨租户面），
 * 仅为消除偶发文案串改，非 RCE 面（注入面已由直引数组 + 双引号包裹堵死）。
 */
function _winArg(s) {
  s = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
  let prev;
  do { prev = s; s = s.replace(/%([A-Za-z0-9_]+)%/g, '%$1'); } while (s !== prev);
  return '"' + s.replace(/"/g, '""') + '"';
}

/** 从 stdout 中提取最后一个可解析的 JSON 对象（CLI 常以单行 JSON 收尾，-q 模式尤甚）。 */
function extractLastJson(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if ((ln.startsWith('{') && ln.endsWith('}')) || (ln.startsWith('[') && ln.endsWith(']'))) {
      try { return JSON.parse(ln); } catch { /* 继续上一行 */ }
    }
  }
  // 兜底：尝试把整块当 JSON
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* noop */ }
  // 再兜底：截取首个 { 到末个 }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* noop */ }
  }
  return null;
}

// 视频 URL 字段优先级：无水印优先（会员权益），再普通，再下载直链。封面/缩略图排除。
const _NOWM_KEYS = ['url_without_watermark', 'urlwithoutwatermark', 'no_watermark_url', 'nowatermark_url', 'wm_free_url'];
const _URL_KEYS = ['video_url', 'videourl', 'result_url', 'resulturl', 'download_url', 'downloadurl', 'play_url', 'playurl', 'url', 'mp4_url', 'mp4url', 'src'];
const _EXCLUDE = /cover|thumb|poster|image|first_frame|preview_image/i;

/**
 * 从任意 CLI JSON 中递归提取「远端可下载的视频 URL」。
 * watermarkFree=true 时优先无水印字段。返回 https URL 或 ''。
 * 之所以要远端 URL（而非本地下载路径）：ARTVAS complete 端点会自己 GET 该 URL 归档落 OSS，
 * 校验要求 https 公网地址（byo_validate_result_url）。
 */
function extractVideoUrl(json, { watermarkFree = true } = {}) {
  if (!json) return '';
  const found = { nowm: [], normal: [] };

  const walk = (node, keyHint) => {
    if (!node) return;
    if (typeof node === 'string') {
      if (/^https:\/\/\S+\.(mp4|mov|webm|m4v)(\?\S*)?$/i.test(node) && !_EXCLUDE.test(keyHint || '')) {
        const bucket = _NOWM_KEYS.includes((keyHint || '').toLowerCase()) ? found.nowm : found.normal;
        bucket.push(node);
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach((v) => walk(v, keyHint)); return; }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const kl = k.toLowerCase();
        const v = node[k];
        if (typeof v === 'string' && /^https:\/\//i.test(v) && !_EXCLUDE.test(kl)) {
          if (_NOWM_KEYS.includes(kl)) found.nowm.push(v);
          else if (_URL_KEYS.includes(kl) && /\.(mp4|mov|webm|m4v)(\?|$)/i.test(v)) found.normal.push(v);
          else if (_URL_KEYS.includes(kl)) found.normal.push(v);
        }
        walk(v, k);
      }
    }
  };
  walk(json, '');

  const pick = (arr) => arr.find((u) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u)) || arr[0];
  if (watermarkFree && found.nowm.length) return pick(found.nowm);
  if (found.normal.length) return pick(found.normal);
  if (found.nowm.length) return pick(found.nowm); // 退而求其次
  return '';
}

/** 从 CLI JSON 中提取上游任务/生成 id（供心跳记 external_generation_id）。 */
function extractGenerationId(json) {
  if (!json || typeof json !== 'object') return '';
  const keys = ['generation_id', 'generationId', 'submit_id', 'submitId', 'task_id', 'taskId', 'id'];
  const find = (node) => {
    if (!node || typeof node !== 'object') return '';
    for (const k of keys) {
      if (node[k] && (typeof node[k] === 'string' || typeof node[k] === 'number')) return String(node[k]);
    }
    for (const k of Object.keys(node)) {
      const r = find(node[k]);
      if (r) return r;
    }
    return '';
  };
  return find(json);
}

module.exports = { runCli, spawnCompat, extractLastJson, extractVideoUrl, extractGenerationId };
