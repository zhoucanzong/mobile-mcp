import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { transformScreenshot } from "../src/screenshot-transform";

const source = () => sharp({ create: { width: 120, height: 240, channels: 3, background: "#336699" } }).png().toBuffer();

test("converts PNG to JPEG with actual dimensions and preserves colors", async () => {
	const result = await transformScreenshot(await source(), { format: "jpeg", quality: 90, scale: 0.5 });
	const info = await sharp(result).metadata();
	expect(info).toMatchObject({ width: 60, height: 120, format: "jpeg" });
	const pixel = await sharp(result).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
	for (let i = 0; i < 3; i++) { expect(Math.abs(pixel[i] - [51, 102, 153][i])).toBeLessThan(5); }
});

test("converts JPEG to lossless PNG and maxSize overrides scale", async () => {
	const jpeg = await sharp(await source()).jpeg().toBuffer();
	const result = await transformScreenshot(jpeg, { format: "png", maxSize: 80, scale: 0.9 });
	expect(await sharp(result).metadata()).toMatchObject({ width: 40, height: 80, format: "png" });
});

test("preserves original bytes without unnecessary re-encoding and does not enlarge", async () => {
	const png = await source();
	expect(await transformScreenshot(png)).toEqual(png);
	expect(await transformScreenshot(png, { maxSize: 1000, quality: 1 })).toEqual(png);
	expect(await sharp(await transformScreenshot(png, { scale: 0.00001 })).metadata()).toMatchObject({ width: 1, height: 1 });
});

test("JPEG quality affects the encoded output and PNG stays lossless", async () => {
	const pixels = Buffer.alloc(128 * 128 * 3);
	for (let i = 0; i < pixels.length; i++) { pixels[i] = (i * 73 + Math.floor(i / 13)) % 256; }
	const png = await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
	const low = await transformScreenshot(png, { format: "jpeg", quality: 10 });
	const high = await transformScreenshot(png, { format: "jpeg", quality: 95 });
	expect(high.length).toBeGreaterThan(low.length);
	expect(await transformScreenshot(png, { format: "png", quality: 10 })).toEqual(png);
});

test("rejects invalid options and corrupt input instead of returning synthetic images", async () => {
	const png = await source();
	for (const options of [{ quality: 0 }, { quality: 101 }, { scale: 0 }, { scale: 2 }, { maxSize: 0 }, { format: "webp" }]) {
		await expect(transformScreenshot(png, options as any)).rejects.toThrow();
	}
	await expect(transformScreenshot(png.subarray(0, 30))).rejects.toThrow("processing failed");
	await expect(transformScreenshot(Buffer.from("not an image"))).rejects.toThrow("processing failed");
});

test("an explicit JPEG request applies the default quality even to JPEG input", async () => {
	const jpeg = await sharp(await source()).jpeg({ quality: 100 }).toBuffer();
	expect(await transformScreenshot(jpeg)).toEqual(jpeg);
	expect(await transformScreenshot(jpeg, { format: "jpeg" })).toEqual(await transformScreenshot(jpeg, { format: "jpeg", quality: 75 }));
});
