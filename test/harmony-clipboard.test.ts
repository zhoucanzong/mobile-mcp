import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyClipboard } from "../src/harmony-clipboard";

const success = (data: unknown = {}) => JSON.stringify({ type: "result", status: "success", data });
const textResponse = (text: string) => success({ recordCount: 1, records: [{ mimeType: "text/plain", plainText: text }] });
const errorResponse = (code: string) => JSON.stringify({ type: "result", status: "failed", errCode: code, errMsg: "test failure" });
const originalCommand = process.env.HARMONY_PASTEBOARD_COMMAND;
test.afterEach(() => {
	if (originalCommand === undefined) {
		delete process.env.HARMONY_PASTEBOARD_COMMAND;
	} else {
		process.env.HARMONY_PASTEBOARD_COMMAND = originalCommand;
	}
});

test("reads Unicode and whitespace exactly and recognizes an explicitly empty clipboard", () => {
	const hdc = new Hdc();
	const value = " 中文🙂 O'Reilly\n\n";
	hdc.shellChecked = () => textResponse(value);
	const clipboard = new HarmonyClipboard(hdc, "MATE60");
	expect(clipboard.get()).toBe(value);
	hdc.shellChecked = () => errorResponse("ERR_NO_DATA");
	expect(clipboard.get()).toBe("");
	hdc.shellChecked = () => success({ recordCount: 0, records: [] });
	expect(clipboard.get()).toBe("");
});

test("rejects permission failures, help text, inconsistent records and non-text data", () => {
	const hdc = new Hdc();
	for (const response of [errorResponse("ERR_PERMISSION_DENIED"), "usage: ohos-pasteboard", success({ recordCount: 1, records: [] }), success({ recordCount: 1, records: [{ mimeType: "text/html", htmlText: "<b>text</b>" }] })]) {
		hdc.shellChecked = () => response;
		expect(() => new HarmonyClipboard(hdc, "MATE60").get()).toThrow();
	}
});

test("sets text via a private file, cleans up and checks readback", () => {
	const hdc = new Hdc();
	const text = "你好🙂\n末尾\n\n";
	const calls: string[][] = [];
	let local = "";
	let remote = "";
	hdc.executeCommand = args => {
		calls.push(args);
		local = args[4];
		remote = args[5];
		expect(fs.readFileSync(local, "utf8")).toBe(text);
		return Buffer.from("");
	};
	hdc.shellChecked = (_target, args) => {
		calls.push(args);
		return args[1] === "get-data" ? textResponse(text) : success();
	};
	new HarmonyClipboard(hdc, "MATE60").set(text);
	expect(fs.existsSync(local)).toBe(false);
	expect(calls).toContainEqual(["chmod", "600", remote]);
	expect(calls).toContainEqual(["rm", "-f", remote]);
	expect(calls.find(args => args[0] === "sh")![4]).toBe(remote);
});

test("device shell transport preserves trailing newlines and never executes clipboard syntax", () => {
	test.skip(process.platform === "win32", "models the POSIX device shell");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-clipboard-test-"));
	try {
		const hdc = new Hdc();
		const text = "中文🙂 ' \" $(printf injected) `printf injected` & ;\n\n";
		let remoteFile = "";
		let received = "";
		const sink = path.join(directory, "sink");
		fs.writeFileSync(sink, '#!/bin/sh\nprintf "%s" "$3"\n', { mode: 0o700 });
		hdc.executeCommand = args => {
			remoteFile = path.join(directory, "remote.txt");
			fs.copyFileSync(args[4], remoteFile);
			return Buffer.from("");
		};
		hdc.shellChecked = (_target, args) => {
			if (args[0] === "sh") {
				received = execFileSync("sh", ["-c", args[2], args[3], remoteFile, sink], { encoding: "utf8" });
			}

			return args[1] === "get-data" ? textResponse(received) : success();
		};
		new HarmonyClipboard(hdc, "MATE60").set(text);
		expect(received).toBe(text);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("empty text clears the clipboard and verifies the cleared state", () => {
	const hdc = new Hdc();
	const operations: string[] = [];
	hdc.shellChecked = (_target, args) => {
		operations.push(args[1]);
		return args[1] === "get-data" ? errorResponse("ERR_NO_DATA") : success();
	};
	new HarmonyClipboard(hdc, "MATE60").set("");
	expect(operations).toEqual(["clear-data", "get-data"]);
});

test("reports accepted-but-unverified writes without claiming success", () => {
	const hdc = new Hdc();
	hdc.shellChecked = (_target, args) => args[1] === "get-data" ? errorResponse("ERR_PERMISSION_DENIED") : success();
	expect(() => new HarmonyClipboard(hdc, "MATE60").set("")).toThrow("write was accepted but readback could not be verified");
	hdc.shellChecked = (_target, args) => args[1] === "get-data" ? textResponse("another app changed it") : success();
	expect(() => new HarmonyClipboard(hdc, "MATE60").set("")).toThrow("readback did not match");
});

test("validates transport limits and executable configuration before mutation", () => {
	const hdc = new Hdc();
	let calls = 0;
	hdc.shellChecked = () => { calls++; return success(); };
	const clipboard = new HarmonyClipboard(hdc, "MATE60");
	for (const text of ["a\0b", "中".repeat(22000), "--help", "\ud800"]) {
		expect(() => clipboard.set(text)).toThrow();
	}

	process.env.HARMONY_PASTEBOARD_COMMAND = "--help";
	expect(() => clipboard.set("")).toThrow("one device executable");
	expect(calls).toBe(0);
});

test("removes local temporary text and reports failed remote cleanup", () => {
	const hdc = new Hdc();
	let local = "";
	hdc.executeCommand = args => { local = args[4]; return Buffer.from(""); };
	hdc.shellChecked = (_target, args) => {
		if (args[0] === "rm") {
			throw new Error("device disconnected");
		}

		return args[0] === "sh" ? errorResponse("ERR_SET_DATA_FAILED") : success();
	};
	expect(() => new HarmonyClipboard(hdc, "MATE60").set("临时文本")).toThrow(/ERR_SET_DATA_FAILED.*cleanup also failed/);
	expect(fs.existsSync(local)).toBe(false);
});
