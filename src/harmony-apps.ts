import { Hdc } from "./hdc";
import { ActionableError, InstalledApp } from "./robot";

const bundlePattern = /^[a-zA-Z][\w]*(?:\.[\w]+)+$/;
export function parseBundleLabels(output: string): Map<string, string> {
	let rows: unknown;
	try { rows = JSON.parse(output); } catch { throw new ActionableError("Bundle label response is not JSON; this system may not support bm dump -a -l"); }
	if (!Array.isArray(rows)) { throw new ActionableError("Bundle label response must be an array"); }
	const labels = new Map<string, string>();
	const ambiguous = new Set<string>();
	for (const row of rows) {
		if (!row || typeof row.bundleName !== "string" || !bundlePattern.test(row.bundleName) || typeof row.label !== "string" ||
			!row.label.trim() || row.label.length > 4096 || /[\x00-\x1f]/.test(row.label) || /^\$string:|^@string\//.test(row.label)) { continue; }
		if (labels.has(row.bundleName) && labels.get(row.bundleName) !== row.label) { ambiguous.add(row.bundleName); }
		labels.set(row.bundleName, row.label);
	}
	for (const bundle of ambiguous) { labels.delete(bundle); }
	return labels;
}

export function listHarmonyApps(hdc: Hdc, target: string): InstalledApp[] {
	const output = hdc.shell(target, ["bm", "dump", "-a"]);
	if (/^\s*(?:usage|error|failed|permission denied)\b/im.test(output)) { throw new ActionableError(`Cannot list HarmonyOS applications: ${output}`); }
	const bundles = [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(line => bundlePattern.test(line)))];
	if (!bundles.length && output.trim() !== "") { throw new ActionableError("Bundle list response contains no recognized bundle names"); }
	if (!bundles.length) { return []; }
	let labels = new Map<string, string>();
	let warning = "No unambiguous resolved label was returned for this bundle";
	try { labels = parseBundleLabels(hdc.shell(target, ["bm", "dump", "-a", "-l"])); } catch (error: any) { warning = error.message; }
	return bundles.map(packageName => labels.has(packageName)
		? { packageName, appName: labels.get(packageName)!, appNameSource: "system-label" }
		: { packageName, appName: packageName, appNameSource: "bundle-name", appNameWarning: warning });
}

export function resolveHarmonyApp(hdc: Hdc, target: string, packageName: string): InstalledApp {
	try {
		const label = parseBundleLabels(hdc.shell(target, ["bm", "dump", "-a", "-l"])).get(packageName);
		if (label) { return { packageName, appName: label, appNameSource: "system-label" }; }
		return { packageName, appName: packageName, appNameSource: "bundle-name", appNameWarning: "No unambiguous resolved label was returned for this bundle" };
	} catch (error: any) {
		return { packageName, appName: packageName, appNameSource: "bundle-name", appNameWarning: error.message };
	}
}
