// dsh-message-actions — 浏览器端（客户端 UI）。
//
// 本文件由 build.mjs 处理：
//   - 共享纯函数占位符会被内联为 shared.cjs 的 IIFE（见下方 const shared 声明）；
//   - 构建时间戳占位符会被替换为 ISO 时间（见下方 const BUILD 声明）。
//
// 官方图标组件（@deepseek-ai/dsh-client-ui-primitives）为可选依赖：
// 加载成功时与官方「复制」等按钮保持同一套图标；失败时回退到内置图标。

window.__ModuleLoader__.load({
  id: "dsh-message-actions",
  factory: (require) => {
    const React = require("react");

    let ReactDOMClient = null;
    try {
      ReactDOMClient = require("react-dom/client");
    } catch {
      ReactDOMClient = null;
    }

    // createPortal 来自 react-dom（不是 react-dom/client）。单独探测：
    // 拿不到时浮层退回宿主槽位渲染，不影响按钮与弹窗功能。
    let ReactDOM = null;
    try {
      ReactDOM = require("react-dom");
    } catch {
      ReactDOM = null;
    }

    let PRIMITIVES = null;
    try {
      PRIMITIVES = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch {
      PRIMITIVES = null;
    }

    // 占位符写成合法表达式，保证 src/client.js 可被 lint/typecheck 直接解析；
    // build.mjs 会把 `null` 整体替换为 shared.cjs 的 IIFE。
    const shared = /*__DMA_SHARED__*/ null;
    const BUILD = "__DMA_BUILD_TIME__";
    // 构建时由 build.mjs 用 package.json 的 version 替换，避免设置页显示旧版本。
    const VERSION = "__DMA_VERSION__";

    if (typeof console !== "undefined" && typeof console.info === "function") {
      console.info("[dsh-message-actions] build", BUILD);
    }

    const {
      ICONS,
      CSS,
      ERROR_LABELS,
      escapeHtml,
      markdownOf,
      exportFilename,
      toolCallIdFromNodeKey,
      toolNodeKeysToHide,
      findToolRowByCallId,
      resolveKeyAction,
      mergeMessageSummary,
      completionSoundEnabled,
      normalizeSoundTone,
      completionSoundTone,
      soundToneOptions,
      DEFAULT_SOUND_VOLUME,
      clampSoundVolume,
      soundGainScale,
      shouldPlayCompletionSound,
      formatTokens,
      railTurnOfAttributes,
      createScheduler,
      createRequestGate,
      formatCents,
      formatYuanCents,
      formatCostMicros,
      formatReplyCost,
      periodInfo,
      periodChangeText,
      autoCloseAt,
      easeOutCubic,
      validateCorrectionAmount,
      yuanToCents,
      COST_LAYOUTS,
      DEFAULT_COST_LAYOUT,
      normalizeCostLayout
    } = shared;

    const NS = "dsh-message-actions";

    // -------------------------------------------------------------------------
    // 本地化字典（客户端 UI 文案）
    // -------------------------------------------------------------------------

    // 文案单一来源：src/i18n.cjs（构建时内联为 IIFE，同时生成 locale/*.json）。
    const I18N = /*__DMA_I18N__*/ null;

    const zh = I18N.zh;
    const en = I18N.en;

    const DICTS = { zh, en };

    // 语言来源：优先宿主 locale 服务快照（active 为 "zh" / "en"），
    // 其次 <html lang>，最后浏览器语言。不能缓存：插件加载可能早于宿主同步 <html lang>。
    let localeService = null;

    function normalizeLang(value) {
      const raw = String(value == null ? "" : value).toLowerCase();
      if (raw.startsWith("zh")) return "zh";
      if (raw.startsWith("en")) return "en";
      return null;
    }

    function detectLang() {
      if (localeService && typeof localeService.getLocale === "function") {
        const snapshot = localeService.getLocale();
        const active = normalizeLang(snapshot && snapshot.active);
        if (active) return active;
      }
      const docLang = typeof document !== "undefined" ? document.documentElement.lang : "";
      const nav = typeof navigator !== "undefined" ? navigator.language : "";
      return normalizeLang(docLang) || normalizeLang(nav) || "zh";
    }

    function t(key, params) {
      const dict = DICTS[detectLang()] || DICTS.zh;
      let text = dict[key] != null ? dict[key] : key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.split("{" + k + "}").join(String(v));
        }
      }
      return text;
    }

    // -------------------------------------------------------------------------
    // 图标：优先官方组件，缺失时回退内置 SVG
    // -------------------------------------------------------------------------

    // 官方图标组件名（@deepseek-ai/dsh-client-ui-primitives）。
    // 除「撤回」外全部使用官方图标；官方缺失时回退内置 SVG。
    const OFFICIAL_ICON_NAMES = {
      recall: null,
      share: "IconShareOutlineRegular",
      export: "IconDownloadOutlineRegular",
      delete: "IconTrashOutlineRegular",
      deleteFrom: "IconArchiveOffOutlineRegular",
      check: "IconCheckOutlineRegular"
    };

    function officialIconElement(kind, size) {
      if (!PRIMITIVES || typeof PRIMITIVES !== "object") return null;
      const name = OFFICIAL_ICON_NAMES[kind];
      const component = name ? PRIMITIVES[name] : null;
      if (typeof component !== "function") return null;
      return React.createElement(component, { size: size });
    }

    /** 把图标画进命令式创建的按钮；返回 false 表示应使用内置 SVG。 */
    function paintButtonIcon(btn, kind) {
      const element = officialIconElement(kind, 15);
      if (!element) return false;
      if (!ReactDOMClient || typeof ReactDOMClient.createRoot !== "function") return false;
      try {
        const root = ReactDOMClient.createRoot(btn);
        root.render(element);
        btn.__dmaIconRoot = root;
        return true;
      } catch {
        return false;
      }
    }

    function unmountButtonIcon(btn) {
      const root = btn.__dmaIconRoot;
      if (!root) return;
      btn.__dmaIconRoot = null;
      try {
        root.unmount();
      } catch {
        /* ignore */
      }
    }

    /** 移除一个问行按钮容器前，先卸载 React 图标根，避免残留。 */
    function disposeActionsRow(row) {
      if (!row) return;
      row.querySelectorAll(".dma-btn").forEach(unmountButtonIcon);
      row.remove();
    }

    // -------------------------------------------------------------------------
    // 最小可观测 store（供 slot 的 hooks 机制使用：subscribe + getSnapshot）
    // -------------------------------------------------------------------------

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      const api = {
        getSnapshot() {
          return state;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set(next) {
          if (next !== state) {
            state = next;
            for (const listener of [...listeners]) listener();
          }
        }
      };
      return api;
    }

    // -------------------------------------------------------------------------
    // HTTP 工具（同源请求宿主 webServer 路由）
    // -------------------------------------------------------------------------

    function baseOrigin() {
      if (typeof location !== "undefined" && location.origin) return location.origin;
      if (typeof document !== "undefined" && document.baseURI) {
        try {
          return new URL(document.baseURI).origin;
        } catch {
          /* ignore */
        }
      }
      return "";
    }

    function apiUrl(path, query) {
      const url = baseOrigin() + path;
      return query ? url + "?" + query : url;
    }

    /** 请求超时：宿主卡住时不至于让轮询 / 按钮永久挂起。 */
    const REQUEST_TIMEOUT_MS = 15000;

    async function fetchWithTimeout(url, init) {
      if (typeof AbortController !== "function") return fetch(url, init);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
      } finally {
        clearTimeout(timer);
      }
    }

    async function postJson(path, body) {
      const res = await fetchWithTimeout(apiUrl(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { status: res.status, data };
    }

    async function getJson(path, query) {
      const res = await fetchWithTimeout(apiUrl(path, query), { cache: "no-store" });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { status: res.status, data };
    }

    // -------------------------------------------------------------------------
    // 费用统计：共享状态 + 轮询
    // -------------------------------------------------------------------------

    const COST_POLL_MS = 5000;

    const costStore = createStore({ status: "idle", value: null, fetchedAt: 0, error: "" });
    let costForm = null;
    let costPollTimer = null;
    let costPolling = false;
    let costVisibilityBound = false;

    function patchCostState(patch) {
      costStore.set(Object.assign({}, costStore.getSnapshot(), patch));
    }

    /** 总开关（默认 true）。设置快照未就绪时按开启处理，避免首屏空白。 */
    function costEnabledNow() {
      if (!costForm || typeof costForm.getSnapshot !== "function") return true;
      const snap = costForm.getSnapshot();
      if (!snap || snap.status !== "ready" || typeof snap.value !== "object" || !snap.value) return true;
      return snap.value.usageStats !== false;
    }

    let lastTurnAtApplied = null;
    let lastPlayedTurnAt = null;
    let audioCtx = null;
    let audioUnlockBound = false;

    /** 提示音开关（默认 true）；设置快照未就绪时按开启处理。 */
    function soundEnabledNow() {
      if (!costForm || typeof costForm.getSnapshot !== "function") return true;
      const snap = costForm.getSnapshot();
      if (!snap || snap.status !== "ready" || typeof snap.value !== "object" || !snap.value) return true;
      return completionSoundEnabled(snap.value);
    }

    /** 当前音色（关闭时返回 'off'）；设置快照未就绪时按默认双音。 */
    function soundToneNow() {
      if (!costForm || typeof costForm.getSnapshot !== "function") return "double";
      const snap = costForm.getSnapshot();
      if (!snap || snap.status !== "ready" || typeof snap.value !== "object" || !snap.value) return "double";
      return completionSoundTone(snap.value);
    }

    /** 当前音量（0–100，默认 50）；设置快照未就绪时按默认值。 */
    function soundVolumeNow() {
      if (!costForm || typeof costForm.getSnapshot !== "function") return DEFAULT_SOUND_VOLUME;
      const snap = costForm.getSnapshot();
      if (!snap || snap.status !== "ready" || typeof snap.value !== "object" || !snap.value) {
        return DEFAULT_SOUND_VOLUME;
      }
      return clampSoundVolume(snap.value.soundVolume);
    }

    /**
     * 创建 / 唤醒 AudioContext。浏览器要求一次用户手势后才能发声：
     * 模块加载时注册一次全局首次点击/按键监听，提前解锁，避免任务完成时才 resume 而错过。
     */
    function ensureAudio() {
      try {
        const Ctor = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
        if (!Ctor) return null;
        if (!audioCtx) audioCtx = new Ctor();
        if (audioCtx.state !== "running" && typeof audioCtx.resume === "function") {
          audioCtx.resume().catch(() => {});
        }
        return audioCtx;
      } catch {
        return null;
      }
    }

    function unlockAudio() {
      ensureAudio();
    }

    function installAudioUnlock() {
      if (audioUnlockBound) return;
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
      audioUnlockBound = true;
      window.addEventListener("pointerdown", unlockAudio, { passive: true, capture: true });
      window.addEventListener("keydown", unlockAudio, { passive: true, capture: true });
    }

    // 插件加载即挂载首次交互解锁：用户点任何按钮/发消息后再播放就不会被策略拦截。
    installAudioUnlock();

    /**
     * 音色参数：按「双音 / 短铃 / 轻提示」给出频率与包络。
     * `gain` 是音量 50% 时的基准（0.12–0.18），实际峰值 = gain × soundGainScale(音量)。
     */
    const TONE_SPECS = {
      double: { gain: 0.18, notes: [{ freq: 880, at: 0, dur: 0.16, type: "sine" }, { freq: 660, at: 0.15, dur: 0.2, type: "sine" }] },
      bell: { gain: 0.16, notes: [{ freq: 1046, at: 0, dur: 0.1, type: "triangle" }, { freq: 784, at: 0.11, dur: 0.16, type: "triangle" }] },
      soft: { gain: 0.12, notes: [{ freq: 523, at: 0, dur: 0.24, type: "sine" }] }
    };

    function emitTone(ctx, tone, volume) {
      const spec = TONE_SPECS[normalizeSoundTone(tone)];
      if (!spec) return false;
      const scale = soundGainScale(volume);
      // 0% 音量直接不发声，避免出现「静音档仍在响」。
      if (!(scale > 0)) return false;
      const now = ctx.currentTime;
      const body = Math.max(...spec.notes.map((note) => note.at + note.dur));
      const peak = Math.max(0.0001, spec.gain * scale);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + body);
      gain.connect(ctx.destination);
      for (const note of spec.notes) {
        const osc = ctx.createOscillator();
        osc.type = note.type;
        osc.frequency.setValueAtTime(note.freq, now + note.at);
        osc.connect(gain);
        osc.start(now + note.at);
        osc.stop(now + note.at + note.dur);
      }
      return true;
    }

    /**
     * 播放完成提示音。挂起时 resume 后静默重试一次（不弹 toast）：
     * 用户已交互过就一定能听到；仍被策略拦截则安静放弃。
     * @param tone 指定音色（试听用）；省略时读设置快照。
     * @param volume 指定音量（试听用）；省略时读设置快照。
     */
    function playCompletionSound(tone, volume) {
      const id = typeof tone === "string" ? tone : soundToneNow();
      if (id === "off") return false;
      const vol = Number.isFinite(volume) ? clampSoundVolume(volume) : soundVolumeNow();
      if (!(soundGainScale(vol) > 0)) return false;
      const ctx = ensureAudio();
      if (!ctx) return false;
      if (ctx.state !== "running") {
        const retry = () => {
          try {
            if (ctx.state === "running") emitTone(ctx, id, vol);
          } catch {
            /* 静默放弃 */
          }
        };
        if (typeof ctx.resume === "function") ctx.resume().then(retry).catch(() => {});
        return false;
      }
      try {
        return emitTone(ctx, id, vol);
      } catch {
        return false;
      }
    }

    function perTurnNow() {
      if (!costForm || typeof costForm.getSnapshot !== "function") return true;
      const snap = costForm.getSnapshot();
      if (!snap || snap.status !== "ready" || typeof snap.value !== "object" || !snap.value) return true;
      return snap.value.costPerTurn !== false;
    }

    /** 单次费用写明的那一刻判定提示音：同一状态更新里出数字、响一次。 */
    function maybeCompletionSound(value) {
      const turn = value && value.lastTurn ? value.lastTurn : null;
      const at = turn && Number.isFinite(turn.at) ? turn.at : null;
      if (at === null) return;
      const previousAt = lastTurnAtApplied;
      lastTurnAtApplied = at;
      if (previousAt === null) return; // 首次快照只记基线，刷新页面不补响
      if (!shouldPlayCompletionSound({
        enabled: costEnabledNow() && soundEnabledNow(),
        settled: true,
        previousAt,
        at,
        lastPlayedAt: lastPlayedTurnAt
      })) return;
      lastPlayedTurnAt = at;
      playCompletionSound();
    }

    function applyCostState(value) {
      patchCostState({ status: "ready", value, fetchedAt: Date.now(), error: "" });
      maybeCompletionSound(value);
    }

    async function fetchCostState(force) {
      try {
        const { status, data } = await getJson(
          "/dsh-message-actions/cost/state",
          force ? "refresh=1" : undefined
        );
        if (status === 200 && data && data.ok && data.value) {
          applyCostState(data.value);
          return data.value;
        }
        patchCostState({ status: "error", error: "request" });
      } catch {
        patchCostState({ status: "error", error: "network" });
      }
      return null;
    }

    function onCostVisibility() {
      if (typeof document !== "undefined" && !document.hidden && costEnabledNow()) {
        fetchCostState(false).catch(() => {});
      }
    }

    // 结算推送：带 wait=<已知 lastTurn.at> 的长轮询，宿主结算后立即返回。
    let costWaitTimer = null;
    let costWaitActive = false;

    function costWaitStep() {
      costWaitTimer = null;
      if (!costPolling || !costWaitActive) return;
      if (typeof document !== "undefined" && document.hidden) {
        costWaitTimer = setTimeout(costWaitStep, 1500);
        return;
      }
      if (!costEnabledNow() || !perTurnNow()) {
        costWaitTimer = setTimeout(costWaitStep, 1500);
        return;
      }
      const wait = lastTurnAtApplied === null ? 0 : lastTurnAtApplied;
      getJson("/dsh-message-actions/cost/state", "wait=" + wait)
        .then(({ status, data }) => {
          if (!costPolling || !costWaitActive) return;
          if (status === 200 && data && data.ok && data.value) applyCostState(data.value);
          costWaitTimer = setTimeout(costWaitStep, 0);
        })
        .catch(() => {
          costWaitTimer = setTimeout(costWaitStep, 2000);
        });
    }

    function startCostWaitLoop() {
      if (costWaitActive) return;
      costWaitActive = true;
      costWaitStep();
    }

    function startCostPolling(form) {
      costForm = form;
      if (costPolling) return;
      costPolling = true;
      const tick = () => {
        if (typeof document !== "undefined" && document.hidden) return;
        if (!costEnabledNow()) return;
        fetchCostState(false).catch(() => {});
      };
      tick();
      costPollTimer = setInterval(tick, COST_POLL_MS);
      startCostWaitLoop();
      if (typeof document !== "undefined" && !costVisibilityBound) {
        costVisibilityBound = true;
        document.addEventListener("visibilitychange", onCostVisibility);
      }
    }

    function stopCostPolling() {
      costPolling = false;
      costWaitActive = false;
      if (costWaitTimer !== null) {
        clearTimeout(costWaitTimer);
        costWaitTimer = null;
      }
      if (costPollTimer !== null) {
        clearInterval(costPollTimer);
        costPollTimer = null;
      }
      if (typeof document !== "undefined" && costVisibilityBound) {
        costVisibilityBound = false;
        document.removeEventListener("visibilitychange", onCostVisibility);
      }
    }

    // -------------------------------------------------------------------------
    // Toast
    // -------------------------------------------------------------------------

    function showToast(text) {
      if (typeof document === "undefined") return;
      document.querySelectorAll("[data-dma-toast]").forEach((n) => n.remove());
      const node = document.createElement("div");
      node.className = "dma-toast";
      node.setAttribute("data-dma-toast", "1");
      node.textContent = text;
      document.body.appendChild(node);
      setTimeout(() => node.remove(), 3200);
    }

    // -------------------------------------------------------------------------
    // 会话控制器（按 sessionId 分桶，避免跨会话串状态）
    // -------------------------------------------------------------------------

    const controllers = new Map();

    function sessionFor(ctx, sessionId) {
      let controller = controllers.get(sessionId);
      if (controller === undefined) {
        controller = new SessionController(ctx, sessionId);
        controllers.set(sessionId, controller);
      }
      return controller;
    }

    /**
     * 回收已从 DOM 消失的会话控制器：快照里含完整正文，长期累积会占用内存。
     * 只删除当前页面找不到对应容器且没有在途请求的控制器，避免误删正在切换的会话。
     */
    function evictStaleControllers() {
      if (typeof document === "undefined" || controllers.size === 0) return;
      const alive = new Set();
      for (const el of document.querySelectorAll("[data-conversation-session]")) {
        const id = el.getAttribute("data-conversation-session");
        if (id) alive.add(id);
      }
      for (const [id, controller] of controllers) {
        if (alive.has(id) || controller.messagesPromise) continue;
        controllers.delete(id);
      }
    }

    class SessionController {
      constructor(ctx, sessionId) {
        this.ctx = ctx;
        this.sessionId = sessionId;
        this.form = ctx.configForms.get("dsh-message-actions");
        this.messages = null; // { rows, rounds, goneTurns }
        this.messagesPromise = null;
        this.fetchedAt = 0; // 上次成功拉取快照的时间，用于 TTL 失效（避免永久缓存旧对话）
        this.hiddenTurns = new Set(); // 乐观隐藏的轮次（本地，用于导航与导出过滤）
        this.requestGate = createRequestGate(); // 丢弃后发先至的旧快照
        this.data = createStore({ messages: null, hidden: [] });
        this.overlay = createStore({ view: null });
      }

      config() {
        const snap = this.form && this.form.getSnapshot ? this.form.getSnapshot() : null;
        return snap && typeof snap.value === "object" && snap.value !== null
          ? snap.value
          : {};
      }

      refreshData() {
        this.data.set({ messages: this.messages, hidden: [...this.hiddenTurns] });
      }

      addHiddenTurn(turn) {
        if (!Number.isFinite(turn)) return;
        this.hiddenTurns.add(turn);
        this.refreshData();
      }

      /**
       * 拉取会话快照（rows / rounds / goneTurns）。
       * 快照必须随新轮次失效：早期实现把 promise 永久缓存，导致弹窗只看到 1 轮。
       * 普通刷新只带游标取增量；force（弹窗 / 操作前）仍取全量，覆盖任何变更。
       * @param {boolean} force true 时忽略 TTL 与在途请求，强制重新拉取
       */
      async fetchMessages(force) {
        const TTL = 3000;
        if (!force && this.messages && Date.now() - this.fetchedAt < TTL) return this.messages;
        if (this.messagesPromise && !force) return this.messagesPromise;
        // force 会绕过在途请求；用代际栅栏保证只有最新请求能写回快照。
        const token = this.requestGate.begin();
        const base = this.messages;
        const since = !force && base && Number.isSafeInteger(base.version) && base.version > 0
          ? base.version
          : null;
        const messagesUrl = (cursor) =>
          "sessionId=" + encodeURIComponent(this.sessionId) +
          (cursor === null ? "" : "&since=" + cursor);
        const promise = (async () => {
          try {
            let cursor = since;
            let { data } = await getJson("/dsh-message-actions/messages", messagesUrl(cursor));
            if (
              cursor !== null &&
              !(data && data.ok && data.value && Number.isSafeInteger(data.value.version) && data.value.version >= cursor)
            ) {
              // 游标回退（宿主重建会话 / 版本跳变）：增量不可信，改为全量重取一次。
              cursor = null;
              ({ data } = await getJson("/dsh-message-actions/messages", messagesUrl(cursor)));
            }
            if (data && data.ok && data.value && this.requestGate.isLatest(token)) {
              this.messages = cursor === null
                ? data.value
                : mergeMessageSummary(base, data.value);
              this.fetchedAt = Date.now();
              this.refreshData();
              // 切换会话 / 刷新后重新挂载的 DOM 没有 data-dma-hidden，
              // 拿到最新快照后立刻按 goneTurns / goneTools 重放隐藏。
              syncRail();
            }
            return this.messages;
          } finally {
            if (this.messagesPromise === promise) this.messagesPromise = null;
          }
        })();
        this.messagesPromise = promise;
        return promise;
      }

      /**
       * 按需拉取指定轮次的完整正文（分享图 / 导出使用）。
       * 摘要轮询不带正文，避免每 3 秒传整份对话；这里只拉用户实际选中的轮次。
       * @param {number[]} turns
       * @returns {Promise<Array<{ turn, question, answer }> | null>} 失败返回 null
       */
      async fetchRoundText(turns) {
        const list = (turns || []).filter(Number.isSafeInteger);
        if (list.length === 0) return [];
        const query =
          "sessionId=" + encodeURIComponent(this.sessionId) +
          "&full=1&turns=" + list.join(",");
        try {
          const { status, data } = await getJson("/dsh-message-actions/messages", query);
          if (status === 200 && data && data.ok && data.value && Array.isArray(data.value.rounds)) {
            return data.value.rounds;
          }
        } catch {
          /* 网络失败由调用方统一提示 */
        }
        return null;
      }

      /** 按 turn 找到真实提问的 seq（问行按钮据此定位）。 */
      userSeqForTurn(rows, turn) {
        let fallback = null;
        for (const row of rows || []) {
          if (row.turn !== turn || row.type !== "user/message") continue;
          // 优先真实提问；运行时注入（runtime-context 等）只作为兜底。
          if (row.sourceKind === undefined || row.sourceKind === "user") return row.seq;
          if (fallback === null) fallback = row.seq;
        }
        return fallback;
      }

      // —— 浮层控制 ——

      openConfirm(action, opts) {
        this.overlay.set({ view: { kind: "confirm", action, ...(opts || {}) } });
      }

      async openPick(mode, turn) {
        // 弹窗必须看到最新全部轮次，不能复用早期只有 1 轮的快照。
        await this.fetchMessages(true).catch(() => {});
        this.overlay.set({ view: { kind: "pick", mode, turn } });
      }

      dismiss() {
        this.overlay.set({ view: null });
      }

      requestAction(action, opts) {
        const config = this.config();
        if (config.confirm !== false) {
          this.openConfirm(action, opts);
          return;
        }
        this.doAction(action, opts);
      }

      confirmAction(action, opts) {
        this.dismiss();
        this.doAction(action, opts);
      }

      async doAction(action, opts) {
        const body = { sessionId: this.sessionId, action };
        if (opts && opts.seq != null) body.seq = opts.seq;
        else if (opts && opts.messageId != null) body.messageId = opts.messageId;

        let data;
        try {
          ({ data } = await postJson("/dsh-message-actions", body));
        } catch {
          // 网络中断 / 宿主 15s 超时：必须给用户可理解的反馈，且不留下未捕获 rejection。
          showToast(t("toast.failed"));
          return false;
        }
        if (!data || !data.ok) {
          const code = data && data.error && data.error.code;
          const labels = ERROR_LABELS[detectLang()] || ERROR_LABELS.zh;
          if (code === "AGENT_BUSY") showToast(t("toast.busy"));
          else showToast((code && labels[code]) || t("toast.failed"));
          return false;
        }

        const value = data.value || {};
        const removedTurn = value.turn;
        if (value.via === "user" && Number.isFinite(removedTurn)) {
          this.addHiddenTurn(removedTurn);
        } else if (value.via === "tool" && opts && opts.nodeKey) {
          // 工具行删除只遮蔽该工具节点，不影响同轮其它内容。
          applyHiddenTool(this.sessionId, opts.nodeKey);
        }
        if (action === "recall") {
          if (value.refillText) refillComposer(this.sessionId, value.refillText);
          // 图片 / 文件：按附件 id 取回字节，交给官方输入框的 drop 通道恢复成真实附件。
          restoreRecallAttachments(this.sessionId, value.attachments).catch(() => {});
        }
        // 刷新消息快照（拿到最新 goneTurns），再重放导航隐藏。
        await this.fetchMessages(true).catch(() => {});
        syncRail();
        return true;
      }
    }

    // -------------------------------------------------------------------------
    // DOM 工具
    // -------------------------------------------------------------------------

    function sessionElement(sessionId) {
      if (typeof document === "undefined") return null;
      for (const el of document.querySelectorAll("[data-conversation-session]")) {
        if (el.getAttribute("data-conversation-session") === sessionId) return el;
      }
      return null;
    }

    function isRunning(sessionId) {
      const el = sessionElement(sessionId);
      return !!(el && el.querySelector("[data-chat-running]"));
    }

    function refillComposer(sessionId, text) {
      if (!text) return;
      const sessionEl = sessionElement(sessionId);
      if (!sessionEl) {
        showToast(t("toast.failed"));
        return;
      }
      const editable = sessionEl.querySelector(
        "[data-conversation-region='composer'] [contenteditable='true']"
      );
      if (!editable) {
        // 找不到输入框时退回剪贴板；给用户明确反馈，避免“复制成功却提示失败”。
        try {
          if (navigator.clipboard) {
            Promise.resolve(navigator.clipboard.writeText(text)).then(
              () => showToast(t("toast.copied")),
              () => showToast(t("toast.failed"))
            );
            return;
          }
        } catch {
          /* ignore */
        }
        showToast(t("toast.failed"));
        return;
      }
      editable.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertText", false, text);
      } catch {
        try {
          document.execCommand("insertText", false, text);
        } catch {
          showToast(t("toast.failed"));
        }
      }
    }

    // 附件回读路由：撤回后按 id 取回字节（image 为宿主归一化后的图片）。
    const ATTACHMENT_PATH = "/dsh-message-actions/attachment";

    /**
     * 撤回后恢复图片 / 文件附件。
     * 取回字节 -> 构造 File -> 在 document 上派发 drop 事件，
     * 交给官方输入框的 `onAddFiles`（createDrafts + addFiles）恢复成真实附件。
     * 无附件、环境不支持 DataTransfer 或全部取回失败时静默跳过。
     */
    async function restoreRecallAttachments(sessionId, attachments) {
      if (!Array.isArray(attachments) || attachments.length === 0) return;
      if (typeof document === "undefined" || typeof DataTransfer !== "function") return;
      const files = [];
      for (const meta of attachments) {
        if (!meta || typeof meta.attachmentId !== "string") continue;
        try {
          const query =
            "sessionId=" + encodeURIComponent(sessionId) +
            "&attachmentId=" + encodeURIComponent(meta.attachmentId);
          const res = await fetchWithTimeout(apiUrl(ATTACHMENT_PATH, query), { cache: "no-store" });
          if (!res.ok) continue;
          const blob = await res.blob();
          const name = typeof meta.name === "string" && meta.name.length > 0
            ? meta.name
            : (meta.kind === "image" ? "image.png" : "attachment");
          files.push(new File([blob], name, { type: meta.mediaType || blob.type || "" }));
        } catch {
          /* 单个附件失败不影响其它附件 */
        }
      }
      if (files.length === 0) return;
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      let event;
      try {
        event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
      } catch {
        event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
      }
      document.dispatchEvent(event);
    }

    // -------------------------------------------------------------------------
    // 问行按钮 DOM 注入
    // -------------------------------------------------------------------------

    const BUTTON_DEFS = [
      { key: "recall", cfg: "recall", danger: false },
      { key: "share", cfg: "share", danger: false },
      { key: "export", cfg: "export", danger: false },
      { key: "delete", cfg: "delete", danger: true },
      { key: "deleteFrom", cfg: "deleteFrom", danger: true }
    ];

    function injectQuestionButtons(ctx) {
      if (typeof document === "undefined") return;
      for (const clock of document.querySelectorAll('[data-clock="start"]')) {
        const sessionEl = clock.closest("[data-conversation-session]");
        if (!sessionEl) continue;
        const sessionId = sessionEl.getAttribute("data-conversation-session");
        const row = clock.closest("[data-chat-turn]");
        const turnText = row ? row.getAttribute("data-chat-turn") : null;
        const turn = turnText == null ? null : Number(turnText);

        const controller = sessionFor(ctx, sessionId);
        const config = controller.config();
        const running = isRunning(sessionId);
        const lang = detectLang();

        // 签名含语言：语言切换后按钮的 aria-label / title 需要重建。
        const signature = BUTTON_DEFS.map((def) =>
          config[def.cfg] === false ? "0" : "1"
        ).join("") + (running ? "R" : "I") + (lang === "zh" ? "Z" : "E");

        const existing = clock.querySelector("[data-dma-actions]");
        if (existing && existing.getAttribute("data-dma-sig") === signature) continue;
        disposeActionsRow(existing);

        const wrap = document.createElement("span");
        wrap.className = "dma-row-actions";
        wrap.setAttribute("data-dma-actions", "1");
        wrap.setAttribute("data-dma-sig", signature);

        for (const def of BUTTON_DEFS) {
          if (config[def.cfg] === false) continue;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "dma-btn" + (def.danger ? " dma-danger" : "");
          btn.setAttribute("data-dma-action", def.key);
          btn.setAttribute("aria-label", t("btn." + def.key));
          btn.title = t("btn." + def.key);
          if (!paintButtonIcon(btn, def.key)) btn.innerHTML = ICONS[def.key] || "";
          if (running) btn.disabled = true;
          btn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            handleQuestionAction(ctx, controller, def.key, turn);
          });
          wrap.appendChild(btn);
        }

        clock.appendChild(wrap);
      }
    }

    async function handleQuestionAction(ctx, controller, actionKey, turn) {
      if (actionKey === "share") {
        controller.openPick("share", turn);
        return;
      }
      if (actionKey === "export") {
        controller.openPick("export", turn);
        return;
      }
      if (turn == null) return;
      await controller.fetchMessages(true).catch(() => {});
      const rows = controller.messages && controller.messages.rows;
      const seq = controller.userSeqForTurn(rows, turn);
      if (seq == null) {
        showToast(t("toast.failed"));
        return;
      }
      controller.requestAction(actionKey, { seq, turn });
    }

    // -------------------------------------------------------------------------
    // 工具行按钮 DOM 注入
    // -------------------------------------------------------------------------

    /**
     * 工具行定位依据（宿主 `@deepseek-ai/dsh-client-ui-chat`）：
     *   - `data-chat-flow-kind="tool-call"`：toolDefinition 的 kind；
     *   - `data-chat-node-key`：conversationContextKey("tool-call", id) = `9:tool-call<id>`；
     *   - id 来自服务端 `tool/call.data.callId` / `tool/result.data.message.source.callId`。
     * 因此可以稳定映射到服务端 tool/result 的 seq，不依赖子节点序号或点击坐标。
     */
    function injectToolButtons(ctx) {
      if (typeof document === "undefined") return;
      const rows = document.querySelectorAll(
        "[data-chat-flow-kind='tool-call'][data-chat-node-key]"
      );
      for (const row of rows) {
        const nodeKey = row.getAttribute("data-chat-node-key");
        const callId = toolCallIdFromNodeKey(nodeKey);
        if (!callId) continue;
        const sessionEl = row.closest("[data-conversation-session]");
        const sessionId = sessionEl ? sessionEl.getAttribute("data-conversation-session") : null;
        if (!sessionId) continue;
        if (row.closest("[data-dma-hidden='1']") || row.hasAttribute("hidden")) continue;

        const controller = sessionFor(ctx, sessionId);
        const config = controller.config();
        const existing = row.querySelector("[data-dma-tool-actions]");
        if (config.delete === false) {
          if (existing) disposeActionsRow(existing);
          continue;
        }

        const running = isRunning(sessionId);
        const lang = detectLang();
        const signature = (running ? "R" : "I") + (lang === "zh" ? "Z" : "E");
        if (existing && existing.getAttribute("data-dma-sig") === signature) continue;
        if (existing) disposeActionsRow(existing);

        const wrap = document.createElement("span");
        wrap.className = "dma-tool-actions";
        wrap.setAttribute("data-dma-tool-actions", "1");
        wrap.setAttribute("data-dma-sig", signature);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dma-btn dma-danger";
        btn.setAttribute("data-dma-action", "deleteTool");
        btn.setAttribute("aria-label", t("btn.deleteTool"));
        btn.title = t("btn.deleteTool");
        if (!paintButtonIcon(btn, "delete")) btn.innerHTML = ICONS.delete || "";
        if (running) btn.disabled = true;
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          handleToolAction(ctx, controller, nodeKey);
        });
        wrap.appendChild(btn);
        row.appendChild(wrap);
      }
    }

    async function handleToolAction(ctx, controller, nodeKey) {
      const callId = toolCallIdFromNodeKey(nodeKey);
      if (!callId) {
        showToast(t("toast.failed"));
        return;
      }
      // 摘要快照必须含最新 tool/result 行，否则拿不到稳定的服务端 seq。
      await controller.fetchMessages(true).catch(() => {});
      const rows = controller.messages && controller.messages.rows;
      const row = findToolRowByCallId(rows, callId);
      if (!row) {
        showToast(t("toast.failed"));
        return;
      }
      controller.requestAction("delete", {
        seq: row.seq,
        turn: row.turn,
        step: row.step,
        target: "tool",
        nodeKey
      });
    }

    // -------------------------------------------------------------------------
    // 导航刻度隐藏与压缩
    // -------------------------------------------------------------------------

    function findRail(root) {
      if (!root) return null;
      if (root.tagName === "NAV" && root.querySelector("button[data-index]")) return root;
      const inner = root.querySelector("nav");
      return inner ? findRail(inner) : null;
    }

    function railButtons(rail) {
      return rail ? [...rail.querySelectorAll("button[data-index]")] : [];
    }

    /** 删除成功后立刻隐藏该轮的行（乐观更新），避免等宿主刷新才消失。 */
    function applyHiddenRows(sessionId, goneTurns) {
      const sessionEl = sessionElement(sessionId);
      if (!sessionEl || goneTurns.size === 0) return;
      for (const row of sessionEl.querySelectorAll("[data-chat-turn]")) {
        const turn = Number(row.getAttribute("data-chat-turn"));
        if (!goneTurns.has(turn) || row.getAttribute("data-dma-hidden") === "1") continue;
        // 只用自有属性隐藏（CSS display:none），不写官方 hidden 属性，
        // 避免反复写属性触发导航观察器自激。
        row.setAttribute("data-dma-hidden", "1");
      }
    }

    /** 工具行删除成功后，只隐藏该工具节点（按宿主稳定的 data-chat-node-key）。 */
    function applyHiddenTool(sessionId, nodeKey) {
      const sessionEl = sessionElement(sessionId);
      if (!sessionEl || typeof nodeKey !== "string" || nodeKey === "") return;
      for (const row of sessionEl.querySelectorAll("[data-chat-flow-kind='tool-call'][data-chat-node-key]")) {
        if (row.getAttribute("data-chat-node-key") !== nodeKey) continue;
        row.setAttribute("data-dma-hidden", "1");
      }
    }

    /**
     * 按「已删除工具行 callId」重新隐藏。
     * 删除成功当下隐藏一次是不够的：切换会话 / 刷新页面会让宿主重建 DOM，
     * 新节点不带 data-dma-hidden，于是被删内容又出现。这里每次同步都重放。
     */
    function applyHiddenTools(sessionId, callIds) {
      const sessionEl = sessionElement(sessionId);
      if (!sessionEl || !callIds || callIds.length === 0) return;
      const rows = [...sessionEl.querySelectorAll("[data-chat-flow-kind='tool-call'][data-chat-node-key]")];
      if (rows.length === 0) return;
      const keys = rows.map((row) => row.getAttribute("data-chat-node-key"));
      const hide = new Set(toolNodeKeysToHide(keys, callIds));
      if (hide.size === 0) return;
      for (let i = 0; i < rows.length; i += 1) {
        if (!hide.has(keys[i])) continue;
        if (rows[i].getAttribute("data-dma-hidden") === "1") continue;
        rows[i].setAttribute("data-dma-hidden", "1");
      }
    }

    function visibleRowsExist(sessionId, turn) {
      const sessionEl = sessionElement(sessionId);
      if (!sessionEl) return false;
      for (const row of sessionEl.querySelectorAll('[data-chat-turn="' + turn + '"]')) {
        if (row.hasAttribute("data-dma-hidden") || row.hasAttribute("hidden")) continue;
        if (row.closest("[data-dma-hidden='1']") || row.closest("[hidden]")) continue;
        if (row.hasAttribute("data-chat-group-key")) continue;
        if (row.getAttribute("data-chat-flow-kind") === "turn-process") continue;
        if (row.textContent.trim() === "") continue;
        return true;
      }
      return false;
    }

    let railSyncing = false;

    function syncRail() {
      if (typeof document === "undefined" || railSyncing) return;
      railSyncing = true;
      try {
      for (const sessionNode of document.querySelectorAll("[data-conversation-session]")) {
        const sessionId = sessionNode.getAttribute("data-conversation-session");

        const goneTurns = new Set();
        const goneTools = [];
        const controller = controllers.get(sessionId);
        if (controller) {
          for (const turn of controller.hiddenTurns) goneTurns.add(turn);
          const hostGone = controller.messages && controller.messages.goneTurns;
          if (Array.isArray(hostGone)) for (const turn of hostGone) goneTurns.add(turn);
          const hostGoneTools = controller.messages && controller.messages.goneTools;
          if (Array.isArray(hostGoneTools)) goneTools.push(...hostGoneTools);
        }
        applyHiddenRows(sessionId, goneTurns);
        applyHiddenTools(sessionId, goneTools);

        const rail = findRail(sessionNode);
        if (!rail) continue;

        const items = [];
        for (const btn of railButtons(rail)) {
          // data-index 语义未验证：与 aria-label 解析一致时才采用，否则回退旧逻辑。
          const turn = railTurnOfAttributes(
            btn.getAttribute("data-index"),
            btn.getAttribute("aria-label")
          );
          const gone = turn != null && goneTurns.has(turn);
          const hidden = gone && (!visibleRowsExist(sessionId, turn));
          items.push({ btn, hidden });
        }

        applyRailCollapse(items);
      }
      } finally {
        railSyncing = false;
      }
    }

    /**
     * 只在目标状态与 DOM 现状不同的时候写入。
     * 之前每次同步都无条件 setAttribute/style，而导航观察器监听 attributes，
     * 会形成「写入 → 观察 → 再写入」的微任务死循环，导致整个页面无响应。
     */
    function applyRailCollapse(items) {
      let hiddenBefore = 0;
      for (const item of items) {
        const btn = item.btn;
        const tooltip = btn.querySelector('[role="tooltip"]');
        if (item.hidden) {
          hiddenBefore += 1;
          if (btn.getAttribute("data-dma-rail") !== "1") btn.setAttribute("data-dma-rail", "1");
          if (btn.style.marginTop !== "") btn.style.marginTop = "";
          if (tooltip && tooltip.style.transform !== "") tooltip.style.transform = "";
        } else {
          if (btn.hasAttribute("data-dma-rail")) btn.removeAttribute("data-dma-rail");
          const offset = hiddenBefore * 10;
          const margin = offset === 0 ? "" : "-" + offset + "px";
          if (btn.style.marginTop !== margin) btn.style.marginTop = margin;
          const transform = offset === 0 ? "" : "translateY(-" + offset + "px)";
          if (tooltip && tooltip.style.transform !== transform) tooltip.style.transform = transform;
        }
      }
    }

    // -------------------------------------------------------------------------
    // 分享 / 导出
    // -------------------------------------------------------------------------

    function roundsOfData(data) {
      if (!data || !data.messages) return [];
      const hidden = new Set(data.hidden || []);
      return (data.messages.rounds || []).filter((r) => !hidden.has(r.turn));
    }

    function downloadBlob(content, filename, type) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function formatNow() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      return (
        d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
      );
    }

    /**
     * 摘要快照里的 round 只有预览；分享图 / 导出必须先按需拉全文。
     * 只请求用户实际选中的轮次（`full=1&turns=`），失败返回 null，绝不用预览生成产物。
     * @returns {Promise<Array<{ turn, question, answer }> | null>}
     */
    async function resolveFullRounds(controller, selected) {
      const turns = (selected || [])
        .map((round) => round && round.turn)
        .filter(Number.isSafeInteger);
      if (turns.length === 0) return [];
      const rounds = await controller.fetchRoundText(turns);
      if (!Array.isArray(rounds)) return null;
      const byTurn = new Map(rounds.map((round) => [round.turn, round]));
      // 保持用户在列表里的选择顺序，按轮次升序输出。
      return turns
        .map((turn) => byTurn.get(turn))
        .filter(Boolean)
        .sort((a, b) => a.turn - b.turn);
    }

    async function doExport(controller, selected) {
      const full = await resolveFullRounds(controller, selected);
      if (full === null) {
        showToast(t("toast.failed"));
        return false;
      }
      const content = markdownOf(full, {
        title: t("export.title"),
        sessionId: controller.sessionId,
        exportedAt: formatNow(),
        questionLabel: t("pick.turn"),
        answerLabel: t("pick.answer")
      });
      if (!content.trim()) {
        showToast(t("toast.empty"));
        return false;
      }
      downloadBlob(content, exportFilename(controller.sessionId, new Date()), "text/markdown;charset=utf-8");
      return true;
    }

    const SHARE_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif";

    /** 把纯文本渲染成分享图可用的 HTML（保留代码围栏，折叠其余为 pre-wrap）。 */
    function shareTextHtml(text) {
      const parts = String(text == null ? "" : text).split(/```(?:[^\n]*)\n?([\s\S]*?)```/g);
      let out = "";
      for (let index = 0; index < parts.length; index += 1) {
        if (index % 2 === 0) {
          out += '<span style="white-space:pre-wrap;word-break:break-word">' + escapeHtml(parts[index]) + "</span>";
        } else {
          out += '<pre style="white-space:pre-wrap;word-break:break-word;margin:8px 0;padding:10px 12px;border-radius:8px;background:#f4f5f7;color:#24292f;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:1.55">' + escapeHtml(parts[index]) + "</pre>";
        }
      }
      return out;
    }

    /** 与旧版一致的浅色分享图：问行右对齐气泡，答行正文。 */
    function buildShareHtml(controller, selected) {
      const blocks = selected.map((round) => {
        const question = (round.question || "").trim();
        const answer = (round.answer || "").trim();
        let out = '<div style="margin:0 0 28px">';
        if (question) {
          out +=
            '<div style="display:flex;justify-content:flex-end">' +
            '<div style="max-width:76%;padding:10px 14px;border-radius:12px;background:#f1f3f6;color:#1a1a1a;font-size:14px;line-height:1.7">' +
            '<span style="display:inline-block;margin-right:8px;color:#8a8f98;font-size:11px">' +
            escapeHtml(t("pick.turn")) +
            "</span>" +
            shareTextHtml(question) +
            "</div></div>";
        }
        if (answer) {
          out +=
            '<div style="margin-top:12px;color:#2b2f36;font-size:14px;line-height:1.7">' +
            '<span style="display:inline-block;margin-right:8px;color:#8a8f98;font-size:11px">' +
            escapeHtml(t("pick.answer")) +
            "</span>" +
            shareTextHtml(answer) +
            "</div>";
        }
        return out + "</div>";
      }).join("");
      return (
        '<article xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:720px;padding:46px 44px;background:#ffffff;color:#1a1a1a;font-family:' +
        SHARE_FONT +
        ";font-size:14px;line-height:1.7\">" +
        blocks +
        "</article>"
      );
    }

    /**
     * 生成并下载分享图。
     * @returns {Promise<boolean>} true = 已成功触发下载；false = 失败（已提示）
     */
    async function generateSharePng(controller, selected) {
      const full = await resolveFullRounds(controller, selected);
      if (full === null) {
        showToast(t("toast.failed"));
        return false;
      }
      const html = buildShareHtml(controller, full);
      const holder = document.createElement("div");
      holder.style.cssText = "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none";
      holder.innerHTML = html;
      document.body.appendChild(holder);
      const height = Math.max(1, Math.ceil(holder.firstElementChild.getBoundingClientRect().height));
      holder.remove();

      const MAX_HEIGHT = 12000;
      if (height > MAX_HEIGHT) {
        showToast(t("toast.tooMuch"));
        return false;
      }

      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="' + height + '" viewBox="0 0 720 ' + height + '">' +
        '<foreignObject x="0" y="0" width="100%" height="100%">' + html + "</foreignObject></svg>";
      const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      const img = new Image();
      // 成功路径原本在 img.onload 里异步完成；用 Promise 包起来，
      // 调用方才能据返回值决定是否关闭浮层（失败时保留已选轮次）。
      return new Promise((resolve) => {
        img.onload = () => {
          // 目标 2x；但按面积上限回落，避免长会话触发部分 WebView 的 canvas 面积限制。
          const MAX_CANVAS_PIXELS = 16 * 1000 * 1000;
          const scale = Math.max(1, Math.min(2, Math.sqrt(MAX_CANVAS_PIXELS / (720 * height))));
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(720 * scale);
          canvas.height = Math.ceil(height * scale);
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            showToast(t("toast.failed"));
            resolve(false);
            return;
          }
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, 720, height);
          canvas.toBlob((png) => {
            if (!png) {
              showToast(t("toast.failed"));
              resolve(false);
              return;
            }
            const pngUrl = URL.createObjectURL(png);
            const a = document.createElement("a");
            a.href = pngUrl;
            a.download = exportFilename(controller.sessionId, new Date()).replace(/\.md$/, ".png");
            document.body.appendChild(a);
            a.click();
            a.remove();
            // 留足下载启动时间，避免慢磁盘/大图时提前释放。
            setTimeout(() => URL.revokeObjectURL(pngUrl), 10000);
            resolve(true);
          }, "image/png");
        };
        img.onerror = () => {
          showToast(t("toast.failed"));
          resolve(false);
        };
        img.src = url;
      });
    }

    // -------------------------------------------------------------------------
    // React 组件
    // -------------------------------------------------------------------------

    const e = React.createElement;

    function Icon({ kind, size }) {
      const official = officialIconElement(kind, size || 13);
      if (official) return e("span", { className: "dma-ico" }, official);
      return e("span", {
        className: "dma-ico",
        dangerouslySetInnerHTML: { __html: ICONS[kind] || "" }
      });
    }

    // 答行统计（assistant-actions 槽位）
    function AssistantActions({ messageId, t: tt, useData, form, refresh }) {
      const messages = useData((view) => view.messages);
      const snap = React.useSyncExternalStore(
        (listener) => (form && form.subscribe ? form.subscribe(listener) : () => {}),
        () => (form && form.getSnapshot ? form.getSnapshot() : null)
      );
      const config = snap && snap.status === "ready" && typeof snap.value === "object"
        ? snap.value
        : null;
      const rows = (messages && messages.rows) || [];
      const row = rows.find((item) => item.id === messageId && item.type === "assistant/message");

      // 快照可能还没包含这条新回答：按 TTL 补拉一次，让统计随对话更新。
      React.useEffect(() => {
        if (!row && refresh) refresh();
      }, [row && row.id, refresh]);

      let tokens = row && row.usage && Number.isFinite(row.usage.outputTokens)
        ? row.usage.outputTokens
        : null;
      // 与旧版对齐：中间步骤没有 usage 时，用同一轮最后一条带用量的回答兜底。
      if (tokens == null && row && Number.isSafeInteger(row.turn)) {
        const sameTurn = rows.filter((item) =>
          item.turn === row.turn &&
          item.type === "assistant/message" &&
          item.usage &&
          Number.isFinite(item.usage.outputTokens)
        );
        if (sameTurn.length > 0) tokens = sameTurn[sameTurn.length - 1].usage.outputTokens;
      }
      // 摘要快照只带 words，不带正文；字数由服务端一次算好，客户端不再重复统计。
      const words = row && Number.isFinite(row.words) ? row.words : 0;

      if (config && config.stats === false) return null;
      if (!row || words === 0) return null;

      // 单条回答金额：只认该条自己的 usage（服务端已算好 costMicros），
      // 中间步骤没有 usage 时不拿同轮其它回答的金额兜底，避免重复计价。
      // 本地 → 「本地」；第三方未配置价格 → 「未配置」（token 仍显示）。
      let replyCost = null;
      let replyCostTitle = null;
      if (row && Number.isFinite(row.costMicros)) {
        if (row.billable === false) {
          replyCost = tt("stats.localCost");
        } else if (row.costPriced === false) {
          replyCost = tt("stats.unpricedCost");
          replyCostTitle = tt("stats.replyUnpricedTitle");
        } else {
          replyCost = formatReplyCost(row.costMicros);
          replyCostTitle = tt("stats.replyCostTitle", { cost: replyCost });
        }
      }
      const replyUnverified = row && row.routeConfirmed === false;

      const label = [
        tokens == null ? null : formatTokens(tokens) + " tok",
        words + " " + tt("stats.unit"),
        replyCost
      ].filter(Boolean).join(" \u00b7 ");

      return e("span", {
        className: "dma-stats",
        title: tt("stats.title", { tokens: tokens == null ? "?" : tokens, words }) +
          (replyCostTitle ? " \u00b7 " + replyCostTitle : "") +
          (replyUnverified ? " \u00b7 " + tt("stats.unconfirmedTag") : "")
      }, label);
    }

    /**
     * 浮层键盘支持：仅在浮层打开期间挂监听，关闭 / 卸载时由 effect 清理。
     * 捕获阶段处理并阻止冒泡：确认框是模态的，同一个 Enter 不应再触发宿主的
     * 其它快捷键；焦点在输入框时不拦截（交给控件自己处理）。
     */
    function useOverlayKeys(options) {
      const { active, primaryEnabled, busy, onDismiss, onPrimary } = options;
      const handlers = React.useRef({ onDismiss, onPrimary });
      handlers.current = { onDismiss, onPrimary };
      React.useEffect(() => {
        if (!active) return undefined;
        function onKey(event) {
          const action = resolveKeyAction({
            key: event.key,
            target: event.target,
            overlayOpen: true,
            primaryEnabled,
            busy
          });
          if (action === "none") return;
          event.preventDefault();
          event.stopPropagation();
          if (action === "dismiss") handlers.current.onDismiss();
          else if (action === "primary") handlers.current.onPrimary();
        }
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [active, primaryEnabled, busy]);
    }

    // 确认弹窗（Enter = 确认，Esc = 取消）
    function ConfirmOverlay({ t: tt, view, onDismiss, confirmAction }) {
      const firing = React.useRef(false);
      // 工具行删除与答行 step 删除共用服务端 step 分支，但文案必须能区分入口。
      const message = view.target === "tool"
        ? tt("confirm.tool")
        : (view.step ? tt("confirm.step") : tt("confirm." + String(view.action)));
      const danger = view.action !== "recall";
      function primary() {
        // 与点击「确认」完全同一个处理函数，避免键盘与鼠标行为分叉。
        if (firing.current) return;
        firing.current = true;
        confirmAction(view.action, {
          seq: view.seq,
          messageId: view.messageId,
          nodeKey: view.nodeKey,
          target: view.target
        });
      }
      useOverlayKeys({ active: true, primaryEnabled: true, busy: false, onDismiss, onPrimary: primary });
      return e("div", {
        className: "dma-overlay",
        onClick: (ev) => {
          if (ev.target === ev.currentTarget) onDismiss();
        }
      },
      e("div", { className: "dma-panel dma-confirm" },
        e("div", { className: "dma-panel-head" }, tt("confirm.title")),
        e("div", { className: "dma-panel-body" }, message),
        e("div", { className: "dma-panel-foot" },
          e("button", { type: "button", className: "dma-btn", onClick: () => onDismiss() }, tt("confirm.cancel")),
          e("button", {
            type: "button",
            autoFocus: true,
            className: "dma-btn dma-primary" + (danger ? " dma-danger" : ""),
            onClick: primary
          }, tt("confirm.ok"))
        )
      ));
    }

    /**
     * 确认框与分享/导出面板的唯一挂载路径。
     * 新版宿主会给输入区容器加 `will-change: transform`，使 `position:fixed`
     * 的包含块变成输入区而不是视口；portal 到 document.body 可彻底脱离该容器，
     * 同时不受其 `overflow:hidden` 裁剪。
     * 拿不到 createPortal / body 时原样返回，退回槽位渲染，保证旧宿主可用。
     */
    function mountOverlay(node) {
      if (node && ReactDOM && typeof ReactDOM.createPortal === "function" &&
          typeof document !== "undefined" && document.body) {
        try {
          return ReactDOM.createPortal(node, document.body);
        } catch {
          // 探测失败按旧路径渲染，弹窗不会消失。
        }
      }
      return node;
    }

    // 确认弹窗 + 分享/导出浮层控制器（input.overlay 槽位只作为渲染触发点）
    function OverlayController(props) {
      const { t: tt, useOverlay, useData, confirmAction, dismiss, runShare, runExport } = props;
      const view = useOverlay((v) => v.view);
      const data = useData((v) => v);

      if (!view) return null;

      let panel = null;
      if (view.kind === "confirm") {
        panel = e(ConfirmOverlay, {
          t: tt,
          view,
          onDismiss: dismiss,
          confirmAction
        });
      } else if (view.kind === "pick") {
        panel = e(PickOverlay, {
          t: tt,
          mode: view.mode,
          seedTurn: view.turn,
          rounds: roundsOfData(data),
          onDismiss: () => dismiss(),
          runShare,
          runExport
        });
      }

      return panel ? mountOverlay(panel) : null;
    }

    // 分享/导出多选列表
    function PickOverlay({ t, mode, seedTurn, rounds, onDismiss, runShare, runExport }) {
      // 与旧版一致：默认选中触发按钮所在的那一轮；没有轮次信息时选第一轮。
      const [selected, setSelected] = React.useState(() => {
        if (Number.isSafeInteger(seedTurn) && rounds.some((r) => r.turn === seedTurn)) {
          return new Set([seedTurn]);
        }
        return rounds.length > 0 ? new Set([rounds[0].turn]) : new Set();
      });
      const all = rounds.length > 0 && selected.size === rounds.length;

      function toggle(turn) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(turn)) next.delete(turn);
          else next.add(turn);
          return next;
        });
      }

      function selectAll() {
        setSelected(new Set(rounds.map((r) => r.turn)));
      }

      const chosen = rounds.filter((r) => selected.has(r.turn));
      const primaryLabel = mode === "share" ? t("pick.share") : t("pick.export");
      const primaryDisabled = chosen.length === 0;
      const [busy, setBusy] = React.useState(false);

      function primary() {
        // 与点击主按钮同一个处理函数；busy 期间忽略重复 Enter，避免重复生成 / 重复下载。
        if (primaryDisabled || busy) return;
        setBusy(true);
        const task = mode === "share" ? runShare(chosen) : runExport(chosen);
        Promise.resolve(task)
          .then((done) => {
            if (done) {
              onDismiss();
              return;
            }
            // 失败：保留浮层与已选轮次，复位 busy 以便重试；提示由生成函数给出。
            setBusy(false);
          })
          .catch(() => {
            showToast(t("toast.failed"));
            setBusy(false);
          });
      }

      useOverlayKeys({
        active: true,
        primaryEnabled: !primaryDisabled,
        busy,
        onDismiss,
        onPrimary: primary
      });

      return e("div", { className: "dma-overlay", onClick: (ev) => { if (ev.target === ev.currentTarget) onDismiss(); } },
        e("div", { className: "dma-panel" },
          e("div", { className: "dma-panel-head" },
            mode === "share" ? t("pick.title.share") : t("pick.title.export")),
          e("div", { className: "dma-panel-body" },
            rounds.length === 0
              ? e("p", { className: "dma-empty" }, t("toast.empty"))
              : rounds.map((round) =>
                  e("div", { className: "dma-round", key: round.turn },
                    e("button", {
                      type: "button",
                      className: "dma-round-box",
                      role: "checkbox",
                      "aria-checked": selected.has(round.turn),
                      onClick: () => toggle(round.turn)
                    }, selected.has(round.turn) ? e(Icon, { kind: "check" }) : null),
                    e("div", { className: "dma-round-main" },
                      e("div", { className: "dma-round-line dma-round-q" },
                        e("span", { className: "dma-round-tag" }, t("pick.turn") + " " + round.turn),
                        e("span", { className: "dma-round-text" },
                          round.questionPreview || "…")),
                      e("div", { className: "dma-round-line dma-round-a" },
                        e("span", { className: "dma-round-tag dma-round-tag-a" }, t("pick.answer")),
                        e("span", { className: "dma-round-text" },
                          round.answerPreview || "…"))
                    )
                  )
                )
          ),
          e("div", { className: "dma-panel-foot" },
            e("button", { type: "button", className: "dma-btn", onClick: selectAll }, t("pick.all")),
            e("div", {},
              e("button", { type: "button", className: "dma-btn", onClick: () => onDismiss() }, t("pick.cancel")),
              e("button", {
                type: "button",
                autoFocus: true,
                className: "dma-btn dma-primary",
                disabled: primaryDisabled || busy,
                onClick: primary
              }, primaryLabel)
            )
          )
        )
      );
    }

    // -------------------------------------------------------------------------
    // 会话统计浮层：body 级挂载，会话页与设置页都能打开
    // -------------------------------------------------------------------------

    const STATS_ROUTE = "/dsh-message-actions/stats";
    const STATS_BUDGET_ROUTE = "/dsh-message-actions/stats/budget";
    const BILLING_ROUTE = "/dsh-message-actions/billing";
    const STATS_POLL_MS = 10000;

    const STATS_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M3 13V9M6.7 13V6M10.4 13V8.5M14 13V3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    const REFRESH_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6V5.4h-2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    let statsHost = null;
    let statsOpener = null;
    const statsStore = createStore({ open: false, seq: 0 });

    function openStatsPanel(opener) {
      if (typeof document === "undefined" || !document.body) return;
      if (!ReactDOMClient || typeof ReactDOMClient.createRoot !== "function") return;
      statsOpener = opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      if (!statsHost) {
        statsHost = document.createElement("div");
        statsHost.className = "dma-stats-root";
        document.body.appendChild(statsHost);
        ReactDOMClient.createRoot(statsHost).render(e(StatsOverlay));
      }
      const snapshot = statsStore.getSnapshot();
      statsStore.set({ open: true, seq: snapshot.seq + 1 });
    }

    function closeStatsPanel() {
      const snapshot = statsStore.getSnapshot();
      if (!snapshot.open) return;
      statsStore.set({ open: false, seq: snapshot.seq + 1 });
      const opener = statsOpener;
      statsOpener = null;
      if (opener && typeof opener.focus === "function" && opener.isConnected) {
        try {
          opener.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
    }

    function StatsOverlay() {
      const snapshot = React.useSyncExternalStore(statsStore.subscribe, statsStore.getSnapshot, statsStore.getSnapshot);
      if (!snapshot.open) return null;
      return e(StatsPanel, { key: snapshot.seq, onClose: closeStatsPanel });
    }

    function statsPct(value) {
      const n = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
      return (Math.round(n * 10) / 10) + "%";
    }

    /** 比例文本不封顶（超预算时仍显示真实百分比）。 */
    function statsRatioText(value) {
      const n = Number.isFinite(value) ? Math.max(0, value) : 0;
      return (Math.round(n * 10) / 10) + "%";
    }

    function statsShare(part, total) {
      if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
      return (part / total) * 100;
    }

    function statsClock(ts) {
      const date = new Date(ts);
      const pad = (n) => (n < 10 ? "0" + n : String(n));
      return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    function statsRelative(ts, tt) {
      if (!Number.isFinite(ts) || ts <= 0) return "—";
      const diff = Math.max(0, Date.now() - ts);
      if (diff < 60 * 1000) return tt("stats.now");
      if (diff < 60 * 60 * 1000) return tt("stats.minutesAgo", { n: Math.floor(diff / 60000) });
      if (diff < 24 * 60 * 60 * 1000) return tt("stats.hoursAgo", { n: Math.floor(diff / 3600000) });
      return tt("stats.daysAgo", { n: Math.floor(diff / 86400000) });
    }

    function StatsLegend({ t: tt }) {
      const rows = [
        ["input", "dma-stats-seg-input"],
        ["cacheRead", "dma-stats-seg-cacheRead"],
        ["cacheWrite", "dma-stats-seg-cacheWrite"],
        ["output", "dma-stats-seg-output"]
      ];
      return e("div", { className: "dma-stats-legend" },
        rows.map(([key, cls]) => e("span", { key },
          e("i", { className: "dma-stats-swatch " + cls }),
          tt("stats." + key))
        )
      );
    }

    function StatsStack({ bucket, max, className }) {
      const total = Number.isFinite(bucket.tokens) ? bucket.tokens : 0;
      const height = max > 0 ? statsShare(total, max) : 0;
      // 计费口径细条：可计价（深蓝）/ 本地 · 不计费（中性灰）/ 未配置价格（琥珀）。
      // 四色分类已占用蓝色系，因此不重上分类色，而是另加一条独立细条与独立图例。
      const billableTokens = Number.isFinite(bucket.billableTokens) ? bucket.billableTokens : total;
      const localTokens = Number.isFinite(bucket.localTokens) ? bucket.localTokens : 0;
      const unpricedTokens = Number.isFinite(bucket.unpricedTokens) ? bucket.unpricedTokens : 0;
      const segments = [
        ["input", "dma-stats-seg-input"],
        ["cacheRead", "dma-stats-seg-cacheRead"],
        ["cacheWrite", "dma-stats-seg-cacheWrite"],
        ["output", "dma-stats-seg-output"]
      ];
      return e("div", { className: "dma-stats-col" },
        e("div", {
          className: "dma-stats-stack" + (className ? " " + className : ""),
          style: { height: statsPct(height) }
        },
          segments.map(([key, cls]) => {
            const part = Number.isFinite(bucket[key]) ? bucket[key] : 0;
            if (part <= 0 || total <= 0) return null;
            return e("i", {
              key,
              className: "dma-stats-seg " + cls,
              style: { height: statsPct(statsShare(part, total)) }
            });
          })
        ),
        total > 0
          ? e("div", { className: "dma-stats-billing-bar" },
            billableTokens > 0
              ? e("i", { className: "dma-stats-billing-deepseek", style: { width: statsPct(statsShare(billableTokens, total)) } })
              : null,
            localTokens > 0
              ? e("i", { className: "dma-stats-billing-local", style: { width: statsPct(statsShare(localTokens, total)) } })
              : null,
            unpricedTokens > 0
              ? e("i", { className: "dma-stats-billing-unpriced", style: { width: statsPct(statsShare(unpricedTokens, total)) } })
              : null
          )
          : null
      );
    }

    function StatsTimeline({ t: tt, series, range, onRange }) {
      const buckets = range === "hour" ? (series.hourly || []).slice(-24) : (series.daily || []);
      let max = 0;
      let billableTotal = 0;
      let localTotal = 0;
      let unpricedTotal = 0;
      for (const bucket of buckets) {
        if (bucket.tokens > max) max = bucket.tokens;
        billableTotal += Number.isFinite(bucket.billableTokens) ? bucket.billableTokens : bucket.tokens;
        localTotal += Number.isFinite(bucket.localTokens) ? bucket.localTokens : 0;
        unpricedTotal += Number.isFinite(bucket.unpricedTokens) ? bucket.unpricedTokens : 0;
      }
      const first = buckets.length > 0 ? buckets[0].t : 0;
      const last = buckets.length > 0 ? buckets[buckets.length - 1].t : 0;
      return e("div", { className: "dma-stats-section" },
        e("div", { className: "dma-stats-section-head" },
          e("h4", { className: "dma-stats-section-title" }, tt("stats.timeline")),
          e("div", { className: "dma-stats-range", role: "group", "aria-label": tt("stats.timeline") },
            e("button", {
              type: "button",
              "aria-pressed": range === "hour" ? "true" : "false",
              onClick: () => onRange("hour")
            }, tt("stats.range24")),
            e("button", {
              type: "button",
              "aria-pressed": range === "day" ? "true" : "false",
              onClick: () => onRange("day")
            }, tt("stats.range30"))
          )
        ),
        e("div", { className: "dma-stats-chart-card" },
          e("div", { className: "dma-stats-chart-meta" },
            e("span", {}, statsClock(first) + " → " + statsClock(last)),
            e("span", {}, tt("stats.peak") + " " + formatTokens(max))
          ),
          e("div", {
            className: "dma-stats-chart",
            role: "img",
            "aria-label": tt("stats.timeline") + ": " + tt("stats.total") + " " + formatTokens(
              buckets.reduce((sum, bucket) => sum + (Number.isFinite(bucket.tokens) ? bucket.tokens : 0), 0)
            )
          },
            buckets.map((bucket, index) => e("div", {
              key: bucket.t,
              title: statsClock(bucket.t) + " · " + formatTokens(bucket.tokens) + " · " + formatCostMicros(bucket.costMicros)
                + (Number.isFinite(bucket.localTokens) && bucket.localTokens > 0
                  ? " · " + tt("stats.billingLocal") + " " + formatTokens(bucket.localTokens)
                  : "")
                + (Number.isFinite(bucket.unpricedTokens) && bucket.unpricedTokens > 0
                  ? " · " + tt("stats.billingUnpriced") + " " + formatTokens(bucket.unpricedTokens)
                  : "")
            }, e(StatsStack, { bucket, max })))
          ),
          e("div", { className: "dma-stats-axis" },
            [0, Math.floor(buckets.length / 3), Math.floor((buckets.length * 2) / 3), Math.max(0, buckets.length - 1)]
              .map((position, index) => e("span", { key: index },
                buckets[position] ? statsClock(buckets[position].t).slice(0, 5) : ""))
          ),
          e("div", { className: "dma-stats-legend-row" },
            e(StatsLegend, { t: tt }),
            e("div", { className: "dma-stats-legend dma-stats-legend-billing" },
              e("span", {},
                e("i", { className: "dma-stats-swatch dma-stats-billing-deepseek" }),
                tt("stats.billingDeepseek") + " " + formatTokens(billableTotal)),
              e("span", {},
                e("i", { className: "dma-stats-swatch dma-stats-billing-local" }),
                tt("stats.billingLocal") + " " + formatTokens(localTotal)),
              unpricedTotal > 0
                ? e("span", {},
                  e("i", { className: "dma-stats-swatch dma-stats-billing-unpriced" }),
                  tt("stats.billingUnpriced") + " " + formatTokens(unpricedTotal))
                : null
            )
          )
        )
      );
    }

    function StatsSessionRows({ t: tt, rows, truncated, total }) {
      return e("div", { className: "dma-stats-section" },
        e("div", { className: "dma-stats-section-head" },
          e("h4", { className: "dma-stats-section-title" }, tt("stats.sessionsSection")),
          e("span", { className: "dma-stats-note" }, truncated ? tt("stats.truncated") : total + " / " + total)
        ),
        e("div", { className: "dma-stats-rows" },
          e("div", { className: "dma-stats-row dma-stats-row-head", "aria-hidden": "true" },
            e("span", {}, tt("stats.colSession")),
            e("span", { className: "dma-stats-cell-right" }, tt("stats.colTokens")),
            e("span", { className: "dma-stats-cell-right" }, tt("stats.colCost")),
            e("span", { className: "dma-stats-cell-right" }, tt("stats.colUpdated"))
          ),
          rows.length === 0
            ? e("div", { className: "dma-stats-empty" }, tt("stats.empty"))
            : rows.map((row) => {
              // 只有本地用量时成本显示「本地」；只有未配置价格的用量时显示「未配置」，
              // 避免把「没算钱」误读成「花了 0 元」。
              const localOnly = Number.isFinite(row.localTokens) && row.localTokens > 0 &&
                !(Number.isFinite(row.billableTokens) && row.billableTokens > 0) &&
                !(Number.isFinite(row.unpricedTokens) && row.unpricedTokens > 0);
              const unpricedOnly = Number.isFinite(row.unpricedTokens) && row.unpricedTokens > 0 &&
                !(Number.isFinite(row.billableTokens) && row.billableTokens > 0);
              const mixedUnpriced = Number.isFinite(row.unpricedTokens) && row.unpricedTokens > 0 &&
                Number.isFinite(row.billableTokens) && row.billableTokens > 0;
              const costLabel = localOnly
                ? tt("stats.localCost")
                : unpricedOnly
                  ? tt("stats.unpricedCost")
                  : formatCostMicros(row.costMicros) + (mixedUnpriced ? " · " + tt("stats.unpricedSuffix") : "");
              const costTitle = localOnly
                ? tt("stats.billingNote")
                : unpricedOnly || mixedUnpriced
                  ? tt("stats.replyUnpricedTitle")
                  : undefined;
              return e("div", { key: row.id, className: "dma-stats-row" },
                e("div", { className: "dma-stats-cell" },
                  e("div", { className: "dma-stats-row-title" },
                    e("b", { title: row.title }, row.title),
                    localOnly ? e("span", { className: "dma-stats-pill dma-stats-pill-local" }, tt("stats.localTag")) : null,
                    unpricedOnly ? e("span", { className: "dma-stats-pill dma-stats-pill-unpriced" }, tt("stats.unpricedTag")) : null,
                    row.unconfirmed ? e("span", { className: "dma-stats-pill dma-stats-pill-unconfirmed" }, tt("stats.unconfirmedTag")) : null,
                    row.running ? e("span", { className: "dma-stats-pill dma-stats-pill-running" }, tt("stats.running")) : null,
                    row.subagent ? e("span", { className: "dma-stats-pill" }, tt("stats.subagent")) : null
                  ),
                  e("div", { className: "dma-stats-meta" },
                    (row.model || tt("stats.noModel")) + " · " + row.turns + " turns · " + row.messages + " msgs"),
                  e("div", { className: "dma-stats-mini" },
                    e("i", { className: "dma-stats-seg-input", style: { width: statsPct(statsShare(row.tokens.input, row.tokens.total || 1)) } }),
                    e("i", { className: "dma-stats-seg-cacheRead", style: { width: statsPct(statsShare(row.tokens.cacheRead, row.tokens.total || 1)) } }),
                    e("i", { className: "dma-stats-seg-cacheWrite", style: { width: statsPct(statsShare(row.tokens.cacheWrite, row.tokens.total || 1)) } }),
                    e("i", { className: "dma-stats-seg-output", style: { width: statsPct(statsShare(row.tokens.output, row.tokens.total || 1)) } })
                  )
                ),
                e("span", { className: "dma-stats-cell dma-stats-cell-right" }, formatTokens(row.tokens.total)),
                e("span", {
                  className: "dma-stats-cell dma-stats-cell-right",
                  title: costTitle
                }, costLabel),
                e("span", { className: "dma-stats-cell dma-stats-cell-right dma-stats-meta" },
                  statsRelative(row.lastActiveAt, tt))
              );
            })
        )
      );
    }

    /** 覆盖清单对象 → 文本（provider=always / provider=local）。 */
    function overridesTextOf(overrides) {
      if (!overrides || typeof overrides !== "object") return "";
      return Object.keys(overrides)
        .sort()
        .map((key) => key + "=" + (overrides[key] === "always" ? "always" : "local"))
        .join("\n");
    }

    /**
     * 模型计费设置：来源诊断 + 覆盖清单 + 第三方价格表。
     * 保存后宿主递增 billingRevision，历史统计立即按新价重算。
     */
    function BillingSection({ t: tt, billing, onReload }) {
      const [overridesText, setOverridesText] = React.useState(() => overridesTextOf(billing && billing.overrides));
      const [pricesText, setPricesText] = React.useState(() =>
        JSON.stringify((billing && billing.prices) || { models: {}, prefixes: {}, providers: {}, fallback: null }, null, 2)
      );
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState("");
      const [error, setError] = React.useState("");
      const endpoints = billing && Array.isArray(billing.endpoints) ? billing.endpoints : [];

      const save = async () => {
        setMessage("");
        setError("");
        let prices;
        try {
          prices = JSON.parse(pricesText || "{}");
        } catch {
          setError(tt("stats.billingInvalid"));
          return;
        }
        if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
          setError(tt("stats.billingInvalid"));
          return;
        }
        setBusy(true);
        try {
          const res = await postJson(BILLING_ROUTE, { overrides: overridesText, prices });
          if (res.status === 200 && res.data && res.data.ok) {
            setMessage(tt("stats.billingSaved"));
            if (typeof onReload === "function") onReload();
          } else {
            setError(tt("stats.billingFailed"));
          }
        } catch {
          setError(tt("stats.billingFailed"));
        } finally {
          setBusy(false);
        }
      };

      return e("div", { className: "dma-stats-section dma-billing" },
        e("div", { className: "dma-stats-section-head" },
          e("h4", { className: "dma-stats-section-title" }, tt("stats.billingConfig")),
          billing && billing.endpointSource
            ? e("span", { className: "dma-stats-note" },
              tt("stats.billingEndpointSource", { source: billing.endpointSource }))
            : null
        ),
        e("div", { className: "dma-billing-endpoints" },
          endpoints.length === 0
            ? e("span", { className: "dma-stats-note" }, tt("stats.billingEndpointsEmpty"))
            : endpoints.map((item) => e("span", { key: item.provider, className: "dma-billing-endpoint" },
              e("b", {}, item.provider),
              " · " + (item.host || "—"),
              e("em", {
                className: "dma-billing-kind dma-billing-kind-" + (
                  item.local ? "local" : item.kind === "third-party" ? "third" : "official"
                )
              }, item.local ? tt("stats.billingLocal") : item.kind === "third-party" ? tt("stats.billingThird") : tt("stats.billingDeepseek")),
              item.local ? null : e("em", {
                className: "dma-billing-kind dma-billing-kind-price-" + (item.priceSource || "unconfigured")
              }, item.priceSource === "official"
                ? tt("stats.billingDeepseek")
                : item.priceSource === "custom"
                  ? tt("stats.billingCustom")
                  : item.priceSource === "estimated"
                    ? tt("stats.billingEstimated")
                    : tt("stats.billingUnpriced"))
            ))
        ),
        e("label", { className: "dma-billing-field" },
          e("span", { className: "dma-billing-label" }, tt("stats.billingOverrides")),
          e("textarea", {
            className: "dma-billing-input",
            rows: 3,
            spellCheck: false,
            value: overridesText,
            placeholder: "ninfer-27b=always",
            onChange: (event) => setOverridesText(event.target.value)
          }),
          e("span", { className: "dma-stats-note" }, tt("stats.billingOverridesHint"))
        ),
        e("label", { className: "dma-billing-field" },
          e("span", { className: "dma-billing-label" }, tt("stats.billingPrices")),
          e("textarea", {
            className: "dma-billing-input dma-billing-json",
            rows: 8,
            spellCheck: false,
            value: pricesText,
            onChange: (event) => setPricesText(event.target.value)
          }),
          e("span", { className: "dma-stats-note" }, tt("stats.billingPricesHint"))
        ),
        e("div", { className: "dma-billing-actions" },
          e("button", {
            type: "button",
            className: "dma-billing-save",
            disabled: busy,
            onClick: save
          }, busy ? tt("stats.billingSaving") : tt("stats.billingSave")),
          message ? e("span", { className: "dma-billing-ok" }, message) : null,
          error ? e("span", { className: "dma-billing-error" }, error) : null
        )
      );
    }

    function StatsPanel({ onClose }) {
      const tt = t;
      const [state, setState] = React.useState({ status: "loading", data: null, error: "" });
      const [range, setRange] = React.useState("hour");
      const [budgetText, setBudgetText] = React.useState("");
      const [budgetEditing, setBudgetEditing] = React.useState(false);
      const [budgetBusy, setBudgetBusy] = React.useState(false);
      const [budgetError, setBudgetError] = React.useState("");
      const alive = React.useRef(true);
      const budgetInit = React.useRef(false);

      const load = React.useCallback(async () => {
        try {
          const res = await getJson(STATS_ROUTE);
          if (!alive.current) return;
          if (res.status === 200 && res.data && res.data.ok) {
            setState({ status: "ready", data: res.data.value, error: "" });
            return;
          }
          const message = res.data && res.data.error && res.data.error.message
            ? String(res.data.error.message)
            : tt("stats.error");
          setState((prev) => ({ status: prev.data ? "stale" : "error", data: prev.data, error: message }));
        } catch (err) {
          if (!alive.current) return;
          setState((prev) => ({
            status: prev.data ? "stale" : "error",
            data: prev.data,
            error: err instanceof Error ? err.message : tt("stats.error")
          }));
        }
      }, [tt]);

      React.useEffect(() => {
        alive.current = true;
        load();
        const timer = setInterval(() => {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          load();
        }, STATS_POLL_MS);
        const onVisibility = () => {
          if (typeof document !== "undefined" && document.visibilityState === "visible") load();
        };
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
        return () => {
          alive.current = false;
          clearInterval(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
        };
      }, [load]);

      React.useEffect(() => {
        const data = state.data;
        if (budgetInit.current || !data || !data.budget) return;
        budgetInit.current = true;
        setBudgetText(formatCents(data.budget.amountCents));
      }, [state.data]);

      useOverlayKeys({ active: true, primaryEnabled: false, busy: budgetBusy, onDismiss: onClose, onPrimary: () => {} });

      const data = state.data;
      const loading = state.status === "loading";
      const totals = data ? data.totals : null;
      const budget = data ? data.budget : null;
      const ledger = data ? data.ledger : null;
      const ratio = budget && budget.enabled ? budget.ratio * 100 : 0;
      const over = budget && budget.enabled && budget.remainingCents === 0 && budget.spentCents > 0;
      const cacheShare = totals && totals.tokens.total > 0
        ? statsShare(totals.tokens.cacheRead, totals.tokens.total)
        : 0;
      const kpi = [
        {
          label: tt("stats.totalTokens"),
          value: totals ? formatTokens(totals.tokens.total) : "—",
          sub: totals ? tt("stats.cacheShare") + " " + statsPct(cacheShare) : ""
        },
        {
          label: tt("stats.sessions"),
          value: totals ? String(totals.sessions) : "—",
          sub: totals ? tt("stats.runningNow") + " " + totals.running : ""
        },
        {
          label: tt("stats.estCost"),
          value: totals ? formatCostMicros(totals.costMicros) : "—",
          sub: tt("stats.priceHint")
        }
      ];
      const statsCard = (item) => e("div", { key: item.label, className: "dma-stats-card" },
        e("span", { className: "dma-stats-card-label" }, item.label),
        e("span", { className: "dma-stats-card-value", title: item.value }, item.value),
        e("span", { className: "dma-stats-card-sub" }, item.sub)
      );

      async function saveBudget() {
        if (budgetBusy) return;
        const check = validateCorrectionAmount(budgetText);
        if (!check.ok) {
          setBudgetError(tt("stats.budgetInvalid"));
          return;
        }
        setBudgetBusy(true);
        setBudgetError("");
        try {
          const res = await postJson(STATS_BUDGET_ROUTE, { budgetYuan: String(budgetText).trim() });
          if (res.status === 200 && res.data && res.data.ok) {
            setBudgetText(formatCents(res.data.value.budgetCents));
            if (alive.current) setBudgetEditing(false);
            await load();
          } else {
            setBudgetError(tt("stats.budgetFailed"));
          }
        } catch {
          setBudgetError(tt("stats.budgetFailed"));
        } finally {
          if (alive.current) setBudgetBusy(false);
        }
      }

      /** 取消就地编辑：丢掉未保存的输入，恢复为当前预算金额。 */
      function cancelBudget() {
        setBudgetEditing(false);
        setBudgetError("");
        if (data && data.budget) setBudgetText(formatCents(data.budget.amountCents));
      }

      const openBudgetEdit = () => {
        setBudgetError("");
        setBudgetEditing(true);
      };

      const budgetProgress = budget && budget.enabled
        ? e("div", { className: "dma-stats-progress", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.min(100, Math.round(ratio)) },
          e("i", { style: { width: statsPct(ratio) } }))
        : null;

      // 第一行第三张：预算卡（金额 + 剩余/已用 + 进度条）；「修改预算」小按钮与金额同一行，
      // 点金额仍可直接编辑（隐藏路径保留）。
      const budgetCardNode = e("div", { className: "dma-stats-card dma-stats-money-card" },
        e("span", { className: "dma-stats-card-label" }, tt("stats.moneyBudget")),
        budgetEditing
          ? e("div", { className: "dma-stats-money-edit-row" },
            e("span", { className: "dma-stats-money-input" },
              "¥",
              e("input", {
                id: "dma-stats-budget-input",
                type: "text",
                inputMode: "decimal",
                value: budgetText,
                disabled: budgetBusy,
                autoFocus: true,
                "aria-label": tt("stats.budgetEdit"),
                onChange: (ev) => {
                  setBudgetText(ev.target.value);
                  if (budgetError) setBudgetError("");
                },
                onKeyDown: (ev) => {
                  if (ev.key === "Enter") saveBudget();
                  else if (ev.key === "Escape") {
                    ev.stopPropagation();
                    cancelBudget();
                  }
                }
              }),
              tt("stats.budgetUnit")
            ),
            e("button", {
              type: "button",
              className: "dma-stats-money-mini",
              disabled: budgetBusy,
              onClick: saveBudget
            }, budgetBusy ? tt("stats.budgetSaving") : tt("stats.budgetSave")),
            e("button", {
              type: "button",
              className: "dma-stats-money-cancel",
              disabled: budgetBusy,
              onClick: cancelBudget
            }, tt("stats.budgetCancel"))
          )
          : e("div", { className: "dma-stats-money-value-row" },
            e("button", {
              type: "button",
              className: "dma-stats-card-value dma-stats-money-edit",
              title: tt("stats.moneyEdit"),
              "aria-label": tt("stats.moneyEdit"),
              onClick: openBudgetEdit
            }, budget ? formatYuanCents(budget.amountCents) : "—"),
            e("button", {
              type: "button",
              className: "dma-stats-money-mini",
              title: tt("stats.moneyEdit"),
              "aria-label": tt("stats.moneyEdit"),
              onClick: openBudgetEdit
            }, tt("stats.moneyEdit"))
          ),
        e("span", { className: "dma-stats-card-sub" },
          budget && budget.enabled
            ? (over
              ? tt("stats.overBudget")
              : tt("stats.budgetLeft") + " " + formatYuanCents(budget.remainingCents) + " · "
                + tt("stats.budgetUsed") + " " + statsPct(ratio))
            : tt("stats.budgetOffSub")),
        budgetEditing
          ? e("span", { className: "dma-stats-money-hint" }, budgetError || tt("stats.budgetHint"))
          : null,
        budgetProgress
      );

      // 第一行第四张：预算使用（比例 + 剩余 / 额度 + 进度条）。
      const budgetUsageCardNode = e("div", { className: "dma-stats-card" },
        e("span", { className: "dma-stats-card-label" }, tt("stats.budget")),
        e("span", { className: "dma-stats-card-value", title: budget && budget.enabled ? statsRatioText(ratio) : tt("stats.budgetOff") },
          budget && budget.enabled ? statsRatioText(ratio) : tt("stats.budgetOff")),
        e("span", { className: "dma-stats-card-sub" },
          budget && budget.enabled
            ? (over
              ? tt("stats.overBudget") + " · " + formatYuanCents(budget.amountCents)
              : tt("stats.budgetLeft") + " " + formatYuanCents(budget.remainingCents) + tt("stats.of") + formatYuanCents(budget.amountCents))
            : tt("stats.budgetOffSub")),
        budgetProgress
      );

      return e("div", {
        className: "dma-overlay",
        onClick: (ev) => {
          if (ev.target === ev.currentTarget) onClose();
        }
      },
      e("div", {
        className: "dma-panel dma-stats-panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": tt("stats.panelTitle")
      },
        e("div", { className: "dma-panel-head dma-stats-head" },
          e("span", { className: "dma-stats-title" }, tt("stats.panelTitle")),
          e("span", { className: "dma-stats-live" },
            e("i", { className: "dma-stats-dot" }),
            state.status === "ready" ? tt("stats.live") : state.status === "stale" ? tt("stats.stale") : tt("stats.loading")),
          e("button", {
            type: "button",
            className: "dma-stats-icon",
            title: tt("stats.refresh"),
            "aria-label": tt("stats.refresh"),
            disabled: loading || budgetBusy,
            onClick: () => load()
          }, e("span", { className: "dma-stats-ico", dangerouslySetInnerHTML: { __html: REFRESH_ICON } })),
          e("button", {
            type: "button",
            autoFocus: true,
            className: "dma-stats-icon",
            title: tt("stats.close"),
            "aria-label": tt("stats.close"),
            onClick: onClose
          }, "×")
        ),
        e("div", { className: "dma-panel-body dma-stats-body" },
          e("p", { className: "dma-stats-intro" }, tt("stats.intro")),
          state.status === "error"
            ? e("p", { className: "dma-stats-error" }, tt("stats.error") + "：" + state.error)
            : null,
          state.status === "stale"
            ? e("p", { className: "dma-stats-error" }, tt("stats.stale") + "：" + state.error)
            : null,
          !loading && data && data.available === false
            ? e("p", { className: "dma-stats-error" }, tt("stats.unavailable"))
            : null,
          loading
            ? e("p", { className: "dma-stats-empty" }, tt("stats.loading"))
            : e("div", { className: "dma-stats-kpis" },
              kpi.slice(0, 2).map(statsCard),
              // 第一行：总 Token → 会话数量 → 预算 → 预算使用。
              budgetCardNode,
              budgetUsageCardNode
            ),
          !loading && data
            ? e("div", { className: "dma-stats-kpis dma-stats-money" },
              // 第二行：余额 → 日用 → 单次 → 估算成本。
              ledger
                ? e("div", { className: "dma-stats-card" },
                  e("span", { className: "dma-stats-card-label" }, tt("cost.balance")),
                  e("span", { className: "dma-stats-card-value" },
                    Number.isFinite(ledger.balanceCents) ? formatYuanCents(ledger.balanceCents) : "—"),
                  e("span", { className: "dma-stats-card-sub" }, tt("stats.moneyBalanceSub"))
                )
                : null,
              ledger
                ? e("div", { className: "dma-stats-card" },
                  e("span", { className: "dma-stats-card-label" }, tt("cost.daily")),
                  e("span", { className: "dma-stats-card-value" }, formatYuanCents(ledger.dailyCents || 0)),
                  e("span", { className: "dma-stats-card-sub" }, tt("stats.moneyDailySub"))
                )
                : null,
              ledger
                ? e("div", { className: "dma-stats-card" },
                  e("span", { className: "dma-stats-card-label" }, tt("cost.perTurn")),
                  e("span", { className: "dma-stats-card-value" },
                    Number.isFinite(ledger.lastTurnMicros) ? formatCostMicros(ledger.lastTurnMicros) : "—"),
                  e("span", { className: "dma-stats-card-sub" }, tt("stats.moneyTurnSub"))
                )
                : null,
              statsCard(kpi[2])
            )
            : null,
          !loading && data
            ? e("p", { className: "dma-stats-note" }, tt("stats.budgetNote"))
            : null,
          !loading && data
            ? e("p", { className: "dma-stats-note" }, tt("stats.billingNote"))
            : null,
          !loading && data
            ? e(StatsTimeline, { t: tt, series: data.series, range, onRange: setRange })
            : null,
          !loading && data
            ? e(StatsSessionRows, {
              t: tt,
              rows: data.sessions || [],
              truncated: data.truncated === true,
              total: data.sessionsTotal || 0
            })
            : null,
          !loading && data && data.billing
            ? e(BillingSection, {
              key: "billing-" + ((data.billing && data.billing.revision) || 0),
              t: tt,
              billing: data.billing,
              onReload: () => load()
            })
            : null,
          !loading && data && data.ledger
            ? e("p", { className: "dma-stats-note" }, tt("stats.ledger", {
              daily: formatYuanCents(data.ledger.dailyCents || 0),
              observed: formatYuanCents(data.ledger.observedSpendCents || 0)
            }))
            : null
        )
      )
      );
    }

    // 设置导航图标（settings.section.icon 槽位）。
    // 宿主外壳只给内置 section id 配图标，第三方 section 默认落到齿轮；
    // 用与 icon.svg 同构的「气泡 + 滑块」线稿补上，颜色跟随宿主 currentColor。
    function SettingsNavIcon({ size }) {
      const s = Number(size) > 0 ? Number(size) : 16;
      return e("svg", {
        width: s,
        height: s,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.7,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false"
      },
        e("path", {
          d: "M4 6.5A3.5 3.5 0 0 1 7.5 3h9A3.5 3.5 0 0 1 20 6.5v6a3.5 3.5 0 0 1-3.5 3.5H11l-4.2 3.4V16H7.5A3.5 3.5 0 0 1 4 12.5z"
        }),
        e("path", { d: "M8 8h8M8 12h8" }),
        e("circle", { cx: 10.5, cy: 8, r: 1.35, fill: "currentColor", stroke: "none" }),
        e("circle", { cx: 13.5, cy: 12, r: 1.35, fill: "currentColor", stroke: "none" })
      );
    }

    // 设置页（settings.section 槽位）
    // 「完成提示音」不再有独立开关行：音色选「关闭」即关闭（见 SoundToneRow）。
    const SETTING_FIELDS = [
      ["recall", "settings.recall", "settings.recallDesc"],
      ["share", "settings.share", "settings.shareDesc"],
      ["export", "settings.export", "settings.exportDesc"],
      ["delete", "settings.delete", "settings.deleteDesc"],
      ["deleteFrom", "settings.deleteFrom", "settings.deleteFromDesc"],
      ["confirm", "settings.confirm", "settings.confirmDesc"],
      ["stats", "settings.stats", "settings.statsDesc"]
    ];

    function SettingRow({ t: tt, labelKey, descKey, on, disabled, onToggle }) {
      return e("div", { className: "dma-setting-row" },
        e("div", { className: "dma-setting-text" },
          e("div", { className: "dma-setting-label" }, tt(labelKey)),
          e("div", { className: "dma-setting-desc" }, tt(descKey))
        ),
        e("button", {
          type: "button",
          role: "switch",
          className: "dma-switch",
          "aria-checked": on ? "true" : "false",
          "aria-label": tt(labelKey),
          disabled: !!disabled,
          onClick: onToggle
        }, e("span", { className: "dma-switch-thumb" }))
      );
    }

    function NumberRow({ t: tt, labelKey, descKey, value, disabled, onCommit }) {
      const fallback = Number.isFinite(value) ? Math.round(value) : 0;
      const [text, setText] = React.useState(String(fallback));
      React.useEffect(() => {
        setText(String(fallback));
      }, [fallback]);
      const commit = () => {
        const raw = String(text).trim();
        if (raw === "") {
          setText("0");
          onCommit(0);
          return;
        }
        const num = Number(raw);
        if (!Number.isFinite(num)) {
          setText(String(fallback));
          return;
        }
        const clamped = Math.min(600, Math.max(0, Math.round(num)));
        setText(String(clamped));
        if (clamped !== fallback) onCommit(clamped);
      };
      return e("div", { className: "dma-setting-row" },
        e("div", { className: "dma-setting-text" },
          e("div", { className: "dma-setting-label" }, tt(labelKey)),
          e("div", { className: "dma-setting-desc" }, tt(descKey))
        ),
        e("input", {
          type: "number",
          className: "dma-number",
          min: 0,
          max: 600,
          step: 1,
          value: text,
          disabled: !!disabled,
          "aria-label": tt(labelKey),
          onChange: (ev) => setText(ev.target.value),
          onBlur: commit,
          onKeyDown: (ev) => {
            if (ev.key === "Enter") ev.currentTarget.blur();
          }
        })
      );
    }

    function LayoutRow({ t: tt, value, disabled, onPick }) {
      const current = normalizeCostLayout(value);
      return e("div", { className: "dma-setting-row" },
        e("div", { className: "dma-setting-text" },
          e("div", { className: "dma-setting-label" }, tt("cost.settings.layout")),
          e("div", { className: "dma-setting-desc" }, tt("cost.settings.layoutDesc"))
        ),
        e("div", { className: "dma-seg", role: "group", "aria-label": tt("cost.settings.layout") },
          COST_LAYOUTS.map((id) => e("button", {
            key: id,
            type: "button",
            className: "dma-seg-btn",
            "aria-pressed": current === id ? "true" : "false",
            disabled,
            onClick: () => onPick(id)
          }, tt("cost.layout." + id)))
        )
      );
    }

    function SoundToneRow({ t: tt, value, onPick }) {
      const current = completionSoundTone(value || {});
      return e("div", { className: "dma-setting-row" },
        e("div", { className: "dma-setting-text" },
          e("div", { className: "dma-setting-label" }, tt("settings.soundTone")),
          e("div", { className: "dma-setting-desc" }, tt("settings.soundToneDesc"))
        ),
        e("div", { className: "dma-seg", role: "group", "aria-label": tt("settings.soundTone") },
          soundToneOptions().map((id) => e("button", {
            key: id,
            type: "button",
            className: "dma-seg-btn",
            "aria-pressed": current === id ? "true" : "false",
            onClick: () => onPick(id)
          }, tt("settings.soundTone." + id)))
        )
      );
    }

    function VolumeRow({ t: tt, value, disabled, onCommit }) {
      const committed = clampSoundVolume(value);
      const [draft, setDraft] = React.useState(committed);
      const draftRef = React.useRef(committed);
      const committedRef = React.useRef(committed);
      const dragging = React.useRef(false);
      const timer = React.useRef(null);
      const inputRef = React.useRef(null);
      const commitRef = React.useRef(() => {});

      // 外部配置变化时才回写本地值；拖动中或防抖未落盘时不覆盖，保证数字跟手。
      React.useEffect(() => {
        committedRef.current = committed;
        if (!dragging.current && !timer.current) {
          draftRef.current = committed;
          setDraft(committed);
        }
      }, [committed]);

      React.useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
      }, []);

      // 拖动过程只更新本地显示，不写宿主配置、不重拉设置快照。
      const update = (raw) => {
        const next = clampSoundVolume(raw);
        draftRef.current = next;
        setDraft(next);
      };

      // 松手 / 键盘抬起 / 失焦合并成一次提交：120ms 防抖后写入并试听一次。
      const commit = () => {
        dragging.current = false;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          const next = draftRef.current;
          if (next === committedRef.current) return;
          committedRef.current = next;
          onCommit(next);
        }, 120);
      };
      commitRef.current = commit;

      // 原生 change 在拖动结束时才触发（React 的 onChange 实际是 input 事件），
      // 兜住指针在滑杆外松开、或浏览器不做隐式指针捕获的情况。
      React.useEffect(() => {
        const el = inputRef.current;
        if (!el || typeof el.addEventListener !== "function") return undefined;
        const onChangeEnd = () => commitRef.current();
        el.addEventListener("change", onChangeEnd);
        return () => el.removeEventListener("change", onChangeEnd);
      }, []);

      return e("div", { className: "dma-setting-row" },
        e("div", { className: "dma-setting-text" },
          e("div", { className: "dma-setting-label" }, tt("settings.soundVolume")),
          e("div", { className: "dma-setting-desc" }, tt("settings.soundVolumeDesc"))
        ),
        e("div", { className: "dma-volume" },
          e("input", {
            ref: inputRef,
            type: "range",
            className: "dma-volume-range",
            min: 0,
            max: 100,
            step: 5,
            value: draft,
            disabled: !!disabled,
            "aria-label": tt("settings.soundVolume"),
            onChange: (ev) => {
              dragging.current = true;
              update(ev.target.value);
            },
            onPointerDown: () => {
              dragging.current = true;
            },
            onPointerUp: commit,
            onPointerCancel: commit,
            onKeyUp: commit,
            onBlur: commit
          }),
          e("span", { className: "dma-volume-value" }, draft + "%")
        )
      );
    }

    function BillingTab({ t: tt, form, value, save }) {
      const enabled = value ? value.usageStats !== false : true;
      const onToggle = (key, on) => () => save(key, !on);
      return e("div", { className: "dma-billing" },
        e(SettingRow, {
          t: tt,
          labelKey: "cost.settings.usageStats",
          descKey: "cost.settings.usageStatsDesc",
          on: enabled,
          onToggle: onToggle("usageStats", enabled)
        }),
        e(LayoutRow, {
          t: tt,
          value: value && typeof value.costLayout === "string" ? value.costLayout : DEFAULT_COST_LAYOUT,
          disabled: !enabled,
          onPick: (id) => save("costLayout", id)
        }),
        e(SettingRow, {
          t: tt,
          labelKey: "cost.settings.perTurn",
          descKey: "cost.settings.perTurnDesc",
          on: value ? value.costPerTurn !== false : true,
          disabled: !enabled,
          onToggle: enabled ? onToggle("costPerTurn", value ? value.costPerTurn !== false : true) : null
        }),
        e(NumberRow, {
          t: tt,
          labelKey: "cost.settings.autoClose",
          descKey: "cost.settings.autoCloseDesc",
          value: value && Number.isFinite(value.costPerTurnAutoClose) ? value.costPerTurnAutoClose : 0,
          disabled: !enabled,
          onCommit: (seconds) => save("costPerTurnAutoClose", seconds)
        }),
        e(SettingRow, {
          t: tt,
          labelKey: "cost.settings.peakValley",
          descKey: "cost.settings.peakValleyDesc",
          on: value ? value.costPeakValley !== false : true,
          disabled: !enabled,
          onToggle: enabled ? onToggle("costPeakValley", value ? value.costPeakValley !== false : true) : null
        }),
        e("div", { className: "dma-setting-row" },
          e("div", { className: "dma-setting-text" },
            e("div", { className: "dma-setting-label" }, tt("cost.settings.statsTable")),
            e("div", { className: "dma-setting-desc" }, tt("cost.settings.statsTableDesc"))
          ),
          e("button", {
            type: "button",
            className: "dma-setting-primary dma-setting-btn",
            onClick: (ev) => openStatsPanel(ev.currentTarget)
          }, tt("cost.settings.statsTableButton"))
        ),
        e("p", { className: "dma-cost-note" }, tt("cost.balanceNote"))
      );
    }

    // -------------------------------------------------------------------------
    // 对话管理：删除到回收站 / 恢复 / 彻底清理 / 移动到工作区
    // -------------------------------------------------------------------------

    const SESSIONS_ROUTE = "/dsh-message-actions/sessions";
    const SESSIONS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M4 6.5h16v9.5H9.5L4 19z"/><path d="M8 10h8M8 12.8h5"/></svg>';

    let sessionsHost = null;
    let sessionsOpener = null;
    const sessionsStore = createStore({ open: false, seq: 0 });

    function openSessionsPanel(opener) {
      if (typeof document === "undefined" || !document.body) return;
      if (!ReactDOMClient || typeof ReactDOMClient.createRoot !== "function") return;
      sessionsOpener = opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      if (!sessionsHost) {
        sessionsHost = document.createElement("div");
        sessionsHost.className = "dma-sessions-root";
        document.body.appendChild(sessionsHost);
        ReactDOMClient.createRoot(sessionsHost).render(e(SessionsOverlay));
      }
      const snapshot = sessionsStore.getSnapshot();
      sessionsStore.set({ open: true, seq: snapshot.seq + 1 });
    }

    function closeSessionsPanel() {
      const snapshot = sessionsStore.getSnapshot();
      if (!snapshot.open) return;
      sessionsStore.set({ open: false, seq: snapshot.seq + 1 });
      const opener = sessionsOpener;
      sessionsOpener = null;
      if (opener && typeof opener.focus === "function" && opener.isConnected) {
        try {
          opener.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
    }

    function SessionsOverlay() {
      const snapshot = React.useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot, sessionsStore.getSnapshot);
      if (!snapshot.open) return null;
      return e(SessionsPanel, { key: snapshot.seq, onClose: closeSessionsPanel });
    }

    /** 兼容 ISO 字符串与毫秒时间戳。 */
    function sessionTime(value) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value !== "") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return 0;
    }

    function sessionClock(value) {
      const ts = sessionTime(value);
      return ts > 0 ? statsClock(ts) : "—";
    }

    function sessionSize(bytes) {
      const n = Number(bytes);
      if (!Number.isFinite(n) || n <= 0) return "—";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (Math.round((n / 1024) * 10) / 10) + " KB";
      return (Math.round((n / (1024 * 1024)) * 10) / 10) + " MB";
    }

    /** 服务端错误码 → 当前语言的文案；未知码原样返回。 */
    function sessionErrorText(code) {
      if (!code) return t("sessions.actionFailed");
      const dict = ERROR_LABELS[detectLang()] || ERROR_LABELS.zh;
      return dict[code] || code;
    }

    function sessionFailure(results) {
      for (const item of Array.isArray(results) ? results : []) {
        if (item && item.ok === false) return sessionErrorText(item.error);
      }
      return "";
    }

    async function fetchSessions() {
      const res = await getJson(SESSIONS_ROUTE);
      const payload = res.data;
      if (res.status !== 200 || !payload || payload.ok !== true || !payload.value) {
        throw new Error(sessionErrorText(payload && payload.error) || ("HTTP " + res.status));
      }
      return payload.value;
    }

    async function postSessionAction(body) {
      const res = await postJson(SESSIONS_ROUTE, body);
      const payload = res.data;
      if (res.status !== 200 || !payload || payload.ok !== true) {
        throw new Error(sessionErrorText(payload && payload.error) || ("HTTP " + res.status));
      }
      return payload.value;
    }

    function SessionsPanel({ onClose }) {
      const tt = t;
      const [tab, setTab] = React.useState("list");
      const [version, setVersion] = React.useState(0);
      const [snapshot, setSnapshot] = React.useState({ status: "loading", data: null, error: "" });
      const [query, setQuery] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [dialog, setDialog] = React.useState(null);
      const [target, setTarget] = React.useState("");
      const [actionError, setActionError] = React.useState("");
      const [hint, setHint] = React.useState("");
      const panelRef = React.useRef(null);

      React.useEffect(() => {
        let cancelled = false;
        setSnapshot((prev) => ({ status: prev.data ? "stale" : "loading", data: prev.data, error: "" }));
        (async () => {
          try {
            const value = await fetchSessions();
            if (!cancelled) setSnapshot({ status: "ready", data: value, error: "" });
          } catch (err) {
            if (!cancelled) {
              setSnapshot((prev) => ({
                status: "error",
                data: prev.data,
                error: err && err.message ? err.message : String(err)
              }));
            }
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [version]);

      React.useEffect(() => {
        function onKey(event) {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (dialog) {
            setDialog(null);
            setActionError("");
          } else {
            onClose();
          }
        }
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
      }, [dialog, onClose]);

      const data = snapshot.data;
      const rows = data && Array.isArray(data.sessions) ? data.sessions : [];
      const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : [];
      const trash = data && data.trash && Array.isArray(data.trash.entries) ? data.trash.entries : [];
      const trashCount = data && data.trash && Number.isFinite(data.trash.count) ? data.trash.count : trash.length;
      const available = !data || data.available !== false;
      const loading = snapshot.status === "loading";
      const stale = snapshot.status === "stale";

      const filtered = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle === "") return rows;
        return rows.filter((row) => {
          const haystack = [row.title, row.cwd, row.workspaceTitle].join("\n").toLowerCase();
          return haystack.includes(needle);
        });
      }, [rows, query]);

      const groups = React.useMemo(() => {
        const byId = new Map();
        for (const ws of workspaces) {
          byId.set(ws.id, { id: ws.id, title: ws.title, path: ws.path, rows: [] });
        }
        const others = { id: "", title: "", path: "", rows: [] };
        for (const row of filtered) {
          const group = row.workspaceId && byId.get(row.workspaceId) ? byId.get(row.workspaceId) : others;
          group.rows.push(row);
        }
        const out = [];
        for (const ws of workspaces) {
          const group = byId.get(ws.id);
          if (group && group.rows.length > 0) out.push(group);
        }
        if (others.rows.length > 0) out.push(others);
        return out;
      }, [filtered, workspaces]);

      function rowTitle(row) {
        return row.title || tt("sessions.untitled");
      }

      function reload() {
        setVersion((value) => value + 1);
      }

      async function doDelete(row) {
        setBusy(row.id);
        setActionError("");
        try {
          const value = await postSessionAction({ action: "delete", sessionIds: [row.id] });
          const error = sessionFailure(value && value.results);
          if (error) throw new Error(error);
          setDialog(null);
          showToast(tt("sessions.doneDelete"));
          reload();
        } catch (err) {
          setActionError(err && err.message ? err.message : tt("sessions.actionFailed"));
        } finally {
          setBusy("");
        }
      }

      async function doMove(row, workspaceId) {
        if (!workspaceId) {
          setActionError(tt("sessions.noTargets"));
          return;
        }
        setBusy(row.id);
        setActionError("");
        try {
          const value = await postSessionAction({ action: "move", sessionId: row.id, workspaceId });
          if (!value || value.ok !== true) throw new Error(sessionErrorText(value && value.error));
          const ws = workspaces.find((item) => item.id === workspaceId);
          const name = value.workspaceTitle || (ws ? ws.title || ws.path : "");
          setDialog(null);
          showToast(tt("sessions.doneMove", { workspace: name }));
          if (value.restartRequired) setHint(tt("sessions.restartHint"));
          reload();
        } catch (err) {
          setActionError(err && err.message ? err.message : tt("sessions.actionFailed"));
        } finally {
          setBusy("");
        }
      }

      async function doRestore(entry) {
        setBusy(entry.trashId);
        setActionError("");
        try {
          const value = await postSessionAction({ action: "restore", trashIds: [entry.trashId] });
          const error = sessionFailure(value && value.results);
          if (error) throw new Error(error);
          const result = value && value.results ? value.results[0] : null;
          if (result && result.restartRequired) setHint(tt("sessions.restartHint"));
          showToast(tt("sessions.doneRestore"));
          reload();
        } catch (err) {
          setActionError(err && err.message ? err.message : tt("sessions.actionFailed"));
        } finally {
          setBusy("");
        }
      }

      async function doPurge(entry) {
        setBusy(entry.trashId);
        setActionError("");
        try {
          const value = await postSessionAction({ action: "purge", confirm: true, trashIds: [entry.trashId] });
          const error = sessionFailure(value && value.results);
          if (error) throw new Error(error);
          setDialog(null);
          showToast(tt("sessions.donePurge"));
          reload();
        } catch (err) {
          setActionError(err && err.message ? err.message : tt("sessions.actionFailed"));
        } finally {
          setBusy("");
        }
      }

      async function doPurgeAll() {
        setBusy("all");
        setActionError("");
        try {
          const value = await postSessionAction({ action: "purge", all: true, confirm: "PURGE_ALL" });
          const error = sessionFailure(value && value.results);
          if (error) throw new Error(error);
          setDialog(null);
          showToast(tt("sessions.donePurge"));
          reload();
        } catch (err) {
          setActionError(err && err.message ? err.message : tt("sessions.actionFailed"));
        } finally {
          setBusy("");
        }
      }

      function openMove(row) {
        const targets = workspaces.filter((ws) => ws.id !== row.workspaceId);
        setTarget(targets.length > 0 ? targets[0].id : "");
        setActionError("");
        setDialog({ kind: "move", row });
      }

      function confirmDialog() {
        if (!dialog) return;
        if (dialog.kind === "delete") doDelete(dialog.row);
        else if (dialog.kind === "purge") doPurge(dialog.entry);
        else if (dialog.kind === "purgeAll") doPurgeAll();
      }

      function renderBadges(row) {
        const badges = [];
        if (row.live) badges.push(e("span", { key: "live", className: "dma-session-badge dma-session-badge-live" }, tt("sessions.live")));
        if (row.running) badges.push(e("span", { key: "running", className: "dma-session-badge dma-session-badge-run" }, tt("sessions.running")));
        if (row.archived) badges.push(e("span", { key: "archived", className: "dma-session-badge" }, tt("sessions.archived")));
        if (row.child) badges.push(e("span", { key: "child", className: "dma-session-badge" }, tt("sessions.child")));
        return badges.length > 0 ? badges : null;
      }

      function renderSessionRow(row) {
        const locked = row.live || row.running;
        const lockedTitle = locked ? tt("sessions.liveHint") : undefined;
        return e("div", { key: row.id, className: "dma-session-row" },
          e("div", { className: "dma-session-main" },
            e("div", { className: "dma-session-title-line" },
              e("span", { className: "dma-session-title", title: rowTitle(row) }, rowTitle(row)),
              renderBadges(row)
            ),
            e("div", { className: "dma-session-meta" },
              e("span", null, sessionClock(row.createdAt)),
              row.cwd ? e("span", { className: "dma-session-path", title: row.cwd }, row.cwd) : null
            )
          ),
          e("div", { className: "dma-session-actions" },
            e("button", {
              type: "button",
              className: "dma-btn dma-session-act",
              title: lockedTitle || (data && data.canMove === false ? tt("sessions.unavailable") : tt("sessions.move")),
              disabled: locked || busy !== "" || !data || data.canMove === false || workspaces.length < 2,
              onClick: () => openMove(row)
            }, tt("sessions.move")),
            e("button", {
              type: "button",
              className: "dma-btn dma-session-act dma-session-danger",
              title: lockedTitle || tt("sessions.deleteHint"),
              disabled: locked || busy !== "",
              onClick: () => {
                setActionError("");
                setDialog({ kind: "delete", row });
              }
            }, tt("sessions.delete"))
          )
        );
      }

      function renderGroup(group) {
        const title = group.id === "" ? tt("sessions.otherWorkspace") : (group.title || group.path || tt("sessions.otherWorkspace"));
        return e("section", { key: group.id || "others", className: "dma-sessions-group" },
          e("div", { className: "dma-sessions-group-head" },
            e("span", { className: "dma-sessions-group-title", title }, title),
            group.path ? e("span", { className: "dma-sessions-group-path", title: group.path }, group.path) : null,
            e("span", { className: "dma-sessions-group-count" }, String(group.rows.length))
          ),
          group.rows.map(renderSessionRow)
        );
      }

      function renderTrashRow(entry) {
        const title = entry.title || tt("sessions.untitled");
        const running = busy === entry.trashId;
        return e("div", { key: entry.trashId, className: "dma-session-row" + (entry.missing ? " dma-session-row-missing" : "") },
          e("div", { className: "dma-session-main" },
            e("div", { className: "dma-session-title-line" },
              e("span", { className: "dma-session-title", title }, title),
              entry.missing ? e("span", { className: "dma-session-badge dma-session-badge-warn" }, tt("sessions.missing")) : null
            ),
            e("div", { className: "dma-session-meta" },
              e("span", null, tt("sessions.deletedAt", { time: sessionClock(entry.deletedAt) })),
              entry.workspaceTitle ? e("span", { className: "dma-session-path", title: entry.workspaceTitle }, entry.workspaceTitle) : null,
              e("span", null, sessionSize(entry.sizeBytes))
            )
          ),
          e("div", { className: "dma-session-actions" },
            e("button", {
              type: "button",
              className: "dma-btn dma-session-act",
              disabled: running || busy !== "" || entry.missing,
              title: entry.missing ? tt("sessions.missing") : tt("sessions.restore"),
              onClick: () => doRestore(entry)
            }, tt("sessions.restore")),
            e("button", {
              type: "button",
              className: "dma-btn dma-session-act dma-session-danger",
              disabled: running || busy !== "",
              title: tt("sessions.purgeHint"),
              onClick: () => {
                setActionError("");
                setDialog({ kind: "purge", entry });
              }
            }, tt("sessions.purge"))
          )
        );
      }

      function renderDialog() {
        if (!dialog) return null;
        let title = "";
        let desc = "";
        let confirmLabel = "";
        let danger = false;
        let toolbar = null;
        if (dialog.kind === "delete") {
          title = tt("sessions.deleteTitle");
          desc = tt("sessions.deleteDesc", { title: rowTitle(dialog.row) });
          confirmLabel = tt("sessions.deleteConfirm");
        } else if (dialog.kind === "move") {
          const targets = workspaces.filter((ws) => ws.id !== dialog.row.workspaceId);
          const value = target || (targets.length > 0 ? targets[0].id : "");
          title = tt("sessions.moveTitle");
          desc = tt("sessions.moveDesc", { title: rowTitle(dialog.row) });
          confirmLabel = tt("sessions.moveConfirm");
          toolbar = targets.length === 0
            ? e("p", { className: "dma-session-warn" }, tt("sessions.noTargets"))
            : e("div", { className: "dma-session-field" },
              e("label", { className: "dma-session-field-label", htmlFor: "dma-session-target" }, tt("sessions.targetWorkspace")),
              e("select", {
                id: "dma-session-target",
                className: "dma-session-select",
                value,
                onChange: (ev) => setTarget(ev.target.value)
              }, targets.map((ws) => e("option", { key: ws.id, value: ws.id }, ws.title || ws.path)))
            );
        } else if (dialog.kind === "purge") {
          title = tt("sessions.purgeTitle");
          desc = tt("sessions.purgeDesc", { title: dialog.entry.title || tt("sessions.untitled") });
          confirmLabel = tt("sessions.purgeConfirm");
          danger = true;
        } else if (dialog.kind === "purgeAll") {
          title = tt("sessions.purgeAllTitle");
          desc = tt("sessions.purgeAllDesc", { n: trashCount });
          confirmLabel = tt("sessions.purgeAllConfirm");
          danger = true;
        }
        const confirmDisabled = busy !== "" || (dialog.kind === "move" && workspaces.filter((ws) => ws.id !== dialog.row.workspaceId).length === 0);
        return e("div", { className: "dma-session-dialog-layer" },
          e("div", {
            className: "dma-session-dialog-backdrop",
            onClick: () => {
              setDialog(null);
              setActionError("");
            }
          }),
          e("div", { className: "dma-session-dialog", role: "alertdialog", "aria-modal": "true", "aria-label": title },
            e("h4", { className: "dma-session-dialog-title" }, title),
            e("p", { className: "dma-session-dialog-desc" }, desc),
            toolbar,
            e("p", { className: danger ? "dma-session-warn" : "dma-session-okhint" },
              danger
                ? tt("sessions.purgeHint")
                : dialog.kind === "move" ? tt("sessions.moveHint") : tt("sessions.deleteHint")),
            actionError ? e("p", { className: "dma-stats-error" }, actionError) : null,
            e("div", { className: "dma-session-dialog-actions" },
              e("button", {
                type: "button",
                className: "dma-btn",
                disabled: busy !== "",
                onClick: () => {
                  setDialog(null);
                  setActionError("");
                }
              }, tt("sessions.cancel")),
              e("button", {
                type: "button",
                className: "dma-btn " + (danger ? "dma-session-danger-solid" : "dma-primary"),
                disabled: confirmDisabled,
                onClick: () => {
                  if (dialog.kind === "move") doMove(dialog.row, target);
                  else confirmDialog();
                }
              }, busy !== "" ? tt("sessions.busy") : confirmLabel)
            )
          )
        );
      }

      return e("div", {
        className: "dma-overlay dma-sessions-overlay",
        onMouseDown: (ev) => {
          if (ev.target === ev.currentTarget) onClose();
        }
      },
        e("div", {
          className: "dma-panel dma-sessions-panel",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": tt("sessions.title"),
          ref: panelRef
        },
          e("div", { className: "dma-panel-head dma-stats-head" },
            e("span", { className: "dma-stats-title" }, tt("sessions.title")),
            e("span", { className: "dma-stats-live" },
              e("i", { className: "dma-stats-dot" }),
              loading || stale ? tt("sessions.loading") : tt("sessions.count", { n: rows.length })),
            e("button", {
              type: "button",
              className: "dma-stats-icon",
              title: tt("sessions.refresh"),
              "aria-label": tt("sessions.refresh"),
              disabled: loading || busy !== "",
              onClick: reload
            }, e("span", { className: "dma-stats-ico", dangerouslySetInnerHTML: { __html: REFRESH_ICON } })),
            e("button", {
              type: "button",
              className: "dma-stats-icon",
              title: tt("sessions.close"),
              "aria-label": tt("sessions.close"),
              onClick: onClose
            }, "×")
          ),
          e("div", { className: "dma-panel-body dma-sessions-body" },
            e("p", { className: "dma-stats-intro" }, tt("sessions.intro")),
            !available ? e("p", { className: "dma-stats-error" }, tt("sessions.unavailable")) : null,
            snapshot.status === "error" ? e("p", { className: "dma-stats-error" }, tt("sessions.loadFailed") + "：" + snapshot.error) : null,
            hint ? e("p", { className: "dma-session-hint" }, hint) : null,
            e("div", { className: "dma-sessions-tabs", role: "tablist" },
              e("button", {
                type: "button",
                role: "tab",
                "aria-selected": tab === "list" ? "true" : "false",
                className: "dma-sessions-tab" + (tab === "list" ? " dma-sessions-tab-active" : ""),
                onClick: () => setTab("list")
              }, tt("sessions.tab.list") + " · " + rows.length),
              e("button", {
                type: "button",
                role: "tab",
                "aria-selected": tab === "trash" ? "true" : "false",
                className: "dma-sessions-tab" + (tab === "trash" ? " dma-sessions-tab-active" : ""),
                onClick: () => setTab("trash")
              }, tt("sessions.tab.trash") + (trashCount > 0 ? " · " + trashCount : ""))
            ),
            tab === "list"
              ? e("div", { className: "dma-sessions-list-wrap" },
                e("div", { className: "dma-sessions-search" },
                  e("input", {
                    type: "search",
                    className: "dma-sessions-search-input",
                    value: query,
                    placeholder: tt("sessions.searchPlaceholder"),
                    "aria-label": tt("sessions.searchPlaceholder"),
                    onChange: (ev) => setQuery(ev.target.value)
                  })
                ),
                loading && rows.length === 0
                  ? e("p", { className: "dma-stats-empty" }, tt("sessions.loading"))
                  : groups.length === 0
                    ? e("p", { className: "dma-stats-empty" }, query.trim() !== "" ? tt("sessions.noMatch") : tt("sessions.empty"))
                    : groups.map(renderGroup)
              )
              : e("div", { className: "dma-sessions-list-wrap" },
                e("p", { className: "dma-sessions-note" }, tt("sessions.trashNote")),
                loading && trash.length === 0
                  ? e("p", { className: "dma-stats-empty" }, tt("sessions.loading"))
                  : trash.length === 0
                    ? e("p", { className: "dma-stats-empty" }, tt("sessions.emptyTrash"))
                    : trash.map(renderTrashRow),
                trash.length > 0
                  ? e("div", { className: "dma-sessions-foot" },
                    e("button", {
                      type: "button",
                      className: "dma-btn dma-session-danger-outline",
                      disabled: busy !== "",
                      onClick: () => {
                        setActionError("");
                        setDialog({ kind: "purgeAll" });
                      }
                    }, tt("sessions.emptyAll"))
                  )
                  : null
              ),
            renderDialog()
          )
        )
      );
    }

    function SessionsTab({ t: tt }) {
      const [info, setInfo] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => {
        let cancelled = false;
        fetchSessions().then((value) => {
          if (!cancelled) setInfo(value);
        }).catch(() => {
          if (!cancelled) setFailed(true);
        });
        return () => {
          cancelled = true;
        };
      }, []);
      const count = info && info.trash && Number.isFinite(info.trash.count) ? info.trash.count : 0;
      const available = info ? info.available !== false : !failed;
      return e("div", { className: "dma-settings-panel" },
        e("p", { className: "dma-cost-note" }, tt("sessions.settingsDesc")),
        count > 0 ? e("p", { className: "dma-sessions-settings-trash" }, tt("sessions.settingsTrash", { n: count })) : null,
        !available ? e("p", { className: "dma-stats-error" }, tt("sessions.unavailable")) : null,
        e("button", {
          type: "button",
          className: "dma-setting-primary dma-setting-btn",
          disabled: !available,
          onClick: (ev) => openSessionsPanel(ev.currentTarget)
        }, tt("sessions.settingsOpen")),
        e("div", { className: "dma-settings-version" }, "v" + VERSION)
      );
    }

    /** 侧边栏底部的「对话管理」入口：宽栏显示图标 + 文字，窄栏与费用入口同形。 */
    function SessionsEntry({ t: tt, wide }) {
      const title = tt("sessions.entryTitle");
      return e("div", { className: "dma-cost-item" },
        e("button", {
          type: "button",
          className: wide ? "dma-sessions-entry" : "dma-cost-rail",
          title,
          "aria-label": title,
          onClick: (ev) => openSessionsPanel(ev.currentTarget)
        },
          e("span", {
            className: "dma-sessions-entry-icon",
            "aria-hidden": "true",
            dangerouslySetInnerHTML: { __html: SESSIONS_ICON }
          }),
          wide ? e("span", { className: "dma-sessions-entry-label" }, tt("sessions.entry")) : null
        )
      );
    }

    let settingsTab = "actions";

    function SettingsSection({ t: tt, form }) {
      const snap = React.useSyncExternalStore(
        (listener) => (form && form.subscribe ? form.subscribe(listener) : () => {}),
        () => (form && form.getSnapshot ? form.getSnapshot() : { status: "loading" })
      );
      const [tab, setTab] = React.useState(settingsTab);
      const [error, setError] = React.useState("");
      const billingFetched = React.useRef(false);
      const value = snap && snap.status === "ready" && typeof snap.value === "object"
        ? snap.value
        : null;

      React.useEffect(() => {
        if (tab !== "billing" || billingFetched.current) return;
        billingFetched.current = true;
        fetchCostState(false).catch(() => {});
      }, [tab]);

      function save(key, next) {
        if (!form || !form.set) return;
        try {
          const result = form.set(key, next);
          if (result && typeof result.then === "function") {
            result.then((ok) => setError(ok === false ? tt("settings.saveFailed") : ""),
              () => setError(tt("settings.saveFailed")));
          } else if (result === false) {
            setError(tt("settings.saveFailed"));
          } else {
            setError("");
          }
        } catch {
          setError(tt("settings.saveFailed"));
        }
      }

      function switchTab(next) {
        settingsTab = next;
        setTab(next);
      }

      const tabButton = (id, labelKey) => e("button", {
        type: "button",
        role: "tab",
        "aria-selected": tab === id ? "true" : "false",
        className: "dma-tab" + (tab === id ? " dma-tab-active" : ""),
        onClick: () => switchTab(id)
      }, tt(labelKey));

      return e("div", { className: "dma-settings" },
        e("div", { className: "dma-tabs", role: "tablist" },
          tabButton("actions", "cost.tab.actions"),
          tabButton("billing", "cost.tab.billing"),
          tabButton("sessions", "cost.tab.sessions")
        ),
        tab === "actions"
          ? e("div", { className: "dma-settings-panel" },
            SETTING_FIELDS.map(([key, labelKey, descKey, defaultOn]) => {
              const on = value ? (defaultOn ? value[key] !== false : value[key] === true) : defaultOn === true;
              return e(SettingRow, {
                key,
                t: tt,
                labelKey,
                descKey,
                on,
                onToggle: () => save(key, !on)
              });
            }),
            // 音色 + 音量：没有独立开关行，「关闭」音色即关闭完成提示音。
            e(SoundToneRow, {
              key: "soundTone",
              t: tt,
              value: value || {},
              onPick: (id) => {
                save("soundTone", id);
                if (id === "off") return; // 选「关闭」即关闭，不再试听
                // 旧配置可能还留着 sound=false：选任一音色时同步打开。
                if (value && value.sound === false) save("sound", true);
                playCompletionSound(id);
              }
            }),
            e(VolumeRow, {
              key: "soundVolume",
              t: tt,
              value: value ? value.soundVolume : DEFAULT_SOUND_VOLUME,
              onCommit: (volume) => {
                save("soundVolume", volume);
                playCompletionSound(undefined, volume);
              }
            }),
            // 第一个标签页底部：只读版本号，不抢设置项视觉焦点。
            e("div", { className: "dma-settings-version" }, "v" + VERSION)
          )
          : tab === "billing"
            ? e(BillingTab, { t: tt, form, value, save })
            : e(SessionsTab, { t: tt }),
        error ? e("div", { className: "dma-setting-error" }, error) : null
      );
    }

    // -------------------------------------------------------------------------
    // 侧边栏费用卡片
    // -------------------------------------------------------------------------

    const COIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><path d="M9.5 12h5M12 9.5v5"/></svg>';
    const PEAK_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.6" fill="#f97316"/><path d="M6 3.1 8.9 7.3H3.1z" fill="#fff"/></svg>';
    const VALLEY_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.6" fill="#3b82f6"/><path d="M6 8.9 3.1 4.7h5.8z" fill="#fff"/></svg>';
    const LOCAL_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.6" fill="#9aa3af"/><circle cx="6" cy="6" r="2.2" fill="#fff"/></svg>';

    function useRollingNumber(value) {
      const [shown, setShown] = React.useState(value);
      const fromRef = React.useRef(value);
      React.useEffect(() => {
        const from = fromRef.current;
        fromRef.current = value;
        if (!Number.isFinite(from) || !Number.isFinite(value) || from === value
          || typeof requestAnimationFrame !== "function") {
          setShown(value);
          return undefined;
        }
        const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
        const startedAt = clock();
        let raf = 0;
        const step = () => {
          const p = Math.min(1, (clock() - startedAt) / 350);
          setShown(from + (value - from) * easeOutCubic(p));
          if (p < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
      }, [value]);
      return shown;
    }

    function CostCard({ t: tt, wide, form }) {
      const costSnap = React.useSyncExternalStore(
        costStore.subscribe,
        costStore.getSnapshot,
        costStore.getSnapshot
      );
      const formSnap = React.useSyncExternalStore(
        (listener) => (form && form.subscribe ? form.subscribe(listener) : () => {}),
        () => (form && form.getSnapshot ? form.getSnapshot() : { status: "loading" }),
        () => ({ status: "loading" })
      );
      const cfg = formSnap && formSnap.status === "ready" && typeof formSnap.value === "object"
        ? formSnap.value
        : {};
      const enabled = cfg.usageStats !== false;
      const showPeak = cfg.costPeakValley !== false;
      const showTurn = cfg.costPerTurn !== false;
      const compact = normalizeCostLayout(cfg.costLayout) === "compact";

      const value = costSnap && costSnap.status === "ready" ? costSnap.value : null;
      const balance = value ? value.balance : null;
      const status = value ? value.status : "stale";
      const route = value && value.route ? value.route : null;
      const lastTurn = value && value.lastTurn ? value.lastTurn : null;

      // 余额口径：主数字 = 充值余额 + 赠金钱包（与「日用」观测的总额同基准），
      // 全部按分计，不做元级四舍五入；赠金拆分只在悬停提示，不再单独占行。
      const rechargeCents = balance && Number.isFinite(balance.rechargeCents) ? balance.rechargeCents : null;
      const bonusCents = balance && Number.isFinite(balance.bonusCents) ? balance.bonusCents : null;
      const totalCents = balance && Number.isFinite(balance.totalCents) ? balance.totalCents : null;
      const balanceCents = balance && balance.updatedAt > 0
        ? (totalCents !== null ? totalCents : rechargeCents)
        : null;
      const bonusTitle = bonusCents !== null && bonusCents > 0
        ? " · " + tt("cost.bonusHint", { bonus: formatYuanCents(bonusCents) })
        : "";
      const dailyCents = balanceCents !== null && value && Number.isFinite(value.dailyCents)
        ? value.dailyCents
        : null;
      const turnMicros = showTurn && lastTurn && Number.isFinite(lastTurn.costMicros)
        ? lastTurn.costMicros
        : null;

      const [manualBusy, setManualBusy] = React.useState(false);
      const [closedAt, setClosedAt] = React.useState(null);
      const seenRef = React.useRef({ at: null, firstAt: 0 });

      const balanceShown = useRollingNumber(balanceCents);
      const dailyShown = useRollingNumber(dailyCents);
      const turnShown = useRollingNumber(turnMicros);

      const turnAt = lastTurn ? lastTurn.at : null;
      React.useEffect(() => {
        setClosedAt(null);
      }, [turnAt]);
      React.useEffect(() => {
        if (turnAt === null) return undefined;
        if (seenRef.current.at !== turnAt || seenRef.current.closeSeconds !== cfg.costPerTurnAutoClose) {
          seenRef.current.at = turnAt;
          seenRef.current.closeSeconds = cfg.costPerTurnAutoClose;
          seenRef.current.firstAt = Date.now();
        }
        const closeAt = autoCloseAt(seenRef.current.firstAt, cfg.costPerTurnAutoClose);
        if (closeAt === null) return undefined;
        const delay = Math.max(0, closeAt - Date.now());
        const timer = setTimeout(() => setClosedAt(turnAt), delay);
        return () => clearTimeout(timer);
      }, [turnAt, cfg.costPerTurnAutoClose]);

      if (!enabled) return null;

      async function refresh() {
        setManualBusy(true);
        await fetchCostState(true);
        setManualBusy(false);
      }

      const refreshing = manualBusy || (balance && balance.refreshing === true);
      const turnHidden = lastTurn !== null && closedAt === turnAt;

      if (!wide) {
        const title = balanceCents !== null
          ? tt("cost.railTitle", { balance: formatYuanCents(balanceCents) }) + bonusTitle
          : tt("cost.balance");
        return e("div", { className: "dma-cost-item" },
          e("button", {
            type: "button",
            className: "dma-cost-rail" + (refreshing ? " dma-cost-busy" : ""),
            title,
            "aria-label": tt("cost.refresh"),
            onClick: refresh
          }, e("span", { className: "dma-ico", dangerouslySetInnerHTML: { __html: COIN_SVG } }))
        );
      }

      if (status === "third-party") {
        // 第三方 / 本地直连：不轮询 DeepSeek 余额，只展示按价格表估算的今日累计。
        const unverified = route && route.confirmed === false;
        const daily = value && Number.isFinite(value.dailyCents) ? formatYuanCents(value.dailyCents) : "—";
        return e("div", { className: "dma-cost-item" },
          e("div", {
            className: "dma-cost-card dma-cost-local" + (compact ? " dma-cost-plain" : ""),
            title: unverified ? tt("stats.billingNote") : undefined,
            "aria-label": unverified ? tt("cost.thirdPartyUnverified") : tt("cost.thirdParty")
          },
            e("span", {
              className: "dma-cost-period-icon",
              "aria-hidden": "true",
              dangerouslySetInnerHTML: { __html: LOCAL_SVG }
            }),
            e("span", { className: "dma-cost-local-text" },
              (unverified ? tt("cost.thirdPartyUnverified") : tt("cost.thirdParty")) +
              " · " + tt("cost.daily") + " " + daily)
          )
        );
      }

      if (status === "local") {
        return e("div", { className: "dma-cost-item" },
          e("div", {
            className: "dma-cost-card dma-cost-local" + (compact ? " dma-cost-plain" : ""),
            "aria-label": tt("cost.local")
          },
            e("span", {
              className: "dma-cost-period-icon",
              "aria-hidden": "true",
              dangerouslySetInnerHTML: { __html: LOCAL_SVG }
            }),
            e("span", { className: "dma-cost-local-text" }, tt("cost.local"))
          )
        );
      }

      let balanceText = "—";
      if (status === "signed-out") balanceText = tt("cost.signedOut");
      else if (status === "api-key") balanceText = tt("cost.apiKey");
      else if (status === "unavailable") balanceText = tt("cost.unavailable");
      else if (Number.isFinite(balanceShown)) balanceText = formatYuanCents(Math.round(balanceShown));

      const dailyText = Number.isFinite(dailyShown) && status !== "signed-out" && status !== "api-key" && status !== "unavailable"
        ? formatYuanCents(Math.round(dailyShown))
        : "—";
      const amountsHidden = status === "signed-out" || status === "api-key" || status === "unavailable";
      const turnHasUnpriced = lastTurn !== null && lastTurn.hasUnpriced === true;
      const turnText = turnHidden || amountsHidden || !Number.isFinite(turnShown)
        ? "—"
        : turnHasUnpriced && lastTurn.costMicros === 0
          ? tt("stats.unpricedCost")
          : formatCostMicros(Math.round(turnShown)) + (turnHasUnpriced ? " · " + tt("stats.unpricedSuffix") : "");

      const stale = status === "stale" && balanceCents !== null;
      const staleTitle = balance && balance.updatedAt > 0
        ? tt("cost.staleTitle", { time: new Date(balance.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
        : "";

      const period = periodInfo(Date.now());
      const changeText = periodChangeText(Date.now(), period.nextChangeAt, detectLang());
      const periodLabel = period.period === "peak" ? tt("cost.peak") : tt("cost.valley");
      const periodIcon = e("span", {
        className: "dma-cost-period-icon",
        title: periodLabel + " · " + changeText,
        dangerouslySetInnerHTML: { __html: period.period === "peak" ? PEAK_SVG : VALLEY_SVG }
      });

      if (compact) {
        return e("div", { className: "dma-cost-item" },
          e("div", { className: "dma-cost-card dma-cost-plain" },
            e("div", { className: "dma-cost-plain-wrap" },
              e("button", {
                type: "button",
                className: "dma-cost-plain-row",
                onClick: refresh,
                title: (stale ? staleTitle : tt("cost.refresh")) + bonusTitle,
                "aria-label": tt("cost.refresh"),
                "aria-busy": refreshing ? "true" : "false"
              },
                showPeak ? periodIcon : null,
                e("span", { className: "dma-cost-col" },
                  e("span", { className: "dma-cost-label" }, tt("cost.balance")),
                  e("span", { className: "dma-cost-value" }, balanceText)
                ),
                e("span", { className: "dma-cost-col" },
                  e("span", { className: "dma-cost-label" }, tt("cost.daily")),
                  e("span", { className: "dma-cost-value" }, dailyText)
                ),
                showTurn && !turnHidden
                  ? e("span", { className: "dma-cost-col" },
                    e("span", { className: "dma-cost-label", title: tt("cost.settings.perTurnDesc") }, tt("cost.perTurn")),
                    e("span", { className: "dma-cost-value" }, turnText)
                  )
                  : null
              ),
              e("button", {
                type: "button",
                className: "dma-stats-entry",
                title: tt("stats.entryTitle"),
                "aria-label": tt("stats.entryTitle"),
                onClick: (ev) => openStatsPanel(ev.currentTarget)
              }, e("span", { className: "dma-ico", dangerouslySetInnerHTML: { __html: STATS_ICON } }))
            )
          )
        );
      }

      return e("div", { className: "dma-cost-item" },
        e("div", { className: "dma-cost-card", "aria-label": tt("cost.title") },
          e("div", { className: "dma-cost-cols" },
            e("button", {
              type: "button",
              className: "dma-cost-col dma-cost-balance" + (refreshing ? " dma-cost-busy" : ""),
              onClick: refresh,
              title: (stale ? staleTitle : tt("cost.refresh")) + bonusTitle,
              "aria-label": tt("cost.refresh"),
              "aria-busy": refreshing ? "true" : "false"
            },
              e("span", { className: "dma-cost-label" },
                tt("cost.balance"),
                refreshing ? e("span", { className: "dma-cost-spinner" }) : null,
                stale ? e("span", { className: "dma-cost-stale", title: staleTitle }) : null
              ),
              e("span", { className: "dma-cost-value" }, balanceText)
            ),
            e("div", { className: "dma-cost-col" },
              e("span", { className: "dma-cost-label" }, tt("cost.daily")),
              e("span", { className: "dma-cost-value" }, dailyText)
            ),
            showTurn && !turnHidden
              ? e("div", { className: "dma-cost-col" },
                e("span", { className: "dma-cost-label", title: tt("cost.settings.perTurnDesc") }, tt("cost.perTurn")),
                e("span", { className: "dma-cost-value" }, turnText),
                lastTurn
                  ? e("button", {
                    type: "button",
                    className: "dma-cost-hide",
                    title: tt("cost.hide"),
                    "aria-label": tt("cost.hide"),
                    onClick: () => setClosedAt(turnAt)
                  }, "×")
                  : null
              )
              : null,
            e("button", {
              type: "button",
              className: "dma-stats-entry",
              title: tt("stats.entryTitle"),
              "aria-label": tt("stats.entryTitle"),
              onClick: (ev) => openStatsPanel(ev.currentTarget)
            }, e("span", { className: "dma-ico", dangerouslySetInnerHTML: { __html: STATS_ICON } }))
          ),
          showPeak
            ? e("div", {
              className: "dma-cost-period " + (period.period === "peak" ? "dma-cost-peak" : "dma-cost-valley"),
              "aria-live": "polite"
            },
              periodIcon,
              e("span", { className: "dma-cost-period-text" }, periodLabel + " · " + changeText)
            )
            : null
        )
      );
    }

    // -------------------------------------------------------------------------
    // CSS 注入
    // -------------------------------------------------------------------------

    const EXTRA_CSS = `
.dma-settings{max-width:680px;display:flex;flex-direction:column;gap:2px}
.dma-settings-panel{display:flex;flex-direction:column;gap:2px}
.dma-settings-version{margin-top:10px;padding-top:8px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a919e);text-align:right;user-select:text}
.dma-setting-row{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:10px 4px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dma-setting-text{min-width:0}
.dma-setting-label{font-size:14px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-setting-desc{margin-top:2px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-switch{flex:none;position:relative;width:36px;height:20px;margin-top:2px;border:0;border-radius:999px;padding:0;background:var(--dsw-alias-border-l3,#c9ced6);cursor:pointer;transition:background 120ms ease}
.dma-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary,#4c8dff)}
.dma-switch:disabled{opacity:.45;cursor:default}
.dma-switch-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.18);transition:transform 120ms ease}
.dma-switch[aria-checked="true"] .dma-switch-thumb{transform:translateX(16px)}
.dma-setting-error{margin-top:8px;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}
.dma-ico{display:inline-flex}
.dma-empty{color:var(--dsw-alias-label-tertiary,#8a919e);font-size:13px;margin:12px 0}
.dma-tabs{display:inline-flex;gap:4px;align-self:flex-start;margin:2px 0 10px;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-tab{border:0;border-radius:7px;padding:5px 14px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);font-size:13px;line-height:1.4;cursor:pointer}
.dma-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.dma-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-number{flex:none;width:88px;margin-top:4px;padding:5px 8px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-variant-numeric:tabular-nums;text-align:right}
.dma-number:disabled{opacity:.5}
.dma-seg{flex:none;display:inline-flex;gap:2px;margin-top:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-seg-btn{border:0;border-radius:6px;padding:4px 10px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);font-size:12px;line-height:1.4;cursor:pointer}
.dma-seg-btn[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dma-seg-btn:disabled{opacity:.45;cursor:default}
.dma-volume{flex:none;display:inline-flex;align-items:center;gap:8px;margin-top:2px}
.dma-volume-range{width:132px;accent-color:var(--dsw-alias-state-business-primary,#4c8dff)}
.dma-volume-range:disabled{opacity:.45}
.dma-volume-value{min-width:38px;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#5b6472);text-align:right}
.dma-cost-note{margin:10px 0 0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-setting-primary{height:32px;padding:0 16px;border:0;border-radius:8px;background:var(--dsw-alias-button-primary-fill,#4c8dff);color:#fff;font-size:13px;cursor:pointer}
.dma-setting-primary:disabled{background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-dimmed,#a0a6b0);cursor:default}
.dma-cost-item{flex:1 1 auto;min-width:0}
.dma-cost-card{display:flex;flex-direction:column;gap:3px;min-width:0;padding:5px 8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2329)}
.dma-cost-cols{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0}
.dma-cost-col{display:flex;align-items:baseline;gap:3px;min-width:0;flex:0 1 auto;text-align:left}
.dma-cost-balance{display:flex;align-items:baseline;gap:3px;min-width:0;border:0;border-radius:5px;padding:0 2px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.dma-cost-balance:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dma-cost-balance:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-cost-label{display:flex;align-items:center;gap:2px;overflow:hidden;font-size:11px;line-height:1.2;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-cost-value{overflow:hidden;font-size:14px;font-weight:600;line-height:1.25;white-space:nowrap;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.dma-cost-spinner{flex:none;width:9px;height:9px;border:1.5px solid rgba(0,0,0,.15);border-top-color:var(--dsw-alias-state-business-primary,#4c8dff);border-radius:50%;animation:dma-spin .8s linear infinite}
.dma-cost-stale{flex:none;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#a0a6b0)}
.dma-cost-hide{margin-left:1px;border:0;padding:0 1px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a919e);font-size:11px;line-height:1;cursor:pointer}
.dma-cost-period{display:flex;align-items:center;justify-content:center;gap:5px;padding-top:4px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));font-size:10.5px;line-height:1.35}
.dma-cost-period-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px}
.dma-cost-period-icon svg{display:block;width:14px;height:14px}
.dma-cost-peak .dma-cost-period-text{color:#c2610b}
.dma-cost-valley .dma-cost-period-text{color:#2563b8}
.dma-cost-period-text{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dma-cost-plain{padding:2px 2px;border:0;border-radius:0;background:transparent;gap:0}
.dma-cost-plain-row{display:flex;align-items:center;justify-content:flex-start;gap:9px;width:100%;min-width:0;border:0;padding:0;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.dma-cost-plain-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-cost-plain .dma-cost-col{flex:0 1 auto;overflow:hidden}
.dma-cost-plain .dma-cost-value{font-size:13.5px}
.dma-cost-local{flex-direction:row;align-items:center;justify-content:center;gap:5px;padding:6px 8px}
.dma-cost-local.dma-cost-plain{justify-content:flex-start;gap:6px;padding:2px 2px}
.dma-cost-local-text{overflow:hidden;font-size:12px;line-height:1.3;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-cost-rail{display:flex;align-items:center;justify-content:center;width:100%;min-width:0;height:30px;border:0;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-secondary,#5b6472);cursor:pointer}
.dma-cost-rail:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dma-cost-rail:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-cost-rail svg{width:16px;height:16px}
.dma-cost-plain-wrap{display:flex;align-items:center;gap:2px;width:100%;min-width:0}
.dma-cost-plain-wrap .dma-cost-plain-row{flex:1 1 auto;min-width:0}
.dma-cost-cols>.dma-stats-entry{align-self:center}
.dma-stats-entry{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a919e);cursor:pointer;transition:background 120ms ease,color 120ms ease}
.dma-stats-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2329)}
.dma-stats-entry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-stats-entry svg{display:block;width:15px;height:15px}
.dma-stats-panel{width:min(920px,calc(100vw - 48px));max-height:86vh}
.dma-stats-head{display:flex;align-items:center;gap:6px}
.dma-stats-title{margin-right:auto;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-stats-live{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22a06b)}
.dma-stats-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);font-size:16px;line-height:1;cursor:pointer}
.dma-stats-icon:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dma-stats-icon:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-stats-icon:disabled{opacity:.45;cursor:default}
.dma-stats-ico svg{display:block;width:16px;height:16px}
.dma-stats-body{display:flex;flex-direction:column;gap:14px;padding:14px 18px}
.dma-stats-intro{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.dma-stats-card{display:flex;flex-direction:column;gap:4px;min-width:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-stats-card-label{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-card-value{overflow:hidden;font-size:20px;font-weight:600;line-height:1.25;white-space:nowrap;text-overflow:ellipsis;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-stats-card-sub{overflow:hidden;font-size:11px;line-height:1.45;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-progress{height:5px;margin-top:2px;border-radius:3px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden}
.dma-stats-progress i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary,#4c8dff);transition:width 240ms ease}
.dma-stats-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.dma-stats-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dma-stats-section-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-stats-note{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-billing-endpoints{display:flex;flex-wrap:wrap;gap:6px 10px;font-size:11px;color:var(--dsw-alias-label-secondary,#4d5460)}
.dma-billing-endpoint{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-billing-endpoint b{font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-billing-kind{font-style:normal;font-size:10px;padding:0 5px;border-radius:6px;line-height:15px;background:rgba(47,107,216,.12);color:#2f6bd8}
.dma-billing-kind-local{background:rgba(0,0,0,.06);color:#6b7280}
.dma-billing-kind-third{background:rgba(217,164,65,.18);color:#8a5b00}
.dma-billing-kind-price-official{background:rgba(47,107,216,.12);color:#2f6bd8}
.dma-billing-kind-price-custom{background:rgba(19,122,78,.14);color:#137a4e}
.dma-billing-kind-price-estimated{background:rgba(217,164,65,.14);color:#8a5b00}
.dma-billing-kind-price-unconfigured{background:rgba(0,0,0,.06);color:#6b7280}
.dma-billing-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dma-billing-label{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#4d5460)}
.dma-billing-input{box-sizing:border-box;width:100%;padding:7px 9px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical}
.dma-billing-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:1px}
.dma-billing-json{min-height:120px}
.dma-billing-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.dma-billing-save{height:28px;padding:0 14px;border:0;border-radius:7px;background:var(--dsw-alias-button-primary-fill,#4c8dff);color:#fff;font-size:12px;font-weight:500;cursor:pointer}
.dma-billing-save:disabled{opacity:.6;cursor:default}
.dma-billing-ok{font-size:11.5px;color:#137a4e}
.dma-billing-error{font-size:11.5px;color:#c0392b}
.dma-stats-range{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-stats-range button{border:0;border-radius:6px;padding:4px 10px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);font-size:12px;line-height:1.4;cursor:pointer}
.dma-stats-range button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dma-stats-range button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-stats-chart-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-stats-chart-meta{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-chart{display:flex;align-items:flex-end;gap:2px;height:150px;min-width:0}
.dma-stats-chart>div{flex:1 1 0;display:flex;align-items:flex-end;justify-content:center;min-width:0;height:100%}
.dma-stats-col{position:relative;flex:1 1 0;display:flex;align-items:flex-end;justify-content:center;min-width:0;height:100%}
.dma-stats-billing-bar{position:absolute;left:50%;bottom:0;transform:translateX(-50%);display:flex;width:100%;max-width:26px;height:3px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}
.dma-stats-billing-bar i{display:block;height:100%}
.dma-stats-billing-deepseek{background:#2f6bd8}
.dma-stats-billing-local{background:#a8aeb8}
.dma-stats-billing-unpriced{background:#d9a441}
.dma-stats-stack{display:flex;flex-direction:column-reverse;width:100%;max-width:26px;border-radius:3px 3px 0 0;overflow:hidden}
.dma-stats-seg{display:block;width:100%}
.dma-stats-seg-input{background:var(--dsw-alias-brand-primary,#4c8dff)}
.dma-stats-seg-cacheRead{background:var(--dsw-alias-brand-primary,#4c8dff);opacity:.5}
.dma-stats-seg-cacheWrite{background:var(--dsw-alias-brand-primary,#4c8dff);opacity:.26}
.dma-stats-seg-output{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dma-stats-axis{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-axis span{overflow:hidden;white-space:nowrap;text-align:center}
.dma-stats-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-legend span{display:inline-flex;align-items:center;gap:4px}
.dma-stats-legend-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;min-width:0}
.dma-stats-legend-billing{flex:none;margin-left:auto}
.dma-stats-swatch{display:inline-block;width:9px;height:9px;border-radius:2px}
.dma-stats-rows{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:9px;overflow:hidden}
.dma-stats-row{display:grid;grid-template-columns:minmax(0,1fr) 96px 84px 84px;gap:8px;align-items:center;padding:8px 12px;font-size:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dma-stats-row:first-child{border-top:0}
.dma-stats-row-head{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#8a919e);background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-stats-cell{min-width:0;overflow:hidden}
.dma-stats-cell-right{text-align:right;font-variant-numeric:tabular-nums}
.dma-stats-row-title{display:flex;align-items:center;gap:5px;min-width:0}
.dma-stats-row-title b{overflow:hidden;font-weight:600;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-stats-pill{flex:none;padding:0 5px;border-radius:7px;background:rgba(76,141,255,.14);color:#2f6bd8;font-size:10px;font-weight:500;line-height:15px}
.dma-stats-pill-running{background:rgba(34,160,107,.15);color:#137a4e}
.dma-stats-pill-local{background:rgba(0,0,0,.06);color:#6b7280}
.dma-stats-pill-unpriced{background:rgba(217,164,65,.18);color:#8a5b00}
.dma-stats-pill-unconfirmed{background:rgba(217,164,65,.12);color:#8a5b00;border:.5px dashed rgba(217,164,65,.6)}
.dma-stats-meta{overflow:hidden;font-size:10.5px;line-height:1.45;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-mini{display:flex;height:4px;margin-top:4px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}
.dma-stats-mini i{display:block;height:100%}
.dma-stats-mini .dma-stats-seg-cacheRead{opacity:.5}
.dma-stats-mini .dma-stats-seg-output{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dma-stats-empty{margin:6px 0;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-money-edit{padding:0;border:0;background:transparent;font:inherit;font-size:20px;font-weight:600;line-height:1.25;text-align:left;color:inherit;border-radius:4px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.dma-stats-money-edit:hover{color:var(--dsw-alias-state-business-primary,#4c8dff)}
.dma-stats-money-edit:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-stats-money-edit-row{display:flex;flex-wrap:nowrap;align-items:center;gap:7px;min-width:0;min-height:24px}
.dma-stats-money-edit-row>*{flex:none;min-width:0}
.dma-stats-money-card{container-type:inline-size}
.dma-stats-money-input{display:inline-flex;flex:0 1 92px;align-items:center;gap:3px;box-sizing:border-box;width:92px;min-width:64px;padding:2px 6px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:13px;color:var(--dsw-alias-label-tertiary,#8a919e);overflow:hidden}
.dma-stats-money-input input{flex:1 1 auto;width:0;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-size:13px;font-variant-numeric:tabular-nums;text-align:right}
.dma-stats-money-mini{flex:none;height:25px;padding:0 9px;border:0;border-radius:6px;background:var(--dsw-alias-button-primary-fill,#4c8dff);color:#fff;font-size:11.5px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap}
.dma-stats-money-mini:hover{filter:brightness(.95)}
.dma-stats-money-mini:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-stats-money-mini:disabled{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-dimmed,#a0a6b0);cursor:default;filter:none}
.dma-stats-money-cancel{flex:none;height:25px;padding:0 7px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);font-size:11px;cursor:pointer;white-space:nowrap}
.dma-stats-money-cancel:hover{color:var(--dsw-alias-label-primary,#1f2329);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.16))}
.dma-stats-money-cancel:disabled{opacity:.45;cursor:default}
@container (max-width:181px){.dma-stats-money-edit-row{gap:4px}.dma-stats-money-mini{padding:0 5px}.dma-stats-money-cancel{padding:0 4px}}
.dma-stats-money-hint{overflow:hidden;font-size:10px;line-height:1.3;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-stats-money-value-row{display:flex;align-items:center;gap:8px;min-width:0;min-height:24px}
.dma-stats-money-value-row .dma-stats-money-edit{flex:1 1 auto;min-width:0}
.dma-stats-money-value-row .dma-stats-money-mini{flex:none;white-space:nowrap}
.dma-stats-error{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5484d)}
.dma-setting-btn{flex:none;margin-top:2px;align-self:flex-start}
.dma-sessions-panel{position:relative;width:min(760px,calc(100vw - 40px));max-height:86vh}
.dma-sessions-body{gap:10px;padding:14px 18px 16px}
.dma-sessions-tabs{display:inline-flex;gap:4px;align-self:flex-start;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-sessions-tab{border:0;border-radius:7px;padding:5px 12px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);font-size:12.5px;line-height:1.4;cursor:pointer;white-space:nowrap}
.dma-sessions-tab-active{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.dma-sessions-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-sessions-list-wrap{display:flex;flex-direction:column;gap:12px;min-height:120px;min-width:0}
.dma-sessions-search-input{box-sizing:border-box;width:100%;height:30px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:12.5px;outline:0}
.dma-sessions-search-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-sessions-search-input:focus{border-color:var(--dsw-alias-state-business-primary,#4c8dff)}
.dma-sessions-group{display:flex;flex-direction:column;min-width:0;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}
.dma-sessions-group-head{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 10px;background:var(--dsw-alias-bg-layer-2,#f2f3f5)}
.dma-sessions-group-title{flex:0 1 auto;max-width:46%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-sessions-group-path{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-sessions-group-count{flex:none;min-width:20px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:10.5px;line-height:16px;text-align:center;color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-session-row{display:flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dma-session-row-missing{opacity:.72}
.dma-session-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.dma-session-title-line{display:flex;align-items:center;gap:6px;min-width:0}
.dma-session-title{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:500;line-height:1.35;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-session-meta{display:flex;align-items:center;gap:8px;min-width:0;font-size:10.5px;line-height:1.35;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-session-path{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;opacity:.85}
.dma-session-actions{flex:none;display:flex;align-items:center;gap:4px}
.dma-session-act{height:26px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);font-size:11.5px;line-height:1;cursor:pointer;white-space:nowrap}
.dma-session-act:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2329)}
.dma-session-act:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-session-act:disabled{opacity:.4;cursor:default}
.dma-session-danger{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dma-session-danger-solid{border-color:transparent;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}
.dma-session-danger-solid:hover:not(:disabled){filter:brightness(.95)}
.dma-session-danger-outline{height:28px;padding:0 11px;border:.5px solid var(--dsw-alias-state-error-primary,#e5484d);border-radius:7px;background:transparent;color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11.5px;cursor:pointer}
.dma-session-danger-outline:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}
.dma-session-danger-outline:disabled{opacity:.45;cursor:default}
.dma-session-badge{flex:none;padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a919e);white-space:nowrap}
.dma-session-badge-live{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-state-business-primary,#4c8dff);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary,#4c8dff)}
.dma-session-badge-run{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-state-success-primary,#22a06b);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-success-primary,#22a06b)}
.dma-session-badge-warn{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-state-warning-primary,#c2610b);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-warning-primary,#c2610b)}
.dma-session-dialog-layer{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;padding:18px}
.dma-session-dialog-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.34);border-radius:inherit}
.dma-session-dialog{position:relative;display:flex;flex-direction:column;gap:9px;width:min(400px,100%);padding:16px;border-radius:11px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 14px 36px rgba(0,0,0,.22)}
.dma-session-dialog-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-session-dialog-desc{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5b6472);overflow-wrap:anywhere}
.dma-session-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.dma-session-warn{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5484d)}
.dma-session-okhint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-session-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dma-session-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-session-select{box-sizing:border-box;width:100%;height:30px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2329);font-size:12.5px}
.dma-sessions-note{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-sessions-foot{display:flex;justify-content:flex-end;margin-top:2px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dma-sessions-settings-trash{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-sessions-entry{display:flex;align-items:center;gap:7px;width:100%;min-width:0;height:30px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6472);font-size:12.5px;line-height:1.3;cursor:pointer;text-align:left}
.dma-sessions-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1f2329)}
.dma-sessions-entry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-sessions-entry-icon{flex:none;display:inline-flex;width:16px;height:16px}
.dma-sessions-entry-icon svg{display:block;width:16px;height:16px}
.dma-sessions-entry-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dma-session-hint{margin:0;padding:6px 9px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#5b6472)}
@media (max-width:560px){
.dma-sessions-panel{width:calc(100vw - 20px);max-height:92vh}
.dma-sessions-body{padding:12px}
.dma-session-row{flex-wrap:wrap}
.dma-session-actions{width:100%;justify-content:flex-end}
.dma-sessions-group-path{display:none}
}
@keyframes dma-spin{to{transform:rotate(360deg)}}
@media (prefers-color-scheme:dark){
.dma-cost-peak .dma-cost-period-text{color:#f0a24a}
.dma-cost-valley .dma-cost-period-text{color:#8fb8ff}
.dma-cost-spinner{border-color:rgba(255,255,255,.18)}
.dma-billing-ok{color:#4ecb8d}
.dma-billing-error{color:#ff8585}
.dma-billing-kind{background:rgba(110,160,255,.2);color:#9cc0ff}
.dma-billing-kind-local,.dma-billing-kind-price-unconfigured{background:rgba(255,255,255,.1);color:#b9c0ca}
.dma-billing-kind-third,.dma-billing-kind-price-estimated{background:rgba(217,164,65,.24);color:#f0c06a}
.dma-billing-kind-price-custom{background:rgba(78,203,141,.2);color:#68d9a4}
.dma-stats-pill{background:rgba(110,160,255,.2);color:#9cc0ff}
.dma-stats-pill-running{background:rgba(78,203,141,.2);color:#68d9a4}
.dma-stats-pill-local{background:rgba(255,255,255,.1);color:#b9c0ca}
.dma-stats-pill-unpriced,.dma-stats-pill-unconfirmed{background:rgba(217,164,65,.22);color:#f0c06a}
}
@media (max-width:680px){
.dma-stats-panel{width:calc(100vw - 24px)}
.dma-stats-body{padding:12px 14px;gap:12px}
.dma-stats-row{grid-template-columns:minmax(0,1fr) 72px 64px 64px;gap:6px;padding:8px 10px;font-size:11.5px}
.dma-stats-kpis{grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
.dma-stats-card{padding:8px 10px}
.dma-stats-card-value{font-size:17px}
.dma-setting-row{gap:12px}
.dma-tabs{margin-bottom:8px}
.dma-cost-note{font-size:10.5px}
}
`;

    function injectCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + NS + '"]')) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = NS;
      tag.textContent = CSS + "\n" + EXTRA_CSS;
      document.head.appendChild(tag);
    }

    // -------------------------------------------------------------------------
    // DOM 观察
    // -------------------------------------------------------------------------

    function startDomObserver(ctx) {
      if (typeof document === "undefined" || !document.body) return () => {};
      const run = () => {
        injectQuestionButtons(ctx);
        injectToolButtons(ctx);
        evictStaleControllers();
        syncRail();
        // 对话在流式输出时结构频繁变化：按 TTL 补拉快照，让答行统计与轮次列表跟上。
        for (const el of document.querySelectorAll("[data-conversation-session]")) {
          const sessionId = el.getAttribute("data-conversation-session");
          if (sessionId) sessionFor(ctx, sessionId).fetchMessages(false).catch(() => {});
        }
      };
      const scheduler = createScheduler(run, { delay: 120 });
      const observer = new MutationObserver(() => scheduler.request());
      observer.observe(document.body, { childList: true, subtree: true });
      run();
      return () => {
        observer.disconnect();
        scheduler.dispose();
      };
    }

    function startRailObserver() {
      if (typeof document === "undefined" || !document.body) return () => {};
      let running = false;
      let observer = null;
      const run = () => {
        if (running) return;
        running = true;
        try {
          syncRail();
        } finally {
          // 丢弃本次同步自己写出的变更记录，避免「写入 → 观察 → 再写入」自激。
          if (observer) observer.takeRecords();
          running = false;
        }
      };
      const schedule = typeof requestAnimationFrame === "function"
        ? (fn) => requestAnimationFrame(fn)
        : (fn) => setTimeout(fn, 60);
      const cancel = typeof cancelAnimationFrame === "function"
        ? (handle) => cancelAnimationFrame(handle)
        : (handle) => clearTimeout(handle);
      const scheduler = createScheduler(run, { schedule, cancel });
      observer = new MutationObserver(() => scheduler.request());
      // 只关心官方刻度自身的重建与标签变化；不监听本插件写入的属性（data-dma-*）。
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-label", "data-index"]
      });
      return () => {
        if (observer) observer.disconnect();
        observer = null;
        scheduler.dispose();
      };
    }

    // -------------------------------------------------------------------------
    // 插件主体
    // -------------------------------------------------------------------------

    /**
     * 设置开关或界面语言变化后，立即重绘会话内的按钮与刻度。
     * 只靠 DOM 观察器时，改设置不会改动会话 DOM，界面要等面板关闭才更新。
     */
    function watchLiveUpdates(ctx, form) {
      const run = () => {
        injectQuestionButtons(ctx);
        injectToolButtons(ctx);
        syncRail();
      };
      const schedule = typeof requestAnimationFrame === "function"
        ? (fn) => requestAnimationFrame(fn)
        : (fn) => setTimeout(fn, 60);
      const cancel = typeof cancelAnimationFrame === "function"
        ? (handle) => cancelAnimationFrame(handle)
        : (handle) => clearTimeout(handle);
      const scheduler = createScheduler(run, { schedule, cancel });
      const queue = () => scheduler.request();

      const stops = [scheduler.dispose];
      if (form && typeof form.subscribe === "function") {
        const off = form.subscribe(queue);
        if (typeof off === "function") stops.push(off);
      }
      if (typeof ctx.on === "function") {
        const onLocale = () => {
          localeService = ctx.locale || localeService;
          queue();
        };
        ctx.on("locale/change", onLocale);
        stops.push(() => {
          if (typeof ctx.off === "function") ctx.off("locale/change", onLocale);
        });
      }

      return () => {
        for (const stop of stops) {
          try {
            stop();
          } catch {
            /* ignore */
          }
        }
      };
    }

    const inject = ["slots", "locale", "configForms"];

    function apply(ctx) {
      injectCss();
      localeService = ctx.locale || null;

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-message-actions: locale");

      const settingsForm = ctx.configForms.get("dsh-message-actions");

      // 答行统计
      ctx.slots.inject("conversation.chat.assistant-actions", () =>
        ctx.slots.register({
          name: "conversation.chat.assistant-actions",
          id: "dsh-message-actions-stats",
          order: 30,
          locale: NS,
          inject: (sessionId) => {
            const controller = sessionFor(ctx, sessionId);
            return {
              hooks: { data: controller.data },
              form: controller.form,
              refresh: () => controller.fetchMessages(false).catch(() => {})
            };
          }
        }, AssistantActions)
      );

      // 确认弹窗 + 分享/导出浮层
      ctx.slots.inject("conversation.input.overlay", () =>
        ctx.slots.register({
          name: "conversation.input.overlay",
          id: "dsh-message-actions-overlay",
          order: 20,
          locale: NS,
          inject: (sessionId) => {
            const controller = sessionFor(ctx, sessionId);
            return {
              hooks: { overlay: controller.overlay, data: controller.data },
              confirmAction: (action, opts) => controller.confirmAction(action, opts),
              dismiss: () => controller.dismiss(),
              // 摘要不含正文：先按需拉全文。只有成功才关闭浮层，
              // 失败时由浮层保留已选轮次并复位 busy（提示在生成函数内给出）。
              runShare: (rounds) => generateSharePng(controller, rounds),
              runExport: (rounds) => doExport(controller, rounds)
            };
          }
        }, OverlayController)
      );

      // 设置页
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({
          name: "settings.section",
          id: "dsh-message-actions",
          order: 100,
          label: () => t("nav"),
          locale: NS,
          inject: () => ({ form: settingsForm })
        }, SettingsSection)
      );

      // 设置导航图标：id 必须与 section id 一致。
      // 旧宿主没有声明该槽位时 inject 只会挂起，不会抛错，也不影响其它注册。
      ctx.slots.inject("settings.section.icon", () =>
        ctx.slots.register({
          name: "settings.section.icon",
          id: "dsh-message-actions",
          locale: NS
        }, SettingsNavIcon)
      );

      // 侧边栏底部费用卡片
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-message-actions-cost",
          order: 20,
          locale: NS,
          inject: () => ({ form: settingsForm })
        }, CostCard)
      );

      // 侧边栏底部对话管理入口（与费用卡片同一区域、同一套视觉）
      ctx.slots.inject("sidebar.footer.action", () =>
        ctx.slots.register({
          name: "sidebar.footer.action",
          id: "dsh-message-actions-sessions",
          order: 21,
          locale: NS
        }, SessionsEntry)
      );

      // 费用状态轮询（5s；usageStats 关闭 / 页面隐藏时暂停）
      startCostPolling(settingsForm);

      // DOM 观察：问行按钮注入 + 导航刻度隐藏/压缩
      const stopDom = startDomObserver(ctx);
      const stopRail = startRailObserver();
      const stopLive = watchLiveUpdates(ctx, settingsForm);
      ctx.effect(() => () => {
        stopDom();
        stopRail();
        stopLive();
        stopCostPolling();
        if (typeof document !== "undefined") {
          document.querySelectorAll("[data-dma-actions]").forEach((node) => disposeActionsRow(node));
          // 工具行按钮是命令式创建的，卸载时要一并移除（含可能的 React 图标根）。
          document.querySelectorAll("[data-dma-tool-actions]").forEach((node) => disposeActionsRow(node));
          document.querySelectorAll("[data-dma-toast]").forEach((node) => node.remove());
          document.querySelectorAll('style[data-plugin-css="' + NS + '"]').forEach((node) => node.remove());
        }
      }, "dsh-message-actions: dom observers");
    }

    return { inject, apply };
  }
});