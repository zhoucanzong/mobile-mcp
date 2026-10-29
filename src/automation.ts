import { dragSchema, pinchSchema } from "./harmony-gestures";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ActionableError, Robot, ScreenElement } from "./robot";
import { PNG } from "./png";
import { getJpegDimensions } from "./jpeg";

export const selectorSchema = z.object({
	identifier: z.string().min(1).max(2048).optional(),
	text: z.string().max(2048).optional(),
	label: z.string().max(2048).optional(),
	type: z.string().min(1).max(256).optional(),
	match: z.enum(["exact", "contains"]).default("exact"),
	enabled: z.boolean().optional(), selected: z.boolean().optional(), checked: z.boolean().optional(),
}).strict().refine(s => [s.identifier, s.text, s.label, s.type].some(v => v !== undefined), "Specify identifier, text, label or type");
export type Selector = z.infer<typeof selectorSchema>;
export const conditionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("element"), selector: selectorSchema, state: z.enum(["present", "absent"]).default("present") }).strict(),
	z.object({ kind: z.literal("app"), packageName: z.string().min(1).max(512) }).strict(),
	z.object({ kind: z.literal("orientation"), orientation: z.enum(["portrait", "landscape"]) }).strict(),
]);
export type Condition = z.infer<typeof conditionSchema>;
export const waitOptions = {
	timeoutMs: z.number().int().min(0).max(60000).default(10000),
	pollIntervalMs: z.number().int().min(50).max(5000).default(250),
	stableForMs: z.number().int().min(0).max(10000).default(0),
};
export interface Observation { matched: boolean; elements?: ScreenElement[]; actual?: unknown }
export function matchesElement(element: ScreenElement, selector: Selector): boolean {
	for (const field of ["identifier", "text", "label", "type"] as const) {
		const expected = selector[field];
		if (expected === undefined) { continue; }
		const actual = element[field];
		if (actual === undefined || (selector.match === "contains" && field !== "identifier" && field !== "type" ? !actual.includes(expected) : actual !== expected)) { return false; }
	}
	return (["enabled", "selected", "checked"] as const).every(field => selector[field] === undefined || element[field] === selector[field]);
}
export async function observe(robot: Robot, condition: Condition): Promise<Observation> {
	if (condition.kind === "element") {
		const elements = (await robot.getElementsOnScreen()).filter(e => matchesElement(e, condition.selector));
		return { matched: condition.state === "absent" ? elements.length === 0 : elements.length > 0, elements };
	}
	if (condition.kind === "app") {
		if (!robot.getForegroundApp) { throw new ActionableError("This device cannot inspect the foreground app"); }
		const actual = await robot.getForegroundApp();
		return { matched: actual.packageName === condition.packageName, actual };
	}
	const actual = await robot.getOrientation();
	return { matched: actual === condition.orientation, actual };
}
export interface WaitSettings { timeoutMs: number; pollIntervalMs: number; stableForMs: number }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export async function waitForCondition(robot: Robot, condition: Condition, settings: WaitSettings, deadline = Infinity): Promise<Observation> {
	if (settings.stableForMs > settings.timeoutMs) { throw new ActionableError("stableForMs must not exceed timeoutMs"); }
	const start = performance.now();
	const end = Math.min(start + settings.timeoutMs, deadline);
	let stableSince: number | undefined;
	let last: Observation | undefined;
	do {
		if (performance.now() >= deadline) { throw new ActionableError("Workflow deadline exceeded"); }
		last = await observe(robot, condition);
		const now = performance.now();
		if (now >= deadline) { throw new ActionableError("Workflow deadline exceeded"); }
		if (last.matched) {
			stableSince ??= now;
			if (now - stableSince >= settings.stableForMs && (settings.timeoutMs === 0 || now <= end)) { return last; }
		} else { stableSince = undefined; }
		if (now >= end) { break; }
		await sleep(Math.min(settings.pollIntervalMs, end - now));
	} while (true);
	throw new ActionableError(`Condition timed out after ${Math.round(performance.now() - start)}ms: ${JSON.stringify({ condition, last })}`);
}

export interface FailureEvidence { directory?: string; screenshot?: string; logs?: string; report?: string; errors: string[] }
export async function captureFailure(robot: Robot, report: unknown): Promise<FailureEvidence> {
	const evidence: FailureEvidence = { errors: [] };
	try {
		evidence.directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-failure-"));
		fs.chmodSync(evidence.directory, 0o700);
	} catch (error: any) { evidence.errors.push(`Directory: ${error.message}`); return evidence; }
	try {
		const bytes = await robot.getScreenshot();
		if (bytes.length > 32 * 1024 * 1024) { throw new Error("Screenshot exceeds 32MiB"); }
		const png = new PNG(bytes);
		let extension: string;
		if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
			const dimensions = png.getDimensions();
			if (dimensions.width === 0 || dimensions.height === 0) { throw new Error("Screenshot has empty dimensions"); }
			extension = "png";
		} else {
			getJpegDimensions(bytes);
			extension = "jpg";
		}
		evidence.screenshot = path.join(evidence.directory, `screen.${extension}`);
		fs.writeFileSync(evidence.screenshot, bytes, { flag: "wx", mode: 0o600 });
	} catch (error: any) { delete evidence.screenshot; evidence.errors.push(`Screenshot: ${error.message}`); }
	try {
		if (!robot.getLogs) { throw new Error("Device log collection is unavailable"); }
		const logs = await robot.getLogs(100, [], 1000);
		if (Buffer.byteLength(logs) > 8 * 1024 * 1024) { throw new Error("Logs exceed 8MiB"); }
		evidence.logs = path.join(evidence.directory, "device.jsonl");
		fs.writeFileSync(evidence.logs, logs, { flag: "wx", mode: 0o600 });
	} catch (error: any) { delete evidence.logs; evidence.errors.push(`Logs: ${error.message}`); }
	try {
		evidence.report = path.join(evidence.directory, "report.json");
		fs.writeFileSync(evidence.report, JSON.stringify({ report, evidence }, null, 2), { flag: "wx", mode: 0o600 });
	} catch (error: any) { delete evidence.report; evidence.errors.push(`Report: ${error.message}`); }
	return evidence;
}

export interface CallStep {
	kind: "call"; name: string; arguments: Record<string, unknown>; target?: Selector;
	expect?: Condition; verifyTimeoutMs: number; attempts: number; retryDelayMs: number;
}
export type WorkflowStep = CallStep | { kind: "wait"; condition: Condition; timeoutMs: number; pollIntervalMs: number; stableForMs: number }
	| { kind: "if"; condition: Condition; then: WorkflowStep[]; else: WorkflowStep[] }
	| { kind: "repeat"; steps: WorkflowStep[]; maxIterations: number; until?: Condition };
const callSchema = z.object({
	kind: z.literal("call"), name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}),
	target: selectorSchema.optional(), expect: conditionSchema.optional(),
	verifyTimeoutMs: z.number().int().min(0).max(60000).default(10000),
	attempts: z.number().int().min(1).max(3).default(1).describe("Explicit action attempts; retries can repeat side effects"),
	retryDelayMs: z.number().int().min(0).max(5000).default(250),
}).strict();
function nodeSchema(depth: number): z.ZodType {
	const leaf = [callSchema, z.object({ kind: z.literal("wait"), condition: conditionSchema, ...waitOptions }).strict()] as const;
	if (depth === 0) { return z.union(leaf); }
	const children = z.array(nodeSchema(depth - 1)).min(1).max(50);
	return z.union([...leaf,
		z.object({ kind: z.literal("if"), condition: conditionSchema, then: children, else: z.array(nodeSchema(depth - 1)).max(50).default([]) }).strict(),
		z.object({ kind: z.literal("repeat"), steps: children, maxIterations: z.number().int().min(1).max(50), until: conditionSchema.optional() }).strict(),
	]);
}
export const workflowStepsSchema = z.array(nodeSchema(3)).min(1).max(50);
export interface WorkflowEntry { paramsSchema: Record<string, z.ZodType>; callback: (args: any, telemetry: Record<string, string | number>) => Promise<string> }
const targetTools = new Set(["mobile_click_on_screen_at_coordinates", "mobile_double_tap_on_screen", "mobile_long_press_on_screen_at_coordinates"]);
// Deliberately explicit: adding a global/cloud tool must never make it runnable in a device workflow.
export const workflowToolNames = new Set([
	...targetTools, "mobile_type_keys", "mobile_press_button", "mobile_swipe_on_screen", "mobile_launch_app", "mobile_terminate_app", "mobile_open_url",
	"mobile_list_elements_on_screen", "mobile_get_foreground_app", "mobile_get_screen_size", "mobile_get_orientation", "mobile_set_orientation",
	"mobile_drag_on_screen", "mobile_pinch_on_screen", "mobile_perform_gestures",
]);
export interface WorkflowEvent { step: string; kind: string; attempt?: number; status: string; output?: string; error?: string; outputTruncated?: boolean }
export async function runWorkflow(robot: Robot, device: string, steps: WorkflowStep[], registry: Map<string, WorkflowEntry>, timeoutMs: number, maxSteps: number): Promise<WorkflowEvent[]> {
	let nodes = 0;
	const validate = (items: WorkflowStep[]) => {
		for (const step of items) {
			if (++nodes > 200) { throw new ActionableError("Workflow has more than 200 declared nodes"); }
			if (step.kind === "call") {
				const entry = registry.get(step.name);
				if (!workflowToolNames.has(step.name) || !entry) { throw new ActionableError(`Tool is not allowed in workflows: ${step.name}`); }
				if ("device" in step.arguments) { throw new ActionableError("Workflow steps cannot override device"); }
				if (step.target && (!targetTools.has(step.name) || ["ref", "x", "y"].some(k => k in step.arguments))) { throw new ActionableError("target requires a tap/long-press tool without ref/x/y arguments"); }
				const parsed = z.object(entry.paramsSchema).strict().parse({ ...step.arguments, device, ...(step.target ? { ref: "@preflight" } : {}) });
				if (targetTools.has(step.name) && parsed.ref === undefined && (parsed.x === undefined || parsed.y === undefined)) {
					throw new ActionableError("Tap/long-press steps require a target, ref or both x and y");
				}
				if (step.name === "mobile_swipe_on_screen" && ((parsed.x === undefined) !== (parsed.y === undefined))) {
					throw new ActionableError("Swipe steps require both x and y, or neither");
				}
				if (step.name === "mobile_drag_on_screen" || step.name === "mobile_pinch_on_screen") {
					const gesture = { ...parsed };
					delete gesture.device; delete gesture.captureOnFailure;
					const kind = step.name === "mobile_drag_on_screen" ? "drag" : "pinch";
					(kind === "drag" ? dragSchema : pinchSchema).parse({ ...gesture, kind });
				}
			} else if (step.kind === "if") {
				validate(step.then); validate(step.else);
			} else if (step.kind === "repeat") {
				validate(step.steps);
			} else if (step.stableForMs > step.timeoutMs) {
				throw new ActionableError("stableForMs must not exceed timeoutMs");
			}
		}
	};
	validate(steps);
	const deadline = performance.now() + timeoutMs;
	let executed = 0;
	const events: WorkflowEvent[] = [];
	let currentStep = "";
	const check = () => { if (performance.now() >= deadline) { throw new ActionableError("Workflow deadline exceeded"); } };
	const tick = () => { check(); if (++executed > maxSteps) { throw new ActionableError("Workflow execution step limit exceeded"); } };
	const evaluate = async (condition: Condition) => { check(); const observation = await observe(robot, condition); check(); return observation.matched; };
	const execute = async (items: WorkflowStep[], prefix: string) => {
		for (let index = 0; index < items.length; index++) {
			const step = items[index];
			const id = `${prefix}${index + 1}`;
			currentStep = id;
			tick();
			if (step.kind === "if") {
				const branch = await evaluate(step.condition) ? "then" : "else";
				events.push({ step: id, kind: step.kind, status: branch });
				await execute(step[branch], `${id}.${branch}.`);
			} else if (step.kind === "repeat") {
				let satisfied = step.until ? await evaluate(step.until) : false;
				let iteration = 0;
				while (!satisfied && iteration < step.maxIterations) {
					await execute(step.steps, `${id}.iteration${++iteration}.`);
					satisfied = step.until ? await evaluate(step.until) : false;
				}
				currentStep = id;
				if (step.until && !satisfied) { throw new ActionableError(`Step ${id}: repeat condition unmet after ${iteration} iterations`); }
				events.push({ step: id, kind: step.kind, status: `completed ${iteration} iterations` });
			} else if (step.kind === "wait") {
				await waitForCondition(robot, step.condition, step, deadline);
				events.push({ step: id, kind: step.kind, status: "matched" });
			} else {
				for (let attempt = 1; attempt <= step.attempts; attempt++) {
					if (attempt > 1) { tick(); }
					try {
						const args = { ...step.arguments, device };
						if (step.target) {
							const matches = (await robot.getElementsOnScreen()).filter(e => matchesElement(e, step.target!));
							if (matches.length !== 1 || !matches[0].ref || matches[0].enabled === false) { throw new ActionableError("Target must match exactly one enabled element with a fresh ref"); }
							Object.assign(args, { ref: matches[0].ref });
						}
						check();
						const entry = registry.get(step.name)!;
						// The enclosing workflow collects diagnostics once, after the final failure.
						if ("captureOnFailure" in entry.paramsSchema) { Object.assign(args, { captureOnFailure: false }); }
						const output = await entry.callback(z.object(entry.paramsSchema).strict().parse(args), {});
						check();
						if (step.expect) { await waitForCondition(robot, step.expect, { timeoutMs: step.verifyTimeoutMs, pollIntervalMs: 250, stableForMs: 0 }, deadline); }
						events.push({ step: id, kind: step.kind, attempt, status: "completed", output: output.slice(0, 8192), outputTruncated: output.length > 8192 });
						break;
					} catch (error: any) {
						events.push({ step: id, kind: step.kind, attempt, status: "failed", error: error.message });
						if (attempt === step.attempts) { throw error; }
						check();
						await sleep(Math.min(step.retryDelayMs, Math.max(0, deadline - performance.now())));
					}
				}
			}
			check();
		}
	};
	try { await execute(steps, ""); } catch (error: any) {
		throw new ActionableError(JSON.stringify({ success: false, failedStep: currentStep, error: error.message, events }));
	}
	return events;
}
