// dsh-message-actions 构建脚本
//
// 产出（lib/ 目录）：
//   - lib/index.js   宿主 ESM（由 src/index.mjs 原样复制）
//   - lib/shared.cjs 共享纯函数（原样复制，供宿主 require）
//   - lib/store.cjs  费用状态文件读写（原样复制，供宿主 require）
//   - lib/http.cjs   HTTP 工具（原样复制，供宿主 require）
//   - lib/client.js  客户端浏览器模块（将 shared.cjs / i18n.cjs 内联 + 注入构建时间戳）
// 同时由 src/i18n.cjs 的 meta 生成 locale/zh.json 与 locale/en.json。
//
// 运行：node build.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const lib = join(root, "lib");
const locale = join(root, "locale");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const require = createRequire(import.meta.url);

mkdirSync(lib, { recursive: true });
mkdirSync(locale, { recursive: true });

// CJS 源码：在客户端里以 IIFE 形式内联，避免客户端 require 受限。
function inlineCjs(rel) {
  const source = read(rel);
  return `(function () {\nconst module = { exports: {} };\nconst exports = module.exports;\n${source}\nreturn module.exports;\n})()`;
}

const sharedSource = read("src/shared.cjs");
const sharedIife = inlineCjs("src/shared.cjs");
const i18nSource = read("src/i18n.cjs");
const i18nIife = inlineCjs("src/i18n.cjs");
const pkg = JSON.parse(read("package.json"));
const version = String(pkg.version || "").trim();
if (version === "") throw new Error("build failed: package.json version is empty");

// 客户端：内联 shared + i18n + 注入构建时间戳与版本号。
// 用函数式替换：shared 源码里可能出现 `$&` 等替换模式字符，
// 直接传字符串会被 String.replace 当成特殊指令（`$&` 会回填占位符本身）。
const client = read("src/client.js")
  .replace("/*__DMA_SHARED__*/ null", () => sharedIife)
  .replace("/*__DMA_I18N__*/ null", () => i18nIife)
  .replaceAll("__DMA_BUILD_TIME__", new Date().toISOString())
  .replaceAll("__DMA_VERSION__", version);

writeFileSync(join(lib, "index.js"), read("src/index.mjs"));
writeFileSync(join(lib, "shared.cjs"), sharedSource);
writeFileSync(join(lib, "store.cjs"), read("src/store.cjs"));
writeFileSync(join(lib, "http.cjs"), read("src/http.cjs"));
writeFileSync(join(lib, "client.js"), client);

// locale 文件只携带 meta（标题 / 描述），客户端 UI 文案由 i18n.cjs 内联。
const i18n = require("./src/i18n.cjs");
for (const lang of ["zh", "en"]) {
  writeFileSync(
    join(locale, lang + ".json"),
    JSON.stringify({ meta: i18n.meta[lang] }, null, 2) + "\n"
  );
}

// 构建后断言：占位符必须全部消失，否则客户端会在运行时报语法错误。
for (const marker of ["/*__DMA_SHARED__*/ null", "/*__DMA_I18N__*/ null", "__DMA_BUILD_TIME__", "__DMA_VERSION__"]) {
  if (client.includes(marker)) {
    throw new Error("build failed: placeholder not replaced: " + marker);
  }
}

// 版本号必须与 package.json 一致（设置页直接显示这个常量）。
if (!client.includes(`const VERSION = "${version}";`)) {
  throw new Error("build failed: client version does not match package.json");
}
const writtenClient = readFileSync(join(lib, "client.js"), "utf8");
if (!writtenClient.includes(`const VERSION = "${version}";`)) {
  throw new Error("build failed: lib/client.js version does not match package.json");
}
if (!readFileSync(join(lib, "index.js"), "utf8").startsWith(read("src/index.mjs").slice(0, 200))) {
  throw new Error("build failed: lib/index.js does not match src/index.mjs");
}

console.log("build ok (version " + version + ")");
console.log("  lib/index.js   (host ESM)");
console.log("  lib/shared.cjs (shared pure functions)");
console.log("  lib/store.cjs  (host cost state store)");
console.log("  lib/http.cjs   (host HTTP helpers)");
console.log("  lib/client.js  (browser client, shared + i18n inlined)");
console.log("  locale/*.json  (generated from src/i18n.cjs meta)");
