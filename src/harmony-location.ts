import crypto from "node:crypto";
import { ChildProcess } from "node:child_process";
import { Hdc } from "./hdc";
import { ActionableError } from "./robot";

interface LocationSession {
	command: string;
	control: string;
	child: ChildProcess;
	done: Promise<void>;
	closed: boolean;
	cleared: boolean;
	terminal: boolean;
	stop: () => void;
}

export class HarmonyLocation {
	private current?: LocationSession;
	private queue: Promise<void> = Promise.resolve();
	private pending = 0;

	constructor(private hdc: Hdc, private target: string,
		private timeouts = { startup: 10000, stop: 10000 }) { }

	public isBusy(): boolean { return this.current !== undefined || this.pending > 0; }

	private executable(): string {
		const command = process.env.HARMONY_LOCATION_COMMAND;
		if (!command || !/^(?:\/[^\0\r\n]+|[a-zA-Z0-9_][a-zA-Z0-9_.-]*)$/.test(command)) {
			throw new ActionableError("Set HARMONY_LOCATION_COMMAND to the authorized device-side mock-location component. A normal shell token may lack system/MOCK_LOCATION permission");
		}

		return command;
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		this.pending++;
		const result = this.queue.then(operation).finally(() => { this.pending--; });
		this.queue = result.catch(() => {});
		return result;
	}

	public set(latitude: number, longitude: number): Promise<void> {
		if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
			return Promise.reject(new ActionableError("Invalid HarmonyOS mock coordinates"));
		}

		return this.enqueue(async () => {
			const command = this.executable();
			if (this.current) {
				await this.clearCurrent();
			}

			await this.start(command, latitude, longitude);
		});
	}

	public clear(): Promise<void> {
		return this.enqueue(async () => {
			if (this.current) {
				await this.clearCurrent();
			} else {
				this.clearStandalone(this.executable());
			}
		});
	}

	private clearStandalone(command: string): void {
		const output = this.hdc.shellChecked(this.target, [command, "clear"]);
		let result: any;
		try { result = JSON.parse(output); } catch {
			throw new ActionableError("Mock-location cleanup returned invalid JSON; cleanup is not confirmed");
		}

		if (result?.event !== "cleared" || result.code !== 0) {
			throw new ActionableError("Mock-location cleanup was not confirmed by the device");
		}
	}

	private async clearCurrent(): Promise<void> {
		const session = this.current!;
		session.stop();
		try {
			await session.done;
		} catch {
			// A crashed/disconnected helper may have left mock mode enabled.
			// Only an explicit successful Disable operation establishes cleanup.
			this.clearStandalone(process.env.HARMONY_LOCATION_COMMAND ? this.executable() : session.command);
			if (!session.terminal) {
				let receipt: any;
				try {
					receipt = JSON.parse(this.hdc.shellChecked(this.target, ["sh", "-c", 'test ! -L "$1" && test -f "$1" && cat "$1"', "mcp-location-receipt", session.control + ".done"]));
				} catch { /* no reliable terminal receipt */ }
				if (!(receipt?.event === "cleared" && receipt.code === 0) &&
					!(receipt?.event === "error" && Number.isInteger(receipt.code) && Number.isInteger(receipt.clearCode))) {
					throw new ActionableError("Mock mode was disabled, but the previous publisher's termination is unconfirmed. Retry clearing after reconnecting; a new session will not start yet");
				}

				session.terminal = true;
			}
		}

		if (session.terminal) {
			try { this.hdc.shellChecked(this.target, ["rm", "-f", session.control, session.control + ".done"]); } catch { /* retain harmless stop markers */ }
		}
		// On abnormal termination retain the stop marker for any surviving helper.
		this.current = undefined;
	}

	private start(command: string, latitude: number, longitude: number): Promise<void> {
		const control = `/data/local/tmp/mobile-mcp-location-${crypto.randomUUID()}.stop`;
		const child = this.hdc.spawnShell(this.target, [command, "run", `${latitude}`, `${longitude}`, control]);
		let resolveStart: () => void;
		let rejectStart: (error: Error) => void;
		const started = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
		let resolveDone: () => void;
		let rejectDone: (error: Error) => void;
		const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
		done.catch(() => {});
		let ready = false;
		let problem: Error | undefined;
		let buffer = "";
		let stderr = "";
		let stopTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const session: LocationSession = {
			command, control, child, done, closed: false, cleared: false, terminal: false,
			stop: () => {
				if (session.closed || stopTimer) { return; }
				try { this.hdc.shellChecked(this.target, ["touch", control]); } catch (error: any) {
					problem ??= new ActionableError(`Cannot request mock-location stop: ${error.message}`);
				}
				stopTimer = setTimeout(() => {
					problem ??= new ActionableError("Mock-location helper exceeded the stop deadline");
					child.kill("SIGTERM");
					killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(-1); }, 1000);
				}, this.timeouts.stop);
			},
		};
		this.current = session;
		const startup = setTimeout(() => fail("Mock-location startup/readback timed out; check USB connection, developer mode and permissions"), this.timeouts.startup);
		const fail = (message: string) => {
			problem ??= new ActionableError(message);
			rejectStart(problem);
			session.stop();
		};
		const finish = (code: number | null) => {
			if (session.closed) { return; }
			session.closed = true;
			clearTimeout(startup);
			clearTimeout(stopTimer);
			clearTimeout(killTimer);
			if (code !== 0 || !session.cleared || problem) {
				const error = problem || new ActionableError(`Mock-location helper exited without confirmed cleanup (exit ${code}). ${stderr}`);
				rejectStart(error);
				rejectDone(error);
			} else {
				if (!ready) { rejectStart(new ActionableError("Mock location stopped before confirming coordinates")); }
				resolveDone();
			}
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (session.closed) { return; }
			buffer += chunk.toString("utf8");
			if (buffer.length > 65536) { fail("Mock-location protocol exceeded 64 KiB"); return; }
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop()!;
			for (const line of lines) {
				if (!line.startsWith("{")) { continue; }
				try {
					const event = JSON.parse(line);
					if (event.event === "started" && !ready && !problem &&
						typeof event.latitude === "number" && typeof event.longitude === "number" &&
						Math.abs(event.latitude - latitude) <= 0.000001 && Math.abs(event.longitude - longitude) <= 0.000001) {
						ready = true;
						clearTimeout(startup);
						resolveStart();
					} else if (event.event === "cleared" && event.code === 0 && !session.cleared) {
						session.cleared = true;
						session.terminal = true;
					} else if (event.event === "error" && Number.isInteger(event.code) && Number.isInteger(event.clearCode)) {
						session.terminal = true;
						fail(`Mock-location component failed (code ${event.code}, cleanup ${event.clearCode}). Check system and MOCK_LOCATION permissions`);
					} else {
						fail(`Mock-location protocol rejected status: ${line}. Check system and MOCK_LOCATION permissions`);
					}
				} catch { fail("Invalid JSON from mock-location component"); }
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
		child.on("error", error => { problem = error; finish(-1); });
		child.on("close", code => finish(code));
		return started;
	}
}
