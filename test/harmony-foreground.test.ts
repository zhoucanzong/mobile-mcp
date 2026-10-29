import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyRobot, harmonyForegroundFromLayout, parseHarmonyFocus } from "../src/harmony";

// Synthetic fixture using the upstream dump schema; not a captured phone dump.
const layout = {
	attributes: { bounds: "[0,0][1080,2400]" },
	children: [
		{ attributes: { hostWindowId: "10", bundleName: "com.example.background", abilityName: "OtherAbility" } },
		{ attributes: { hostWindowId: "91", bundleName: "com.example.notes", abilityName: "EntryAbility" } },
	],
};

test("selects the default-display focused window rather than the first visible app", () => {
	const focus = parseHarmonyFocus("Focus window: 91\nAll Focus window:\nDisplayId: 0 WindowId: 91\nDisplayId: 5 WindowId: 10\n");
	expect(harmonyForegroundFromLayout(layout, focus)).toEqual({ packageName: "com.example.notes", appName: "com.example.notes", activity: "EntryAbility" });
});

test("fails closed for missing, negative, or ambiguous focus output", () => {
	for (const dump of ["permission denied", "Focus window: -1", "All Focus window:\nDisplayId: 0 WindowId: 91", "Focus window: 91\nFocus window: 92"]) {
		expect(() => parseHarmonyFocus(dump)).toThrow("Cannot identify");
	}
});

test("does not guess an app when the focused window is absent from the tree", () => {
	expect(() => harmonyForegroundFromLayout(layout, "42")).toThrow("cannot be mapped uniquely");
	expect(() => harmonyForegroundFromLayout({ attributes: { bundleName: "com.example" } }, "91")).toThrow("cannot be mapped uniquely");
});

test("handles unmerged window arrays and omitted ability metadata", () => {
	expect(harmonyForegroundFromLayout([{ attributes: { bundleName: "com.example", hostWindowId: 91 } }], "91")).toEqual({ appName: "com.example", packageName: "com.example" });
});

test("rejects conflicting package identities for the same focused window", () => {
	const conflicting = { children: [...layout.children, { attributes: { hostWindowId: "91", bundleName: "com.example.wrong" } }] };
	expect(() => harmonyForegroundFromLayout(conflicting, "91")).toThrow("cannot be mapped uniquely");
});

test("brackets the UI dump with focus queries and rejects a focus change", async () => {
	const hdc = new Hdc();
	let focusCalls = 0;
	const calls: string[][] = [];
	hdc.shell = (_target, args) => {
		calls.push(args);
		if (args[0] === "hidumper") {
			return `Focus window: ${++focusCalls === 1 ? 91 : 10}`;
		}

		return args[0] === "cat" ? JSON.stringify(layout) : "";
	};
	await expect(new HarmonyRobot("harmony:MATE60", hdc).getForegroundApp()).rejects.toThrow("focus changed");
	expect(focusCalls).toBe(2);
	expect(calls[0]).toEqual(["hidumper", "-s", "WindowManagerService", "-a", "-a"]);
	expect(calls.some(args => args[0] === "rm")).toBe(true);
});
