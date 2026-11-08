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
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const s = require("../src/shared.cjs");
const store = require("../src/store.cjs");
const http = require("../src/http.cjs");
const i18n = require("../src/i18n.cjs");
const sessionsPure = require("../src/sessions.cjs");

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
  mergeMessageSummary,
  isBusyError,
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
  eq("上升只更新基准", r.state.lastBalanceCents, 2000);
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
// 28. 费用统计：金额解析（官方充值余额截断至分）
// ---------------------------------------------------------------------------

{
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
  // 官方「账号与余额」对正金额截断至分；默认四舍五入保留给普通金额解析。
  eq("截断模式：5.999 → 599", s.yuanToCents("5.999", "truncate"), 599);
  eq("截断模式：5.99 → 599", s.yuanToCents("5.99", "truncate"), 599);
  eq("截断模式：5.994 → 599", s.yuanToCents("5.994", "truncate"), 599);
  eq("截断模式：6 → 600", s.yuanToCents("6", "truncate"), 600);
  eq("默认模式仍四舍五入：5.999 → 600", s.yuanToCents("5.999"), 600);
  eq("截断模式：负数仍四舍五入", s.yuanToCents("-5.999", "truncate"), -600);
  eq("截断模式：数字 5.999 → 599", s.yuanToCents(5.999, "truncate"), 599);
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
      dailySpendCents: { "2026-11-02": 84 }
    });
    store.saveCostState(file, saved);
    const loaded = store.loadCostState(file);
    eq("原子写后读取一致", loaded.state.observedSpendTotalCents, 84);
    eq("旧校正字段不落盘", "correctionCreditCents" in loaded.state, false);
    eq("读取非损坏", loaded.recovered, false);
    eq("状态版本", loaded.state.version, 2);
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

    const high = store.normalizeCostState({ version: 3, baselineBalanceCents: 100 });
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
  eq("本地模型不是余额账户", s.routingOfProvider("ninfer-27b"), "other");
  eq("第三方网关不是余额账户", s.routingOfProvider("openai-compatible"), "other");
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
  eq("i18n meta.zh.title 为显示名", i18n.meta.zh.title, "消息管家");
  eq("i18n meta.en.title 为显示名", i18n.meta.en.title, "Message Butler");
  eq("i18n meta.zh.description 按定稿原文", i18n.meta.zh.description, "功能：撤回、删除、删至末尾、多选分享与导出，会话管理与回收站，每条回答的用量计费、余额费用展示、对话完成声音提示等。");
  eq("i18n meta.en.description 与中文同义", i18n.meta.en.description, "Features: recall, delete, delete-to-end, multi-select share and export; session management with a trash bin; per-reply usage billing, balance and cost display, and a completion sound.");
  const iconSrc = fs.readFileSync(fileURLToPath(new URL("../icon.svg", import.meta.url)), "utf8");
  ok("插件图标：蓝底对话气泡内嵌三档滑块", /viewBox="0 0 64 64"/.test(iconSrc) &&
    iconSrc.includes('fill="#2563eb"') && iconSrc.includes("M23 23h18M23 30h18M23 37h18") &&
    [/cx="34" cy="23"/, /cx="27.5" cy="30"/, /cx="38" cy="37"/].every((re) => re.test(iconSrc)) &&
    !iconSrc.includes("M26 23l6 7 6-7"));

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

  // 产物必须能被真实 JS 引擎解析：0.2.2 曾因括号不平衡导致 web boot import failed。
  const syntax = spawnSync(process.execPath, ["--check", path.join(rootDir, "lib", "client.js")], { encoding: "utf8" });
  eq("构建产物的客户端脚本可解析", syntax.status, 0);

  // 客户端解构的 shared 名称必须都真实导出，防止重命名后产物引用不存在的符号。
  const destructure = /const \{([\s\S]*?)\} = shared;/.exec(srcClient);
  const sharedNames = (destructure ? destructure[1] : "")
    .split(",")
    .map((part) => part.replace(/\/\/.*$/gm, "").trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const missingExports = sharedNames.filter((name) => !(name in s));
  eq("客户端解构的 shared 符号全部存在", missingExports.join(","), "");

  // 客户端字面量文案键必须同时存在于 zh / en，防止新增键漏配一侧。
  const keyMatches = [...srcClient.matchAll(/\bt+\("([^"]+)"\)/g)].map((m) => m[1]);
  const usedKeys = [...new Set(keyMatches)];
  const missingKeys = usedKeys.filter((key) => i18n.zh[key] == null || i18n.en[key] == null);
  eq("客户端引用的 i18n 键在 zh/en 均存在", missingKeys.join(","), "");
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
  eq("预算保存按钮文案收紧", i18n.zh["stats.budgetSave"], "保存");
  eq("预算保存按钮文案（英）", i18n.en["stats.budgetSave"], "Save");
  // 余额校正整块移除后，中英文都不再保留相关键；账号口径说明必须存在。
  for (const key of ["cost.pending", "cost.pendingTitle", "cost.correction.title", "cost.correction.save", "cost.note"]) {
    ok(`已移除文案 ${key}`, i18n.zh[key] === undefined && i18n.en[key] === undefined);
  }
  ok("账号口径说明（中文）", typeof i18n.zh["cost.balanceNote"] === "string" && i18n.zh["cost.balanceNote"].length > 20);
  ok("账号口径说明（英文）", typeof i18n.en["cost.balanceNote"] === "string" && i18n.en["cost.balanceNote"].length > 20);
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
// 45. `/messages` 增量拉取：since 游标 + 客户端合并
// ---------------------------------------------------------------------------
// 方案选择：游标（since=<上次 version>），不是已持有 seq 的列表——
// 现有 seqs 参数是「包含列表」，且长会话里已持有的 seq 会无限增长。

/** 按 index.mjs 的字段写一块墓碑（与本文件其它跨边界用例一致）。 */
function pushTombstone(bag, plan, id, action) {
  const seq = bag.length;
  bag.push({
    type: "user/message",
    seq,
    data: {
      role: "user",
      id,
      content: [{ type: "text", text: "[已删除]" }],
      source: {
        kind: "user",
        producer: PRODUCER,
        action: action || "delete",
        via: plan.via,
        removed: plan.removed,
        kinds: plan.kinds,
        turn: plan.turn
      }
    },
    sourceEventSeqs: plan.removed,
    surfaceOp: { op: "replace", startSeq: plan.startSeq, endSeq: plan.endSeq }
  });
  return seq;
}

{
  const { events: bag, nodes } = session(makeEvents());
  const full = messagesSummaryOf(bag, nodes, undefined, { previewLimit: 200 });
  eq("增量：不带 since 仍是全量（向后兼容）", full.rows.length, 7);
  eq("增量：全量响应 removedSeqs 为空", full.removedSeqs, []);

  const atEnd = messagesSummaryOf(bag, nodes, undefined, { previewLimit: 200, since: full.version });
  eq("增量：游标在末尾时无新行", atEnd.rows, []);
  eq("增量：游标在末尾时无轮次", atEnd.rounds, []);
  eq("增量：游标在末尾时 version 不变", atEnd.version, full.version);
  eq("增量：goneTurns 始终全量", atEnd.goneTurns, full.goneTurns);
  eq("增量：goneTools 始终全量", atEnd.goneTools, full.goneTools);

  const part = messagesSummaryOf(bag, nodes, undefined, { previewLimit: 200, since: 5 });
  ok("增量：rows 只含 seq > since", part.rows.every((row) => row.seq > 5));
  eq("增量：rows 只含第二轮两行", part.rows.map((row) => row.seq), [8, 9]);
  eq("增量：rounds 只含变化的轮次", part.rounds.map((round) => round.turn), [2]);
  eq("增量：变化轮次的预览仍完整", part.rounds[0].questionPreview, "Next?");
  eq("增量：变化轮次的回答预览仍完整", part.rounds[0].answerPreview, "Sure");

  const combined = messagesSummaryOf(bag, nodes, undefined, {
    previewLimit: 200,
    since: 5,
    filter: new Set([8])
  });
  eq("增量：可与 seqs 包含列表叠加", combined.rows.map((row) => row.seq), [8]);
}

{
  // 整轮删除：增量必须带 removedSeqs，合并结果与全量快照逐字段一致。
  const { events: bag, nodes } = session(makeEvents());
  const before = messagesSummaryOf(bag, nodes, undefined, { previewLimit: 200 });
  const plan = planAction(bag, nodes, { action: "delete", seq: 8 });
  eq("增量删除：计划 ok", plan.ok, true);
  const tombSeq = pushTombstone(bag, plan, "dma-inc-turn");
  const staleNodes = nodes.concat([tombSeq]);
  const inc = messagesSummaryOf(bag, staleNodes, undefined, { previewLimit: 200, since: before.version });
  eq("增量删除：removedSeqs 含被删行", inc.removedSeqs, plan.removed);
  eq("增量删除：无新增可见行", inc.rows, []);
  eq("增量删除：goneTurns 反映整轮消失", inc.goneTurns, [2]);
  const merged = mergeMessageSummary(before, inc);
  const fresh = messagesSummaryOf(bag, staleNodes, undefined, { previewLimit: 200 });
  eq("增量删除：合并后 rows 等于全量", merged.rows, fresh.rows);
  eq("增量删除：合并后 rounds 等于全量", merged.rounds, fresh.rounds);
  eq("增量删除：合并后 goneTurns 等于全量", merged.goneTurns, fresh.goneTurns);
  eq("增量删除：合并后 goneTools 等于全量", merged.goneTools, fresh.goneTools);
  eq("增量删除：合并后 version 前进", merged.version, fresh.version);
}

{
  // 工具行删除：removedSeqs 剔除该行，轮次仍保留（不能误删整轮）。
  const { events: bag, nodes } = session(makeEvents());
  bag[4].data.message.source = { kind: "tool", callId: "call_abc" };
  const before = messagesSummaryOf(bag, nodes, undefined, { previewLimit: 200 });
  const plan = planAction(bag, nodes, { action: "delete", seq: 4 });
  eq("增量工具删除：计划 ok", plan.ok, true);
  const tombSeq = pushTombstone(bag, plan, "dma-inc-tool", "delete");
  const staleNodes = nodes.concat([tombSeq]);
  const inc = messagesSummaryOf(bag, staleNodes, undefined, { previewLimit: 200, since: before.version });
  eq("增量工具删除：removedSeqs 含工具行及其前序答案", inc.removedSeqs, plan.removed);
  eq("增量工具删除：goneTools 含 callId", inc.goneTools, ["call_abc"]);
  eq("增量工具删除：轮次未消失", inc.goneTurns, []);
  const merged = mergeMessageSummary(before, inc);
  const fresh = messagesSummaryOf(bag, staleNodes, undefined, { previewLimit: 200 });
  eq("增量工具删除：合并后 rows 等于全量", merged.rows, fresh.rows);
  eq("增量工具删除：合并后 rounds 等于全量", merged.rounds, fresh.rounds);
  eq("增量工具删除：被删工具行已剔除", merged.rows.some((row) => row.seq === 4), false);
  eq("增量工具删除：工具行隐藏信号保留", merged.goneTools, ["call_abc"]);
}

// ---------------------------------------------------------------------------
// 46. 写盘失败不再返回成功（持久化结果 + 重启语义）
// ---------------------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dma-persist-"));
  const file = path.join(dir, "cost-state.json");
  const state = store.defaultState();
  state.observedSpendTotalCents = 3000;
  state.budgetCents = 900;

  eq("持久化：正常写入返回成功", store.persistCostState(file, state, false), { ok: true });
  const loaded = store.loadCostState(file, null);
  eq("持久化：重启后消费观测不丢失", loaded.state.observedSpendTotalCents, 3000);
  eq("持久化：重启后预算不丢失", loaded.state.budgetCents, 900);

  eq(
    "持久化：只读模式返回 READ_ONLY",
    store.persistCostState(file, state, true),
    { ok: false, error: "READ_ONLY" }
  );
  eq("持久化：只读模式不改动磁盘", store.loadCostState(file, null).state.observedSpendTotalCents, 3000);

  // 父路径是普通文件 → mkdir/rename 必然失败，用于模拟写盘异常。
  fs.writeFileSync(path.join(dir, "blocker"), "x");
  eq(
    "持久化：写盘失败返回 WRITE_FAILED",
    store.persistCostState(path.join(dir, "blocker", "cost-state.json"), state, false),
    { ok: false, error: "WRITE_FAILED" }
  );
  eq("持久化：失败时磁盘仍保留旧值", store.loadCostState(file, null).state.observedSpendTotalCents, 3000);

  eq("错误码文案：只读（中）", s.ERROR_LABELS.zh.READ_ONLY.length > 0, true);
  eq("错误码文案：写盘失败（英）", s.ERROR_LABELS.en.WRITE_FAILED.length > 0, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 47. AGENT_BUSY 判定：结构化字段优先，文案兜底
// ---------------------------------------------------------------------------

{
  eq(
    "busy：结构化 code=AGENT_BUSY",
    isBusyError(Object.assign(new Error("closure failed"), { code: "AGENT_BUSY" })),
    true
  );
  eq("busy：结构化 code=EBUSY", isBusyError({ code: "EBUSY" }), true);
  eq("busy：结构化 code 大小写不敏感", isBusyError({ code: "agent_busy" }), true);
  eq("busy：结构化 status=423", isBusyError({ status: 423, message: "other text" }), true);
  eq("busy：结构化 statusCode=423", isBusyError({ statusCode: 423 }), true);
  eq("busy：只有文案（宿主现状）", isBusyError(new Error('agent "x" already has active work')), true);
  eq(
    "busy：有 code 时以 code 为准（文案不生效）",
    isBusyError(Object.assign(new Error("already has active work"), { code: "EIO" })),
    false
  );
  eq("busy：普通错误不误判", isBusyError(new Error("something else")), false);
  eq("busy：非对象不误判", isBusyError(null), false);
  eq("busy：字符串不误判", isBusyError("already has active work"), false);
}

// ---------------------------------------------------------------------------
// 48. 影响面断言：路由 / 客户端用上了上述语义
// ---------------------------------------------------------------------------

{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const indexSrc = fs.readFileSync(path.join(root, "src", "index.mjs"), "utf8");
  const clientSrc = fs.readFileSync(path.join(root, "src", "client.js"), "utf8");

  ok("路由：busy 判定使用 isBusyError", /if \(isBusyError\(err\)\)/.test(indexSrc));
  ok("路由：/messages 解析 since 游标", /searchParams\.get\("since"\)/.test(indexSrc));
  ok(
    "路由：预算保存失败返回 500",
    /if \(!saved\.ok\) \{[\s\S]{0,160}sendError\(res, 500, saved\.error\)/.test(indexSrc)
  );
  ok(
    "余额校正路由已移除",
    !indexSrc.includes("/dsh-message-actions/cost/correction") &&
    !indexSrc.includes("makeCostCorrectionHandler") &&
    !indexSrc.includes("applyCorrection")
  );
  ok(
    "余额校正字段已移除",
    !indexSrc.includes("pendingAdjustmentCents") &&
    !indexSrc.includes("correctedBalanceCents") &&
    !clientSrc.includes("CorrectionForm") &&
    !clientSrc.includes("pendingAdjustmentCents")
  );
  ok(
    "钱包按官方截断至分",
    /yuanToCents\(wallet\.balance, "truncate"\)/.test(indexSrc)
  );
  ok(
    "客户端展示账号口径说明",
    /tt\("cost\.balanceNote"\)/.test(clientSrc)
  );
  ok("store：persist 返回结构化结果", /return persistCostState\(statePath, state, readOnly, ctx\.logger\)/.test(indexSrc));

  ok("浮层：分享/导出不再无条件关闭", !/runShare: async[\s\S]{0,200}controller\.dismiss\(\)/.test(clientSrc));
  ok("浮层：成功才关闭", /\.then\(\(done\) => \{[\s\S]{0,80}onDismiss\(\);/.test(clientSrc));
  ok("浮层：失败复位 busy", /\.catch\(\(\) => \{[\s\S]{0,80}setBusy\(false\);/.test(clientSrc));
  ok(
    "分享图：成功路径返回 Promise<boolean>",
    /return new Promise\(\(resolve\) => \{/.test(clientSrc) && /resolve\(true\)/.test(clientSrc)
  );
  ok("分享图：失败路径 resolve(false)", /img\.onerror = \(\) => \{[\s\S]{0,60}resolve\(false\);/.test(clientSrc));
  ok("增量：普通刷新带 since", /"&since=" \+ cursor/.test(clientSrc));
  ok("增量：版本回退时全量重取", /cursor = null;[\s\S]{0,160}messagesUrl\(cursor\)/.test(clientSrc));
  ok("增量：客户端合并使用共享纯函数", /mergeMessageSummary\(base, data\.value\)/.test(clientSrc));

  // 49) 完成提示音：开关默认值、去重、busy/结算失败门控
  ok("提示音：默认开启", s.completionSoundEnabled({}) === true);
  ok("提示音：显式 false 关闭", s.completionSoundEnabled({ sound: false }) === false);
  ok("提示音：显式 true 开启", s.completionSoundEnabled({ sound: true }) === true);
  const soundBase = { enabled: true, settled: true, previousAt: 100, at: 200, lastPlayedAt: null, busy: false };
  ok("提示音：新一轮应播放", s.shouldPlayCompletionSound(soundBase) === true);
  ok("提示音：同一轮不重复", s.shouldPlayCompletionSound({ ...soundBase, previousAt: 200 }) === false);
  ok("提示音：已响过不补响", s.shouldPlayCompletionSound({ ...soundBase, lastPlayedAt: 200 }) === false);
  ok("提示音：开关关闭不响", s.shouldPlayCompletionSound({ ...soundBase, enabled: false }) === false);
  ok("提示音：宿主 busy 不响", s.shouldPlayCompletionSound({ ...soundBase, busy: true }) === false);
  ok("提示音：结算失败不响", s.shouldPlayCompletionSound({ ...soundBase, settled: false }) === false);
  ok("提示音：无结算时间不响", s.shouldPlayCompletionSound({ ...soundBase, at: null }) === false);
  ok("提示音：非法时间不响", s.shouldPlayCompletionSound({ ...soundBase, at: NaN }) === false);
  ok("提示音：Web Audio 现场合成", /createOscillator\(\)/.test(clientSrc) && !/new Audio\(/.test(clientSrc));
  ok("提示音：AudioContext 挂起静默跳过", /state !== "running"[\s\S]{0,400}return false;/.test(clientSrc));
  ok("提示音：过滤首次快照基线", /if \(previousAt === null\) return;/.test(clientSrc));
  ok("结算推送：客户端 wait 长轮询", /"wait=" \+ wait/.test(clientSrc));
  ok("结算推送：宿主 wait 挂起接口", /waitTurnSettled\(COST_SETTLE_WAIT_MS\)/.test(indexSrc) && /notifyTurnSettled\(\)/.test(indexSrc));
  ok("设置：提示音默认开启分支", /defaultOn \? value\[key\] !== false/.test(clientSrc));
}

// ---------------------------------------------------------------------------
// 50. 会话统计：日志折叠、时间线分桶、会话表聚合、预算与入口判定
// ---------------------------------------------------------------------------

{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const indexSrc = fs.readFileSync(path.join(root, "src", "index.mjs"), "utf8");
  const clientSrc = fs.readFileSync(path.join(root, "src", "client.js"), "utf8");

  // 四类 token 归一化：只认非负安全整数，缺 input/output 视为无效。
  ok("统计：usage 归一化四类桶", s.statsUsageBuckets({
    inputTokens: 120,
    cacheReadTokens: 80,
    cacheWriteTokens: 30,
    outputTokens: 40
  }).input === 120);
  ok("统计：usage 保留 cacheWrite", s.statsUsageBuckets({
    inputTokens: 1,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    outputTokens: 4
  }).cacheWrite === 3);
  ok("统计：usage 缺字段返回 null", s.statsUsageBuckets({ inputTokens: 1 }) === null);
  ok("统计：usage 非对象返回 null", s.statsUsageBuckets(null) === null);
  ok("统计：token 合计", s.statsTokenTotal({ input: 10, cacheRead: 20, cacheWrite: 30, output: 40 }) === 100);

  // 折叠会话日志：标题、模型、四类 token、时间点、轮次与消息数。
  const baseAt = new Date(2026, 10, 4, 15, 30, 0, 0).getTime();
  const events = [
    { type: "session/title", time: baseAt - 90 * 60 * 1000, data: { title: "  Alpha  " } },
    { type: "user/message", time: baseAt - 80 * 60 * 1000, data: { message: { role: "user", content: [{ type: "text", text: "hello world" }] } } },
    {
      type: "request/header",
      time: baseAt - 70 * 60 * 1000,
      data: { header: { config: { model: "deepseek-chat", provider: "deepseek" } } }
    },
    {
      type: "assistant/message",
      time: baseAt - 60 * 60 * 1000,
      data: {
        turn: 1,
        usage: { inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 30, outputTokens: 40 }
      }
    },
    { type: "step/end", time: baseAt - 50 * 60 * 1000, data: {} },
    {
      type: "assistant/message",
      time: baseAt - 40 * 60 * 1000,
      data: { turn: 2, usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 } }
    }
  ];
  const fold = s.foldSessionStats(events);
  eq("折叠：标题去空白", fold.title, "Alpha");
  eq("折叠：首个问题", fold.firstPrompt, "hello world");
  eq("折叠：模型", fold.model, "deepseek-chat");
  eq("折叠：provider", fold.provider, "deepseek");
  eq("折叠：input 合计", fold.tokens.input, 110);
  eq("折叠：cacheRead 合计", fold.tokens.cacheRead, 200);
  eq("折叠：cacheWrite 合计", fold.tokens.cacheWrite, 30);
  eq("折叠：output 合计", fold.tokens.output, 45);
  eq("折叠：时间点数量", fold.points.length, 2);
  eq("折叠：时间点继承模型", fold.points[0].model, "deepseek-chat");
  eq("折叠：轮次取最大 turn", fold.turns, 2);
  eq("折叠：step 计数", fold.steps, 1);
  eq("折叠：消息计数", fold.messages, 2);
  eq("折叠：最后活跃时间", fold.lastActiveAt, baseAt - 40 * 60 * 1000);
  eq("折叠：空日志不崩", s.foldSessionStats(null).points.length, 0);

  // 计费口径：默认计费，只有确认为本地 / 内网才不计费。
  const localEndpoints = { "ninfer-27b": "http://192.168.31.10:51200/v1" };
  eq("计费：DeepSeek 账户路由计费", s.isBillableRoute("deepseek-account", "deepseek-flash"), true);
  eq("计费：DeepSeek 官方路由计费", s.isBillableRoute("deepseek-official", "deepseek-v4-pro"), true);
  eq("计费：局域网路由不计费", s.isBillableRoute("ninfer-27b", "ninfer-27b", { endpoints: localEndpoints }), false);
  eq("计费：无 provider 但模型为 DeepSeek 时兜底计费", s.isBillableRoute("", "deepseek-flash"), true);
  eq("计费：无 provider 且未知模型默认计费", s.isBillableRoute("", "llama3"), true);
  eq("计费：provider 与模型都缺失时默认计费", s.isBillableRoute(undefined, undefined), true);
  ok("计费：provider 不是本地时 model 不改变计费", s.isBillableRoute("openrouter", "deepseek-flash") === true);
  eq("计费：覆盖清单 always 覆盖本地", s.classifyRoute({ provider: "ninfer-27b", model: "ninfer-27b" },
    { endpoints: localEndpoints, overrides: { "ninfer-27b": "always" } }).billable, true);
  eq("计费：覆盖清单 local 覆盖第三方", s.classifyRoute({ provider: "openrouter", model: "gpt-4o" },
    { endpoints: { openrouter: "https://openrouter.ai/api/v1" }, overrides: { openrouter: "local" } }).billable, false);
  eq("计费：未知来源默认计费且标记未确认", s.classifyRoute({ provider: "mystery", model: "mystery" }).confirmed, false);
  eq("计费：官方域名视为官方", s.classifyRoute({ provider: "proxy", model: "x" },
    { endpoints: { proxy: "https://api.deepseek.com/v1" } }).official, true);

  const localEvents = [
    { type: "request/header", time: baseAt - 30 * 60 * 1000, data: { header: { config: { provider: "ninfer-27b", model: "ninfer-27b" } } } },
    {
      type: "assistant/message",
      time: baseAt - 20 * 60 * 1000,
      data: { turn: 1, usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 } }
    }
  ];
  const localFold = s.foldSessionStats(localEvents, { endpoints: localEndpoints });
  eq("计费：本地时间点标记不计费", localFold.points[0].billable, false);
  eq("计费：本地时间点成本为 0", s.statsPointCostMicros(localFold.points[0]), 0);
  eq("计费：本地 token 仍统计", localFold.tokens.input + localFold.tokens.output, 1500);
  const localRow = s.statsSessionRow({ id: "local-1" }, localFold, {});
  eq("计费：本地会话成本为 0", localRow.costMicros, 0);
  eq("计费：本地会话可识别（无计费用量）", localRow.billable, false);
  eq("计费：本地会话 token 照常统计", localRow.tokens.total, 1500);
  eq("计费：本地 token 计入 localTokens", localRow.localTokens, 1500);
  eq("计费：本地 token 不计入 billableTokens", localRow.billableTokens, 0);
  const localSummary = s.statsSummary([localRow]);
  eq("计费：合计成本排除本地", localSummary.costMicros, 0);
  eq("计费：合计 token 仍含本地", localSummary.tokens.total, 1500);
  eq("计费：合计 localTokens", localSummary.localTokens, 1500);
  eq("计费：合计 billableTokens 为 0", localSummary.billableTokens, 0);
  const localBuckets = s.statsAggregate(localFold.points, s.statsBucketStarts(baseAt, 2, "hour"), "hour");
  eq("计费：时间线本地桶 localTokens", localBuckets[1].localTokens, 1500);
  eq("计费：时间线本地桶 billableTokens", localBuckets[1].billableTokens, 0);
  eq("计费：时间线本地桶成本为 0", localBuckets[1].costMicros, 0);

  // 第三方未配置价格：token 照常统计，金额为 0，并标记 unpriced / unconfirmed。
  const thirdFold = s.foldSessionStats([
    { type: "request/header", time: baseAt - 30 * 60 * 1000, data: { header: { config: { provider: "openrouter", model: "gpt-4o" } } } },
    {
      type: "assistant/message",
      time: baseAt - 20 * 60 * 1000,
      data: { turn: 1, usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 } }
    }
  ], { endpoints: { openrouter: "https://openrouter.ai/api/v1" } });
  eq("计费：第三方未配置价格标记 priced=false", thirdFold.points[0].priced, false);
  eq("计费：第三方未配置价格来源", thirdFold.points[0].priceSource, "unconfigured");
  eq("计费：第三方未配置价格成本为 0", s.statsPointCostMicros(thirdFold.points[0]), 0);
  const thirdRow = s.statsSessionRow({ id: "third-1" }, thirdFold, {});
  eq("计费：第三方未配置计入 unpricedTokens", thirdRow.unpricedTokens, 1500);
  eq("计费：第三方未配置 billableTokens 为 0", thirdRow.billableTokens, 0);
  eq("计费：第三方未配置标记 hasUnpriced", thirdRow.hasUnpriced, true);
  eq("计费：第三方未配置成本仍为 0", thirdRow.costMicros, 0);

  // 第三方已配置价格：按配置价计价，且不适用 DeepSeek 峰谷折扣。
  const thirdPriced = s.foldSessionStats([
    { type: "request/header", time: baseAt - 30 * 60 * 1000, data: { header: { config: { provider: "openrouter", model: "gpt-4o" } } } },
    {
      type: "assistant/message",
      time: baseAt - 20 * 60 * 1000,
      data: { turn: 1, usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500 } }
    }
  ], {
    endpoints: { openrouter: "https://openrouter.ai/api/v1" },
    prices: { models: { "gpt-4o": { cacheHit: 1, cacheMiss: 10, output: 20 } } }
  });
  eq("计费：第三方自定义价来源", thirdPriced.points[0].priceSource, "custom");
  eq("计费：第三方自定义价金额", s.statsPointCostMicros(thirdPriced.points[0]), 20000);
  ok("计费：第三方价格按 model 精确匹配", s.priceEntryFor({ provider: "openrouter", model: "gpt-4o" },
    { endpoints: { openrouter: "https://openrouter.ai/api/v1" }, prices: { models: { "gpt-4o": { cacheHit: 1, cacheMiss: 10, output: 20 } } } }).source === "custom");
  eq("计费：第三方价格前缀匹配", s.priceEntryFor({ provider: "x", model: "gpt-4o-mini" },
    { endpoints: { x: "https://api.example.com" }, prices: { prefixes: { "gpt-": { cacheHit: 1, cacheMiss: 1, output: 1 } } } }).matched, "prefix:gpt-");
  eq("计费：第三方价格 provider 匹配", s.priceEntryFor({ provider: "openai", model: "o3" },
    { endpoints: { openai: "https://api.openai.com" }, prices: { providers: { openai: { cacheHit: 1, cacheMiss: 2, output: 3 } } } }).matched, "provider");
  eq("计费：第三方价格全局兜底来源", s.priceEntryFor({ provider: "openai", model: "o3" },
    { endpoints: { openai: "https://api.openai.com" }, prices: { fallback: { cacheHit: 1, cacheMiss: 2, output: 3 } } }).source, "estimated");

  const mixedEvents = [
    { type: "request/header", time: baseAt - 40 * 1000, data: { header: { config: { provider: "deepseek-account", model: "deepseek-flash" } } } },
    {
      type: "assistant/message",
      time: baseAt - 30 * 1000,
      data: { turn: 1, usage: { inputTokens: 100000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 } }
    },
    { type: "request/header", time: baseAt - 20 * 1000, data: { header: { config: { provider: "ninfer-27b", model: "ninfer-27b" } } } },
    {
      type: "assistant/message",
      time: baseAt - 10 * 1000,
      data: { turn: 1, usage: { inputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 } }
    }
  ];
  const mixedRow = s.statsSessionRow({ id: "mixed-1" }, s.foldSessionStats(mixedEvents, { endpoints: localEndpoints }), {});
  ok("计费：混合会话只计 DeepSeek 部分", mixedRow.costMicros > 0);
  eq("计费：混合会话 billableTokens", mixedRow.billableTokens, 101000);
  eq("计费：混合会话 localTokens", mixedRow.localTokens, 3000);

  // 时间线分桶：本地小时 / 日起点，旧 → 新，越界点忽略。
  const hourStarts = s.statsBucketStarts(baseAt, 4, "hour");
  eq("分桶：小时桶数量", hourStarts.length, 4);
  eq("分桶：小时桶按本地整点结束", hourStarts[3], new Date(2026, 10, 4, 15, 0, 0, 0).getTime());
  eq("分桶：小时桶连续", hourStarts[0], new Date(2026, 10, 4, 12, 0, 0, 0).getTime());
  const dayStarts = s.statsBucketStarts(baseAt, 3, "day");
  eq("分桶：日桶结束于今天零点", dayStarts[2], new Date(2026, 10, 4, 0, 0, 0, 0).getTime());
  eq("分桶：日桶连续", dayStarts[0], new Date(2026, 10, 2, 0, 0, 0, 0).getTime());

  const points = [
    { t: new Date(2026, 10, 4, 15, 10).getTime(), input: 10, cacheRead: 20, cacheWrite: 30, output: 40, model: "deepseek-chat" },
    { t: new Date(2026, 10, 4, 12, 20).getTime(), input: 5, cacheRead: 0, cacheWrite: 0, output: 5, model: "deepseek-chat" },
    { t: new Date(2026, 10, 1, 9, 0).getTime(), input: 99, cacheRead: 0, cacheWrite: 0, output: 1, model: "deepseek-chat" }
  ];
  const hourBuckets = s.statsAggregate(points, hourStarts, "hour");
  eq("聚合：越界点被忽略", hourBuckets[0].tokens, 10);
  eq("聚合：最后一桶含两点", hourBuckets[3].tokens, 100);
  ok("聚合：成本为正", hourBuckets[3].costMicros > 0);
  eq("聚合：日视图跨天取最近 30 天", s.statsTimeline(points, baseAt).daily.length, 30);
  eq("聚合：小时视图 48 桶", s.statsTimeline(points, baseAt).hourly.length, 48);

  // 会话表聚合：标题兜底、总 token、运行态。
  const row = s.statsSessionRow(
    { id: "s1", cwd: "D:\\projects\\alpha" },
    fold,
    { running: true, live: true }
  );
  eq("会话行：有标题用标题", row.title, "Alpha");
  eq("会话行：token 总数", row.tokens.total, 385);
  eq("会话行：运行中标记", row.running, true);
  eq("会话行：实时标记", row.live, true);
  eq("会话行：无标题回退目录名", s.statsSessionRow({ id: "s2", cwd: "D:\\projects\\beta" }, { points: [], tokens: {} }, {}).title, "beta");
  eq("会话行：无标题无目录回退 id", s.statsSessionRow({ id: "s3" }, { points: [], tokens: {} }, {}).title, "s3");
  eq("会话行：子会话标记", s.statsSessionRow({ id: "s4", origin: "subagent" }, { points: [], tokens: {} }, {}).subagent, true);

  const summary = s.statsSummary([
    row,
    s.statsSessionRow({ id: "s5" }, { tokens: { input: 1, output: 1 }, points: [] }, {}),
    s.statsSessionRow({ id: "s6" }, { tokens: {}, points: [] }, { running: true })
  ]);
  eq("汇总：会话数", summary.sessions, 3);
  eq("汇总：四类 token 合计", summary.tokens.total, 387);
  eq("汇总：运行中数量", summary.running, 2);
  ok("汇总：成本累加为正", summary.costMicros > 0);
  ok("汇总：空表不崩", s.statsSummary(null).sessions === 0 && s.statsSummary(null).tokens.total === 0);

  // 预算：人民币分，0 视为未启用。
  const budget = s.statsBudget(2500000, 500);
  eq("预算：金额", budget.amountCents, 500);
  eq("预算：已用", budget.spentCents, 250);
  eq("预算：剩余", budget.remainingCents, 250);
  eq("预算：比例", budget.ratio, 0.5);
  eq("预算：启用", budget.enabled, true);
  const over = s.statsBudget(9000000, 500);
  eq("预算：超支剩余归零", over.remainingCents, 0);
  eq("预算：超支仍启用", over.enabled, true);
  const off = s.statsBudget(100, 0);
  eq("预算：0 关闭比例", off.enabled, false);
  eq("预算：0 比例为零", off.ratio, 0);
  eq("预算：无消费比例为零", s.statsBudget(null, 500).ratio, 0);

  // 入口与开关：0.2.2 调整后不再有「会话统计」开关，入口随费用卡片常显。
  ok("入口：不再暴露会话统计开关函数", typeof s.statsPanelEnabled === "undefined");
  ok("入口：不再暴露入口判定函数", typeof s.statsEntryVisible === "undefined");
  ok("入口：客户端不再引用入口判定", !/statsEntryVisible/.test(clientSrc));
  ok("入口：客户端不再渲染 showStats 分支", !/showStats/.test(clientSrc));
  ok("配置：宿主不再声明 statsPanel 开关", !/statsPanel/.test(indexSrc));
  ok("配置：客户端不再引用 statsPanel", !/statsPanel/.test(clientSrc));

  // 状态文件兼容：旧文件缺 budgetCents 时补默认 500，且不因未知字段报错。
  const legacy = store.normalizeCostState({ version: 1, observedSpendTotalCents: 12 });
  eq("状态：旧文件补默认预算", legacy.state.budgetCents, store.DEFAULT_BUDGET_CENTS);
  eq("状态：默认预算 500 分", store.DEFAULT_BUDGET_CENTS, 500);
  eq("状态：旧文件预算不为 0", legacy.state.budgetCents > 0, true);
  eq("状态：读旧文件不进入只读", legacy.readOnly, false);
  eq("状态：负数预算归零", store.normalizeCostState({ budgetCents: -20 }).state.budgetCents, 0);
  eq("状态：非法预算回默认", store.normalizeCostState({ budgetCents: "abc" }).state.budgetCents, 500);

  // 宿主 / 客户端接线断言：路由、日志来源、入口位置与设置项。
  ok("宿主：注册会话统计路由", /path: STATS_ROUTE/.test(indexSrc));
  ok("宿主：预算路由", /path: STATS_BUDGET_ROUTE/.test(indexSrc));
  ok("宿主：复用官方 sessionQuery", /ctx\.get\("sessionQuery"\)/.test(indexSrc));
  ok("宿主：折叠复用共享纯函数", /foldSessionStats\(/.test(indexSrc) && /statsTimeline\(/.test(indexSrc));
  ok("宿主：结算按分类口径计价（默认计费 + 本地例外）",
    /costOfGroups\(usage\.groups, period, classifyOptions\(\)\)/.test(indexSrc) &&
    /classifyRoute\(/.test(indexSrc) && /priceEntryFor\(/.test(indexSrc));
  ok("宿主：第三方计费不触发 DeepSeek 余额轮询",
    /routing: "third-party"/.test(indexSrc) && /mapped === "other"/.test(indexSrc));
  ok("宿主：provider→baseURL 三级探测（llm → configEditor → patch）",
    /llm\.listProviders/.test(indexSrc) && /configEditor/.test(indexSrc) &&
    /profileContext/.test(indexSrc) && /collectEndpointsFromPatch/.test(indexSrc));
  ok("宿主：计费配置读写路由",
    /BILLING_ROUTE = "\/dsh-message-actions\/billing"/.test(indexSrc) &&
    /makeBillingHandler/.test(indexSrc) && /applyBilling/.test(indexSrc));
  ok("宿主：价格表变更触发历史重算", /billingRevision/.test(indexSrc));
  ok("宿主：预算写入走同一状态文件", /applyBudget\(/.test(indexSrc) && /cost\.budgetCents\(\)/.test(indexSrc));
  ok("客户端：侧边栏费用行末尾入口", /dma-stats-entry/.test(clientSrc) && !/statsEntryVisible\(cfg\)/.test(clientSrc));
  ok("客户端：图标 + 悬停提示", /title: tt\("stats\.entryTitle"\)/.test(clientSrc));
  ok("设置页：按钮文案打开统计表", /tt\("cost\.settings\.statsTableButton"\)/.test(clientSrc) && !/cost\.settings\.openStats/.test(clientSrc));
  ok("设置页：统计表按钮不再受开关置灰", !/disabled: !statsPanelEnabled/.test(clientSrc));
  const iUsage = clientSrc.indexOf('labelKey: "cost.settings.usageStats"');
  const iLayout = clientSrc.indexOf("e(LayoutRow");
  const iPerTurn = clientSrc.indexOf('labelKey: "cost.settings.perTurn"');
  const iAutoClose = clientSrc.indexOf('labelKey: "cost.settings.autoClose"');
  const iPeak = clientSrc.indexOf('labelKey: "cost.settings.peakValley"');
  const iStats = clientSrc.indexOf('tt("cost.settings.statsTable")');
  const iBalanceNote = clientSrc.indexOf('tt("cost.balanceNote")');
  ok("设置页：统计表排在峰谷之后、账号口径说明之前",
    iUsage > -1 && iUsage < iLayout && iLayout < iPerTurn && iPerTurn < iAutoClose &&
    iAutoClose < iPeak && iPeak < iStats && iStats < iBalanceNote);
  ok("设置页：统计表行不再写预算说明", !/cost\.settings\.budgetNote/.test(clientSrc));
  ok("面板：预算辅助说明保留", /stats\.budgetNote/.test(clientSrc));
  const i18nSrc = fs.readFileSync(path.join(root, "src", "i18n.cjs"), "utf8");
  ok("文案：统计表 zh/en 均有", (i18nSrc.match(/'cost\.settings\.statsTable':/g) || []).length === 2);
  ok("文案：打开统计表按钮 zh/en 均有",
    (i18nSrc.match(/'cost\.settings\.statsTableButton':/g) || []).length === 2);
  ok("文案：预算说明只在面板、不在设置页",
    (i18nSrc.match(/'cost\.settings\.budgetNote':/g) || []).length === 0 &&
    (i18nSrc.match(/'stats\.budgetNote':/g) || []).length === 2);
  const i18nObj = i18n;
  eq("文案：面板标题 zh", i18nObj.zh["stats.panelTitle"], "统计表");
  eq("文案：面板标题 en", i18nObj.en["stats.panelTitle"], "Statistics");
  eq("文案：入口悬停 zh", i18nObj.zh["stats.entryTitle"], "统计表");
  eq("文案：入口悬停 en", i18nObj.en["stats.entryTitle"], "Statistics");
  ok("面板标题用于 aria-label", /"aria-label": tt\("stats\.panelTitle"\)/.test(clientSrc));
  ok("面板标题用于标题栏", /className: "dma-stats-title" \}, tt\("stats\.panelTitle"\)/.test(clientSrc));
  ok("文案：答行统计提示仍保留 stats.title", (i18nSrc.match(/'stats\.title':/g) || []).length === 2);
  ok("文案：不再保留打开会话统计设置项", !/cost\.settings\.openStats/.test(i18nSrc));
  ok("客户端：浮层复用 dma-overlay/dma-panel", /className: "dma-panel dma-stats-panel"/.test(clientSrc));
  ok("客户端：Esc 关闭走 useOverlayKeys", /useOverlayKeys\(\{ active: true, primaryEnabled: false/.test(clientSrc));
  ok("客户端：面板请求统计路由", /getJson\(STATS_ROUTE\)/.test(clientSrc));
  ok("客户端：预算保存走宿主路由", /postJson\(STATS_BUDGET_ROUTE/.test(clientSrc));
  ok("客户端：时间线 24 小时切换", /\(series\.hourly \|\| \[\]\)\.slice\(-24\)/.test(clientSrc));
  ok("客户端：未并入 CPU 面板", !/CpuPanel|process\.cpuUsage|loadavg|uptime\(/.test(clientSrc));

  // —— 0.2.2 实测反馈：日用即时累加、分单位余额、预算行三数字、提示音 ——

  // 北京时区固定锚点：2026-11-03 23:00 与 2026-11-04 01:00。
  const dayOneAt = Date.UTC(2026, 10, 3, 15, 0, 0);
  const dayTwoAt = dayOneAt + 2 * 60 * 60 * 1000;
  const settledOne = s.settleSpend({}, { micros: 50000, at: dayOneAt, key: "s:1:1" });
  eq("结算：本轮立即累加日用（5 分）", settledOne.state.dailySpendCents["2026-11-03"], 5);
  eq("结算：标记已应用", settledOne.applied, true);
  eq("结算：累计结算总额", settledOne.state.settledSpendTotalCents, 5);
  eq("结算：累计待核对结算", settledOne.state.settledSinceObserveCents, 5);
  const settledDup = s.settleSpend(settledOne.state, { micros: 50000, at: dayOneAt, key: "s:1:1" });
  eq("结算：同一轮重复推送幂等", settledDup.applied, false);
  eq("结算：幂等后日用量不变", settledDup.state.dailySpendCents["2026-11-03"], 5);
  const settledCross = s.settleSpend({}, { micros: 70000, at: dayTwoAt, key: "s:2:2" });
  eq("结算：跨零点按结算时刻入桶", settledCross.state.dailySpendCents["2026-11-04"], 7);
  eq("结算：跨日不写入前一天", settledCross.state.dailySpendCents["2026-11-03"], undefined);
  eq("结算：零金额不计", s.settleSpend({}, { micros: 0, at: dayOneAt, key: "s:3:3" }).applied, false);

  // 余额观测只补差额，不把已结算金额重复计入。
  const observedBase = {
    baselineBalanceCents: 600,
    lastBalanceCents: 600,
    lastBalanceAt: dayOneAt,
    lastRouting: "account",
    dailySpendCents: { "2026-11-03": 5 },
    settledSinceObserveCents: 5,
    settledSpendTotalCents: 5,
    observedSpendTotalCents: 0
  };
  const observedSame = s.observeBalance(observedBase, { cents: 595, routing: "account", at: dayOneAt + 60000 });
  eq("观测：差额与结算相等不重复累加", observedSame.state.dailySpendCents["2026-11-03"], 5);
  eq("观测：累计已观测消费", observedSame.state.observedSpendTotalCents, 5);
  eq("观测：核对后清空待核对结算", observedSame.state.settledSinceObserveCents, 0);
  const observedExtra = s.observeBalance(observedBase, { cents: 592, routing: "account", at: dayOneAt + 60000 });
  eq("观测：差额大于结算时只补超出部分", observedExtra.state.dailySpendCents["2026-11-03"], 8);
  const observedLess = s.observeBalance(observedBase, { cents: 597, routing: "account", at: dayOneAt + 60000 });
  eq("观测：差额小于结算时不做减法", observedLess.state.dailySpendCents["2026-11-03"], 5);
  const observedCross = s.observeBalance(
    { lastBalanceCents: 600, lastBalanceAt: dayOneAt, lastRouting: "account", baselineBalanceCents: 600, settledSinceObserveCents: 5, dailySpendCents: { "2026-11-03": 5 } },
    { cents: 590, routing: "account", at: dayTwoAt }
  );
  eq("观测：跨日跳过差额并清空待核对", observedCross.state.settledSinceObserveCents, 0);
  eq("观测：跨日不改日用", observedCross.state.dailySpendCents["2026-11-03"], 5);

  // 分单位金额：不经过元级四舍五入。
  eq("金额：字符串 5.99 元 = 599 分", s.yuanToCents("5.99"), 599);
  eq("金额：数字 5.99 元 = 599 分", s.yuanToCents(5.99), 599);
  eq("金额：浮点 0.1+0.2 = 30 分", s.yuanToCents(0.1 + 0.2), 30);
  eq("金额：599 分显示 ¥5.99", s.formatYuanCents(599), "¥5.99");
  eq("金额：600 分显示 ¥6.00", s.formatYuanCents(600), "¥6.00");
  eq("金额：非法值返回 null", s.yuanToCents("abc"), null);

  // 提示音：音色归一化、关闭语义与选项集合（0.2.2 起由音色「关闭」承载开关）。
  eq("提示音：未知音色回默认双音", s.normalizeSoundTone("weird"), "double");
  eq("提示音：默认音色为双音", s.completionSoundTone({}), "double");
  eq("提示音：关闭开关返回 off", s.completionSoundTone({ sound: false }), "off");
  eq("提示音：音色关闭返回 off", s.completionSoundTone({ soundTone: "off" }), "off");
  eq("提示音：关闭后开启状态为假", s.completionSoundEnabled({ soundTone: "off" }), false);
  eq("提示音：四选项含关闭", s.soundToneOptions().join(","), "double,bell,soft,off");
  eq("提示音：旧配置 sound=false 映射为关闭", s.completionSoundTone({ sound: false, soundTone: "soft" }), "off");
  eq("提示音：新配置 soundTone=soft 即开启", s.completionSoundTone({ soundTone: "soft" }), "soft");

  // 音量：0–100，默认 50，50 为基准，100 为两倍，0 静音。
  eq("音量：默认 50", s.DEFAULT_SOUND_VOLUME, 50);
  eq("音量：非法值回默认", s.clampSoundVolume("abc"), 50);
  eq("音量：负数归零", s.clampSoundVolume(-10), 0);
  eq("音量：超过 100 归 100", s.clampSoundVolume(130), 100);
  eq("音量：字符串数字生效", s.clampSoundVolume("35"), 35);
  eq("音量：50 为基准倍数 1", s.soundGainScale(50), 1);
  eq("音量：25 为一半", s.soundGainScale(25), 0.5);
  eq("音量：100 为两倍", s.soundGainScale(100), 2);
  eq("音量：0 增益为 0（不发声）", s.soundGainScale(0), 0);

  // 接线：结算、充值余额、预算卡片与音频解锁。
  ok("宿主：turn/end 走 settleSpend", /settleSpend\(state, \{/.test(indexSrc));
  ok("宿主：Config 声明 soundTone", /soundTone: z\.string\(\)\.default\("double"\)\.volatile\(\)/.test(indexSrc));
  ok("宿主：Config 声明 soundVolume", /soundVolume: z\.number\(\)\.min\(0\)\.max\(100\)\.default\(50\)\.volatile\(\)/.test(indexSrc));
  ok("宿主：余额主数字取总额（充值 + 赠金，缺总额才退回充值）",
    /const balanceCents = totalCents !== null \? totalCents : rechargeCents;/.test(indexSrc) &&
    /const rechargeCents = sumCnyWallets\(result\.value\);/.test(indexSrc) &&
    /const bonusCents = sumCnyWallets\(result\.bonusWallets\);/.test(indexSrc));
  ok("客户端：余额主数字取总额（充值 + 赠金）",
    /totalCents !== null \? totalCents : rechargeCents/.test(clientSrc));
  ok("统计表：余额卡不再单独拆赠金副行", !/ledger\.bonusCents > 0/.test(clientSrc) &&
    /tt\("stats\.moneyBalanceSub"\)/.test(clientSrc));
  ok("客户端：首次交互预解锁音频", /installAudioUnlock\(\)/.test(clientSrc) && /addEventListener\("pointerdown", unlockAudio/.test(clientSrc));
  ok("客户端：基准增益 0.18", /double: \{ gain: 0\.18/.test(clientSrc));
  ok("客户端：增益按音量缩放", /spec\.gain \* scale/.test(clientSrc) && /soundGainScale\(vol\) > 0/.test(clientSrc));
  ok("客户端：设置页不再有完成提示音开关行", !/settings\.soundDesc/.test(clientSrc) &&
    !/\["sound", "settings\.sound"/.test(clientSrc));
  ok("客户端：设置页音色行", /function SoundToneRow/.test(clientSrc) && /soundToneOptions\(\)/.test(clientSrc));
  ok("客户端：选中音色即时试听", /playCompletionSound\(id\)/.test(clientSrc));
  ok("客户端：音量滑杆 0–100 步进 5", /type: "range"/.test(clientSrc) && /min: 0,/.test(clientSrc) &&
    /max: 100,/.test(clientSrc) && /step: 5,/.test(clientSrc));
  ok("客户端：音量用本地 draft 跟手显示",
    /const \[draft, setDraft\] = React\.useState\(committed\)/.test(clientSrc) &&
    /draftRef\.current = next;/.test(clientSrc) &&
    /value: draft,/.test(clientSrc) && /draft \+ "%"/.test(clientSrc));
  ok("客户端：拖动 onChange 只更新本地、不写宿主配置",
    /onChange: \(ev\) => \{\s*dragging\.current = true;\s*update\(ev\.target\.value\);/.test(clientSrc) &&
    (clientSrc.match(/save\("soundVolume"/g) || []).length === 1);
  ok("客户端：音量提交防抖 120ms 且只提交一次",
    /}, 120\);/.test(clientSrc) &&
    /if \(next === committedRef\.current\) return;/.test(clientSrc) &&
    /committedRef\.current = next;[\s\S]{0,80}onCommit\(next\);/.test(clientSrc));
  ok("客户端：松手 / 键盘 / 失焦 / change 结束都走提交",
    /onPointerUp: commit/.test(clientSrc) && /onKeyUp: commit/.test(clientSrc) &&
    /onBlur: commit/.test(clientSrc) && /addEventListener\("change", onChangeEnd\)/.test(clientSrc));
  ok("客户端：音量提交时保存一次并只试听一次",
    /onCommit: \(volume\) => \{\s*save\("soundVolume", volume\);\s*playCompletionSound\(undefined, volume\);\s*\}/.test(clientSrc));
  ok("客户端：外部配置在拖动/防抖期间不回写 draft",
    /if \(!dragging\.current && !timer\.current\) \{\s*draftRef\.current = committed;\s*setDraft\(committed\);\s*\}/.test(clientSrc));
  ok("客户端：音色「关闭」不再写 sound 开关", /if \(id === "off"\) return;/.test(clientSrc));
  ok("客户端：预算卡片网格", /dma-stats-kpis dma-stats-money/.test(clientSrc) && !/dma-stats-budget-ledger/.test(clientSrc));
  ok("客户端：预算卡可编辑金额", /dma-stats-money-edit/.test(clientSrc) && /budgetEditing/.test(clientSrc));
  ok("客户端：预算卡有「修改预算」小按钮", /className: "dma-stats-money-value-row"/.test(clientSrc) &&
    /className: "dma-stats-money-mini"/.test(clientSrc) &&
    !/dma-stats-money-apply/.test(clientSrc) && !/dma-stats-money-trigger/.test(clientSrc));
  ok("客户端：「修改预算」与「保存」复用同一小按钮类",
    (clientSrc.match(/className: "dma-stats-money-mini"/g) || []).length >= 2 &&
    !/dma-stats-money-save/.test(clientSrc) &&
    !/\.dma-stats-money-value-row \.dma-setting-primary/.test(clientSrc));
  ok("客户端：预算小按钮尺寸 25px 高 / 11.5px 字 / 6px 圆角",
    /\.dma-stats-money-mini\{[^}]*height:25px[^}]*padding:0 9px[^}]*border-radius:6px[^}]*font-size:11\.5px/.test(clientSrc));
  ok("客户端：「修改预算」与金额同一行，不再独占一行",
    /className: "dma-stats-money-value-row"[\s\S]{0,700}dma-stats-money-mini/.test(clientSrc) &&
    /\.dma-stats-money-value-row\{display:flex;align-items:center/.test(clientSrc));
  ok("客户端：预算输入框宽度 92px（最窄 64px、13px 字）",
    /\.dma-stats-money-input\{[^}]*flex:0 1 92px[^}]*box-sizing:border-box;width:92px;min-width:64px[^}]*font-size:13px/.test(clientSrc) &&
    /\.dma-stats-money-input input\{[^}]*width:0[^}]*font-size:13px/.test(clientSrc));
  ok("客户端：最窄卡片下预算行由容器查询收紧间距",
    /\.dma-stats-money-card\{container-type:inline-size\}/.test(clientSrc) &&
    /@container \(max-width:181px\)\{\.dma-stats-money-edit-row\{gap:4px\}/.test(clientSrc));
  ok("客户端：预算编辑态强制同行（nowrap）且控件间距 7px",
    /\.dma-stats-money-edit-row\{display:flex;flex-wrap:nowrap;align-items:center;gap:7px/.test(clientSrc));
  ok("客户端：预算输入框不再使用 64px 基础宽度",
    !/flex:0 1 64px/.test(clientSrc) && !/width:64px;min-width:40px/.test(clientSrc));
  ok("客户端：预算编辑态保存 + 取消同行，取消为小号次级描边",
    /tt\("stats\.budgetSave"\)\),[\s\S]{0,260}className: "dma-stats-money-cancel"/.test(clientSrc) &&
    /\.dma-stats-money-cancel\{[^}]*height:25px[^}]*padding:0 7px[^}]*border:\.5px solid[^}]*font-size:11px/.test(clientSrc));
  ok("客户端：预算说明压缩为一行（不换行截断）",
    /\.dma-stats-money-hint\{[^}]*font-size:10px[^}]*white-space:nowrap/.test(clientSrc));
  ok("客户端：时间线有计费口径细条（DeepSeek 深蓝 / 本地灰）",
    /dma-stats-billing-bar/.test(clientSrc) &&
    /\.dma-stats-billing-deepseek\{background:#2f6bd8\}/.test(clientSrc) &&
    /\.dma-stats-billing-local\{background:#a8aeb8\}/.test(clientSrc));
  ok("客户端：时间线图例区分 DeepSeek 计费与本地不计费",
    /tt\("stats\.billingDeepseek"\)/.test(clientSrc) && /tt\("stats\.billingLocal"\)/.test(clientSrc));
  ok("客户端：计费说明并入四色图例同一行并右对齐",
    /className: "dma-stats-legend-row"[\s\S]{0,300}e\(StatsLegend, \{ t: tt \}\)[\s\S]{0,200}dma-stats-legend-billing/.test(clientSrc) &&
    /\.dma-stats-legend-row\{[^}]*justify-content:space-between/.test(clientSrc) &&
    /\.dma-stats-legend-billing\{flex:none;margin-left:auto\}/.test(clientSrc));
  ok("客户端：会话表本地行成本显示「本地」并加灰色标记",
    /tt\("stats\.localCost"\)/.test(clientSrc) &&
    /dma-stats-pill-local/.test(clientSrc) && /tt\("stats\.localTag"\)/.test(clientSrc));
  ok("客户端：统计表说明写明默认计费与本地例外", /tt\("stats\.billingNote"\)/.test(clientSrc));
  ok("文案：默认计费说明（英）",
    String(i18n.en["stats.billingNote"]).indexOf("Billed by default") >= 0);
  eq("文案：预算说明已缩短（中）", i18n.zh["stats.budgetHint"], "按全部会话估算成本；填 0 隐藏占比");
  ok("客户端：「修改预算」按钮为主要入口（与点金额共用）",
    /const openBudgetEdit = \(\) => \{/.test(clientSrc) &&
    (clientSrc.match(/onClick: openBudgetEdit/g) || []).length === 2);
  ok("客户端：预算编辑态回车保存 / Esc 取消 / 保存取消按钮",
    /ev\.key === "Enter"\) saveBudget\(\);/.test(clientSrc) &&
    /ev\.key === "Escape"/.test(clientSrc) &&
    /dma-stats-money-cancel/.test(clientSrc) && /tt\("stats\.budgetSaving"\)/.test(clientSrc));
  ok("客户端：第一行顺序 总Token → 会话 → 预算 → 预算使用",
    /className: "dma-stats-kpis"[\s\S]{0,220}kpi\.slice\(0, 2\)\.map\(statsCard\),[\s\S]{0,220}budgetCardNode,[\s\S]{0,90}budgetUsageCardNode/.test(clientSrc));
  ok("客户端：第二行顺序 余额 → 日用 → 单次 → 估算成本",
    (() => {
      const at = clientSrc.indexOf('className: "dma-stats-kpis dma-stats-money"');
      if (at < 0) return false;
      const end = clientSrc.indexOf("!loading && data", at);
      const seg = clientSrc.slice(at, end < 0 ? at + 1200 : end);
      const a = seg.indexOf('tt("cost.balance")');
      const b = seg.indexOf('tt("cost.daily")');
      const c = seg.indexOf('tt("cost.perTurn")');
      const d = seg.indexOf("statsCard(kpi[2])");
      return a >= 0 && a < b && b < c && c < d;
    })());
  ok("客户端：预算卡与预算使用卡各定义一次（无重复内联）",
    (clientSrc.match(/className: "dma-stats-money-edit-row"/g) || []).length === 1 &&
    (clientSrc.match(/dma-stats-budget-input/g) || []).length === 1 &&
    (clientSrc.match(/const budgetUsageCardNode/g) || []).length === 1);
  ok("样式：余额校正区块已完全移除（无死样式）",
    !/\.dma-correction/.test(clientSrc) && !/dma-cost-badge/.test(clientSrc) &&
    /\.dma-setting-primary\{/.test(clientSrc));
  ok("样式：设置分组分割线唯一来源是设置行 border-bottom",
    (clientSrc.match(/\.dma-setting-row\{[^}]*border-bottom:\.5px solid/g) || []).length === 1);
  ok("客户端：顶部 KPI 不再含预算使用项",
    (() => {
      const at = clientSrc.indexOf("const kpi = [");
      if (at < 0) return false;
      const block = clientSrc.slice(at, clientSrc.indexOf("];", at));
      return block.split("label:").length - 1 === 3 && !/stats\.budget"/.test(block);
    })());
  eq("文案：修改预算中文", i18n.zh["stats.moneyEdit"], "修改预算");
  eq("文案：修改预算英文", i18n.en["stats.moneyEdit"], "Edit budget");
  ok("客户端：预算/余额/日用/单次四卡", /tt\("stats\.moneyBudget"\)/.test(clientSrc) && /tt\("cost\.balance"\)/.test(clientSrc) &&
    /tt\("cost\.daily"\)/.test(clientSrc) && /tt\("cost\.perTurn"\)/.test(clientSrc));
  ok("客户端：卡片数字与侧边栏同源", /ledger\.balanceCents/.test(clientSrc) && /ledger\.dailyCents/.test(clientSrc) &&
    /ledger\.lastTurnMicros/.test(clientSrc) && /formatYuanCents\(ledger\.dailyCents/.test(clientSrc));
  ok("文案：赠金提示 zh/en 均有且为合并口径", (i18nSrc.match(/'cost\.bonusHint':/g) || []).length === 2 &&
    i18n.zh["cost.bonusHint"] === "含赠金 {bonus}" && i18n.en["cost.bonusHint"] === "incl. bonus {bonus}");
  eq("文案：统计表余额副行中文", i18n.zh["stats.moneyBalanceSub"], "账户总余额（含赠金）");
  eq("文案：统计表余额副行英文", i18n.en["stats.moneyBalanceSub"], "Total balance (incl. bonus)");
  ok("文案：音色选项 zh/en 均有", (i18nSrc.match(/'settings\.soundTone\.double':/g) || []).length === 2);
  ok("文案：音色说明 zh/en 均有", (i18nSrc.match(/'settings\.soundToneDesc':/g) || []).length === 2 &&
    !/等同.*上方开关/.test(i18nSrc));
  ok("文案：音量项 zh/en 均有", (i18nSrc.match(/'settings\.soundVolume':/g) || []).length === 2 &&
    (i18nSrc.match(/'settings\.soundVolumeDesc':/g) || []).length === 2);
  ok("文案：金额卡文案 zh/en 均有", (i18nSrc.match(/'stats\.moneyEdit':/g) || []).length === 2 &&
    (i18nSrc.match(/'stats\.moneyBudget':/g) || []).length === 2);
}

// ---------------------------------------------------------------------------
// 51. 单条回答金额：只算该条自己的 usage，本地路由不显示金额
// ---------------------------------------------------------------------------

{
  const at = bj(2026, 11, 2, 10, 0); // 周一高峰
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", { role: "user", id: "u1", content: [{ type: "text", text: "q" }], source: { kind: "user" } }),
    {
      type: "assistant/message",
      time: at,
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1000000, outputTokens: 0 },
        message: { content: [{ type: "text", text: "DeepSeek 回答" }], source: { provider: "deepseek-account", model: "deepseek-flash" } }
      }
    },
    {
      type: "assistant/message",
      time: at,
      data: {
        turn: 1,
        step: 2,
        usage: { inputTokens: 1000000, outputTokens: 0 },
        message: { content: [{ type: "text", text: "本地回答" }], source: { provider: "ninfer-27b", model: "ninfer-27b" } }
      }
    },
    ev("assistant/message", { turn: 1, step: 3, message: { content: [{ type: "text", text: "无用量" }] } }),
    ev("turn/end", { turn: 1 })
  ];
  const { events: bag, nodes } = session(events);
  const summary = messagesSummaryOf(bag, nodes, null, {
    endpoints: { "ninfer-27b": "http://127.0.0.1:11434" }
  });
  const row = (seq) => summary.rows.find((item) => item.seq === seq);

  eq("单条金额：DeepSeek 高峰百万输入", row(3).costMicros, 2000000);
  eq("单条金额：DeepSeek 计入", row(3).billable, true);
  eq("单条金额：本地路由为 0", row(4).costMicros, 0);
  eq("单条金额：本地路由不计费", row(4).billable, false);
  eq("单条金额：无 usage 不显示", row(5).costMicros, null);
  eq("单条金额：无 usage 不计费标记", row(5).billable, null);
  eq("单条金额：问行不计算", row(2).costMicros, null);

  eq("formatReplyCost 0", s.formatReplyCost(0), "¥0.0000");
  eq("formatReplyCost 不足万分之一元", s.formatReplyCost(50), "<¥0.0001");
  eq("formatReplyCost 4 位小数", s.formatReplyCost(2300), "¥0.0023");
  eq("formatReplyCost 进位到 4 位", s.formatReplyCost(250000), "¥0.2500");
  eq("formatReplyCost 非法值返回空", s.formatReplyCost(undefined), "");
  eq("formatReplyCost 负值按 0", s.formatReplyCost(-1), "¥0.0000");
}

// ---------------------------------------------------------------------------
// 52. 撤回附件：正文不留占位符，图片/文件按 id 交给客户端恢复
// ---------------------------------------------------------------------------

{
  const events = [
    ev("system/message", { message: { content: [{ type: "text", text: "sys" }] } }),
    ev("turn/start", { turn: 1 }),
    ev("user/message", {
      role: "user",
      id: "u1",
      content: [
        { type: "text", text: "看图" },
        {
          type: "image",
          attachment: {
            attachmentId: "sha256:aaa",
            mediaType: "image/png",
            name: "报错.png",
            bytes: 1234,
            width: 800,
            height: 600
          }
        },
        { type: "text", text: "还有" },
        {
          type: "file",
          attachment: {
            attachmentId: "sha256:bbb",
            mediaType: "application/pdf",
            name: "柱状图.pdf",
            bytes: 5678
          }
        },
        {
          type: "image",
          attachment: { attachmentId: "sha256:aaa", mediaType: "image/png", name: "报错.png" }
        }
      ],
      source: { kind: "user" }
    }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "好的" }] } }),
    ev("turn/end", { turn: 1 })
  ];
  const { events: bag, nodes } = session(events);
  const plan = planAction(bag, nodes, { action: "recall", seq: 2 });

  ok("撤回附件：返回 ok", plan.ok === true);
  eq("撤回附件：正文不含占位符", plan.refillText, "看图还有");
  eq("撤回附件：描述去重且保序", plan.attachments, [
    {
      kind: "image",
      attachmentId: "sha256:aaa",
      name: "报错.png",
      mediaType: "image/png",
      bytes: 1234,
      width: 800,
      height: 600
    },
    {
      kind: "file",
      attachmentId: "sha256:bbb",
      name: "柱状图.pdf",
      mediaType: "application/pdf",
      bytes: 5678,
      width: undefined,
      height: undefined
    }
  ]);
  eq("撤回附件：分享/导出文本仍保留占位符", textOf(bag[2]), "看图[图片]还有[文件][图片]");
  eq("撤回附件：无附件时为空数组", s.attachmentsOfEvent(bag[4]), []);
  eq("撤回附件：非用户消息为空数组", s.attachmentsOfEvent({ type: "assistant/message", data: { content: [] } }), []);
  eq("删除不返回附件", planAction(bag, nodes, { action: "delete", seq: 2 }).attachments, undefined);
}

// ---------------------------------------------------------------------------
// 53. 影响面断言：附件路由、客户端恢复通道、单条金额展示
// ---------------------------------------------------------------------------

{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const indexSrc = fs.readFileSync(path.join(root, "src", "index.mjs"), "utf8");
  const clientSrc = fs.readFileSync(path.join(root, "src", "client.js"), "utf8");
  const i18nSrc = fs.readFileSync(path.join(root, "src", "i18n.cjs"), "utf8");

  ok("宿主：附件路由常量", /const ATTACHMENT_ROUTE = "\/dsh-message-actions\/attachment"/.test(indexSrc));
  ok("宿主：附件处理器存在", /function makeAttachmentHandler\(ctx\)/.test(indexSrc));
  ok("宿主：图片走 readImage", /store\.readImage\(found\.ref\)/.test(indexSrc) && /typeof store\.readImage !== "function"/.test(indexSrc));
  ok("宿主：文件走 readFileStream", /store\.readFileStream\(found\.ref\)/.test(indexSrc) && /typeof store\.readFileStream !== "function"/.test(indexSrc));
  ok("宿主：注册附件路由", /path: ATTACHMENT_ROUTE/.test(indexSrc));
  ok("宿主：动作响应带回附件", /attachments: plan\.attachments \|\| \[\]/.test(indexSrc));
  ok("宿主：附件错误码已本地化", /ATTACHMENT_NOT_FOUND/.test(indexSrc) && /ATTACHMENT_UNAVAILABLE/.test(indexSrc) && /ATTACHMENT_READ_FAILED/.test(indexSrc));

  ok("客户端：撤回后恢复附件", /restoreRecallAttachments\(this\.sessionId, value\.attachments\)/.test(clientSrc));
  ok("客户端：附件回读路由常量", /const ATTACHMENT_PATH = "\/dsh-message-actions\/attachment"/.test(clientSrc));
  ok("客户端：交给官方 drop 通道", /new DragEvent\("drop"/.test(clientSrc) && /document\.dispatchEvent\(event\)/.test(clientSrc));
  ok("客户端：构造 File 恢复附件", /new File\(\[blob\], name, \{ type: meta\.mediaType/.test(clientSrc));
  ok("客户端：单条金额用 4 位格式", /formatReplyCost\(row\.costMicros\)/.test(clientSrc));
  ok("客户端：本地路由显示「本地」", /row\.billable === false[\s\S]{0,80}tt\("stats\.localCost"\)/.test(clientSrc));
  ok("客户端：未配置价格显示「未配置」", /row\.costPriced === false[\s\S]{0,80}tt\("stats\.unpricedCost"\)/.test(clientSrc));
  ok("客户端：计费设置入口与来源诊断", /BILLING_ROUTE/.test(clientSrc) && /BillingSection/.test(clientSrc) &&
    /stats\.billingEndpoints/.test(clientSrc));
  ok("客户端：单条金额并入统计行", /words \+ " " \+ tt\("stats\.unit"\),[\s\S]{0,40}replyCost/.test(clientSrc));

  eq("文案：单条金额说明中文", i18n.zh["stats.replyCostTitle"], "本条回答估算 {cost}；同一轮的合计见侧边栏「单次」");
  ok("文案：单条金额说明中英均有", (i18nSrc.match(/'stats\.replyCostTitle':/g) || []).length === 2 &&
    i18n.zh["stats.replyCostTitle"].includes("{cost}") &&
    i18n.en["stats.replyCostTitle"].includes("{cost}"));
  eq("文案：附件不存在中文", s.ERROR_LABELS.zh.ATTACHMENT_NOT_FOUND, "附件不存在或已失效");
  eq("文案：附件不存在英文", s.ERROR_LABELS.en.ATTACHMENT_NOT_FOUND, "Attachment not found or no longer available");
}

// ---------------------------------------------------------------------------
// 54. 确认弹窗宽度：收回/删除/删至末尾共用窄面板，窄屏按钮不挤
// ---------------------------------------------------------------------------

{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sharedSrc = fs.readFileSync(path.join(root, "src", "shared.cjs"), "utf8");
  const clientSrc = fs.readFileSync(path.join(root, "src", "client.js"), "utf8");

  ok("确认弹窗：窄面板宽度 420px", /\.dma-confirm\{width:min\(420px,calc\(100vw - 48px\)\)\}/.test(sharedSrc));
  ok("确认弹窗：窄屏改为满宽减 32px", /@media \(max-width:480px\)\{\.dma-confirm\{width:calc\(100vw - 32px\)\}/.test(sharedSrc));
  ok("确认弹窗：窄屏按钮间距与内边距收紧", /\.dma-panel-foot\{gap:8px\}/.test(sharedSrc) && /\.dma-panel-foot \.dma-btn\{padding:0 12px\}/.test(sharedSrc));
  ok("确认弹窗：三个动作共用 dma-confirm", /className: "dma-panel dma-confirm"/.test(clientSrc));
  ok("确认弹窗：不影响分享/导出面板 680px", /\.dma-panel\{width:min\(680px,calc\(100vw - 48px\)\);/.test(sharedSrc));
}

// ---------------------------------------------------------------------------
// 55. 浮层 portal 挂载与视口约束（宿主输入区 will-change/overflow 兼容）
// ---------------------------------------------------------------------------

{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sharedSrc = fs.readFileSync(path.join(root, "src", "shared.cjs"), "utf8");
  const clientSrc = fs.readFileSync(path.join(root, "src", "client.js"), "utf8");

  ok("浮层：从 react-dom 探测 createPortal", /require\("react-dom"\)/.test(clientSrc) &&
    /typeof ReactDOM\.createPortal === "function"/.test(clientSrc));
  ok("浮层：portal 到 document.body 且失败回退槽位", /ReactDOM\.createPortal\(node, document\.body\)/.test(clientSrc) &&
    /return node;/.test(clientSrc));
  ok("浮层：确认框与分享/导出共用 mountOverlay 单一路径",
    /function mountOverlay\(node\)/.test(clientSrc) &&
    /return panel \? mountOverlay\(panel\) : null;/.test(clientSrc) &&
    !/return e\(ConfirmOverlay,/.test(clientSrc) && !/return e\(PickOverlay,/.test(clientSrc));
  ok("浮层：遮罩按视口铺满并居中滚动",
    /\.dma-overlay\{position:fixed;inset:0;/.test(sharedSrc) &&
    /display:grid;place-items:center;padding:16px;overflow:auto/.test(sharedSrc));
  ok("浮层：面板限高且正文可滚动、头尾固定",
    /max-height:calc\(100vh - 32px\)/.test(sharedSrc) &&
    /\.dma-panel-head\{flex:none/.test(sharedSrc) &&
    /\.dma-panel-body\{flex:1 1 auto;min-height:0;overflow:auto/.test(sharedSrc) &&
    /\.dma-panel-foot\{flex:none/.test(sharedSrc));
}

// ---------------------------------------------------------------------------
// 56. 会话管理纯函数（参数校验 / 路径 / 回收站元数据 / 响应头）
// ---------------------------------------------------------------------------

{
  const sp = sessionsPure;

  ok("会话 id：接受 session-<uuid>", sp.isSessionId("session-0b9f5c1e-7d2a-4c31-9a0e-3f4b5c6d7e8f"));
  ok("会话 id：拒绝路径穿越", !sp.isSessionId("../session-abc") && !sp.isSessionId("session/abc"));
  ok("会话 id：拒绝控制字符与空值", !sp.isSessionId("session\nabc") && !sp.isSessionId(""));
  ok("会话 id：拒绝超长值", !sp.isSessionId("a".repeat(200)));
  ok("工作区 id：接受 uuid", sp.isWorkspaceId("5d0c4b1a-1f7e-4a3b-8894-2c2f8e8a9c11"));
  ok("工作区 id：拒绝分隔符", !sp.isWorkspaceId("ws/one") && !sp.isWorkspaceId("ws\\one"));
  ok("回收站 id：只接受 trash- 前缀", sp.isTrashId("trash-m3f8x-0b9f5c1e") && !sp.isTrashId("meta.json") &&
    !sp.isTrashId("trash-../../x"));

  const sep = path.sep;
  const base = path.join(path.parse(process.cwd()).root, "data", "sessions");
  ok("路径包含：自身为真", sp.isContainedPath(base, base));
  ok("路径包含：子目录为真", sp.isContainedPath(base, path.join(base, "a", "b")));
  ok("路径包含：同级前缀不算包含", !sp.isContainedPath(base, base + "2"));
  ok("路径包含：.. 逃逸为假", !sp.isContainedPath(base, path.join(base, "..", "outside")));
  ok("路径包含：非字符串为假", !sp.isContainedPath(null, base) && !sp.isContainedPath(base, 42));

  eq("编码：安全字符原样保留", sp.encodeSegment("session-0b9f.5c"), "session-0b9f.5c");
  eq("编码：分隔符转义", sp.encodeSegment("a/b\\c"), "a~002Fb~005Cc");
  eq("编码：点目录转义", sp.encodeSegment(".."), "~002E~002E");
  eq("编码：中文按码元转义", sp.encodeSegment("你"), "~4F60");
  let encodeThrows = false;
  try {
    sp.encodeSegment("");
  } catch {
    encodeThrows = true;
  }
  ok("编码：空串抛错", encodeThrows);

  eq("项目目录：Windows 路径",
    sp.projectKeyOf("D:\\DATA\\Documents\\Projects\\DeepSeek Harness"),
    "--D-DATA-Documents-Projects-DeepSeek~0020Harness--");
  eq("项目目录：POSIX 路径", sp.projectKeyOf("/home/u/app"), "--home-u-app--");
  eq("项目目录：根路径", sp.projectKeyOf("/"), "--root--");
  ok("项目目录：不会生成 .. 段", sp.projectKeyOf("..") !== ".." && !sp.projectKeyOf("..").startsWith("."));
  eq("会话目录：拼接", sp.sessionDirOf("/root", "/home/u/app", "session-1"),
    path.join("/root", "--home-u-app--", "session-1"));
  eq("会话目录：无 cwd", sp.sessionDirOf("/root", "", "session-1"),
    path.join("/root", "_no-cwd", "session-1"));

  eq("标题：字符串", sp.titleTextOf("  hello  "), "hello");
  eq("标题：快照对象", sp.titleTextOf({ title: "会话标题" }), "会话标题");
  eq("标题：嵌套快照", sp.titleTextOf({ value: { title: "嵌套" } }), "嵌套");
  eq("标题：无效值", sp.titleTextOf(null) + sp.titleTextOf(42), "");

  const meta = {
    version: 1,
    trashId: "trash-m3f8x-0b9f5c1e",
    id: "session-1",
    deletedAt: 1760000000000,
    title: "标题",
    header: { id: "session-1", cwd: "/home/u/app", createdAt: 1750000000000 },
    originalDir: "/root/--home-u-app--/session-1",
    sizeBytes: 1234,
    workspaceId: "5d0c4b1a-1f7e-4a3b-8894-2c2f8e8a9c11",
    workspaceTitle: "工作区"
  };
  const normalized = sp.normalizeTrashMeta(meta);
  ok("回收站元数据：合法条目通过", normalized && normalized.id === "session-1" && normalized.sizeBytes === 1234);
  ok("回收站元数据：版本不符拒绝", sp.normalizeTrashMeta({ ...meta, version: 2 }) === null);
  ok("回收站元数据：header 不匹配拒绝", sp.normalizeTrashMeta({ ...meta, header: { ...meta.header, id: "session-2" } }) === null);
  ok("回收站元数据：bad id 拒绝", sp.normalizeTrashMeta({ ...meta, id: "../x" }) === null);
  ok("回收站元数据：时间非法拒绝", sp.normalizeTrashMeta({ ...meta, deletedAt: Number.NaN }) === null);
  eq("回收站元数据：超长标题截断", sp.normalizeTrashMeta({ ...meta, title: "x".repeat(400) }).title.length, 300);

  const sorted = sp.sortSessionsNewestFirst([
    { id: "session-a", createdAt: 100 },
    { id: "session-c", createdAt: "2026-01-02T00:00:00.000Z" },
    { id: "session-b", createdAt: 300 }
  ]);
  eq("会话排序：新的在前", sorted.map((row) => row.id), ["session-c", "session-b", "session-a"]);
  const trashSorted = sp.sortTrashNewestFirst([
    { trashId: "trash-a", deletedAt: 1 },
    { trashId: "trash-b", deletedAt: 9 }
  ]);
  eq("回收站排序：删除时间倒序", trashSorted.map((row) => row.trashId), ["trash-b", "trash-a"]);

  eq("附件类型：白名单栅格原样返回", s.attachmentMediaType("image/jpeg", "image"), "image/jpeg");
  eq("附件类型：SVG 降级", s.attachmentMediaType("image/svg+xml", "image"), "image/png");
  eq("附件类型：text/html 降级", s.attachmentMediaType("text/html", "file"), "application/octet-stream");
  eq("附件类型：CRLF 注入降级", s.attachmentMediaType("image/png\r\nX-Evil: 1", "image"), "image/png");
  eq("附件类型：缺失值降级", s.attachmentMediaType(undefined, "file"), "application/octet-stream");
}

// ---------------------------------------------------------------------------
// 43. 0.2.6 真机反馈回归：会话菜单扩展点 + 设置 Tab 合并
// ---------------------------------------------------------------------------
// 真机问题一：上一版把「移动/删除」放在自有列表行，宿主 ⋯ 菜单里看不到。
// 宿主（dsh-client-ui-workspace）用 ctx.contextMenus.register({ target: "session" })
// 注册内置会话项，因此我们也必须注册到同一 target，才能与宿主项同菜单出现。
// 真机问题二：设置左侧导航的「对话管理」独立分区要合并进「消息管家」，
// Tab 顺序为 消息操作 → 对话管理 → 费用统计，且原页面能力不得丢失。

(function verifySessionMenuAndSettingsTabs() {
  const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const clientSrc = fs.readFileSync(path.join(rootDir, "src", "client.js"), "utf8");
  const libClient = fs.readFileSync(path.join(rootDir, "lib", "client.js"), "utf8");
  const managerSrc = fs.readFileSync(path.join(rootDir, "src", "session-manager.mjs"), "utf8");
  const indexSrc = fs.readFileSync(path.join(rootDir, "src", "index.mjs"), "utf8");
  const i18nSrc = fs.readFileSync(path.join(rootDir, "src", "i18n.cjs"), "utf8");
  const localeZh = fs.readFileSync(path.join(rootDir, "locale", "zh.json"), "utf8");
  const localeEn = fs.readFileSync(path.join(rootDir, "locale", "en.json"), "utf8");

  // —— 会话菜单：必须走宿主正规扩展点 ——
  ok("会话菜单：读取宿主 contextMenus 服务", clientSrc.includes('ctx.get("contextMenus")'));
  ok("会话菜单：存在 target session 的注册", /target: "session"/.test(clientSrc));
  ok("会话菜单：注册移动项 id", clientSrc.includes('"dsh-message-actions.move"'));
  ok("会话菜单：注册删除项 id", clientSrc.includes('"dsh-message-actions.delete"'));
  ok("会话菜单：移动项 order 650（归档之后）", /\border:\s*650\b/.test(clientSrc));
  ok("会话菜单：删除项 order 700（菜单末尾）", /\border:\s*700\b/.test(clientSrc));
  ok("会话菜单：宿主无 contextMenus 时退回 DOM 兜底",
    clientSrc.includes("startSidebarMenuAugment()"));
  ok("会话菜单：移动文案绑定 i18n",
    /label: t\("sessions\.actionMove"\)/.test(clientSrc));
  ok("会话菜单：删除项 danger 标红",
    /label: t\("sessions\.actionDelete"\),\n\s+icon: \{ key: MENU_ICON_KEYS\.delete \},\n\s+danger: true/.test(clientSrc));
  ok("会话菜单：移动/删除项带图标 key",
    /label: t\("sessions\.actionMove"\), icon: \{ key: MENU_ICON_KEYS\.move \}/.test(clientSrc)
      && clientSrc.includes("icon: { key: MENU_ICON_KEYS.delete }"));
  ok("会话菜单：图标走宿主 contextMenu.icon 槽且尺寸随宿主",
    clientSrc.includes('ctx.slots.inject("contextMenu.icon"')
      && clientSrc.includes("IconFolderOpenRegular")
      && clientSrc.includes("IconTrashOutlineRegular"));
  ok("会话菜单：移动为二级菜单（children）",
    clientSrc.includes("children") && clientSrc.includes("workspace-\" + workspace.id"));
  ok("会话菜单：当前工作区置灰并标注「当前」",
    clientSrc.includes('t("sessions.currentWorkspace")') && clientSrc.includes("disabled: isCurrent"));
  ok("会话菜单：构建产物包含扩展点注册与图标槽",
    libClient.includes('ctx.get("contextMenus")')
      && libClient.includes('"dsh-message-actions.move"')
      && libClient.includes('"dsh-message-actions.delete"')
      && libClient.includes('contextMenu.icon')
      && libClient.includes("IconFolderOpenRegular"));

  // —— 删除失败修复：只拒运行中；live 会话允许迁移目录 ——
  ok("删除：只拒绝运行中的会话",
    managerSrc.includes('record.running === true || runningSet().has(id)')
      && !managerSrc.includes('failureOf(id, "SESSION_LIVE")'));
  ok("删除：live 写句柄冲突时跳过写声明",
    managerSrc.includes("isOwnershipConflict")
      && managerSrc.includes("SessionAlreadyOwnedError"));
  ok("移动：只拒绝运行中，live 允许移动",
    !managerSrc.includes('error: "SESSION_LIVE"')
      && managerSrc.includes('if ((record && record.running === true) || runningSet().has(sessionId)) {')
      && managerSrc.includes('return { ok: false, error: "SESSION_RUNNING" };'));
  ok("移动：写句柄冲突时跳过写声明并继续迁移",
    (managerSrc.match(/isOwnershipConflict\(err\)/g) || []).length >= 2);
  ok("移动：不再用 sp.create（避免 live 会话 SessionAlreadyExistsError）",
    !managerSrc.includes("sp.create(nextHeader)")
      && managerSrc.includes("async function relocateLog(")
      && managerSrc.includes("LOG_VERIFY_FAILED"));
  ok("移动：原日志迁移只改写首行 header 并保留事件",
    managerSrc.includes("splitLogText") && managerSrc.includes("countEvents")
      && managerSrc.includes("function scanZstdFrames(")
      && managerSrc.includes("const tail = buf.subarray(first.end);")
      && managerSrc.includes("JSON.stringify(nextHeaderObj)")
      && managerSrc.includes("if (tail.length > 0 && !verifyBuf.subarray(verifyBuf.length - tail.length).equals(tail))")
      && managerSrc.includes("moved log lost events"));
  ok("移动：zstd 多帧只重写首帧，不整段解压重压",
    managerSrc.includes("const first = frames[0];")
      && managerSrc.includes("const newFrame0 = await compressZstdBuffer(")
      && managerSrc.includes("const data = Buffer.concat([newFrame0, ...salvageFrames, tail]);")
      && managerSrc.includes("const salvage = firstLines.slice(1)"));
  ok("移动：header 按宿主 v4 白名单重整并补回 type",
    managerSrc.includes("const SESSION_HEADER_KEYS = new Set([")
      && managerSrc.includes("function sanitizeHeader(header)")
      && managerSrc.includes('if (out.type !== "session") out.type = "session";')
      && managerSrc.includes("Object.assign(sanitizeHeader(header), { cwd: nextHeader.cwd })")
      && managerSrc.includes('verifyHeader.type !== "session"'));
  ok("移动：失败路径透出错误码/阶段/路径给客户端",
    managerSrc.includes("detail = {") && managerSrc.includes("stage,")
      && managerSrc.includes("stackLine: firstStackLine(err)")
      && managerSrc.includes('error: errorCodeOf(err) || "MOVE_FAILED"'));
  ok("移动：目标已有同名会话返回 TARGET_EXISTS",
    managerSrc.includes('code: "TARGET_EXISTS"') && managerSrc.includes("target session directory already exists"));
  ok("移动：迁移后重挂工作区索引并刷新宿主索引",
    managerSrc.includes("attached = await attachToWorkspace(sessionId, nextHeader, target.path);")
      && managerSrc.includes("const indexRefreshed = await refreshRegistryIndex();")
      && managerSrc.includes("async function refreshRegistryIndex()")
      && managerSrc.includes("await serviceValue.replaceHeaderIndex(headers);")
      && managerSrc.includes("indexLiveSessions()"));
  ok("移动：sessionPaths 写工作区路径而不是会话目录",
    managerSrc.includes("function attachToWorkspace(sessionId, header, workspacePath)")
      && managerSrc.includes("sessionPaths.set(sessionId, canonical)")
      && managerSrc.includes("if (!ids.includes(sessionId)) {"));
  ok("移动：live 会话重定向 header/meta/cwd 与持久化 states",
    managerSrc.includes("function redirectLiveSession(sessionId, header, workspacePath)")
      && managerSrc.includes("states.get(sessionId)")
      && managerSrc.includes("redirect = redirectLiveSession(sessionId, nextHeader, target.path);"));
  ok("移动：找不到列表记录时回退宿主 stat / readSession，不误报「目标不存在」",
    managerSrc.includes("let records = null;")
      && managerSrc.includes("if (!header) header = await statHeaderOf(sp, sessionId);")
      && managerSrc.includes("const read = await queryService.readSession(sessionId, 0);"));
  ok("移动：目标目录优先走宿主 locate 编码",
    managerSrc.includes("const locatedTargetPath = locateLogPath(sp, nextHeader);")
      && managerSrc.includes("if (targetDir === \"\" || !insideRoot(root, targetDir))")
      && managerSrc.includes("function locateLogPath(sp, header)"));
  ok("移动：源目录缺失时按目录名扫描磁盘兜底",
    managerSrc.includes("function findSessionDirOnDisk(root, sessionId)")
      && managerSrc.includes("const scanned = findSessionDirOnDisk(root, sessionId);")
      && managerSrc.includes("if (scanned !== \"\") sourceDir = scanned;")
      && managerSrc.includes("normalizePathKey(header.cwd) === canonical && isDirectory(locatedDir(sp, header, root))"));

  // —— 口令：只有批量删除 / 批量彻底清理 / 清空回收站要求输入 OK ——
  ok("口令：客户端确认码为 OK 且不再出现 PURGE_ALL",
    clientSrc.includes('SESSIONS_CONFIRM_CODE = "OK"')
      && !clientSrc.includes("PURGE_ALL")
      && clientSrc.includes("function sessionConfirmMatches"));
  ok("口令：单条删除免确认，批量删除/批量清理/清空才要求 OK",
    (clientSrc.match(/confirm: SESSIONS_CONFIRM_CODE/g) || []).length === 2
      && clientSrc.includes("body.confirm = SESSIONS_CONFIRM_CODE")
      && (clientSrc.match(/confirmField\("sessions\.confirmPrompt"\)/g) || []).length === 2
      && (clientSrc.match(/confirmField\("sessions\.purgeCodePrompt"\)/g) || []).length === 1
      && clientSrc.includes("单条删除只进回收站，可恢复；不再输入 OK")
      && clientSrc.includes("单条删除只进回收站（可恢复），无需输入 OK")
      && clientSrc.includes("if (bulk) body.confirm = SESSIONS_CONFIRM_CODE"));
  ok("口令：输入去首尾空格且大小写不敏感",
    /trim\(\)\.toUpperCase\(\) === SESSIONS_CONFIRM_CODE/.test(clientSrc));
  ok("口令：中英文案同步为输入 OK",
    i18nSrc.includes("'sessions.confirmPrompt': '输入 OK 确认删除'")
      && i18nSrc.includes("'sessions.confirmPrompt': 'Type OK to confirm deletion'")
      && i18nSrc.includes("'sessions.purgeCodePrompt': '输入 OK 确认清空'")
      && !i18nSrc.includes("PURGE_ALL"));
  ok("口令：服务端仅批量操作校验 OK",
    indexSrc.includes('const SESSION_CONFIRM_CODE = "OK"')
      && indexSrc.includes("function isSessionConfirm(value)")
      && indexSrc.includes("if (ids.length > 1 && !isSessionConfirm(body.confirm))")
      && indexSrc.includes("if (body.all === true)")
      && !indexSrc.includes("PURGE_ALL"));

  // —— 删除后从工作区索引与列表移除（含 live 内存残留） ——
  const removeFnStart = managerSrc.indexOf("async function removeToTrash");
  const restoreFnStart = managerSrc.indexOf("async function restore");
  const removeFn = managerSrc.slice(removeFnStart, restoreFnStart);
  ok("删除：软回收站只写索引，日志留在原工作区",
    removeFn.includes("await removeTombstone(id)")
      && !removeFn.includes("moveDirectory(")
      && !removeFn.includes("detachFromWorkspaces")
      && removeFn.includes("soft: true")
      && removeFn.includes("restartRequired: false"));
  ok("删除：列表按回收站 id / 墓碑过滤，杜绝「未分组」残留",
    managerSrc.includes("const trashedIds = new Set(trashEntries.map((entry) => entry.id))")
      && managerSrc.includes("if (trashedIds.has(id) || purgedSet.has(id)) continue;")
      && managerSrc.includes("activePurgedIds(sp, root)")
      && managerSrc.includes('const TOMBSTONE_FILE = "purged.json"')
      && managerSrc.indexOf("readTrashEntries()") < managerSrc.indexOf("const rows = [];"));
  ok("删除：live 会话目录已移走时直接按物理日志过滤",
    managerSrc.includes('record.live === true && findLogFile(locatedDir(sp, header, root)) === ""'));
  ok("恢复：软条目删索引即可见；旧物理条目仍能移回并挂索引",
    managerSrc.includes("if (soft) {")
      && managerSrc.includes("restartRequired: false")
      && managerSrc.includes("const attached = await attachToWorkspace(meta.id, meta.header, meta.header.cwd);")
      && managerSrc.includes("if (attached) await refreshRegistryIndex();"));
  ok("恢复：日志缺失/归属不符时不误恢复",
    managerSrc.includes("logBelongsTo(targetDir, meta.id)")
      && managerSrc.includes('"TRASH_LOG_MISSING"'));

  // —— 回收站批量操作 ——
  ok("回收站：批量恢复 / 批量彻底清理 / 全选与清空",
    clientSrc.includes("const [selectedTrash, setSelectedTrash]")
      && clientSrc.includes("function selectAllTrash()")
      && clientSrc.includes("function clearTrashSelection()")
      && clientSrc.includes("trashRestoreSelected")
      && clientSrc.includes("trashPurgeSelected")
      && clientSrc.includes('setDialog({ kind: "bulkPurge"'));
  ok("回收站：部分失败保持选中、已成功项不回滚",
    clientSrc.includes("setSelectedTrash(failedResults.map((item) => item.trashId))")
      && clientSrc.includes("dropTrashLocally(okResults.map((item) => item.trashId))")
      && clientSrc.includes("markSidebarPurged(okResults.map((item) => item.sessionId)"));
  ok("侧边栏：回收站行样式级隐藏与当场恢复（无需重启）",
    clientSrc.includes('const SIDEBAR_HIDDEN_ATTR = "data-dma-hidden"')
      && clientSrc.includes("function markSidebarTrash(ids)")
      && clientSrc.includes("function unmarkSidebarTrash(ids)")
      && clientSrc.includes("function paintSidebarHiddenRows()")
      && clientSrc.includes("/dsh-message-actions/sessions?hidden=1"));
  ok("服务端：hidden 快照只返回 id 列表，不枚举会话",
    indexSrc.includes('hiddenOnly = query.get("hidden") === "1"')
      && managerSrc.includes("if (hiddenOnly)")
      && managerSrc.includes("trashedIds: trashEntries.map((entry) => entry.id)"));

  // —— 前端：删除后立即移除 + 缓存失效 + 旧请求不覆盖新快照 ——
  ok("前端：删除成功后本地立刻移除条目",
    clientSrc.includes("const dropRowsLocally = React.useCallback")
      && clientSrc.includes("dropRowsLocally(okResults.map((item) => item.id))")
      && clientSrc.includes("dropRowsLocally([row.id])"));
  ok("前端：会话列表失效信号驱动重新拉取",
    clientSrc.includes("const sessionsStore = createStore({ revision: 0 })")
      && clientSrc.includes("function bumpSessionsRevision()")
      && clientSrc.includes("sessionsStore.subscribe(() => {")
      && clientSrc.includes("if (ok) bumpSessionsRevision();"));
  ok("前端：旧请求结果不会覆盖删除后的新快照",
    clientSrc.includes("const loadSeq = React.useRef(0)")
      && clientSrc.includes("seq !== loadSeq.current"));

  // —— Enter 直接确认 ——
  ok("Enter：设置页确认框 onKeyDown 提交且排除输入法组词",
    clientSrc.includes("onKeyDown: (ev) => {")
      && clientSrc.includes('if (ev.key !== "Enter" || ev.shiftKey) return;')
      && clientSrc.includes("native.isComposing === true || ev.keyCode === 229")
      && clientSrc.includes('tt("sessions.purgeCodeWrong")'));
  ok("Enter：输入不匹配时不提交并给出既有错误提示",
    /if \(!sessionConfirmMatches\(purgeCode\)\) \{\s*setNotice\(\{ ok: false, text: tt\("sessions\.purgeCodeWrong"\) \}\);\s*return;\s*\}\s*if \(canConfirm && typeof onConfirm === "function"\) onConfirm\(\);/.test(clientSrc));
  ok("Enter：侧边栏单条删除使用轻量确认，不再输入口令",
    !clientSrc.includes('requireConfirm: true')
      && clientSrc.includes("function openSidebarDialog(options)")
      && clientSrc.includes("ok.focus()"));
  ok("确认框自动聚焦并全选输入（需要口令时）",
    clientSrc.includes("autoFocus: true")
      && clientSrc.includes("ev.target.select()")
      && clientSrc.includes("autoFocus: !needsCode"));

  // —— 文案：对话管理 → 会话管理（中英 + locale + Tab） ——
  ok("文案：中文 Tab/标题统一为「会话管理」",
    i18nSrc.includes("'cost.tab.sessions': '会话管理'")
      && i18nSrc.includes("'sessions.title': '会话管理'")
      && i18nSrc.includes("'sessions.settingsTitle': '会话管理'")
      && !i18nSrc.includes("对话管理"));
  ok("文案：英文同步为 Session manager",
    i18nSrc.includes("'cost.tab.sessions': 'Session manager'"));
  ok("locale/zh.json：生成「会话管理」且不再有「对话管理」",
    localeZh.includes("会话管理") && !localeZh.includes("对话管理"));
  ok("locale/en.json：meta 同步为 session management", localeEn.includes("session management"));

  // —— 状态筛选：活跃 = 未归档；已归档可单独查看；计数与总数一致 ——
  ok("状态筛选：已归档可单独筛选",
    clientSrc.includes('status === "archived" && row.archived !== true')
      && clientSrc.includes('value: "archived"'));
  ok("状态筛选：活跃 = 未归档，计数使用 active/archived",
    clientSrc.includes('status === "active" && row.archived === true')
      && clientSrc.includes("totals.active") && clientSrc.includes("totals.archived"));

  // —— 多选与批量操作 ——
  ok("多选：每行复选框", clientSrc.includes('type: "checkbox"'));
  ok("多选：全选 / 清空选择",
    clientSrc.includes("function selectAllFiltered") && clientSrc.includes("function clearSelected"));
  ok("多选：多选模式下隐藏单项菜单",
    clientSrc.includes('multiSelect ? null : e("button"')
      && clientSrc.includes("if (!menu || !menu.row || multiSelect) return null;"));
  ok("批量：删除 / 移动 / 归档入口",
    clientSrc.includes('runBulk("delete"') && clientSrc.includes('runBulk("move"') && clientSrc.includes('runBulk("archive"'));
  ok("批量：结果汇总（成功/失败条数及原因）",
    clientSrc.includes("sessions.bulkResult") && clientSrc.includes("sessions.bulkMoreFailed"));
  ok("批量接口：moveBatch 参数校验",
    indexSrc.includes('body.action === "moveBatch"')
      && indexSrc.includes('readIdList(body, "sessionIds")')
      && indexSrc.includes("sessionsPure.isWorkspaceId(body.workspaceId)"));
  ok("批量接口：archive 参数校验", indexSrc.includes('body.action === "archive"'));
  ok("批量实现：moveMany 逐条独立、部分失败不回滚",
    managerSrc.includes("async function moveMany(ids, workspaceId)")
      && managerSrc.includes("results.push(failureOf(id"));
  ok("批量实现：archive 逐条独立",
    managerSrc.includes("async function archive(ids)")
      && managerSrc.includes("serviceValue.archiveSession(id)"));

  // —— 设置：只保留「消息管家」一个分区 ——
  ok("设置导航：没有独立「会话管理」分区", !clientSrc.includes("dsh-message-actions-sessions"));
  eq("设置导航：只注册一个 settings.section",
    (clientSrc.match(/name: "settings\.section"/g) || []).length, 1);

  // —— 设置 Tab 顺序：消息操作 → 会话管理 → 费用统计 ——
  const tabActions = libClient.indexOf('tabButton("actions", "cost.tab.actions")');
  const tabSessions = libClient.indexOf('tabButton("sessions", "cost.tab.sessions")');
  const tabBilling = libClient.indexOf('tabButton("billing", "cost.tab.billing")');
  ok("设置 Tab：三项都存在",
    tabActions !== -1 && tabSessions !== -1 && tabBilling !== -1);
  ok("设置 Tab：顺序为 消息操作 → 会话管理 → 费用统计",
    tabActions < tabSessions && tabSessions < tabBilling);
  ok("会话管理：作为 Tab 渲染而非独立页面",
    libClient.includes("e(SessionsPage, { t: tt })"));

  // —— 能力不因挪位置而丢失 ——
  const abilityMarkers = [
    "function runDelete",
    "function runMove",
    "function runRestore",
    "function runPurge",
    "function runPurgeAll",
    "SESSIONS_CONFIRM_CODE",
    "sessions.searchPlaceholder",
    "sessions.filterWorkspace",
    "sessions.statusArchived",
    "sessions.sortUpdated"
  ];
  const missingAbilities = abilityMarkers.filter((marker) => !clientSrc.includes(marker));
  eq("会话管理 Tab：分组/搜索/筛选/排序/回收站/移动/删除/口令清空齐备",
    missingAbilities.join(","), "");
})();

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