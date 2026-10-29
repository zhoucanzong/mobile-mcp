import sharp from "sharp";
import { z } from "zod";
import { ActionableError, ScreenshotOptions } from "./robot";

export const screenshotOptionsSchema = z.object({
	format: z.enum(["png", "jpeg"]).optional(),
	quality: z.number().int().min(1).max(100).optional(),
	scale: z.number().gt(0).max(1).optional(),
	maxSize: z.number().int().positive().optional(),
}).strict();

// Decode on the host: no extra image converter or privileged helper on the phone.
export async function transformScreenshot(input: Buffer, options: ScreenshotOptions = {}): Promise<Buffer> {
	const settings = screenshotOptionsSchema.parse(options);
	try {
		if (input.length > 64 * 1024 * 1024) { throw new Error("Screenshot exceeds 64MiB"); }
		const image = sharp(input, { limitInputPixels: 64 * 1024 * 1024, failOn: "warning" });
		const metadata = await image.metadata();
		if (!["png", "jpeg"].includes(metadata.format || "") || !metadata.width || !metadata.height) {
			throw new Error("Only valid PNG/JPEG screenshots are supported");
		}
		// Decode even when retaining bytes, so truncated data is not passed as a valid screenshot.
		const factor = settings.maxSize !== undefined
			? Math.min(1, settings.maxSize / Math.max(metadata.width, metadata.height))
			: settings.scale ?? 1;
		const format = settings.format ?? metadata.format;
		if (factor === 1 && format === metadata.format && (format !== "jpeg" || settings.quality === undefined && settings.format === undefined)) {
			await image.stats();
			return input;
		}
		if (factor < 1) {
			image.resize({ width: Math.max(1, Math.round(metadata.width * factor)), height: Math.max(1, Math.round(metadata.height * factor)), fit: "fill" });
		}
		// PNG is lossless; JPEG quality is intentionally not mapped to PNG palette quantization.
		return await (format === "jpeg" ? image.flatten({ background: "#ffffff" }).jpeg({ quality: settings.quality ?? 75 }) : image.png()).toBuffer();
	} catch (error: any) {
		throw new ActionableError(`Screenshot processing failed: ${error.message}`);
	}
}
