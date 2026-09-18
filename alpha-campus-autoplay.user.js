// ==UserScript==
// @name         Alpha Campus 自动连播（静音 · 播完自动下一节）
// @namespace    https://alpha-campus.kr/
// @version      1.0.0
// @description  课堂视频自动静音播放，一节播完自动切到下一节，可挂机刷完全部课时
// @match        https://alpha-campus.kr/*
// @match        https://*.alpha-campus.kr/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 适配页面：https://alpha-campus.kr/my/classRoom/classRoomDetail?registrationId=...&type=ONLINE
 *
 * 站点结构（2026-09 实测）：
 *   - 播放器是同源 iframe #lxPlayerIframe -> https://alpha-campus.kr/catenoid.html
 *   - iframe 内是 Video.js，<video id="lx-player_html5_api" class="vjs-tech">
 *   - 右侧课时列表：li[class*="myClassRoom_item"]，当前播放的那条额外带 myClassRoom_active
 *   - 没有"下一节"按钮，切换课时 = 点列表里的下一个条目。
 *     点击后 iframe 会被销毁重建、video 元素换新，新视频默认是"暂停"状态，必须脚本拉起。
 *
 * 关于进度：平台通过 xAPI（https://lrs.alpha-campus.kr/xAPI/statements）上报
 * "已播放片段"(played-segments)，也就是按真实观看的时间区间累计，跳转/倍速都不产生有效片段。
 * 所以本脚本只做"自动播 + 自动切"，不去 seek 视频——跳着播既不计学时也容易被判异常。
 * 想加速请自行调 CONFIG.playbackRate，但风险自负（可能不计入有效学时）。
 */

(function () {
  'use strict';

  // ======== 可调参数 ========
  const CONFIG = {
    autoMute: true,        // 自动静音
    autoPlay: true,        // 自动播放 / 被暂停后自动拉起
    autoNext: true,        // 播完自动切下一节
    nextDelayMs: 4000,     // 播完后隔多久点下一节（给平台上报留点时间）
    pollMs: 2000,          // 巡检间隔
    endThreshold: 0.8,     // 距结尾多少秒内视为"已播完"
    playbackRate: 1.0,     // 倍速，默认 1.0。改成 1.5/2.0 有"不计学时"的风险
    showPanel: true,       // 显示右下角状态面板
  };

  const IS_TOP = window.top === window.self;
  const LOG_PREFIX = '[AC-AutoPlay]';
  const log = (...a) => console.log(LOG_PREFIX, ...a);

  // ======== 运行状态 ========
  const state = {
    on: true,            // 总开关
    boundVideo: null,    // 当前已绑事件的 video
    activeIdx: -1,       // 当前课时在列表中的序号
    endedFired: false,   // 本节是否已触发过"结束"
    lockUntil: 0,        // 切节冷却，防连点
    status: '启动中…',
  };

  const now = () => Date.now();

  // ======== 找 video 元素 ========
  // 顶层文档找不到时，钻进同源 iframe 里找
  function findVideo() {
    const own = document.querySelector('video');
    if (own) return own;

    const frames = document.querySelectorAll('iframe');
    for (const f of frames) {
      let doc = null;
      try {
        doc = f.contentDocument;   // 同源才拿得到，跨域会抛异常
      } catch (e) {
        continue;
      }
      if (!doc) continue;
      const v = doc.querySelector('video');
      if (v) return v;
    }
    return null;
  }

  // ======== 课时列表（只在顶层操作） ========
  function getLessons() {
    const doc = IS_TOP ? document : (() => { try { return window.top.document; } catch (e) { return null; } })();
    if (!doc) return [];
    return Array.from(doc.querySelectorAll('li[class*="myClassRoom_item"]'));
  }

  const isActive = (li) => /myClassRoom_active/.test(li.className || '');

  function getActiveIdx() {
    return getLessons().findIndex(isActive);
  }

  // ======== 自动播放 / 静音 ========
  async function ensurePlaying(v) {
    try {
      if (CONFIG.autoMute) {
        // 必须在 play() 之前置 muted，否则会被 Chrome 自动播放策略拦下
        if (!v.muted) v.muted = true;
        if (v.volume !== 0) v.volume = 0;
      }

      if (CONFIG.playbackRate !== 1 && v.playbackRate !== CONFIG.playbackRate) {
        v.playbackRate = CONFIG.playbackRate;
      }

      if (v.paused && !v.ended && v.readyState >= 2) {
        await v.play();
        state.status = '播放中';
      }
    } catch (e) {
      // 静音状态下一般不会被拦；真被拦了就等下次巡检重试
      state.status = 'play() 被拒绝：' + e.message;
      log('play() 被拒绝', e);
    }
  }

  // ======== 切换下一节 ========
  function goNext(reason) {
    if (!state.on || !CONFIG.autoNext) return;
    if (now() < state.lockUntil) return;   // 冷却中

    const lessons = getLessons();
    if (!lessons.length) {
      log('找不到课时列表');
      return;
    }

    const idx = getActiveIdx();
    if (idx < 0) {
      log('定位不到当前课时，跳过切换');
      return;
    }

    if (idx >= lessons.length - 1) {
      state.status = `已是最后一节（共 ${lessons.length} 节），全部播放完毕`;
      log('已是最后一节，停止');
      return;
    }

    const nextLi = lessons[idx + 1];
    const target = nextLi.querySelector('button[class*="btnStudy"]') || nextLi;

    state.lockUntil = now() + CONFIG.nextDelayMs;
    state.endedFired = true;
    state.status = `第 ${idx + 1} 节结束（${reason}）→ 切到第 ${idx + 2} 节`;
    log(state.status, target.textContent.trim().replace(/\s+/g, ' '));

    target.click();
  }

  // ======== 绑定 video 事件 ========
  function bind(v) {
    state.boundVideo = v;
    state.endedFired = false;
    log('绑定 video，时长', v.duration || '(未知)');

    v.addEventListener('ended', () => {
      if (state.endedFired) return;
      state.endedFired = true;
      log('收到 ended 事件');
      setTimeout(() => goNext('ended'), CONFIG.nextDelayMs);
    });
  }

  // ======== 单次巡检 ========
  function tick() {
    if (!state.on) return;

    const v = findVideo();
    if (!v) {
      state.status = '等待播放器…';
      state.boundVideo = null;
      updatePanel();
      return;
    }

    if (v !== state.boundVideo) {
      bind(v);
    }

    // 课时是否被切换过（切了就要重置结束标记）
    const idx = getActiveIdx();
    if (idx !== state.activeIdx) {
      state.activeIdx = idx;
      state.endedFired = false;
      log('当前课时变为第', idx + 1, '节');
    }

    if (CONFIG.autoPlay) ensurePlaying(v);

    // 兜底：Video.js 偶尔不派发 ended，用 currentTime 判断
    const d = v.duration;
    if (CONFIG.autoNext && d > 0 && !state.endedFired) {
      if (v.currentTime >= d - CONFIG.endThreshold) {
        state.endedFired = true;
        log('按 currentTime 判定已播完', v.currentTime.toFixed(1), '/', d.toFixed(1));
        setTimeout(() => goNext('currentTime'), CONFIG.nextDelayMs);
      }
    }

    updatePanel();
  }

  // ======== iframe 内脚本的兜底通道 ========
  // 万一以后播放器换成跨域 iframe，顶层拿不到 video，
  // 就由 iframe 内的脚本实例把"播完了"这件事 postMessage 上来。
  if (IS_TOP) {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.__acAutoPlay === 'ended') {
        if (!state.endedFired) {
          state.endedFired = true;
          setTimeout(() => goNext('iframe消息'), CONFIG.nextDelayMs);
        }
      }
    });
  } else {
    setInterval(() => {
      const v = document.querySelector('video');
      if (!v) return;
      if (CONFIG.autoMute && !v.muted) { v.muted = true; v.volume = 0; }
      if (CONFIG.autoPlay && v.paused && !v.ended && v.readyState >= 2) v.play().catch(() => {});
      const d = v.duration;
      if (d > 0 && v.currentTime >= d - CONFIG.endThreshold) {
        try { window.top.postMessage({ __acAutoPlay: 'ended' }, '*'); } catch (e) {}
      }
    }, CONFIG.pollMs);
    return;   // iframe 内不再跑顶层那套逻辑
  }

  // ======== 状态面板 ========
  let panel = null;
  function buildPanel() {
    if (!CONFIG.showPanel) return;
    panel = document.createElement('div');
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'background:rgba(17,24,39,.92)', 'color:#e5e7eb', 'font:12px/1.6 system-ui,sans-serif',
      'padding:10px 12px', 'border-radius:10px', 'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'cursor:pointer', 'max-width:260px', 'white-space:pre-line',
    ].join(';');
    panel.addEventListener('click', (e) => {
      // 点哪一行就切哪个开关
      const row = e.target.dataset && e.target.dataset.row;
      if (row === 'on') state.on = !state.on;
      if (row === 'mute') CONFIG.autoMute = !CONFIG.autoMute;
      if (row === 'next') CONFIG.autoNext = !CONFIG.autoNext;
      updatePanel();
    });
    document.body.appendChild(panel);
  }

  function updatePanel() {
    if (!panel) return;
    const lessons = getLessons();
    const cur = state.activeIdx >= 0 ? state.activeIdx + 1 : '?';
    panel.innerHTML =
      `<b>Alpha Campus 自动连播</b>\n` +
      `<span data-row="on">${state.on ? '🟢' : '⚪️'} 总开关：${state.on ? '开' : '关'}</span>\n` +
      `<span data-row="mute">${CONFIG.autoMute ? '🔇' : '🔊'} 静音：${CONFIG.autoMute ? '开' : '关'}</span>\n` +
      `<span data-row="next">${CONFIG.autoNext ? '⏭' : '⏸'} 自动下一节：${CONFIG.autoNext ? '开' : '关'}</span>\n` +
      `第 ${cur} / ${lessons.length || '?'} 节\n` +
      `<span style="color:#9ca3af">${state.status}</span>`;
  }

  // ======== 起飞 ========
  function start() {
    buildPanel();
    tick();
    setInterval(tick, CONFIG.pollMs);
    log('脚本已启动');
  }

  if (document.body) {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
