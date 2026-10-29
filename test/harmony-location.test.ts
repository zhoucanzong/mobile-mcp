import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyLocation } from "../src/harmony-location";

const originalCommand = process.env.HARMONY_LOCATION_COMMAND;
test.afterEach(() => {
	if (originalCommand === undefined) { delete process.env.HARMONY_LOCATION_COMMAND; } else { process.env.HARMONY_LOCATION_COMMAND = originalCommand; }
});

const fixture = (ready = true) => {
	process.env.HARMONY_LOCATION_COMMAND = "/system/bin/mobile-mcp-location";
	const hdc = new Hdc();
	const calls: string[][] = [];
	const sessions: Array<{ child: any; args: string[] }> = [];
	let receipt = '{"event":"cleared","code":0}';
	let clearResponse = receipt;
	let emitStop = true;
	hdc.spawnShell = (_target, args) => {
		calls.push(args);
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(), stderr: new PassThrough(),
			kill() { queueMicrotask(() => child.emit("close", -1)); return true; },
		});
		sessions.push({ child, args });
		if (ready) {
			queueMicrotask(() => child.stdout.write(JSON.stringify({ event: "started", latitude: Number(args[2]), longitude: Number(args[3]) }) + "\n"));
		}

		return child as unknown as ChildProcess;
	};
	hdc.shellChecked = (_target, args) => {
		calls.push(args);
		if (args[0] === "touch" && emitStop) {
			const session = sessions.find(entry => entry.args[4] === args[1])!;
			queueMicrotask(() => {
				session.child.stdout.write('{"event":"cleared","code":0}\n');
				session.child.emit("close", 0);
			});
		}

		return args[0] === "sh" ? receipt : args[1] === "clear" ? clearResponse : "";
	};
	return {
		service: new HarmonyLocation(hdc, "MATE60", { startup: 20, stop: 20 }), calls, sessions,
		setReceipt: (value: string) => { receipt = value; },
		setClearResponse: (value: string) => { clearResponse = value; },
		ignoreStop: () => { emitStop = false; },
	};
};

test("keeps a coordinate session alive until explicit cleanup is confirmed", async () => {
	const f = fixture();
	await f.service.set(31.2, 121.5);
	expect(f.service.isBusy()).toBe(true);
	expect(f.calls[0].slice(0, 4)).toEqual(["/system/bin/mobile-mcp-location", "run", "31.2", "121.5"]);
	await f.service.clear();
	expect(f.service.isBusy()).toBe(false);
	expect(f.calls.some(args => args[0] === "touch")).toBe(true);
	expect(f.calls.some(args => args[0] === "rm")).toBe(true);
});

test("serializes coordinate updates and terminates the previous publisher first", async () => {
	const f = fixture();
	await Promise.all([f.service.set(1, 2), f.service.set(3, 4)]);
	expect(f.sessions).toHaveLength(2);
	const oldStop = f.calls.findIndex(args => args[0] === "touch");
	const newStart = f.calls.findIndex(args => args[1] === "run" && args[2] === "3");
	expect(oldStop).toBeLessThan(newStart);
	await f.service.clear();
});

test("rejects invalid coordinates and missing component before spawning", async () => {
	const f = fixture();
	await expect(f.service.set(NaN, 0)).rejects.toThrow("Invalid");
	await expect(f.service.set(0, 181)).rejects.toThrow("Invalid");
	delete process.env.HARMONY_LOCATION_COMMAND;
	await expect(f.service.set(0, 0)).rejects.toThrow("HARMONY_LOCATION_COMMAND");
	expect(f.sessions).toEqual([]);
});

test("clear without a live session invokes and validates explicit system cleanup", async () => {
	const f = fixture();
	await f.service.clear();
	expect(f.calls).toContainEqual(["/system/bin/mobile-mcp-location", "clear"]);
	f.setClearResponse('{"event":"error","code":201}');
	await expect(f.service.clear()).rejects.toThrow("not confirmed");
});

test("wrong coordinate acknowledgement is not accepted as success", async () => {
	const f = fixture(false);
	const start = f.service.set(1, 2);
	await new Promise(resolve => setImmediate(resolve));
	f.sessions[0].child.stdout.write('{"event":"started","latitude":5,"longitude":6}\n');
	await expect(start).rejects.toThrow("rejected status");
	await f.service.clear();
});

test("native permission failure is reported and recovery is checked", async () => {
	const f = fixture(false);
	const start = f.service.set(1, 2);
	await new Promise(resolve => setImmediate(resolve));
	f.sessions[0].child.stdout.write('{"event":"error","code":201,"clearCode":0}\n');
	await expect(start).rejects.toThrow("MOCK_LOCATION permissions");
	await f.service.clear();
	expect(f.calls.some(args => args[1] === "clear")).toBe(true);
});

test("after a lost channel, recovery requires a terminal receipt before another session", async () => {
	const f = fixture();
	await f.service.set(1, 2);
	f.sessions[0].child.emit("close", -1);
	f.setReceipt("missing");
	await expect(f.service.set(3, 4)).rejects.toThrow("termination is unconfirmed");
	expect(f.sessions).toHaveLength(1);
	expect(f.service.isBusy()).toBe(true);
	f.setReceipt('{"event":"error","code":201,"clearCode":0}');
	await f.service.clear();
	expect(f.service.isBusy()).toBe(false);
});

test("a stop timeout is not success without an explicit cleanup and terminal receipt", async () => {
	const f = fixture();
	await f.service.set(1, 2);
	f.ignoreStop();
	f.setReceipt("missing");
	await expect(f.service.clear()).rejects.toThrow("termination is unconfirmed");
	f.setReceipt('{"event":"cleared","code":0}');
	await f.service.clear();
});
