import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import shared from "./shared.cjs";
import store from "./store.cjs";

const {
  PRODUCER,
  TOMBSTONE_TEXT,
  ERROR_LABELS,
  planAction,
  roundsOf,
  goneTurnsOf,
  buildTurnIndex,
  turnOf,
  textOf,
  MAX_BODY_BYTES,
  isTrustedRequest,
  statusCodeOf,
  bodyTooLarge,
  beijingDateKey,
  periodInfo,
  PRICE_TABLE,
  routeOfMessage,
  routeOfUsage,
  routingOfProvider,
  turnCostOfGroups,
  deriveTurnUsage,
  createTurnBuffer,
  appendTurnEvent,
  observeBalance,
  correctedBalanceCents,
  validateCorrectionAmount,
  pruneDailySpend,
  yuanToCents
} = shared;

const {
  resolveStatePath,
  loadCostState,
  saveCostState
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

  // —— 费用统计（新增）——
  usageStats: z.boolean().default(true).volatile(),
  costPerTurn: z.boolean().default(true).volatile(),
  costPerTurnAutoClose: z.number().min(0).max(600).default(0).volatile(),
  costPeakValley: z.boolean().default(true).volatile(),
  costLayout: z.string().default("default").volatile()
});

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

/**
 * 统一 JSON 响应头。除类型与长度外，附加防缓存 / 防嗅探 / 禁引用 / 禁嵌入，
 * 避免含会话正文与财务数据的响应被浏览器缓存、被嗅探成其它类型或在页面里被内联执行。
 */
function jsonHeaders(bodyLength) {
  return {
    "content-type": "application/json; charset=utf-8",
    "content-length": bodyLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'"
  };
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, jsonHeaders(Buffer.byteLength(body)));
  res.end(body);
}

/**
 * 提前拒绝（405 / 403 / 类型不符）时主动排空请求体。
 * 不排空会让同一个 keep-alive 连接上的剩余字节污染后续请求解析。
 */
function drainRequest(req) {
  try {
    if (typeof req.resume === "function") req.resume();
  } catch {
    /* 连接已断开 */
  }
}

function errorMessage(code) {
  return ERROR_LABELS.en[code] || code;
}

function sendError(res, status, code) {
  sendJson(res, status, { ok: false, error: { code, message: errorMessage(code) } });
}

function sendBadRequest(res) {
  sendError(res, 400, "INVALID_REQUEST");
}

function sendForbidden(res) {
  sendError(res, 403, "FORBIDDEN");
}

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
// 请求体读取（1MB 上限 + 断连处理）
// ---------------------------------------------------------------------------

async function readJsonBody(req, res) {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined && bodyTooLarge(contentLength)) {
    sendError(res, 413, "PAYLOAD_TOO_LARGE");
    return null;
  }
  const chunks = [];
  let total = 0;
  let broken = false;
  const onBreak = () => {
    broken = true;
  };
  req.on("aborted", onBreak);
  req.on("close", onBreak);
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        sendError(res, 413, "PAYLOAD_TOO_LARGE");
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  if (broken && chunks.length === 0) return null;
  if (chunks.length === 0) {
    sendBadRequest(res);
    return null;
  }
  let raw;
  try {
    raw = Buffer.concat(chunks).toString("utf8");
  } catch {
    raw = chunks.map((c) => c.toString("utf8")).join("");
  }
  try {
    return JSON.parse(raw);
  } catch {
    sendBadRequest(res);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 事件角色与随机 id
// ---------------------------------------------------------------------------

function messageRole(event) {
  switch (event.type) {
    case "user/message": return "user";
    case "assistant/message": return "assistant";
    case "tool/result": return "tool";
    case "system/message": return "system";
    case "developer/message": return "developer";
    default: return "other";
  }
}

/** 取事件的稳定消息 id（用于客户端与辅助/答行槽位对齐）。 */
function messageIdOf(event) {
  if (!event || !event.data) return undefined;
  if (typeof event.data.id === "string") return event.data.id;
  if (event.data.message && typeof event.data.message.id === "string") return event.data.message.id;
  return undefined;
}

/** 取事件的用量信息（答行统计 tokens 来源）。 */
function usageOf(event) {
  if (!event || !event.data) return undefined;
  const usage = event.data.usage;
  if (!usage || typeof usage !== "object") return undefined;
  return usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : undefined;
}

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

function makeActionHandler(ctx) {
  return async function handleAction(req, res) {
    if (req.method !== "POST") {
      drainRequest(req);
      res.writeHead(405, { allow: "POST" });
      res.end();
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
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("already has active work")) {
        sendError(res, 423, "AGENT_BUSY");
        return;
      }
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
        removed: plan.removed,
        turn: plan.turn,
        refillText: plan.refillText
      }
    });
  };
}

function makeMessagesHandler(ctx) {
  return async function handleMessages(req, res) {
    if (req.method !== "GET") {
      drainRequest(req);
      res.writeHead(405, { allow: "GET" });
      res.end();
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

    let filter = null;
    const seqsParam = url.searchParams.get("seqs");
    if (seqsParam !== null && seqsParam !== "") {
      filter = new Set(
        seqsParam.split(",").map((s) => Number(s)).filter(Number.isSafeInteger)
      );
    }

    // user/message 没有 data.turn（真实日志里只有 assistant/tool 带 turn），
    // 需要按 turn/start~turn/end 区间推导，否则问行按钮找不到对应 seq。
    const turnIndex = buildTurnIndex(events);

    const rows = [];
    for (const seq of nodes) {
      const event = events[seq];
      if (!event) continue;
      if (shared.isTombstone(event)) continue;
      if (filter && !filter.has(seq)) continue;
      const explicitTurn = event.data && event.data.turn;
      rows.push({
        seq,
        type: event.type,
        id: messageIdOf(event),
        turn: Number.isSafeInteger(explicitTurn) ? explicitTurn : turnOf(turnIndex, seq),
        step: event.data && event.data.step,
        role: messageRole(event),
        // 真实提问与运行时注入（runtime-context / skill-catalog / time-context）
        // 都是 user/message，客户端靠 sourceKind 区分，避免点错问行。
        sourceKind: (event.data && event.data.source && event.data.source.kind) || "user",
        // 只回传问 / 答正文：系统 / 开发者提示词与工具结果（可能含文件内容、密钥）
        // 客户端渲染用不到，不回传可把敏感正文的暴露面降到最小。
        text: event.type === "user/message" || event.type === "assistant/message" ? textOf(event) : "",
        usage: usageOf(event)
      });
    }

    sendJson(res, 200, {
      ok: true,
      value: {
        rows,
        rounds: roundsOf(events, nodes),
        goneTurns: goneTurnsOf(events, nodes)
      }
    });
  };
}

// ---------------------------------------------------------------------------
// 费用统计服务（余额观测 + 单次结算 + 持久化状态）
// ---------------------------------------------------------------------------

const COST_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const COST_BALANCE_TIMEOUT_MS = 10 * 1000;
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

/** 钱包列表按 CNY 求和（其他币种忽略，不换算）。 */
function sumCnyWallets(wallets) {
  if (!Array.isArray(wallets)) return 0;
  let cents = 0;
  for (const wallet of wallets) {
    if (!wallet || typeof wallet !== "object") continue;
    if (wallet.currency !== "CNY") continue;
    const value = yuanToCents(wallet.balance);
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
 * 创建费用统计服务。内存状态为唯一读写源，写盘为整份原子替换。
 * @param ctx Cordis 宿主上下文
 * @param config 宿主 Config（volatile 对象）
 */
function createCostService(ctx, config) {
  const cfg = config || {};
  const enabled = cfg.usageStats !== false;
  const perTurn = cfg.costPerTurn !== false;

  const statePath = resolveStatePath();
  const loaded = loadCostState(statePath, ctx.logger);
  const state = loaded.state;
  const readOnly = loaded.readOnly;

  if (!enabled) {
    // 总开关关闭：重新开启后从新余额继续，不补记关闭期间的差额。
    state.lastBalanceCents = null;
    state.lastBalanceAt = 0;
  }

  const cache = { rechargeCents: null, bonusCents: null, totalCents: null, updatedAt: 0 };
  const buffers = new Map();
  let lastTurn = null;
  let inFlight = null;
  let lastFetchFailed = false;
  let lastMessageProvider;
  let lastHeaderProvider;

  const warn = (message) => {
    if (typeof ctx.logger?.warn === "function") ctx.logger.warn(`[dsh-message-actions] ${message}`);
  };

  function persist() {
    state.updatedAt = Date.now();
    state.dailySpendCents = pruneDailySpend(state.dailySpendCents, state.updatedAt, shared.DAILY_KEEP_DAYS);
    if (readOnly) return;
    try {
      saveCostState(statePath, state);
    } catch (err) {
      warn(`write cost state failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function routingInfo() {
    const provider = lastMessageProvider || lastHeaderProvider;
    const mapped = routingOfProvider(provider);
    if (mapped) return { routing: mapped, provider };
    if (await hasApiKey(ctx)) return { routing: "api-key", provider: "deepseek-official" };
    const account = accountServiceOf(ctx);
    if (!account) return { routing: "unavailable", provider: undefined };
    try {
      const snapshot = await account.getState();
      const status = snapshot && typeof snapshot === "object" ? snapshot.status : undefined;
      if (status === "credential-stored") return { routing: "account", provider: "deepseek-account" };
      return { routing: "signed-out", provider: undefined };
    } catch {
      return { routing: "unavailable", provider: undefined };
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

  function applyCorrection(creditCents, debitCents) {
    state.correctionCreditCents = creditCents;
    state.correctionDebitCents = debitCents;
    state.pendingAdjustmentCents = 0;
    state.pendingAdjustmentAt = 0;
    persist();
  }

  async function stateValue() {
    const now = Date.now();
    const routing = (await routingInfo()).routing;
    let status;
    if (routing === "signed-out") status = "signed-out";
    else if (routing === "api-key") status = "api-key";
    else if (routing === "unavailable") status = "unavailable";
    else if (routing === "local") status = "local";
    else status = cache.updatedAt > 0 && !lastFetchFailed ? "ready" : "stale";

    const period = periodInfo(now);
    return {
      status,
      billing: routing,
      balance: {
        rechargeCents: cache.rechargeCents,
        bonusCents: cache.bonusCents,
        totalCents: cache.totalCents,
        updatedAt: cache.updatedAt,
        refreshing: inFlight !== null
      },
      dailyCents: state.dailySpendCents[beijingDateKey(now)] || 0,
      pendingAdjustmentCents: state.pendingAdjustmentCents,
      account: {
        baselineCents: state.baselineBalanceCents,
        observedSpendCents: state.observedSpendTotalCents,
        creditCents: state.correctionCreditCents,
        debitCents: state.correctionDebitCents,
        correctedBalanceCents: correctedBalanceCents({
          baselineCents: state.baselineBalanceCents,
          observedSpendCents: state.observedSpendTotalCents,
          creditCents: state.correctionCreditCents,
          debitCents: state.correctionDebitCents
        })
      },
      period: period.period,
      nextChangeAt: period.nextChangeAt,
      lastTurn: perTurn ? lastTurn : null
    };
  }

  /** 会话事件：跟踪最近模型路由，并在 turn/end 时结算本轮。 */
  function onSessionEvent(session, event) {
    if (!enabled) return;
    if (!event || typeof event !== "object") return;
    const sessionId = session && typeof session.id === "string" ? session.id : undefined;
    if (!sessionId) return;
    const type = event.type;
    const data = event.data || {};

    if (type === "assistant/message") {
      const route = routeOfUsage(data.usage) || routeOfMessage(data.message);
      if (route) lastMessageProvider = route.provider;
    } else if (type === "request/header") {
      const provider = data.header && data.header.config ? data.header.config.provider : undefined;
      if (typeof provider === "string" && provider.length > 0) lastHeaderProvider = provider;
    }

    if (!perTurn) return;
    if (type === "turn/start") {
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
    lastTurn = {
      at,
      endedAt: Number.isFinite(usage.endedAt) ? usage.endedAt : eventTime(event),
      provider: usage.provider,
      models: usage.models,
      tokens: usage.tokens,
      costMicros: turnCostOfGroups(usage.groups, period, PRICE_TABLE),
      turn: Number.isSafeInteger(usage.turn) ? usage.turn : buffer.turn
    };
  }

  function dispose() {
    buffers.clear();
    inFlight = null;
  }

  return {
    enabled,
    perTurn,
    refresh,
    stateValue,
    applyCorrection,
    onSessionEvent,
    dispose,
    state,
    readOnly
  };
}

// ---------------------------------------------------------------------------
// 费用统计路由
// ---------------------------------------------------------------------------

function makeCostStateHandler(ctx, service) {
  return async function handleCostState(req, res) {
    if (req.method !== "GET") {
      drainRequest(req);
      res.writeHead(405, { allow: "GET" });
      res.end();
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
      if (service.enabled) {
        if (force) await service.refresh(true);
        else service.refresh(false).catch(() => {});
      }
      sendJson(res, 200, { ok: true, value: await service.stateValue() });
    } catch (err) {
      if (typeof ctx.logger?.warn === "function") {
        ctx.logger.warn(`[dsh-message-actions] cost state failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      sendError(res, 500, "INTERNAL");
    }
  };
}

function makeCostCorrectionHandler(ctx, service) {
  return async function handleCostCorrection(req, res) {
    if (req.method !== "POST") {
      drainRequest(req);
      res.writeHead(405, { allow: "POST" });
      res.end();
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
    const credit = validateCorrectionAmount(body.creditYuan);
    const debit = validateCorrectionAmount(body.debitYuan);
    if (!credit.ok || !debit.ok) {
      sendError(res, 400, "INVALID_AMOUNT");
      return;
    }
    try {
      service.applyCorrection(credit.cents, debit.cents);
      sendJson(res, 200, { ok: true, value: await service.stateValue() });
    } catch (err) {
      if (typeof ctx.logger?.warn === "function") {
        ctx.logger.warn(`[dsh-message-actions] correction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      sendError(res, 500, "INTERNAL");
    }
  };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/dsh-message-actions",
      handler: makeActionHandler(ctx)
    }),
    "dsh-message-actions: write route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/dsh-message-actions/messages",
      handler: makeMessagesHandler(ctx)
    }),
    "dsh-message-actions: read route"
  );

  // —— 费用统计 ——
  const cost = createCostService(ctx, config);

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/dsh-message-actions/cost/state",
      handler: makeCostStateHandler(ctx, cost)
    }),
    "dsh-message-actions: cost state route"
  );
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/dsh-message-actions/cost/correction",
      handler: makeCostCorrectionHandler(ctx, cost)
    }),
    "dsh-message-actions: cost correction route"
  );

  ctx.effect(() => {
    const offEvent = ctx.on("session/event", (session, event) => cost.onSessionEvent(session, event));
    let timer = null;
    if (cost.enabled) {
      timer = setInterval(() => {
        cost.refresh(false).catch(() => {});
      }, COST_REFRESH_MIN_INTERVAL_MS);
      if (typeof timer.unref === "function") timer.unref();
    }
    return () => {
      if (typeof offEvent === "function") offEvent();
      if (timer !== null) clearInterval(timer);
      cost.dispose();
    };
  }, "dsh-message-actions: cost service");
}

export { Config, apply, inject, name };