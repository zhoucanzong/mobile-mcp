import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ChildProcess } from "node:child_process";
import { Hdc } from "./hdc";
import { ActionableError } from "./robot";
import { createPrivateOutputPath, finishRecording } from "./utils";

export interface RecordingResult {
	output: string;
	bytes: number;
	durationSeconds: number;
}

// Check the complete top-level MP4 container without loading a video into RAM.
// This is structural validation; decoding actual captured frames needs device QA.
export const validateRecordingMp4 = (file: string): number => {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const total = fs.fstatSync(fd).size;
		const found = new Set<string>();
		let position = 0;
		while (position < total) {
			const header = Buffer.alloc(16);
			if (fs.readSync(fd, header, 0, 8, position) !== 8) {
				throw new ActionableError("Recording has a truncated MP4 box");
			}

			let size = header.readUInt32BE(0);
			let headerSize = 8;
			if (size === 1) {
				if (fs.readSync(fd, header, 8, 8, position + 8) !== 8) {
					throw new ActionableError("Recording has a truncated extended MP4 box");
				}

				size = Number(header.readBigUInt64BE(8));
				headerSize = 16;
			} else if (size === 0) {
				size = total - position;
			}

			if (!Number.isSafeInteger(size) || size < headerSize || size > total - position) {
				throw new ActionableError("Recording contains an invalid MP4 box length");
			}

			if (size > headerSize) {
				found.add(header.toString("ascii", 4, 8));
			}

			position += size;
		}

		if (!["ftyp", "moov", "mdat"].every(box => found.has(box))) {
			throw new ActionableError("Recording is incomplete: missing MP4 file type, index or video data");
		}

		return total;
	} finally {
		fs.closeSync(fd);
	}
};

interface Recording {
	output: string;
	local: string;
	remote: string;
	control: string;
	binary: string;
	child: ChildProcess;
	done: Promise<RecordingResult>;
	requestStop: () => void;
	finished: boolean;
}

export class HarmonyRecording {
	private current?: Recording;

	constructor(private hdc: Hdc, private target: string,
		private timeouts = { startup: 65000, stop: 15000 }) { }

	public isBusy(): boolean { return this.current !== undefined; }

	public async start(width: number, height: number, output?: string, timeLimit?: number): Promise<string> {
		if (this.current) {
			throw new ActionableError("A HarmonyOS recording is already active or awaiting collection. Call mobile_stop_screen_recording first");
		}

		if (![width, height].every(value => Number.isInteger(value) && value >= 2 && value <= 16384) ||
			(timeLimit !== undefined && (!Number.isInteger(timeLimit) || timeLimit < 1 || timeLimit > 86400))) {
			throw new ActionableError("Recording needs valid dimensions and an integer timeLimit of 1..86400 seconds");
		}

		const executable = process.env.HARMONY_RECORDER_PATH;
		if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
			throw new ActionableError("Build the native HarmonyOS recorder with the device SDK and set HARMONY_RECORDER_PATH to its absolute executable path");
		}

		const session = `/data/local/tmp/mobile-mcp-recording-${crypto.randomUUID()}`;
		const local = createPrivateOutputPath("capture.mp4");
		const remote = session + ".mp4";
		const control = session + ".stop";
		const binary = session + ".bin";
		let child: ChildProcess;
		try {
			this.hdc.executeCommand(["-t", this.target, "file", "send", executable, binary], 180000);
			this.hdc.shellChecked(this.target, ["chmod", "700", binary]);
			child = this.hdc.spawnShell(this.target, [binary, remote, control, `${width - width % 2}`, `${height - height % 2}`, `${timeLimit ?? 0}`]);
		} catch (error) {
			this.cleanupRemote([binary, control, remote]);
			fs.rmSync(path.dirname(local), { recursive: true, force: true });
			throw error;
		}

		let resolveStart: (output: string) => void;
		let rejectStart: (error: Error) => void;
		const started = new Promise<string>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
		let resolveDone: (result: RecordingResult) => void;
		let rejectDone: (error: Error) => void;
		const done = new Promise<RecordingResult>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
		// Timed/system stops may finish before the client asks to collect the result.
		done.catch(() => {});
		let ready = false;
		let startedAt = 0;
		let stoppedAt = 0;
		let stoppedBytes: number | undefined;
		let problem: Error | undefined;
		let pending = "";
		let stderr = "";
		let stopTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const recording: Recording = {
			output: output || local, local, remote, control, binary, child, done, finished: false,
			requestStop: () => {
				if (recording.finished || stopTimer) {
					return;
				}

				try {
					this.hdc.shellChecked(this.target, ["touch", control]);
				} catch (error: any) {
					problem ??= new ActionableError(`Cannot request recorder stop: ${error.message}`);
				}

				stopTimer = setTimeout(() => {
					problem ??= new ActionableError("HarmonyOS recorder did not finalize before the stop deadline");
					child.kill("SIGTERM");
					killTimer = setTimeout(() => { child.kill("SIGKILL"); finish(-1); }, 1000);
				}, this.timeouts.stop);
			},
		};
		this.current = recording;
		const startup = setTimeout(() => {
			problem = new ActionableError("HarmonyOS recording authorization/start timed out");
			rejectStart(problem);
			recording.requestStop();
		}, this.timeouts.startup);
		const fail = (message: string) => {
			problem ??= new ActionableError(message);
			if (!ready) {
				rejectStart(problem);
			}

			recording.requestStop();
		};
		const finish = (code: number | null) => {
			if (recording.finished) {
				return;
			}

			recording.finished = true;
			clearTimeout(startup);
			clearTimeout(stopTimer);
			clearTimeout(killTimer);
			try {
				if (problem || code !== 0 || !ready || stoppedBytes === undefined) {
					throw problem || new ActionableError(`HarmonyOS recorder did not complete successfully (exit ${code}). ${stderr}`);
				}

				this.hdc.executeCommand(["-t", this.target, "file", "recv", remote, local], 180000);
				const bytes = validateRecordingMp4(local);
				if (bytes !== stoppedBytes) {
					throw new ActionableError("Recording transfer size differs from the finalized device file");
				}

				const moveError = finishRecording(local, recording.output);
				if (moveError) {
					throw new ActionableError(`Recording could not be saved: ${moveError}. Recovery file: ${local}`);
				}

				this.cleanupRemote([remote]);
				resolveDone({ output: recording.output, bytes, durationSeconds: Math.max(0, (stoppedAt - startedAt) / 1000) });
			} catch (error: any) {
				const failure = new ActionableError(`${error.message}. Recovery location on device: ${remote}`);
				rejectStart(failure);
				rejectDone(failure);
				if (!ready) {
					this.current = undefined;
				}
			} finally {
				this.cleanupRemote([binary, control]);
				if (!fs.existsSync(local)) {
					fs.rmSync(path.dirname(local), { recursive: true, force: true });
				}
			}
		};
		child.stdout?.on("data", (data: Buffer) => {
			if (recording.finished) {
				return;
			}

			pending += data.toString("utf8");
			if (pending.length > 65536) {
				fail("Recorder protocol output exceeded 64 KiB");
				return;
			}

			const lines = pending.split(/\r?\n/);
			pending = lines.pop()!;
			for (const line of lines) {
				if (!line.startsWith("{")) {
					continue;
				}

				try {
					const event = JSON.parse(line);
					if (event.event === "started" && !ready && !problem) {
						ready = true;
						startedAt = Date.now();
						clearTimeout(startup);
						resolveStart(recording.output);
					} else if (event.event === "stopped" && ready && Number.isSafeInteger(event.bytes) && event.bytes > 0 && stoppedBytes === undefined) {
						stoppedBytes = event.bytes;
						stoppedAt = Date.now();
					} else {
						fail(`Unexpected recorder status: ${line}`);
					}
				} catch {
					fail("Invalid JSON from HarmonyOS recorder");
				}
			}
		});
		child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-4096); });
		child.on("error", error => { problem = error; finish(-1); });
		child.on("close", code => finish(code));
		return started;
	}

	public async stop(): Promise<RecordingResult> {
		const recording = this.current;
		if (!recording) {
			throw new ActionableError("No HarmonyOS recording is available. Call mobile_start_screen_recording first");
		}

		recording.requestStop();
		try {
			return await recording.done;
		} finally {
			if (this.current === recording) {
				this.current = undefined;
			}
		}
	}

	private cleanupRemote(files: string[]): void {
		try {
			this.hdc.shellChecked(this.target, ["rm", "-f", ...files]);
		} catch {
			// Preserve the primary outcome; device cleanup can be retried later.
		}
	}
}
