#!/usr/bin/env node
import Ajv from "ajv/dist/2020";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpServer, getAgentVersion } from "./server";
import { validateOutputPath } from "./utils";
import { screenshotOptionsSchema, transformScreenshot } from "./screenshot-transform";

export const acceptanceCategories = ["basic", "chinese", "gestures", "workflow", "recovery"] as const;
const stepSchema = z.object({
	tool: z.string().startsWith("mobile_"), arguments: z.record(z.string(), z.unknown()).default({}),
	expectError: z.string().min(3).max(512).optional(),
}).strict();
export const acceptancePlanSchema = z.object({
	version: z.literal(1), name: z.string().min(1),
	fixture: z.string().min(1).describe("Test application and initial state required by this plan"),
	cases: z.array(z.object({
		id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
		category: z.enum(acceptanceCategories), description: z.string().min(1),
		steps: z.array(stepSchema).min(1).max(50),
	}).strict()).min(1).max(100),
	manualChecks: z.array(z.object({ id: z.string().min(1), description: z.string().min(1) }).strict()).default([]),
}).strict().superRefine((plan, ctx) => {
	const ids = new Set<string>();
	for (const item of plan.cases) {
		if (ids.has(item.id)) { ctx.addIssue({ code: "custom", message: `Duplicate case id: ${item.id}` }); }
		ids.add(item.id);
	}
	for (const category of acceptanceCategories) {
		if (!plan.cases.some(c => c.category === category)) { ctx.addIssue({ code: "custom", message: `Missing required category: ${category}` }); }
	}
	for (const item of plan.cases.filter(c => c.category === "recovery")) {
		const failure = item.steps.findIndex(s => s.expectError);
		if (failure < 0 || !item.steps.slice(failure + 1).some(s => !s.expectError)) {
			ctx.addIssue({ code: "custom", message: "Recovery case must include an expected failure followed by a successful operation" });
		}
	}
});
export type AcceptancePlan = z.infer<typeof acceptancePlanSchema>;
export interface AcceptanceClient {
	listTools(): Promise<{ tools: Array<{ name: string; inputSchema?: object }> }>;
	callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<any>;
}
export interface AcceptanceReport {
	version: 1; serverVersion: string; device: string; planName: string; fixture: string; startedAt: string; finishedAt?: string;
	mode: "plan" | "device"; status: "not_run" | "running" | "passed" | "needs_manual" | "failed";
	cases: Array<{ id: string; category: string; status: "not_run" | "passed" | "failed"; steps: Array<{ tool: string; status: string; text: string; artifacts: string[] }> }>;
	manualChecks: Array<{ id: string; description: string; status: "pending" }>;
	capabilities?: unknown; error?: string;
}
const forbidden = new Set(["mobile_login_to_cloud_provider", "mobile_list_remote_devices", "mobile_allocate_remote_device", "mobile_release_remote_device", "mobile_connect_harmony_device", "mobile_disconnect_harmony_device", "mobile_batch_commands"]);
function validateStep(step: z.infer<typeof stepSchema>, available: Set<string>): void {
	if (!available.has(step.tool) || forbidden.has(step.tool)) { throw new Error(`Tool not allowed in acceptance plans: ${step.tool}`); }
	if ("device" in step.arguments) { throw new Error("Acceptance steps cannot override device"); }
}
export function createAcceptanceReport(device: string, input: unknown): { plan: AcceptancePlan; report: AcceptanceReport } {
	if (!/^harmony:[a-zA-Z0-9][a-zA-Z0-9_.:[\]-]*$/.test(device)) { throw new Error("An explicit harmony: device id is required"); }
	const plan = acceptancePlanSchema.parse(input);
	return { plan, report: {
		version: 1, serverVersion: getAgentVersion(), device, planName: plan.name, fixture: plan.fixture, startedAt: new Date().toISOString(), mode: "plan", status: "not_run",
		cases: plan.cases.map(item => ({ id: item.id, category: item.category, status: "not_run", steps: [] })),
		manualChecks: plan.manualChecks.map(item => ({ ...item, status: "pending" })),
	} };
}
export function writeAcceptanceReport(directory: string, report: AcceptanceReport): void {
	const json = path.join(directory, "report.json");
	// Write into a new private run directory. Atomic replacement preserves a usable checkpoint on interruption.
	const temporary = path.join(directory, "report.pending.json");
	fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(temporary, json);
	const escape = (text: string) => text.replace(/[|\r\n]/g, " ");
	const lines = [`# ${escape(report.planName)}`, "", `Mode: ${report.mode}; status: ${report.status}; device: ${report.device}`, "", `Fixture: ${escape(report.fixture)}`, "", "| Case | Category | Result |", "|---|---|---|"];
	for (const item of report.cases) { lines.push(`| ${item.id} | ${item.category} | ${item.status} |`); }
	lines.push("", "## Manual checks", "");
	for (const item of report.manualChecks) { lines.push(`- [ ] ${escape(item.id)}: ${escape(item.description)}`); }
	lines.push("", "Automated pass does not complete pending manual checks. See report.json for per-step results and artifacts.");
	if (report.error) { lines.push("", `Error: ${escape(report.error)}`); }
	fs.writeFileSync(path.join(directory, "report.md"), lines.join("\n") + "\n", { mode: 0o600 });
}

export async function runAcceptance(client: AcceptanceClient, device: string, input: unknown, directory: string, execute: boolean, signal?: AbortSignal): Promise<AcceptanceReport> {
	const { plan, report } = createAcceptanceReport(device, input);
	const tools = (await client.listTools()).tools;
	const available = new Set(tools.map(t => t.name));
	const ajv = new Ajv({ strict: false, allErrors: true });
	const validators = new Map(tools.filter(t => t.inputSchema).map(t => [t.name, ajv.compile(t.inputSchema!)]));
	for (const item of plan.cases) {
		for (const step of item.steps) {
			validateStep(step, available);
			const validator = validators.get(step.tool);
			if (!validator || !validator({ ...step.arguments, device })) { throw new Error(`Invalid arguments for ${step.tool}: ${JSON.stringify(validator?.errors ?? "schema unavailable")}`); }
		}
	}
	writeAcceptanceReport(directory, report);
	if (!execute) { return report; }
	report.mode = "device";
	report.status = "running";
	writeAcceptanceReport(directory, report);
	try {
		if (signal?.aborted) { throw new Error("Acceptance interrupted before execution"); }
		const capabilities = await client.callTool({ name: "mobile_get_harmony_capabilities", arguments: { device, probeReads: false } });
		if (capabilities.isError) { throw new Error("Capability self-check failed"); }
		report.capabilities = JSON.parse(capabilities.content.find((c: any) => c.type === "text").text);
		if ((report.capabilities as any).connection.state !== "available") { throw new Error("Device connection is not established; no acceptance steps executed"); }
		for (let i = 0; i < plan.cases.length; i++) {
			const item = plan.cases[i], result = report.cases[i];
			for (let n = 0; n < item.steps.length; n++) {
				if (signal?.aborted) { throw new Error("Acceptance interrupted; subsequent steps were not executed"); }
				const step = item.steps[n];
				const record = { tool: step.tool, status: "failed", text: "", artifacts: [] as string[] };
				result.steps.push(record);
				try {
					const response = await client.callTool({ name: step.tool, arguments: { ...step.arguments, device } });
					const text = (response.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
					record.text = text.length > 65536 ? text.slice(0, 65536) + "\n[truncated]" : text;
					if (step.expectError) {
						if (!response.isError || !text.includes(step.expectError)) { throw new Error(`Expected a tool error containing: ${step.expectError}`); }
						record.status = "expected_error";
					} else {
						if (response.isError) { throw new Error(text || "Tool failed without diagnostic text"); }
						for (const [index, content] of (response.content ?? []).entries()) {
							if (content.type !== "image") { continue; }
							const format = content.mimeType === "image/png" ? "png" : content.mimeType === "image/jpeg" ? "jpeg" : undefined;
							if (!format) { throw new Error("Unexpected screenshot MIME type"); }
							const bytes = Buffer.from(content.data, "base64");
							const actualFormat = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png" : bytes[0] === 255 && bytes[1] === 216 ? "jpeg" : undefined;
							if (actualFormat !== format) { throw new Error("Screenshot MIME type does not match its bytes"); }
							await transformScreenshot(bytes, screenshotOptionsSchema.parse({}));
							const filename = `${item.id}-${n + 1}-${index}.${format === "png" ? "png" : "jpg"}`;
							fs.writeFileSync(path.join(directory, filename), bytes, { flag: "wx", mode: 0o600 });
							record.artifacts.push(filename);
						}
						if (step.tool === "mobile_take_screenshot" && record.artifacts.length === 0) { throw new Error("Screenshot tool returned no image"); }
						record.status = "passed";
					}
				} catch (error: any) {
					record.status = "failed"; record.text += `\n${error.message}`;
					result.status = "failed";
					throw new Error(`Case ${item.id}, step ${n + 1} failed`);
				} finally { writeAcceptanceReport(directory, report); }
			}
			result.status = "passed";
			writeAcceptanceReport(directory, report);
		}
		if (signal?.aborted) { throw new Error("Acceptance interrupted before completion"); }
		report.status = report.manualChecks.length ? "needs_manual" : "passed";
	} catch (error: any) { report.status = "failed"; report.error = error.message; } finally { report.finishedAt = new Date().toISOString(); writeAcceptanceReport(directory, report); }
	return report;
}

async function main(): Promise<void> {
	const options = new Command().requiredOption("--device <id>", "HarmonyOS device id")
		.requiredOption("--config <file>", "Acceptance plan JSON")
		.requiredOption("--output <directory>", "New run directory under cwd or OS temp")
		.option("--execute", "Execute device actions; without this flag, only validate the plan")
		.parse().opts();
	const input = JSON.parse(fs.readFileSync(path.resolve(options.config), "utf8"));
	createAcceptanceReport(options.device, input);
	const directory = path.resolve(options.output);
	validateOutputPath(path.join(directory, "report.json"));
	fs.mkdirSync(directory, { mode: 0o700 });
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
	const server = createMcpServer();
	const client = new Client({ name: "harmony-acceptance", version: getAgentVersion() });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
	try {
		await server.connect(serverTransport); await client.connect(clientTransport);
		const report = await runAcceptance({ listTools: () => client.listTools(), callTool: request => client.callTool(request, { timeout: 360000 }) }, options.device, input, directory, options.execute === true, controller.signal);
		process.stdout.write(JSON.stringify({ status: report.status, mode: report.mode, report: path.join(directory, "report.json"), manualChecksPending: report.manualChecks.length }) + "\n");
		if (report.status === "failed") { process.exitCode = 1; }
	} finally {
		process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
		await client.close(); await server.close();
	}
}
if (require.main === module) { main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); }
