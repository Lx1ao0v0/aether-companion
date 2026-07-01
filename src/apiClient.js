'use strict';
/**
 * apiClient.js — ARTVAS Deskpet BYO 端点封装 · ADR-0149
 *
 * 凭 X-Deskpet-Token（复用桌宠通道）调用服务端 5 个端点：
 *   GET  /api/deskpet/me           自检 / 取会员等级
 *   GET  /api/deskpet/byo/tasks    轮询待认领工单
 *   POST /api/deskpet/byo/claim    认领（awaiting_deskpet → running_local）
 *   POST /api/deskpet/byo/progress 心跳（延长认领有效期 + 记上游生成 id）
 *   POST /api/deskpet/byo/complete 回传产物 URL / 失败
 *
 * I-BYO-NOTOKEN：本客户端只发 ARTVAS 自己的 Deskpet Token，绝不携带任何
 * 可灵/即梦凭证。回传给服务端的只有「上游 CDN 产物 URL」或「错误信息」。
 */

const log = require('./logger');

class ApiClient {
  constructor(cfg) {
    this.base = cfg.serverUrl;
    this.token = cfg.deskpetToken;
  }

  /** 热更新鉴权（config.json 被「一键连接」改写后，运行中的管家无需重启即生效）。 */
  updateAuth(serverUrl, token) {
    if (serverUrl) this.base = String(serverUrl).replace(/\/+$/, '');
    if (token) this.token = token;
  }

  async _req(method, path, body) {
    const url = this.base + path;
    const headers = { 'X-Deskpet-Token': this.token, Accept: 'application/json' };
    const opts = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let resp;
    try {
      resp = await fetch(url, opts);
    } catch (e) {
      throw new Error(`网络请求失败 ${method} ${path}: ${e.message}`);
    }
    const text = await resp.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`服务端返回非 JSON（HTTP ${resp.status}）: ${text.slice(0, 160)}`);
    }
    if (resp.status === 401) {
      throw new Error('鉴权失败（HTTP 401）：Deskpet Token 无效或已过期，请重新在 ARTVAS 复制');
    }
    if (resp.status === 403) {
      const msg = (json && json.error) || '无权使用自带 CLI 通道（需高级/专业版会员）';
      const err = new Error(msg);
      err.forbidden = true;
      throw err;
    }
    if (!resp.ok && !json) {
      throw new Error(`HTTP ${resp.status} ${method} ${path}`);
    }
    return json;
  }

  /** 自检：返回 {ok, membership_tier, mode, ...} */
  me() {
    return this._req('GET', '/api/deskpet/me');
  }

  /** 列出待认领 BYO 工单 → [{task_id, tool, billing_source, created_at, job}] */
  async listTasks() {
    const r = await this._req('GET', '/api/deskpet/byo/tasks');
    return (r && r.jobs) || [];
  }

  /** 认领工单 → {ok, task_id, job, already_claimed?} */
  claim(taskId) {
    return this._req('POST', '/api/deskpet/byo/claim', { task_id: taskId });
  }

  /** 心跳：延长认领有效期，可带上游生成 id 与当前阶段（友好进度文案用） */
  progress(taskId, externalGenerationId, stage) {
    const body = { task_id: taskId };
    if (externalGenerationId) body.external_generation_id = String(externalGenerationId);
    if (stage) body.stage = String(stage);
    return this._req('POST', '/api/deskpet/byo/progress', body).catch((e) => {
      // 心跳失败不致命：仅告警，下一轮再续
      log.warn(`心跳失败 task=${taskId}: ${e.message}`);
      return { ok: false };
    });
  }

  /** 回传成功产物 URL */
  completeOk(taskId, resultUrl) {
    return this._req('POST', '/api/deskpet/byo/complete', { task_id: taskId, result_url: resultUrl });
  }

  /** 回传失败：error=脱敏友好句（用户可见），error_detail=原始报错（仅入后端诊断，不展示） */
  completeFail(taskId, errorMsg, rawDetail) {
    const body = { task_id: taskId, error: String(errorMsg || '本地生成失败').slice(0, 200) };
    if (rawDetail && rawDetail !== errorMsg) body.error_detail = String(rawDetail).slice(0, 500);
    return this._req('POST', '/api/deskpet/byo/complete', body);
  }

  /**
   * 上报本地视频能力清单（在线/登录态 + 模型/参数白名单），供画布渲染厂商/模型下拉。
   * 失败不致命：管家照常轮询工单，只是画布拿不到动态清单会退静态兜底。
   */
  reportCapabilities(caps) {
    return this._req('POST', '/api/deskpet/byo/capabilities', { capabilities: caps || {} }).catch((e) => {
      log.warn(`能力上报失败: ${e.message}`);
      return { ok: false };
    });
  }
}

module.exports = { ApiClient };
