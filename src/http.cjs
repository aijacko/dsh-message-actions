// dsh-message-actions 通用 HTTP 工具
//
// 无宿主依赖（仅依赖 shared.cjs 的纯函数），便于在离线测试中直接用
// 假的 req/res 验证 413 排空、请求体上限与统一响应头。

'use strict';

const shared = require('./shared.cjs');
const { ERROR_LABELS, MAX_BODY_BYTES, bodyTooLarge } = shared;

/**
 * 统一 JSON 响应头。除类型与长度外，附加防缓存 / 防嗅探 / 禁引用 / 禁嵌入，
 * 避免含会话正文与财务数据的响应被浏览器缓存、被嗅探成其它类型或在页面里被内联执行。
 */
function jsonHeaders(bodyLength) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bodyLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  };
}

function sendJson(res, status, payload, extraHeaders) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({}, extraHeaders || {}, jsonHeaders(Buffer.byteLength(body))));
  res.end(body);
}

/**
 * 提前拒绝时主动排空请求体。
 * 不排空会让同一个 keep-alive 连接上的剩余字节污染后续请求解析。
 */
function drainRequest(req) {
  try {
    if (typeof req.resume === 'function') req.resume();
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
  sendError(res, 400, 'INVALID_REQUEST');
}

function sendForbidden(res) {
  sendError(res, 403, 'FORBIDDEN');
}

/** 405 也走统一安全头与 JSON 错误体，避免与其它接口的安全策略不一致。 */
function sendMethodNotAllowed(res, allow) {
  sendJson(
    res,
    405,
    { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: errorMessage('METHOD_NOT_ALLOWED') } },
    { allow }
  );
}

/** 读取 JSON 请求体（1MB 上限 + 断连处理）；提前拒绝时一律排空。 */
async function readJsonBody(req, res) {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined && bodyTooLarge(contentLength)) {
    // 先排空再响应，避免 keep-alive 连接残留字节污染后续请求。
    drainRequest(req);
    sendError(res, 413, 'PAYLOAD_TOO_LARGE');
    return null;
  }
  const chunks = [];
  let total = 0;
  let broken = false;
  const onBreak = () => {
    broken = true;
  };
  req.on('aborted', onBreak);
  req.on('close', onBreak);
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        drainRequest(req);
        sendError(res, 413, 'PAYLOAD_TOO_LARGE');
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
    raw = Buffer.concat(chunks).toString('utf8');
  } catch {
    raw = chunks.map((c) => c.toString('utf8')).join('');
  }
  try {
    return JSON.parse(raw);
  } catch {
    sendBadRequest(res);
    return null;
  }
}

/**
 * 路由处理器兜底：任何未预期的异常都收敛为 500 JSON，不让 rejection 穿透到宿主 webServer。
 * 流式响应已写出头部时不能再发 JSON，直接销毁连接（客户端会拿到网络错误而不是半截数据）。
 *
 * @param handler 原始请求处理器
 * @param options { label?: string, log?: (message: string) => void }
 */
function guardedHandler(handler, options) {
  const o = options || {};
  const label = typeof o.label === 'string' && o.label !== '' ? o.label : 'request';
  const log = typeof o.log === 'function' ? o.log : null;
  return async function guarded(req, res) {
    try {
      await handler(req, res);
    } catch (err) {
      if (log) {
        try {
          log(`[dsh-message-actions] ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
        } catch {
          /* 日志本身失败不能影响响应 */
        }
      }
      if (res.headersSent) {
        try { res.destroy(); } catch { /* 已断开 */ }
        return;
      }
      try {
        sendError(res, 500, 'INTERNAL');
      } catch {
        /* 连接已断开 */
      }
    }
  };
}

module.exports = {
  jsonHeaders,
  sendJson,
  drainRequest,
  errorMessage,
  sendError,
  sendBadRequest,
  sendForbidden,
  sendMethodNotAllowed,
  readJsonBody,
  guardedHandler
};
