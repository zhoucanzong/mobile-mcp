import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyRobot } from "../src/harmony";
import { gestureSequenceSchema, gesturePoints, pinchSchema } from "../src/harmony-gestures";

const help = "-K --keyboard\n-g other\n-T --touch\n-g x y x y [press time] [total time]\n-m x y x y\nSupports up to three finger movement at the same time\n-d x y\n-u x y\n-i ms\n";
function fixture() {
	const calls: string[][] = [];
	const hdc = new Hdc();
	hdc.shellChecked = (_target, args) => {
		calls.push(args);
		if (args[1] === "-?") { return help; }
		if (args[2] === "-g") { return `pressTimems:${args[7]}\ntotalTimeMs:${args[8]}`; }
		if (args[2] === "-m") { return `startX:${args[3]}, startY:${args[4]}, endX:${args[5]}, endY:${args[6]}\nstartX:${args[7]}, startY:${args[8]}, endX:${args[9]}, endY:${args[10]}\nfingerCount:2\nsmoothTimeMs:${args[11]}`; }
		return "";
	};
	const robot = new HarmonyRobot("harmony:TEST", hdc);
	robot.getScreenSize = async () => ({ width: 1000, height: 2000, scale: 1 });
	return { calls, hdc, robot };
}

test("drag includes the hold and total duration in one touch command", async () => {
	const { robot, calls } = fixture();
	await robot.performGestures(gestureSequenceSchema.parse([{ kind: "drag", from: { x: 10, y: 20 }, to: { x: 100, y: 200 }, pressMs: 600, durationMs: 1500 }]));
	expect(calls[1]).toEqual(["uinput", "-T", "-g", "10", "20", "100", "200", "600", "1500"]);
});

test("pinch uses simultaneous touchscreen fingers, not sequential swipes", async () => {
	const { robot, calls } = fixture();
	await robot.performGestures(gestureSequenceSchema.parse([{ kind: "pinch", center: { x: 500, y: 500 }, startDistance: 100, endDistance: 300 }]));
	expect(calls[1]).toEqual(["uinput", "-T", "-m", "550", "500", "650", "500", "450", "500", "350", "500", "500"]);
});

test("pinch supports inward and vertical movement", () => {
	const gesture = pinchSchema.parse({ kind: "pinch", center: { x: 500, y: 500 }, startDistance: 300, endDistance: 100, angle: 90 });
	expect(gesturePoints(gesture)).toEqual([{ x: 500, y: 650 }, { x: 500, y: 550 }, { x: 500, y: 350 }, { x: 500, y: 450 }]);
});

test("preflights all coordinates before a combined sequence changes the screen", async () => {
	const { robot, calls } = fixture();
	await expect(robot.performGestures(gestureSequenceSchema.parse([
		{ kind: "tap", point: { x: 10, y: 10 } },
		{ kind: "pinch", center: { x: 10, y: 10 }, startDistance: 100, endDistance: 200 },
	]))).rejects.toThrow("outside");
	expect(calls).toEqual([]);
});

test("rejects missing multi-finger capability without issuing touch input", async () => {
	const { robot, hdc, calls } = fixture();
	hdc.shellChecked = (_target, args) => { calls.push(args); return "-T --touch\n-m x y x y\n"; };
	await expect(robot.performGestures(gestureSequenceSchema.parse([{ kind: "pinch", center: { x: 500, y: 500 }, startDistance: 100, endDistance: 200 }]))).rejects.toThrow("simultaneous");
	expect(calls).toEqual([["uinput", "-?"]]);
});

test("stops combined gestures after failure and reports unconfirmed touch release", async () => {
	const { robot, hdc } = fixture();
	let taps = 0;
	robot.tap = async () => { taps++; };
	hdc.shellChecked = (_target, args) => args[1] === "-?" ? help : "permission denied";
	await expect(robot.performGestures(gestureSequenceSchema.parse([
		{ kind: "tap", point: { x: 10, y: 10 } },
		{ kind: "drag", from: { x: 10, y: 10 }, to: { x: 20, y: 20 } },
		{ kind: "tap", point: { x: 10, y: 10 } },
	]))).rejects.toThrow("Gesture 2/3 (drag) failed; earlier gestures may have run");
	expect(taps).toBe(1);
});

test("rejects a partial or wrong parameter acknowledgement", async () => {
	const { robot, hdc } = fixture();
	hdc.shellChecked = (_target, args) => args[1] === "-?" ? help : "pressTimems:500\ntotalTimeMs:2000";
	await expect(robot.performGestures(gestureSequenceSchema.parse([{ kind: "drag", from: { x: 10, y: 10 }, to: { x: 20, y: 20 } }]))).rejects.toThrow("Touch release is unconfirmed");
});

test("bounds durations, coordinates, sequence count and total duration", () => {
	for (const input of [
		[{ kind: "drag", from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, pressMs: 800, durationMs: 1000 }],
		[{ kind: "tap", point: { x: NaN, y: 1 } }],
		[{ kind: "pinch", center: { x: 2, y: 2 }, startDistance: 2, endDistance: 2 }],
		Array.from({ length: 21 }, () => ({ kind: "tap", point: { x: 1, y: 1 } })),
		Array.from({ length: 13 }, () => ({ kind: "pause", durationMs: 5000 })),
	]) { expect(gestureSequenceSchema.safeParse(input).success).toBe(false); }
});

test("combined sequence preserves order across tap, hold, pause, pinch and drag", async () => {
	const { robot, calls } = fixture();
	robot.tap = async () => { calls.push(["tap"]); };
	robot.longPress = async () => { calls.push(["hold"]); };
	await robot.performGestures(gestureSequenceSchema.parse([
		{ kind: "tap", point: { x: 10, y: 10 } }, { kind: "hold", point: { x: 10, y: 10 } },
		{ kind: "pause", durationMs: 1 },
		{ kind: "pinch", center: { x: 500, y: 500 }, startDistance: 100, endDistance: 200 },
		{ kind: "drag", from: { x: 10, y: 10 }, to: { x: 20, y: 20 } },
	]));
	expect(calls.map(c => c[0] === "uinput" ? c[2] || c[1] : c[0])).toEqual(["-?", "tap", "hold", "-m", "-g"]);
});
