import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hdc } from "../src/hdc";
import { Robot } from "../src/robot";
import { inspectHarmonyCapabilities, inspectRecorderFile, probeExecutable } from "../src/harmony-capabilities";

function fixture() {
	const hdc = new Hdc(); const calls: string[][] = [];
	hdc.shellChecked = (_target, args) => {
		calls.push(args);
		if (args[0] === "param") { return args[2] === "const.ohos.fullname" ? "OpenHarmony-6.1" : "true"; }
		return "available";
	};
	hdc.shell = (_target, args) => { calls.push(args); return args[0] === "bm" ? "-l, --label" : args[0] === "uinput" ? "-T --touch\n-g x y x y [press time] [total time]\n-m x y x y\nSupports up to three finger movement\n" : "text -motion -p -z -y"; };
	return { hdc, calls };
}

test("presence and help never imply write permission", async () => {
	const { hdc, calls } = fixture();
	const result = await inspectHarmonyCapabilities(hdc, "TEST", {} as Robot);
	expect(result.features.pinch.state).toBe("available");
	expect(result.commands.uitest.state).toBe("available");
	expect(Object.values(result.permissions).every(p => p.state === "unknown")).toBe(true);
	expect(calls.some(c => c.includes("start") || c.includes("set-data") || c.includes("uiInput") && !c.includes("-h"))).toBe(false);
});

test("read successes only establish their own read operation", async () => {
	const { hdc } = fixture(); let reads = 0;
	const robot = {
		getElementsOnScreen: async () => { reads++; return []; }, getScreenshot: async () => Buffer.from("sensitive"),
		listApps: async () => [], getClipboard: async () => "private clipboard",
		getLogs: async () => "private logs", listCrashes: () => [], getForegroundApp: async () => ({ packageName: "private.app" }),
	} as any;
	const result = await inspectHarmonyCapabilities(hdc, "TEST", robot, true);
	expect(reads).toBe(1); expect(result.permissions["clipboard.read"].state).toBe("available");
	expect(result.permissions["clipboard.write"].state).toBe("unknown");
	expect(JSON.stringify(result)).not.toContain("private clipboard");
	expect(JSON.stringify(result)).not.toContain("private.app");
});

test("explicit denial differs from an unknown read failure", async () => {
	const { hdc } = fixture();
	const robot = { getElementsOnScreen: async () => { throw new Error("permission denied"); }, getScreenshot: async () => { throw new Error("transport disconnected"); } } as any;
	const result = await inspectHarmonyCapabilities(hdc, "TEST", robot, true);
	expect(result.permissions["ui.read"].state).toBe("unavailable");
	expect(result.permissions["screenshot.read"].state).toBe("unknown");
});

test("connection failures return unknown and do not launch a cascade of probes", async () => {
	const { hdc, calls } = fixture();
	hdc.shellChecked = (_target, args) => { calls.push(args); throw new Error("not connected"); };
	const report = await inspectHarmonyCapabilities(hdc, "TEST", {} as Robot, true);
	expect(report.connection.state).toBe("unknown"); expect(calls).toHaveLength(1);
	expect(Object.values(report.commands).every(c => c.state === "unknown")).toBe(true);
});

test("missing command, malformed response and transport failure are distinct", () => {
	const { hdc } = fixture();
	hdc.shellChecked = () => "unavailable";
	expect(probeExecutable(hdc, "TEST", "uitest").state).toBe("unavailable");
	hdc.shellChecked = () => "unexpected";
	expect(probeExecutable(hdc, "TEST", "uitest").state).toBe("unknown");
	hdc.shellChecked = () => { throw new Error("timeout"); };
	expect(probeExecutable(hdc, "TEST", "uitest").state).toBe("unknown");
	expect(probeExecutable(hdc, "TEST", "tool --option").state).toBe("unavailable");
});

test("host recorder inspection validates architecture without executing a helper", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-recorder-inspect-"));
	const file = path.join(dir, "recorder");
	try {
		fs.writeFileSync(file, "not a binary"); expect(inspectRecorderFile(file).state).toBe("unavailable");
		const elf = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(183, 18);
		fs.writeFileSync(file, elf); expect(inspectRecorderFile(file).state).toBe("available");
		expect(inspectRecorderFile(file).evidence).toContain("authorization are unverified");
		expect(inspectRecorderFile("relative").state).toBe("unavailable");
	} finally { fs.rmSync(dir, { recursive: true }); }
});
