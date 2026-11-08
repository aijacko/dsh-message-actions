import { randomUUID } from "node:crypto";
import fs from "node:fs";
import z from "@deepseek-ai/schemastery";
import shared from "./shared.cjs";
import store from "./store.cjs";
import http from "./http.cjs";
import sessionsPure from "./sessions.cjs";
import { createSessionManager } from "./session-manager.mjs";

const {
  sendJson,
  drainRequest,
  sendError,
  sendBadRequest,
  sendForbidden,
  sendMethodNotAllowed,
  readJsonBody,
  guardedHandler
} = http;

const {
  PRODUCER,
  TOMBSTONE_TEXT,
  planAction,
  roundsOf,
  createTurnLookup,
  liveNodesOf,
  messageIdOf,
  messagesSummaryOf,
  isTrustedRequest,
  attachmentMediaType,
  statusCodeOf,
  isBusyError,
  beijingDateKey,
  periodInfo,
  PRICE_TABLE,
  routeOfMessage,
  routeOfUsage,
  routingOfProvider,
  classifyRoute,
  priceEntryFor,
  costOfGroups,
  normalizeBillingOverrides,
  normalizePriceConfig,
  hostOfBaseUrl,
  costSwitches,
  deriveTurnUsage,
  createTurnBuffer,
  appendTurnEvent,
  observeBalance,
  validateCorrectionAmount,
  pruneDailySpend,
  yuanToCents,
  foldSessionStats,
  statsTimeline,
  statsSessionRow,
  statsSummary,
  statsBudget,
  settleSpend
} = shared;

const {
  resolveStatePath,
  loadCostState,
  persistCostState,
  DEFAULT_BUDGET_CENTS
} = store;

// ---------------------------------------------------------------------------
// 插件身份与依赖
// ---------------------------------------------------------------------------

const name = "dsh-message-actions";

const inject = ["webServer", "sessions", "agents"];

/**
 * 宿主配置。所有字段必须 `.volatile()`，否则官方配置通道不认；
 * 改 Config 需重启 DSH 生效。设置页顺序由这里的声明顺序决定。
 */
const Config = z.object({
  recall: z.boolean().default(true).volatile(),
  share: z.boolean().default(true).volatile(),
  export: z.boolean().default(true).volatile(),
  delete: z.boolean().default(true).volatile(),
  deleteFrom: z.boolean().default(true).volatile(),
  confirm: z.boolean().default(true).volatile(),
  stats: z.boolean().default(true).volatile(),
  // 0.2.2 起「完成提示音」不再有独立开关：由 soundTone 的「off」表示关闭。
  // 保留 sound 字段只为兼容旧配置（老配置 sound=false 视为关闭）。
  sound: z.boolean().default(true).volatile(),
  // 完成提示音音色：double | bell | soft | off。
  soundTone: z.string().default("double").volatile(),
  // 提示音音量 0–100（50 = 基准增益，0 = 静音），作用于全部音色。
  soundVolume: z.number().min(0).max(100).default(50).volatile(),

  // —— 费用统计（新增）——
  usageStats: z.boolean().default(true).volatile(),
  // 计费样式排在「单次消耗」之前；默认单行样式（compact）。
  costLayout: z.string().default("compact").volatile(),
  costPerTurn: z.boolean().default(true).volatile(),
  costPerTurnAutoClose: z.number().min(0).max(600).default(0).volatile(),
  costPeakValley: z.boolean().default(true).volatile()
});

// ---------------------------------------------------------------------------
// 信任围栏
// ---------------------------------------------------------------------------

/**
 * 请求入站三重围栏。回环 Host 与 Sec-Fetch-Site/Origin 校验为纯逻辑
 * （见 shared.cjs 的 isLoopbackHost / isTrustedRequest），此处仅实时解析
 * webServer 同源地址。
 */
function isTrusted(req, webServer) {
  let expectedOrigin;
  try {
    expectedOrigin = webServer.getOrigin();
  } catch {
    expectedOrigin = undefined;
  }
  return isTrustedRequest({
    host: req.headers.host,
    secFetchSite: req.headers["sec-fetch-site"],
    origin: req.headers.origin,
    expectedOrigin
  });
}

// ---------------------------------------------------------------------------
// 事件与随机 id
// ---------------------------------------------------------------------------

/** 由消息 id 反查表面节点的 seq；找不到返回 null。 */
function resolveSeqByMessageId(events, nodes, messageId) {
  for (const seq of nodes) {
    const event = events[seq];
    if (event && messageIdOf(event) === messageId) return seq;
  }
  return null;
}

function newTombstoneId() {
  try {
    return `dma-${randomUUID()}`;
  } catch {
    return `dma-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

// ---------------------------------------------------------------------------
// 路由处理器
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 附件回读（撤回后恢复图片 / 文件）
// ---------------------------------------------------------------------------

const ATTACHMENT_ROUTE = "/dsh-message-actions/attachment";

/** 在会话事件里按 attachmentId 找回原始附件引用（只查用户消息）。 */
function attachmentRefFromEvents(events, attachmentId) {
  for (const event of events) {
    if (!event || event.type !== "user/message") continue;
    const content = event.data && event.data.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || (block.type !== "image" && block.type !== "file")) continue;
      const ref = block.attachment;
      if (ref && ref.attachmentId === attachmentId) return { kind: block.type, ref: ref };
    }
  }
  return null;
}

/**
 * `/dsh-message-actions/attachment`：按 id 回读附件原字节。
 * 图片走 `attachments.readImage`（宿主归一化后的字节），文件走
 * `readFileStream`（原样字节）；响应直接流式返回，不经过 JSON 编码。
 */
function makeAttachmentHandler(ctx) {
  return async function handleAttachment(req, res) {
    if (req.method !== "GET") {
      drainRequest(req);
      sendMethodNotAllowed(res, "GET");
      return;
    }
    if (!isTrusted(req, ctx.webServer)) {
      drainRequest(req);
      sendForbidden(res);
      return;
    }
    let query;
    try {
      query = new URL(req.url, "http://localhost").searchParams;
    } catch {
      sendBadRequest(res);
      return;
    }
    const sessionId = query.get("sessionId") || "";
    const attachmentId = query.get("attachmentId") || "";
    if (!sessionId || !attachmentId) {
      sendBadRequest(res);
      return;
    }

    const agent = ctx.agents.get(sessionId);
    const session = agent && agent.session;
    if (!session || typeof session.snapshotEvents !== "function") {
      sendError(res, 409, "SESSION_NOT_LIVE");
      return;
    }
    const found = attachmentRefFromEvents(session.snapshotEvents(), attachmentId);
    if (!found) {
      sendError(res, 404, "ATTACHMENT_NOT_FOUND");
      return;
    }
    const store = ctx.get("attachments");
    if (!store) {
      sendError(res, 503, "ATTACHMENT_UNAVAILABLE");
      return;
    }

    const name = (found.ref && found.ref.name) || (found.kind === "image" ? "image" : "file");
    const headers = {
      "content-type": attachmentMediaType(found.ref && found.ref.mediaType, found.kind),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(name)
    };

    try {
      if (found.kind === "image") {
        if (typeof store.readImage !== "function") {
          sendError(res, 503, "ATTACHMENT_UNAVAILABLE");
          return;
        }
        const image = await store.readImage(found.ref);
        // 图片可能被宿主重新编码，长度与原始 ref.bytes 不同，必须用实际字节数。
        const bytes = Buffer.from(image.data);
        headers["content-length"] = bytes.length;
        res.writeHead(200, headers);
        res.end(bytes);
        return;
      }
      if (typeof store.readFileStream !== "function") {
        sendError(res, 503, "ATTACHMENT_UNAVAILABLE");
        return;
      }
      res.writeHead(200, headers);
      for await (const chunk of store.readFileStream(found.ref)) {
        res.write(chunk);
      }
      res.end();
    } catch {
      if (res.headersSent) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      sendError(res, 500, "ATTACHMENT_READ_FAILED");
    }
  };
}

// ---------------------------------------------------------------------------
// 删除动作
// ---------------------------------------------------------------------------

function makeActionHandler(ctx) {
  return async function handleAction(req, res) {
    if (req.method !== "POST") {
      drainRequest(req);
      sendMethodNotAllowed(res, "POST");
      return;
    }
    if (!isTrusted(req, ctx.webServer)) {
      drainRequest(req);
      sendForbidden(res);
      return;
    }
    const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      drainRequest(req);
      sendBadRequest(res);
      return;
    }

    const body = await readJsonBody(req, res);
    if (body === null) return;
    if (!body || typeof body !== "object") {
      sendBadRequest(res);
      return;
    }

    const { sessionId, action, seq, messageId } = body;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      sendBadRequest(res);
      return;
    }
    if (action !== "recall" && action !== "delete" && action !== "deleteFrom") {
      sendBadRequest(res);
      return;
    }
    const hasSeq = Number.isSafeInteger(seq) && seq >= 0;
    const hasMessageId = typeof messageId === "string" && messageId.length > 0;
    if (!hasSeq && !hasMessageId) {
      sendBadRequest(res);
      return;
    }

    const agent = ctx.agents.get(sessionId);
    if (agent === undefined || agent.session === undefined) {
      sendError(res, 409, "SESSION_NOT_LIVE");
      return;
    }
    const session = agent.session;
    if (agent.status === "running") {
      sendError(res, 423, "AGENT_BUSY");
      return;
    }

    const events = session.snapshotEvents();
    const nodes = [...session.surface.nodes];

    let targetSeq = seq;
    if (!hasSeq) {
      targetSeq = resolveSeqByMessageId(events, nodes, messageId);
      if (targetSeq === null) {
        sendError(res, 409, "TARGET_NOT_FOUND");
        return;
      }
    }

    const plan = planAction(events, nodes, { action, seq: targetSeq });
    if (!plan.ok) {
      sendError(res, statusCodeOf(plan.code), plan.code);
      return;
    }

    const data = {
      role: "user",
      id: newTombstoneId(),
      content: [{ type: "text", text: TOMBSTONE_TEXT[action] }],
      source: {
        kind: "user",
        producer: PRODUCER,
        action,
        via: plan.via,
        removed: plan.removed,
        kinds: plan.kinds,
        turn: plan.turn
      }
    };

    try {
      await agent.runMaintenance(async () => {
        session.append("user/message", data, {
          surfaceOp: { op: "replace", startSeq: plan.startSeq, endSeq: plan.endSeq },
          sourceEventSeqs: plan.removed
        });
        await ctx.sessions.flush(session);
      });
    } catch (err) {
      // 优先按结构化字段判定 busy（err.code / err.status）；宿主的忙错误目前
      // 没有 code，此时才回退到文案匹配。
      if (isBusyError(err)) {
        sendError(res, 423, "AGENT_BUSY");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (typeof ctx.logger?.warn === "function") {
        ctx.logger.warn(`[dsh-message-actions] ${action} failed: ${message}`);
      }
      sendError(res, 500, "INTERNAL");
      return;
    }

    sendJson(res, 200, {
      ok: true,
      value: {
        action,
        seq,
        via: plan.via,
        removed: plan.removed,
        turn: plan.turn,
        step: plan.step,
        refillText: plan.refillText,
        attachments: plan.attachments || []
      }
    });
  };
}

function makeMessagesHandler(ctx, cost) {
  return async function handleMessages(req, res) {
    if (req.method !== "GET") {
      drainRequest(req);
      sendMethodNotAllowed(res, "GET");
      return;
    }
    if (!isTrusted(req, ctx.webServer)) {
      drainRequest(req);
      sendForbidden(res);
      return;
    }
    const url = new URL(req.url || "/", "http://x");
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendBadRequest(res);
      return;
    }

    const agent = ctx.agents.get(sessionId);
    if (agent === undefined || agent.session === undefined) {
      sendError(res, 409, "SESSION_NOT_LIVE");
      return;
    }
    const session = agent.session;

    const events = session.snapshotEvents();
    const nodes = [...session.surface.nodes];

    // user/message 没有 data.turn（真实日志里只有 assistant/tool 带 turn），
    // 需要按 turn/start~turn/end 区间推导，否则问行按钮找不到对应 seq。
    // 一次构建索引与 seq→turn 映射，供 rows / rounds / goneTurns 复用。
    const turns = createTurnLookup(events);

    // 全文按需接口：只给分享图 / 导出使用，普通 3s 轮询不经过这里。
    if (url.searchParams.get("full") === "1") {
      const turnsParam = url.searchParams.get("turns");
      let turnFilter = null;
      if (turnsParam !== null && turnsParam !== "") {
        turnFilter = new Set(
          turnsParam.split(",")
            .filter((s) => s.trim() !== "")
            .map((s) => Number(s))
            .filter(Number.isSafeInteger)
        );
      }
      const rounds = roundsOf(events, nodes, turns);
      const liveNodes = liveNodesOf(events, nodes);
      const lastSeq = liveNodes.length > 0 ? liveNodes[liveNodes.length - 1] : 0;
      sendJson(res, 200, {
        ok: true,
        value: {
          version: Number.isSafeInteger(lastSeq) ? lastSeq : 0,
          nodeCount: liveNodes.length,
          rounds: turnFilter === null ? rounds : rounds.filter((round) => turnFilter.has(round.turn))
        }
      });
      return;
    }

    let filter = null;
    const seqsParam = url.searchParams.get("seqs");
    if (seqsParam !== null && seqsParam !== "") {
      filter = new Set(
        seqsParam.split(",")
          .filter((s) => s.trim() !== "")
          .map((s) => Number(s))
          .filter(Number.isSafeInteger)
      );
    }

    // 增量游标：since=<上次快照 version> 时只回新增行（不带 since 仍为全量）。
    // 选择游标而非 seqs 列表：seqs 在这里是「包含列表」，且长会话已持有 seq
    // 会无限增长；游标只传一个整数，语义与追加式事件日志天然吻合。
    const sinceParam = url.searchParams.get("since");
    let since = null;
    if (sinceParam !== null && sinceParam !== "") {
      const parsed = Number(sinceParam.trim());
      since = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }

    // 摘要轮询：只回 preview / words / usage / callId，不回正文。
    // 系统 / 开发者提示词与工具结果正文从不进入摘要（预览也只覆盖问 / 答）。
    sendJson(res, 200, {
      ok: true,
      value: messagesSummaryOf(events, nodes, turns, Object.assign(
        { filter, since, previewLimit: 200 },
        cost && typeof cost.classifyOptions === "function" ? cost.classifyOptions() : {}
      ))
    });
  };
}

// ---------------------------------------------------------------------------
// 费用统计服务（余额观测 + 单次结算 + 持久化状态）
// ---------------------------------------------------------------------------

const COST_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
// 结算推送：客户端长轮询最长等待时长，必须小于客户端 15s 请求超时。
const COST_SETTLE_WAIT_MS = 10 * 1000;
const COST_BALANCE_TIMEOUT_MS = 10 * 1000;
const ROUTING_TIMEOUT_MS = 3 * 1000;
const ROUTING_CACHE_MS = 5 * 1000;
// provider → baseURL 探测：缓存 60s；探测失败只用旧缓存，不阻塞事件结算。
const ENDPOINT_CACHE_MS = 60 * 1000;
const ENDPOINT_TIMEOUT_MS = 2 * 1000;
const DSH_VERSION_FALLBACK = "0.2.1";

/** getBalance 的客户端元数据：时区固定北京时间，不随本机漂移。 */
function accountClientMetadata() {
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  const version = typeof env.DSH_VERSION === "string" && env.DSH_VERSION.trim()
    ? env.DSH_VERSION.trim()
    : DSH_VERSION_FALLBACK;
  return { version, locale: "zh-CN", timezoneOffsetSeconds: 8 * 3600 };
}

/** 事件时刻：优先数值 time，其次 ISO 字符串，最后宿主收包时刻。 */
function eventTime(event) {
  if (event && typeof event === "object") {
    if (typeof event.time === "number" && Number.isFinite(event.time)) return event.time;
    if (typeof event.time === "string") {
      const parsed = Date.parse(event.time);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (event.data && typeof event.data.at === "number" && Number.isFinite(event.data.at)) {
      return event.data.at;
    }
  }
  return Date.now();
}

/** 钱包列表按 CNY 求和（其他币种忽略，不换算）。
 *  正金额按官方「账号与余额」的规则截断至分：API 原始字符串可能带三位以上小数，
 *  四舍五入会把 5.999… 显示成 6.00，与官方页面的 5.99 差一分。 */
function sumCnyWallets(wallets) {
  if (!Array.isArray(wallets)) return 0;
  let cents = 0;
  for (const wallet of wallets) {
    if (!wallet || typeof wallet !== "object") continue;
    if (wallet.currency !== "CNY") continue;
    const value = yuanToCents(wallet.balance, "truncate");
    if (value !== null) cents += value;
  }
  return cents;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("balance request timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function accountServiceOf(ctx) {
  try {
    const service = ctx.get("deepseekAccount");
    if (service && typeof service.getBalance === "function") return service;
  } catch {
    /* 服务缺失 */
  }
  return null;
}

async function hasApiKey(ctx) {
  try {
    const credentials = ctx.get("credentials");
    if (credentials && typeof credentials.resolve === "function") {
      const resolved = await credentials.resolve("DEEPSEEK_API_KEY");
      const value = resolved && typeof resolved === "object" ? resolved.value : resolved;
      if (typeof value === "string" && value.trim().length > 0) return true;
    }
  } catch {
    /* 凭据服务不可用，回退环境变量 */
  }
  const env = typeof process !== "undefined" && process.env ? process.env : {};
  return typeof env.DEEPSEEK_API_KEY === "string" && env.DEEPSEEK_API_KEY.trim().length > 0;
}

/**
 * 递归收集配置里 `providers.<id>.baseURL`（configEditor 返回的
 * `{ entry, inherited, override }[]`；也兼容其他嵌套形状）。
 */
function collectEndpointsFromConfig(node, keyHint, map, depth) {
  if (!node || typeof node !== "object" || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) collectEndpointsFromConfig(item, keyHint, map, depth + 1);
    return;
  }
  const baseUrl = node.baseURL || node.baseUrl;
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    const id = keyHint || node.id || node.name || node.provider;
    if (typeof id === "string" && id.trim()) map.set(id.trim().toLowerCase(), baseUrl.trim());
  }
  for (const [key, value] of Object.entries(node)) {
    collectEndpointsFromConfig(value, key, map, depth + 1);
  }
}

/** 从 profile patch YAML 里粗略提取 `providers.<id>.baseURL`（configEditor 不可用时的兜底）。 */
function collectEndpointsFromPatch(text, map) {
  const lines = String(text || "").split(/\r?\n/);
  let inProviders = false;
  let providersIndent = -1;
  let current = null;
  let providerIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)[0].length;
    const content = line.trim();
    if (/^providers:\s*$/.test(content)) {
      inProviders = true;
      providersIndent = indent;
      current = null;
      providerIndent = -1;
      continue;
    }
    if (inProviders && indent <= providersIndent) {
      inProviders = false;
      current = null;
      continue;
    }
    if (!inProviders) continue;
    const keyMatch = /^['"]?([\w.@-]+)['"]?:\s*$/.exec(content);
    if (keyMatch && indent > providersIndent) {
      if (providerIndent === -1) providerIndent = indent;
      if (indent === providerIndent) current = keyMatch[1];
      continue;
    }
    const baseMatch = /^baseURL:\s*(.+?)\s*$/.exec(content);
    if (baseMatch && current) {
      const value = baseMatch[1].replace(/^["']|["']$/g, "");
      if (value) map.set(current.toLowerCase(), value);
    }
  }
}

/**
 * 创建费用统计服务。内存状态为唯一读写源，写盘为整份原子替换。
 * @param ctx Cordis 宿主上下文
 * @param config 宿主 Config（volatile 对象）
 */
function createCostService(ctx, config) {
  const cfg = config || {};
  // 运行时读取开关，默认值与旧版保持一致（未配置 = 开启）。
  const switches = () => costSwitches(cfg);
  const isEnabled = () => switches().enabled;

  const statePath = resolveStatePath();
  const loaded = loadCostState(statePath, ctx.logger);
  const state = loaded.state;
  const readOnly = loaded.readOnly;

  if (!isEnabled()) {
    // 启动时总开关关闭：丢掉上次的余额基线，重新开启后首次观测只建基线，不补记关闭期间的差额。
    state.lastBalanceCents = null;
    state.lastBalanceAt = 0;
  }
  let lastEnabled = isEnabled();

  const cache = { rechargeCents: null, bonusCents: null, totalCents: null, updatedAt: 0 };
  const buffers = new Map();
  const MAX_BUFFERS = 200;
  let lastTurn = null;
  // 结算事件：客户端长轮询靠它即时唤醒，避免等下一次 5 秒轮询。
  const settleWaiters = new Set();
  function notifyTurnSettled() {
    for (const wake of [...settleWaiters]) {
      try {
        wake();
      } catch {
        // 单个等待者出错不影响其它客户端
      }
    }
  }
  function waitTurnSettled(ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        settleWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      settleWaiters.add(finish);
    });
  }
  let inFlight = null;
  let lastFetchFailed = false;
  let lastMessageProvider;
  let lastMessageModel;
  let lastHeaderProvider;
  let lastHeaderModel;
  let routingCache = { at: 0, value: null };
  // provider → baseURL：只缓存成功探测结果；失败时保留旧值并等待下次重试。
  const endpointCache = { at: 0, lastAttempt: 0, map: new Map(), source: "none", pending: null };
  // 价格表 / 覆盖清单变更时递增，统计折叠缓存据此失效并重算历史。
  let billingRevision = 0;
  // provider → baseURL 变化时递增，避免历史统计沿用旧的本地 / 第三方判定。
  let endpointRevision = 0;

  const warn = (message) => {
    if (typeof ctx.logger?.warn === "function") ctx.logger.warn(`[dsh-message-actions] ${message}`);
  };

  /**
   * 写盘并返回结果：`{ ok:true }` 或 `{ ok:false, error }`。
   * 只读 / 写入失败不再被吞掉——调用方（余额校正路由）据此返回 500，
   * 避免客户端把未落盘的写操作显示为成功。
   */
  function persist() {
    state.updatedAt = Date.now();
    state.dailySpendCents = pruneDailySpend(state.dailySpendCents, state.updatedAt, shared.DAILY_KEEP_DAYS);
    return persistCostState(statePath, state, readOnly, ctx.logger);
  }

  /**
   * 探测 provider → baseURL。三级来源（新版优先，逐级回退）：
   * 1. `llm.listProviders()`（返回 baseUrl）；
   * 2. `configEditor.configuration()`（providers.<id>.baseURL）；
   * 3. profile patch YAML 文本（粗解析）。
   * 探测失败不会清空旧缓存，也不会影响按钮注入。
   */
  async function refreshEndpoints(force) {
    const now = Date.now();
    if (!force && endpointCache.at > 0 && now - endpointCache.at < ENDPOINT_CACHE_MS) {
      return endpointCache;
    }
    let map = new Map();
    let source = "none";

    try {
      const llm = ctx.get("llm");
      if (llm && typeof llm.listProviders === "function") {
        const list = await withTimeout(Promise.resolve(llm.listProviders()), ENDPOINT_TIMEOUT_MS);
        for (const provider of Array.isArray(list) ? list : []) {
          if (!provider || typeof provider !== "object") continue;
          const id = provider.id || provider.name || provider.provider;
          const baseUrl = provider.baseUrl || provider.baseURL;
          if (typeof id === "string" && typeof baseUrl === "string" && baseUrl.trim()) {
            map.set(id.trim().toLowerCase(), baseUrl.trim());
          }
        }
        if (map.size > 0) source = "llm";
      }
    } catch {
      /* 旧宿主没有 llm 服务或接口不同：继续下一级 */
    }

    // 第二级：配置编辑器（补齐 llm 没给出的 provider，不覆盖 llm 的结果）。
    {
      try {
        const editor = ctx.get("configEditor");
        if (editor && typeof editor.configuration === "function") {
          const rows = await withTimeout(Promise.resolve(editor.configuration()), ENDPOINT_TIMEOUT_MS);
          const collected = new Map();
          for (const row of Array.isArray(rows) ? rows : []) {
            collectEndpointsFromConfig(row && row.inherited, "", collected, 0);
            collectEndpointsFromConfig(row && row.override, "", collected, 0);
          }
          let added = 0;
          for (const [key, value] of collected) {
            if (!map.has(key)) {
              map.set(key, value);
              added += 1;
            }
          }
          if (added > 0) source = source === "none" ? "config-editor" : "llm+config-editor";
        }
      } catch {
        /* 配置服务不可用：继续兜底 */
      }
    }

    // 第三级：profile patch 文本（最后兜底，同样只补缺失项）。
    {
      try {
        const profile = ctx.get("profileContext");
        const patchPath = profile && typeof profile.patchPath === "string" ? profile.patchPath : "";
        if (patchPath) {
          const text = await fs.promises.readFile(patchPath, "utf8");
          const collected = new Map();
          collectEndpointsFromPatch(text, collected);
          let added = 0;
          for (const [key, value] of collected) {
            if (!map.has(key)) {
              map.set(key, value);
              added += 1;
            }
          }
          if (added > 0) source = source === "none" ? "profile-patch" : source + "+profile-patch";
        }
      } catch {
        /* 文件读取失败：保持旧缓存 */
      }
    }

    endpointCache.lastAttempt = Date.now();
    if (map.size === 0) {
      // 上一轮什么都没探测到：不缓存空结果，下次调用立即重试。
      endpointCache.at = 0;
    } else {
      const changed = map.size !== endpointCache.map.size ||
        [...map.entries()].some(([key, value]) => endpointCache.map.get(key) !== value);
      if (changed) endpointRevision += 1;
      endpointCache.at = Date.now();
      endpointCache.map = map;
      endpointCache.source = source;
    }
    return endpointCache;
  }

  /** 非阻塞探测：同一时刻只跑一次；15s 内不重复敲宿主。 */
  function scheduleEndpointRefresh() {
    if (endpointCache.pending) return endpointCache.pending;
    if (endpointCache.lastAttempt > 0 && Date.now() - endpointCache.lastAttempt < 15 * 1000) {
      return Promise.resolve(endpointCache);
    }
    endpointCache.pending = refreshEndpoints(true)
      .catch(() => {})
      .finally(() => {
        endpointCache.pending = null;
      });
    return endpointCache.pending;
  }

  /** 当前计费配置（覆盖清单 + 第三方价格表）。 */
  function billingConfig() {
    if (!state.billing || typeof state.billing !== "object") {
      state.billing = { overrides: {}, prices: normalizePriceConfig(null), updatedAt: 0 };
    }
    return state.billing;
  }

  /** 传给 classifyRoute / priceEntryFor 的统一口径。 */
  function classifyOptions() {
    const billing = billingConfig();
    return {
      endpoints: Object.fromEntries(endpointCache.map),
      overrides: normalizeBillingOverrides(billing.overrides),
      prices: normalizePriceConfig(billing.prices)
    };
  }

  /** 单条路由的分类 + 价目（供费用卡片 / 统计诊断使用）。 */
  function classifyRouteInfo(provider, model) {
    const options = classifyOptions();
    const classification = classifyRoute({ provider, model }, options);
    if (!classification.confirmed) scheduleEndpointRefresh();
    const pricing = priceEntryFor({ provider, model }, Object.assign({}, options, { classification }));
    return {
      kind: classification.kind,
      billable: classification.billable,
      local: classification.local,
      confirmed: classification.confirmed,
      official: classification.official,
      source: classification.source,
      reason: classification.reason,
      baseUrl: classification.baseUrl,
      host: classification.host,
      provider: provider || "",
      model: model || "",
      priceSource: pricing.source,
      priceMatched: pricing.matched
    };
  }

  /** 保存计费配置（覆盖清单 / 价格表），失败回滚。 */
  function applyBilling(input) {
    const previous = billingConfig();
    const next = {
      overrides: normalizeBillingOverrides(input && input.overrides !== undefined ? input.overrides : previous.overrides),
      prices: normalizePriceConfig(input && input.prices !== undefined ? input.prices : previous.prices),
      updatedAt: Date.now()
    };
    state.billing = next;
    const saved = persist();
    if (!saved.ok) {
      state.billing = previous;
      return saved;
    }
    billingRevision += 1;
    return { ok: true, value: next };
  }

  /** 诊断信息：当前探测到的 provider → baseURL（不回传凭据）。 */
  function endpointDiagnostics() {
    const options = classifyOptions();
    return [...endpointCache.map.entries()].map(([provider, baseUrl]) => {
      const host = hostOfBaseUrl(baseUrl);
      const classification = classifyRoute({ provider, model: "" }, options);
      const pricing = priceEntryFor({ provider, model: "" }, Object.assign({}, options, { classification }));
      return {
        provider,
        baseUrl,
        host,
        kind: classification.kind,
        local: classification.local,
        billable: classification.billable,
        priceSource: pricing.source
      };
    });
  }

  async function routingInfo() {
    const now = Date.now();
    if (routingCache.value && now - routingCache.at < ROUTING_CACHE_MS) return routingCache.value;

    const provider = lastMessageProvider || lastHeaderProvider;
    const mapped = routingOfProvider(provider);
    const finish = (value) => {
      routingCache = { at: Date.now(), value };
      return value;
    };
    // 余额轮询只跟 DeepSeek 账户有关；第三方 / 本地明确不查余额。
    if (mapped === "account" || mapped === "api-key") return finish({ routing: mapped, provider });
    if (mapped === "other") return finish({ routing: "third-party", provider });

    let hasKey = false;
    try {
      hasKey = await withTimeout(Promise.resolve(hasApiKey(ctx)), ROUTING_TIMEOUT_MS);
    } catch {
      hasKey = false; // 凭据服务卡住时按未配置处理，继续尝试账户路由
    }
    if (hasKey) return finish({ routing: "api-key", provider: "deepseek-official" });

    const account = accountServiceOf(ctx);
    if (!account) return finish({ routing: "unavailable", provider: undefined });
    try {
      const snapshot = await withTimeout(Promise.resolve(account.getState()), ROUTING_TIMEOUT_MS);
      const status = snapshot && typeof snapshot === "object" ? snapshot.status : undefined;
      if (status === "credential-stored") return finish({ routing: "account", provider: "deepseek-account" });
      return finish({ routing: "signed-out", provider: undefined });
    } catch {
      return finish({ routing: "unavailable", provider: undefined });
    }
  }

  async function fetchOnce() {
    const routing = (await routingInfo()).routing;
    if (routing !== "account") {
      lastFetchFailed = false;
      return;
    }
    state.lastAttemptAt = Date.now();
    const account = accountServiceOf(ctx);
    if (!account) {
      lastFetchFailed = true;
      return;
    }
    let result;
    try {
      result = await withTimeout(
        Promise.resolve(account.getBalance(accountClientMetadata())),
        COST_BALANCE_TIMEOUT_MS
      );
    } catch {
      lastFetchFailed = true;
      return;
    }
    if (!result || typeof result !== "object" || (typeof result.status === "string" && result.status !== "ready")) {
      lastFetchFailed = true;
      return;
    }
    const rechargeCents = sumCnyWallets(result.value);
    const bonusCents = sumCnyWallets(result.bonusWallets);
    const totalCents = rechargeCents + bonusCents;
    const at = Date.now();

    cache.rechargeCents = rechargeCents;
    cache.bonusCents = bonusCents;
    cache.totalCents = totalCents;
    cache.updatedAt = at;
    lastFetchFailed = false;

    const observed = observeBalance(state, { cents: totalCents, routing: "account", at });
    Object.assign(state, observed.state);
    state.lastAttemptAt = at;
    persist();
  }

  /** 背景 / 强制刷新；单飞 + 60s 节流 + 10s 超时。 */
  function refresh(force) {
    const enabled = isEnabled();
    if (enabled !== lastEnabled) {
      lastEnabled = enabled;
      if (!enabled) {
        // 运行中关闭总开关：与「启动时已关闭」同路径，丢弃余额基线。
        // 重新开启后首次观测只建基线，不把关闭期间的消费计入「日用」。
        state.lastBalanceCents = null;
        state.lastBalanceAt = 0;
        persist();
      }
    }
    if (!enabled) return Promise.resolve();
    if (inFlight) return inFlight;
    const now = Date.now();
    if (!force && now - state.lastAttemptAt < COST_REFRESH_MIN_INTERVAL_MS) return Promise.resolve();
    inFlight = fetchOnce()
      .catch((err) => {
        lastFetchFailed = true;
        warn(`balance refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /**
   * 保存预算（分）。落盘失败时回滚内存值：
   * 不把未落盘的设置伪装成成功。
   */
  function applyBudget(cents) {
    const previous = state.budgetCents;
    state.budgetCents = Math.max(0, Math.round(Number.isFinite(cents) ? cents : 0));
    const saved = persist();
    if (!saved.ok) state.budgetCents = previous;
    return saved;
  }

  /** 当前预算（分）；旧状态文件缺字段时回落到默认 ¥5。 */
  function budgetCents() {
    return Number.isFinite(state.budgetCents) && state.budgetCents >= 0
      ? Math.round(state.budgetCents)
      : DEFAULT_BUDGET_CENTS;
  }

  async function stateValue() {
    const now = Date.now();
    const routing = (await routingInfo()).routing;
    const provider = lastMessageProvider || lastHeaderProvider;
    const model = lastMessageModel || lastHeaderModel;
    // 还没有任何 provider 时不做「第三方 / 来源未确认」判定，避免启动瞬间误报。
    const route = provider ? classifyRouteInfo(provider, model) : null;
    let status;
    if (routing === "third-party") status = route && route.local ? "local" : "third-party";
    else if (routing === "signed-out") status = "signed-out";
    else if (routing === "api-key") status = "api-key";
    else if (routing === "unavailable") status = "unavailable";
    else status = cache.updatedAt > 0 && !lastFetchFailed ? "ready" : "stale";

    const period = periodInfo(now);
    return {
      status,
      billing: routing,
      route,
      balance: {
        rechargeCents: cache.rechargeCents,
        bonusCents: cache.bonusCents,
        totalCents: cache.totalCents,
        updatedAt: cache.updatedAt,
        refreshing: inFlight !== null
      },
      dailyCents: state.dailySpendCents[beijingDateKey(now)] || 0,
      observedSpendCents: state.observedSpendTotalCents,
      period: period.period,
      nextChangeAt: period.nextChangeAt,
      lastTurn: switches().perTurn ? lastTurn : null
    };
  }

  /** 会话事件：跟踪最近模型路由，并在 turn/end 时结算本轮。 */
  function onSessionEvent(session, event) {
    if (!isEnabled()) return;
    if (!event || typeof event !== "object") return;
    const sessionId = session && typeof session.id === "string" ? session.id : undefined;
    if (!sessionId) return;
    const type = event.type;
    const data = event.data || {};

    if (type === "assistant/message") {
      const route = routeOfUsage(data.usage) || routeOfMessage(data.message);
      if (route) {
        lastMessageProvider = route.provider;
        lastMessageModel = route.model;
        routingCache = { at: 0, value: null };
        if (!endpointCache.map.has(route.provider.trim().toLowerCase())) scheduleEndpointRefresh();
      }
    } else if (type === "request/header") {
      const config = data.header && data.header.config;
      const provider = config ? config.provider : undefined;
      if (typeof provider === "string" && provider.length > 0) {
        lastHeaderProvider = provider;
        if (config && typeof config.model === "string" && config.model) lastHeaderModel = config.model;
        routingCache = { at: 0, value: null };
        if (!endpointCache.map.has(provider.trim().toLowerCase())) scheduleEndpointRefresh();
      }
    }

    if (!switches().perTurn) {
      // 运行中关闭「单次」后不再保留旧的 lastTurn，避免重新开启时闪回过期金额；
      // 但当日用量仍按结算累加（统计表与费用卡片共用这一份数字）。
      lastTurn = null;
    }
    if (type === "turn/start") {
      // 防御性上限：会话中途异常结束（没有 turn/end）时不让缓冲无限增长。
      if (buffers.size >= MAX_BUFFERS && !buffers.has(sessionId)) {
        const oldest = buffers.keys().next();
        if (!oldest.done) buffers.delete(oldest.value);
      }
      buffers.set(sessionId, createTurnBuffer(
        Number.isSafeInteger(data.turn) ? data.turn : undefined,
        eventTime(event)
      ));
      return;
    }

    const buffer = buffers.get(sessionId);
    if (!buffer) return; // 未见 turn/start：不回放历史
    appendTurnEvent(buffer, event);
    if (type !== "turn/end") return;

    buffers.delete(sessionId);
    if (buffer.overflow) return;
    const usage = deriveTurnUsage(buffer.events);
    if (!usage) return;
    const at = Number.isFinite(usage.at) ? usage.at : buffer.at;
    const period = periodInfo(at).period;
    const endedAt = Number.isFinite(usage.endedAt) ? usage.endedAt : eventTime(event);
    // 默认计费，只有确认为本地才免；第三方未配置价格时 token 仍计数、金额不进「日用」。
    const billing = costOfGroups(usage.groups, period, classifyOptions());
    const costMicros = billing.micros;
    const turn = Number.isSafeInteger(usage.turn) ? usage.turn : buffer.turn;

    // 结算即累加：当日用量与「单次」同一时刻更新，余额观测随后只补差额。
    const settled = settleSpend(state, {
      micros: costMicros,
      at: endedAt,
      key: `${sessionId}:${turn == null ? "" : turn}:${endedAt}`
    });
    if (settled.applied) {
      Object.assign(state, settled.state);
      persist();
    }

    if (!switches().perTurn) return;
    lastTurn = {
      at,
      endedAt,
      provider: usage.provider,
      models: usage.models,
      tokens: usage.tokens,
      costMicros,
      billableTokens: billing.billableTokens,
      localTokens: billing.localTokens,
      unpricedTokens: billing.unpricedTokens,
      hasUnpriced: billing.hasUnpriced,
      priceSources: billing.sources,
      turn
    };
    notifyTurnSettled();
  }

  function dispose() {
    buffers.clear();
    inFlight = null;
  }

  return {
    isEnabled,
    isPerTurn: () => switches().perTurn,
    lastTurnAt: () => (lastTurn && Number.isFinite(lastTurn.at) ? lastTurn.at : null),
    waitTurnSettled,
    refresh,
    stateValue,
    applyBudget,
    budgetCents,
    onSessionEvent,
    dispose,
    state,
    readOnly,
    refreshEndpoints,
    classifyOptions,
    classifyRouteInfo,
    billingRevision: () => billingRevision,
    endpointRevision: () => endpointRevision,
    applyBilling,
    endpointDiagnostics,
    endpointSource: () => endpointCache.source
  };
}

// ---------------------------------------------------------------------------
// 费用统计路由
// ---------------------------------------------------------------------------

function makeCostStateHandler(ctx, service) {
  return async function handleCostState(req, res) {
    if (req.method !== "GET") {
      drainRequest(req);
      sendMethodNotAllowed(res, "GET");
      return;
    }
    if (!isTrusted(req, ctx.webServer)) {
      drainRequest(req);
      sendForbidden(res);
      return;
    }
    try {
      const url = new URL(req.url || "/", "http://x");
      const force = url.searchParams.get("refresh") === "1";
      // wait=<lastTurn.at>：长轮询挂起，结算完成立即返回（上限 10s，短于客户端 15s 超时）。
      const waitRaw = url.searchParams.get("wait");
      const waitAt = waitRaw === null || waitRaw === "" ? null : Number(waitRaw);
      if (service.isEnabled()) {
        if (force) await service.refresh(true);
        else service.refresh(false).catch(() => {});
      }
      if (!force && Number.isFinite(waitAt) && service.isPerTurn()) {
        const lastAt = service.lastTurnAt();
        if (lastAt === null || lastAt === waitAt) await service.waitTurnSettled(COST_SETTLE_WAIT_MS);
      }
      if (res.destroyed) return;
      sendJson(res, 200, { ok: true, value: await service.stateValue() });
    } catch (err) {
      if (typeof ctx.logger?.warn === "function") {
        ctx.logger.warn(`[dsh-message-actions] cost state failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      sendError(res, 500, "INTERNAL");
    }
  };
}

// ---------------------------------------------------------------------------
// 会话统计：读真实会话日志（复用官方 sessionQuery，不新建采集器）
// ---------------------------------------------------------------------------

const STATS_ROUTE = "/dsh-message-actions/stats";
const STATS_BUDGET_ROUTE = "/dsh-message-actions/stats/budget";
const BILLING_ROUTE = "/dsh-message-actions/billing";
/** 同一会话日志的折叠结果缓存 4s，避免每次刷新都重读大文件。 */
const STATS_FOLD_TTL_MS = 4000;
/** 会话表最多返回 100 行，避免大型工作区一次传输过多数据。 */
const STATS_SESSION_ROWS = 100;
/** 折叠缓存上限：超出后丢弃最早插入的一项。 */
const STATS_FOLD_CACHE_MAX = 300;

function sessionQueryOf(ctx) {
  try {
    const service = ctx.get("sessionQuery");
    if (service && typeof service.listSessions === "function" && typeof service.readSession === "function") {
      return service;
    }
  } catch {
    /* 宿主未提供该服务 */
  }
  return null;
}

/**
 * 会话统计服务：枚举会话、按 revision 折叠日志，产出与费用卡片同一价目口径的
 * token / 成本 / 时间线 / 会话表。数据源只有官方日志，不另建采集器。
 */
function createStatsService(ctx, cost, config) {
  const folds = new Map();
  const warn = (message) => {
    if (typeof ctx.logger?.warn === "function") ctx.logger.warn(`[dsh-message-actions] ${message}`);
  };

  async function revisionOf(sessionId) {
    try {
      const store = ctx.get("sessionPersistence");
      if (!store || typeof store.stat !== "function") return undefined;
      const snapshot = await store.stat(sessionId);
      if (snapshot === undefined) return "missing";
      return String(snapshot.revision ?? `${snapshot.eventCount ?? ""}:${snapshot.sizeBytes ?? ""}`);
    } catch {
      return undefined;
    }
  }

  async function foldFor(record) {
    const id = record && record.header && typeof record.header.id === "string" ? record.header.id : "";
    if (!id) return null;
    const query = sessionQueryOf(ctx);
    if (!query) return null;
    const cached = folds.get(id);
    const now = Date.now();
    const billingRevision = cost.billingRevision();
    const endpointRevision = cost.endpointRevision();
    const sameBilling = cached !== undefined &&
      cached.billingRevision === billingRevision && cached.endpointRevision === endpointRevision;
    if (sameBilling && now - cached.at < STATS_FOLD_TTL_MS) {
      return cached.fold;
    }
    const revision = await revisionOf(id);
    if (sameBilling && revision !== undefined && cached.revision === revision) {
      cached.at = now;
      return cached.fold;
    }
    let snapshot;
    try {
      snapshot = await query.readSession(id);
    } catch (err) {
      warn(`could not read session "${id}": ${err instanceof Error ? err.message : String(err)}`);
      return cached !== undefined ? cached.fold : null;
    }
    // 价格表 / 覆盖清单一变，历史按新口径重算（billingRevision 参与缓存键）。
    const fold = foldSessionStats(
      Array.isArray(snapshot && snapshot.events) ? snapshot.events : [],
      cost.classifyOptions()
    );
    if (folds.size >= STATS_FOLD_CACHE_MAX && !folds.has(id)) {
      const oldest = folds.keys().next();
      if (!oldest.done) folds.delete(oldest.value);
    }
    folds.set(id, { revision, at: now, fold, billingRevision, endpointRevision });
    return fold;
  }

  function runningSet() {
    const running = new Set();
    try {
      const agents = ctx.get("agents");
      if (agents && typeof agents.list === "function") {
        for (const agent of agents.list()) {
          if (!agent || agent.status !== "running") continue;
          const id = agent.session && typeof agent.session.id === "string" ? agent.session.id : agent.id;
          if (typeof id === "string") running.add(id);
        }
      }
    } catch {
      /* 运行状态只是装饰列 */
    }
    return running;
  }

  async function buildPayload() {
    const now = Date.now();
    // 先刷新 provider → baseURL（失败沿用旧缓存），再折叠历史，避免用空映射误判。
    await cost.refreshEndpoints(false).catch(() => {});
    const query = sessionQueryOf(ctx);
    let records = [];
    if (query) {
      try {
        records = await query.listSessions();
      } catch (err) {
        warn(`session list failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const running = runningSet();
    const rows = [];
    const points = [];
    for (const record of Array.isArray(records) ? records : []) {
      const fold = await foldFor(record);
      if (fold === null) continue;
      const id = record && record.header && typeof record.header.id === "string" ? record.header.id : "";
      rows.push(statsSessionRow(record && record.header, fold, {
        running: running.has(id),
        live: record && record.live === true
      }));
      for (const point of fold.points) points.push(point);
    }
    rows.sort((left, right) => right.tokens.total - left.tokens.total || right.lastActiveAt - left.lastActiveAt);
    const summary = statsSummary(rows);
    const budget = statsBudget(summary.costMicros, cost.budgetCents());
    // 余额口径（费用卡片）：只作对照，不参与估算成本与预算。
    let ledger = null;
    try {
      const value = await cost.stateValue();
      const b = (value.balance && typeof value.balance === "object") ? value.balance : {};
      const rechargeCents = Number.isFinite(b.rechargeCents) ? b.rechargeCents : null;
      const bonusCents = Number.isFinite(b.bonusCents) ? b.bonusCents : null;
      const totalCents = Number.isFinite(b.totalCents) ? b.totalCents : null;
      // 与侧边栏费用卡片完全同一口径：充值余额 + 赠金钱包 = 账户可用总余额。
      const balanceCents = totalCents !== null ? totalCents : rechargeCents;
      ledger = {
        balanceCents,
        rechargeCents,
        bonusCents,
        totalCents,
        dailyCents: Number.isFinite(value.dailyCents) ? value.dailyCents : 0,
        observedSpendCents: Number.isFinite(value.observedSpendCents) ? value.observedSpendCents : 0,
        lastTurnMicros: value.lastTurn && Number.isFinite(value.lastTurn.costMicros) ? value.lastTurn.costMicros : null
      };
    } catch {
      ledger = null;
    }
    const billingOptions = cost.classifyOptions();
    return {
      available: query !== null,
      generatedAt: now,
      currency: "CNY",
      currencySymbol: "¥",
      budget,
      totals: { ...summary, costCents: Math.round(summary.costMicros / 10000) },
      series: statsTimeline(points, now),
      sessions: rows.slice(0, STATS_SESSION_ROWS),
      sessionsTotal: rows.length,
      truncated: rows.length > STATS_SESSION_ROWS,
      ledger,
      billing: {
        revision: cost.billingRevision(),
        endpointSource: cost.endpointSource(),
        endpoints: cost.endpointDiagnostics(),
        overrides: billingOptions.overrides,
        prices: billingOptions.prices,
        officialPrices: Object.keys(PRICE_TABLE).filter((key) => key !== "default")
      }
    };
  }

  /**
   * 会话列表用的轻量元数据：复用同一份折叠缓存与 revision 判断，
   * 避免「打开会话管理」再解压一遍全部日志。
   */
  async function sessionMeta(record) {
    const fold = await foldFor(record);
    if (!fold) return null;
    return {
      model: typeof fold.model === "string" ? fold.model : "",
      provider: typeof fold.provider === "string" ? fold.provider : "",
      title: typeof fold.title === "string" ? fold.title : "",
      messages: Number.isFinite(fold.messages) ? fold.messages : 0,
      turns: Number.isFinite(fold.turns) ? fold.turns : 0,
      tokens: fold.tokens && Number.isFinite(fold.tokens.total) ? fold.tokens.total : 0,
      lastActiveAt: Number.isFinite(fold.lastActiveAt) ? fold.lastActiveAt : 0
    };
  }

  /** 同一时刻只跑一次折叠：刷新按钮与定时轮询撞车时复用同一个 Promise。 */
  let inflight = null;
  function payload() {
    if (inflight !== null) return inflight;
    const task = buildPayload();
    inflight = task;
    task
      .finally(() => {
        if (inflight === task) inflight = null;
      })
      .catch(() => {});
    return task;
  }

  return { payload, sessionMeta };
}

function makeStatsHandler(ctx, service) {
  return async function handleStats(req, res) {
    if (req.method !== "GET") {
      drainRequest(req);
      sendMethodNotAllowed(res, "GET");
      return;
    }
    if (!isTrusted(req, ctx.webServer)) {
      drainRequest(req);
      sendForbidden(res);
      return;
    }
    try {
      sendJson(res, 200, { ok: true, value: await service.payload() });
    } catch (err) {
      if (typeof ctx.logger?.warn === "function") {
        ctx.logger.warn(`[dsh-message-actions] stats failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      sendError(res, 500, "INTERNAL");
    }
  };
}

function makeStatsBudgetHandler(ctx, cost) {
  return async function handleStatsBudget(req, res) {
    if (req.method !== "POST") {
      drainRequest(req);
      sendMethodNotAllowed(res, "POST");
      return;
    }
    if (!isTrusted(req, ctx.webServer)) {
      drainRequest(req);
      sendForbidden(res);
      return;
    }
    const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      drainRequest(req);
      sendBadRequest(res);
      return;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    if (!body || typeof body !== "object") {
      sendBadRequest(res);
      return;
    }
    const amount = validateCorrectionAmount(body.budgetYuan);
    if (!amount.ok) {
      sendError(res, 400, "INVALID_AMOUNT");
      return;
    }
    try {
      const saved = cost.applyBudget(amount.cents);
      if (!saved.ok) {
        sendError(res, 500, saved.error);
        return;
      }
      sendJson(res, 200, { ok: true, value: { budgetCents: cost.budgetCents() } });
    } catch (err) {
      if (typeof ctx.logger?.warn === "function") {
        ctx.logger.warn(`[dsh-message-actions] budget save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      sendError(res, 500, "INTERNAL");
    }
  };
}

/**
 * `/dsh-message-actions/billing`：读取 / 保存计费覆盖清单与第三方价格表。
 * GET  返回 `{ overrides, prices, endpoints, endpointSource, officialPrices }`
 * POST 接受 `{ overrides?, prices? }`（对象或文本），保存后历史统计立即按新价重算。
 */
function makeBillingHandler(ctx, cost) {
  return async function handleBilling(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {
      drainRequest(req);
      sendMethodNotAllowed(res, "GET, POST");
      return;
    }
    if (!isTrusted(req, ctx.webServer)) {
      drainRequest(req);
      sendForbidden(res);
      return;
    }
    if (req.method === "GET") {
      try {
        await cost.refreshEndpoints(false).catch(() => {});
        const options = cost.classifyOptions();
        sendJson(res, 200, {
          ok: true,
          value: {
            overrides: options.overrides,
            prices: options.prices,
            endpoints: cost.endpointDiagnostics(),
            endpointSource: cost.endpointSource(),
            officialPrices: Object.keys(PRICE_TABLE).filter((key) => key !== "default"),
            officialTable: PRICE_TABLE
          }
        });
      } catch (err) {
        if (typeof ctx.logger?.warn === "function") {
          ctx.logger.warn(`[dsh-message-actions] billing read failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        sendError(res, 500, "INTERNAL");
      }
      return;
    }
    const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      drainRequest(req);
      sendBadRequest(res);
      return;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendBadRequest(res);
      return;
    }
    try {
      const saved = cost.applyBilling({ overrides: body.overrides, prices: body.prices });
      if (!saved.ok) {
        sendError(res, 500, saved.error);
        return;
      }
      const options = cost.classifyOptions();
      sendJson(res, 200, {
        ok: true,
        value: {
          overrides: options.overrides,
          prices: options.prices,
          revision: cost.billingRevision()
        }
      });
    } catch (err) {
      if (typeof ctx.logger?.warn === "function") {
        ctx.logger.warn(`[dsh-message-actions] billing save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      sendError(res, 500, "INTERNAL");
    }
  };
}

// ---------------------------------------------------------------------------
// 会话管理路由
// ---------------------------------------------------------------------------

const SESSIONS_ROUTE = "/dsh-message-actions/sessions";
const MAX_SESSION_BATCH = 50;
/** 删除类操作的确认口令：输入 OK（大小写不敏感、忽略首尾空格）。 */
const SESSION_CONFIRM_CODE = "OK";

function isSessionConfirm(value) {
  return typeof value === "string" && value.trim().toUpperCase() === SESSION_CONFIRM_CODE;
}

/** 解析去重后的 id 数组；数量、类型或重复项不合法都返回 null。 */
function readIdList(body, key) {
  const list = body ? body[key] : null;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SESSION_BATCH) return null;
  const out = [];
  const seen = new Set();
  for (const value of list) {
    if (typeof value !== "string" || value === "" || seen.has(value)) return null;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function makeSessionsHandler(ctx, sessions) {
  return async function handleSessions(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {
      drainRequest(req);
      sendMethodNotAllowed(res, "GET, POST");
      return;
    }
    if (!isTrusted(req, ctx.webServer)) {
      drainRequest(req);
      sendForbidden(res);
      return;
    }
    if (req.method === "GET") {
      let lean = false;
      let hiddenOnly = false;
      try {
        const query = new URL(req.url || SESSIONS_ROUTE, "http://localhost").searchParams;
        lean = query.get("lean") === "1";
        // 侧边栏隐藏行只需要 trashedIds / purgedIds，避免轮询时枚举全部日志。
        hiddenOnly = query.get("hidden") === "1";
      } catch {
        lean = false;
        hiddenOnly = false;
      }
      try {
        sendJson(res, 200, { ok: true, value: await sessions.payload({ lean, hiddenOnly }) });
      } catch (err) {
        ctx.logger?.warn?.(`[dsh-message-actions] session list failed: ${err instanceof Error ? err.message : String(err)}`);
        sendError(res, 500, "INTERNAL");
      }
      return;
    }

    const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      drainRequest(req);
      sendBadRequest(res);
      return;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendBadRequest(res);
      return;
    }

    try {
      if (body.action === "delete") {
        const ids = readIdList(body, "sessionIds");
        if (!ids || !ids.every(sessionsPure.isSessionId)) {
          sendBadRequest(res);
          return;
        }
        // 单条删除直接进回收站（可恢复），不再要求输入口令；
        // 批量删除才需要 OK，避免一次误删多条。
        if (ids.length > 1 && !isSessionConfirm(body.confirm)) {
          sendError(res, 400, "CONFIRM_REQUIRED");
          return;
        }
        sendJson(res, 200, { ok: true, value: { results: await sessions.removeToTrash(ids) } });
        return;
      }
      if (body.action === "restore") {
        const ids = readIdList(body, "trashIds");
        if (!ids || !ids.every(sessionsPure.isTrashId)) {
          sendBadRequest(res);
          return;
        }
        sendJson(res, 200, { ok: true, value: { results: await sessions.restore(ids) } });
        return;
      }
      if (body.action === "purge") {
        if (body.all === true) {
          // 清空回收站需要显式口令（输入 OK），避免误触或伪造请求直接清空。
          if (!isSessionConfirm(body.confirm)) {
            sendError(res, 400, "CONFIRM_REQUIRED");
            return;
          }
          sendJson(res, 200, { ok: true, value: await sessions.purge([], true) });
          return;
        }
        const ids = readIdList(body, "trashIds");
        if (!ids || !ids.every(sessionsPure.isTrashId)) {
          sendBadRequest(res);
          return;
        }
        // 批量彻底清理不可恢复，需要 OK；单条彻底清理沿用轻量确认按钮。
        if (ids.length > 1 && !isSessionConfirm(body.confirm)) {
          sendError(res, 400, "CONFIRM_REQUIRED");
          return;
        }
        sendJson(res, 200, { ok: true, value: await sessions.purge(ids, false) });
        return;
      }
      if (body.action === "move") {
        if (!sessionsPure.isSessionId(body.sessionId) || !sessionsPure.isWorkspaceId(body.workspaceId)) {
          sendBadRequest(res);
          return;
        }
        sendJson(res, 200, { ok: true, value: await sessions.move(body.sessionId, body.workspaceId) });
        return;
      }
      if (body.action === "moveBatch") {
        const ids = readIdList(body, "sessionIds");
        if (!ids || !ids.every(sessionsPure.isSessionId) || !sessionsPure.isWorkspaceId(body.workspaceId)) {
          sendBadRequest(res);
          return;
        }
        sendJson(res, 200, { ok: true, value: await sessions.moveMany(ids, body.workspaceId) });
        return;
      }
      if (body.action === "archive") {
        const ids = readIdList(body, "sessionIds");
        if (!ids || !ids.every(sessionsPure.isSessionId)) {
          sendBadRequest(res);
          return;
        }
        sendJson(res, 200, { ok: true, value: await sessions.archive(ids) });
        return;
      }
      sendBadRequest(res);
    } catch (err) {
      ctx.logger?.warn?.(`[dsh-message-actions] session action failed: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, "INTERNAL");
    }
  };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  // —— 费用统计 ——
  const cost = createCostService(ctx, config);
  const stats = createStatsService(ctx, cost, config);
  const sessions = createSessionManager(ctx, { sessionMeta: (record) => stats.sessionMeta(record) });
  // 清理上次崩溃留下的暂存目录（只动一小时前的）。
  sessions.sweepStaging().catch(() => {});
  // 启动即探测一次 provider → baseURL；失败静默，不影响任何路由注册。
  cost.refreshEndpoints(false).catch(() => {});

  // 所有路由统一包一层兜底：handler 内部漏掉的异常只会变成 500 JSON，
  // 不会以未处理 rejection 的形式穿透到宿主（宿主界面也就不会弹自己的报错）。
  const route = (path, handler, label) =>
    ctx.effect(
      () => ctx.webServer.register({
        kind: "exact",
        path,
        handler: guardedHandler(handler, {
          label,
          log: (message) => {
            if (typeof ctx.logger?.warn === "function") ctx.logger.warn(message);
          }
        })
      }),
      `dsh-message-actions: ${label}`
    );

  route("/dsh-message-actions", makeActionHandler(ctx), "write route");
  route("/dsh-message-actions/messages", makeMessagesHandler(ctx, cost), "read route");
  route(ATTACHMENT_ROUTE, makeAttachmentHandler(ctx), "attachment route");
  route("/dsh-message-actions/cost/state", makeCostStateHandler(ctx, cost), "cost state route");
  // —— 会话统计（数据来自官方会话日志）——
  route(STATS_ROUTE, makeStatsHandler(ctx, stats), "session stats route");
  route(STATS_BUDGET_ROUTE, makeStatsBudgetHandler(ctx, cost), "stats budget route");
  route(BILLING_ROUTE, makeBillingHandler(ctx, cost), "billing route");
  // —— 会话管理（删除到回收站 / 恢复 / 彻底清理 / 移动到工作区）——
  route(SESSIONS_ROUTE, makeSessionsHandler(ctx, sessions), "sessions route");

  ctx.effect(() => {
    const offEvent = ctx.on("session/event", (session, event) => cost.onSessionEvent(session, event));
    // 始终创建定时器，但每次触发都重新读开关：运行中关闭后不再取数，
    // 重新打开后也无需重启即可恢复（默认开启时行为与旧版一致）。
    const timer = setInterval(() => {
      if (!cost.isEnabled()) return;
      cost.refresh(false).catch(() => {});
    }, COST_REFRESH_MIN_INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
    return () => {
      if (typeof offEvent === "function") offEvent();
      clearInterval(timer);
      cost.dispose();
    };
  }, "dsh-message-actions: cost service");
}

export { Config, apply, inject, name };