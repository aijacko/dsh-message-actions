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
      shouldPlayCompletionSound,
      formatTokens,
      railTurnOfAttributes,
      createScheduler,
      createRequestGate,
      formatCents,
      formatYuanCents,
      formatCostMicros,
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

    /** 提示音开关（默认 true）；设置快照未就绪时按开启处理。 */
    function soundEnabledNow() {
      if (!costForm || typeof costForm.getSnapshot !== "function") return true;
      const snap = costForm.getSnapshot();
      if (!snap || snap.status !== "ready" || typeof snap.value !== "object" || !snap.value) return true;
      return completionSoundEnabled(snap.value);
    }

    function perTurnNow() {
      if (!costForm || typeof costForm.getSnapshot !== "function") return true;
      const snap = costForm.getSnapshot();
      if (!snap || snap.status !== "ready" || typeof snap.value !== "object" || !snap.value) return true;
      return snap.value.costPerTurn !== false;
    }

    /**
     * Web Audio 现场合成，不依赖音频文件或网络：
     * 880Hz → 660Hz 两段正弦，约 0.36s，音量约 0.09。
     * 任何失败（无 AudioContext、被浏览器策略挂起、节点创建失败）都静默返回 false。
     */
    function playCompletionSound() {
      try {
        const Ctor = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
        if (!Ctor) return false;
        if (!audioCtx) audioCtx = new Ctor();
        if (audioCtx.state !== "running") {
          // 挂起时静默跳过：不弹 toast、不影响费用数字。
          if (typeof audioCtx.resume === "function") audioCtx.resume().catch(() => {});
          return false;
        }
        const now = audioCtx.currentTime;
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.09, now + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
        gain.connect(audioCtx.destination);
        const osc = audioCtx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(660, now + 0.14);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.36);
        return true;
      } catch {
        return false;
      }
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
        if (action === "recall" && value.refillText) {
          refillComposer(this.sessionId, value.refillText);
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

      const label = [
        tokens == null ? null : formatTokens(tokens) + " tok",
        words + " " + tt("stats.unit")
      ].filter(Boolean).join(" \u00b7 ");

      return e("span", {
        className: "dma-stats",
        title: tt("stats.title", { tokens: tokens == null ? "?" : tokens, words })
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

    // 确认弹窗 + 分享/导出浮层控制器（input.overlay 槽位）
    function OverlayController(props) {
      const { t: tt, useOverlay, useData, confirmAction, dismiss, runShare, runExport } = props;
      const view = useOverlay((v) => v.view);
      const data = useData((v) => v);

      if (!view) return null;

      if (view.kind === "confirm") {
        return e(ConfirmOverlay, {
          t: tt,
          view,
          onDismiss: dismiss,
          confirmAction
        });
      }

      if (view.kind === "pick") {
        return e(PickOverlay, {
          t: tt,
          mode: view.mode,
          seedTurn: view.turn,
          rounds: roundsOfData(data),
          onDismiss: () => dismiss(),
          runShare,
          runExport
        });
      }

      return null;
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

    // 设置页（settings.section 槽位）
    const SETTING_FIELDS = [
      ["recall", "settings.recall", "settings.recallDesc"],
      ["share", "settings.share", "settings.shareDesc"],
      ["export", "settings.export", "settings.exportDesc"],
      ["delete", "settings.delete", "settings.deleteDesc"],
      ["deleteFrom", "settings.deleteFrom", "settings.deleteFromDesc"],
      ["confirm", "settings.confirm", "settings.confirmDesc"],
      ["stats", "settings.stats", "settings.statsDesc"],
      ["sound", "settings.sound", "settings.soundDesc", true]
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
        e(CorrectionForm, { t: tt })
      );
    }

    function centsToInput(cents) {
      return Number.isFinite(cents) ? formatCents(cents) : "0.00";
    }

    function CorrectionForm({ t: tt }) {
      const snap = React.useSyncExternalStore(
        costStore.subscribe,
        costStore.getSnapshot,
        costStore.getSnapshot
      );
      const value = snap && snap.status === "ready" ? snap.value : null;
      const [credit, setCredit] = React.useState("0.00");
      const [debit, setDebit] = React.useState("0.00");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");
      const initialized = React.useRef(false);

      React.useEffect(() => {
        if (!value || initialized.current) return;
        initialized.current = true;
        setCredit(centsToInput(value.account.creditCents));
        setDebit(centsToInput(value.account.debitCents));
      }, [value]);

      const creditCheck = validateCorrectionAmount(credit === "" ? 0 : credit);
      const debitCheck = validateCorrectionAmount(debit === "" ? 0 : debit);
      const invalid = !creditCheck.ok || !debitCheck.ok;

      const account = value ? value.account : null;
      const baseline = account && Number.isFinite(account.baselineCents) ? account.baselineCents : null;
      const observed = account && Number.isFinite(account.observedSpendCents) ? account.observedSpendCents : 0;
      const previewCents = baseline === null
        ? null
        : baseline - observed + (creditCheck.ok ? creditCheck.cents : 0) - (debitCheck.ok ? debitCheck.cents : 0);

      async function submit() {
        if (invalid || busy) return;
        setBusy(true);
        setError("");
        let res;
        try {
          res = await postJson("/dsh-message-actions/cost/correction", {
            creditYuan: credit,
            debitYuan: debit
          });
        } catch {
          // 网络中断 / 宿主超时：给出可理解的反馈，不留未捕获 rejection。
          setError(tt("cost.correction.failed"));
          setBusy(false);
          return;
        }
        if (res.status === 200 && res.data && res.data.ok && res.data.value) {
          patchCostState({ status: "ready", value: res.data.value, fetchedAt: Date.now(), error: "" });
          setCredit(centsToInput(res.data.value.account.creditCents));
          setDebit(centsToInput(res.data.value.account.debitCents));
        } else {
          const code = res.data && res.data.error ? res.data.error.code : undefined;
          setError(tt(code === "INVALID_AMOUNT" ? "cost.correction.invalid" : "cost.correction.failed"));
        }
        setBusy(false);
      }

      return e("div", { className: "dma-correction" },
        e("div", { className: "dma-correction-title" }, tt("cost.correction.title")),
        e("div", { className: "dma-correction-row" },
          e("label", { className: "dma-correction-label" }, tt("cost.correction.credit")),
          e("span", { className: "dma-correction-input" },
            e("span", { className: "dma-correction-yuan" }, tt("cost.correction.yuan")),
            e("input", {
              type: "text",
              inputMode: "decimal",
              value: credit,
              disabled: busy,
              "aria-invalid": invalid ? "true" : "false",
              onChange: (ev) => setCredit(ev.target.value)
            })
          )
        ),
        e("div", { className: "dma-correction-row" },
          e("label", { className: "dma-correction-label" }, tt("cost.correction.debit")),
          e("span", { className: "dma-correction-input" },
            e("span", { className: "dma-correction-yuan" }, tt("cost.correction.yuan")),
            e("input", {
              type: "text",
              inputMode: "decimal",
              value: debit,
              disabled: busy,
              "aria-invalid": invalid ? "true" : "false",
              onChange: (ev) => setDebit(ev.target.value)
            })
          )
        ),
        e("div", { className: "dma-correction-row dma-correction-preview" },
          e("label", { className: "dma-correction-label" }, tt("cost.correction.preview")),
          e("span", {
            className: "dma-correction-value" + (previewCents !== null && previewCents < 0 ? " dma-correction-negative" : "")
          }, previewCents === null ? "—" : formatYuanCents(previewCents))
        ),
        e("div", { className: "dma-correction-row" },
          e("label", { className: "dma-correction-label" }, tt("cost.correction.pending")),
          e("span", { className: "dma-correction-value" },
            formatYuanCents(value && Number.isFinite(value.pendingAdjustmentCents) ? value.pendingAdjustmentCents : 0))
        ),
        invalid ? e("div", { className: "dma-setting-error" }, tt("cost.correction.invalid")) : null,
        previewCents !== null && previewCents < 0
          ? e("div", { className: "dma-correction-warn" }, tt("cost.correction.negative"))
          : null,
        error ? e("div", { className: "dma-setting-error" }, error) : null,
        e("p", { className: "dma-cost-note" }, tt("cost.note")),
        e("div", { className: "dma-correction-actions" },
          e("button", {
            type: "button",
            className: "dma-correction-save",
            disabled: invalid || busy,
            onClick: submit
          }, tt(busy ? "cost.correction.saving" : "cost.correction.save"))
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
          tabButton("billing", "cost.tab.billing")
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
            // 第一个标签页底部：只读版本号，不抢设置项视觉焦点。
            e("div", { className: "dma-settings-version" }, "v" + VERSION)
          )
          : e(BillingTab, { t: tt, form, value, save }),
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
      const lastTurn = value && value.lastTurn ? value.lastTurn : null;

      const balanceCents = balance && balance.updatedAt > 0 && Number.isFinite(balance.totalCents)
        ? balance.totalCents
        : null;
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
          ? tt("cost.railTitle", { balance: formatYuanCents(balanceCents) })
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
      const turnText = turnHidden || amountsHidden || !Number.isFinite(turnShown)
        ? "—"
        : formatCostMicros(Math.round(turnShown));

      const stale = status === "stale" && balanceCents !== null;
      const pending = value && Number.isFinite(value.pendingAdjustmentCents) && value.pendingAdjustmentCents > 0;
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
            e("button", {
              type: "button",
              className: "dma-cost-plain-row",
              onClick: refresh,
              title: stale ? staleTitle : tt("cost.refresh"),
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
                : null,
              pending ? e("span", { className: "dma-cost-badge", title: tt("cost.pendingTitle") }, tt("cost.pending")) : null
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
              title: stale ? staleTitle : tt("cost.refresh"),
              "aria-label": tt("cost.refresh"),
              "aria-busy": refreshing ? "true" : "false"
            },
              e("span", { className: "dma-cost-label" },
                tt("cost.balance"),
                pending ? e("span", { className: "dma-cost-badge", title: tt("cost.pendingTitle") }, tt("cost.pending")) : null,
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
              : null
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
.dma-correction{margin-top:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}
.dma-correction-title{margin-bottom:6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-correction-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:5px 0;font-size:13px}
.dma-correction-label{color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-correction-input{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff)}
.dma-correction-input input{width:110px;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;font-variant-numeric:tabular-nums;text-align:right}
.dma-correction-input input[aria-invalid="true"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dma-correction-yuan{color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-correction-value{color:var(--dsw-alias-label-primary,#1f2329);font-variant-numeric:tabular-nums}
.dma-correction-negative{color:var(--dsw-alias-state-error-primary,#e5484d);font-weight:600}
.dma-correction-warn{margin-top:4px;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}
.dma-cost-note{margin:10px 0 0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-correction-actions{display:flex;justify-content:flex-end;margin-top:8px}
.dma-correction-save{height:32px;padding:0 16px;border:0;border-radius:8px;background:var(--dsw-alias-button-primary-fill,#4c8dff);color:#fff;font-size:13px;cursor:pointer}
.dma-correction-save:disabled{background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-dimmed,#a0a6b0);cursor:default}
.dma-cost-item{flex:1 1 auto;min-width:0}
.dma-cost-card{display:flex;flex-direction:column;gap:3px;min-width:0;padding:5px 8px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-primary,#1f2329)}
.dma-cost-cols{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0}
.dma-cost-col{display:flex;align-items:baseline;gap:3px;min-width:0;flex:0 1 auto;text-align:left}
.dma-cost-balance{display:flex;align-items:baseline;gap:3px;min-width:0;border:0;border-radius:5px;padding:0 2px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.dma-cost-balance:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dma-cost-balance:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-cost-label{display:flex;align-items:center;gap:2px;overflow:hidden;font-size:11px;line-height:1.2;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-cost-value{overflow:hidden;font-size:14px;font-weight:600;line-height:1.25;white-space:nowrap;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.dma-cost-badge{flex:none;padding:0 4px;border-radius:7px;background:rgba(245,154,46,.16);color:#b56a00;font-size:10.5px;font-weight:500;line-height:15px}
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
.dma-cost-plain .dma-cost-badge{margin-left:auto}
.dma-cost-local{flex-direction:row;align-items:center;justify-content:center;gap:5px;padding:6px 8px}
.dma-cost-local.dma-cost-plain{justify-content:flex-start;gap:6px;padding:2px 2px}
.dma-cost-local-text{overflow:hidden;font-size:12px;line-height:1.3;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-cost-rail{display:flex;align-items:center;justify-content:center;width:100%;min-width:0;height:30px;border:0;border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-secondary,#5b6472);cursor:pointer}
.dma-cost-rail:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dma-cost-rail:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-cost-rail svg{width:16px;height:16px}
@keyframes dma-spin{to{transform:rotate(360deg)}}
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