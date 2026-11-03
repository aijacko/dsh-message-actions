'use strict';

/**
 * dsh-message-actions — 共享纯函数（宿主与客户端共用）。
 *
 * 本模块不依赖任何 DSH / 第三方运行时，也不产生副作用，因此可被
 * `test/check.mjs` 离线加载，也可被构建脚本内联进客户端 bundle。
 *
 * 命名与实现均为本项目自行设计，不复制任何第三方代码。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 墓碑事件的 producer 标识，用于在会话日志里识别本插件写入的删除/撤回标记。 */
const PRODUCER = 'dsh-message-actions';

/** 墓碑正文占位文本。 */
const TOMBSTONE_TEXT = { recall: '[已撤回]', delete: '[已删除]', deleteFrom: '[已删除]' };

/**
 * 宿主 HTTP 错误码与文案（zh / en）。
 * 错误码稳定；文案仅用于日志与客户端 toast 兜底展示。
 */
const ERROR_LABELS = {
  zh: {
    INVALID_REQUEST: '无效请求',
    FORBIDDEN: '请求被拒绝',
    PAYLOAD_TOO_LARGE: '请求体过大',
    AGENT_BUSY: '正在生成回复，请稍后再试',
    SESSION_NOT_LIVE: '会话不可用',
    TARGET_NOT_FOUND: '目标消息不存在或已被删除',
    NOT_DELETABLE: '该消息不可删除',
    NOT_A_USER_MESSAGE: '仅用户消息可撤回',
    SPAN_NOT_CONTIGUOUS: '目标回答与工具结果不连续，无法整体删除',
    INVALID_AMOUNT: '金额格式不合法',
    READ_ONLY: '状态文件只读，未保存',
    WRITE_FAILED: '写入状态文件失败',
    INTERNAL: '内部错误'
  },
  en: {
    INVALID_REQUEST: 'Invalid request',
    FORBIDDEN: 'Forbidden',
    PAYLOAD_TOO_LARGE: 'Payload too large',
    AGENT_BUSY: 'A reply is being generated; try again later',
    SESSION_NOT_LIVE: 'Session is not live',
    TARGET_NOT_FOUND: 'Target message not found or already deleted',
    NOT_DELETABLE: 'This message cannot be deleted',
    NOT_A_USER_MESSAGE: 'Only user messages can be recalled',
    SPAN_NOT_CONTIGUOUS: 'Answer and tool results are not contiguous',
    INVALID_AMOUNT: 'Invalid amount',
    READ_ONLY: 'State file is read-only; nothing saved',
    WRITE_FAILED: 'Could not write the state file',
    INTERNAL: 'Internal error'
  }
};

// ---------------------------------------------------------------------------
// 文本提取
// ---------------------------------------------------------------------------

/**
 * 折叠 OpenAI 风格 content（字符串或 block 数组）为纯文本。
 * 只取用户可见的 text 块：reasoning（思维链）不属于回答正文，不能混进分享/导出。
 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block == null) continue;
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push('[图片]');
    } else if (block.type === 'file') {
      parts.push('[文件]');
    }
  }
  return parts.join('');
}

/** 取一个事件的纯文本正文（按事件类型分发）。 */
function textOf(event) {
  if (!event || typeof event !== 'object') return '';
  const data = event.data;
  if (!data || typeof data !== 'object') return '';
  switch (event.type) {
    case 'user/message':
      return contentText(data.content);
    case 'assistant/message':
      return contentText(data.message && data.message.content);
    case 'tool/result':
      return contentText(data.message && data.message.content);
    case 'system/message':
      return contentText(data.message && data.message.content);
    case 'developer/message':
      return contentText(data.message && data.message.content);
    default:
      return '';
  }
}

/** 事件对应的角色（供 /messages 摘要与客户端槽位对齐）。 */
function messageRoleOf(event) {
  if (!event || typeof event !== 'object') return 'other';
  switch (event.type) {
    case 'user/message': return 'user';
    case 'assistant/message': return 'assistant';
    case 'tool/result': return 'tool';
    case 'system/message': return 'system';
    case 'developer/message': return 'developer';
    default: return 'other';
  }
}

/** 取事件的稳定消息 id（供客户端与辅助/答行槽位对齐）。 */
function messageIdOf(event) {
  if (!event || typeof event !== 'object' || !event.data) return undefined;
  const data = event.data;
  if (typeof data.id === 'string') return data.id;
  if (data.message && typeof data.message.id === 'string') return data.message.id;
  return undefined;
}

/** 取事件的用量摘要（答行统计 tokens 来源）；只回传 outputTokens。 */
function usageSummaryOf(event) {
  if (!event || typeof event !== 'object' || !event.data) return undefined;
  const usage = event.data.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  return usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : undefined;
}

/**
 * 取工具事件的 callId。
 * 宿主工具行 DOM 的 `data-chat-node-key` = `9:tool-call<callId>`，
 * callId 来自 `tool/call.data.callId` / `tool/result.data.message.source.callId`。
 */
function toolCallIdOf(event) {
  if (!event || typeof event !== 'object' || !event.data) return undefined;
  const data = event.data;
  if (event.type === 'tool/result') {
    const source = data.message && data.message.source;
    if (source && typeof source.callId === 'string' && source.callId !== '') return source.callId;
  }
  if (event.type === 'tool/call' && typeof data.callId === 'string' && data.callId !== '') {
    return data.callId;
  }
  return undefined;
}

/** 宿主工具节点 key 前缀（`conversationContextKey("tool-call", id)` = `9:tool-call<id>`）。 */
const TOOL_NODE_KEY_PREFIX = '9:tool-call';

/**
 * 从宿主 DOM 的 `data-chat-node-key` 解析工具 callId。
 * 这不是序号 / 坐标猜测：前缀与 key 构造规则来自宿主
 * `conversationContextKey(kind, id) = ${kind.length}:${kind}${id}`，
 * 而 id 就是服务端 `tool/call` 事件的 callId。
 * @param {string} nodeKey
 * @returns {string|null}
 */
function toolCallIdFromNodeKey(nodeKey) {
  if (typeof nodeKey !== 'string' || !nodeKey.startsWith(TOOL_NODE_KEY_PREFIX)) return null;
  const id = nodeKey.slice(TOOL_NODE_KEY_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * 从 DOM 上现存的工具节点 key 中，挑出应被隐藏的那些。
 * 宿主切换会话 / 刷新会重建 DOM，新节点不带任何本地隐藏标记，
 * 因此客户端每次重建后都要按墓碑里的 callId 重新判定一次。
 * @param {string[]} nodeKeys 现存的 `data-chat-node-key`
 * @param {string[]} callIds 墓碑覆盖的 callId（来自 /messages 的 goneTools）
 * @returns {string[]} 需要隐藏的 nodeKey
 */
function toolNodeKeysToHide(nodeKeys, callIds) {
  if (!Array.isArray(nodeKeys) || !Array.isArray(callIds) || callIds.length === 0) return [];
  const gone = new Set();
  for (const callId of callIds) {
    if (typeof callId === 'string' && callId !== '') gone.add(callId);
  }
  if (gone.size === 0) return [];
  const out = [];
  for (const key of nodeKeys) {
    const callId = toolCallIdFromNodeKey(key);
    if (callId !== null && gone.has(callId)) out.push(key);
  }
  return out;
}

/** 在 /messages 摘要 rows 中找到 callId 对应的 tool/result 行（表面顺序第一条）。 */
function findToolRowByCallId(rows, callId) {
  if (!Array.isArray(rows) || typeof callId !== 'string' || callId === '') return null;
  for (const row of rows) {
    if (row && row.type === 'tool/result' && row.callId === callId) return row;
  }
  return null;
}

/**
 * 汇总所有墓碑声明的 removed seq。
 * 墓碑随事件日志一起持久化（带 surfaceOp），因此即使宿主重建表面时
 * 没有重放 surfaceOp，或客户端拿到旧快照，这里仍能还原「哪些节点已被删」。
 * @param events 按 seq 索引的事件数组
 * @returns {Set<number>}
 */
function tombstonedSeqsOf(events) {
  const hidden = new Set();
  if (!Array.isArray(events)) return hidden;
  for (const event of events) {
    if (!isTombstone(event)) continue;
    const removed = event.data && event.data.source && event.data.source.removed;
    if (!Array.isArray(removed)) continue;
    for (const seq of removed) {
      if (Number.isSafeInteger(seq) && seq >= 0) hidden.add(seq);
    }
  }
  return hidden;
}

/**
 * 从 events + 表面节点得到「仍可见」的节点列表。
 * 不信任宿主表面重放结果：被墓碑覆盖的 seq 一律剔除。
 * @param events
 * @param nodes
 * @returns {number[]}
 */
function liveNodesOf(events, nodes) {
  if (!Array.isArray(nodes)) return [];
  const hidden = tombstonedSeqsOf(events);
  if (hidden.size === 0) return nodes.slice();
  return nodes.filter((seq) => !hidden.has(seq));
}

/**
 * 已删除的工具行 callId 列表（供客户端在每次 DOM 重建后重新隐藏）。
 * 工具行 DOM key = `9:tool-call<callId>`，因此只需 callId。
 * @param events
 * @returns {string[]}
 */
function goneToolsOf(events) {
  const hidden = tombstonedSeqsOf(events);
  const out = [];
  const seen = new Set();
  for (const seq of hidden) {
    const event = events[seq];
    if (!event) continue;
    if (event.type !== 'tool/result' && event.type !== 'tool/call') continue;
    const callId = toolCallIdOf(event);
    if (typeof callId !== 'string' || callId === '' || seen.has(callId)) continue;
    seen.add(callId);
    out.push(callId);
  }
  return out;
}

/** 判断键盘事件目标是否为可编辑控件（输入框内 Enter 必须交给控件自己处理）。 */
function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable === true) return true;
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** 判断键盘事件目标是否落在按钮上（按钮上的 Enter 由原生 click 处理）。 */
function isButtonTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (typeof target.closest === 'function') {
    try {
      if (target.closest('button')) return true;
    } catch {
      /* 非 DOM 环境，回退到 tagName */
    }
  }
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
  return tag === 'BUTTON';
}

/**
 * 浮层键盘行为判定（纯函数，供客户端与离线测试共用）。
 *
 * - 浮层未打开：一律 none（不拦截宿主快捷键）。
 * - Esc：dismiss。
 * - Enter：焦点在输入框 / 可编辑区域 / 按钮上、或主操作不可用 / 正在执行时返回 none；
 *   否则返回 primary。disabled 时客户端选择「什么都不做」，与点击禁用按钮一致。
 * - 其它键：none。
 *
 * @param params {{ key?: string, target?: object, overlayOpen?: boolean, primaryEnabled?: boolean, busy?: boolean }}
 * @returns {'none'|'dismiss'|'primary'}
 */
function resolveKeyAction(params) {
  const opts = params || {};
  if (opts.overlayOpen !== true) return 'none';
  if (opts.key === 'Escape' || opts.key === 'Esc') return 'dismiss';
  if (opts.key !== 'Enter') return 'none';
  // 焦点落在按钮上时交给原生 click：否则「取消」按钮上按 Enter 会同时触发主操作。
  if (isEditableTarget(opts.target) || isButtonTarget(opts.target)) return 'none';
  if (opts.busy === true) return 'none';
  if (opts.primaryEnabled === false) return 'none';
  return 'primary';
}

/** 去掉空白后的字符数（用于「答行统计」的“字数”）。 */
function wordCount(text) {
  return String(text == null ? '' : text).replace(/\s/g, '').length;
}

/**
 * 生成单行预览文本（供分享/导出多选列表使用）。
 * 折叠换行与连续空白后截断，超出部分以 `…` 结尾；不改变原始文本，导出仍用全文。
 * @param {string} text
 * @param {number} limit 最大字符数（<=0 视为空）
 * @returns {string}
 */
function previewText(text, limit) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const flat = raw.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim();
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit).trimEnd() + '…';
}

/**
 * 紧凑的 token 计数：`169` / `1.2k` / `39.1k` / `120k`。
 * @param {number} n
 * @returns {string}
 */
function formatTokens(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return (k >= 100 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
}

// ---------------------------------------------------------------------------
// 事件与表面结构
// ---------------------------------------------------------------------------

/** 判断某事件是否为本插件写入的墓碑。 */
function isTombstone(event) {
  return !!event &&
    event.type === 'user/message' &&
    !!event.data &&
    !!event.data.source &&
    event.data.source.producer === PRODUCER;
}

/**
 * 扫描日志，建立「轮次 -> { startSeq, endSeq }」索引。
 * turn/start、turn/end 是 log-only 事件，不在 surface.nodes 里，
 * 但它们的 seq 可用来界定该轮表面的上下界。
 */
function buildTurnIndex(events) {
  const starts = new Map();
  events.forEach((evt, seq) => {
    if (evt && evt.type === 'turn/start') {
      const turn = evt.data && evt.data.turn;
      if (typeof turn === 'number' && !starts.has(turn)) starts.set(turn, seq);
    }
  });
  const index = [];
  events.forEach((evt, seq) => {
    if (evt && evt.type === 'turn/end') {
      const turn = evt.data && evt.data.turn;
      if (typeof turn === 'number' && starts.has(turn)) {
        index.push({ turn, startSeq: starts.get(turn), endSeq: seq });
      }
    }
  });
  index.sort((a, b) => a.startSeq - b.startSeq);
  return index;
}

/** 返回包含给定 seq 的轮次号；孤立（无 turn/start）返回 null。 */
function turnOf(turnIndex, seq) {
  for (const info of turnIndex) {
    if (seq > info.startSeq && seq < info.endSeq) return info.turn;
  }
  return null;
}

/**
 * 把轮次区间展开成 seq → turn 的 Map，避免逐条消息线性扫描 turnIndex。
 * 结果必须与 turnOf(turnIndex, seq) 一致（见离线测试）。
 * @param turnIndex buildTurnIndex 的返回值
 * @returns {Map<number, number>}
 */
function buildTurnSeqMap(turnIndex) {
  const map = new Map();
  if (!Array.isArray(turnIndex)) return map;
  for (const info of turnIndex) {
    // 与 turnOf 的「按 startSeq 顺序取第一个命中」语义保持一致：
    // 轮次区间若有重叠 / 嵌套，先出现的轮次优先，后出现的不得覆盖。
    for (let seq = info.startSeq + 1; seq < info.endSeq; seq += 1) {
      if (!map.has(seq)) map.set(seq, info.turn);
    }
  }
  return map;
}

/** 一次构建轮次索引与 seq 映射，供 /messages 复用。 */
function createTurnLookup(events) {
  const index = buildTurnIndex(events);
  return { index, seqTurn: buildTurnSeqMap(index) };
}

/** 从 lookup（或现建）取某 seq 所属轮次。 */
function turnOfLookup(lookup, seq) {
  if (lookup && lookup.seqTurn instanceof Map) {
    const turn = lookup.seqTurn.get(seq);
    return Number.isSafeInteger(turn) ? turn : null;
  }
  if (lookup && Array.isArray(lookup.index)) return turnOf(lookup.index, seq);
  return null;
}

/** 返回同一 (turn, step) 的全部表面节点 seq（按出现顺序）。 */
function stepNodesOf(events, nodes, turn, step) {
  const out = [];
  for (const seq of nodes) {
    const data = events[seq] && events[seq].data;
    if (data && data.turn === turn && data.step === step) out.push(seq);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 删除/撤回区间规划（核心纯函数）
// ---------------------------------------------------------------------------

/**
 * 由目标 seq + action 规划要遮蔽的区间。
 *
 * @param events 完整日志事件数组（events[seq] = event）
 * @param nodes  当前 surface.nodes（模型可见有序 seq 数组）
 * @param params { action: "recall"|"delete"|"deleteFrom", seq: number }
 * @returns
 *   成功：{ ok:true, startSeq, endSeq, removed, kinds, via, turn, refillText }
 *   失败：{ ok:false, code }
 */
function planAction(events, nodes, params) {
  const action = params && params.action;
  const targetSeq = params && params.seq;
  if ((action !== 'recall' && action !== 'delete' && action !== 'deleteFrom') ||
      !Number.isSafeInteger(targetSeq) || targetSeq < 0) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }

  // 已写墓碑的节点不再可操作：宿主重建表面时可能仍把旧节点留在 nodes 里，
  // 这里统一按「墓碑 → 可见集合」判定，避免对同一段内容重复撤回 / 重复删除。
  const liveNodes = liveNodesOf(events, nodes);
  const idx = liveNodes.indexOf(targetSeq);
  if (idx === -1) return { ok: false, code: 'TARGET_NOT_FOUND' };
  const evt = events[targetSeq];
  if (!evt) return { ok: false, code: 'TARGET_NOT_FOUND' };

  // 系统提示（节点 0）与 system/message 一律拒绝。
  if (targetSeq === 0 || evt.type === 'system/message') {
    return { ok: false, code: 'NOT_DELETABLE' };
  }

  // 撤回仅允许 user/message 且非系统/开发者来源。
  if (action === 'recall') {
    if (evt.type !== 'user/message') return { ok: false, code: 'NOT_A_USER_MESSAGE' };
    const kind = evt.data && evt.data.source && evt.data.source.kind;
    if (kind === 'system' || kind === 'developer') return { ok: false, code: 'NOT_DELETABLE' };
  }

  const turnIndex = buildTurnIndex(events);

  // 删至末尾：从目标节点到 surface 末尾全部遮蔽。
  if (action === 'deleteFrom') {
    const endSeq = liveNodes[liveNodes.length - 1];
    return buildPlan(events, liveNodes, targetSeq, endSeq, evt.type, 'deleteFrom',
      turnOf(turnIndex, targetSeq));
  }

  // 问行：整轮；孤立提问只删自身。
  if (evt.type === 'user/message') {
    const turn = turnOf(turnIndex, targetSeq);
    const plan = turn === null
      ? buildPlan(events, liveNodes, targetSeq, targetSeq, evt.type, action, null)
      : (() => {
          const span = turnSpan(events, liveNodes, turnIndex, turn);
          return buildPlan(events, liveNodes, span.startSeq, span.endSeq, evt.type, action, turn);
        })();
    // 撤回回填必须用被点的那条提问文本：轮次区间起点可能是运行时注入消息，
    // 不能取 startSeq 的正文，否则会把注入上下文回填到输入框。
    if (plan.ok && action === 'recall') plan.refillText = textOf(evt);
    return plan;
  }

  // 答行 / 工具行：同 (turn, step) 的整 step。
  if (evt.type === 'assistant/message' || evt.type === 'tool/result') {
    const data = evt.data || {};
    const { turn, step } = data;
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) {
      return { ok: false, code: 'NOT_DELETABLE' };
    }
    const stepNodes = stepNodesOf(events, liveNodes, turn, step);
    if (stepNodes.length === 0) return { ok: false, code: 'TARGET_NOT_FOUND' };
    const start = stepNodes[0];
    const end = stepNodes[stepNodes.length - 1];
    const startIdx = liveNodes.indexOf(start);
    const endIdx = liveNodes.indexOf(end);
    for (let i = startIdx; i <= endIdx; i++) {
      if (!stepNodes.includes(liveNodes[i])) return { ok: false, code: 'SPAN_NOT_CONTIGUOUS' };
    }
    return buildPlan(events, liveNodes, start, end, evt.type, action, turn);
  }

  return { ok: false, code: 'NOT_DELETABLE' };
}

/** 计算某个轮次在 surface 中覆盖的 [startSeq, endSeq]（含边界）。 */
function turnSpan(events, nodes, turnIndex, turn) {
  const info = turnIndex.find((item) => item.turn === turn);
  if (!info) return { startSeq: null, endSeq: null };
  const inTurn = nodes.filter((seq) => seq > info.startSeq && seq < info.endSeq);
  if (inTurn.length === 0) return { startSeq: null, endSeq: null };
  return { startSeq: inTurn[0], endSeq: inTurn[inTurn.length - 1] };
}

/** 由区间组装一个可落地的删除计划。 */
function buildPlan(events, nodes, startSeq, endSeq, targetType, action, turn) {
  const startIdx = nodes.indexOf(startSeq);
  const endIdx = nodes.indexOf(endSeq);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { ok: false, code: 'TARGET_NOT_FOUND' };
  }
  const removed = nodes.slice(startIdx, endIdx + 1);
  const kinds = removed.map((seq) => (events[seq] ? events[seq].type : 'unknown'));
  const via = targetType === 'user/message' ? 'user' :
    targetType === 'assistant/message' ? 'assistant' :
    targetType === 'tool/result' ? 'tool' : 'unknown';
  const target = events[startSeq] || {};
  const step = target.data && Number.isSafeInteger(target.data.step) ? target.data.step : undefined;
  return {
    ok: true,
    startSeq,
    endSeq,
    removed,
    kinds,
    via,
    turn,
    step,
    refillText: action === 'recall' ? textOf(events[startSeq]) : null
  };
}

// ---------------------------------------------------------------------------
// 分享 / 导出：活表面分组
// ---------------------------------------------------------------------------

/**
 * 从活表面分离出「轮次」列表（排除墓碑与系统提示），供分享/导出使用。
 * @returns [{ turn, question, answer }]，按轮次升序。
 */
function roundsOf(events, nodes, lookup) {
  const turns = lookup || createTurnLookup(events);
  const rounds = new Map();
  const ensure = (turn) => {
    if (!rounds.has(turn)) rounds.set(turn, { turn, question: '', answer: '' });
    return rounds.get(turn);
  };
  // 不依赖宿主表面是否重放了 surfaceOp：被墓碑覆盖的节点一律不导出。
  for (const seq of liveNodesOf(events, nodes)) {
    const evt = events[seq];
    if (!evt || isTombstone(evt)) continue;
    if (evt.type === 'user/message') {
      const turn = turnOfLookup(turns, seq);
      if (turn === null) continue; // 无轮次归属的游离消息不进导出
      // 运行时上下文 / 技能目录 / 时间上下文也是 user/message，但不算用户提问。
      const kind = evt.data && evt.data.source && evt.data.source.kind;
      if (kind !== undefined && kind !== 'user') continue;
      const r = ensure(turn);
      const text = textOf(evt);
      // 一轮只取第一条真实提问：runtime context / system-reminder 等注入消息不混入导出。
      if (text && !r.question) r.question = text;
    } else if (evt.type === 'assistant/message') {
      const data = evt.data || {};
      const turn = Number.isSafeInteger(data.turn) ? data.turn : turnOfLookup(turns, seq);
      if (turn === null) continue;
      const r = ensure(turn);
      const text = textOf(evt);
      // 一轮只保留最后一条回答，避免把中间步骤 / 重试内容拼进导出。
      if (text) r.answer = text;
    }
  }
  return [...rounds.values()].sort((a, b) => a.turn - b.turn);
}

/**
 * 计算「已消失轮次」：日志里有 turn/start 但当前 surface 中已无任何活节点的轮次。
 * 用于导航刻度隐藏（turnOutline 只看 turn/start，忽略 surfaceOp，必须靠客户端补齐）。
 * @returns 升序的轮次号数组。
 */
function goneTurnsOf(events, nodes, lookup) {
  const turns = lookup || createTurnLookup(events);
  const turnIndex = turns.index;
  if (turnIndex.length === 0) return [];
  const live = new Set();
  for (const seq of liveNodesOf(events, nodes)) {
    const evt = events[seq];
    if (!evt || isTombstone(evt)) continue;
    const data = evt.data || {};
    const turn = Number.isSafeInteger(data.turn) ? data.turn : turnOfLookup(turns, seq);
    if (Number.isSafeInteger(turn)) live.add(turn);
  }
  return turnIndex.filter((info) => !live.has(info.turn)).map((info) => info.turn);
}

/**
 * `/messages` 摘要快照：只返回预览、字数、用量与 callId，不返回正文。
 * 分享图 / 导出需要全文时，走 `full=1&turns=a,b` 的按需接口（见 index.mjs）。
 *
 * 增量：传入 `since`（上次快照的 version）时，rows 只回 seq > since 的行，
 * rounds 只回本次有新增行的轮次，并额外回 `removedSeqs`（since 之后墓碑
 * 覆盖的 seq），供客户端合并并剔除已删行；不带 since 仍是全量快照。
 * goneTurns / goneTools 始终全量返回，删除同步不受增量影响。
 *
 * @param events 按 seq 索引的事件数组
 * @param nodes  当前 surface.nodes
 * @param lookup createTurnLookup 的返回值（可缺省）
 * @param options { filter?: Set<number>, since?: number, previewLimit?: number }
 * @returns {{ version: number, nodeCount: number, rows: Array, rounds: Array, goneTurns: number[], goneTools: string[], removedSeqs: number[] }}
 */
function messagesSummaryOf(events, nodes, lookup, options) {
  const opts = options || {};
  const turns = lookup || createTurnLookup(events);
  const filter = opts.filter instanceof Set ? opts.filter : null;
  // 游标 v.s. seqs 列表：seqs 是「包含列表」，且长会话里已持有的 seq 数量会无限增长；
  // 游标只传一个整数，天然表达「只要新的」。
  const since = Number.isSafeInteger(opts.since) && opts.since >= 0 ? opts.since : null;
  const previewLimit = Number.isFinite(opts.previewLimit) && opts.previewLimit > 0
    ? Math.floor(opts.previewLimit)
    : 200;
  const rows = [];
  const rounds = new Map();
  const touched = since === null ? null : new Set();
  const ensure = (turn) => {
    if (!rounds.has(turn)) rounds.set(turn, { turn, questionPreview: '', answerPreview: '' });
    return rounds.get(turn);
  };
  const liveNodes = liveNodesOf(events, nodes);
  for (const seq of liveNodes) {
    const event = events[seq];
    if (!event || isTombstone(event)) continue;
    const data = event.data || {};
    const explicitTurn = data.turn;
    const turn = Number.isSafeInteger(explicitTurn) ? explicitTurn : turnOfLookup(turns, seq);
    // 只有真实提问与助手回答进入预览：system / developer 消息、运行时注入的
    // 上下文（user/message + 非 user 来源）与工具结果都不回传正文。
    const isUserQuestion = event.type === 'user/message' &&
      (data.source === undefined || data.source === null || data.source.kind === undefined || data.source.kind === 'user');
    const isText = isUserQuestion || event.type === 'assistant/message';
    const text = isText ? textOf(event) : '';
    const summary = {
      seq,
      type: event.type,
      id: messageIdOf(event),
      turn,
      step: data.step,
      role: messageRoleOf(event),
      sourceKind: (data.source && data.source.kind) || 'user',
      preview: isText ? previewText(text, previewLimit) : '',
      words: isText ? wordCount(text) : 0,
      usage: usageSummaryOf(event),
      callId: toolCallIdOf(event)
    };
    const beyondCursor = since === null || seq > since;
    if (beyondCursor && (!filter || filter.has(seq))) rows.push(summary);

    if (isUserQuestion) {
      if (turn === null) continue;
      const round = ensure(turn);
      if (summary.preview && !round.questionPreview) round.questionPreview = summary.preview;
    } else if (event.type === 'assistant/message') {
      if (turn === null) continue;
      const round = ensure(turn);
      if (summary.preview) round.answerPreview = summary.preview;
    }
    if (touched && beyondCursor && turn !== null) touched.add(turn);
  }
  const lastSeq = liveNodes.length > 0 ? liveNodes[liveNodes.length - 1] : 0;
  // 增量响应附带 since 之后墓碑覆盖的 seq；全量响应不需要（rows 已不含它们）。
  const removedSeqs = [];
  if (since !== null && Array.isArray(events)) {
    const seen = new Set();
    for (let seq = since + 1; seq < events.length; seq += 1) {
      const event = events[seq];
      if (!isTombstone(event)) continue;
      const removed = event.data && event.data.source && event.data.source.removed;
      if (!Array.isArray(removed)) continue;
      for (const target of removed) {
        if (!Number.isSafeInteger(target) || target < 0 || seen.has(target)) continue;
        seen.add(target);
        removedSeqs.push(target);
      }
    }
  }
  const sortedRounds = [...rounds.values()].sort((a, b) => a.turn - b.turn);
  return {
    version: Number.isSafeInteger(lastSeq) ? lastSeq : 0,
    nodeCount: liveNodes.length,
    rows,
    rounds: touched === null ? sortedRounds : sortedRounds.filter((round) => touched.has(round.turn)),
    goneTurns: goneTurnsOf(events, nodes, turns),
    // 客户端在每次 DOM 重建（切换会话 / 刷新）后据此重新隐藏工具行，
    // 不能只在删除成功当下隐藏一次。
    goneTools: goneToolsOf(events),
    removedSeqs
  };
}

/**
 * 合并增量摘要到已持有的快照：按 seq 合并行、按 turn 合并轮次，
 * 剔除增量确认删除的 seq 以及整轮消失的轮次。
 * goneTurns / goneTools 以服务端最新结果为准（服务端始终全量返回）。
 */
function mergeMessageSummary(base, patch) {
  const rows = new Map();
  for (const row of (base && base.rows) || []) rows.set(row.seq, row);
  for (const row of (patch && patch.rows) || []) rows.set(row.seq, row);
  for (const seq of (patch && patch.removedSeqs) || []) rows.delete(seq);

  const goneTurns = Array.isArray(patch && patch.goneTurns) ? patch.goneTurns : [];
  for (const turn of goneTurns) {
    for (const [seq, row] of rows) {
      if (row.turn === turn) rows.delete(seq);
    }
  }

  const rounds = new Map();
  for (const round of (base && base.rounds) || []) rounds.set(round.turn, round);
  for (const round of (patch && patch.rounds) || []) rounds.set(round.turn, round);
  for (const turn of goneTurns) rounds.delete(turn);

  return {
    version: patch && Number.isSafeInteger(patch.version) ? patch.version : (base ? base.version : 0),
    nodeCount: patch && Number.isSafeInteger(patch.nodeCount) ? patch.nodeCount : (base ? base.nodeCount : 0),
    rows: [...rows.values()].sort((a, b) => a.seq - b.seq),
    rounds: [...rounds.values()].sort((a, b) => a.turn - b.turn),
    goneTurns,
    goneTools: Array.isArray(patch && patch.goneTools) ? patch.goneTools : []
  };
}

/** 生成本轮导出的 Markdown 文本（不含被删内容）。 */
function markdownOf(rounds, meta) {
  const m = meta || {};
  const lines = [];
  if (m.title) lines.push(`# ${m.title}`);
  lines.push(`> ${m.sessionId || ''}${m.exportedAt ? ' / ' + m.exportedAt : ''}`);
  const qLabel = m.questionLabel || '问';
  const aLabel = m.answerLabel || '答';
  for (const round of rounds) {
    lines.push('');
    lines.push(`## ${qLabel} ${round.turn}`);
    const question = (round.question || '').trim();
    if (question) {
      lines.push('');
      lines.push(question);
    }
    lines.push('');
    lines.push(`### ${aLabel}`);
    const answer = (round.answer || '').trim();
    lines.push('');
    lines.push(answer || '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 导出文件名：dsh-{sessionId}-{YYYYMMDD-HHmm}.md */
function exportFilename(sessionId, date) {
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safeId = String(sessionId == null ? '' : sessionId).replace(/[^\w.-]/g, '_').slice(0, 64);
  return `dsh-${safeId}-${stamp}.md`;
}

// ---------------------------------------------------------------------------
// 导航刻度
// ---------------------------------------------------------------------------

/**
 * 从导航刻度 aria-label（中/英）解析轮号：取最后一个整数。
 * 例：'第 3 问' -> 3，'Turn 12' -> 12，'第 10 问，共 5 轮' -> 5。
 */
function railTurnOf(label) {
  if (typeof label !== 'string') return null;
  const nums = label.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  const value = parseInt(nums[nums.length - 1], 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * 导航刻度的轮号解析：`data-index` 语义未验证，只在它与 aria-label 结果
 * 一致时才采用；不一致或缺失时完全回退到原有 railTurnOf，避免改变现状。
 * @param dataIndex 元素 data-index 属性（可能是 0-based，未验证）
 * @param label aria-label 文本
 */
function railTurnOfAttributes(dataIndex, label) {
  const byLabel = railTurnOf(label);
  const raw = typeof dataIndex === 'number'
    ? String(dataIndex)
    : (typeof dataIndex === 'string' ? dataIndex.trim() : '');
  const byIndex = /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
  if (byIndex !== null && Number.isFinite(byIndex) && byIndex >= 1) {
    if (byLabel === null) return byIndex;
    // aria-label 可能同时含「第 N 问」与「共 M 轮」：与首个整数或旧解析结果
    // 任一一致即可信；都不一致说明 data-index 语义不同（如 0-based），回退旧逻辑。
    const nums = typeof label === 'string' ? label.match(/\d+/g) : null;
    const first = nums && nums.length > 0 ? parseInt(nums[0], 10) : null;
    if (byIndex === byLabel || byIndex === first) return byIndex;
  }
  return byLabel;
}

/**
 * 计算虚拟轨道上每个可见刻度的向上压缩偏移。
 * @param items [{ turn, hidden }] 按轨道顺序
 * @returns [{ turn, hidden, offset }]，offset 为「排在它前面被隐藏的数量 * 10」像素。
 */
function collapseRail(items) {
  let hiddenBefore = 0;
  return (items || []).map((item) => {
    if (item.hidden) {
      hiddenBefore += 1;
      return { turn: item.turn, hidden: true, offset: 0 };
    }
    return { turn: item.turn, hidden: false, offset: hiddenBefore * 10 };
  });
}

// ---------------------------------------------------------------------------
// HTTP 围栏与状态码
// ---------------------------------------------------------------------------

/** 写请求体上限（字节）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 判断 Host 头是否为回环地址（localhost / 127.0.0.0/8 / ::1）。 */
function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.trim().length === 0) return false;
  const raw = hostHeader.trim();
  let host;
  if (raw.startsWith('[')) {
    // 带方括号的 IPv6（可含端口）：[::1] 或 [::1]:8080
    const close = raw.indexOf(']');
    if (close === -1) return false;
    host = raw.slice(1, close);
  } else if (raw.startsWith(':')) {
    // 裸 IPv6（如 ::1）
    host = raw;
  } else {
    // 主机名或 IPv4，剥端口
    const colon = raw.indexOf(':');
    host = colon === -1 ? raw : raw.slice(0, colon);
  }
  host = host.toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * 入站请求三重围栏（纯函数，便于离线测试）：
 * 1. 仅回环 Host（挡住 DNS rebinding / 局域网来源）；
 * 2. Sec-Fetch-Site 只接受 `same-origin` / `none`（用户直达）或缺失（非浏览器客户端）；
 *    显式拒绝 `cross-site` 与 `same-site`（同站不同端口 / 子域的本机页面）；
 * 3. 携带 Origin 时必须与服务同源（expectedOrigin 由宿主实时计算）；
 *    `expectedOrigin` 未知时一律拒绝带 Origin 的请求（失败即关闭）。
 */
function isTrustedRequest(info) {
  const { host, secFetchSite, origin, expectedOrigin } = info || {};
  if (!isLoopbackHost(host)) return false;
  if (secFetchSite !== undefined && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return false;
  }
  if (origin === undefined) return true;
  return expectedOrigin !== undefined && origin === expectedOrigin;
}

/** 错误码 -> HTTP 状态码映射。 */
function statusCodeOf(code) {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'INVALID_AMOUNT': return 400;
    case 'FORBIDDEN': return 403;
    case 'PAYLOAD_TOO_LARGE': return 413;
    case 'AGENT_BUSY': return 423;
    case 'SESSION_NOT_LIVE':
    case 'TARGET_NOT_FOUND':
    case 'NOT_DELETABLE':
    case 'NOT_A_USER_MESSAGE':
    case 'SPAN_NOT_CONTIGUOUS': return 409;
    case 'INTERNAL': return 500;
    default: return 500;
  }
}

/**
 * 判断异常是否为「智能体正忙」。
 * 优先使用结构化字段（err.code / err.status / err.statusCode），
 * 文案匹配只作为没有结构化字段时的兜底：
 * 宿主 @deepseek-ai/dsh-agent-loop 抛出的忙错误目前是普通 Error（无 code），
 * 因此兜底文案必须保留；但只要带了结构化字段，就以字段判定为准。
 */
const BUSY_CODES = new Set(['AGENT_BUSY', 'ALREADY_ACTIVE', 'EBUSY', 'BUSY']);

function isBusyError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = typeof err.code === 'string' ? err.code.trim().toUpperCase() : '';
  const statusRaw = err.status != null ? err.status : err.statusCode;
  const status = typeof statusRaw === 'number' && Number.isFinite(statusRaw) ? statusRaw : null;
  if (code !== '' && BUSY_CODES.has(code)) return true;
  if (status === 423) return true;
  if (code !== '' || status !== null) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('already has active work');
}

/** 依据 Content-Length 判断是否超限（离线可测的 413 判据）。 */
function bodyTooLarge(contentLength, limit = MAX_BODY_BYTES) {
  const length = Number(contentLength);
  return Number.isFinite(length) && length > limit;
}

// ---------------------------------------------------------------------------
// 费用统计：北京时间、峰谷定价、token 计价
// ---------------------------------------------------------------------------

/** 北京时间固定 UTC+8（无夏令时），不依赖宿主 / 浏览器本地时区。 */
const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 该日期起（含）周末全天谷价；之前周末仍按工作日时段判定。 */
const WEEKEND_VALLEY_SINCE = '2026-08-23';

/** 谷价 = 高峰价的一半（官方固定规则，非可调）。 */
const VALLEY_FACTOR = 0.5;

/**
 * 官方 2026 价目（单位 ¥/百万 token，取高峰价）。
 * 官方调价时只改这里与测试期望值；最后核对日期 2026-11-01。
 */
const PRICE_CHECKED_AT = '2026-11-01';
const PRICE_TABLE = {
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0, reasoning: 0 },
  'deepseek-v4-pro': { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0, reasoning: 0 },
  default: { cacheHit: 0.04, cacheMiss: 2.0, output: 8.0, reasoning: 0 }
};

/** 需要缓冲的计价事件类型（turn/start 单独处理，不占缓冲配额）。 */
const TURN_EVENT_TYPES = new Set(['request/header', 'assistant/attempt', 'assistant/message', 'turn/end']);

/** 单个 Turn 缓冲最多保留的计价事件条数；超出即放弃该轮（宁缺不错算）。 */
const MAX_TURN_EVENTS = 2000;

/** 金额校正允许的最大值（元）。 */
const MAX_CORRECTION_YUAN = 1e7;

/** 日累计保留天数（北京时间自然日）。 */
const DAILY_KEEP_DAYS = 90;

/** 把毫秒时间换算成北京时间的年月日与星期。 */
function beijingParts(ms) {
  const t = Number.isFinite(ms) ? ms : Date.now();
  const d = new Date(t + BJ_OFFSET_MS);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year,
    month,
    day,
    weekday: d.getUTCDay(),
    minutes,
    dateKey: `${year}-${pad(month)}-${pad(day)}`
  };
}

/** 北京时间的自然日键 `YYYY-MM-DD`。 */
function beijingDateKey(ms) {
  return beijingParts(ms).dateKey;
}

/** 由北京时间年月日 + 当日分钟数还原 epoch ms（日/月溢出由 Date.UTC 处理）。 */
function beijingMsOf(year, month, day, minutes) {
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) + minutes * 60000 - BJ_OFFSET_MS;
}

/** 是否为「周末全天谷价」生效后的周末（含阈值当天）。 */
function isValleyDay(parts) {
  const weekend = parts.weekday === 0 || parts.weekday === 6;
  return weekend && parts.dateKey >= WEEKEND_VALLEY_SINCE;
}

/** 高峰窗口：09:00–12:00、14:00–18:00（北京时间）。 */
function inPeakWindow(minutes) {
  return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
}

/** 下一个工作日的 09:00（跳过谷价周末）。 */
function nextWeekdayPeak(parts) {
  for (let i = 1; i <= 8; i += 1) {
    const at = beijingMsOf(parts.year, parts.month, parts.day + i, 540);
    if (!isValleyDay(beijingParts(at))) return at;
  }
  return beijingMsOf(parts.year, parts.month, parts.day + 1, 540);
}

/**
 * 判定某时刻的峰 / 谷状态与下一次切换时刻。
 * @param {number} ms epoch ms（缺省取当前）
 * @returns {{ period: "peak"|"offpeak", nextChangeAt: number }}
 */
function periodInfo(ms) {
  const t = Number.isFinite(ms) ? ms : Date.now();
  const parts = beijingParts(t);
  if (!isValleyDay(parts) && inPeakWindow(parts.minutes)) {
    const end = parts.minutes < 720 ? 720 : 1080;
    return { period: 'peak', nextChangeAt: beijingMsOf(parts.year, parts.month, parts.day, end) };
  }
  if (!isValleyDay(parts)) {
    if (parts.minutes < 540) {
      return { period: 'offpeak', nextChangeAt: beijingMsOf(parts.year, parts.month, parts.day, 540) };
    }
    if (parts.minutes < 840) {
      return { period: 'offpeak', nextChangeAt: beijingMsOf(parts.year, parts.month, parts.day, 840) };
    }
  }
  return { period: 'offpeak', nextChangeAt: nextWeekdayPeak(parts) };
}

/** 峰谷切换文案：`12:00 转谷价` / `明日 9:00 起高峰` / `周一 9:00 起高峰`。 */
function periodChangeText(nowMs, nextChangeAt, lang) {
  const isEn = lang === 'en';
  const now = beijingParts(nowMs);
  const next = beijingParts(nextChangeAt);
  const zhWeekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const enWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${Math.floor(next.minutes / 60)}:${pad(next.minutes % 60)}`;
  let dayPrefix = '';
  if (next.dateKey !== now.dateKey) {
    const tomorrowKey = beijingParts(nowMs + 24 * 3600 * 1000).dateKey;
    if (next.dateKey === tomorrowKey) {
      dayPrefix = isEn ? 'Tomorrow ' : '明日 ';
    } else {
      dayPrefix = (isEn ? enWeekdays : zhWeekdays)[next.weekday] + ' ';
    }
  }
  const action = periodInfo(nowMs).period === 'peak'
    ? (isEn ? 'off-peak at ' : '转谷价')
    : (isEn ? 'peak at ' : '起高峰');
  return isEn ? `${action}${dayPrefix}${time}` : `${dayPrefix}${time} ${action}`;
}

/** 按模型名取价目；未知 / 旧模型名回落到 default（与 deepseek-flash 同价）。 */
function priceFor(model, table) {
  const prices = table && typeof table === 'object' ? table : PRICE_TABLE;
  const key = String(model == null ? '' : model).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(prices, key)) return prices[key];
  return prices.default || PRICE_TABLE.default;
}

/** 计数型 token 值：非负安全整数才认。 */
function tokenCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * 单次金额：逐项用浮点元计算，最后一次性取整到微元（1e-6 元）。
 * reasoning 价一律 0（官方输出价已覆盖思考 token）。
 * @param usage 原始 usage（inputTokens / cacheReadTokens / outputTokens / reasoningTokens）
 * @param model 模型名
 * @param period "peak" | "offpeak"
 * @param table 价目表（缺省 PRICE_TABLE）
 * @returns {number} costMicros
 */
function turnCost(usage, model, period, table) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const p = priceFor(model, table);
  const factor = period === 'peak' ? 1 : VALLEY_FACTOR;
  const yuan =
    tokenCount(u.inputTokens) * p.cacheMiss / 1e6 +
    tokenCount(u.cacheReadTokens) * p.cacheHit / 1e6 +
    tokenCount(u.outputTokens) * p.output / 1e6 +
    tokenCount(u.reasoningTokens) * p.reasoning / 1e6;
  return Math.round(yuan * factor * 1e6);
}

/** 多个 (route, usage) 分组分别计价后求和（不同模型不会用错单价）。 */
function turnCostOfGroups(groups, period, table) {
  let micros = 0;
  for (const group of groups || []) {
    if (!group) continue;
    micros += turnCost(group.usage || group.tokens, group.model, period, table);
  }
  return micros;
}

/**
 * 取 assistant 流最后一帧 usage（stream 为官方 compact records 数组）。
 * 兼容 `{type:"chunk",chunk:{type:"usage",usage}}` 与直接 usage 记录。
 */
function streamUsageOf(stream) {
  if (Array.isArray(stream)) {
    for (let i = stream.length - 1; i >= 0; i -= 1) {
      const record = stream[i];
      if (!record || typeof record !== 'object') continue;
      if (record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
        return record.chunk.usage;
      }
      if (record.type === 'usage' && record.usage) return record.usage;
    }
    return undefined;
  }
  if (stream && typeof stream === 'object' && stream.usage && typeof stream.usage === 'object') {
    return stream.usage;
  }
  return undefined;
}

/** 消息路由：`message.source` 的 provider / model。 */
function routeOfMessage(message) {
  if (!message || typeof message !== 'object') return undefined;
  const source = message.source;
  if (!source || typeof source !== 'object') return undefined;
  if (typeof source.provider !== 'string' || source.provider.length === 0) return undefined;
  if (typeof source.model !== 'string' || source.model.length === 0) return undefined;
  return { provider: source.provider, model: source.model };
}

/** 归一化原始 usage：inputTokens / outputTokens 必须是计数，可选分项缺省按 0。 */
function normalizeCostUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0) return undefined;
  if (!Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) return undefined;
  const cacheReadTokens = tokenCount(usage.cacheReadTokens);
  const cacheWriteTokens = tokenCount(usage.cacheWriteTokens);
  const reasoningTokens = tokenCount(usage.reasoningTokens);
  return {
    inputTokens: usage.inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens,
    totalTokens: tokenCount(usage.totalTokens) || usage.inputTokens + cacheReadTokens + cacheWriteTokens + usage.outputTokens
  };
}

/** 从一个 step 的 message / attempt 取原始 usage（message 优先）。 */
function stepUsageOf(messageEvent, attemptEvent) {
  const messageData = messageEvent && messageEvent.data;
  if (messageData && messageData.usage) {
    const normalized = normalizeCostUsage(messageData.usage);
    if (normalized) return normalized;
  }
  if (messageData) {
    const fromStream = normalizeCostUsage(streamUsageOf(messageData.stream));
    if (fromStream) return fromStream;
  }
  const attemptData = attemptEvent && attemptEvent.data;
  if (attemptData) {
    const normalized = normalizeCostUsage(streamUsageOf(attemptData.stream));
    if (normalized) return normalized;
  }
  return undefined;
}

/** 路由列表里的第一条合法 route。 */
function routeOfUsage(usage) {
  if (!usage || typeof usage !== 'object' || !Array.isArray(usage.routes)) return undefined;
  for (const route of usage.routes) {
    if (!route) continue;
    if (typeof route.provider !== 'string' || route.provider.length === 0) continue;
    if (typeof route.model !== 'string' || route.model.length === 0) continue;
    return { provider: route.provider, model: route.model };
  }
  return undefined;
}

/**
 * provider → 计费口径：
 * - `deepseek-account` → account（账户余额可观测）
 * - 其他 DeepSeek 官方路由（如 deepseek-official）→ api-key
 * - 非 DeepSeek 的 provider（本地模型、第三方网关）→ local（不消耗 DeepSeek 余额）
 */
function routingOfProvider(provider) {
  if (typeof provider !== 'string' || provider.length === 0) return null;
  const key = provider.trim().toLowerCase();
  if (!key) return null;
  if (key === 'deepseek-account') return 'account';
  if (key.startsWith('deepseek')) return 'api-key';
  return 'local';
}

/**
 * 费用卡片样式枚举。数组顺序即设置页选项顺序：单行样式排在第一位。
 * 内部存储值沿用 `compact` / `default`，与旧版本配置兼容。
 */
const COST_LAYOUTS = ['compact', 'default'];
const DEFAULT_COST_LAYOUT = 'compact';

/**
 * 把已保存 / 未配置的样式值归一为枚举值。
 * 旧配置里的 `default` 保持不变（映射到「多行样式」），未知值回退到当前默认值。
 * @param value 配置中的 costLayout
 * @returns {'compact' | 'default'}
 */
function normalizeCostLayout(value) {
  return value === 'default' ? 'default' : DEFAULT_COST_LAYOUT;
}

/**
 * 费用相关开关的运行时视图：每次调用都重新读取 Config，默认值保持「开启」。
 * @param config 宿主 Config（可能被配置通道原地更新）
 * @returns {{ enabled: boolean, perTurn: boolean }}
 */
function costSwitches(config) {
  const cfg = config || {};
  return {
    enabled: cfg.usageStats !== false,
    perTurn: cfg.costPerTurn !== false
  };
}

/**
 * 聚合一轮（turn/start…turn/end）内各 step 的 usage。
 * 每个 step 只取最后一个有效 assistant 结果（message 优先，其次 attempt），
 * 重试产生的多个 attempt 不重复累加；不同 route 的 step 分别成组，由调用方分价求和。
 *
 * @param events 本轮缓冲事件（可含 turn/start、turn/end）
 * @param options { fallbackRoute } 本轮回退路由（最近一次 request/header）
 * @returns undefined 或 { at, endedAt, turn, provider, models, tokens, groups }
 */
function deriveTurnUsage(events, options) {
  if (!Array.isArray(events) || events.length === 0) return undefined;
  const fallbackRoute = options && options.fallbackRoute;
  let at;
  let endedAt;
  let turn;
  let headerRoute;
  const steps = new Map();
  const timeOf = (event) => {
    if (Number.isFinite(event.time)) return event.time;
    if (event.data && Number.isFinite(event.data.at)) return event.data.at;
    return undefined;
  };

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const data = event.data || {};
    if (event.type === 'turn/start') {
      if (turn === undefined && Number.isSafeInteger(data.turn)) turn = data.turn;
      if (at === undefined) at = timeOf(event);
      continue;
    }
    if (event.type === 'turn/end') {
      if (endedAt === undefined) endedAt = timeOf(event);
      continue;
    }
    if (event.type === 'request/header') {
      const config = data.header && data.header.config;
      if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
        headerRoute = { provider: config.provider, model: config.model };
      }
      continue;
    }
    if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message') continue;
    const step = Number.isSafeInteger(data.step) ? data.step : 0;
    let entry = steps.get(step);
    if (!entry) {
      entry = { message: undefined, attempt: undefined, headerRoute };
      steps.set(step, entry);
    }
    if (event.type === 'assistant/message') entry.message = event;
    else entry.attempt = event;
  }

  const groups = [];
  const models = [];
  const totals = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
  let provider;
  for (const entry of steps.values()) {
    const usage = stepUsageOf(entry.message, entry.attempt);
    if (!usage) continue;
    const messageRoute = entry.message ? routeOfMessage(entry.message.data && entry.message.data.message) : undefined;
    const route = messageRoute ||
      routeOfUsage(entry.message && entry.message.data && entry.message.data.usage) ||
      routeOfUsage(entry.attempt && entry.attempt.data && entry.attempt.data.usage) ||
      entry.headerRoute ||
      headerRoute ||
      fallbackRoute;
    const model = route && route.model ? route.model : undefined;
    groups.push({ provider: route ? route.provider : undefined, model, usage });
    if (!provider && route && route.provider) provider = route.provider;
    if (model && models.indexOf(model) === -1) models.push(model);
    for (const key of Object.keys(totals)) totals[key] += usage[key] || 0;
  }
  if (groups.length === 0) return undefined;

  return {
    at,
    endedAt,
    turn,
    provider: provider || undefined,
    models,
    tokens: totals,
    groups
  };
}

/** 新建一轮缓冲。 */
function createTurnBuffer(turn, at) {
  return { turn, at: Number.isFinite(at) ? at : Date.now(), events: [], overflow: false };
}

/**
 * 向缓冲追加一条计价事件。
 * @returns true 表示已收下；false 表示类型不需要 / 已溢出（overflow 置位）
 */
function appendTurnEvent(buffer, event) {
  if (!buffer || !event) return false;
  if (buffer.overflow) return false;
  if (!TURN_EVENT_TYPES.has(event.type)) return false;
  if (buffer.events.length >= MAX_TURN_EVENTS) {
    buffer.overflow = true;
    return false;
  }
  buffer.events.push(event);
  return true;
}

// ---------------------------------------------------------------------------
// 费用统计：余额观测（账户口径）与金额校正
// ---------------------------------------------------------------------------

/** 间隔超过 25 小时视为应用长时间未运行，不补记差额。 */
const MAX_OBSERVE_GAP_MS = 25 * 60 * 60 * 1000;

/** 校正后余额（允许为负）。 */
function correctedBalanceCents(account) {
  const a = account || {};
  const baseline = Number.isFinite(a.baselineCents) ? a.baselineCents : null;
  if (baseline === null) return null;
  return baseline -
    (Number.isFinite(a.observedSpendCents) ? a.observedSpendCents : 0) +
    (Number.isFinite(a.creditCents) ? a.creditCents : 0) -
    (Number.isFinite(a.debitCents) ? a.debitCents : 0);
}

/**
 * 一次余额观测的记账（纯函数，返回新状态与本次记账原因）。
 *
 * - 下降 → 累计「已观测消费」，按北京时间日期计入「日用」；
 * - 上升 → 累计「待核对余额调整」，绝不冲减消费；
 * - 跨日 / 间隔超 25h / 路由切换 → 只更新 lastBalance，跳过本次差额；
 * - 非 account 路由 → 完全不记账。
 *
 * @param state 持久化状态（不修改入参）
 * @param params { cents, routing, at }
 * @returns {{ state, reason }}
 */
function observeBalance(state, params) {
  const s = state || {};
  const cents = params && Number.isFinite(params.cents) ? Math.round(params.cents) : null;
  const routing = params && params.routing;
  const at = params && Number.isFinite(params.at) ? params.at : Date.now();
  const out = {
    baselineBalanceCents: Number.isFinite(s.baselineBalanceCents) ? s.baselineBalanceCents : null,
    lastBalanceCents: Number.isFinite(s.lastBalanceCents) ? s.lastBalanceCents : null,
    lastBalanceAt: Number.isFinite(s.lastBalanceAt) ? s.lastBalanceAt : 0,
    lastRouting: typeof s.lastRouting === 'string' ? s.lastRouting : null,
    observedSpendTotalCents: Number.isFinite(s.observedSpendTotalCents) ? s.observedSpendTotalCents : 0,
    dailySpendCents: Object.assign({}, s.dailySpendCents || {}),
    pendingAdjustmentCents: Number.isFinite(s.pendingAdjustmentCents) ? s.pendingAdjustmentCents : 0,
    pendingAdjustmentAt: Number.isFinite(s.pendingAdjustmentAt) ? s.pendingAdjustmentAt : 0
  };
  if (cents === null) return { state: out, reason: 'invalid' };
  if (routing !== 'account') return { state: out, reason: 'not-account' };

  if (out.baselineBalanceCents === null) {
    out.baselineBalanceCents = cents;
    out.lastBalanceCents = cents;
    out.lastBalanceAt = at;
    out.lastRouting = routing;
    return { state: out, reason: 'baseline' };
  }
  if (out.lastBalanceCents === null || out.lastBalanceAt === 0) {
    out.lastBalanceCents = cents;
    out.lastBalanceAt = at;
    out.lastRouting = routing;
    return { state: out, reason: 'first' };
  }
  if (out.lastRouting !== routing) {
    out.lastBalanceCents = cents;
    out.lastBalanceAt = at;
    out.lastRouting = routing;
    return { state: out, reason: 'routing-switch' };
  }
  if (beijingDateKey(out.lastBalanceAt) !== beijingDateKey(at)) {
    out.lastBalanceCents = cents;
    out.lastBalanceAt = at;
    return { state: out, reason: 'cross-day' };
  }
  if (at - out.lastBalanceAt > MAX_OBSERVE_GAP_MS) {
    out.lastBalanceCents = cents;
    out.lastBalanceAt = at;
    return { state: out, reason: 'too-long' };
  }

  const diff = out.lastBalanceCents - cents;
  let reason = 'none';
  if (diff > 0) {
    out.observedSpendTotalCents += diff;
    const key = beijingDateKey(at);
    out.dailySpendCents[key] = (out.dailySpendCents[key] || 0) + diff;
    reason = 'spend';
  } else if (diff < 0) {
    out.pendingAdjustmentCents += -diff;
    out.pendingAdjustmentAt = at;
    reason = 'adjust';
  }
  out.lastBalanceCents = cents;
  out.lastBalanceAt = at;
  return { state: out, reason };
}

/** 元（数字或字符串）转分；非法返回 null。 */
function yuanToCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const split = body.split('.');
  const whole = split[0];
  const frac = split[1] || '';
  let cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (frac.length > 2 && Number(frac.charAt(2)) >= 5) cents += 1;
  return negative ? -cents : cents;
}

/**
 * 校正金额校验：有限数字（或数字字符串）、≥ 0、最多两位小数、≤ 1e7。
 * @returns {{ ok: true, cents } | { ok: false, code: "INVALID_AMOUNT" }}
 */
function validateCorrectionAmount(value) {
  let num;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    const raw = value.trim().replace(/,/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(raw)) return { ok: false, code: 'INVALID_AMOUNT' };
    num = Number(raw);
  } else {
    return { ok: false, code: 'INVALID_AMOUNT' };
  }
  if (!Number.isFinite(num)) return { ok: false, code: 'INVALID_AMOUNT' };
  if (num < 0 || num > MAX_CORRECTION_YUAN) return { ok: false, code: 'INVALID_AMOUNT' };
  const cents = Math.round(num * 100);
  if (Math.abs(cents / 100 - num) > 1e-9) {
    return { ok: false, code: 'INVALID_AMOUNT' };
  }
  return { ok: true, cents };
}

/** 删除早于「北京今天 − keepDays 天」的日累计键（返回新对象）。 */
function pruneDailySpend(daily, nowMs, keepDays) {
  const days = Number.isFinite(keepDays) ? keepDays : DAILY_KEEP_DAYS;
  const cutoff = beijingDateKey((Number.isFinite(nowMs) ? nowMs : Date.now()) - days * 24 * 3600 * 1000);
  const out = {};
  for (const [key, value] of Object.entries(daily || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (key < cutoff) continue;
    if (!Number.isFinite(value)) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 费用统计：展示格式与动画辅助（客户端与离线测试共用）
// ---------------------------------------------------------------------------

/** 分 -> `16.84`（千分位、两位小数、允许负号）；非有限值返回 `—`。 */
function formatCents(cents) {
  if (!Number.isFinite(cents)) return '—';
  const rounded = Math.round(cents);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  const yuan = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fen = String(abs % 100).padStart(2, '0');
  return (negative ? '-' : '') + yuan + '.' + fen;
}

/** 分 -> `¥16.84`。 */
function formatYuanCents(cents) {
  const text = formatCents(cents);
  return text === '—' ? text : '¥' + text;
}

/**
 * 微元 -> 单次金额展示：
 * 0 → `¥0.00`；0 < x < ¥0.01 → `<¥0.01`；其余按分四舍五入。
 */
function formatCostMicros(micros) {
  if (!Number.isFinite(micros)) return '—';
  if (micros <= 0) return '¥0.00';
  if (micros < 10000) return '<¥0.01';
  return formatYuanCents(Math.round(micros / 10000));
}

/** 自动关闭时刻：秒数 0 / 非法返回 null（不自动关闭）；上限 600 秒。 */
function autoCloseAt(firstSeenAt, seconds) {
  const s = typeof seconds === 'string' ? Number(seconds) : seconds;
  if (!Number.isFinite(firstSeenAt) || !Number.isFinite(s) || s <= 0) return null;
  return firstSeenAt + Math.min(600, s) * 1000;
}

/** 数字滚动动画缓动：easeOutCubic，端点 0 → 0、1 → 1。 */
function easeOutCubic(t) {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return 1 - Math.pow(1 - x, 3);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 可取消的延迟执行器（DOM 观察器节流 / rAF 合并）。
 * 定时/取消函数可注入，便于离线测试「卸载后不再执行」。
 *
 * @param run 到点执行的回调
 * @param options { delay?: number, schedule?: (fn) => handle, cancel?: (handle) => void }
 * @returns {{ request: () => boolean, dispose: () => void, disposed: boolean }}
 */
function createScheduler(run, options) {
  const o = options || {};
  const schedule = typeof o.schedule === 'function'
    ? o.schedule
    : (fn) => setTimeout(fn, Number.isFinite(o.delay) ? o.delay : 0);
  const cancel = typeof o.cancel === 'function'
    ? o.cancel
    : (handle) => clearTimeout(handle);
  let handle = null;
  let disposed = false;

  return {
    request() {
      if (disposed || handle !== null) return false;
      handle = schedule(() => {
        handle = null;
        if (!disposed) run();
      });
      return true;
    },
    dispose() {
      disposed = true;
      if (handle !== null) {
        try { cancel(handle); } catch { /* 已触发 */ }
        handle = null;
      }
    },
    get disposed() {
      return disposed;
    }
  };
}

/**
 * 请求代际栅栏：用于丢弃「后发先至」的旧快照。
 * 每次 begin() 递增代号，只有最新代号的结果才允许写回。
 * @returns {{ begin: () => number, isLatest: (token: number) => boolean }}
 */
function createRequestGate() {
  let seq = 0;
  return {
    begin() {
      seq += 1;
      return seq;
    },
    isLatest(token) {
      return token === seq;
    }
  };
}

/** HTML 转义（用于浮层内注入标题/正文）。 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------------------------------------------------------------------------
// 图标（内置兜底：24 网格 / 1.5px 线宽 / round cap 的通用线性图标）
//
// 线宽 1.5 与官方图标（16 网格 / 1px 线宽）在 15px 尺寸下的视觉粗细一致，
// 因此官方组件缺失时混用也不会出现粗细差异。
// 运行时优先使用 DSH 官方图标组件（见 client.js 的 OFFICIAL_ICON_NAMES）。
// ---------------------------------------------------------------------------

const ICONS = {
  recall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 16V3"/><path d="m8 7 4-4 4 4"/></svg>',
  export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/><path d="M12 3v11"/><path d="m8 10 4 4 4-4"/></svg>',
  delete: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>',
  deleteFrom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M12 10v6"/><path d="m9 13 3 3 3-3"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L19 7"/></svg>'
};

// ---------------------------------------------------------------------------
// 客户端注入样式表
// ---------------------------------------------------------------------------

/**
 * 客户端注入的行内样式。仅依赖 CSS 变量（DSH 主题提供），不硬编码品牌色。
 */
const CSS = `
.dma-row-actions{display:inline-flex;align-items:center;gap:2px;vertical-align:middle}
.dma-tool-actions{display:inline-flex;align-items:center;gap:2px;margin-inline-start:6px;vertical-align:middle}
.dma-btn{display:inline-flex;align-items:center;justify-content:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8a919e);cursor:pointer;line-height:1;transition:background 80ms ease,color 80ms ease}
.dma-btn svg{display:block;width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.dma-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-btn:disabled{opacity:.35;cursor:not-allowed}
.dma-btn.dma-danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(229,72,77,.12));color:var(--dsw-alias-state-error-primary,#e5484d)}
.dma-stats{order:1;display:inline-flex;align-items:center;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary,#8a919e);white-space:nowrap;user-select:text;margin-inline:2px}
[data-dma-hidden="1"]{display:none!important}
[data-dma-rail="1"]{display:none!important}
.dma-overlay{position:fixed;inset:0;z-index:2147483000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));display:flex;align-items:center;justify-content:center}
.dma-panel{width:min(680px,calc(100vw - 48px));max-height:80vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#ffffff);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-panel,12px);box-shadow:var(--dsw-elevation-panel,0 18px 48px rgba(0,0,0,.18));overflow:hidden;color:var(--dsw-alias-label-primary,#1f2329)}
.dma-panel-head{padding:16px 20px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));font-size:16px;font-weight:600}
.dma-panel-body{overflow:auto;padding:12px 16px}
.dma-round{display:flex;gap:12px;align-items:flex-start;padding:10px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:8px}
.dma-round:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dma-round-box{flex:0 0 auto;width:20px;height:20px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3,#c9ced6);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;background:transparent;color:transparent;margin-top:2px}
.dma-round-box[aria-checked="true"]{border-color:var(--dsw-alias-state-business-primary,#4c8dff);background:var(--dsw-alias-state-business-primary,#4c8dff);color:#fff}
.dma-round-box svg{width:13px;height:13px}
.dma-round-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.dma-round-line{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px}
.dma-round-tag{flex:0 0 auto;font-size:11px;line-height:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-round-q{font-weight:600}
.dma-round-q .dma-round-tag{background:var(--dsw-alias-button-primary-dimmed,rgba(76,141,255,.14));color:var(--dsw-alias-state-business-primary,#4c8dff)}
.dma-round-tag-a{color:var(--dsw-alias-label-tertiary,#8a919e)}
.dma-round-a{color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-round-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dma-panel-foot{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.dma-panel-foot .dma-btn{width:auto;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3,#c9ced6);border-radius:8px;color:var(--dsw-alias-label-secondary,#5b6472)}
.dma-panel-foot .dma-primary{background:var(--dsw-alias-button-primary-fill,#4c8dff);color:var(--dsw-alias-label-primary-inverted,#fff);border-color:transparent}
.dma-panel-foot .dma-primary.dma-danger{background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff}
.dma-panel-foot .dma-primary:disabled{background:var(--dsw-alias-bg-layer-2,#f2f3f5);color:var(--dsw-alias-label-dimmed,#a0a6b0)}
.dma-panel-foot .dma-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c8dff);outline-offset:2px}
.dma-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483100;padding:8px 16px;border-radius:999px;background:var(--dsw-alias-toast-bg,rgba(32,35,42,.96));box-shadow:0 6px 20px rgba(0,0,0,.22);font-size:12px;line-height:1.6;color:var(--dsw-alias-toast-label,#fff);pointer-events:none}
`;

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

module.exports = {
  PRODUCER,
  TOMBSTONE_TEXT,
  ERROR_LABELS,
  contentText,
  textOf,
  messageRoleOf,
  messageIdOf,
  usageSummaryOf,
  toolCallIdOf,
  toolCallIdFromNodeKey,
  toolNodeKeysToHide,
  findToolRowByCallId,
  tombstonedSeqsOf,
  liveNodesOf,
  goneToolsOf,
  resolveKeyAction,
  isEditableTarget,
  TOOL_NODE_KEY_PREFIX,
  wordCount,
  previewText,
  formatTokens,
  isTombstone,
  buildTurnIndex,
  buildTurnSeqMap,
  createTurnLookup,
  turnOf,
  turnOfLookup,
  stepNodesOf,
  planAction,
  turnSpan,
  buildPlan,
  roundsOf,
  goneTurnsOf,
  messagesSummaryOf,
  mergeMessageSummary,
  markdownOf,
  exportFilename,
  railTurnOf,
  railTurnOfAttributes,
  collapseRail,
  createScheduler,
  createRequestGate,
  escapeHtml,
  MAX_BODY_BYTES,
  isLoopbackHost,
  isTrustedRequest,
  statusCodeOf,
  isBusyError,
  bodyTooLarge,
  BJ_OFFSET_MS,
  WEEKEND_VALLEY_SINCE,
  VALLEY_FACTOR,
  PRICE_CHECKED_AT,
  PRICE_TABLE,
  MAX_TURN_EVENTS,
  MAX_CORRECTION_YUAN,
  DAILY_KEEP_DAYS,
  MAX_OBSERVE_GAP_MS,
  beijingParts,
  beijingDateKey,
  beijingMsOf,
  isValleyDay,
  inPeakWindow,
  periodInfo,
  periodChangeText,
  priceFor,
  turnCost,
  turnCostOfGroups,
  streamUsageOf,
  routeOfMessage,
  routeOfUsage,
  routingOfProvider,
  costSwitches,
  COST_LAYOUTS,
  DEFAULT_COST_LAYOUT,
  normalizeCostLayout,
  normalizeCostUsage,
  stepUsageOf,
  deriveTurnUsage,
  createTurnBuffer,
  appendTurnEvent,
  correctedBalanceCents,
  observeBalance,
  yuanToCents,
  validateCorrectionAmount,
  pruneDailySpend,
  formatCents,
  formatYuanCents,
  formatCostMicros,
  autoCloseAt,
  easeOutCubic,
  ICONS,
  CSS
};