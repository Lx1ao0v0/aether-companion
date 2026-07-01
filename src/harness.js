'use strict';
/**
 * harness.js — 通用执行外壳 · ADR-0149
 *
 * 与具体 CLI 无关的执行循环：
 *   轮询 GET /byo/tasks → CAS 认领 → brain.plan(可选) → 下载参考图 →
 *   起心跳 → 路由到 handler 执行 → 回传 complete → 清理临时文件。
 *
 * 设计：harness（通用）+ brain（决策，可空）+ handler（per-CLI 翻译）三层解耦。
 * 新增第三方 CLI 只加 handler；本文件永不为某个 CLI 写特例。
 *
 * I-BYO-NOTOKEN：harness 只搬运服务端工单与上游产物 URL，绝不接触/转发任何 CLI 凭证。
 */

const { getHandler, supportedTools } = require('./handlers');
const brain = require('./brain');
const { materializeRefs } = require('./download');
const { uploadResult } = require('./upload');
const { friendlyError } = require('./friendly');
const log = require('./logger');

class Harness {
  constructor(api, cfg) {
    this.api = api;
    this.cfg = cfg;
    this.inflight = new Set(); // 正在处理的 task_id，去重防双认领
    this.stopped = false;
  }

  stop() { this.stopped = true; }

  /** 跑一轮：拉取 → 对每个可处理工单启动执行（受 maxConcurrent 限制）。返回本轮启动数。 */
  async tick() {
    let jobs;
    try {
      jobs = await this.api.listTasks();
    } catch (e) {
      if (e.forbidden) { log.error(e.message); }
      else log.warn(`拉取工单失败: ${e.message}`);
      return 0;
    }
    let started = 0;
    for (const item of jobs) {
      if (this.inflight.size >= this.cfg.maxConcurrent) break;
      const tid = item && item.task_id;
      if (!tid || this.inflight.has(tid)) continue;
      const tool = (item.tool || '').toLowerCase();
      if (!getHandler(tool)) {
        log.warn(`跳过未知工具工单 task=${tid} tool=${tool}（本机仅支持 ${supportedTools().join('/')}）`);
        continue;
      }
      this.inflight.add(tid);
      started++;
      // 不 await：并发执行，受 inflight/maxConcurrent 控量
      this._process(tid).finally(() => this.inflight.delete(tid));
    }
    return started;
  }

  async _process(taskId) {
    const handlerHint = '';
    let cleanup = () => {};
    let hbTimer = null;
    let lastGen = '';
    let stage = '';
    try {
      // 1) 认领（CAS awaiting_deskpet → running_local）
      const claimed = await this.api.claim(taskId);
      if (!claimed || !claimed.ok) {
        log.warn(`认领失败 task=${taskId}`);
        return;
      }
      const job = (claimed.job) || {};
      const tool = (job.tool || '').toLowerCase();
      const handler = getHandler(tool);
      if (!handler) {
        await this.api.completeFail(taskId, `本机不支持工具 ${tool}`);
        return;
      }
      log.ok(`已认领 task=${taskId} tool=${tool} action=${job.action}`);

      // 2) 心跳：立即一次 + 周期续约，避免被服务端僵尸回收。
      //    beat 每拍带当前 stage（友好分阶段进度），setStage 切阶段时立即补一拍。
      const beat = () => this.api.progress(taskId, lastGen, stage);
      const setStage = (s) => { stage = s; beat(); };
      await beat();
      hbTimer = setInterval(() => beat(), this.cfg.heartbeatIntervalMs);

      // 3) brain 决策层（v1 直通）
      const planned = await brain.plan(job, { cfg: this.cfg });

      // 4) 统一参考图策略：下载 refs 成本机临时文件
      //    透传 token+serverUrl：ARTVAS 同源参考图需带 X-Deskpet-Token 鉴权，
      //    跨域跳转（OSS）由 download.js 逐跳剥离 token，防凭证泄露。
      if ((planned.refs || []).length) setStage('downloading_refs');
      const mat = await materializeRefs(planned.refs || [], {
        deskpetToken: this.cfg.deskpetToken,
        serverBase: this.cfg.serverUrl,
      });
      cleanup = mat.cleanup;

      // 5) 执行 handler（提交指令 → 生成中）
      setStage('submitting');
      const onProgress = (gen) => {
        if (gen && gen !== lastGen) {
          lastGen = gen;
          stage = 'generating';
          beat(); // 立刻把上游生成 id + 阶段报给服务端
        }
      };
      const result = await handler.run({ job: planned, files: mat.files, cfg: this.cfg, onProgress });

      // 6) 回传成功产物：
      //    主路径 = 管家下载字节后 multipart 上传（ADR-0149 §5.9，绕开服务器抓 URL → 消 SSRF）；
      //    上传任一步失败 → 回落 server-pull（completeOk 报 result_url，服务端 SSRF 逐跳校验后自抓）。
      if (!result || !result.url) throw new Error('handler 未返回产物 URL');
      let done = null;
      let viaUpload = false;
      try {
        done = await uploadResult(this.cfg, { taskId, url: result.url, setStage });
        viaUpload = true;
      } catch (upErr) {
        log.warn(`上传主路径失败，回落 server-pull task=${taskId}: ${upErr.message}`);
        setStage('fetching');
        done = await this.api.completeOk(taskId, result.url);
      }
      if (done && done.ok && (done.status === 'SUCCESS')) {
        log.ok(`完成 task=${taskId}（${viaUpload ? '管家上传' : 'server-pull'}）`);
      } else {
        log.warn(`回传被服务端拒绝 task=${taskId}: ${(done && (done.error || done.status)) || '未知'}`);
      }
    } catch (e) {
      const raw = (e && e.message) || String(e);
      const friendly = friendlyError(raw);
      // 本地日志留原文（运维可看）；回传给用户的是脱敏友好句，raw 走 error_detail 入诊断
      log.error(`处理失败 task=${taskId}: ${raw}`);
      try { await this.api.completeFail(taskId, friendly, raw); } catch (e2) { log.warn(`回传失败也失败 task=${taskId}: ${e2.message}`); }
    } finally {
      if (hbTimer) clearInterval(hbTimer);
      try { cleanup(); } catch { /* noop */ }
    }
    void handlerHint;
  }

  async runForever() {
    log.info(`管家已启动，支持工具: ${supportedTools().join(', ')}；轮询间隔 ${this.cfg.pollIntervalMs}ms`);
    while (!this.stopped) {
      const n = await this.tick();
      if (n > 0) log.info(`本轮启动 ${n} 个工单`);
      await _sleep(this.cfg.pollIntervalMs);
    }
  }
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { Harness };
