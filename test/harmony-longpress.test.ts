import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { HarmonyRobot } from "../src/harmony";

const help = "Usage: uinput\n-K --keyboard\n-d key\n-u key\n-i time\n-T --touch\ncommands for touch:\n-d <x> <y> --down\n-u <x> <y> --up\n-i <time> --interval\n";

test("uses one ordered touch sequence with the requested rounded duration", async () => {
	const hdc = new Hdc();
	const calls: Array<{ args: string[]; timeout?: number }> = [];
	hdc.shellChecked = (_target, args, timeout) => {
		calls.push({ args, timeout });
		return args[1] === "-?" ? help : "touch down 10 21\ntouch up 10 21\n";
	};
	await new HarmonyRobot("harmony:MATE60", hdc).longPress(10.2, 20.8, 799.6);
	expect(calls[1]).toEqual({ args: ["uinput", "-T", "-d", "10", "21", "-i", "800", "-u", "10", "21"], timeout: 10800 });
	expect(calls).toHaveLength(2);
});

test("does not mistake keyboard commands for touch capability", async () => {
	const hdc = new Hdc();
	const calls: string[][] = [];
	hdc.shellChecked = (_target, args) => {
		calls.push(args);
		return "-K --keyboard\n-d key\n-u key\n-i time\n-T --touch\n-m x y\n";
	};
	await expect(new HarmonyRobot("harmony:MATE60", hdc).longPress(10, 20, 800)).rejects.toThrow("does not advertise");
	expect(calls).toEqual([["uinput", "-?"]]);
});

test("attempts touch release after an interrupted hold", async () => {
	const hdc = new Hdc();
	const calls: string[][] = [];
	hdc.shellChecked = (_target, args) => {
		calls.push(args);
		if (args[1] === "-?") { return help; }
		if (args[2] === "-d") { throw new Error("transport interrupted"); }
		return "touch up 10 20";
	};
	await expect(new HarmonyRobot("harmony:MATE60", hdc).longPress(10, 20, 800)).rejects.toThrow("transport interrupted");
	expect(calls.at(-1)).toEqual(["uinput", "-T", "-u", "10", "20"]);
});

test("reports failed recovery instead of concealing a possibly held touch", async () => {
	const hdc = new Hdc();
	hdc.shellChecked = (_target, args) => args[1] === "-?" ? help : "permission denied";
	await expect(new HarmonyRobot("harmony:MATE60", hdc).longPress(10, 20, 800)).rejects.toThrow("Touch release also failed");
});

test("requires both acknowledgements in the correct order", async () => {
	const hdc = new Hdc();
	for (const output of ["touch down 10 20", "touch up 10 20\ntouch down 10 20", "usage: uinput"]) {
		hdc.shellChecked = (_target, args) => args[1] === "-?" ? help : args[2] === "-u" ? "touch up 10 20" : output;
		await expect(new HarmonyRobot("harmony:MATE60", hdc).longPress(10, 20, 800)).rejects.toThrow("ordered touch");
	}
});

test("rejects invalid values before issuing any input commands", async () => {
	const hdc = new Hdc();
	let count = 0;
	hdc.shellChecked = () => { count++; return help; };
	const robot = new HarmonyRobot("harmony:MATE60", hdc);
	for (const duration of [0, -1, 10001, Infinity, NaN]) {
		await expect(robot.longPress(10, 20, duration)).rejects.toThrow("Invalid");
	}
	await expect(robot.longPress(Infinity, 20, 500)).rejects.toThrow("Invalid");
	expect(count).toBe(0);
});
