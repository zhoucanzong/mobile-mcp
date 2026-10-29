import { execFileSync, spawn, ChildProcess } from "node:child_process";
import { ActionableError } from "./robot";

// hdc shell forwards a command string to the device shell, even though the
// host process uses execFileSync. Quote every argument for that second shell.
export const quoteHdcArgument = (value: string): string => {
	if (value.includes("\0")) {
		throw new ActionableError("HDC arguments cannot contain a NUL character");
	}

	return "'" + value.replace(/'/g, "'\"'\"'") + "'";
};

export const validateHdcTarget = (target: string): void => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:[\]-]*$/.test(target)) {
		throw new ActionableError("Invalid HarmonyOS device id. Use mobile_list_available_devices to find a connected device");
	}
};

export class Hdc {
	public spawnShell(target: string, args: string[]): ChildProcess {
		validateHdcTarget(target);
		return spawn(process.env.HDC_PATH || "hdc", ["-t", target, "shell", args.map(quoteHdcArgument).join(" ")], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	public executeCommand(args: string[], timeout = 30000): Buffer {
		try {
			const output = execFileSync(process.env.HDC_PATH || "hdc", args, {
				timeout,
				maxBuffer: 8 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			});
			// HDC and some device tools print a failure but exit with status zero.
			if (/^\s*(?:\[Fail\]|error\b|errorcode\b|failed\b|unknown command\b)/im.test(output.toString("utf8"))) {
				throw new ActionableError(`HDC command failed: ${output.toString("utf8").trim()}`);
			}

			return output;
		} catch (error: any) {
			if (error.code === "ENOENT") {
				// Discovery treats a missing optional HDC differently from a broken one.
				throw error;
			}

			if (error instanceof ActionableError) {
				throw error;
			}

			const detail = error.stderr?.toString().trim() || error.stdout?.toString().trim() || error.message;
			throw new ActionableError(`HDC command failed: ${detail}`);
		}
	}

	public shell(target: string, args: string[], timeout = 30000): string {
		validateHdcTarget(target);
		try {
			return this.executeCommand(["-t", target, "shell", args.map(quoteHdcArgument).join(" ")], timeout).toString("utf8").trim();
		} catch (error: any) {
			if (error.code === "ENOENT") {
				throw new ActionableError("HDC was not found. Install the DevEco SDK command line tools and set HDC_PATH to the hdc executable (未找到 HDC，请安装并配置 HDC_PATH)");
			}

			throw error;
		}
	}
}
