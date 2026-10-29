import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyRobot, parseHarmonyLayout } from "../src/harmony";
import { formatElements } from "../src/format-elements";

const layout = () => ({
	attributes: { bounds: "[0,0][1080,2400]" },
	children: [{
		attributes: { type: "Button", text: "搜索中文🙂", description: "开始搜索", id: "search", bounds: "[10,20][110,80]", enabled: "true", focused: "true" },
		children: [],
	}],
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=", "base64");

const mockRobot = () => {
	const hdc = new Hdc();
	const calls: string[][] = [];
	let currentLayout: unknown = layout();
	let mutationOutput = "";
	let localScreenshot: string | undefined;
	hdc.shell = (_target, args) => {
		calls.push(args);
		if (args[0] === "cat") {
			return JSON.stringify(currentLayout);
		}

		return args[0] === "uitest" && args[1] === "uiInput" ? mutationOutput : "";
	};
	hdc.executeCommand = args => {
		calls.push(args);
		if (args[2] === "file" && args[3] === "recv") {
			localScreenshot = args[5];
			fs.writeFileSync(args[5], png);
		}

		return Buffer.from("");
	};
	return {
		robot: new HarmonyRobot("harmony:MATE60", hdc), calls,
		setLayout: (value: unknown) => { currentLayout = value; },
		setMutationOutput: (value: string) => { mutationOutput = value; },
		getLocalScreenshot: () => localScreenshot,
	};
};

test("keeps Chinese text, accessibility labels and states in both output formats", () => {
	const elements = parseHarmonyLayout(layout(), 1);
	expect(elements).toHaveLength(1);
	expect(elements[0]).toMatchObject({ ref: "@h1e1", text: "搜索中文🙂", label: "开始搜索", focused: true, rect: { x: 10, y: 20, width: 100, height: 60 } });
	expect(formatElements(elements, "text")).toContain('text="搜索中文🙂" label="开始搜索"');
	expect(JSON.parse(formatElements(elements, "json").replace("Found these elements on screen: ", ""))[0].text).toBe("搜索中文🙂");
});

test("does not expose invisible subtrees or invalid/empty rectangles", () => {
	const root = layout();
	root.children[0].attributes.bounds = "[10,20][10,20]";
	expect(parseHarmonyLayout(root, 1)).toEqual([]);
	expect(parseHarmonyLayout({ attributes: { visible: "false" }, children: layout().children }, 1)).toEqual([]);
	expect(parseHarmonyLayout({ attributes: { type: "Text", bounds: "garbage" } }, 1)).toEqual([]);
});

test("resolves refs to the element center and invalidates them after an action", async () => {
	const { robot, calls } = mockRobot();
	const [element] = await robot.getElementsOnScreen();
	await robot.tapByRef(element.ref!);
	expect(calls).toContainEqual(["uitest", "uiInput", "click", "60", "50"]);
	await expect(robot.tapByRef(element.ref!)).rejects.toThrow("stale or unknown");
	const [fresh] = await robot.getElementsOnScreen();
	expect(fresh.ref).not.toBe(element.ref);
});

test("rejects a ref after external layout changes instead of tapping an old position", async () => {
	const { robot, calls, setLayout } = mockRobot();
	const [element] = await robot.getElementsOnScreen();
	const changed = layout();
	changed.children[0].attributes.text = "其他按钮";
	setLayout(changed);
	await expect(robot.tapByRef(element.ref!)).rejects.toThrow("UI changed");
	expect(calls.some(args => args[1] === "uiInput")).toBe(false);
});

test("ref double-tap uses UITest's native doubleClick", async () => {
	const { robot, calls } = mockRobot();
	const [element] = await robot.getElementsOnScreen();
	await robot.doubleTapByRef(element.ref!);
	expect(calls).toContainEqual(["uitest", "uiInput", "doubleClick", "60", "50"]);
});

test("native long press resolves a ref without promising a configurable duration", async () => {
	const { robot, calls } = mockRobot();
	const [element] = await robot.getElementsOnScreen();
	await robot.longPressDefaultByRef(element.ref!);
	expect(calls).toContainEqual(["uitest", "uiInput", "longClick", "60", "50"]);
	await expect(robot.tapByRef(element.ref!)).rejects.toThrow("stale");
});

test("forwards mixed Chinese input without encoding loss and clears refs", async () => {
	const { robot, calls } = mockRobot();
	const [element] = await robot.getElementsOnScreen();
	const text = "你好，Mate 60 Pro！🙂 O'Reilly & 空格\n第二行";
	await robot.sendKeys(text);
	expect(calls).toContainEqual(["uitest", "uiInput", "text", text]);
	await expect(robot.tapByRef(element.ref!)).rejects.toThrow("stale");
});

test("does not interpret UITest help as successful input on older devices", async () => {
	const { robot, setMutationOutput } = mockRobot();
	setMutationOutput("Usage: uitest uiInput inputText x y text");
	await expect(robot.sendKeys("中文")).rejects.toThrow("not accepted");
});

test("rejects unsupported operations and invalid app arguments before acting", async () => {
	const { robot, calls } = mockRobot();
	await expect(robot.longPress(10, 10, 500)).rejects.toThrow("not supported");
	await expect(robot.setOrientation("landscape")).rejects.toThrow("not supported");
	await expect(robot.launchApp("com.example", "zh-CN")).rejects.toThrow("not supported");
	await expect(robot.installApp("app.apk")).rejects.toThrow(".hap");
	await expect(robot.uninstallApp("-n")).rejects.toThrow("Invalid");
	await expect(robot.terminateApp("app/Ability")).rejects.toThrow("Invalid");
	expect(calls).toEqual([]);
});

test("retrieves a PNG and cleans both host and device temporary files", async () => {
	const { robot, calls, getLocalScreenshot } = mockRobot();
	expect(await robot.getScreenshot({ format: "jpeg", maxSize: 1024 })).toEqual(png);
	expect(fs.existsSync(getLocalScreenshot()!)).toBe(false);
	expect(calls.some(args => args[0] === "rm" && args[2].endsWith(".png"))).toBe(true);
	expect(await robot.getScreenSize()).toEqual({ width: 1, height: 1, scale: 1 });
});

test("falls back to an available screenshot command and cleans each attempt", async () => {
	const hdc = new Hdc();
	const calls: string[][] = [];
	hdc.shell = (_target, args) => {
		calls.push(args);
		if (args[0] === "uitest") {
			throw new Error("screenCap unavailable");
		}

		return "";
	};
	hdc.executeCommand = args => { fs.writeFileSync(args[5], png); return Buffer.from(""); };
	expect(await new HarmonyRobot("harmony:MATE60", hdc).getScreenshot()).toEqual(png);
	expect(calls.some(args => args[0] === "snapshot_display")).toBe(true);
	expect(calls.filter(args => args[0] === "rm")).toHaveLength(2);
	expect(calls.some(args => args[0] === "screenshot")).toBe(false);
});

test("never substitutes a fabricated image when all screenshot methods fail", async () => {
	const hdc = new Hdc();
	const cleanup: string[] = [];
	hdc.shell = (_target, args) => {
		if (args[0] === "rm") {
			cleanup.push(args[2]);
			return "";
		}

		throw new Error("capture denied");
	};
	await expect(new HarmonyRobot("harmony:MATE60", hdc).getScreenshot()).rejects.toThrow("No valid HarmonyOS screenshot");
	expect(cleanup).toHaveLength(3);
	expect(new Set(cleanup).size).toBe(3);
});

test("cleans device temporary files when the UI dump cannot be parsed", async () => {
	const { robot, calls, setLayout } = mockRobot();
	setLayout({ wrong: "shape" });
	await expect(robot.getElementsOnScreen()).rejects.toThrow("UI tree");
	expect(calls.some(args => args[0] === "rm" && args[2].endsWith(".json"))).toBe(true);
});

test("clamps swipe coordinates to the current screen and maps Home/Back/Enter", async () => {
	const { robot, calls } = mockRobot();
	robot.getScreenSize = async () => ({ width: 1080, height: 2400, scale: 1 });
	await robot.swipeFromCoordinate(10, 20, "up", 400);
	expect(calls).toContainEqual(["uitest", "uiInput", "swipe", "10", "20", "10", "0"]);
	await robot.pressButton("HOME");
	await robot.pressButton("BACK");
	await robot.pressButton("ENTER");
	expect(calls.slice(-3)).toEqual([["uitest", "uiInput", "keyEvent", "Home"], ["uitest", "uiInput", "keyEvent", "Back"], ["uitest", "uiInput", "keyEvent", "2054"]]);
});

test("supports explicit ability launch and preserves URL query parameters", async () => {
	const { robot, calls } = mockRobot();
	await robot.launchApp("com.example.app/EntryAbility");
	await robot.openUrl("https://example.com/?q=中文&a=1");
	expect(calls).toEqual([["aa", "start", "-b", "com.example.app", "-a", "EntryAbility"], ["aa", "start", "-A", "ohos.want.action.viewData", "-U", "https://example.com/?q=中文&a=1"]]);
});
