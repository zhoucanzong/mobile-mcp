import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hdc } from "./hdc";
import { ActionableError } from "./robot";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class HarmonyClipboard {
	constructor(private hdc: Hdc, private target: string) { }

	private command(): string {
		const executable = process.env.HARMONY_PASTEBOARD_COMMAND || "/system/bin/cli_tool/executable/ohos-pasteboard";
		if (!/^(?:\/[^\0\r\n]+|[a-zA-Z0-9_][a-zA-Z0-9_.-]*)$/.test(executable)) {
			throw new ActionableError("HARMONY_PASTEBOARD_COMMAND must be one device executable path or command name");
		}

		return executable;
	}

	private response(output: string, allowEmpty = false): Record<string, unknown> {
		let value: Record<string, unknown>;
		try {
			value = object(JSON.parse(output));
		} catch {
			throw new ActionableError("HarmonyOS clipboard tool did not return JSON. Check HARMONY_PASTEBOARD_COMMAND and its supported version");
		}

		if (value.type !== "result") {
			throw new ActionableError("Unrecognized HarmonyOS clipboard response");
		}

		if (allowEmpty && value.status === "failed" && value.errCode === "ERR_NO_DATA") {
			return { records: [], recordCount: 0 };
		}

		if (value.status !== "success") {
			const code = typeof value.errCode === "string" ? value.errCode : "unknown";
			const message = typeof value.errMsg === "string" ? value.errMsg : "operation failed";
			throw new ActionableError(`HarmonyOS clipboard ${code}: ${message}`);
		}

		return object(value.data);
	}

	public get(): string {
		const data = this.response(this.hdc.shellChecked(this.target, [this.command(), "get-data"]), true);
		if (!Array.isArray(data.records) || !Number.isInteger(data.recordCount) || data.recordCount !== data.records.length) {
			throw new ActionableError("HarmonyOS clipboard returned an invalid or incomplete record list");
		}

		if (data.recordCount === 0) {
			return "";
		}

		const text = data.records.map(object).find(record => typeof record.plainText === "string");
		if (!text) {
			throw new ActionableError("HarmonyOS clipboard has no plain-text representation");
		}

		return text.plainText as string;
	}

	public set(text: string): void {
		if (text.includes("\0") || Buffer.byteLength(text, "utf8") > 65536 || Buffer.from(text, "utf8").toString("utf8") !== text) {
			throw new ActionableError("HarmonyOS clipboard text must be valid Unicode, at most 64 KiB of UTF-8, and cannot contain NUL");
		}

		if (text === "--help") {
			throw new ActionableError("This system clipboard command reserves the literal --help argument and cannot store it verbatim");
		}

		const executable = this.command();
		if (text === "") {
			this.response(this.hdc.shellChecked(this.target, [executable, "clear-data"]));
		} else {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-clipboard-"));
			const local = path.join(directory, "text.txt");
			const remote = `/data/local/tmp/mobile-mcp-clipboard-${crypto.randomUUID()}.txt`;
			let failure: unknown;
			try {
				fs.writeFileSync(local, text, { encoding: "utf8", mode: 0o600 });
				this.hdc.executeCommand(["-t", this.target, "file", "send", local, remote]);
				this.hdc.shellChecked(this.target, ["chmod", "600", remote]);
				// The sentinel preserves trailing newlines removed by shell command
				// substitution. Clipboard text never becomes executable shell source.
				const script = 'mcp_text=$(cat "$1" && printf .) || exit 1; mcp_text=${mcp_text%.}; exec "$2" set-data --text "$mcp_text"';
				this.response(this.hdc.shellChecked(this.target, ["sh", "-c", script, "mcp-clipboard", remote, executable]));
			} catch (error) {
				failure = error;
				throw error;
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
				try {
					this.hdc.shellChecked(this.target, ["rm", "-f", remote]);
				} catch (error: any) {
					if (!failure) {
						throw new ActionableError(`Clipboard write was accepted, but its temporary file could not be removed: ${remote}. ${error.message}`);
					}
					if (failure instanceof Error) {
						failure.message += `. Temporary clipboard file cleanup also failed: ${remote}`;
					}
				}
			}
		}

		let actual: string;
		try {
			actual = this.get();
		} catch (error: any) {
			throw new ActionableError(`Clipboard write was accepted but readback could not be verified: ${error.message}`);
		}

		if (actual !== text) {
			throw new ActionableError("Clipboard write was accepted but readback did not match; another app may have changed it");
		}
	}
}
