import { StringDecoder } from "node:string_decoder";
import { Hdc } from "./hdc";
import { ActionableError } from "./robot";

const LEVELS: Record<string, string> = { D: "DEBUG", I: "INFO", W: "WARN", E: "ERROR", F: "FATAL" };
const normalizeLevel = (value: string): string => LEVELS[value.toUpperCase()] || value.toUpperCase();

export const parseHilogLine = (raw: string): Record<string, string> => {
	// hilog -v epoch prints seconds since 1970 followed by pid/tid/level/domain/tag.
	const match = /^\s*(\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)\s+([DIWEF])\s+([^/\s]+)\/([^:]+):\s?(.*)$/.exec(raw);
	if (!match) {
		// Keep continuation lines and unfamiliar firmware formats visible.
		return { message: raw, raw };
	}

	const [, timestamp, pid, tid, level, subsystem, tag, message] = match;
	return { timestamp, pid, tid, level: normalizeLevel(level), subsystem, tag: tag.trim(), message, raw };
};

export const collectHarmonyLogs = (hdc: Hdc, target: string, limit: number, filters: string[], timeoutMs: number): Promise<string> => {
	const predicates = filters.map(filter => {
		const match = /^(pid|tag|level|subsystem|message)(!?=)(.+)$/.exec(filter);
		if (!match) {
			throw new ActionableError("HarmonyOS log filters support pid, tag, level, subsystem (HiLog domain), and message; process/category filters are not available");
		}

		const [, key, operator, value] = match;
		return (entry: Record<string, string>): boolean => {
			if (entry[key] === undefined) {
				return false;
			}

			const actual = (key === "level" ? normalizeLevel(entry[key]) : entry[key]).toLowerCase();
			const expected = (key === "level" ? normalizeLevel(value) : value).toLowerCase();
			const matches = key === "message" ? actual.includes(expected) : actual === expected;
			return operator === "!=" ? !matches : matches;
		};
	});
	if (!Number.isInteger(limit) || limit < 1 || limit > 10000 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new ActionableError("Invalid HarmonyOS log limit or timeout");
	}

	return new Promise((resolve, reject) => {
		const child = hdc.spawnShell(target, ["hilog", "-v", "epoch"]);
		const decoder = new StringDecoder("utf8");
		const entries: string[] = [];
		let pending = "";
		let stderr = "";
		let bytes = 0;
		let finished = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (finished) {
				return;
			}

			finished = true;
			clearTimeout(timer);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						child.kill("SIGKILL");
					}
				}, 500);
				killTimer.unref();
			}

			if (error) {
				reject(error);
			} else {
				resolve(entries.join("\n"));
			}
		};
		const timer = setTimeout(() => finish(), timeoutMs);
		const line = (raw: string) => {
			if (!raw || finished) {
				return;
			}

			if (/^\s*(?:\[Fail\]|error:|usage:|unknown command)/i.test(raw)) {
				finish(new ActionableError(`HiLog failed: ${raw}`));
				return;
			}

			const entry = parseHilogLine(raw);
			if (predicates.every(predicate => predicate(entry))) {
				entries.push(JSON.stringify(entry));
				if (entries.length >= limit) {
					finish();
				}
			}
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (finished) {
				return;
			}

			bytes += chunk.length;
			if (bytes > 8 * 1024 * 1024) {
				finish(new ActionableError("HiLog exceeded the 8 MiB collection limit; use a shorter timeout or narrower filters"));
				return;
			}

			pending += decoder.write(chunk);
			const lines = pending.split(/\r?\n/);
			pending = lines.pop()!;
			lines.forEach(line);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-8192);
			if (/\[Fail\]|permission denied|not found|error:/i.test(stderr)) {
				finish(new ActionableError(`HiLog failed: ${stderr.trim()}`));
			}
		});
		child.on("error", error => finish(new ActionableError(`Cannot start HiLog; check HDC_PATH and USB debugging: ${error.message}`)));
		child.on("close", code => {
			clearTimeout(killTimer);
			if (finished) {
				return;
			}

			if (code !== 0) {
				finish(new ActionableError(`HiLog exited with code ${code}: ${stderr.trim()}`));
				return;
			}

			line(pending + decoder.end());
			finish();
		});
	});
};
