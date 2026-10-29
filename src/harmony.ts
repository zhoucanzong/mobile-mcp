import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import { Hdc, validateHdcTarget } from "./hdc";
import { PNG } from "./png";
import { getJpegDimensions } from "./jpeg";
import { collectHarmonyLogs } from "./harmony-logs";
import { HarmonyCrashes, HarmonyCrash } from "./harmony-crashes";
import { HarmonyRecording, RecordingResult } from "./harmony-recording";
import { ActionableError, Button, FoldPosture, ForegroundApp, InstalledApp, Orientation, Robot, ScreenElement, ScreenElementRect, ScreenSize, ScreenshotOptions, SwipeDirection } from "./robot";

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

	public connect(address: string): string {
		this.validateAddress(address);
		this.hdc.executeCommand(["tconn", address], 15000);
		if (!this.discover().devices.some(device => device.id === HARMONY_DEVICE_PREFIX + address)) {
			throw new ActionableError("HDC did not report the requested network device after connecting. Check the address, port and device authorization");
		}

		return HARMONY_DEVICE_PREFIX + address;
	}

	public disconnect(address: string): void {
		this.validateAddress(address);
		this.hdc.executeCommand(["tdisconn", address], 15000);
		if (this.discover().devices.some(device => device.id === HARMONY_DEVICE_PREFIX + address)) {
			throw new ActionableError("The requested HarmonyOS network device is still connected");
		}
	}

	private validateAddress(address: string): void {
		const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*):(\d{1,5})$/.exec(address);
		if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 || (match[1].startsWith("[") && isIP(match[1].slice(1, -1)) !== 6)) {
			throw new ActionableError("Provide an explicit HarmonyOS network address and port, such as 192.168.1.10:5555 or [::1]:5555");
		}
	}

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

export const parseHarmonyFocus = (dump: string): string => {
	// WindowManager's default-display focus, not the per-display summary rows.
	const matches = [...dump.matchAll(/^\s*Focus window:\s*(-?\d+)\s*$/gm)];
	if (matches.length !== 1 || !/^\d+$/.test(matches[0][1])) {
		throw new ActionableError("Cannot identify the focused HarmonyOS window. Check WindowManagerService dump permission and unlock the device");
	}

	return matches[0][1];
};

export const harmonyForegroundFromLayout = (layout: unknown, windowId: string): ForegroundApp => {
	const candidates = new Map<string, ForegroundApp>();
	const visit = (value: unknown) => {
		const node = record(value);
		const attrs = record(node.attributes);
		const bundle = string(attrs.bundleName);
		if (bundle && String(attrs.hostWindowId) === windowId) {
			const ability = string(attrs.abilityName);
			const app: ForegroundApp = { packageName: bundle, appName: bundle, ...(ability ? { activity: ability } : {}) };
			candidates.set(JSON.stringify(app), app);
		}

		if (Array.isArray(node.children)) {
			node.children.forEach(visit);
		}
	};
	if (Array.isArray(layout)) {
		layout.forEach(visit);
	} else {
		visit(layout);
	}

	if (candidates.size !== 1) {
		throw new ActionableError("The focused HarmonyOS window cannot be mapped uniquely to an app in the UI tree. Refresh the screen and retry");
	}

	return [...candidates.values()][0];
};

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
	private recording?: HarmonyRecording;
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

	public async getForegroundApp(): Promise<ForegroundApp> {
		const focus = () => parseHarmonyFocus(this.hdc.shell(this.target, ["hidumper", "-s", "WindowManagerService", "-a", "-a"]));
		const before = focus();
		const layout = this.readLayout();
		if (focus() !== before) {
			throw new ActionableError("HarmonyOS focus changed during inspection. Retry mobile_get_foreground_app");
		}

		return harmonyForegroundFromLayout(layout, before);
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
		const failures: string[] = [];
		const methods = [
			{ extension: "png", command: (remote: string) => ["uitest", "screenCap", "-p", remote] },
			{ extension: "png", command: (remote: string) => ["snapshot_display", "-f", remote] },
			{ extension: "jpeg", command: (remote: string) => ["screenshot", remote] },
		];
		for (const method of methods) {
			try {
				return this.withRemoteFile(method.extension, remote => {
					this.hdc.shell(this.target, method.command(remote));
				}, remote => this.receiveScreenshot(remote));
			} catch (error: any) {
				failures.push(`${method.command("<output>")[0]}: ${error.message}`);
			}
		}

		throw new ActionableError(`No valid HarmonyOS screenshot was captured. ${failures.join("; ")}`);
	}

	private receiveScreenshot(remote: string): Buffer {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-harmony-"));
		try {
			const local = path.join(directory, "screen.png");
			this.hdc.executeCommand(["-t", this.target, "file", "recv", remote, local]);
			const data = fs.readFileSync(local);
			const size = this.screenshotSize(data);
			if (size.width <= 0 || size.height <= 0) {
				throw new ActionableError("Screenshot has invalid dimensions");
			}
			return data;
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	}

	private screenshotSize(data: Buffer): { width: number; height: number } {
		return data[0] === 0xff && data[1] === 0xd8 ? getJpegDimensions(data) : new PNG(data).getDimensions();
	}

	public async getScreenSize(): Promise<ScreenSize> {
		return { ...this.screenshotSize(await this.getScreenshot()), scale: 1 };
	}

	public async getOrientation(): Promise<Orientation> {
		const size = await this.getScreenSize();
		return size.width > size.height ? "landscape" : "portrait";
	}

	public async getLogs(limit: number, filters: string[], timeoutMs: number): Promise<string> {
		return collectHarmonyLogs(this.hdc, this.target, limit, filters, timeoutMs);
	}

	public listCrashes(): HarmonyCrash[] {
		return new HarmonyCrashes(this.hdc, this.target).list();
	}

	public getCrash(id: string): string {
		return new HarmonyCrashes(this.hdc, this.target).read(id);
	}

	public hasRecording(): boolean { return this.recording?.isBusy() ?? false; }

	public async startRecording(output?: string, timeLimit?: number): Promise<string> {
		this.recording ??= new HarmonyRecording(this.hdc, this.target);
		const { width, height } = await this.getScreenSize();
		return this.recording.start(width, height, output, timeLimit);
	}

	public async stopRecording(): Promise<RecordingResult> {
		if (!this.recording) {
			throw new ActionableError("No HarmonyOS recording has been started");
		}

		return this.recording.stop();
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		if (await this.getOrientation() === orientation) {
			return;
		}

		this.ensureDisplayCommand("-motion");
		this.invalidateRefs();
		this.hdc.shellChecked(this.target, ["hidumper", "-s", "DisplayManagerService", "-a", orientation === "portrait" ? "-motion,0" : "-motion,1"]);
		for (let attempt = 0; attempt < 4; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 150));
			if (await this.getOrientation() === orientation) {
				return;
			}
		}

		throw new ActionableError("HarmonyOS did not reach the requested orientation. Check auto-rotation, app orientation restrictions and display-service permissions");
	}

	public async fold(posture: FoldPosture | number): Promise<void> {
		if (typeof posture === "number") {
			throw new ActionableError("HarmonyOS supports named fold postures; exact hinge-angle injection is not available");
		}

		const commands = { "folded": { command: "-p", status: "2" }, "half-open": { command: "-z", status: "3" }, "open": { command: "-y", status: "1" } };
		const target = commands[posture];
		if (!target) {
			throw new ActionableError("Invalid HarmonyOS fold posture");
		}

		this.ensureDisplayCommand(target.command);
		this.invalidateRefs();
		const result = this.hdc.shellChecked(this.target, ["hidumper", "-s", "DisplayManagerService", "-a", target.command]);
		const statuses = [...result.matchAll(/^\s*currentFoldStatus is:\s*(\d+)\s*$/gm)];
		if (statuses.length !== 1 || statuses[0][1] !== target.status) {
			throw new ActionableError("HarmonyOS did not confirm the requested fold posture. The device must support fold-state simulation; a non-foldable phone cannot provide this capability");
		}
	}

	private ensureDisplayCommand(command: string): void {
		const developerMode = this.hdc.shellChecked(this.target, ["param", "get", "const.security.developermode.state"]).trim();
		if (developerMode !== "true" && developerMode !== "1") {
			throw new ActionableError("HarmonyOS display control requires developer mode. Enable it on the device before retrying");
		}

		const help = this.hdc.shellChecked(this.target, ["hidumper", "-s", "DisplayManagerService", "-a", "-h"]);
		if (!new RegExp(`^\\s*${command}(?:\\s|,)`, "m").test(help)) {
			throw new ActionableError(`This HarmonyOS display service does not advertise ${command}; check device version and permissions`);
		}
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
