// Build first. With --check, verify that the reviewed notes still cover every MCP parameter.
const fs = require("node:fs");
const path = require("node:path");
process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
const { createMcpServer } = require("../lib/server");
const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");
const root = path.resolve(__dirname, "..");
const notes = require("../docs/platform-audit-notes.json");
const escape = text => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
function constraint(schema, required) {
 const value = { required, ...Object.fromEntries(Object.entries(schema).filter(([key]) => ["type", "enum", "const", "default", "minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength", "minItems", "maxItems", "pattern"].includes(key))) };
 if(schema.anyOf || schema.oneOf) value.variants=(schema.anyOf||schema.oneOf).map(s=>s.type||s.const||"object");
 return '`'+escape(JSON.stringify(value))+'`';
}
(async () => {
 const server=createMcpServer(), client=new Client({name:"platform-parameter-audit",version:"1"});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 try {
  const {tools}=await client.listTools();
  const lines=["# 平台逐工具、逐参数对照", "", "此表对照当前仓库源码，不代表 iOS、Android 或商业鸿蒙的所有系统版本已实测。由实际 MCP schema 与人工审阅的后端说明生成；更新命令：`npm run build && npm run audit:platforms`。", "", "默认 iOS/Android 路径是 `MobileDevice → mobilecli`，因此下文的“转交”只证明本仓库传参，外部 CLI 的平台支持不在这里冒充验证。`MOBILEMCP_LEGACY_ROBOT=1` 的真机路径另使用 `IosRobot` / `AndroidRobot`；iOS 模拟器仍走 MobileDevice。HarmonyOS 在该开关之前分流至 HDC。", "", "证据入口：[路由与工具校验](../src/server.ts)、[默认 iOS/Android 包装器](../src/mobile-device.ts)、[旧 iOS](../src/ios.ts)、[旧 Android](../src/android.ts)、[鸿蒙](../src/harmony.ts)。", "", "每个 device 参数：iOS/Android 使用发现所得 ID，鸿蒙使用 harmony: 前缀 ID；不会把鸿蒙 ID 送入 adb。主机文件路径遵守公共路径校验。所有数值边界以本表 schema 和对应后端额外限制共同决定。", "", `当前覆盖 ${tools.length} 个 mobile 工具。遥测反馈 get_more_tools 不属于设备操作，仍按原有开关提供。`, "", "## 工具与后端", "", "| 工具 | iOS / Android | HarmonyOS | 代码依据 |", "|---|---|---|---|"];
  const known=new Set(tools.map(t=>t.name));
  for(const name of Object.keys(notes))if(!known.has(name))throw Error(`Stale audit tool: ${name}`);
  for(const tool of tools){
   const note=notes[tool.name];if(!note)throw Error(`Unreviewed tool: ${tool.name}`);
   const params=Object.keys(tool.inputSchema.properties||{});
   if(JSON.stringify([...params].sort())!==JSON.stringify(Object.keys(note.parameters).sort()))throw Error(`Unreviewed/stale parameters: ${tool.name}`);
   const sources=note.sources.map(s=>`[${s}](../${s})`).join("、");
   lines.push(`| [${tool.name}](#${tool.name}) | ${escape(note.iosAndroid)} | ${escape(note.harmony)} | ${sources} |`);
  }
  lines.push("", "## 参数逐项核查", "", "嵌套参数的共同语义见本表末尾；arguments 使用目标工具本节的参数，不能据此绕过后端限制。", "");
  for(const tool of tools){
   lines.push(`### ${tool.name}`,"","| 参数 | 公共 schema 约束 | 平台处理与差异 |","|---|---|---|");
   const note=notes[tool.name];
   for(const [name,schema] of Object.entries(tool.inputSchema.properties||{}))lines.push(`| ${name} | ${constraint(schema,(tool.inputSchema.required||[]).includes(name))} | ${escape(note.parameters[name])} |`);
   if(!Object.keys(tool.inputSchema.properties||{}).length)lines.push("| 无 | — | 无调用参数；后端差异见上表 |");
   lines.push("");
  }
  lines.push("## 嵌套参数与运行语义", "", fs.readFileSync(path.join(root,"docs/platform-nested-parameters.md"),"utf8").trim(), "");
  const output=lines.join("\n");const target=path.join(root,"docs/platform-parity.md");
  if(process.argv.includes("--check")){if(!fs.existsSync(target)||fs.readFileSync(target,"utf8")!==output)throw Error("Platform matrix is out of date; review notes and regenerate");}
  else fs.writeFileSync(target,output);
  console.log(`Platform matrix: ${tools.length} tools; ${Object.values(notes).reduce((n,x)=>n+Object.keys(x.parameters).length,0)} top-level parameters reviewed`);
 }finally{await client.close();await server.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
