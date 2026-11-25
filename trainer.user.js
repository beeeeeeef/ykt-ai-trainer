// ==UserScript==
// @name         雨课堂 AI 陪练 自动答题
// @name:en      Yuketang AI Training Partner · Auto Answer
// @namespace    https://github.com/beeeeeeef
// @version      1.0.0
// @description  AI 陪练助手循环答题：先试让服务端交出答案，拿不到再穷举选项。支持单选/多选/判断，填空与主观题跳过。不需要大模型或 API Key。
// @author       beeeeeeef
// @license      MIT
// @homepageURL  https://github.com/beeeeeeef/ykt-ai-trainer
// @supportURL   https://github.com/beeeeeeef/ykt-ai-trainer/issues
// @updateURL    https://raw.githubusercontent.com/beeeeeeef/ykt-ai-trainer/main/trainer.user.js
// @downloadURL  https://raw.githubusercontent.com/beeeeeeef/ykt-ai-trainer/main/trainer.user.js
// @match        https://*.yuketang.cn/ai-workspace/ai-training-partner/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- 常量 ----------------
  const P_INFO = '/mooc-api/v1/lms/kg/kg_classroom_agent/';
  const P_PROBLEM = '/mooc-api/v1/lms/exercise/training_partner/problem/';
  const P_ANSWER = '/mooc-api/v1/lms/exercise/training_partner/answer/';

  const TYPE_NAME = { 1: '单选', 2: '多选', 4: '填空', 5: '主观', 6: '判断' };
  const BRUTE_TYPES = [1, 2, 6];
  const MAX_OPTIONS_FOR_SUBSET = 6;

  const S = {
    targetCount: 10,
    delayMs: 700,
    skipUnsupported: true
  };

  const R = { running: false, aborted: false, done: 0, correct: 0, submitTotal: 0 };
  let ctx = null;

  // ---------------- 工具 ----------------
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : '';
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function qsExtra() {
    const uv = getCookie('uv_id');
    const parts = [];
    if (uv) parts.push('uv_id=' + uv);
    parts.push('platform_id=3');
    return parts.join('&');
  }

  async function api(path, method, body) {
    const url = path + (path.indexOf('?') === -1 ? '?' : '&') + qsExtra();
    const headers = { 'XTBZ': 'ykt' };
    const csrf = getCookie('csrftoken');
    if (csrf) headers['X-CSRFToken'] = csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method: method || 'GET',
      credentials: 'include',
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('返回不是 JSON（HTTP ' + res.status + '）'); }
    if (!res.ok || json.success === false) throw new Error(json.msg || ('HTTP ' + res.status));
    return json.data;
  }

  // ---------------- 页面上下文 ----------------
  async function loadContext() {
    const m = location.pathname.match(/\/ai-workspace\/ai-training-partner(?:-mobile)?\/(\d+)\/(\d+)/);
    if (!m) throw new Error('URL 里没找到 classroom_id / graph_id');

    const classroomId = m[1];
    const graphId = m[2];

    let nodeIds = [];
    new URLSearchParams(location.search).getAll('node_id').forEach(function (v) {
      String(v).split(',').forEach(function (x) {
        const n = parseInt(x, 10);
        if (!isNaN(n)) nodeIds.push(n);
      });
    });
    nodeIds = Array.from(new Set(nodeIds));
    if (!nodeIds.length) throw new Error('URL 里没有 node_id');

    const info = await api(P_INFO + '?classroom_id=' + classroomId + '&node_id=' + nodeIds.join(','), 'GET');
    if (!info || !info.agent_id) throw new Error('没拿到 agent_id');

    let kgId = graphId;
    if (Array.isArray(info.node_data) && info.node_data.length && info.node_data[0].kg_id) {
      kgId = String(info.node_data[0].kg_id);
    }

    return {
      classroomId: String(classroomId),
      kgId: String(kgId),
      agentId: info.agent_id,
      nodeIds: nodeIds,
      seenProblemIds: [],
      seenAiProblemIds: []
    };
  }

  // ---------------- 取题 ----------------
  async function fetchProblem(c) {
    const body = {
      agent_id: c.agentId,
      classroom_id: c.classroomId,
      kg_id: c.kgId,
      node_id_list: c.nodeIds
    };
    if (c.seenProblemIds.length) body.exclude_problem_id = c.seenProblemIds;
    if (c.seenAiProblemIds.length) body.exclude_ai_problem_id = c.seenAiProblemIds;

    const data = await api(P_PROBLEM, 'POST', body);
    const list = (data && data.problem) || [];
    return list.length ? list[0] : null;
  }

  // ---------------- 提交 ----------------
  async function submit(c, problemId, problemType, answer, wantAnswer) {
    const body = {
      problem_id: problemId,
      problem_type: problemType,
      classroom_id: c.classroomId,
      answer: answer
    };
    if (wantAnswer) body.need_explain_and_answer = true;
    R.submitTotal += 1;
    return api(P_ANSWER, 'POST', body);
  }

  function subsets(keys) {
    const out = [];
    const n = Math.min(keys.length, MAX_OPTIONS_FOR_SUBSET);
    for (let mask = 1; mask < (1 << n); mask++) {
      const combo = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) combo.push(keys[i]);
      out.push(combo);
    }
    out.sort(function (a, b) { return a.length - b.length; });
    return out;
  }

  // 返回 { ok, correctAnswer, via, submits }
  async function solve(c, q) {
    const type = q.problem_type;
    const options = ((q.content && q.content.Options) || []).map(function (o) { return o.key; });
    if (options.length < 2) throw new Error('选项不足，无法作答');

    let submits = 0;

    // 第一步：问服务端要答案（带 need_explain_and_answer）
    if (BRUTE_TYPES.indexOf(type) !== -1) {
      const probe = await submit(c, q.problem_id, type, [options[0]], true);
      submits += 1;
      if (probe && probe.is_correct) {
        return { ok: true, correctAnswer: [options[0]], via: '服务端直判', submits: submits };
      }
      if (probe && Array.isArray(probe.answer) && probe.answer.length) {
        const second = await submit(c, q.problem_id, type, probe.answer, false);
        submits += 1;
        if (second && second.is_correct) {
          return { ok: true, correctAnswer: probe.answer, via: '服务端给答案', submits: submits };
        }
      }
      log('服务端没给答案，转穷举（已消耗 ' + submits + ' 次）');
    }

    // 第二步：穷举
    const candidates = type === 2 ? subsets(options) : options.map(function (k) { return [k]; });

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (cand.length === 1 && cand[0] === options[0]) continue; // 第一步已经试过

      await sleep(S.delayMs);
      if (R.aborted) throw new Error('已终止');

      const r = await submit(c, q.problem_id, type, cand, false);
      submits += 1;
      if (r && r.is_correct) {
        return { ok: true, correctAnswer: cand, via: '穷举', submits: submits };
      }
    }
    return { ok: false, correctAnswer: null, via: '穷举', submits: submits };
  }

  // ---------------- 主循环 ----------------
  async function run() {
    R.running = true; R.aborted = false; R.done = 0; R.correct = 0; R.submitTotal = 0;
    ui.lock(true);
    log('读取课程上下文…');

    try {
      ctx = await loadContext();
      log('agent_id=' + ctx.agentId + ' kg_id=' + ctx.kgId + ' 知识点 ' + ctx.nodeIds.join(','));
    } catch (e) {
      log('初始化失败：' + e.message);
      stop();
      return;
    }

    let emptyStreak = 0;

    while (R.running && !R.aborted && R.done < S.targetCount) {
      let q;
      try {
        q = await fetchProblem(ctx);
      } catch (e) {
        log('取题失败：' + e.message);
        break;
      }
      if (!q) {
        emptyStreak += 1;
        if (emptyStreak >= 2) { log('没有更多题目了，已答 ' + R.done + ' 题'); break; }
        await sleep(1200);
        continue;
      }
      emptyStreak = 0;

      ctx.seenProblemIds.push(q.problem_id);

      const typeName = TYPE_NAME[q.problem_type] || ('类型' + q.problem_type);
      const body = (q.content && q.content.Body) || '';
      log('第 ' + (R.done + 1) + ' 题 [' + typeName + '] ' + body.slice(0, 26) + (body.length > 26 ? '…' : ''));

      if (BRUTE_TYPES.indexOf(q.problem_type) === -1) {
        if (S.skipUnsupported) {
          log('  ↳ ' + typeName + '不支持自动作答，跳过');
          await sleep(300);
          continue;
        }
        break;
      }

      let res;
      try {
        res = await solve(ctx, q);
      } catch (e) {
        log('  ↳ 作答出错：' + e.message);
        if (R.aborted) break;
        await sleep(1200);
        continue;
      }

      R.done += 1;
      if (res.ok) {
        R.correct += 1;
        log('  ✓ ' + res.correctAnswer.join(',') + '（' + res.via + '，' + res.submits + ' 次提交）');
      } else {
        log('  ✗ 未能确定答案（' + res.submits + ' 次提交）');
      }
      ui.tick();

      await sleep(Math.max(S.delayMs, 600));
    }

    log('结束：共 ' + R.done + ' 题，答对 ' + R.correct + '，累计提交 ' + R.submitTotal + ' 次。页面未刷新，按 F5 可让界面同步。');
    stop();
  }

  function stop() {
    R.running = false;
    ui.lock(false);
  }

  // ---------------- 面板 ----------------
  const logs = [];
  const ui = {
    el: null,
    lock: function (busy) {
      if (!ui.el) return;
      ui.el.querySelector('#ykt-run').disabled = busy;
      ui.el.querySelector('#ykt-stop').disabled = !busy;
    },
    tick: function () {
      if (!ui.el) return;
      ui.el.querySelector('#ykt-stat').textContent =
        '已答 ' + R.done + '/' + S.targetCount + '　正确 ' + R.correct + '　提交 ' + R.submitTotal;
    }
  };

  function log(text) {
    logs.push(text);
    while (logs.length > 40) logs.shift();
    if (!ui.el) return;
    ui.el.querySelector('#ykt-log').textContent = logs.slice(-14).join('\n');
    ui.el.querySelector('#ykt-log').scrollTop = 1e6;
  }

  function buildPanel() {
    if (document.getElementById('ykt-trainer')) return;
    const box = document.createElement('div');
    box.id = 'ykt-trainer';
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483646',
      'width:360px', 'background:#171a22', 'color:#e8e8ee', 'border-radius:10px',
      'box-shadow:0 8px 28px rgba(0,0,0,.45)', 'font:12px/1.6 -apple-system,Segoe UI,Microsoft YaHei,sans-serif',
      'padding:10px 12px', 'box-sizing:border-box'
    ].join(';');

    box.innerHTML = [
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">',
      '  <b style="font-size:13px">AI陪练 自动答题</b>',
      '  <span id="ykt-stat" style="color:#8b8fa3">待开始</span>',
      '</div>',
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">',
      '  <label style="color:#8b8fa3">题数</label>',
      '  <input id="ykt-count" type="number" min="1" max="200" value="10" style="width:56px;background:#12141a;border:1px solid #2a2d38;color:#e8e8ee;border-radius:5px;padding:3px 5px">',
      '  <label style="color:#8b8fa3;margin-left:6px">间隔ms</label>',
      '  <input id="ykt-delay" type="number" min="200" max="8000" step="100" value="700" style="width:66px;background:#12141a;border:1px solid #2a2d38;color:#e8e8ee;border-radius:5px;padding:3px 5px">',
      '</div>',
      '<div style="display:flex;gap:6px">',
      '  <button id="ykt-run" style="flex:1;cursor:pointer;border:0;border-radius:6px;padding:6px 0;background:#3b6cf6;color:#fff;font-size:12px">开始</button>',
      '  <button id="ykt-stop" disabled style="flex:1;cursor:pointer;border:0;border-radius:6px;padding:6px 0;background:#2a2d38;color:#dfe3f0;font-size:12px">停止</button>',
      '</div>',
      '<div id="ykt-log" style="margin-top:8px;max-height:170px;overflow:auto;background:#12141a;border-radius:6px;padding:6px;color:#9aa0b5;white-space:pre-wrap;word-break:break-all">等待开始…</div>'
    ].join('');

    document.body.appendChild(box);
    ui.el = box;

    const saved = localStorage.getItem('ykt-trainer-cfg');
    if (saved) {
      try {
        const c = JSON.parse(saved);
        if (c.targetCount) box.querySelector('#ykt-count').value = c.targetCount;
        if (c.delayMs) box.querySelector('#ykt-delay').value = c.delayMs;
      } catch (e) { /* 忽略 */ }
    }

    box.querySelector('#ykt-run').addEventListener('click', function () {
      const t = parseInt(box.querySelector('#ykt-count').value, 10);
      const d = parseInt(box.querySelector('#ykt-delay').value, 10);
      S.targetCount = isNaN(t) ? 10 : Math.max(1, Math.min(200, t));
      S.delayMs = isNaN(d) ? 700 : Math.max(200, Math.min(8000, d));
      localStorage.setItem('ykt-trainer-cfg', JSON.stringify(S));
      run();
    });

    box.querySelector('#ykt-stop').addEventListener('click', function () {
      R.aborted = true;
      R.running = false;
      log('正在停止…');
      ui.lock(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel, { once: true });
  } else {
    buildPanel();
  }
})();
