import { Hdc } from "./hdc";
import { ActionableError } from "./robot";

const CRASH_DIRECTORY = "/data/log/faultlog/faultlogger";

export interface HarmonyCrash {
	id: string;
	processName: string;
	timestamp: string;
	type: string;
}

export const parseHarmonyCrashName = (id: string): HarmonyCrash | undefined => {
	const match = /^(cppcrash|jscrash|rustpanic|cjerror)-([^/\\\r\n\0]+)-(\d+)-(\d{14}(?:\d{3})?)\.log$/.exec(id);
	if (!match) {
		return undefined;
	}

	// The filename encodes device-local wall time, not UTC. Keep it unzoned.
	const [, type, processName, , stamp] = match;
	const timestamp = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}${stamp.length === 17 ? "." + stamp.slice(14) : ""}`;
	return { id, type, processName, timestamp };
};

export class HarmonyCrashes {
	constructor(private hdc: Hdc, private target: string) { }

	public list(): HarmonyCrash[] {
		const output = this.hdc.shellChecked(this.target, ["find", CRASH_DIRECTORY, "-maxdepth", "1", "-type", "f", "-print"]);
		const reports = new Map<string, HarmonyCrash>();
		for (const line of output.split(/\r?\n/)) {
			if (!line.startsWith(CRASH_DIRECTORY + "/")) {
				continue;
			}

			const parsed = parseHarmonyCrashName(line.slice(CRASH_DIRECTORY.length + 1));
			if (parsed) {
				reports.set(parsed.id, parsed);
			}
		}

		return [...reports.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
	}

	public read(id: string): string {
		if (!parseHarmonyCrashName(id)) {
			throw new ActionableError("Invalid HarmonyOS crash report id. Use mobile_list_crashes to obtain a report id");
		}

		if (!this.list().some(report => report.id === id)) {
			throw new ActionableError("The HarmonyOS crash report is no longer available as a regular file. Refresh mobile_list_crashes");
		}

		// Recheck the final component immediately before reading. No user-provided
		// paths are accepted; all reports live in the fixed system log directory.
		const file = CRASH_DIRECTORY + "/" + id;
		const script = 'test ! -L "$1" && test -f "$1" && cat "$1"';
		return this.hdc.shellChecked(this.target, ["sh", "-c", script, "mcp-crash-read", file]);
	}
}
