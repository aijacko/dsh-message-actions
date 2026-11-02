// dsh-message-actions 离线测试
//
// 只依赖共享纯函数（src/shared.cjs），无需 DSH 运行时即可运行：
//   node test/check.mjs
//
// 覆盖《开发需求与重写提示词.md》§7「离线测试必须覆盖」的全部行为。

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const s = require("../src/shared.cjs");
const store = require("../src/store.cjs");

const {
  planAction,
  roundsOf,
  goneTurnsOf,
  markdownOf,
  exportFilename,
  railTurnOf,
  collapseRail,
  isTombstone,
  textOf,
  wordCount,
  previewText,
  formatTokens,
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
    const tooLarge = store.loadCostState(file, undefined, 32);
    eq("超大状态文件不解析", tooLarge.state.baselineBalanceCents, null);
    eq("超大状态文件不算损坏", tooLarge.recovered, false);
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
// 汇总
// ---------------------------------------------------------------------------

console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nFAILED");
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");