// dsh-message-actions 构建脚本
//
// 产出（lib/ 目录）：
//   - lib/index.js   宿主 ESM（由 src/index.mjs 原样复制）
//   - lib/shared.cjs 共享纯函数（原样复制，供宿主 require）
//   - lib/store.cjs  费用状态文件读写（原样复制，供宿主 require）
//   - lib/client.js  客户端浏览器模块（将 shared.cjs 内联 + 注入构建时间戳）
//
// 运行：node build.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const lib = join(root, "lib");
const read = (rel) => readFileSync(join(root, rel), "utf8");

mkdirSync(lib, { recursive: true });

// 共享纯函数源码：在客户端里以 IIFE 形式内联，避免客户端 require 受限。
const sharedSource = read("src/shared.cjs");
const sharedIife = `(function () {\nconst module = { exports: {} };\nconst exports = module.exports;\n${sharedSource}\nreturn module.exports;\n})()`;

// 客户端：内联 shared + 注入构建时间戳。
const client = read("src/client.js")
  .replace("/*__DMA_SHARED__*/", sharedIife)
  .replaceAll("__DMA_BUILD_TIME__", new Date().toISOString());

writeFileSync(join(lib, "index.js"), read("src/index.mjs"));
writeFileSync(join(lib, "shared.cjs"), sharedSource);
writeFileSync(join(lib, "store.cjs"), read("src/store.cjs"));
writeFileSync(join(lib, "client.js"), client);

console.log("build ok");
console.log("  lib/index.js   (host ESM)");
console.log("  lib/shared.cjs (shared pure functions)");
console.log("  lib/store.cjs  (host cost state store)");
console.log("  lib/client.js  (browser client, shared inlined)");