import fs from "node:fs";
import path from "node:path";
import { Hdc } from "./hdc";
import { Robot } from "./robot";
import { checkGestureSupport, gestureSequenceSchema } from "./harmony-gestures";

export type CapabilityState = "available" | "unavailable" | "unknown";
export interface CapabilityCheck { state: CapabilityState; evidence: string }
export interface CapabilityReport {
	device: string; checkedAt: string; probeReads: boolean;
	connection: CapabilityCheck;
	metadata: Record<string, CapabilityCheck>;
	commands: Record<string, CapabilityCheck>;
	features: Record<string, CapabilityCheck>;
	permissions: Record<string, CapabilityCheck>;
	components: Record<string, CapabilityCheck>;
	limitations: string[];
}
const check = (state: CapabilityState, evidence: string): CapabilityCheck => ({ state, evidence });
const unknown = (reason = "Not exercised; command presence does not establish operation permission") => check("unknown", reason);
const executablePattern = /^(?:\/[^\0\r\n]+|[a-zA-Z0-9_][a-zA-Z0-9_.-]*)$/;
export function probeExecutable(hdc: Hdc, target: string, executable: string): CapabilityCheck {
	if (!executablePattern.test(executable)) { return check("unavailable", "Invalid executable configuration; expected one command name or absolute device path"); }
	try {
		const script = 'mcp_executable=$(command -v "$1" 2>/dev/null); if [ -n "$mcp_executable" ] && [ -f "$mcp_executable" ] && [ -x "$mcp_executable" ]; then printf "available"; else printf "unavailable"; fi';
		const output = hdc.shellChecked(target, ["sh", "-c", script, "mcp-capability", executable], 5000).trim();
		return output === "available" ? check("available", `${executable} resolves in the device shell; system-service permission is untested`) : output === "unavailable" ? check("unavailable", `${executable} cannot be resolved in the device shell`) : unknown("Unrecognized executable probe response");
	} catch (error: any) { return unknown(`Executable probe failed: ${error.message}`); }
}
export function inspectRecorderFile(filename = process.env.HARMONY_RECORDER_PATH): CapabilityCheck {
	if (!filename) { return check("unavailable", "HARMONY_RECORDER_PATH is not configured"); }
	if (!path.isAbsolute(filename)) { return check("unavailable", "HARMONY_RECORDER_PATH must be absolute"); }
	let fd: number | undefined;
	try {
		if (!fs.statSync(filename).isFile()) { return check("unavailable", "Recorder path is not a regular file"); }
		fd = fs.openSync(filename, "r");
		const header = Buffer.alloc(64); const count = fs.readSync(fd, header, 0, header.length, 0);
		if (count < 64 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 183) {
			return check("unavailable", "Recorder is not a readable little-endian AArch64 ELF64 binary");
		}
		return check("available", "Host recorder ELF64/AArch64 file is present; device deployment, linking and authorization are unverified");
	} catch (error: any) { return check("unavailable", `Host recorder cannot be read: ${error.message}`); } finally { if (fd !== undefined) { fs.closeSync(fd); } }
}

export async function inspectHarmonyCapabilities(hdc: Hdc, target: string, robot: Robot & { listCrashes?: () => unknown }, probeReads = false): Promise<CapabilityReport> {
	const report: CapabilityReport = {
		device: `harmony:${target}`, checkedAt: new Date().toISOString(), probeReads, connection: unknown(), metadata: {}, commands: {}, features: {}, permissions: {},
		components: { recorderHostFile: inspectRecorderFile(), recorderDeviceDeployment: unknown("Self-check does not upload or execute the recorder"), locationDeviceCommand: unknown(), pasteboardDeviceCommand: unknown() },
		limitations: ["Read permission is scoped to the successful read at this time; write/input permission stays unknown until tested", "No taps, text input, clipboard writes, orientation changes, recording, installation or mock-location changes are performed", "Read probes may capture the screen and read clipboard/log data; content is not included in this report"],
	};
	const commandNames = ["uitest", "uinput", "snapshot_display", "screenshot", "bm", "aa", "hilog", "hidumper", "param", "find"];
	const operationNames = ["ui.read", "screenshot.read", "apps.read", "clipboard.read", "logs.read", "crashes.read", "foreground.read", "input.write", "clipboard.write", "orientation.write", "fold.write", "apps.install", "recording.start", "location.mock"];
	for (const name of commandNames) { report.commands[name] = unknown(); }
	for (const name of operationNames) { report.permissions[name] = unknown(); }
	for (const name of ["textInput", "drag", "pinch", "appLabels", "orientation", "fold"]) { report.features[name] = unknown(); }
	try {
		const version = hdc.shellChecked(target, ["param", "get", "const.ohos.fullname"], 5000).trim();
		if (!version || /^(?:usage|error|failed|unknown)\b/i.test(version)) { throw new Error("No valid system version response"); }
		report.connection = check("available", "A checked device shell read completed");
		report.metadata.systemVersion = check("available", version);
	} catch (error: any) {
		report.connection = unknown(`Device shell read failed: ${error.message}`);
		return report;
	}
	for (const [name, key] of [["model", "const.product.model"], ["developerMode", "const.security.developermode.state"]]) {
		try { const value = hdc.shellChecked(target, ["param", "get", key], 5000).trim(); report.metadata[name] = value ? check("available", value) : unknown("No value reported"); } catch (error: any) { report.metadata[name] = unknown(error.message); }
	}
	for (const name of commandNames) { report.commands[name] = probeExecutable(hdc, target, name); }
	report.components.pasteboardDeviceCommand = probeExecutable(hdc, target, process.env.HARMONY_PASTEBOARD_COMMAND || "/system/bin/cli_tool/executable/ohos-pasteboard");
	report.components.locationDeviceCommand = process.env.HARMONY_LOCATION_COMMAND ? probeExecutable(hdc, target, process.env.HARMONY_LOCATION_COMMAND) : check("unavailable", "HARMONY_LOCATION_COMMAND is not configured");
	const help = (args: string[]): string | undefined => {
		try { return hdc.shell(target, args, 5000); } catch { return undefined; }
	};
	if (report.commands.uitest.state === "available") {
		const text = help(["uitest", "uiInput", "-h"]);
		if (text) { report.features.textInput = /\btext\b/.test(text) ? check("available", "UITest help advertises text input; actual input permission untested") : unknown("UITest help did not establish text support"); }
	}
	if (report.commands.uinput.state === "available") {
		const raw = help(["uinput", "-?"]);
		const heading = raw ? /^\s*-T\s+--touch[^\r\n]*$/m.exec(raw) : null;
		const touch = heading && raw ? raw.slice(heading.index + heading[0].length).split(/\r?\n\s*(?:-[A-Z]\s|The option are:)/)[0] : undefined;
		if (touch) {
			for (const [name, step] of Object.entries({ drag: { kind: "drag", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, pinch: { kind: "pinch", center: { x: 10, y: 10 }, startDistance: 2, endDistance: 4 } })) {
				try { checkGestureSupport(gestureSequenceSchema.parse([step]), touch); report.features[name] = check("available", "Touch command syntax advertised; injection permission untested"); } catch { report.features[name] = check("unavailable", "Required touch syntax is not advertised by this device version"); }
			}
		}
	}
	if (report.commands.bm.state === "available") {
		const text = help(["bm", "dump", "-h"]);
		if (text) { report.features.appLabels = /--label\b/.test(text) ? check("available", "bm help advertises label queries; resolved names unverified") : unknown("bm help did not establish label support"); }
	}
	if (report.commands.hidumper.state === "available") {
		const text = help(["hidumper", "-s", "DisplayManagerService", "-a", "-h"]);
		if (text) {
			report.features.orientation = /-motion\b/.test(text) ? check("available", "Display service advertises orientation injection; permission untested") : unknown("Orientation syntax not established");
			report.features.fold = ["-p", "-z", "-y"].every(flag => text.includes(flag)) ? check("available", "Named fold commands advertised; foldable hardware and permission unverified") : unknown("Fold syntax not established");
		}
	}
	if (probeReads) {
		const probes: Record<string, () => Promise<unknown> | unknown> = {
			"ui.read": () => robot.getElementsOnScreen(), "screenshot.read": () => robot.getScreenshot(), "apps.read": () => robot.listApps(),
			"clipboard.read": () => { if (!robot.getClipboard) { throw new Error("No clipboard reader"); } return robot.getClipboard(); },
			"logs.read": () => { if (!robot.getLogs) { throw new Error("No log reader"); } return robot.getLogs(1, [], 1000); },
			"crashes.read": () => { if (!robot.listCrashes) { throw new Error("No crash reader"); } return robot.listCrashes(); },
			"foreground.read": () => { if (!robot.getForegroundApp) { throw new Error("No foreground reader"); } return robot.getForegroundApp(); },
		};
		for (const [name, probe] of Object.entries(probes)) {
			try { await probe(); report.permissions[name] = check("available", "This read operation succeeded during the probe; content omitted"); } catch (error: any) {
				const denied = /permission denied|not permitted|EACCES|ERR_PERMISSION_DENIED/i.test(error.message);
				report.permissions[name] = check(denied ? "unavailable" : "unknown", `Read probe failed: ${error.message}`);
			}
		}
	}
	return report;
}
