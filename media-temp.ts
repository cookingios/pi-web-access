import { createHash } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

const TEMP_ROOT_OVERRIDE = "PI_WEB_ACCESS_TEMP_DIR";
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

let lastCleanupAt = 0;

export interface PersistedMedia {
	url: string;
	mimeType: string;
	bytes: number;
	data: string;
}

function sanitizePart(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "media";
}

function extensionForMime(mimeType: string): string {
	const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/avif") return ".avif";
	return ".bin";
}

export function getMediaTempRoot(): string {
	const override = process.env[TEMP_ROOT_OVERRIDE]?.trim();
	return override || join(homedir(), "Desktop", "Temp", "pi-web-access");
}

function getSessionDirectory(sessionId?: string): string {
	const suffix = sessionId ? sanitizePart(sessionId) : `run-${Date.now()}`;
	return join(getMediaTempRoot(), suffix);
}

async function removeStaleEntries(now: number): Promise<void> {
	const root = getMediaTempRoot();
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}

	await Promise.all(entries.map(async (entry) => {
		const path = join(root, entry.name);
		try {
			const info = await stat(path);
			if (now - info.mtimeMs <= STALE_AFTER_MS) return;
			await rm(path, { recursive: true, force: true });
		} catch {
			// Temp cleanup is best effort and must not block media retrieval.
		}
	}));
}

async function cleanupStaleEntries(): Promise<void> {
	const now = Date.now();
	if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
	lastCleanupAt = now;
	await removeStaleEntries(now);
}

function sourceStem(url: string): string {
	try {
		const path = new URL(url).pathname;
		const name = basename(path);
		const suffix = extname(name);
		return sanitizePart(suffix ? name.slice(0, -suffix.length) : name);
	} catch {
		return "media";
	}
}

export async function persistMediaToTemp(media: PersistedMedia, options?: { sessionId?: string }): Promise<string> {
	await cleanupStaleEntries();
	const directory = getSessionDirectory(options?.sessionId);
	await mkdir(directory, { recursive: true, mode: 0o700 });

	const bytes = Buffer.from(media.data, "base64");
	const digest = createHash("sha256").update(media.url).digest("hex").slice(0, 12);
	const filename = `${sourceStem(media.url)}-${digest}${extensionForMime(media.mimeType)}`;
	const outputPath = join(directory, filename);
	const partialPath = `${outputPath}.part`;
	await writeFile(partialPath, bytes, { mode: 0o600 });
	await rename(partialPath, outputPath);
	return outputPath;
}
