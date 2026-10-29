import { z } from "zod";
import { ActionableError, Robot } from "./robot";
import { HarmonyRobot } from "./harmony";
import { dragSchema, pinchSchema, gestureSequenceSchema, Gesture } from "./harmony-gestures";
import { captureFailure, conditionSchema, observe, waitForCondition, waitOptions, workflowStepsSchema, WorkflowStep, WorkflowEntry, runWorkflow } from "./automation";

type RegisterTool = (name: string, title: string, description: string, schema: Record<string, z.ZodType>, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }, callback: WorkflowEntry["callback"]) => void;
export function registerAutomationTools(tool: RegisterTool, getRobot: (device: string) => Robot, registry: Map<string, WorkflowEntry>): void {
	const device = z.string().min(1).describe("Device identifier from device discovery");
	const captureOnFailure = z.boolean().default(true).describe("Save a private temporary screenshot, device logs and report on failure; returned paths stay on the MCP host");
	const guarded = async (id: string, capture: boolean, action: (robot: Robot) => Promise<string>) => {
		const robot = getRobot(id);
		try { return await action(robot); } catch (error: any) {
			if (!capture) { throw error; }
			const evidence = await captureFailure(robot, { device: id, error: error.message });
			throw new ActionableError(JSON.stringify({ success: false, error: error.message, evidence }));
		}
	};
	const gestures = async (id: string, capture: boolean, steps: Gesture[]) => guarded(id, capture, async robot => {
		if (!(robot instanceof HarmonyRobot)) { throw new ActionableError("These gesture tools currently require a HarmonyOS device"); }
		await robot.performGestures(steps);
		return JSON.stringify({ success: true, gestures: steps.length, verification: "Input commands completed; inspect the screen or use a workflow postcondition to verify the app result" });
	});
	const gestureAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
	tool("mobile_drag_on_screen", "Drag on Screen", "HarmonyOS: hold then drag between coordinates. Requires uinput touch drag. durationMs includes pressMs. Input completion does not prove the application accepted the drag.", {
		device, ...z.object(dragSchema.shape).omit({ kind: true }).shape, captureOnFailure,
	}, gestureAnnotations, async ({ device, captureOnFailure, ...args }) => gestures(device, captureOnFailure, [dragSchema.parse({ kind: "drag", ...args })]));
	tool("mobile_pinch_on_screen", "Pinch on Screen", "HarmonyOS: move two fingers simultaneously around a center. Distances are full finger separation in screen pixels; larger endDistance zooms in. Angle is degrees from the horizontal screen axis. Requires multi-finger uinput.", {
		device, ...z.object(pinchSchema.shape).omit({ kind: true }).shape, captureOnFailure,
	}, gestureAnnotations, async ({ device, captureOnFailure, ...args }) => gestures(device, captureOnFailure, [pinchSchema.parse({ kind: "pinch", ...args })]));
	tool("mobile_perform_gestures", "Perform Gestures", "HarmonyOS: execute up to 20 tap, hold, drag, pinch or pause gestures in order, releasing fingers between gestures. All coordinates and capabilities are preflighted; stop on the first failure. Combined requested duration is limited to 60 seconds. This is a sequence, not a continuous arbitrary multi-finger path.", {
		device, gestures: gestureSequenceSchema, captureOnFailure,
	}, gestureAnnotations, async ({ device, gestures: steps, captureOnFailure }) => gestures(device, captureOnFailure, steps));
	tool("mobile_wait_for_condition", "Wait for Condition", "Poll fresh UI elements, foreground app or orientation until a condition is true. Element selectors support Unicode and conjunctive fields. An absent condition never treats a device read error as absence. stableForMs requires matching successive observations. Returns current matching elements and refs. Failures can save local diagnostics.", {
		device, condition: conditionSchema, ...waitOptions, captureOnFailure,
	}, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, async ({ device, condition, captureOnFailure, ...settings }) => guarded(device, captureOnFailure, async robot => JSON.stringify(await waitForCondition(robot, condition, settings))));
	tool("mobile_assert_condition", "Assert Condition", "Check a fresh UI element, foreground app or orientation once. A mismatch is an MCP tool error. Use after an action to verify its result. Failures can save local screenshots and logs.", {
		device, condition: conditionSchema, captureOnFailure,
	}, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, async ({ device, condition, captureOnFailure }) => guarded(device, captureOnFailure, async robot => {
		const observation = await observe(robot, condition);
		if (!observation.matched) { throw new ActionableError(`Assertion failed: ${JSON.stringify({ condition, observation })}`); }
		return JSON.stringify(observation);
	}));
	tool("mobile_run_workflow", "Run Workflow", "Execute a bounded device workflow with call, wait, if/then/else and repeat steps (3 nested control levels). Validate all steps before execution. A call can have a fresh target selector for tap/long-press, an expect postcondition and explicitly opted-in attempts (default 1). Repeating actions can duplicate side effects; there is no rollback. repeat checks until before and after each iteration, failing when its limit is exhausted. No nested workflows, batch, cloud or cross-device calls. Failures are tool errors with partial execution history and optional local diagnostics. Deadlines are checked between device operations; they cannot interrupt an in-flight device command.", {
		device, steps: workflowStepsSchema,
		timeoutMs: z.number().int().min(1).max(300000).default(60000).describe("Overall execution deadline in milliseconds, excluding failure diagnostics"),
		maxSteps: z.number().int().min(1).max(500).default(100).describe("Maximum executed nodes and action attempts"),
		captureOnFailure,
	}, { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, async ({ device, steps, timeoutMs, maxSteps, captureOnFailure }) => guarded(device, captureOnFailure, async robot => {
		const events = await runWorkflow(robot, device, steps as WorkflowStep[], registry, timeoutMs, maxSteps);
		return JSON.stringify({ success: true, events });
	}));
}
