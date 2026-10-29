import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyRecording, validateRecordingMp4 } from "../src/harmony-recording";

// Synthetic container for structural checks, not an encoded-video fixture.
const box = (type: string, payload: string) => {
	const out = Buffer.alloc(8 + payload.length);
	out.writeUInt32BE(out.length);
	out.write(type, 4);
	out.write(payload, 8);
	return out;
};
const container = Buffer.concat([box("ftyp", "isom0000"), box("mdat", "data"), box("moov", "index")]);
const previousPath = process.env.HARMONY_RECORDER_PATH;
const directories: string[] = [];
test.afterEach(() => {
	for (const directory of directories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}

	if (previousPath === undefined) {
		delete process.env.HARMONY_RECORDER_PATH;
	} else {
		process.env.HARMONY_RECORDER_PATH = previousPath;
	}
});

const fixture = (ready = true) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-record-test-"));
	directories.push(directory);
	process.env.HARMONY_RECORDER_PATH = path.join(directory, "recorder");
	fs.writeFileSync(process.env.HARMONY_RECORDER_PATH, "mock executable; never deployed to a device");
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(), stderr: new PassThrough(),
		kill() { queueMicrotask(() => child.emit("close", -1)); return true; },
	});
	const calls: string[][] = [];
	let contents = container;
	let reportedBytes = container.length;
	const emit = (event: unknown) => child.stdout.write(JSON.stringify(event) + "\n");
	const close = () => {
		emit({ event: "stopped", bytes: reportedBytes });
		child.emit("close", 0);
	};
	const hdc = new Hdc();
	hdc.executeCommand = args => {
		calls.push(args);
		if (args[2] === "file" && args[3] === "recv") {
			directories.push(path.dirname(args[5]));
			fs.writeFileSync(args[5], contents);
		}

		return Buffer.from("");
	};
	hdc.shellChecked = (_target, args) => {
		calls.push(args);
		if (args[0] === "touch") {
			queueMicrotask(close);
		}

		return "";
	};
	hdc.spawnShell = (_target, args) => {
		calls.push(args);
		if (ready) {
			queueMicrotask(() => emit({ event: "started", pid: 123 }));
		}

		return child as unknown as ChildProcess;
	};
	return {
		directory, child, hdc, calls, emit, close,
		output: path.join(directory, "capture.mp4"),
		recorder: new HarmonyRecording(hdc, "MATE60", { startup: 20, stop: 20 }),
		setData: (data: Buffer) => { contents = data; },
		setReportedBytes: (bytes: number) => { reportedBytes = bytes; },
	};
};

test("waits for native start, stops via a control file and saves the verified container", async () => {
	const f = fixture();
	expect(await f.recorder.start(1081, 2401, f.output, 10)).toBe(f.output);
	expect(fs.existsSync(f.output)).toBe(false);
	const result = await f.recorder.stop();
	expect(result).toMatchObject({ output: f.output, bytes: container.length });
	expect(fs.readFileSync(f.output)).toEqual(container);
	expect(f.calls.some(args => args[0] === "touch")).toBe(true);
	expect(f.calls.find(args => args[0].endsWith(".bin"))!.slice(-3)).toEqual(["1080", "2400", "10"]);
	expect(f.recorder.isBusy()).toBe(false);
});

test("a timed completion stays collectable and prevents a second start until collection", async () => {
	const f = fixture();
	await f.recorder.start(1080, 2400, f.output, 1);
	f.close();
	await expect(f.recorder.start(1080, 2400)).rejects.toThrow("awaiting collection");
	expect((await f.recorder.stop()).output).toBe(f.output);
	expect(f.calls.some(args => args[0] === "touch")).toBe(false);
});

test("does not acknowledge authorization cancellation or save an output", async () => {
	const f = fixture(false);
	const start = f.recorder.start(1080, 2400, f.output);
	f.emit({ event: "error", code: -10 });
	await expect(start).rejects.toThrow("Unexpected recorder status");
	await new Promise(resolve => setImmediate(resolve));
	expect(fs.existsSync(f.output)).toBe(false);
});

test("startup timeout requests remote stop and leaves no successful result", async () => {
	const f = fixture(false);
	await expect(f.recorder.start(1080, 2400, f.output)).rejects.toThrow("timed out");
	await new Promise(resolve => setImmediate(resolve));
	expect(f.calls.some(args => args[0] === "touch")).toBe(true);
	expect(fs.existsSync(f.output)).toBe(false);
});

test("preserves an existing destination if transfer size differs", async () => {
	const f = fixture();
	fs.writeFileSync(f.output, "existing user file");
	await f.recorder.start(1080, 2400, f.output);
	f.setReportedBytes(container.length + 1);
	await expect(f.recorder.stop()).rejects.toThrow("transfer size differs");
	expect(fs.readFileSync(f.output, "utf8")).toBe("existing user file");
	expect(f.calls.some(args => args[0] === "rm" && args.slice(2).some(value => value.endsWith(".mp4")))).toBe(false);
});

test("rejects malformed or unfinalized output instead of overwriting the destination", async () => {
	const f = fixture();
	fs.writeFileSync(f.output, "original");
	await f.recorder.start(1080, 2400, f.output);
	f.setData(box("ftyp", "isom0000"));
	await expect(f.recorder.stop()).rejects.toThrow("Recording is incomplete");
	expect(fs.readFileSync(f.output, "utf8")).toBe("original");
});

test("process exit without finalization is an error even when it exits zero", async () => {
	const f = fixture();
	await f.recorder.start(1080, 2400, f.output);
	f.child.emit("close", 0);
	await expect(f.recorder.stop()).rejects.toThrow("did not complete successfully");
});

test("a recorder that ignores stop is terminated and never reported as saved", async () => {
	const f = fixture();
	await f.recorder.start(1080, 2400, f.output);
	f.hdc.shellChecked = () => "";
	await expect(f.recorder.stop()).rejects.toThrow("stop deadline");
	expect(fs.existsSync(f.output)).toBe(false);
});

test("validates native helper configuration and time limits before deployment", async () => {
	const f = fixture();
	await expect(f.recorder.start(1080, 2400, f.output, 0.5)).rejects.toThrow("integer timeLimit");
	delete process.env.HARMONY_RECORDER_PATH;
	await expect(f.recorder.start(1080, 2400, f.output)).rejects.toThrow("HARMONY_RECORDER_PATH");
	expect(f.calls).toEqual([]);
});

test("MP4 validation rejects truncated box payloads and incomplete indexes", () => {
	const f = fixture();
	fs.writeFileSync(f.output, container);
	expect(validateRecordingMp4(f.output)).toBe(container.length);
	fs.writeFileSync(f.output, container.subarray(0, container.length - 1));
	expect(() => validateRecordingMp4(f.output)).toThrow("invalid MP4 box length");
	fs.writeFileSync(f.output, Buffer.concat([box("ftyp", "isom"), box("mdat", "data")]));
	expect(() => validateRecordingMp4(f.output)).toThrow("incomplete");
});
