import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { collectHarmonyLogs, parseHilogLine } from "../src/harmony-logs";

const fixture = () => {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as string | null,
		kill(signal: string) {
			this.signalCode = signal;
			queueMicrotask(() => this.emit("close", null));
			return true;
		},
	});
	const hdc = new Hdc();
	const calls: unknown[] = [];
	hdc.spawnShell = (target, args) => { calls.push([target, args]); return child as unknown as ChildProcess; };
	return { hdc, child, calls };
};

test("parses epoch logs and preserves unrecognized continuation lines", () => {
	expect(parseHilogLine("1700000000.123 123 124 I C01800/SAMGR: 中文内容")).toMatchObject({ pid: "123", tid: "124", tag: "SAMGR", level: "INFO", subsystem: "C01800", message: "中文内容" });
	expect(parseHilogLine("    stack continuation")).toEqual({ message: "    stack continuation", raw: "    stack continuation" });
});

test("handles split UTF-8 characters and stops the stream at the matching limit", async () => {
	const { hdc, child, calls } = fixture();
	const result = collectHarmonyLogs(hdc, "MATE60", 1, ["tag=samgr", "level=i", "message=中文"], 1000);
	const data = Buffer.from("1700000000.123 123 124 I C01800/SAMGR: 中文🙂\n");
	const split = data.indexOf(Buffer.from("中")) + 1;
	child.stdout.write(data.subarray(0, split));
	child.stdout.write(data.subarray(split));
	expect(JSON.parse(await result).message).toBe("中文🙂");
	expect(child.signalCode).toBe("SIGTERM");
	expect(calls).toEqual([["MATE60", ["hilog", "-v", "epoch"]]]);
});

test("filters are ANDed, negation works and absent fields do not match", async () => {
	const { hdc, child } = fixture();
	const result = collectHarmonyLogs(hdc, "MATE60", 1, ["pid!=1", "message=READY"], 1000);
	child.stdout.write("unknown READY\n1700000000.1 1 1 I C1/APP: ready\n1700000000.2 2 2 I C1/APP: ready now\n");
	expect(JSON.parse(await result).pid).toBe("2");
});

test("a fixed deadline terminates even a stream without matching entries", async () => {
	const { hdc, child } = fixture();
	const result = collectHarmonyLogs(hdc, "MATE60", 10, ["pid=999"], 10);
	child.stdout.write("1700000000.1 1 1 I C1/APP: no match\n");
	expect(await result).toBe("");
	expect(child.signalCode).toBe("SIGTERM");
});

test("rejects unsupported filters before starting HDC", () => {
	const { hdc, calls } = fixture();
	expect(() => collectHarmonyLogs(hdc, "MATE60", 1, ["process=myapp"], 1000)).toThrow("process/category");
	expect(calls).toEqual([]);
});

test("propagates HDC launch and device permission failures", async () => {
	const first = fixture();
	const missing = collectHarmonyLogs(first.hdc, "MATE60", 1, [], 1000);
	first.child.emit("error", new Error("spawn hdc ENOENT"));
	await expect(missing).rejects.toThrow("HDC_PATH");
	const second = fixture();
	const denied = collectHarmonyLogs(second.hdc, "MATE60", 1, [], 1000);
	second.child.stderr.write("permission denied");
	await expect(denied).rejects.toThrow("permission denied");
});

test("flushes a final unterminated line and rejects failed exits", async () => {
	const first = fixture();
	const result = collectHarmonyLogs(first.hdc, "MATE60", 10, [], 1000);
	first.child.stdout.write("1700000000.1 1 1 E C1/APP: final");
	first.child.exitCode = 0;
	first.child.emit("close", 0);
	expect(JSON.parse(await result).message).toBe("final");
	const second = fixture();
	const failed = collectHarmonyLogs(second.hdc, "MATE60", 10, [], 1000);
	second.child.exitCode = 1;
	second.child.emit("close", 1);
	await expect(failed).rejects.toThrow("exited with code 1");
});
