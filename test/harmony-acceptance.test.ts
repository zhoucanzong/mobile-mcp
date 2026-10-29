import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../src/server";
import { acceptanceCategories, acceptancePlanSchema, runAcceptance } from "../src/harmony-acceptance";

function fixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-acceptance-test-"));
	const calls: string[] = [];
	const plan = {
		version: 1, name: "Test acceptance", fixture: "Mock fixture; not a real device",
		cases: acceptanceCategories.map(category => ({ id: category, category, description: category, steps: category === "recovery" ? [
			{ tool: "mobile_assert_condition", arguments: {}, expectError: "Assertion failed" }, { tool: "mobile_get_screen_size" },
		] : [{ tool: "mobile_get_screen_size" }] })),
		manualChecks: [{ id: "permission", description: "Check actual phone authorization" }],
	};
	const client = {
		listTools: async () => ({ tools: ["mobile_assert_condition", "mobile_get_screen_size"].map(name => ({ name, inputSchema: { type: "object" } })) }),
		callTool: async ({ name }: { name: string }) => {
			calls.push(name);
			return name === "mobile_get_harmony_capabilities" ? { content: [{ type: "text", text: JSON.stringify({ connection: { state: "available" } }) }] }
				: name === "mobile_assert_condition" ? { isError: true, content: [{ type: "text", text: "Assertion failed: expected failure" }] }
					: { content: [{ type: "text", text: "Screen size is 100x200" }] };
		},
	};
	return { directory, calls, client, plan, cleanup: () => fs.rmSync(directory, { recursive: true }) };
}

test("plan-only mode never touches a device and does not mark cases passed", async () => {
	const f = fixture();
	try {
		const report = await runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, false);
		expect(f.calls).toEqual([]); expect(report.status).toBe("not_run");
		expect(report.cases.every(c => c.status === "not_run")).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(f.directory, "report.json"), "utf8")).mode).toBe("plan");
	} finally { f.cleanup(); }
});

test("successful automatic cases retain pending manual checks", async () => {
	const f = fixture();
	try {
		const report = await runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, true);
		expect(report.status).toBe("needs_manual");
		expect(report.cases.every(c => c.status === "passed")).toBe(true);
		expect(report.cases.at(-1)?.steps.map(s => s.status)).toEqual(["expected_error", "passed"]);
		expect(fs.readFileSync(path.join(f.directory, "report.md"), "utf8")).toContain("pending manual checks");
	} finally { f.cleanup(); }
});

test("unexpected failure stops later cases and preserves a partial report", async () => {
	const f = fixture();
	const original = f.client.callTool;
	f.client.callTool = async request => request.name === "mobile_get_screen_size" ? { isError: true, content: [{ type: "text", text: "disconnected" }] } : original(request);
	try {
		const report = await runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, true);
		expect(report.status).toBe("failed"); expect(report.cases[0].status).toBe("failed");
		expect(report.cases.slice(1).every(c => c.status === "not_run")).toBe(true);
		expect(fs.readFileSync(path.join(f.directory, "report.json"), "utf8")).toContain("disconnected");
	} finally { f.cleanup(); }
});

test("an expected-error step must fail for the specified reason", async () => {
	const f = fixture();
	const original = f.client.callTool;
	f.client.callTool = async request => request.name === "mobile_assert_condition" ? { isError: true, content: [{ type: "text", text: "permission denied" }] } : original(request);
	try {
		const report = await runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, true);
		expect(report.status).toBe("failed");
		expect(report.cases.at(-1)?.steps).toHaveLength(1);
	} finally { f.cleanup(); }
});

test("requires all categories and meaningful failure recovery", () => {
	const f = fixture();
	try {
		expect(acceptancePlanSchema.safeParse({ ...f.plan, cases: f.plan.cases.slice(1) }).success).toBe(false);
		const cases = f.plan.cases.map(c => c.category === "recovery" ? { ...c, steps: [c.steps[0]] } : c);
		expect(acceptancePlanSchema.safeParse({ ...f.plan, cases }).success).toBe(false);
	} finally { f.cleanup(); }
});

test("preflights every case before any device call and rejects device overrides", async () => {
	const f = fixture();
	try {
		f.plan.cases[4].steps.push({ tool: "mobile_run_workflow" });
		await expect(runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, true)).rejects.toThrow("not allowed");
		expect(f.calls).toEqual([]);
		f.plan.cases[4].steps.pop();
		(f.plan.cases[0].steps[0] as any).arguments = { device: "harmony:OTHER" };
		await expect(runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, true)).rejects.toThrow("override");
		expect(f.calls).toEqual([]);
	} finally { f.cleanup(); }
});

test("disconnected self-check prevents test actions", async () => {
	const f = fixture();
	f.client.callTool = async ({ name }) => { f.calls.push(name); return { content: [{ type: "text", text: '{"connection":{"state":"unknown"}}' }] }; };
	try {
		const report = await runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, true);
		expect(report.status).toBe("failed"); expect(f.calls).toEqual(["mobile_get_harmony_capabilities"]);
	} finally { f.cleanup(); }
});

test("shipped template validates against the actual MCP schemas without a phone", async () => {
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
	const server = createMcpServer(), client = new Client({ name: "acceptance-plan-test", version: "1" });
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(b); await client.connect(a);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-plan-schema-"));
	try {
		const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "../acceptance/harmony.template.json"), "utf8"));
		const result = await runAcceptance(client, "harmony:UNCONNECTED", plan, directory, false);
		expect(result.cases).toHaveLength(7); expect(result.status).toBe("not_run");
	} finally { await client.close(); await server.close(); fs.rmSync(directory, { recursive: true }); }
});

test("an abort request leaves later cases unexecuted", async () => {
	const f = fixture(); const controller = new AbortController(); const original = f.client.callTool;
	f.client.callTool = async request => { const result = await original(request); if (request.name === "mobile_get_screen_size") { controller.abort(); } return result; };
	try {
		const report = await runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, true, controller.signal);
		expect(report.status).toBe("failed"); expect(report.error).toContain("interrupted");
		expect(report.cases.slice(1).every(c => c.status === "not_run")).toBe(true);
	} finally { f.cleanup(); }
});

test("saves actual screenshot artifacts and rejects mismatched MIME", async () => {
	const sharp = (await import("sharp")).default;
	const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: "white" } }).png().toBuffer();
	for (const mimeType of ["image/png", "image/jpeg"]) {
		const f = fixture(); const original = f.client.callTool;
		const listTools = f.client.listTools;
		f.client.listTools = async () => ({ tools: [...(await listTools()).tools, { name: "mobile_take_screenshot", inputSchema: { type: "object" } }] });
		(f.plan.cases[0].steps as any[]).push({ tool: "mobile_take_screenshot" });
		f.client.callTool = async request => request.name === "mobile_take_screenshot" ? { content: [{ type: "image", data: bytes.toString("base64"), mimeType }] } as any : original(request);
		try {
			const report = await runAcceptance(f.client, "harmony:TEST", f.plan, f.directory, true);
			if (mimeType === "image/png") {
				expect(report.status).toBe("needs_manual");
				const artifact = report.cases[0].steps[1].artifacts[0];
				expect(fs.readFileSync(path.join(f.directory, artifact))).toEqual(bytes);
			} else { expect(report.status).toBe("failed"); expect(report.cases[0].steps[1].text).toContain("MIME type"); }
		} finally { f.cleanup(); }
	}
});
