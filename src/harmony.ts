import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hdc, validateHdcTarget } from "./hdc";
import { PNG } from "./png";
import { ActionableError, Button, InstalledApp, Orientation, Robot, ScreenElement, ScreenElementRect, ScreenSize, ScreenshotOptions, SwipeDirection } from "./robot";

export const HARMONY_DEVICE_PREFIX = "harmony:";
export const isHarmonyDevice = (id: string): boolean => id.startsWith(HARMONY_DEVICE_PREFIX);

export interface HarmonyDeviceInfo {
	id: string;
	name: string;
	platform: "harmonyos";
	type: "real";
	version: string;
	state: "online";
}

export class HarmonyDeviceManager {
	constructor(private hdc = new Hdc()) { }

	public discover(): { available: boolean; devices: HarmonyDeviceInfo[] } {
		let output: string;
		try {
			output = this.hdc.executeCommand(["list", "targets"]).toString("utf8").trim();
		} catch (error: any) {
			if (error.code === "ENOENT" && !process.env.HDC_PATH) {
				return { available: false, devices: [] };
			}

			throw new ActionableError(`HarmonyOS discovery failed. Check HDC_PATH and USB debugging: ${error.message}`);
		}

		const targets = output === "[Empty]" || output === "" ? [] : [...new Set(output.split(/\r?\n/).map(line => line.trim()))];
		const devices = targets.map(target => {
			validateHdcTarget(target);
			const parameter = (name: string): string => {
				try {
					return this.hdc.shell(target, ["param", "get", name]);
				} catch {
					return "";
				}
			};

			return {
				id: HARMONY_DEVICE_PREFIX + target,
				name: parameter("const.product.model") || target,
				platform: "harmonyos" as const,
				type: "real" as const,
				version: parameter("const.ohos.fullname") || "unknown",
				state: "online" as const,
			};
		});
		return { available: true, devices };
	}
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;
const state = (value: unknown): boolean | undefined => value === true || value === "true" ? true : value === false || value === "false" ? false : undefined;

const bounds = (value: unknown): ScreenElementRect | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}

	const match = /^\[(-?\d+),\s*(-?\d+)\]\[(-?\d+),\s*(-?\d+)\]$/.exec(value);
	if (!match) {
		return undefined;
	}

	const [x, y, right, bottom] = match.slice(1).map(Number);
	if (right <= x || bottom <= y || ![x, y, right, bottom].every(Number.isSafeInteger)) {
		return undefined;
	}

	return { x, y, width: right - x, height: bottom - y };
};

// UITest dumpLayout uses {attributes, children}. Preserve Unicode verbatim.
export const parseHarmonyLayout = (layout: unknown, generation: number): ScreenElement[] => {
	const elements: ScreenElement[] = [];
	const walk = (value: unknown) => {
		const node = record(value);
		const attrs = record(node.attributes);
		const rect = bounds(attrs.bounds);
		if (state(attrs.visible) === false) {
			return;
		}

		if (rect && string(attrs.type)) {
			elements.push({
				ref: `@h${generation}e${elements.length + 1}`,
				type: attrs.type as string,
				text: string(attrs.text),
				label: string(attrs.description),
				identifier: string(attrs.id) || string(attrs.key),
				focused: state(attrs.focused),
				selected: state(attrs.selected),
				checked: state(attrs.checked),
				enabled: state(attrs.enabled),
				rect,
			});
		}

		if (Array.isArray(node.children)) {
			node.children.forEach(walk);
		}
	};
	if (Array.isArray(layout)) {
		layout.forEach(walk);
	} else {
		walk(layout);
	}

	return elements;
};

export class HarmonyRobot implements Robot {
	private target: string;
	private generation = 0;
	private snapshot: string | undefined;
	private refs = new Map<string, ScreenElement>();

	constructor(deviceId: string, private hdc = new Hdc()) {
		this.target = deviceId.slice(HARMONY_DEVICE_PREFIX.length);
		if (!isHarmonyDevice(deviceId)) {
			throw new ActionableError("HarmonyOS device ids must start with harmony:");
		}

		validateHdcTarget(this.target);
	}

	private invalidateRefs(): void {
		this.refs.clear();
		this.snapshot = undefined;
	}

	private mutate(args: string[], timeout = 30000): void {
		this.invalidateRefs();
		const output = this.hdc.shell(this.target, args, timeout);
		if (/^\s*(?:usage|unknown|unsupported|invalid|failed|error)\b/im.test(output)) {
			throw new ActionableError(`HarmonyOS command was not accepted: ${output}`);
		}
	}

	private withRemoteFile<T>(extension: string, create: (remotePath: string) => void, read: (remotePath: string) => T): T {
		const remotePath = `/data/local/tmp/mobile-mcp-${crypto.randomUUID()}.${extension}`;
		try {
			create(remotePath);
			return read(remotePath);
		} finally {
			try {
				this.hdc.shell(this.target, ["rm", "-f", remotePath]);
			} catch {
				// Cleanup must not replace the result/error of the requested operation.
			}
		}
	}

	private readLayout(): unknown {
		return this.withRemoteFile("json", remote => {
			this.hdc.shell(this.target, ["uitest", "dumpLayout", "-p", remote]);
		}, remote => {
			try {
				const layout: unknown = JSON.parse(this.hdc.shell(this.target, ["cat", remote]));
				if (!Array.isArray(layout) && !record(layout).attributes) {
					throw new Error("missing attributes");
				}

				return layout;
			} catch (error: any) {
				throw new ActionableError(`Could not read the HarmonyOS UI tree. Unlock the device and check UITest availability: ${error.message}`);
			}
		});
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		this.invalidateRefs();
		const layout = this.readLayout();
		const elements = parseHarmonyLayout(layout, ++this.generation);
		this.snapshot = JSON.stringify(layout);
		this.refs = new Map(elements.map(element => [element.ref!, element]));
		return elements;
	}

	private resolveRef(ref: string): ScreenElementRect {
		const element = this.refs.get(ref);
		if (!element) {
			throw new ActionableError(`Element ${ref} is stale or unknown. Call mobile_list_elements_on_screen again (请重新读取界面元素)`);
		}

		if (JSON.stringify(this.readLayout()) !== this.snapshot) {
			this.invalidateRefs();
			throw new ActionableError("The HarmonyOS UI changed. Call mobile_list_elements_on_screen again before tapping (界面已变化，请重新读取元素)");
		}

		if (element.enabled === false) {
			throw new ActionableError(`Element ${ref} is disabled`);
		}

		return element.rect;
	}

	public async tapByRef(ref: string): Promise<void> {
		const rect = this.resolveRef(ref);
		await this.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
	}

	public async doubleTapByRef(ref: string): Promise<void> {
		const rect = this.resolveRef(ref);
		await this.doubleTap(rect.x + rect.width / 2, rect.y + rect.height / 2);
	}

	public async tap(x: number, y: number): Promise<void> {
		this.mutate(["uitest", "uiInput", "click", `${Math.round(x)}`, `${Math.round(y)}`]);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		this.mutate(["uitest", "uiInput", "doubleClick", `${Math.round(x)}`, `${Math.round(y)}`]);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		throw new ActionableError("Custom-duration long press is not supported by the HarmonyOS HDC backend");
	}

	public async longPressDefault(x: number, y: number): Promise<void> {
		this.mutate(["uitest", "uiInput", "longClick", `${Math.round(x)}`, `${Math.round(y)}`]);
	}

	public async longPressDefaultByRef(ref: string): Promise<void> {
		const rect = this.resolveRef(ref);
		await this.longPressDefault(rect.x + rect.width / 2, rect.y + rect.height / 2);
	}

	public async sendKeys(text: string): Promise<void> {
		if (text !== "") {
			// UITest text (API 18+) inputs at the current focus; non-keyboard
			// characters use UITest's clipboard path, including Chinese text.
			this.mutate(["uitest", "uiInput", "text", text]);
		}
	}

	public async pressButton(button: Button): Promise<void> {
		const keys: Record<string, string> = { HOME: "Home", BACK: "Back", ENTER: "2054", BACKSPACE: "2055", POWER: "18", VOLUME_UP: "16", VOLUME_DOWN: "17" };
		const key = keys[button.toUpperCase()];
		if (!key) {
			throw new ActionableError(`Button ${button} is not supported on HarmonyOS. Supported: ${Object.keys(keys).join(", ")}`);
		}

		this.mutate(["uitest", "uiInput", "keyEvent", key]);
	}

	public async getScreenshot(options?: ScreenshotOptions): Promise<Buffer> {
		// Return a full-resolution PNG, as legacy robots do. The MCP layer
		// detects the actual format and supplies the correct coordinate mapping.
		return this.withRemoteFile("png", remote => {
			this.hdc.shell(this.target, ["uitest", "screenCap", "-p", remote]);
		}, remote => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-harmony-"));
			try {
				const local = path.join(directory, "screen.png");
				this.hdc.executeCommand(["-t", this.target, "file", "recv", remote, local]);
				const data = fs.readFileSync(local);
				new PNG(data).getDimensions();
				return data;
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		});
	}

	public async getScreenSize(): Promise<ScreenSize> {
		return { ...new PNG(await this.getScreenshot()).getDimensions(), scale: 1 };
	}

	public async getOrientation(): Promise<Orientation> {
		const size = await this.getScreenSize();
		return size.width > size.height ? "landscape" : "portrait";
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		throw new ActionableError("Setting orientation is not supported by the HarmonyOS HDC backend");
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const size = await this.getScreenSize();
		const dimension = direction === "left" || direction === "right" ? size.width : size.height;
		await this.swipeFromCoordinate(size.width / 2, size.height / 2, direction, Math.round(dimension * 0.3));
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance = 400): Promise<void> {
		const size = await this.getScreenSize();
		const clamp = (value: number, maximum: number): string => `${Math.round(Math.max(0, Math.min(value, maximum - 1)))}`;
		const dx = direction === "left" ? -distance : direction === "right" ? distance : 0;
		const dy = direction === "up" ? -distance : direction === "down" ? distance : 0;
		this.mutate(["uitest", "uiInput", "swipe", clamp(x, size.width), clamp(y, size.height), clamp(x + dx, size.width), clamp(y + dy, size.height)]);
	}

	public async listApps(): Promise<InstalledApp[]> {
		const output = this.hdc.shell(this.target, ["bm", "dump", "-a"]);
		return [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-zA-Z][\w]*(?:\.[\w]+)+$/.test(line)))].map(packageName => ({ packageName, appName: packageName }));
	}

	public async launchApp(packageName: string, locale?: string): Promise<void> {
		if (locale) {
			throw new ActionableError("Per-app launch locale is not supported by the HarmonyOS HDC backend");
		}

		const [bundle, ability, extra] = packageName.split("/");
		if (extra !== undefined || !/^[a-zA-Z][\w.]*$/.test(bundle) || (ability !== undefined && !/^[a-zA-Z][\w.]*$/.test(ability))) {
			throw new ActionableError("Use a HarmonyOS bundle name, or bundleName/AbilityName for an explicit launch");
		}

		this.mutate(["aa", "start", "-b", bundle, ...(ability ? ["-a", ability] : [])]);
	}

	public async terminateApp(packageName: string): Promise<void> {
		this.validateBundle(packageName);
		this.mutate(["aa", "force-stop", packageName]);
	}

	public async installApp(filePath: string): Promise<void> {
		if (path.extname(filePath).toLowerCase() !== ".hap") {
			throw new ActionableError("HarmonyOS installation requires a signed .hap file");
		}

		this.invalidateRefs();
		this.withRemoteFile("hap", remote => {
			this.hdc.executeCommand(["-t", this.target, "file", "send", path.resolve(filePath), remote], 180000);
		}, remote => this.mutate(["bm", "install", "-p", remote], 185000));
	}

	public async uninstallApp(packageName: string): Promise<void> {
		this.validateBundle(packageName);
		this.mutate(["bm", "uninstall", "-n", packageName]);
	}

	private validateBundle(packageName: string): void {
		if (!/^[a-zA-Z][\w.]*$/.test(packageName)) {
			throw new ActionableError("Invalid HarmonyOS bundle name");
		}
	}

	public async openUrl(url: string): Promise<void> {
		this.mutate(["aa", "start", "-A", "ohos.want.action.viewData", "-U", url]);
	}
}
