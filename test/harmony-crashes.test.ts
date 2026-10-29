import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyCrashes, parseHarmonyCrashName } from "../src/harmony-crashes";

const directory = "/data/log/faultlog/faultlogger/";
const cpp = "cppcrash-com.example.app-10001-20261029123456123.log";
const js = "jscrash-测试进程-10001-20261029123457.log";

test("parses process names and device-local timestamps without inventing a timezone", () => {
	expect(parseHarmonyCrashName(cpp)).toEqual({ id: cpp, type: "cppcrash", processName: "com.example.app", timestamp: "2026-10-29T12:34:56.123" });
	expect(parseHarmonyCrashName(js)?.processName).toBe("测试进程");
	for (const id of ["../" + cpp, directory + cpp, "cppcrash-../../secret-1-20261029123456.log", "appfreeze-app-1-20261029123456.log", "cppcrash-app-1-20261029123456.tmp"]) {
		expect(parseHarmonyCrashName(id)).toBeUndefined();
	}
});

test("lists only regular crash files from the fixed directory and sorts newest first", () => {
	const hdc = new Hdc();
	hdc.shellChecked = (_target, args) => {
		expect(args).toEqual(["find", directory.slice(0, -1), "-maxdepth", "1", "-type", "f", "-print"]);
		return [directory + cpp, directory + js, directory + cpp, "/tmp/" + cpp, directory + "other.txt"].join("\n");
	};
	expect(new HarmonyCrashes(hdc, "MATE60").list().map(report => report.id)).toEqual([js, cpp]);
});

test("preserves report text including error lines and trailing newlines", () => {
	const hdc = new Hdc();
	const content = "Error: 模拟应用崩溃\nstack trace\n\n";
	hdc.shellChecked = (_target, args) => {
		if (args[0] === "find") {
			return directory + cpp;
		}

		expect(args[0]).toBe("sh");
		expect(args[2]).toContain('test ! -L "$1"');
		expect(args[4]).toBe(directory + cpp);
		return content;
	};
	expect(new HarmonyCrashes(hdc, "MATE60").read(cpp)).toBe(content);
});

test("rejects removed reports and invalid ids without issuing a read", () => {
	const hdc = new Hdc();
	const commands: string[][] = [];
	hdc.shellChecked = (_target, args) => { commands.push(args); return ""; };
	const crashes = new HarmonyCrashes(hdc, "MATE60");
	expect(() => crashes.read("../../secret")).toThrow("Invalid");
	expect(commands).toEqual([]);
	expect(() => crashes.read(cpp)).toThrow("no longer available");
	expect(commands.map(args => args[0])).toEqual(["find"]);
});

test("permission failures remain errors rather than an empty report list", () => {
	const hdc = new Hdc();
	hdc.shellChecked = () => { throw new Error("permission denied"); };
	expect(() => new HarmonyCrashes(hdc, "MATE60").list()).toThrow("permission denied");
});

test("checked shell reads preserve data and validate the remote exit status", () => {
	test.skip(process.platform === "win32", "uses POSIX shell to model the device command interpreter");
	const hdc = new Hdc();
	hdc.executeCommand = (args, _timeout, inspectOutput) => {
		expect(inspectOutput).toBe(false);
		return execFileSync("sh", ["-c", args[3]], { stdio: ["ignore", "pipe", "pipe"] });
	};
	const data = "Error: 中文崩溃\n\n";
	expect(hdc.shellChecked("MATE60", ["printf", "%s", data])).toBe(data);
	expect(() => hdc.shellChecked("MATE60", ["sh", "-c", "exit 7"])).toThrow("status 7");
	hdc.executeCommand = () => Buffer.from("connection lost");
	expect(() => hdc.shellChecked("MATE60", ["printf", "data"])).toThrow("missing command status");
});
