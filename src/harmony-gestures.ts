import { z } from "zod";
import { Hdc } from "./hdc";
import { ActionableError, ScreenSize } from "./robot";

const coordinate = z.number().int().min(0).max(2147483647);
const point = z.object({ x: coordinate, y: coordinate }).strict();
export const dragSchema = z.object({
	kind: z.literal("drag"), from: point, to: point,
	pressMs: z.number().int().min(500).max(14500).default(500),
	durationMs: z.number().int().min(1000).max(15000).default(1000),
}).strict().refine(value => value.durationMs - value.pressMs >= 500, "Drag needs at least 500ms of movement after the hold");
export const pinchSchema = z.object({
	kind: z.literal("pinch"), center: point,
	startDistance: z.number().int().min(2).max(10000),
	endDistance: z.number().int().min(2).max(10000),
	angle: z.number().min(-180).max(180).default(0),
	durationMs: z.number().int().min(1).max(15000).default(500),
}).strict().refine(value => value.startDistance !== value.endDistance, "Pinch distances must differ");
export const gestureSchema = z.union([
	dragSchema, pinchSchema,
	z.object({ kind: z.literal("tap"), point }).strict(),
	z.object({ kind: z.literal("hold"), point, durationMs: z.number().int().min(1).max(10000).default(500) }).strict(),
	z.object({ kind: z.literal("pause"), durationMs: z.number().int().min(1).max(5000) }).strict(),
]);
export const gestureSequenceSchema = z.array(gestureSchema).min(1).max(20).refine(
	steps => steps.reduce((total, step) => total + ("durationMs" in step ? step.durationMs : 0), 0) <= 60000,
	"Combined gesture duration must not exceed 60000ms"
);
export type Gesture = z.infer<typeof gestureSchema>;

export function gesturePoints(gesture: Gesture): Array<{ x: number; y: number }> {
	if (gesture.kind === "drag") { return [gesture.from, gesture.to]; }
	if (gesture.kind === "pinch") {
		const radians = gesture.angle * Math.PI / 180;
		return [1, -1].flatMap(sign => [gesture.startDistance, gesture.endDistance].map(distance => ({
			x: Math.round(gesture.center.x + sign * Math.cos(radians) * distance / 2),
			y: Math.round(gesture.center.y + sign * Math.sin(radians) * distance / 2),
		})));
	}
	return "point" in gesture ? [gesture.point] : [];
}

export function validateGestureBounds(steps: Gesture[], size: ScreenSize): void {
	for (const step of steps) {
		if (gesturePoints(step).some(p => p.x < 0 || p.y < 0 || p.x >= size.width || p.y >= size.height)) {
			throw new ActionableError("Gesture coordinates are outside the current screen; no coordinates were clamped");
		}
	}
}

export function touchHelp(hdc: Hdc, target: string): string {
	const help = hdc.shellChecked(target, ["uinput", "-?"]);
	const heading = /^\s*-T\s+--touch[^\r\n]*$/m.exec(help);
	return heading ? help.slice(heading.index + heading[0].length).split(/\r?\n\s*(?:-[A-Z]\s|The option are:)/)[0] : "";
}

export function checkGestureSupport(steps: Gesture[], help: string): void {
	if (steps.some(s => s.kind === "drag") && !/^\s*-g\s.*\[press time\].*\[total time\]/im.test(help)) {
		throw new ActionableError("Device uinput does not advertise touch drag with press and total time");
	}
	if (steps.some(s => s.kind === "pinch") && (!/^\s*-m\s/m.test(help) || !/three finger movement/i.test(help))) {
		throw new ActionableError("Device uinput does not advertise simultaneous multi-finger touch movement");
	}
	if (steps.some(s => s.kind === "hold") && !["-d", "-u", "-i"].every(o => new RegExp(`^\\s*${o}\\s`, "m").test(help))) {
		throw new ActionableError("Device uinput does not advertise touch hold support");
	}
}

export function runNativeGesture(hdc: Hdc, target: string, step: Gesture): void {
	if (step.kind !== "drag" && step.kind !== "pinch") { throw new ActionableError("Expected drag or pinch"); }
	const points = gesturePoints(step);
	const args = step.kind === "drag"
		? ["-g", ...points.flatMap(p => [`${p.x}`, `${p.y}`]), `${step.pressMs}`, `${step.durationMs}`]
		: ["-m", ...points.flatMap(p => [`${p.x}`, `${p.y}`]), `${step.durationMs}`];
	try {
		const output = hdc.shellChecked(target, ["uinput", "-T", ...args], step.durationMs + 10000);
		const expected = step.kind === "drag"
			? [`pressTimems:${step.pressMs}`, `totalTimeMs:${step.durationMs}`]
			: ["fingerCount:2", `smoothTimeMs:${step.durationMs}`, ...[0, 2].map(i => `startX:${points[i].x}, startY:${points[i].y}, endX:${points[i + 1].x}, endY:${points[i + 1].y}`)];
		if (expected.some(line => !output.split(/\r?\n/).some(actual => actual.trim() === line)) || /\b(?:failed|denied|invalid|error|usage)\b/i.test(output)) {
			throw new ActionableError("uinput did not confirm the requested gesture parameters");
		}
	} catch (error: any) {
		// The CLI has no pointer-id-aware cancel command. A separate touch-up cannot
		// reliably release the two pointers of an interrupted pinch.
		throw new ActionableError(`Gesture failed: ${error.message}. Touch release is unconfirmed; inspect/reset the device input before retrying`);
	}
}
