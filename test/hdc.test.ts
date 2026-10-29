import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { Hdc, quoteHdcArgument, validateHdcTarget } from "../src/hdc";
import { HarmonyDeviceManager } from "../src/harmony";

const originalHdcPath = process.env.HDC_PATH;
test.afterEach(() => {
	if (originalHdcPath === undefined) {
		delete process.env.HDC_PATH;
	} else {
		process.env.HDC_PATH = originalHdcPath;
	}
});

test("quotes Chinese, whitespace and shell syntax for the device shell", () => {
	test.skip(process.platform === "win32", "requires a POSIX shell to exercise remote-shell quoting");
	const text = "中文🙂 O'Reilly $(printf injected) `printf injected` & ; #~\n第二行";
	const result = execFileSync("sh", ["-c", "printf '%s' " + quoteHdcArgument(text)], { encoding: "utf8" });
	expect(result).toBe(text);
	expect(() => quoteHdcArgument("a\0b")).toThrow("NUL");
});

test("passes the complete quoted command as one HDC shell argument", () => {
	const hdc = new Hdc();
	let captured: string[] = [];
	hdc.executeCommand = args => {
		captured = args;
		return Buffer.from("ok");
	};
	hdc.shell("127.0.0.1:8710", ["uitest", "uiInput", "text", "你好 world"]);
	expect(captured).toEqual(["-t", "127.0.0.1:8710", "shell", "'uitest' 'uiInput' 'text' '你好 world'"]);
	expect(() => validateHdcTarget("-h")).toThrow("Invalid");
	expect(() => validateHdcTarget("device;echo injected")).toThrow("Invalid");
});

test("detects HDC failures even when the process exits zero", () => {
	process.env.HDC_PATH = process.execPath;
	expect(() => new Hdc().executeCommand(["-e", "process.stdout.write('[Fail] device unauthorized')"])).toThrow("device unauthorized");
});

test("treats a missing optional HDC differently from an explicitly broken path", () => {
	const hdc = new Hdc();
	hdc.executeCommand = () => { throw Object.assign(new Error("missing hdc"), { code: "ENOENT" }); };
	delete process.env.HDC_PATH;
	expect(new HarmonyDeviceManager(hdc).discover()).toEqual({ available: false, devices: [] });
	process.env.HDC_PATH = "/missing/hdc";
	expect(() => new HarmonyDeviceManager(hdc).discover()).toThrow("Check HDC_PATH");
});

test("discovers HDC targets with Chinese model names and preserves target identity", () => {
	const hdc = new Hdc();
	hdc.executeCommand = () => Buffer.from("MATE60\n127.0.0.1:8710\nMATE60\n");
	hdc.shell = (_target, args) => args[2] === "const.product.model" ? "华为 Mate 60 Pro" : "HarmonyOS test fixture";
	const result = new HarmonyDeviceManager(hdc).discover();
	expect(result.available).toBe(true);
	expect(result.devices.map(device => device.id)).toEqual(["harmony:MATE60", "harmony:127.0.0.1:8710"]);
	expect(result.devices[0]).toMatchObject({ name: "华为 Mate 60 Pro", platform: "harmonyos", type: "real", state: "online" });
});

test("returns no targets for HDC's empty response", () => {
	const hdc = new Hdc();
	hdc.executeCommand = () => Buffer.from("[Empty]\n");
	expect(new HarmonyDeviceManager(hdc).discover()).toEqual({ available: true, devices: [] });
});
