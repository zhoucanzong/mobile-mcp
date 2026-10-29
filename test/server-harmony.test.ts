import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Hdc } from "../src/hdc";
import { Mobilecli } from "../src/mobilecli";
import { createMcpServer } from "../src/server";
import type { Robot } from "../src/robot";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { HarmonyRobot } from "../src/harmony";

const originalHdcExecute = Hdc.prototype.executeCommand;
const originalHdcShell = Hdc.prototype.shell;
const originalShellChecked = Hdc.prototype.shellChecked;
const originalVersion = Mobilecli.prototype.getVersion;
const originalDevices = Mobilecli.prototype.getDevices;
const originalSpawnShell = Hdc.prototype.spawnShell;
const originalTelemetry = process.env.MOBILEMCP_DISABLE_TELEMETRY;

test.beforeEach(() => {
	process.env.MOBILEMCP_DISABLE_TELEMETRY = "1";
	Hdc.prototype.executeCommand = () => Buffer.from("MATE60\n");
	Hdc.prototype.shell = (_target, args) => {
		if (args[0] === "param") {
			return args[2] === "const.product.model" ? "华为 Mate 60 Pro" : "HarmonyOS fixture";
		}

		if (args[0] === "cat") {
			return JSON.stringify({ attributes: { type: "Button", text: "搜索", bounds: "[10,20][110,80]" }, children: [] });
		}

		return "";
	};
	Mobilecli.prototype.getVersion = () => "failed unavailable";
});

test.afterEach(() => {
	Hdc.prototype.executeCommand = originalHdcExecute;
	Hdc.prototype.shell = originalHdcShell;
	Hdc.prototype.shellChecked = originalShellChecked;
	Mobilecli.prototype.getVersion = originalVersion;
	Mobilecli.prototype.getDevices = originalDevices;
	Hdc.prototype.spawnShell = originalSpawnShell;
	if (originalTelemetry === undefined) {
		delete process.env.MOBILEMCP_DISABLE_TELEMETRY;
	} else {
		process.env.MOBILEMCP_DISABLE_TELEMETRY = originalTelemetry;
	}
});

const withClient = async (run: (client: Client) => Promise<void>, robotCache?: Map<string, Robot>) => {
	const server = createMcpServer({ robotCache });
	const client = new Client({ name: "harmony-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		await run(client);
	} finally {
		await client.close();
		await server.close();
	}
};

test("lists and operates HarmonyOS independently of mobilecli", async () => {
	await withClient(async client => {
		const list: any = await client.callTool({ name: "mobile_list_available_devices", arguments: {} });
		expect(list.isError).not.toBe(true);
		const discovered = JSON.parse(list.content[0].text);
		expect(discovered.devices).toHaveLength(1);
		expect(discovered.devices[0]).toMatchObject({ id: "harmony:MATE60", platform: "harmonyos", name: "华为 Mate 60 Pro" });
		expect(discovered.warnings[0]).toContain("mobilecli");
		const elements: any = await client.callTool({ name: "mobile_list_elements_on_screen", arguments: { device: "harmony:MATE60" } });
		expect(elements.content[0].text).toContain('@h1e1 Button text="搜索"');
		const tap: any = await client.callTool({ name: "mobile_click_on_screen_at_coordinates", arguments: { device: "harmony:MATE60", ref: "@h1e1" } });
		expect(tap.isError).not.toBe(true);
		const stale: any = await client.callTool({ name: "mobile_click_on_screen_at_coordinates", arguments: { device: "harmony:MATE60", ref: "@h1e1" } });
		expect(stale.isError).toBe(true);
		expect(stale.content[0].text).toContain("stale");
	});
});

test("merges Android/iOS discovery with HarmonyOS", async () => {
	Mobilecli.prototype.getVersion = () => "1.0.19";
	Mobilecli.prototype.getDevices = () => ({ status: "ok", data: { devices: [{ id: "android-1", name: "Pixel", platform: "android", type: "real", version: "15", state: "online" }] } });
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_list_available_devices", arguments: {} });
		expect(JSON.parse(result.content[0].text).devices.map((device: any) => device.platform)).toEqual(["harmonyos", "android"]);
	});
});

test("routes the MCP log tool through HiLog and returns filtered NDJSON", async () => {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null as string | null,
		kill(signal: string) {
			this.signalCode = signal;
			queueMicrotask(() => this.emit("close", null));
			return true;
		},
	});
	Hdc.prototype.spawnShell = (target, args) => {
		expect(target).toBe("MATE60");
		expect(args).toEqual(["hilog", "-v", "epoch"]);
		queueMicrotask(() => child.stdout.write("1700000000.1 123 124 I C01800/APP: 中文日志\n"));
		return child as unknown as ChildProcess;
	};
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_get_device_logs", arguments: { device: "harmony:MATE60", limit: 1, filter: ["message=中文"] } });
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content[0].text)).toMatchObject({ pid: "123", message: "中文日志" });
		expect(child.signalCode).toBe("SIGTERM");
	});
});

test("preserves HarmonyOS refs across the per-request HTTP server factory", async () => {
	const robotCache = new Map<string, Robot>();
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_list_elements_on_screen", arguments: { device: "harmony:MATE60" } });
		expect(result.content[0].text).toContain("@h1e1");
	}, robotCache);
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_click_on_screen_at_coordinates", arguments: { device: "harmony:MATE60", ref: "@h1e1" } });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toBe("Clicked on element @h1e1");
	}, robotCache);
});

test("keeps HarmonyOS discoverable when mobilecli device listing fails", async () => {
	Mobilecli.prototype.getVersion = () => "1.0.19";
	Mobilecli.prototype.getDevices = () => { throw new Error("adb unavailable"); };
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_list_available_devices", arguments: {} });
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content[0].text).devices[0].platform).toBe("harmonyos");
		expect(JSON.parse(result.content[0].text).warnings[0]).toContain("adb unavailable");
	});
});

test("batches coordinate tap, Chinese input and submit through HDC", async () => {
	const calls: string[][] = [];
	const base = Hdc.prototype.shell;
	Hdc.prototype.shell = function(target, args) {
		calls.push(args);
		return base.call(this, target, args);
	};
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_batch_commands", arguments: {
			device: "harmony:MATE60",
			steps: [
				{ name: "mobile_click_on_screen_at_coordinates", arguments: { x: 10, y: 20 } },
				{ name: "mobile_type_keys", arguments: { text: "你好，鸿蒙！🙂", submit: true } },
			],
			listElementsAtEnd: true,
		} });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).not.toContain("failed:");
		expect(result.content[0].text).toContain('text="搜索"');
		expect(calls).toContainEqual(["uitest", "uiInput", "text", "你好，鸿蒙！🙂"]);
		expect(calls).toContainEqual(["uitest", "uiInput", "keyEvent", "2054"]);
	});
});

test("returns actual PNG content and saves it without pretending it is JPEG", async () => {
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=", "base64");
	Hdc.prototype.executeCommand = args => {
		if (args[0] === "list") {
			return Buffer.from("MATE60\n");
		}

		if (args[2] === "file" && args[3] === "recv") {
			fs.writeFileSync(args[5], png);
			return Buffer.from("");
		}

		throw new Error(`Unexpected HDC command: ${args.join(" ")}`);
	};
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-harmony-test-"));
	try {
		await withClient(async client => {
			const result: any = await client.callTool({ name: "mobile_take_screenshot", arguments: { device: "harmony:MATE60" } });
			expect(result.isError).not.toBe(true);
			expect(result.content.find((item: any) => item.type === "image")).toMatchObject({ mimeType: "image/png", data: png.toString("base64") });
			const saveTo = path.join(directory, "中文截图.png");
			const saved: any = await client.callTool({ name: "mobile_save_screenshot", arguments: { device: "harmony:MATE60", saveTo } });
			expect(saved.isError).not.toBe(true);
			expect(fs.readFileSync(saveTo)).toEqual(png);
			const wrong: any = await client.callTool({ name: "mobile_save_screenshot", arguments: { device: "harmony:MATE60", saveTo: path.join(directory, "wrong.jpg") } });
			expect(wrong.isError).toBe(true);
			expect(fs.existsSync(path.join(directory, "wrong.jpg"))).toBe(false);
		});
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("accepts a local HAP, transfers it to the selected device and invokes bm install", async () => {
	const calls: string[][] = [];
	const execute = Hdc.prototype.executeCommand;
	const shell = Hdc.prototype.shell;
	Hdc.prototype.executeCommand = function(args) {
		calls.push(args);
		return args[2] === "file" ? Buffer.from("") : execute.call(this, args);
	};
	Hdc.prototype.shell = function(target, args) {
		calls.push(args);
		return shell.call(this, target, args);
	};
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-hap-test-"));
	try {
		const hap = path.join(directory, "测试.hap");
		fs.writeFileSync(hap, "mock HAP fixture; no device install");
		await withClient(async client => {
			const result: any = await client.callTool({ name: "mobile_install_app", arguments: { device: "harmony:MATE60", path: hap } });
			expect(result.isError).not.toBe(true);
		});
		const transfer = calls.find(args => args[2] === "file" && args[3] === "send")!;
		expect(transfer.slice(0, 5)).toEqual(["-t", "MATE60", "file", "send", hap]);
		expect(calls).toContainEqual(["bm", "install", "-p", transfer[5]]);
		expect(calls).toContainEqual(["rm", "-f", transfer[5]]);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("uses the native long-press duration only when duration was omitted", async () => {
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_long_press_on_screen_at_coordinates", arguments: { device: "harmony:MATE60", x: 20, y: 30 } });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toContain("platform default duration");
		const custom: any = await client.callTool({ name: "mobile_long_press_on_screen_at_coordinates", arguments: { device: "harmony:MATE60", x: 20, y: 30, duration: 500 } });
		expect(custom.isError).toBe(true);
		expect(custom.content[0].text).toMatch(/uinput/);
	});
});


test("reports the focused HarmonyOS bundle and Ability over MCP", async () => {
	const original = Hdc.prototype.shell;
	Hdc.prototype.shell = function(target, args) {
		if (args[0] === "hidumper") {
			return "Focus window: 91\n";
		}

		if (args[0] === "cat") {
			return JSON.stringify({ attributes: { hostWindowId: "91", bundleName: "com.example.notes", abilityName: "EntryAbility" } });
		}

		return original.call(this, target, args);
	};
	await withClient(async client => {
		const result: any = await client.callTool({ name: "mobile_get_foreground_app", arguments: { device: "harmony:MATE60" } });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toBe("Foreground app: com.example.notes (com.example.notes), activity: EntryAbility");
	});
});

test("connects and disconnects an explicit network device through MCP", async () => {
	let connected = false;
	Hdc.prototype.executeCommand = args => {
		if (args[0] === "tconn") {
			expect(args[1]).toBe("192.168.1.10:5555");
			connected = true;
		} else if (args[0] === "tdisconn") {
			expect(args[1]).toBe("192.168.1.10:5555");
			connected = false;
		}

		return Buffer.from(args[0] === "list" ? (connected ? "192.168.1.10:5555" : "[Empty]") : "");
	};
	await withClient(async client => {
		for (const name of ["mobile_connect_harmony_device", "mobile_disconnect_harmony_device"]) {
			const result: any = await client.callTool({ name, arguments: { address: "192.168.1.10:5555" } });
			expect(result.isError).not.toBe(true);
			expect(result.content[0].text).toContain("harmony:192.168.1.10:5555");
		}
	});
	expect(connected).toBe(false);
});

test("supports a JPEG-only capture fallback without mislabelling saved PNG files", async () => {
	const jpeg = fs.readFileSync(path.join(__dirname, "fixtures", "baseline.jpg"));
	const original = Hdc.prototype.shell;
	Hdc.prototype.shell = function(target, args) {
		if (args[0] === "uitest" || args[0] === "snapshot_display") {
			throw new Error("capture method unavailable");
		}

		return original.call(this, target, args);
	};
	Hdc.prototype.executeCommand = args => {
		if (args[0] === "list") {
			return Buffer.from("MATE60");
		}

		fs.writeFileSync(args[5], jpeg);
		return Buffer.from("");
	};
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-jpeg-test-"));
	try {
		await withClient(async client => {
			const image: any = await client.callTool({ name: "mobile_take_screenshot", arguments: { device: "harmony:MATE60" } });
			expect(image.isError).not.toBe(true);
			expect(image.content.find((item: any) => item.type === "image").mimeType).toBe("image/jpeg");
			const jpg = path.join(directory, "capture.jpg");
			const saved: any = await client.callTool({ name: "mobile_save_screenshot", arguments: { device: "harmony:MATE60", saveTo: jpg } });
			expect(saved.isError).not.toBe(true);
			expect(fs.readFileSync(jpg)).toEqual(jpeg);
			const png = path.join(directory, "wrong.png");
			const wrong: any = await client.callTool({ name: "mobile_save_screenshot", arguments: { device: "harmony:MATE60", saveTo: png } });
			expect(wrong.isError).toBe(true);
			expect(fs.existsSync(png)).toBe(false);
		});
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("lists and reads HarmonyOS crash reports through MCP", async () => {
	const id = "jscrash-com.example.notes-10001-20261029123456123.log";
	Hdc.prototype.shellChecked = (_target, args) => args[0] === "find" ? `/data/log/faultlog/faultlogger/${id}` : "Error: 中文崩溃\n";
	await withClient(async client => {
		const listed: any = await client.callTool({ name: "mobile_list_crashes", arguments: { device: "harmony:MATE60" } });
		expect(listed.isError).not.toBe(true);
		expect(JSON.parse(listed.content[0].text)[0]).toMatchObject({ id, processName: "com.example.notes" });
		const report: any = await client.callTool({ name: "mobile_get_crash", arguments: { device: "harmony:MATE60", id } });
		expect(report.isError).not.toBe(true);
		expect(report.content[0].text).toBe("Error: 中文崩溃\n");
		Hdc.prototype.shellChecked = () => { throw new Error("permission denied"); };
		const denied: any = await client.callTool({ name: "mobile_list_crashes", arguments: { device: "harmony:MATE60" } });
		expect(denied.isError).toBe(true);
		expect(denied.content[0].text).toContain("permission denied");
	});
});

test("starts and collects native recording across HTTP-style server instances", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-record-protocol-"));
	const originalPath = process.env.HARMONY_RECORDER_PATH;
	const originalSize = HarmonyRobot.prototype.getScreenSize;
	const device = "harmony:192.168.1.5:5555";
	const output = path.join(directory, "record.mp4");
	const box = (type: string) => {
		const result = Buffer.alloc(12);
		result.writeUInt32BE(12);
		result.write(type, 4);
		return result;
	};
	// Only a synthetic MP4 container; device video decoding remains hardware QA.
	const mp4 = Buffer.concat([box("ftyp"), box("moov"), box("mdat")]);
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(), stderr: new PassThrough(),
		kill() { queueMicrotask(() => child.emit("close", -1)); return true; },
	});
	process.env.HARMONY_RECORDER_PATH = path.join(directory, "mock-recorder");
	fs.writeFileSync(process.env.HARMONY_RECORDER_PATH, "mock only");
	HarmonyRobot.prototype.getScreenSize = async () => ({ width: 1080, height: 2400, scale: 1 });
	Hdc.prototype.executeCommand = args => {
		if (args[0] === "list") {
			return Buffer.from("192.168.1.5:5555");
		}

		if (args[2] === "file" && args[3] === "recv") {
			fs.writeFileSync(args[5], mp4);
		}

		return Buffer.from("");
	};
	Hdc.prototype.spawnShell = () => {
		queueMicrotask(() => child.stdout.write('{"event":"started","pid":123}\n'));
		return child as unknown as ChildProcess;
	};
	Hdc.prototype.shellChecked = (_target, args) => {
		if (args[0] === "touch") {
			queueMicrotask(() => {
				child.stdout.write(JSON.stringify({ event: "stopped", bytes: mp4.length }) + "\n");
				child.emit("close", 0);
			});
		}

		return "";
	};
	const robotCache = new Map<string, Robot>();
	try {
		await withClient(async client => {
			const started: any = await client.callTool({ name: "mobile_start_screen_recording", arguments: { device, output, timeLimit: 10 } });
			expect(started.isError).not.toBe(true);
			expect(started.content[0].text).toContain("recording started");
		}, robotCache);
		await withClient(async client => {
			const disconnect: any = await client.callTool({ name: "mobile_disconnect_harmony_device", arguments: { address: "192.168.1.5:5555" } });
			expect(disconnect.isError).toBe(true);
			expect(disconnect.content[0].text).toContain("Collect the HarmonyOS recording");
			const stopped: any = await client.callTool({ name: "mobile_stop_screen_recording", arguments: { device } });
			expect(stopped.isError).not.toBe(true);
			expect(stopped.content[0].text).toContain(output);
			expect(fs.readFileSync(output)).toEqual(mp4);
		}, robotCache);
	} finally {
		HarmonyRobot.prototype.getScreenSize = originalSize;
		if (originalPath === undefined) {
			delete process.env.HARMONY_RECORDER_PATH;
		} else {
			process.env.HARMONY_RECORDER_PATH = originalPath;
		}

		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("routes orientation and named fold posture through the HarmonyOS display service", async () => {
	const original = HarmonyRobot.prototype.getOrientation;
	let current: "portrait" | "landscape" = "portrait";
	HarmonyRobot.prototype.getOrientation = async () => current;
	Hdc.prototype.shellChecked = (_target, args) => {
		if (args[0] === "param") {
			return "true";
		}

		if (args[4] === "-h") {
			return " -motion set sensor\n -y expand\n";
		}

		if (args[4] === "-motion,1") {
			current = "landscape";
			return "";
		}

		return "currentFoldStatus is: 1\n";
	};
	try {
		await withClient(async client => {
			const orientation: any = await client.callTool({ name: "mobile_set_orientation", arguments: { device: "harmony:MATE60", orientation: "landscape" } });
			expect(orientation.isError).not.toBe(true);
			expect(current).toBe("landscape");
			const fold: any = await client.callTool({ name: "mobile_fold_device", arguments: { device: "harmony:MATE60", posture: "open" } });
			expect(fold.isError).not.toBe(true);
			const angle: any = await client.callTool({ name: "mobile_fold_device", arguments: { device: "harmony:MATE60", angle: 90 } });
			expect(angle.isError).toBe(true);
		});
	} finally {
		HarmonyRobot.prototype.getOrientation = original;
	}
});

test("reads, clears and verifies the HarmonyOS clipboard through MCP", async () => {
	let clipboard = "中文剪贴板🙂\n";
	Hdc.prototype.shellChecked = (_target, args) => {
		if (args[1] === "clear-data") {
			clipboard = "";
			return JSON.stringify({ type: "result", status: "success", data: {} });
		}

		return JSON.stringify({ type: "result", status: "success", data: { recordCount: 1, records: [{ mimeType: "text/plain", plainText: clipboard }] } });
	};
	await withClient(async client => {
		const read: any = await client.callTool({ name: "mobile_clipboard", arguments: { device: "harmony:MATE60" } });
		expect(read.isError).not.toBe(true);
		expect(read.content[0].text).toBe(clipboard);
		const clear: any = await client.callTool({ name: "mobile_clipboard", arguments: { device: "harmony:MATE60", text: "" } });
		expect(clear.isError).not.toBe(true);
		expect(clipboard).toBe("");
		Hdc.prototype.shellChecked = () => JSON.stringify({ type: "result", status: "failed", errCode: "ERR_PERMISSION_DENIED", errMsg: "no read permission" });
		const denied: any = await client.callTool({ name: "mobile_clipboard", arguments: { device: "harmony:MATE60" } });
		expect(denied.isError).toBe(true);
		expect(denied.content[0].text).toContain("ERR_PERMISSION_DENIED");
	});
});

test("sets and clears a persistent location across HTTP-style MCP requests", async () => {
	const original = process.env.HARMONY_LOCATION_COMMAND;
	process.env.HARMONY_LOCATION_COMMAND = "/system/bin/mobile-mcp-location";
	const device = "harmony:192.168.1.6:5555";
	const cache = new Map<string, Robot>();
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(), stderr: new PassThrough(),
		kill() { queueMicrotask(() => child.emit("close", -1)); return true; },
	});
	Hdc.prototype.executeCommand = () => Buffer.from("192.168.1.6:5555");
	Hdc.prototype.spawnShell = (target, args) => {
		expect(target).toBe("192.168.1.6:5555");
		expect(args.slice(0, 4)).toEqual(["/system/bin/mobile-mcp-location", "run", "31.2", "121.5"]);
		queueMicrotask(() => child.stdout.write('{"event":"started","latitude":31.2,"longitude":121.5}\n'));
		return child as unknown as ChildProcess;
	};
	Hdc.prototype.shellChecked = (_target, args) => {
		if (args[0] === "touch") {
			queueMicrotask(() => {
				child.stdout.write('{"event":"cleared","code":0}\n');
				child.emit("close", 0);
			});
		}

		return "";
	};
	try {
		await withClient(async client => {
			const set: any = await client.callTool({ name: "mobile_set_location", arguments: { device, latitude: 31.2, longitude: 121.5 } });
			expect(set.isError).not.toBe(true);
			expect(set.content[0].text).toContain("31.2,121.5");
		}, cache);
		await withClient(async client => {
			const disconnect: any = await client.callTool({ name: "mobile_disconnect_harmony_device", arguments: { address: "192.168.1.6:5555" } });
			expect(disconnect.isError).toBe(true);
			expect(disconnect.content[0].text).toContain("Clear the HarmonyOS mock location");
			const clear: any = await client.callTool({ name: "mobile_set_location", arguments: { device } });
			expect(clear.isError).not.toBe(true);
			expect(clear.content[0].text).toBe("Cleared location override");
		}, cache);
		expect((cache.get(device) as HarmonyRobot).hasLocationOverride()).toBe(false);
	} finally {
		if (original === undefined) { delete process.env.HARMONY_LOCATION_COMMAND; } else { process.env.HARMONY_LOCATION_COMMAND = original; }
	}
});

test("executes an explicit-duration long press by element ref and expires that ref", async () => {
	Hdc.prototype.shellChecked = (_target, args) => args[1] === "-?"
		? "-T --touch\n-d x y\n-u x y\n-i time\n"
		: "touch down 60 50\ntouch up 60 50\n";
	await withClient(async client => {
		await client.callTool({ name: "mobile_list_elements_on_screen", arguments: { device: "harmony:MATE60" } });
		const result: any = await client.callTool({ name: "mobile_long_press_on_screen_at_coordinates", arguments: { device: "harmony:MATE60", ref: "@h1e1", duration: 1200 } });
		expect(result.isError).not.toBe(true);
		expect(result.content[0].text).toContain("1200ms");
		const stale: any = await client.callTool({ name: "mobile_click_on_screen_at_coordinates", arguments: { device: "harmony:MATE60", ref: "@h1e1" } });
		expect(stale.isError).toBe(true);
		expect(stale.content[0].text).toContain("stale");
	});
});

test("manages HarmonyOS application lifecycle through MCP", async () => {
	const installed = new Set(["com.example.notes", "com.example.calendar"]);
	let foreground = "";
	const original = Hdc.prototype.shell;
	Hdc.prototype.shell = function(target, args) {
		if (args[0] === "bm" && args[1] === "dump") {
			return "Bundle list:\n" + [...installed].join("\n");
		}

		if (args[0] === "aa" && args[1] === "start") {
			if (!installed.has(args[3]) || args[5] !== "EntryAbility") { throw new Error("ability unavailable"); }
			foreground = args[3];
			return "start ability successfully.";
		}

		if (args[0] === "aa" && args[1] === "force-stop") {
			if (foreground === args[2]) { foreground = ""; }
			return "force stop process successfully.";
		}

		if (args[0] === "bm" && args[1] === "uninstall") {
			installed.delete(args[3]);
			return "uninstall bundle successfully.";
		}

		return original.call(this, target, args);
	};
	await withClient(async client => {
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const result: any = await client.callTool({ name, arguments: { device: "harmony:MATE60", ...args } });
			expect(result.isError, name).not.toBe(true);
			return result.content[0].text as string;
		};
		expect(await call("mobile_list_apps")).toContain("com.example.notes");
		await call("mobile_launch_app", { packageName: "com.example.notes/EntryAbility" });
		expect(foreground).toBe("com.example.notes");
		await call("mobile_terminate_app", { packageName: "com.example.notes" });
		expect(foreground).toBe("");
		await call("mobile_uninstall_app", { packageName: "com.example.notes" });
		const remaining = await call("mobile_list_apps");
		expect(remaining).not.toContain("com.example.notes");
		expect(remaining).toContain("com.example.calendar");
	});
});
