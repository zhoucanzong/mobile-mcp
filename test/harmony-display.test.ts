import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyRobot } from "../src/harmony";
import type { Orientation } from "../src/robot";

const fixture = () => {
	const hdc = new Hdc();
	const calls: string[][] = [];
	let developer = "true";
	let help = " -motion |set sensor rotation\n -p |fold\n -z |half\n -y |expand\n";
	let orientation: Orientation = "portrait";
	let applyRotation = true;
	let foldReply: string | undefined;
	hdc.shellChecked = (_target, args) => {
		calls.push(args);
		if (args[0] === "param") {
			return developer;
		}

		const option = args[4];
		if (option === "-h") {
			return help;
		}

		if (option.startsWith("-motion,") && applyRotation) {
			orientation = option === "-motion,0" ? "portrait" : "landscape";
		}

		return foldReply ?? `currentFoldStatus is: ${{ "-p": 2, "-z": 3, "-y": 1 }[option]}`;
	};
	const robot = new HarmonyRobot("harmony:MATE60", hdc);
	robot.getOrientation = async () => orientation;
	return {
		robot, calls,
		setDeveloper: (value: string) => { developer = value; },
		setHelp: (value: string) => { help = value; },
		disableRotation: () => { applyRotation = false; },
		setFoldReply: (value: string) => { foldReply = value; },
	};
};

test("orientation change checks capability and confirms screen state without changing locks", async () => {
	const f = fixture();
	await f.robot.setOrientation("landscape");
	expect(await f.robot.getOrientation()).toBe("landscape");
	expect(f.calls).toContainEqual(["hidumper", "-s", "DisplayManagerService", "-a", "-motion,1"]);
	expect(f.calls.some(args => args.some(value => value.includes("rotationlock")))).toBe(false);
	await f.robot.setOrientation("portrait");
	expect(await f.robot.getOrientation()).toBe("portrait");
});

test("does not mutate an already matching orientation", async () => {
	const f = fixture();
	await f.robot.setOrientation("portrait");
	expect(f.calls).toEqual([]);
});

test("rejects display changes when developer mode or advertised support is missing", async () => {
	const f = fixture();
	f.setDeveloper("false");
	await expect(f.robot.setOrientation("landscape")).rejects.toThrow("developer mode");
	expect(f.calls).toHaveLength(1);
	f.calls.length = 0;
	f.setDeveloper("true");
	f.setHelp("Unknown command -motion");
	await expect(f.robot.setOrientation("landscape")).rejects.toThrow("does not advertise");
	expect(f.calls.some(args => args[4] === "-motion,1")).toBe(false);
});

test("does not equate an accepted command with a successful rotation", async () => {
	const f = fixture();
	f.disableRotation();
	await expect(f.robot.setOrientation("landscape")).rejects.toThrow("did not reach");
});

test("maps named fold postures and verifies the reported FoldStatus", async () => {
	const f = fixture();
	for (const posture of ["folded", "half-open", "open"] as const) {
		await f.robot.fold(posture);
	}

	expect(f.calls.filter(args => args[0] === "hidumper" && args[4] !== "-h").map(args => args[4])).toEqual(["-p", "-z", "-y"]);
});

test("rejects non-foldable/error responses and incorrect reported posture", async () => {
	const f = fixture();
	for (const response of ["The arguments are illegal", "", "currentFoldStatus is: 0", "currentFoldStatus is: 2", "currentFoldStatus is: 1\ncurrentFoldStatus is: 2"]) {
		f.setFoldReply(response);
		await expect(f.robot.fold("open")).rejects.toThrow("did not confirm");
	}
});

test("does not silently approximate exact hinge angles", async () => {
	const f = fixture();
	await expect(f.robot.fold(90)).rejects.toThrow("exact hinge-angle");
	expect(f.calls).toEqual([]);
});
