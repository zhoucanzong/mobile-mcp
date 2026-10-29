import { expect, test } from "@playwright/test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import fs from "node:fs";
import { createMcpServer } from "../src/server";
import { HarmonyRobot } from "../src/harmony";
import { ScreenElement } from "../src/robot";

const next: ScreenElement = { type: "Button", text: "下一步", ref: "@h1e1", enabled: true, rect: { x: 10, y: 20, width: 40, height: 50 } };
async function connection() {
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
	const robot = new HarmonyRobot("harmony:TEST");
	robot.getElementsOnScreen = async () => [next];
	robot.getScreenshot = async () => { throw new Error("screenshot unavailable"); };
	robot.getLogs = async () => { throw new Error("logs unavailable"); };
	const server = createMcpServer({ robotCache: new Map([["harmony:TEST", robot]]) });
	const client = new Client({ name: "automation-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport); await client.connect(clientTransport);
	return {
		robot, client,
		call: async (name: string, args: Record<string, unknown> = {}): Promise<any> => client.callTool({ name, arguments: { device: "harmony:TEST", captureOnFailure: false, ...args } }),
		close: async () => { await client.close(); await server.close(); },
	};
}

test("MCP registers all six tools with usable schemas and applies gesture defaults", async () => {
	const c = await connection();
	const gestures: unknown[] = [];
	c.robot.performGestures = async steps => { gestures.push(steps); };
	try {
		const tools = await c.client.listTools();
		for (const name of ["mobile_drag_on_screen", "mobile_pinch_on_screen", "mobile_perform_gestures", "mobile_wait_for_condition", "mobile_assert_condition", "mobile_run_workflow"]) {
			expect(tools.tools.some(t => t.name === name)).toBe(true);
		}
		expect((await c.call("mobile_drag_on_screen", { from: { x: 10, y: 10 }, to: { x: 100, y: 100 } })).isError).not.toBe(true);
		expect((await c.call("mobile_pinch_on_screen", { center: { x: 500, y: 500 }, startDistance: 100, endDistance: 300 })).isError).not.toBe(true);
		expect((await c.call("mobile_perform_gestures", { gestures: [{ kind: "tap", point: { x: 1, y: 2 } }, { kind: "pause", durationMs: 1 }] })).isError).not.toBe(true);
		expect(gestures[0]).toEqual([{ kind: "drag", from: { x: 10, y: 10 }, to: { x: 100, y: 100 }, pressMs: 500, durationMs: 1000 }]);
	} finally { await c.close(); }
});

test("MCP wait returns a fresh Chinese match and assertion mismatch is an error", async () => {
	const c = await connection();
	try {
		const result = await c.call("mobile_wait_for_condition", { condition: { kind: "element", selector: { text: "下一步" } } });
		expect(JSON.parse(result.content[0].text).elements[0].ref).toBe("@h1e1");
		const failed = await c.call("mobile_assert_condition", { condition: { kind: "element", selector: { text: "不存在" } } });
		expect(failed.isError).toBe(true);
		expect(failed.content[0].text).toContain("Assertion failed");
	} finally { await c.close(); }
});

test("MCP workflow executes nested Chinese target, postcondition and loop with defaults", async () => {
	const c = await connection();
	const calls: string[] = [];
	c.robot.tapByRef = async ref => { calls.push(ref); };
	c.robot.sendKeys = async text => { calls.push(text); };
	const condition = { kind: "element", selector: { text: "下一步" } };
	try {
		const result = await c.call("mobile_run_workflow", { steps: [
			{ kind: "if", condition, then: [
				{ kind: "call", name: "mobile_click_on_screen_at_coordinates", target: { text: "下一步" }, expect: condition },
				{ kind: "repeat", maxIterations: 2, steps: [{ kind: "call", name: "mobile_type_keys", arguments: { text: "测试" } }] },
			] },
		] });
		expect(result.isError, result.content[0].text).not.toBe(true);
		expect(JSON.parse(result.content[0].text).success).toBe(true);
		expect(calls).toEqual(["@h1e1", "测试", "测试"]);
	} finally { await c.close(); }
});

test("MCP failure includes private diagnostic paths without hiding the failed step", async () => {
	const c = await connection();
	let directory: string | undefined;
	c.robot.sendKeys = async () => { throw new Error("text input denied"); };
	try {
		const result = await c.call("mobile_run_workflow", { captureOnFailure: true, steps: [{ kind: "call", name: "mobile_type_keys", arguments: { text: "中文" } }] });
		expect(result.isError).toBe(true);
		const text = result.content[0].text;
		const report = JSON.parse(text.slice(0, text.lastIndexOf(". Please fix")));
		directory = report.evidence.directory;
		expect(JSON.parse(report.error).failedStep).toBe("1");
		expect(report.evidence.errors.join(" ")).toContain("logs unavailable");
		expect(fs.readFileSync(report.evidence.report, "utf8")).toContain("text input denied");
	} finally { if (directory) { fs.rmSync(directory, { recursive: true }); } await c.close(); }
});

test("workflow preflight rejects inconsistent drag timing before earlier actions", async () => {
	const c = await connection();
	let calls = 0;
	c.robot.sendKeys = async () => { calls++; };
	try {
		const result = await c.call("mobile_run_workflow", { steps: [
			{ kind: "call", name: "mobile_type_keys", arguments: { text: "must not run" } },
			{ kind: "call", name: "mobile_drag_on_screen", arguments: { from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, pressMs: 900, durationMs: 1000 } },
		] });
		expect(result.isError).toBe(true);
		expect(calls).toBe(0);
	} finally { await c.close(); }
});

test("MCP rejects nesting beyond three control levels before execution", async () => {
	const c = await connection();
	let calls = 0;
	c.robot.sendKeys = async () => { calls++; };
	try {
		let step: any = { kind: "call", name: "mobile_type_keys", arguments: { text: "hi" } };
		for (let i = 0; i < 4; i++) { step = { kind: "repeat", maxIterations: 1, steps: [step] }; }
		const result = await c.call("mobile_run_workflow", { steps: [step] });
		expect(result.isError).toBe(true);
		expect(calls).toBe(0);
	} finally { await c.close(); }
});

test("workflow rejects incomplete tap and swipe coordinates before earlier actions", async () => {
	const c = await connection();
	let calls = 0;
	c.robot.sendKeys = async () => { calls++; };
	try {
		for (const invalid of [
			{ kind: "call", name: "mobile_click_on_screen_at_coordinates", arguments: { x: 1 } },
			{ kind: "call", name: "mobile_swipe_on_screen", arguments: { direction: "up", y: 1 } },
		]) {
			const result = await c.call("mobile_run_workflow", { steps: [{ kind: "call", name: "mobile_type_keys", arguments: { text: "hi" } }, invalid] });
			expect(result.isError).toBe(true);
		}
		expect(calls).toBe(0);
	} finally { await c.close(); }
});
