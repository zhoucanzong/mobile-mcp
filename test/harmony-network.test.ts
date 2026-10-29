import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyDeviceManager } from "../src/harmony";

test("verifies connection state and disconnects only the requested endpoint", () => {
	const targets = new Set(["USB_DEVICE", "192.168.1.2:5555"]);
	const calls: string[][] = [];
	const hdc = new Hdc();
	hdc.shell = () => "";
	hdc.executeCommand = args => {
		calls.push(args);
		if (args[0] === "tconn") {
			targets.add(args[1]);
		} else if (args[0] === "tdisconn") {
			targets.delete(args[1]);
		}

		return Buffer.from(args[0] === "list" ? [...targets].join("\n") : "");
	};
	const manager = new HarmonyDeviceManager(hdc);
	expect(manager.connect("192.168.1.3:5555")).toBe("harmony:192.168.1.3:5555");
	manager.disconnect("192.168.1.3:5555");
	expect([...targets]).toEqual(["USB_DEVICE", "192.168.1.2:5555"]);
	expect(calls.filter(args => args[0] === "tdisconn")).toEqual([["tdisconn", "192.168.1.3:5555"]]);
});

test("rejects implicit ports, command syntax and invalid endpoint ports before HDC", () => {
	const hdc = new Hdc();
	let calls = 0;
	hdc.executeCommand = () => { calls++; return Buffer.from(""); };
	const manager = new HarmonyDeviceManager(hdc);
	for (const address of ["", "127.0.0.1", "-h", "host:0", "host:65536", "host:5555;id", "[:::]:123", "host:5555\n"]) {
		expect(() => manager.connect(address)).toThrow();
		expect(() => manager.disconnect(address)).toThrow();
	}

	expect(calls).toBe(0);
});

test("does not report success just because HDC prints a connection message", () => {
	const hdc = new Hdc();
	hdc.executeCommand = args => Buffer.from(args[0] === "list" ? "[Empty]" : "Connect OK");
	expect(() => new HarmonyDeviceManager(hdc).connect("host:5555")).toThrow("did not report");
	hdc.shell = () => "";
	hdc.executeCommand = args => Buffer.from(args[0] === "list" ? "host:5555" : "Disconnected");
	expect(() => new HarmonyDeviceManager(hdc).disconnect("host:5555")).toThrow("still connected");
});
