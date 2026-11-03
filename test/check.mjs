// dsh-message-actions 离线测试
//
// 只依赖共享纯函数（src/shared.cjs），无需 DSH 运行时即可运行：
//   node test/check.mjs
//
// 覆盖《开发需求与重写提示词.md》§7「离线测试必须覆盖」的全部行为。

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const s = require("../src/shared.cjs");
const store = require("../src/store.cjs");
const http = require("../src/http.cjs");
const i18n = require("../src/i18n.cjs");

const {
  planAction,
  roundsOf,
  goneTurnsOf,
  markdownOf,
  exportFilename,
  railTurnOf,
  railTurnOfAttributes,
  buildTurnIndex,
  buildTurnSeqMap,
  createTurnLookup,
  turnOf,
  turnOfLookup,
  costSwitches,
  createScheduler,
  createRequestGate,
  collapseRail,
  isTombstone,
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
  TOOL_NODE_KEY_PREFIX,
  messagesSummaryOf,
  wordCount,
  previewText,
  formatTokens,
  COST_LAYOUTS,
  DEFAULT_COST_LAYOUT,
  normalizeCostLayout,
  isLoopbackHost,
  isTrustedRequest,
  statusCodeOf,
  bodyTooLarge,
  TOMBSTONE_TEXT,
  PRODUCER
} = s;

// ---------------------------------------------------------------------------
// 微型断言框架
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(name);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  const cond = a === b;
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name} (期望 ${b}，得到 ${a})`);
  }
}

// ---------------------------------------------------------------------------
// 事件构造辅助
// ---------------------------------------------------------------------------

const SURFACE_TYPES = new Set([
  "system/message",
  "developer/message",
  "user/message",
  "assistant/message",
  "tool/result"
]);

function ev(type, data) {
  return { type, data };
}

/** 由「按 seq 索引的事件数组」构造 events + surface 节点列表。 */
function session(events) {
  const nodes = [];
  events.forEach((event, seq) => {
    if (event && SURFACE_TYPES.has(event.type)) nodes.push(seq);
  });
  return { events, nodes };
}

// ---------------------------------------------------------------------------
// 标准测试会话
// ---------------------------------------------------------------------------
// seq: 0=system, 1=turn/start(1), 2=user(q1), 3=assistant(t1s1), 4=tool(t1s1),
//      5=assistant(t1s2), 6=turn/end(1), 7=turn/start(2), 8=user(q2),
//      9=assistant(t2s1), 10=turn/end(2)
// surface nodes = [0, 2, 3, 4, 5, 8, 9]

function makeEvents() {
  return [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", { role: "user", id: "u1", content: [{ type: "text", text: "Hi" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "Hello" }] } }),
    ev("tool/result", { turn: 1, step: 1, message: { content: [{ type: "text", text: "tool-out" }] } }),
    ev("assistant/message", { turn: 1, step: 2, message: { content: [{ type: "text", text: "Done" }] } }),
    ev("turn/end", { turn: 1 }),
    ev("turn/start", { turn: 2 }),
    ev("user/message", { role: "user", id: "u2", content: [{ type: "text", text: "Next?" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 2, step: 1, message: { content: [{ type: "text", text: "Sure" }] } }),
    ev("turn/end", { turn: 2 })
  ];
}

// ---------------------------------------------------------------------------
// 1. 撤回 = 整轮
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan = planAction(events, nodes, { action: "recall", seq: 2 });
  ok("撤回返回 ok", plan.ok === true);
  eq("撤回 startSeq/endSeq", [plan.startSeq, plan.endSeq], [2, 5]);
  eq("撤回 removed", plan.removed, [2, 3, 4, 5]);
  eq("撤回 kinds", plan.kinds, ["user/message", "assistant/message", "tool/result", "assistant/message"]);
  eq("撤回 via", plan.via, "user");
  eq("撤回 turn", plan.turn, 1);
  eq("撤回 refillText", plan.refillText, "Hi");
}

// ---------------------------------------------------------------------------
// 1.1 撤回：轮次以运行时注入开头时，回填仍是真实提问
// ---------------------------------------------------------------------------

{
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", {
      role: "user",
      id: "ctx",
      content: [{ type: "text", text: "Current runtime context. This snapshot supersedes ..." }],
      source: { kind: "runtime-context" }
    }),
    ev("user/message", { role: "user", id: "u1", content: [{ type: "text", text: "Hi" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "Hello" }] } }),
    ev("turn/end", { turn: 1 })
  ];
  const { events: bag, nodes } = session(events);
  const plan = planAction(bag, nodes, { action: "recall", seq: 3 });
  ok("注入开头撤回返回 ok", plan.ok === true);
  eq("注入开头撤回整轮区间", [plan.startSeq, plan.endSeq], [2, 4]);
  eq("注入开头撤回 refillText 为真实提问", plan.refillText, "Hi");
  eq("注入开头撤回 removed 含注入", plan.removed, [2, 3, 4]);
}

// ---------------------------------------------------------------------------
// 2. 删除（问行）= 整轮
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan = planAction(events, nodes, { action: "delete", seq: 2 });
  ok("问行删除返回 ok", plan.ok === true);
  eq("问行删除 removed", plan.removed, [2, 3, 4, 5]);
  eq("问行删除 via", plan.via, "user");
  eq("问行删除 refillText 为 null", plan.refillText, null);
}

// ---------------------------------------------------------------------------
// 3. 删除（答行）= 整 step
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan = planAction(events, nodes, { action: "delete", seq: 3 });
  ok("答行删除(step1)返回 ok", plan.ok === true);
  eq("答行删除 removed", plan.removed, [3, 4]);
  eq("答行删除 via", plan.via, "assistant");
  eq("答行删除 turn", plan.turn, 1);
}

// ---------------------------------------------------------------------------
// 4. 删除（工具行）= 整 step
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan = planAction(events, nodes, { action: "delete", seq: 4 });
  ok("工具行删除返回 ok", plan.ok === true);
  eq("工具行删除 removed", plan.removed, [3, 4]);
  eq("工具行删除 via", plan.via, "tool");
}

// ---------------------------------------------------------------------------
// 5. 单 step 的答行（step2）
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan = planAction(events, nodes, { action: "delete", seq: 5 });
  eq("step2 删除 removed", plan.removed, [5]);
  eq("step2 删除 via", plan.via, "assistant");
}

// ---------------------------------------------------------------------------
// 6. 删至末尾
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan = planAction(events, nodes, { action: "deleteFrom", seq: 8 });
  ok("删至末尾返回 ok", plan.ok === true);
  eq("删至末尾 removed", plan.removed, [8, 9]);
  eq("删至末尾 via", plan.via, "user");
  eq("删至末尾 turn", plan.turn, 2);
}

// ---------------------------------------------------------------------------
// 7. 系统提示（节点 0）与 system/message 拒删
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan0 = planAction(events, nodes, { action: "delete", seq: 0 });
  eq("节点0拒删", plan0.code, "NOT_DELETABLE");

  // 非 0 位置的 system/message 也应拒绝
  const sysEvents = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("system/message", { message: { content: [{ type: "text", text: "mid" }] } }),
    ev("user/message", { role: "user", id: "u1", content: [{ type: "text", text: "x" }], source: { kind: "user" } })
  ];
  const sysSession = session(sysEvents);
  const planMid = planAction(sysSession.events, sysSession.nodes, { action: "delete", seq: 1 });
  eq("system/message 拒删", planMid.code, "NOT_DELETABLE");
}

// ---------------------------------------------------------------------------
// 8. 已删目标 / 目标不在表面
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan = planAction(events, nodes, { action: "delete", seq: 6 }); // turn/end 不在 surface
  eq("目标不在表面", plan.code, "TARGET_NOT_FOUND");
}

// ---------------------------------------------------------------------------
// 9. 交错 step 拒删
// ---------------------------------------------------------------------------

{
  const { events } = session(makeEvents());
  const nodes = [0, 2, 3, 5, 4, 8, 9]; // 把 5 插到 4 前面，制造不连续
  const plan = planAction(events, nodes, { action: "delete", seq: 3 });
  eq("交错 step 拒删", plan.code, "SPAN_NOT_CONTIGUOUS");
}

// ---------------------------------------------------------------------------
// 10. 未知 action
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const plan = planAction(events, nodes, { action: "purge", seq: 2 });
  eq("未知 action", plan.code, "INVALID_REQUEST");
}

// ---------------------------------------------------------------------------
// 11. 无 turn/start 的孤立提问只删自身
// ---------------------------------------------------------------------------

{
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("user/message", { role: "user", id: "orphan", content: [{ type: "text", text: "孤立提问" }], source: { kind: "user" } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", { role: "user", id: "q1", content: [{ type: "text", text: "q1" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "a1" }] } }),
    ev("turn/end", { turn: 1 })
  ];
  const { events: evs, nodes } = session(events); // nodes = [0,1,3,4]
  const plan = planAction(evs, nodes, { action: "delete", seq: 1 });
  ok("孤立提问删除返回 ok", plan.ok === true);
  eq("孤立提问只删自身 removed", plan.removed, [1]);
  eq("孤立提问 turn 为 null", plan.turn, null);
}

// ---------------------------------------------------------------------------
// 12. 撤回非 user 消息 / 系统来源
// ---------------------------------------------------------------------------

{
  const { events, nodes } = session(makeEvents());
  const planA = planAction(events, nodes, { action: "recall", seq: 3 });
  eq("撤回答行拒绝", planA.code, "NOT_A_USER_MESSAGE");

  const sysUser = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("user/message", { role: "user", id: "dev", content: [{ type: "text", text: "x" }], source: { kind: "developer" } })
  ];
  const s2 = session(sysUser);
  const planB = planAction(s2.events, s2.nodes, { action: "recall", seq: 1 });
  eq("撤回 developer 来源拒绝", planB.code, "NOT_DELETABLE");
}

// ---------------------------------------------------------------------------
// 13. 墓碑 source 字段 + content 非空 + 无 preview
// ---------------------------------------------------------------------------

{
  ok("墓碑正文非空(recall)", typeof TOMBSTONE_TEXT.recall === "string" && TOMBSTONE_TEXT.recall.length > 0);
  ok("墓碑正文非空(delete)", typeof TOMBSTONE_TEXT.delete === "string" && TOMBSTONE_TEXT.delete.length > 0);

  const tomb = ev("user/message", {
    role: "user",
    id: "t1",
    content: [{ type: "text", text: "[已删除]" }],
    source: { kind: "user", producer: PRODUCER, action: "delete", via: "user", removed: [2, 3], kinds: ["user/message", "assistant/message"], turn: 1 }
  });
  ok("isTombstone 识别", isTombstone(tomb) === true);
  ok("普通消息不被当作墓碑", isTombstone(ev("user/message", { role: "user", id: "u", content: [], source: { kind: "user" } })) === false);
  eq("墓碑 textOf", textOf(tomb), "[已删除]");
  ok("墓碑无 preview 字段", tomb.data.preview === undefined && tomb.data.truncated === undefined);
}

// ---------------------------------------------------------------------------
// 14. textOf / wordCount / previewText
// ---------------------------------------------------------------------------

{
  eq("wordCount 去空白", wordCount("a b c"), 3);
  eq("wordCount 中文", wordCount("你好 世界"), 4);
  eq("textOf 内容数组拼接", textOf(ev("user/message", { role: "user", id: "u", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] })), "AB");
  eq("textOf 空事件", textOf(null), "");
  eq("textOf 忽略 reasoning 块", textOf(ev("assistant/message", { message: { content: [{ type: "reasoning", text: "思考" }, { type: "text", text: "回答" }] } })), "回答");
  eq("previewText 折叠换行", previewText("第一行\n\n第二行", 100), "第一行 第二行");
  eq("previewText 空值", previewText(null, 10), "");
  eq("previewText 短文本不截断", previewText("短", 10), "短");
  const long = "0123456789".repeat(5);
  eq("previewText 截断加省略号", previewText(long, 12), "012345678901…");
  eq("previewText 0 上限返回空", previewText("任意", 0), "");
  eq("formatTokens 小于 1000", formatTokens(169), "169");
  eq("formatTokens 千位", formatTokens(1234), "1.2k");
  eq("formatTokens 整千", formatTokens(2000), "2k");
  eq("formatTokens 超十万", formatTokens(120000), "120k");
  eq("formatTokens 非法", formatTokens(-1), "");
}

// ---------------------------------------------------------------------------
// 15. 分享/导出：墓碑过滤 + 乐观墓碑过滤 + Markdown 不含被删文本
// ---------------------------------------------------------------------------

{
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", { role: "user", id: "q1", content: [{ type: "text", text: "被删的问题" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "被删的回答" }] } }),
    ev("turn/end", { turn: 1 }),
    ev("turn/start", { turn: 2 }),
    ev("user/message", { role: "user", id: "q2", content: [{ type: "text", text: "保留的问题" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 2, step: 1, message: { content: [{ type: "text", text: "保留的回答" }] } }),
    ev("turn/end", { turn: 2 }),
    // 墓碑替换 turn 1（乐观/已持久化墓碑，出现在 surface 中）
    ev("user/message", {
      role: "user", id: "tomb", content: [{ type: "text", text: "[已删除]" }],
      source: { kind: "user", producer: PRODUCER, action: "delete", via: "user", removed: [2, 3], kinds: ["user/message", "assistant/message"], turn: 1 }
    })
  ];
  // 替换后 surface：墓碑 seq 9 遮蔽 [2,3]
  const nodes = [0, 9, 6, 7];
  const rounds = roundsOf(events, nodes);
  eq("roundsOf 仅保留未删轮次", rounds.map((r) => r.turn), [2]);
  eq("roundsOf 提问", rounds[0].question, "保留的问题");
  eq("roundsOf 回答", rounds[0].answer, "保留的回答");

  const md = markdownOf(rounds, { sessionId: "sess-1", title: "标题" });
  ok("Markdown 不含被删问题", !md.includes("被删的问题"));
  ok("Markdown 不含被删回答", !md.includes("被删的回答"));
  ok("Markdown 含保留内容", md.includes("保留的问题") && md.includes("保留的回答"));

  // 空集合合法
  const emptyMd = markdownOf([], { sessionId: "s" });
  ok("空集合 markdown 合法", typeof emptyMd === "string" && emptyMd.length > 0);
}

// 一轮只取「第一条提问 + 最后一条回答」，注入消息与中间步骤不混入导出。
{
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", { role: "user", id: "q1", content: [{ type: "text", text: "真正的问题" }], source: { kind: "user" } }),
    ev("user/message", { role: "user", id: "q1b", content: [{ type: "text", text: "运行时注入上下文" }], source: { kind: "system" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "中间步骤" }] } }),
    ev("assistant/message", { turn: 1, step: 2, message: { content: [{ type: "text", text: "最终回答" }] } }),
    ev("turn/end", { turn: 1 }),
    ev("turn/start", { turn: 2 }),
    ev("user/message", { role: "user", id: "q2", content: [{ type: "text", text: "第二个问题" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 2, step: 1, message: { content: [{ type: "text", text: "第二个回答" }] } }),
    ev("turn/end", { turn: 2 })
  ];
  const nodes = events.map((_, seq) => seq).filter((seq) => ["user/message", "assistant/message"].includes(events[seq].type));
  const rounds = roundsOf(events, nodes);
  eq("roundsOf 首问末答 轮次", rounds.map((r) => r.turn), [1, 2]);
  eq("roundsOf 首问末答 提问", rounds[0].question, "真正的问题");
  eq("roundsOf 首问末答 回答", rounds[0].answer, "最终回答");
  ok("roundsOf 不含注入上下文", !markdownOf(rounds, {}).includes("运行时注入上下文"));
  ok("roundsOf 不含中间步骤", !markdownOf(rounds, {}).includes("中间步骤"));
}

// ---------------------------------------------------------------------------
// 15.1 /messages 摘要契约 + 工具行稳定映射
// ---------------------------------------------------------------------------
// 宿主工具行 DOM 的 data-chat-node-key = conversationContextKey("tool-call", id)
// = `9:tool-call<id>`，id 来自服务端 tool/call / tool/result 的 callId。
// 摘要行必须同时带 seq / callId，客户端才能从 DOM 稳定映射回服务端节点。

{
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", {
      role: "user",
      id: "u1",
      content: [{ type: "text", text: "这是一个比较长的问题，用来验证预览截断行为。" }],
      source: { kind: "user" }
    }),
    ev("tool/call", { callId: "call_abc" }),
    ev("tool/result", {
      turn: 1,
      step: 1,
      message: {
        content: [{ type: "text", text: "工具输出的完整正文，不应进入摘要。" }],
        source: { callId: "call_abc" }
      }
    }),
    ev("assistant/message", {
      turn: 1,
      step: 2,
      message: { id: "a1", content: [{ type: "text", text: "最终回答正文" }] },
      usage: { inputTokens: 10, outputTokens: 321 }
    }),
    ev("turn/end", { turn: 1 })
  ];
  const { events: bag, nodes } = session(events);
  const summary = messagesSummaryOf(bag, nodes, undefined, { previewLimit: 12 });

  ok("摘要行不携带完整正文", summary.rows.every((row) => !Object.prototype.hasOwnProperty.call(row, "text")));
  eq("摘要版本为最后一个表面 seq", summary.version, nodes[nodes.length - 1]);
  eq("摘要节点数", summary.nodeCount, nodes.length);
  eq("摘要轮次", summary.rounds.map((round) => round.turn), [1]);
  ok("摘要轮次只有预览字段", summary.rounds.every((round) =>
    !Object.prototype.hasOwnProperty.call(round, "question") &&
    !Object.prototype.hasOwnProperty.call(round, "answer")
  ));
  ok("摘要问行预览已截断", /^…|…$/.test(summary.rounds[0].questionPreview));
  eq("摘要答行预览", summary.rounds[0].answerPreview, "最终回答正文");

  const userRow = summary.rows.find((row) => row.type === "user/message");
  eq("摘要问行 words", userRow.words, wordCount("这是一个比较长的问题，用来验证预览截断行为。"));
  eq("摘要问行 role", userRow.role, "user");
  eq("摘要问行 id", userRow.id, "u1");

  const toolRow = summary.rows.find((row) => row.type === "tool/result");
  eq("摘要工具行 callId", toolRow.callId, "call_abc");
  eq("摘要工具行 preview 为空", toolRow.preview, "");
  eq("toolCallIdOf 从 tool/result 取 callId", toolCallIdOf(bag[4]), "call_abc");
  eq("toolCallIdOf 从 tool/call 取 callId", toolCallIdOf(bag[3]), "call_abc");

  const assistantRow = summary.rows.find((row) => row.type === "assistant/message");
  eq("摘要答行用量", assistantRow.usage, { outputTokens: 321 });
  eq("摘要答行 id", assistantRow.id, "a1");

  eq("工具节点 key 前缀", TOOL_NODE_KEY_PREFIX, "9:tool-call");
  eq("从宿主 node key 解析 callId", toolCallIdFromNodeKey("9:tool-callcall_abc"), "call_abc");
  eq("空 callId 不解析", toolCallIdFromNodeKey("9:tool-call"), null);
  eq("非工具节点不解析", toolCallIdFromNodeKey("9:assistant-messagea1"), null);

  const found = findToolRowByCallId(summary.rows, "call_abc");
  ok("按 callId 找到工具行", found !== null);
  eq("工具行映射到服务端 seq", found.seq, 4);
  eq("找不到 callId 返回 null", findToolRowByCallId(summary.rows, "missing"), null);

  // 映射到 seq 后仍走服务端已有 step 删除分支：单工具行 = 该 step 的节点。
  const plan = planAction(bag, nodes, { action: "delete", seq: found.seq });
  ok("工具行删除返回 ok", plan.ok === true);
  eq("工具行删除 via", plan.via, "tool");
  eq("工具行删除 step", plan.step, 1);
  eq("工具行删除 removed", plan.removed, [4]);
  eq("工具行删除 turn", plan.turn, 1);

  eq("messageRoleOf tool", messageRoleOf(bag[4]), "tool");
  eq("messageIdOf 缺失返回 undefined", messageIdOf(bag[4]), undefined);
  eq("usageSummaryOf 只回传 outputTokens", usageSummaryOf(bag[5]), { outputTokens: 321 });
  eq("usageSummaryOf 非答行返回 undefined", usageSummaryOf(bag[2]), undefined);
}

// ---------------------------------------------------------------------------
// 15.2 /messages 摘要只回传真实提问与回答预览
// ---------------------------------------------------------------------------
// system / developer 消息、运行时注入上下文（user/message + 非 user 来源）
// 与工具结果都不得进入 rows 的 preview / words。

{
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "系统提示正文" }] } }),
    ev("developer/message", { message: { content: [{ type: "text", text: "开发者提示正文" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", {
      role: "user",
      id: "ctx",
      content: [{ type: "text", text: "运行时注入上下文正文" }],
      source: { kind: "runtime-context" }
    }),
    ev("user/message", { role: "user", id: "u1", content: [{ type: "text", text: "真正的问题" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "回答" }] } }),
    ev("turn/end", { turn: 1 })
  ];
  const { events: bag, nodes } = session(events);
  const summary = messagesSummaryOf(bag, nodes, undefined, { previewLimit: 200 });

  const sysRow = summary.rows.find((row) => row.type === "system/message");
  eq("system 行预览为空", sysRow.preview, "");
  eq("system 行字数为零", sysRow.words, 0);
  const devRow = summary.rows.find((row) => row.type === "developer/message");
  eq("developer 行预览为空", devRow.preview, "");
  eq("developer 行字数为零", devRow.words, 0);
  const ctxRow = summary.rows.find((row) => row.id === "ctx");
  eq("运行时注入行预览为空", ctxRow.preview, "");
  eq("运行时注入行字数为零", ctxRow.words, 0);
  const userRow = summary.rows.find((row) => row.id === "u1");
  eq("真实提问仍有预览", userRow.preview, "真正的问题");
  eq("摘要 rounds 只含真实问答应答", summary.rounds.length, 1);
  eq("摘要 rounds 提问预览", summary.rounds[0].questionPreview, "真正的问题");
  eq("摘要 rounds 回答预览", summary.rounds[0].answerPreview, "回答");
  ok("摘要任何行都不含系统 / 开发者正文", !JSON.stringify(summary).includes("系统提示正文")
    && !JSON.stringify(summary).includes("开发者提示正文")
    && !JSON.stringify(summary).includes("运行时注入上下文正文"));
}

// ---------------------------------------------------------------------------
// 16. 导出文件名
// ---------------------------------------------------------------------------

{
  eq("exportFilename", exportFilename("abc123", new Date(2026, 9, 3, 14, 5)), "dsh-abc123-20261003-1405.md");
}

// ---------------------------------------------------------------------------
// 17. 导航刻度：railTurnOf（中英文）
// ---------------------------------------------------------------------------

{
  eq("railTurnOf 中文简单", railTurnOf("第 3 问"), 3);
  eq("railTurnOf 英文", railTurnOf("Turn 12"), 12);
  eq("railTurnOf 中文取最后整数", railTurnOf("第 10 问，共 5 轮"), 5);
  eq("railTurnOf 无数字", railTurnOf("no number"), null);
  eq("railTurnOf 非字符串", railTurnOf(null), null);
}

// ---------------------------------------------------------------------------
// 18. 导航刻度：collapseRail 偏移量
// ---------------------------------------------------------------------------

{
  const items = [
    { turn: 1, hidden: false },
    { turn: 2, hidden: true },
    { turn: 3, hidden: false },
    { turn: 4, hidden: true },
    { turn: 5, hidden: false }
  ];
  const out = collapseRail(items);
  eq("collapseRail turn1 offset", out[0].offset, 0);
  eq("collapseRail turn2 hidden", out[1].hidden, true);
  eq("collapseRail turn3 offset", out[2].offset, 10);
  eq("collapseRail turn4 hidden", out[3].hidden, true);
  eq("collapseRail turn5 offset", out[4].offset, 20);
}

// ---------------------------------------------------------------------------
// 19. 围栏：回环 Host
// ---------------------------------------------------------------------------

{
  ok("localhost", isLoopbackHost("localhost") === true);
  ok("127.0.0.1", isLoopbackHost("127.0.0.1") === true);
  ok("127.x 段", isLoopbackHost("127.8.7.6") === true);
  ok("::1", isLoopbackHost("::1") === true);
  ok("[::1]", isLoopbackHost("[::1]") === true);
  ok("localhost 带端口", isLoopbackHost("localhost:3080") === true);
  ok("公网 IP 拒绝", isLoopbackHost("192.168.1.1") === false);
  ok("公网域名拒绝", isLoopbackHost("example.com") === false);
  ok("空 Host 拒绝", isLoopbackHost("") === false);
  ok("缺 Host 拒绝", isLoopbackHost(undefined) === false);
}

// ---------------------------------------------------------------------------
// 20. 围栏：isTrustedRequest
// ---------------------------------------------------------------------------

{
  const origin = "http://127.0.0.1:3080";
  ok("回环+同源通过", isTrustedRequest({ host: "127.0.0.1:3080", secFetchSite: "same-origin", origin, expectedOrigin: origin }) === true);
  ok("cross-site 拒绝", isTrustedRequest({ host: "127.0.0.1:3080", secFetchSite: "cross-site", origin, expectedOrigin: origin }) === false);
  ok("公网 Host 拒绝", isTrustedRequest({ host: "evil.com", secFetchSite: "same-origin", origin: "http://evil.com", expectedOrigin: origin }) === false);
  ok("Origin 不匹配拒绝", isTrustedRequest({ host: "127.0.0.1:3080", secFetchSite: "same-origin", origin: "http://evil.com", expectedOrigin: origin }) === false);
  ok("缺 Host 拒绝", isTrustedRequest({ host: undefined, secFetchSite: "same-origin", origin, expectedOrigin: origin }) === false);
  ok("无 Origin 允许(非浏览器)", isTrustedRequest({ host: "127.0.0.1:3080", secFetchSite: "same-origin", origin: undefined, expectedOrigin: origin }) === true);
  ok("same-site 拒绝", isTrustedRequest({ host: "127.0.0.1:3080", secFetchSite: "same-site", origin: "http://127.0.0.1:9999", expectedOrigin: origin }) === false);
  ok("缺 Sec-Fetch-Site 且无 Origin 允许", isTrustedRequest({ host: "localhost:3080", origin: undefined, expectedOrigin: origin }) === true);
  ok("同源未知时带 Origin 拒绝", isTrustedRequest({ host: "127.0.0.1:3080", secFetchSite: "same-origin", origin, expectedOrigin: undefined }) === false);
  ok("用户直达(none)允许", isTrustedRequest({ host: "127.0.0.1:3080", secFetchSite: "none", origin: undefined, expectedOrigin: origin }) === true);
}

// ---------------------------------------------------------------------------
// 21. 1MB 413 / 运行中 423 / 状态码映射
// ---------------------------------------------------------------------------

{
  ok("1024KB 未超限(相等)", bodyTooLarge(1024 * 1024) === false);
  ok("超过 1MB 判超限", bodyTooLarge(1024 * 1024 + 1) === true);
  ok("非数字不算超限", bodyTooLarge("garbage") === false);
  ok("小值不算超限", bodyTooLarge(10) === false);

  eq("INVALID_REQUEST -> 400", statusCodeOf("INVALID_REQUEST"), 400);
  eq("FORBIDDEN -> 403", statusCodeOf("FORBIDDEN"), 403);
  eq("PAYLOAD_TOO_LARGE -> 413", statusCodeOf("PAYLOAD_TOO_LARGE"), 413);
  eq("AGENT_BUSY(运行中) -> 423", statusCodeOf("AGENT_BUSY"), 423);
  eq("SESSION_NOT_LIVE -> 409", statusCodeOf("SESSION_NOT_LIVE"), 409);
  eq("TARGET_NOT_FOUND -> 409", statusCodeOf("TARGET_NOT_FOUND"), 409);
  eq("NOT_DELETABLE -> 409", statusCodeOf("NOT_DELETABLE"), 409);
  eq("NOT_A_USER_MESSAGE -> 409", statusCodeOf("NOT_A_USER_MESSAGE"), 409);
  eq("SPAN_NOT_CONTIGUOUS -> 409", statusCodeOf("SPAN_NOT_CONTIGUOUS"), 409);
  eq("INTERNAL -> 500", statusCodeOf("INTERNAL"), 500);
}

// ---------------------------------------------------------------------------
// 22. goneTurnsOf：日志有 turn/start 但表面无活节点的轮次
// ---------------------------------------------------------------------------

{
  const { events } = session(makeEvents());
  eq("goneTurnsOf 全活为空", goneTurnsOf(events, [0, 2, 3, 4, 5, 8, 9]), []);
  eq("goneTurnsOf 删至末尾后尾轮消失", goneTurnsOf(events, [0, 2, 3, 4, 5]), [2]);
  eq("goneTurnsOf 撤回首轮后消失", goneTurnsOf(events, [0, 8, 9]), [1]);
}

// ---------------------------------------------------------------------------
// 23. 费用统计：峰谷定价（北京时间 UTC+8）
// ---------------------------------------------------------------------------

/** 由北京时间构造 epoch ms（测试机时区无关）。 */
function bj(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh, mm, 0, 0) - 8 * 3600 * 1000;
}

{
  const peak = s.periodInfo(bj(2026, 11, 2, 10, 0));
  eq("周一 10:00 = 高峰", peak.period, "peak");
  eq("周一 10:00 下一跳 12:00", peak.nextChangeAt, bj(2026, 11, 2, 12, 0));

  const noonBreak = s.periodInfo(bj(2026, 11, 2, 13, 0));
  eq("周一 13:00 = 谷价", noonBreak.period, "offpeak");
  eq("周一 13:00 下一跳 14:00", noonBreak.nextChangeAt, bj(2026, 11, 2, 14, 0));

  const evening = s.periodInfo(bj(2026, 11, 2, 19, 0));
  eq("周一 19:00 = 谷价", evening.period, "offpeak");
  eq("周一 19:00 下一跳周二 9:00", evening.nextChangeAt, bj(2026, 11, 3, 9, 0));

  const weekend = s.periodInfo(bj(2026, 11, 7, 10, 0));
  eq("2026-08-23 后周末 10:00 = 谷价", weekend.period, "offpeak");
  eq("周末下一跳周一 9:00", weekend.nextChangeAt, bj(2026, 11, 9, 9, 0));

  const oldWeekend = s.periodInfo(bj(2026, 8, 15, 10, 0));
  eq("2026-08-23 前周末 10:00 = 高峰", oldWeekend.period, "peak");
  eq("阈值前周末下一跳 12:00", oldWeekend.nextChangeAt, bj(2026, 8, 15, 12, 0));

  const threshold = s.periodInfo(bj(2026, 8, 23, 10, 0));
  eq("阈值当天（周日）= 谷价", threshold.period, "offpeak");
  eq("阈值当天下一跳周一 9:00", threshold.nextChangeAt, bj(2026, 8, 24, 9, 0));

  eq("峰谷切换文案（转谷价）", s.periodChangeText(bj(2026, 11, 2, 10, 0), bj(2026, 11, 2, 12, 0), "zh"), "12:00 转谷价");
  eq("峰谷切换文案（明日）", s.periodChangeText(bj(2026, 11, 2, 19, 0), bj(2026, 11, 3, 9, 0), "zh"), "明日 9:00 起高峰");
  eq("峰谷切换文案（周一）", s.periodChangeText(bj(2026, 11, 7, 10, 0), bj(2026, 11, 9, 9, 0), "zh"), "周一 9:00 起高峰");
  eq("峰谷切换文案（en）", s.periodChangeText(bj(2026, 11, 2, 19, 0), bj(2026, 11, 3, 9, 0), "en"), "peak at Tomorrow 9:00");
}

// ---------------------------------------------------------------------------
// 24. 费用统计：金额换算
// ---------------------------------------------------------------------------

{
  eq("flash 百万输入（高峰）= ¥2", s.turnCost({ inputTokens: 1000000 }, "deepseek-flash", "peak"), 2000000);
  eq("flash 百万输入（谷价）= ¥1", s.turnCost({ inputTokens: 1000000 }, "deepseek-flash", "offpeak"), 1000000);
  eq("缓存命中百万 = ¥0.04", s.turnCost({ cacheReadTokens: 1000000 }, "deepseek-flash", "peak"), 40000);
  eq("v4-pro 百万输入 = ¥9", s.turnCost({ inputTokens: 1000000 }, "deepseek-v4-pro", "peak"), 9000000);
  eq("未知模型回落 default", s.turnCost({ inputTokens: 1000000 }, "deepseek-v4-flash", "peak"), 2000000);
  eq("reasoning 不计费", s.turnCost({ inputTokens: 1000000, reasoningTokens: 1000000 }, "deepseek-flash", "peak"), 2000000);
  eq("0 token = 0 元", s.turnCost({}, "deepseek-flash", "peak"), 0);
  eq("极小金额不被抹成 0", s.turnCost({ inputTokens: 1 }, "deepseek-flash", "peak"), 2);
  eq(
    "分项求和一次取整",
    s.turnCost({ inputTokens: 100, cacheReadTokens: 100, outputTokens: 100 }, "deepseek-flash", "peak"),
    Math.round((100 * 2.0 / 1e6 + 100 * 0.04 / 1e6 + 100 * 8.0 / 1e6) * 1e6)
  );
  eq(
    "多路由分组分价",
    s.turnCostOfGroups([
      { model: "deepseek-flash", usage: { inputTokens: 1000000 } },
      { model: "deepseek-v4-pro", usage: { inputTokens: 1000000 } }
    ], "offpeak"),
    5500000
  );
}

// ---------------------------------------------------------------------------
// 25. 费用统计：usage 聚合
// ---------------------------------------------------------------------------

{
  const usage = { inputTokens: 200, cacheReadTokens: 50, outputTokens: 20, reasoningTokens: 5 };
  const events = [
    { type: "turn/start", time: bj(2026, 11, 2, 10, 0), data: { turn: 1 } },
    { type: "request/header", time: bj(2026, 11, 2, 10, 0), data: { header: { config: { provider: "deepseek-account", model: "deepseek-flash" } } } },
    { type: "assistant/attempt", time: bj(2026, 11, 2, 10, 1), data: { turn: 1, step: 1, stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } } }] } },
    { type: "assistant/message", time: bj(2026, 11, 2, 10, 2), data: { turn: 1, step: 1, usage, message: { source: { provider: "deepseek-account", model: "deepseek-flash" } } } },
    { type: "turn/end", time: bj(2026, 11, 2, 10, 3), data: { turn: 1 } }
  ];
  const derived = s.deriveTurnUsage(events);
  eq("聚合 turn/step", [derived.turn, derived.at, derived.endedAt], [1, bj(2026, 11, 2, 10, 0), bj(2026, 11, 2, 10, 3)]);
  eq("message usage 优先于 attempt", derived.tokens.inputTokens, 200);
  eq("聚合 reasoning", derived.tokens.reasoningTokens, 5);
  eq("聚合 totalTokens", derived.tokens.totalTokens, 200 + 50 + 20);
  eq("聚合路由", derived.provider, "deepseek-account");
  eq("聚合模型", derived.models, ["deepseek-flash"]);
  eq("聚合分组数", derived.groups.length, 1);

  const retry = s.deriveTurnUsage([
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/attempt", data: { step: 1, stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } } }] } },
    { type: "assistant/attempt", data: { step: 1, stream: [{ type: "chunk", chunk: { type: "usage", usage: { inputTokens: 50, outputTokens: 5 } } }] } },
    { type: "turn/end", data: { turn: 1 } }
  ]);
  eq("重试 attempt 只取最后一个", [retry.tokens.inputTokens, retry.tokens.outputTokens], [50, 5]);

  const multi = s.deriveTurnUsage([
    { type: "turn/start", time: bj(2026, 11, 2, 10, 0), data: { turn: 2 } },
    { type: "assistant/message", data: { turn: 2, step: 1, usage: { inputTokens: 100, outputTokens: 10, routes: [{ provider: "deepseek-account", model: "deepseek-flash" }] } } },
    { type: "assistant/message", data: { turn: 2, step: 2, usage: { inputTokens: 200, outputTokens: 20, routes: [{ provider: "deepseek-account", model: "deepseek-v4-pro" }] } } },
    { type: "turn/end", data: { turn: 2 } }
  ]);
  eq("多 step token 求和", [multi.tokens.inputTokens, multi.tokens.outputTokens], [300, 30]);
  eq("多模型按路由分组", multi.models, ["deepseek-flash", "deepseek-v4-pro"]);
  eq("多模型分组数", multi.groups.length, 2);
  eq("多模型金额分价求和", s.turnCostOfGroups(multi.groups, "peak"), 100 * 2 / 1e6 * 1e6 + 10 * 8 / 1e6 * 1e6 + 200 * 9 / 1e6 * 1e6 + 20 * 27 / 1e6 * 1e6);

  eq("缺 reasoning 兜底为 0", s.normalizeCostUsage({ inputTokens: 1, outputTokens: 1 }).reasoningTokens, 0);
  eq("整轮无 usage → undefined", s.deriveTurnUsage([{ type: "turn/start", data: { turn: 1 } }, { type: "turn/end", data: { turn: 1 } }]), undefined);
  eq("空事件 → undefined", s.deriveTurnUsage([]), undefined);
}

// ---------------------------------------------------------------------------
// 26. 费用统计：Turn 缓冲上限
// ---------------------------------------------------------------------------

{
  const buffer = s.createTurnBuffer(1, 1000);
  for (let i = 0; i < 2000; i += 1) {
    ok(`缓冲第 ${i + 1} 条收下`, s.appendTurnEvent(buffer, { type: "assistant/message", data: { step: 1 } }));
  }
  ok("第 2001 条触发 overflow", s.appendTurnEvent(buffer, { type: "assistant/message", data: { step: 1 } }) === false && buffer.overflow === true);
  ok("overflow 后拒绝后续事件", s.appendTurnEvent(buffer, { type: "assistant/message", data: {} }) === false);
  ok("非计价事件不入缓冲", s.appendTurnEvent(s.createTurnBuffer(2, 1000), { type: "tool/result", data: {} }) === false);
  ok("turn/end 计入缓冲", s.appendTurnEvent(s.createTurnBuffer(3, 1000), { type: "turn/end", data: {} }) === true);
}

// ---------------------------------------------------------------------------
// 27. 费用统计：余额观测
// ---------------------------------------------------------------------------

{
  const at1 = bj(2026, 11, 2, 10, 0);
  let r = s.observeBalance(store.defaultState(), { cents: 1684, routing: "account", at: at1 });
  eq("首次观测 → baseline", r.reason, "baseline");
  eq("基线写入", [r.state.baselineBalanceCents, r.state.lastBalanceCents], [1684, 1684]);

  r = s.observeBalance(r.state, { cents: 1600, routing: "account", at: at1 + 60000 });
  eq("余额下降 → spend", r.reason, "spend");
  eq("下降累计消费", r.state.observedSpendTotalCents, 84);
  eq("按北京日期记日用", r.state.dailySpendCents["2026-11-02"], 84);

  r = s.observeBalance(r.state, { cents: 1600, routing: "account", at: at1 + 120000 });
  eq("余额相等 → none", r.reason, "none");
  eq("等值不重复记账", r.state.observedSpendTotalCents, 84);

  r = s.observeBalance(r.state, { cents: 2000, routing: "account", at: at1 + 180000 });
  eq("余额上升 → adjust", r.reason, "adjust");
  eq("上升记待核对", r.state.pendingAdjustmentCents, 400);
  eq("上升不冲减消费", r.state.observedSpendTotalCents, 84);

  const overnight = Object.assign(store.defaultState(), {
    baselineBalanceCents: 20000,
    lastBalanceCents: 18000,
    lastBalanceAt: bj(2026, 11, 1, 23, 50),
    lastRouting: "account",
    observedSpendTotalCents: 1000,
    dailySpendCents: { "2026-11-01": 1000 }
  });
  const cross = s.observeBalance(overnight, { cents: 17500, routing: "account", at: bj(2026, 11, 2, 0, 10) });
  eq("跨日 → cross-day", cross.reason, "cross-day");
  eq("跨日不累计消费", cross.state.observedSpendTotalCents, 1000);
  eq("跨日不写今天日用", cross.state.dailySpendCents["2026-11-02"], undefined);

  const longGap = Object.assign(store.defaultState(), {
    baselineBalanceCents: 20000,
    lastBalanceCents: 18000,
    lastBalanceAt: at1 - 30 * 3600 * 1000,
    lastRouting: "account"
  });
  const gap = s.observeBalance(longGap, { cents: 17000, routing: "account", at: at1 });
  ok("长间隔不累计（cross-day / too-long）", gap.reason === "cross-day" || gap.reason === "too-long");
  eq("长间隔不累计消费", gap.state.observedSpendTotalCents, 0);

  const switched = Object.assign(store.defaultState(), {
    baselineBalanceCents: 20000,
    lastBalanceCents: 20000,
    lastBalanceAt: at1 - 60000,
    lastRouting: "api-key"
  });
  const sw = s.observeBalance(switched, { cents: 19000, routing: "account", at: at1 });
  eq("路由切换 → routing-switch", sw.reason, "routing-switch");
  eq("路由切换不累计", sw.state.observedSpendTotalCents, 0);
  eq("路由切换只更新 lastBalance", sw.state.lastBalanceCents, 19000);

  const apiKey = s.observeBalance(Object.assign(store.defaultState(), {
    baselineBalanceCents: 20000,
    lastBalanceCents: 20000,
    lastBalanceAt: at1 - 60000,
    lastRouting: "account"
  }), { cents: 10000, routing: "api-key", at: at1 });
  eq("非 account 不记账", apiKey.reason, "not-account");
  eq("非 account 不更新 lastBalance", apiKey.state.lastBalanceCents, 20000);

  eq("非法金额 → invalid", s.observeBalance(store.defaultState(), { cents: Number.NaN, routing: "account", at: at1 }).reason, "invalid");

  // 开 → 关 → 开：关闭时清空基线（lastBalanceCents / lastBalanceAt 置空），
  // 重新开启后的首次观测只建基线，不补记关闭期间产生的消费。
  const closed = Object.assign({}, r.state, { lastBalanceCents: null, lastBalanceAt: 0 });
  const reopened = s.observeBalance(closed, { cents: 1200, routing: "account", at: at1 + 3600000 });
  eq("关闭再开启 → 首次观测只建基线", reopened.reason, "first");
  eq("不补记关闭期间消费", reopened.state.observedSpendTotalCents, r.state.observedSpendTotalCents);
  eq("关闭期间消费不进当日日用", reopened.state.dailySpendCents["2026-11-02"], 84);
}

// ---------------------------------------------------------------------------
// 28. 费用统计：余额校正
// ---------------------------------------------------------------------------

{
  eq("校正后余额 = 基线 - 消费 + 到账 - 扣减", s.correctedBalanceCents({
    baselineCents: 20000,
    observedSpendCents: 5000,
    creditCents: 3000,
    debitCents: 1000
  }), 17000);
  eq("校正后余额允许为负", s.correctedBalanceCents({
    baselineCents: 1000,
    observedSpendCents: 5000,
    creditCents: 0,
    debitCents: 0
  }), -4000);
  eq("缺基线 → null", s.correctedBalanceCents({ observedSpendCents: 100 }), null);

  eq("金额字符串转分", s.validateCorrectionAmount("12.34"), { ok: true, cents: 1234 });
  eq("金额数字转分", s.validateCorrectionAmount(12.34), { ok: true, cents: 1234 });
  eq("千分位字符串", s.validateCorrectionAmount("1,000"), { ok: true, cents: 100000 });
  eq("0 合法", s.validateCorrectionAmount("0"), { ok: true, cents: 0 });
  eq("三位小数拒绝", s.validateCorrectionAmount("1.234"), { ok: false, code: "INVALID_AMOUNT" });
  eq("三位小数数字也拒绝", s.validateCorrectionAmount(1.234), { ok: false, code: "INVALID_AMOUNT" });
  eq("负数拒绝", s.validateCorrectionAmount("-1"), { ok: false, code: "INVALID_AMOUNT" });
  eq("超大金额拒绝", s.validateCorrectionAmount(10000001), { ok: false, code: "INVALID_AMOUNT" });
  eq("非数字拒绝", s.validateCorrectionAmount("abc"), { ok: false, code: "INVALID_AMOUNT" });
  eq("空值拒绝", s.validateCorrectionAmount(""), { ok: false, code: "INVALID_AMOUNT" });
  eq("INVALID_AMOUNT -> 400", statusCodeOf("INVALID_AMOUNT"), 400);

  eq("元字符串转分", s.yuanToCents("16.84"), 1684);
  eq("元数字转分", s.yuanToCents(16.84), 1684);
  eq("元非法 → null", s.yuanToCents("abc"), null);
}

// ---------------------------------------------------------------------------
// 29. 费用统计：展示格式与自动关闭
// ---------------------------------------------------------------------------

{
  eq("formatCents 两位小数", s.formatCents(1684), "16.84");
  eq("formatCents 千分位", s.formatCents(123456789), "1,234,567.89");
  eq("formatCents 负数", s.formatCents(-50), "-0.50");
  eq("formatCents 非数", s.formatCents(Number.NaN), "—");
  eq("formatYuanCents", s.formatYuanCents(1684), "¥16.84");
  eq("formatCostMicros 0", s.formatCostMicros(0), "¥0.00");
  eq("formatCostMicros 小于一分", s.formatCostMicros(5000), "<¥0.01");
  eq("formatCostMicros 一分", s.formatCostMicros(10000), "¥0.01");
  eq("formatCostMicros 四舍五入到分", s.formatCostMicros(20234), "¥0.02");
  eq("autoCloseAt 6 秒", s.autoCloseAt(1000, 6), 7000);
  eq("autoCloseAt 0 不关闭", s.autoCloseAt(1000, 0), null);
  eq("autoCloseAt 非法", s.autoCloseAt(1000, "abc"), null);
  eq("autoCloseAt 上限 600 秒", s.autoCloseAt(1000, 1000), 601000);
  eq("easeOutCubic 起点", s.easeOutCubic(0), 0);
  eq("easeOutCubic 终点", s.easeOutCubic(1), 1);
  eq("easeOutCubic 中点", s.easeOutCubic(0.5), 0.875);
}

// ---------------------------------------------------------------------------
// 30. 费用统计：状态文件
// ---------------------------------------------------------------------------

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dma-cost-"));
  try {
    const home = path.join(tmp, "home");
    eq("DSH_HOME 路径解析", store.resolveDshHome({ DSH_HOME: home }), home);
    eq(
      "状态文件路径",
      store.resolveStatePath({ DSH_HOME: home }),
      path.join(home, "plugins", "dsh-message-actions", "cost-state.json")
    );
    eq("~ 展开", store.expandHome("~"), os.homedir());

    const file = store.resolveStatePath({ DSH_HOME: home });
    const saved = Object.assign(store.defaultState(), {
      baselineBalanceCents: 1684,
      observedSpendTotalCents: 84,
      dailySpendCents: { "2026-11-02": 84 },
      correctionCreditCents: 3000,
      correctionDebitCents: 1000
    });
    store.saveCostState(file, saved);
    const loaded = store.loadCostState(file);
    eq("原子写后读取一致", loaded.state.correctionCreditCents, 3000);
    eq("读取非损坏", loaded.recovered, false);
    eq("状态版本", loaded.state.version, 1);
    eq("普通版本可写", loaded.readOnly, false);

    fs.writeFileSync(file, "{ not json", "utf8");
    const recovered = store.loadCostState(file);
    eq("损坏 JSON 从空状态启动", recovered.recovered, true);
    eq("损坏后基线为空", recovered.state.baselineBalanceCents, null);
    const badFiles = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bad-"));
    ok("损坏文件改名保留", badFiles.length === 1);

    fs.writeFileSync(file, JSON.stringify(saved), "utf8");
    const badBefore = fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bad-")).length;
    const tooLarge = store.loadCostState(file, undefined, 32);
    eq("超大状态文件重建为默认状态", tooLarge.state.baselineBalanceCents, null);
    eq("超大状态文件标记为已恢复", tooLarge.recovered, true);
    eq("超大状态文件恢复可写", tooLarge.readOnly, false);
    eq(
      "超大状态文件已原子重建落盘",
      JSON.parse(fs.readFileSync(file, "utf8")).version,
      store.STATE_VERSION
    );
    eq(
      "超大状态文件不新增 .bad 副本",
      fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".bad-")).length,
      badBefore
    );
    // 重建后必须能继续正常持久化（不是本次运行只读）。
    const rewritten = Object.assign(tooLarge.state, { baselineBalanceCents: 999 });
    store.saveCostState(file, rewritten);
    eq("重建后下一次写入成功", store.loadCostState(file).state.baselineBalanceCents, 999);
    ok("状态文件默认上限 4MB", store.MAX_STATE_BYTES === 4 * 1024 * 1024);

    const high = store.normalizeCostState({ version: 2, baselineBalanceCents: 100 });
    eq("高版本只读", high.readOnly, true);
    eq("高版本字段仍可读", high.state.baselineBalanceCents, 100);

    const pruned = s.pruneDailySpend({ "2026-08-01": 10, "2026-08-05": 20, "2026-11-02": 30 }, bj(2026, 11, 2, 12, 0), 90);
    eq("90 天裁剪删除过期键", Object.keys(pruned), ["2026-08-05", "2026-11-02"]);
    eq("裁剪保留有效金额", pruned["2026-11-02"], 30);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 31. 计费路由判定（provider → account / api-key / local）
// ---------------------------------------------------------------------------

{
  eq("账户登录路由", s.routingOfProvider("deepseek-account"), "account");
  eq("官方 API key 路由", s.routingOfProvider("deepseek-official"), "api-key");
  eq("本地模型路由", s.routingOfProvider("ninfer-27b"), "local");
  eq("第三方网关按本地处理", s.routingOfProvider("openai-compatible"), "local");
  eq("大小写与空白归一", s.routingOfProvider("  DeepSeek-Account "), "account");
  eq("空 provider", s.routingOfProvider(""), null);
  eq("非字符串 provider", s.routingOfProvider(undefined), null);
}

// ---------------------------------------------------------------------------
// 32. 轮次索引：seq→turn 映射必须与旧 turnOf 逐条一致
// ---------------------------------------------------------------------------

{
  const cases = [
    session(makeEvents()).events,
    [
      ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
      ev("turn/start", { turn: 1 }),
      ev("user/message", { id: "u1", content: [{ type: "text", text: "Hi" }] }),
      ev("turn/end", { turn: 1 })
    ],
    // 只有 turn/start、没有 turn/end：不应产生任何归属
    [
      ev("turn/start", { turn: 7 }),
      ev("user/message", { id: "u1", content: [{ type: "text", text: "Hi" }] })
    ],
    // 交错的 turn/end 顺序（真实日志里可能因 flush 顺序出现）
    [
      ev("turn/start", { turn: 1 }),
      ev("user/message", { id: "u1", content: [{ type: "text", text: "a" }] }),
      ev("turn/start", { turn: 2 }),
      ev("user/message", { id: "u2", content: [{ type: "text", text: "b" }] }),
      ev("turn/end", { turn: 2 }),
      ev("turn/end", { turn: 1 })
    ],
    // 稀疏数组：中间空 seq 不应影响映射
    Object.assign([], {
      0: ev("turn/start", { turn: 3 }),
      2: ev("user/message", { id: "u3", content: [{ type: "text", text: "c" }] }),
      4: ev("turn/end", { turn: 3 })
    })
  ];

  for (const events of cases) {
    const index = buildTurnIndex(events);
    const lookup = createTurnLookup(events);
    const seqMap = buildTurnSeqMap(index);
    eq("lookup.index 与 buildTurnIndex 一致", lookup.index, index);
    const last = events.length + 2;
    for (let seq = 0; seq <= last; seq += 1) {
      const legacy = turnOf(index, seq);
      const viaMap = seqMap.has(seq) ? seqMap.get(seq) : null;
      ok(`turnOfLookup 与旧实现一致 (seq=${seq})`, turnOfLookup(lookup, seq) === legacy);
      ok(`buildTurnSeqMap 与旧实现一致 (seq=${seq})`, viaMap === legacy);
    }
  }

  eq("turnOfLookup 空 lookup", turnOfLookup(null, 3), null);
  eq("turnOfLookup 仅 index 回退", turnOfLookup({ index: buildTurnIndex(makeEvents()) }, 2), 1);
}

// ---------------------------------------------------------------------------
// 33. 导航轮号：data-index 主路径 + aria-label 兜底（两条路径都覆盖）
// ---------------------------------------------------------------------------

{
  // 一致 → 采用 data-index
  eq("轮号：data-index 与 aria 一致", railTurnOfAttributes("3", "第 3 问，共 5 轮"), 3);
  eq("轮号：英文一致", railTurnOfAttributes("12", "Turn 12"), 12);
  // 不一致 → 完全回退旧实现（取 aria-label 最后一个整数）
  eq("轮号：data-index 不一致回退旧解析", railTurnOfAttributes("9", "第 3 问，共 5 轮"), 5);
  eq("轮号：data-index 为 0 回退 aria", railTurnOfAttributes("0", "第 3 问"), 3);
  // 无 aria-label → 只能信 data-index
  eq("轮号：仅 data-index", railTurnOfAttributes("4", null), 4);
  eq("轮号：data-index 非数字", railTurnOfAttributes("abc", "第 6 问"), 6);
  eq("轮号：数字类型 data-index", railTurnOfAttributes(8, "第 8 问"), 8);
  // 两条都无有效值
  eq("轮号：两路径皆空", railTurnOfAttributes(null, "no number"), null);
  eq("轮号：0 且无 aria", railTurnOfAttributes("0", null), null);
  // 旧行为必须原样保留：'第 10 问，共 5 轮' 仍取最后一个整数 5
  eq("轮号：旧 aria 行为不变", railTurnOf("第 10 问，共 5 轮"), 5);
  eq("轮号：无 data-index 时旧行为不变", railTurnOfAttributes(null, "第 10 问，共 5 轮"), 5);
}

// ---------------------------------------------------------------------------
// 34. 费用开关：默认值不变，且运行时读取最新配置
// ---------------------------------------------------------------------------

{
  eq("开关：空配置默认全开", costSwitches(undefined), { enabled: true, perTurn: true });
  eq("开关：空对象默认全开", costSwitches({}), { enabled: true, perTurn: true });
  eq("开关：显式 true", costSwitches({ usageStats: true, costPerTurn: true }), { enabled: true, perTurn: true });
  eq("开关：总开关关闭", costSwitches({ usageStats: false }), { enabled: false, perTurn: true });
  eq("开关：单次开关关闭", costSwitches({ costPerTurn: false }), { enabled: true, perTurn: false });
  eq("开关：两者关闭", costSwitches({ usageStats: false, costPerTurn: false }), { enabled: false, perTurn: false });

  // 运行时生效：同一个 config 对象被宿主改写后，下一次读取必须反映新值
  const cfg = { usageStats: true, costPerTurn: true };
  const before = costSwitches(cfg);
  cfg.usageStats = false;
  cfg.costPerTurn = false;
  const after = costSwitches(cfg);
  eq("开关：运行时关闭立即生效", after, { enabled: false, perTurn: false });
  eq("开关：默认值未被污染", before, { enabled: true, perTurn: true });
}

// ---------------------------------------------------------------------------
// 35. 调度器：卸载后必须取消待执行任务
// ---------------------------------------------------------------------------

{
  let pending = null;
  let cancelled = 0;
  let runs = 0;
  const scheduler = createScheduler(() => { runs += 1; }, {
    schedule(fn) { pending = fn; return 7; },
    cancel(handle) { ok("调度器取消句柄正确", handle === 7); cancelled += 1; }
  });

  ok("调度器首次 request", scheduler.request() === true);
  ok("调度器合并重复 request", scheduler.request() === false);
  pending();
  eq("调度器到点执行一次", runs, 1);
  ok("调度器未 dispose", scheduler.disposed === false);

  // 执行后内部句柄应已清空，因此可以再次排期
  ok("调度器执行后可再次 request", scheduler.request() === true);
  scheduler.dispose();
  eq("调度器 dispose 取消一次", cancelled, 1);
  pending();
  eq("调度器卸载后不再执行", runs, 1);
  ok("调度器 disposed 标记", scheduler.disposed === true);
  ok("调度器卸载后拒绝 request", scheduler.request() === false);

  // 默认实现（setTimeout）也应能正常请求与取消，不依赖 fake timer
  const real = createScheduler(() => { runs += 1; }, { delay: 0 });
  ok("调度器默认实现 request", real.request() === true);
  real.dispose();
}

// ---------------------------------------------------------------------------
// 36. 请求代际栅栏：后发先至的旧快照必须被丢弃
// ---------------------------------------------------------------------------

{
  const gate = createRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  ok("请求代际：第一条已过期", gate.isLatest(first) === false);
  ok("请求代际：最新一条有效", gate.isLatest(second) === true);
  const third = gate.begin();
  ok("请求代际：再次发起后第二条过期", gate.isLatest(second) === false);
  ok("请求代际：第三条有效", gate.isLatest(third) === true);
  ok("请求代际：未知 token 拒绝", gate.isLatest(999) === false);
}

// ---------------------------------------------------------------------------
// 37. HTTP：413 先排空请求体（content-length 与流式两条路径）
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    headersSent: false,
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = body;
    }
  };
}

{
  // 路径一：content-length 提前超限
  const reqA = {
    headers: { "content-length": String(s.MAX_BODY_BYTES + 100) },
    resumeCalled: false,
    resume() { this.resumeCalled = true; },
    on() {}
  };
  const resA = fakeRes();
  eq("413 超长 content-length 返回 null", await http.readJsonBody(reqA, resA), null);
  eq("413 状态码", resA.status, 413);
  ok("413 content-length 路径先排空", reqA.resumeCalled === true);
  eq("413 错误码", JSON.parse(resA.body).error.code, "PAYLOAD_TOO_LARGE");
  eq("413 安全头 no-store", resA.headers["cache-control"], "no-store");
  eq("413 content-type", resA.headers["content-type"], "application/json; charset=utf-8");

  // 路径二：流式读取累计超限
  const big = Buffer.alloc(s.MAX_BODY_BYTES + 1, 0x20);
  const reqB = {
    headers: {},
    resumeCalled: false,
    resume() { this.resumeCalled = true; },
    on() {},
    async *[Symbol.asyncIterator]() {
      yield big;
    }
  };
  const resB = fakeRes();
  eq("413 流式超限返回 null", await http.readJsonBody(reqB, resB), null);
  eq("413 流式状态码", resB.status, 413);
  ok("413 流式路径先排空", reqB.resumeCalled === true);

  // 合法请求不应产生任何提前响应
  const reqC = {
    headers: { "content-length": "7" },
    on() {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"a":1}');
    }
  };
  const resC = fakeRes();
  eq("合法 JSON 正常解析", await http.readJsonBody(reqC, resC), { a: 1 });
  eq("合法 JSON 不提前响应", resC.status, 0);
  ok("合法 JSON 不排空", resC.headersSent === false);

  // 非法 JSON → 400
  const reqD = {
    headers: {},
    on() {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("{");
    }
  };
  const resD = fakeRes();
  eq("非法 JSON 返回 null", await http.readJsonBody(reqD, resD), null);
  eq("非法 JSON 400", resD.status, 400);
  eq("非法 JSON 错误码", JSON.parse(resD.body).error.code, "INVALID_REQUEST");

  // 405 也走统一 JSON 与安全头
  const resE = fakeRes();
  http.sendMethodNotAllowed(resE, "POST");
  eq("405 状态码", resE.status, 405);
  eq("405 allow 头", resE.headers.allow, "POST");
  eq("405 错误码", JSON.parse(resE.body).error.code, "METHOD_NOT_ALLOWED");
  eq("405 安全头 nosniff", resE.headers["x-content-type-options"], "nosniff");
}

// ---------------------------------------------------------------------------
// 38. 本地化单一来源：zh / en 键一致，locale meta 与源码一致
// ---------------------------------------------------------------------------

{
  const zhKeys = Object.keys(i18n.zh).sort();
  const enKeys = Object.keys(i18n.en).sort();
  eq("i18n zh / en 键完全一致", zhKeys, enKeys);
  ok("i18n zh 非空", zhKeys.length > 50);
  ok("i18n en 非空", enKeys.length > 50);
  ok("i18n meta.zh.title", typeof i18n.meta.zh.title === "string" && i18n.meta.zh.title.length > 0);
  ok("i18n meta.en.title", typeof i18n.meta.en.title === "string" && i18n.meta.en.title.length > 0);

  const localeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "locale");
  for (const lang of ["zh", "en"]) {
    const file = path.join(localeDir, lang + ".json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    eq(`locale/${lang}.json meta 与 i18n.cjs 同步`, parsed.meta, i18n.meta[lang]);
  }
}

// ---------------------------------------------------------------------------
// 39. 导出文件名：会话 id 不得含路径分隔符
// ---------------------------------------------------------------------------

{
  const name = exportFilename("../../etc/passwd", new Date(2026, 10, 2, 12, 30));
  ok("导出文件名无路径分隔符", !name.includes("/") && !name.includes("\\"));
  ok("导出文件名以 dsh- 开头", name.startsWith("dsh-"));
  ok("导出文件名以 .md 结尾", name.endsWith(".md"));
  ok("导出文件名长度受限", name.length < 120);
  ok("空 sessionId 可生成", exportFilename(null, new Date(2026, 10, 2, 12, 30)).endsWith(".md"));
}

// ---------------------------------------------------------------------------
// 40. 计费样式默认值 / 选项顺序 / 旧配置映射 / 版本号注入
// ---------------------------------------------------------------------------

{
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const indexSource = fs.readFileSync(path.join(rootDir, "src", "index.mjs"), "utf8");

  // 默认值与顺序：内部存储值仍为 compact / default，只改可见顺序与默认。
  eq("计费样式默认值为单行", DEFAULT_COST_LAYOUT, "compact");
  eq("计费样式选项顺序为单行在前", COST_LAYOUTS, ["compact", "default"]);
  eq("Config 计费样式默认单行", /costLayout:\s*z\.string\(\)\.default\("compact"\)\.volatile\(\)/.test(indexSource), true);
  ok("总开关运行时由开启转关闭会丢弃余额基线", /if \(enabled !== lastEnabled\)/.test(indexSource));
  ok(
    "Config 中计费样式排在单次消耗之前",
    indexSource.indexOf("costLayout:") !== -1
      && indexSource.indexOf("costPerTurn:") !== -1
      && indexSource.indexOf("costLayout:") < indexSource.indexOf("costPerTurn:")
  );

  // 旧配置映射：已保存的 default 仍是多行，compact 仍是单行。
  eq("旧配置 default 映射多行样式", normalizeCostLayout("default"), "default");
  eq("旧配置 compact 映射单行样式", normalizeCostLayout("compact"), "compact");
  eq("未配置时回退单行样式", normalizeCostLayout(undefined), DEFAULT_COST_LAYOUT);
  eq("非法值回退单行样式", normalizeCostLayout("unknown"), DEFAULT_COST_LAYOUT);

  // 可见文案：标签、描述与选项名必须与内部枚举一一对应。
  eq("计费样式中文标签", i18n.zh["cost.settings.layout"], "计费样式");
  eq("计费样式英文标签", i18n.en["cost.settings.layout"], "Style");
  eq("单行样式中文文案", i18n.zh["cost.layout.compact"], "单行样式");
  eq("单行样式英文文案", i18n.en["cost.layout.compact"], "Single-line");
  eq("多行样式中文文案", i18n.zh["cost.layout.default"], "多行样式");
  eq("多行样式英文文案", i18n.en["cost.layout.default"], "Multi-line");

  // 版本号：源码保留占位符，构建产物必须换成 package.json 的 version。
  const srcClient = fs.readFileSync(path.join(rootDir, "src", "client.js"), "utf8");
  ok("客户端源码包含版本占位符", srcClient.includes("__DMA_VERSION__"));
  const libClient = fs.readFileSync(path.join(rootDir, "lib", "client.js"), "utf8");
  ok("构建产物注入 package.json 版本", libClient.includes(`const VERSION = "${pkg.version}";`));
  ok("构建产物无 __DMA_VERSION__ 占位符", !libClient.includes("__DMA_VERSION__"));
  ok("构建产物无 __DMA_BUILD_TIME__ 占位符", !libClient.includes("__DMA_BUILD_TIME__"));
  ok(
    "lib/index.js 与 src/index.mjs 一致",
    fs.readFileSync(path.join(rootDir, "lib", "index.js"), "utf8")
      === fs.readFileSync(path.join(rootDir, "src", "index.mjs"), "utf8")
  );
}

// ---------------------------------------------------------------------------
// 41. 删除 → 销毁会话控制器 → 重新拉 /messages：被删内容不得恢复
// ---------------------------------------------------------------------------
// 复现路径：删除工具行 → 切换对话（宿主卸载并重建 DOM / 丢弃控制器）→
// 用同一 sessionId 重新拉 /messages。最坏情况是宿主重建表面时忽略 surfaceOp，
// 原始节点仍在 nodes 里；/messages 必须按持久化墓碑的 removed 自行剔除。

{
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", { role: "user", id: "u1", content: [{ type: "text", text: "问题" }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "答" }] } }),
    ev("tool/call", { callId: "call_abc" }),
    ev("tool/result", {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: "工具结果" }], source: { callId: "call_abc" } }
    }),
    ev("turn/end", { turn: 1 })
  ];
  const { events: bag, nodes } = session(events);
  const plan = planAction(bag, nodes, { action: "delete", seq: 5 });
  eq("回归：工具行删除计划 ok", plan.ok, true);
  eq("回归：工具行删除区间", plan.removed, [3, 5]);

  // 与服务端 index.mjs 完全一致的墓碑字段（会随事件日志持久化）。
  const tombSeq = bag.length;
  bag.push({
    type: "user/message",
    seq: tombSeq,
    data: {
      role: "user",
      id: "dma-test",
      content: [{ type: "text", text: "[已删除]" }],
      source: {
        kind: "user",
        producer: PRODUCER,
        action: "delete",
        via: "tool",
        removed: plan.removed,
        kinds: plan.kinds,
        turn: plan.turn
      }
    },
    sourceEventSeqs: plan.removed,
    surfaceOp: { op: "replace", startSeq: plan.startSeq, endSeq: plan.endSeq }
  });

  // 模拟宿主重建表面时未重放 surfaceOp：原节点与墓碑同时出现在 nodes。
  const staleNodes = nodes.concat([tombSeq]);
  const refreshed = messagesSummaryOf(bag, staleNodes, undefined, { previewLimit: 200 });
  ok(
    "回归：切换回会话后摘要不再含被删工具行",
    !refreshed.rows.some((row) => row.callId === "call_abc")
  );
  eq("回归：goneTools 含被删工具 callId", refreshed.goneTools, ["call_abc"]);
  eq("liveNodesOf 剔除墓碑覆盖节点", liveNodesOf(bag, staleNodes).includes(5), false);
  eq("goneToolsOf 只回 callId", goneToolsOf(bag), ["call_abc"]);
  eq("tombstonedSeqsOf 覆盖区间", [...tombstonedSeqsOf(bag)].sort((a, b) => a - b), [3, 5]);

  // 再拉一次（模拟第二次切回）：结果必须稳定。
  const again = messagesSummaryOf(bag, staleNodes, undefined, { previewLimit: 200 });
  eq("回归：重复拉取结果稳定", again.rows.length, refreshed.rows.length);
  ok("回归：第二次拉取仍无被删工具行", !again.rows.some((row) => row.callId === "call_abc"));
}

{
  // 整轮删除同样不能被「切回后旧表面」复活。
  const { events: bag, nodes } = session(makeEvents());
  const plan = planAction(bag, nodes, { action: "delete", seq: 8 });
  eq("回归：整轮删除计划 ok", plan.ok, true);
  const tombSeq = bag.length;
  bag.push({
    type: "user/message",
    seq: tombSeq,
    data: {
      role: "user",
      id: "dma-test-turn",
      content: [{ type: "text", text: "[已删除]" }],
      source: {
        kind: "user",
        producer: PRODUCER,
        action: "delete",
        via: "user",
        removed: plan.removed,
        kinds: plan.kinds,
        turn: plan.turn
      }
    },
    sourceEventSeqs: plan.removed,
    surfaceOp: { op: "replace", startSeq: plan.startSeq, endSeq: plan.endSeq }
  });
  const staleNodes = nodes.concat([tombSeq]);
  const refreshed = messagesSummaryOf(bag, staleNodes, undefined, { previewLimit: 200 });
  ok("回归：整轮删除后摘要不含第二轮", !refreshed.rows.some((row) => row.turn === 2));
  eq("回归：整轮删除记入 goneTurns", refreshed.goneTurns, [2]);
  ok("回归：导出轮次也不含第二轮", !roundsOf(bag, staleNodes).some((round) => round.turn === 2));
}

// ---------------------------------------------------------------------------
// 42. 浮层键盘判定：Enter 主操作 / Esc 关闭 / 输入框与 busy 不触发
// ---------------------------------------------------------------------------

{
  const div = { tagName: "DIV" };
  const input = { tagName: "INPUT" };
  const area = { tagName: "TEXTAREA" };
  const editable = { tagName: "DIV", isContentEditable: true };
  const button = { tagName: "BUTTON" };
  const buttonChild = { tagName: "SPAN", closest: (sel) => (sel === "button" ? button : null) };
  const base = { overlayOpen: true, primaryEnabled: true, busy: false };
  eq("浮层内 Enter 触发主操作", resolveKeyAction({ ...base, key: "Enter", target: div }), "primary");
  eq("焦点在 input 时不触发", resolveKeyAction({ ...base, key: "Enter", target: input }), "none");
  eq("焦点在 textarea 时不触发", resolveKeyAction({ ...base, key: "Enter", target: area }), "none");
  eq("contenteditable 内不触发", resolveKeyAction({ ...base, key: "Enter", target: editable }), "none");
  eq("焦点在「取消」按钮上不触发主操作", resolveKeyAction({ ...base, key: "Enter", target: button }), "none");
  eq("焦点在按钮内的子元素上不触发主操作", resolveKeyAction({ ...base, key: "Enter", target: buttonChild }), "none");
  eq("busy 时不触发", resolveKeyAction({ ...base, busy: true, key: "Enter", target: div }), "none");
  eq("主操作 disabled 时不触发", resolveKeyAction({ ...base, primaryEnabled: false, key: "Enter", target: div }), "none");
  eq("Esc 关闭浮层", resolveKeyAction({ ...base, key: "Escape", target: div }), "dismiss");
  eq("浮层未打开时不触发 Enter", resolveKeyAction({ ...base, overlayOpen: false, key: "Enter", target: div }), "none");
  eq("浮层未打开时不处理 Esc", resolveKeyAction({ ...base, overlayOpen: false, key: "Escape", target: div }), "none");
  eq("其它按键不触发", resolveKeyAction({ ...base, key: "a", target: div }), "none");
}

// ---------------------------------------------------------------------------
// 43. 英文短文案长度上限（防止侧边栏 / 设置项再次溢出）
// ---------------------------------------------------------------------------

{
  // 上限来自实测布局：侧边栏卡片标签 6、设置项标签 18、按钮 12。
  const limits = [
    ["cost.balance", 6],
    ["cost.perTurn", 6],
    ["cost.hide", 12],
    ["btn.deleteTool", 12],
    ["settings.confirm", 18],
    ["cost.settings.layout", 8],
    ["cost.settings.perTurn", 12],
    ["cost.settings.autoClose", 12],
    ["cost.settings.peakValley", 15],
    ["cost.local", 20],
    ["cost.correction.title", 20],
    ["cost.correction.debit", 18],
    ["cost.correction.preview", 18],
    ["cost.correction.pending", 14],
    ["pick.share", 12]
  ];
  for (const [key, max] of limits) {
    const text = i18n.en[key];
    ok(`英文文案 ${key} 不超过 ${max} 字符（实际 ${text.length}）`, text.length <= max);
  }
  // 中文文案不得因英文缩写而改动。
  eq("中文余额标签未改", i18n.zh["cost.balance"], "余额");
  eq("中文计费样式标签未改", i18n.zh["cost.settings.layout"], "计费样式");
  eq("中文单次标签未改", i18n.zh["cost.perTurn"], "单次");
}

// ---------------------------------------------------------------------------
// 44. 跨边界：撤回 / 删除后「刷新 / 切换会话」与「继续对话」
// ---------------------------------------------------------------------------
// 模拟方式：写墓碑（与 index.mjs 字段一致）→ 假设宿主重建表面时忽略
// surfaceOp（staleNodes 同时含原节点与墓碑）→ 重新调用摘要 / 导出纯函数。
// 这等价于「销毁 SessionController → 用同一 sessionId 再拉一次 /messages」，
// 因为控制器只是快照的持有者，重建后的结果完全由这些纯函数决定。

{
  // —— 撤回整轮 → 刷新：内容不得恢复，原文仍可取回 ——
  const { events: bag, nodes } = session(makeEvents());
  const plan = planAction(bag, nodes, { action: "recall", seq: 2 });
  eq("跨边界：撤回计划 ok", plan.ok, true);
  eq("跨边界：撤回原文可取回", plan.refillText, "Hi");
  const tombSeq = bag.length;
  bag.push({
    type: "user/message",
    seq: tombSeq,
    data: {
      role: "user",
      id: "dma-recall",
      content: [{ type: "text", text: "[已撤回]" }],
      source: {
        kind: "user",
        producer: PRODUCER,
        action: "recall",
        via: plan.via,
        removed: plan.removed,
        kinds: plan.kinds,
        turn: plan.turn
      }
    },
    sourceEventSeqs: plan.removed,
    surfaceOp: { op: "replace", startSeq: plan.startSeq, endSeq: plan.endSeq }
  });
  const staleNodes = nodes.concat([tombSeq]);
  const refreshed = messagesSummaryOf(bag, staleNodes, undefined, { previewLimit: 200 });
  ok("跨边界：撤回后刷新不再有第一轮行", !refreshed.rows.some((row) => row.turn === 1));
  eq("跨边界：撤回后刷新 goneTurns", refreshed.goneTurns, [1]);
  eq("跨边界：撤回后导出轮次只剩第二轮", roundsOf(bag, staleNodes).map((r) => r.turn), [2]);
  ok("跨边界：撤回原文不出现在导出", !markdownOf(roundsOf(bag, staleNodes), {}).includes("Hello"));
  // 重复撤回：已墓碑节点从可见集合移除，必须拒绝而不是写第二块墓碑。
  eq(
    "跨边界：重复撤回被拒绝",
    planAction(bag, staleNodes, { action: "recall", seq: 2 }).code,
    "TARGET_NOT_FOUND"
  );
}

{
  // —— 删除工具行 → 继续对话（新轮次）→ 再删另一步 ——
  const { events: bag, nodes } = session(makeEvents());
  // 给工具结果补上宿主真实字段（message.source.callId），才能按 callId 重放隐藏。
  bag[4].data.message.source = { kind: "tool", callId: "call_abc" };
  const first = planAction(bag, nodes, { action: "delete", seq: 4 });
  eq("跨边界：工具行删除 ok", first.ok, true);
  const firstTomb = bag.length;
  bag.push({
    type: "user/message",
    seq: firstTomb,
    data: {
      role: "user",
      id: "dma-tool-1",
      content: [{ type: "text", text: "[已删除]" }],
      source: {
        kind: "user",
        producer: PRODUCER,
        action: "delete",
        via: "tool",
        removed: first.removed,
        kinds: first.kinds,
        turn: first.turn
      }
    },
    sourceEventSeqs: first.removed,
    surfaceOp: { op: "replace", startSeq: first.startSeq, endSeq: first.endSeq }
  });

  bag.push(ev("turn/start", { turn: 3 }));
  const q3 = bag.length;
  bag.push(ev("user/message", {
    role: "user",
    id: "u3",
    content: [{ type: "text", text: "第三问" }],
    source: { kind: "user" }
  }));
  const a3 = bag.length;
  bag.push(ev("assistant/message", {
    turn: 3,
    step: 1,
    message: { content: [{ type: "text", text: "第三答" }] }
  }));
  bag.push(ev("turn/end", { turn: 3 }));

  const nodes2 = nodes.concat([q3, a3]);
  const second = planAction(bag, nodes2, { action: "delete", seq: a3 });
  eq("跨边界：续聊后删除另一步 ok", second.ok, true);
  eq("跨边界：续聊后删除区间只含该答行", second.removed, [a3]);
  const secondTomb = bag.length;
  bag.push({
    type: "user/message",
    seq: secondTomb,
    data: {
      role: "user",
      id: "dma-tool-2",
      content: [{ type: "text", text: "[已删除]" }],
      source: {
        kind: "user",
        producer: PRODUCER,
        action: "delete",
        via: "assistant",
        removed: second.removed,
        kinds: second.kinds,
        turn: second.turn
      }
    },
    sourceEventSeqs: second.removed,
    surfaceOp: { op: "replace", startSeq: second.startSeq, endSeq: second.endSeq }
  });

  const stale2 = nodes2.concat([firstTomb, secondTomb]);
  const summary = messagesSummaryOf(bag, stale2, undefined, { previewLimit: 200 });
  ok("跨边界：两次删除后刷新仍无被删工具行", !summary.rows.some((row) => row.callId === "call_abc"));
  eq("跨边界：多次删除后 goneTools 仍只含一遍", summary.goneTools, ["call_abc"]);
  ok("跨边界：续聊新提问保留", summary.rows.some((row) => row.seq === q3));
  ok("跨边界：第二次删除的答行已消失", !summary.rows.some((row) => row.seq === a3));
  eq("跨边界：轮次仍活着时 goneTurns 为空", summary.goneTurns, []);
  const rounds = roundsOf(bag, stale2);
  eq("跨边界：第一轮仍保留最后一条回答", rounds[0].answer, "Done");
  eq("跨边界：第三轮提问保留", rounds[2].question, "第三问");
  eq("跨边界：第三轮回答已删空", rounds[2].answer, "");
  ok("跨边界：导出不含第二次删除的正文", !markdownOf(rounds, {}).includes("第三答"));
}

{
  // —— DOM 重建后的工具行重放：按 callId 选中新节点的 nodeKey ——
  const keys = [
    TOOL_NODE_KEY_PREFIX + "call_abc",
    TOOL_NODE_KEY_PREFIX + "call_live",
    "9:assistant-messagex"
  ];
  eq("跨边界：重建后只隐藏被删工具行", toolNodeKeysToHide(keys, ["call_abc"]), [keys[0]]);
  eq("跨边界：无墓碑时不隐藏任何行", toolNodeKeysToHide(keys, []), []);
  eq("跨边界：隐藏其它已删工具行", toolNodeKeysToHide(keys, ["call_live"]), [keys[1]]);
  eq("跨边界：空节点列表返回空", toolNodeKeysToHide([], ["call_abc"]), []);
}

{
  // —— 空会话 / 超长文本预览截断 ——
  const empty = messagesSummaryOf([], []);
  eq("跨边界：空会话 version", empty.version, 0);
  eq("跨边界：空会话 nodeCount", empty.nodeCount, 0);
  eq("跨边界：空会话 rows", empty.rows, []);
  eq("跨边界：空会话 rounds", empty.rounds, []);
  eq("跨边界：空会话 goneTurns", empty.goneTurns, []);
  eq("跨边界：空会话 goneTools", empty.goneTools, []);

  const longQ = "问".repeat(500);
  const longA = "答".repeat(600);
  const longEvents = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", { role: "user", id: "uq", content: [{ type: "text", text: longQ }], source: { kind: "user" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: longA }] } }),
    ev("turn/end", { turn: 1 })
  ];
  const { events: bag, nodes } = session(longEvents);
  const summary = messagesSummaryOf(bag, nodes, undefined, { previewLimit: 200 });
  const qRow = summary.rows.find((row) => row.type === "user/message");
  const aRow = summary.rows.find((row) => row.type === "assistant/message");
  ok("跨边界：超长提问预览被截断", qRow.preview.length <= 201 && qRow.preview.endsWith("…"));
  ok("跨边界：超长回答预览被截断", aRow.preview.length <= 201 && aRow.preview.endsWith("…"));
  eq("跨边界：摘要仍回传完整字数", [qRow.words, aRow.words], [500, 600]);
  const rounds = roundsOf(bag, nodes);
  eq("跨边界：分享/导出拿到全文", [rounds[0].question.length, rounds[0].answer.length], [500, 600]);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nFAILED");
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");