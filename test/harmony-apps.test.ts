import { expect, test } from "@playwright/test";
import { Hdc } from "../src/hdc";
import { listHarmonyApps, parseBundleLabels } from "../src/harmony-apps";

test("reads localized bundle labels in one query and keeps the authoritative app list", () => {
	const hdc = new Hdc(); const calls: string[][] = [];
	hdc.shell = (_target, args) => {
		calls.push(args);
		return args.includes("-l") ? JSON.stringify([{ bundleName: "com.example.notes", label: "备忘录🙂" }, { bundleName: "com.unlisted", label: "Ignore" }]) : "com.example.notes\ncom.example.notes\ncom.example.other\n";
	};
	const apps = listHarmonyApps(hdc, "TEST");
	expect(apps[0]).toEqual({ packageName: "com.example.notes", appName: "备忘录🙂", appNameSource: "system-label" });
	expect(apps[1]).toMatchObject({ packageName: "com.example.other", appNameSource: "bundle-name" });
	expect(apps).toHaveLength(2); expect(calls).toEqual([["bm", "dump", "-a"], ["bm", "dump", "-a", "-l"]]);
});

test("label permission or version failures produce explicit fallback without losing apps", () => {
	const hdc = new Hdc();
	for (const message of ["permission denied", "usage: bm dump", "resource not support"]) {
		hdc.shell = (_target, args) => { if (args.includes("-l")) { throw new Error(message); } return "com.example.app"; };
		expect(listHarmonyApps(hdc, "TEST")[0]).toEqual({ packageName: "com.example.app", appName: "com.example.app", appNameSource: "bundle-name", appNameWarning: message });
	}
});

test("does not guess names from unresolved resources, conflicting labels or malformed data", () => {
	const labels = parseBundleLabels(JSON.stringify([
		{ bundleName: "com.one", label: "A" }, { bundleName: "com.one", label: "B" },
		{ bundleName: "com.two", label: "$string:app_name" }, { bundleName: "com.three", label: "" },
		{ bundleName: "com.four", label: "中文" }, { bundleName: "bad;command", label: "wrong" },
	]));
	expect([...labels.entries()]).toEqual([["com.four", "中文"]]);
	for (const data of ["usage: bm", "{}", "not json"]) { expect(() => parseBundleLabels(data)).toThrow(); }
});

test("app listing failures remain errors instead of an empty successful list", () => {
	const hdc = new Hdc();
	for (const output of ["permission denied", "usage: bm dump", "unexpected response"]) {
		hdc.shell = () => output;
		expect(() => listHarmonyApps(hdc, "TEST")).toThrow();
	}
});
