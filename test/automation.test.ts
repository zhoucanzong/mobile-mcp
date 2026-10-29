import { expect, test } from "@playwright/test";
import { z } from "zod";
import fs from "node:fs";
import { Robot, ScreenElement } from "../src/robot";
import { captureFailure, conditionSchema, matchesElement, observe, runWorkflow, selectorSchema, waitForCondition, WorkflowEntry, WorkflowStep, workflowStepsSchema } from "../src/automation";

const element: ScreenElement = { type: "Button", text: "下一步", identifier: "next", enabled: true, rect: { x: 1, y: 2, width: 30, height: 40 }, ref: "@h1e1" };
const present = conditionSchema.parse({ kind: "element", selector: { text: "下一步" } });
const absent = conditionSchema.parse({ kind: "element", selector: { text: "下一步" }, state: "absent" });
const settings = { timeoutMs: 500, pollIntervalMs: 50, stableForMs: 0 };
function robot(elements: ScreenElement[] = [element]): Robot {
	return {
		getElementsOnScreen: async () => elements,
		getForegroundApp: async () => ({ packageName: "com.example.app", appName: "示例" }),
		getOrientation: async () => "portrait",
		getScreenshot: async () => { throw new Error("screenshot denied"); },
		getLogs: async () => { throw new Error("log denied"); },
	} as Robot;
}
function workflow(input: unknown): WorkflowStep[] { return workflowStepsSchema.parse(input) as WorkflowStep[]; }
function registry(callback: WorkflowEntry["callback"]): Map<string, WorkflowEntry> {
	return new Map([["mobile_type_keys", { paramsSchema: { device: z.string(), text: z.string() }, callback }],
		["mobile_click_on_screen_at_coordinates", { paramsSchema: { device: z.string(), ref: z.string() }, callback }]]);
}
const type = { kind: "call", name: "mobile_type_keys", arguments: { text: "中文" } };

test("selectors are conjunctive, exact by default and preserve Unicode", () => {
	expect(matchesElement(element, selectorSchema.parse({ text: "下一步", identifier: "next", enabled: true }))).toBe(true);
	expect(matchesElement(element, selectorSchema.parse({ text: "下一" }))).toBe(false);
	expect(matchesElement(element, selectorSchema.parse({ text: "下一", match: "contains" }))).toBe(true);
	expect(matchesElement(element, selectorSchema.parse({ text: "下一步", identifier: "wrong" }))).toBe(false);
	expect(matchesElement(element, selectorSchema.parse({ text: "下一步", checked: false }))).toBe(false);
	expect(selectorSchema.safeParse({}).success).toBe(false);
});

test("wait observes fresh snapshots until the element appears", async () => {
	const device = robot();
	let reads = 0;
	device.getElementsOnScreen = async () => ++reads < 3 ? [] : [element];
	expect((await waitForCondition(device, present, settings)).elements).toEqual([element]);
	expect(reads).toBe(3);
});

test("stable wait restarts its timer if the condition stops matching", async () => {
	const device = robot();
	let reads = 0;
	device.getElementsOnScreen = async () => ++reads === 2 ? [] : [element];
	await waitForCondition(device, present, { ...settings, stableForMs: 90 });
	expect(reads).toBeGreaterThanOrEqual(5);
});

test("absence and observation errors remain distinct", async () => {
	expect((await observe(robot([]), absent)).matched).toBe(true);
	const device = robot();
	device.getElementsOnScreen = async () => { throw new Error("disconnected"); };
	await expect(waitForCondition(device, absent, settings)).rejects.toThrow("disconnected");
});

test("waits time out and reject contradictory timing parameters", async () => {
	await expect(waitForCondition(robot([]), present, { ...settings, timeoutMs: 60 })).rejects.toThrow("timed out");
	await expect(waitForCondition(robot(), present, { ...settings, timeoutMs: 20, stableForMs: 30 })).rejects.toThrow("must not exceed");
});

test("app and orientation checks compare actual device observations", async () => {
	expect((await observe(robot(), conditionSchema.parse({ kind: "app", packageName: "com.example.app" }))).matched).toBe(true);
	expect((await observe(robot(), conditionSchema.parse({ kind: "orientation", orientation: "landscape" }))).matched).toBe(false);
});

test("workflow executes the selected branch and fixed-count loop", async () => {
	const calls: string[] = [];
	const entries = registry(async args => { calls.push(args.text); return "ok"; });
	const steps = workflow([{ kind: "if", condition: present, then: [{ kind: "repeat", maxIterations: 2, steps: [type] }], else: [{ ...type, arguments: { text: "wrong" } }] }]);
	const events = await runWorkflow(robot(), "harmony:TEST", steps, entries, 1000, 20);
	expect(calls).toEqual(["中文", "中文"]);
	expect(events[0].status).toBe("then");
});

test("else branch and repeat-until check state before and after actions", async () => {
	const device = robot([]);
	let calls = 0;
	const entries = registry(async () => { calls++; device.getElementsOnScreen = async () => [element]; return "ok"; });
	const events = await runWorkflow(device, "harmony:TEST", workflow([
		{ kind: "if", condition: present, then: [type], else: [{ kind: "repeat", maxIterations: 3, until: present, steps: [type] }] },
		{ kind: "repeat", maxIterations: 3, until: present, steps: [type] },
	]), entries, 1000, 20);
	expect(calls).toBe(1);
	expect(events.at(-1)?.status).toBe("completed 0 iterations");
});

test("unmet loop condition is failure with partial history", async () => {
	let calls = 0;
	await expect(runWorkflow(robot([]), "harmony:TEST", workflow([{ kind: "repeat", maxIterations: 2, until: present, steps: [type] }]), registry(async () => { calls++; return "ok"; }), 1000, 20)).rejects.toThrow("unmet after 2 iterations");
	expect(calls).toBe(2);
});

test("validates all branches before any action and refuses cross-device/nested calls", async () => {
	let calls = 0;
	const entries = registry(async () => { calls++; return "ok"; });
	for (const invalid of [
		{ ...type, name: "mobile_batch_commands" }, { ...type, name: "mobile_run_workflow" },
		{ ...type, name: "mobile_allocate_remote_device" },
		{ ...type, arguments: { text: "hi", device: "other" } },
		{ ...type, arguments: { text: 123 } },
	]) {
		await expect(runWorkflow(robot(), "harmony:TEST", workflow([type, { kind: "if", condition: present, then: [type], else: [invalid] }]), entries, 1000, 20)).rejects.toThrow();
	}
	expect(calls).toBe(0);
});

test("does not retry by default and never executes later steps after failure", async () => {
	let calls = 0;
	await expect(runWorkflow(robot(), "harmony:TEST", workflow([type, type]), registry(async () => { calls++; throw new Error("lost response"); }), 1000, 20)).rejects.toThrow("lost response");
	expect(calls).toBe(1);
});

test("explicit retries re-resolve fresh target refs and retain failed attempts", async () => {
	const refs: string[] = [];
	let reads = 0;
	const device = robot();
	device.getElementsOnScreen = async () => [{ ...element, ref: `@h${++reads}e1` }];
	const events = await runWorkflow(device, "harmony:TEST", workflow([{ kind: "call", name: "mobile_click_on_screen_at_coordinates", target: { text: "下一步" }, attempts: 2, retryDelayMs: 0 }]), registry(async args => {
		refs.push(args.ref);
		if (refs.length === 1) { throw new Error("transient"); }
		return "ok";
	}), 1000, 20);
	expect(refs).toEqual(["@h1e1", "@h2e1"]);
	expect(events.map(e => e.status)).toEqual(["failed", "completed"]);
});

test("postconditions can fail an otherwise successful action", async () => {
	let calls = 0;
	await expect(runWorkflow(robot([]), "harmony:TEST", workflow([{ ...type, expect: present, verifyTimeoutMs: 0 }, type]), registry(async () => { calls++; return "input accepted"; }), 1000, 20)).rejects.toThrow("timed out");
	expect(calls).toBe(1);
});

test("workflow wait and postcondition see state produced by an action", async () => {
	const device = robot([]);
	const events = await runWorkflow(device, "harmony:TEST", workflow([{ ...type, expect: present }, { kind: "wait", condition: present }]), registry(async () => { device.getElementsOnScreen = async () => [element]; return "ok"; }), 1000, 20);
	expect(events.map(e => e.status)).toEqual(["completed", "matched"]);
});

test("ambiguous or disabled targets cannot silently click the first match", async () => {
	let calls = 0;
	for (const elements of [[element, element], [{ ...element, enabled: false }], []]) {
		await expect(runWorkflow(robot(elements), "harmony:TEST", workflow([{ kind: "call", name: "mobile_click_on_screen_at_coordinates", target: { text: "下一步" } }]), registry(async () => { calls++; return "ok"; }), 1000, 20)).rejects.toThrow("exactly one");
	}
	expect(calls).toBe(0);
});

test("execution budget counts loop bodies and retries", async () => {
	let calls = 0;
	await expect(runWorkflow(robot(), "harmony:TEST", workflow([{ kind: "repeat", maxIterations: 50, steps: [type] }]), registry(async () => { calls++; return "ok"; }), 1000, 3)).rejects.toThrow("step limit");
	expect(calls).toBe(2);
});

test("deadline stops subsequent actions even if an in-flight command returns late", async () => {
	let calls = 0;
	await expect(runWorkflow(robot(), "harmony:TEST", workflow([type, type]), registry(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return "ok"; }), 10, 20)).rejects.toThrow("deadline");
	expect(calls).toBe(1);
});

test("failure capture retains original report even when screenshot and logs fail", async () => {
	const evidence = await captureFailure(robot(), { error: "original failure" });
	try {
		expect(evidence.errors).toEqual(["Screenshot: screenshot denied", "Logs: log denied"]);
		expect(JSON.parse(fs.readFileSync(evidence.report!, "utf8")).report.error).toBe("original failure");
		expect(fs.statSync(evidence.directory!).mode & 0o777).toBe(0o700);
	} finally { fs.rmSync(evidence.directory!, { recursive: true }); }
});

test("failure capture saves actual screenshot format and bounded logs privately", async () => {
	const device = robot();
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7XsAAAAASUVORK5CYII=", "base64");
	device.getScreenshot = async () => png;
	device.getLogs = async (limit, filters, timeout) => {
		expect([limit, filters, timeout]).toEqual([100, [], 1000]); return '{"message":"中文"}\n';
	};
	const evidence = await captureFailure(device, { error: "mismatch" });
	try {
		expect(evidence.errors).toEqual([]);
		expect(fs.readFileSync(evidence.screenshot!)).toEqual(png);
		expect(fs.readFileSync(evidence.logs!, "utf8")).toContain("中文");
		expect(fs.statSync(evidence.screenshot!).mode & 0o777).toBe(0o600);
	} finally { fs.rmSync(evidence.directory!, { recursive: true }); }
});

test("a matching observation that arrives after the wait deadline is not success", async () => {
	const device = robot();
	device.getElementsOnScreen = async () => { await new Promise(resolve => setTimeout(resolve, 30)); return [element]; };
	await expect(waitForCondition(device, present, { ...settings, timeoutMs: 10 })).rejects.toThrow("timed out");
});

test("the declaration limit is checked before executing even unreachable nodes", async () => {
	let calls = 0;
	const tree = Array.from({ length: 5 }, () => ({ kind: "if", condition: absent, then: Array.from({ length: 40 }, () => type) }));
	await expect(runWorkflow(robot(), "harmony:TEST", workflow(tree), registry(async () => { calls++; return "ok"; }), 1000, 500)).rejects.toThrow("200 declared nodes");
	expect(calls).toBe(0);
});
