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
	return value
		.normalize("NFC")
		.replace(/[\u0000-\u001f\u007f]/gu, "")
		.replace(/[\\/:*?"<>|]+/gu, "-")
		.replace(/\s+/gu, "-")
		.replace(/-+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 80) || "media";
}

function extensionForMime(mimeType: string): string {
	const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/avif") return ".avif";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "audio/mp4") return ".m4a";
	return ".bin";
}

export function getMediaTempRoot(): string {
	const override = process.env[TEMP_ROOT_OVERRIDE]?.trim();
	return override || join(homedir(), "Desktop", "Web-Access", "pi-web-access");
}

function getSessionDirectory(sessionId?: string): string {
	const suffix = sessionId ? sanitizePart(sessionId) : `run-${Date.now()}`;
	return join(getMediaTempRoot(), suffix);
}

export function getMediaTempDirectory(sessionId?: string): string {
	return getSessionDirectory(sessionId);
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
		if (entry.name === "douyin" || entry.name === ".runs") return;
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

export interface DouyinArtifactPaths {
	directory: string;
	videoPath: string;
	audioPath: string;
	metadataPath: string;
}

function localDateStamp(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function publishedDateStamp(publishedAt?: string): string {
	const value = publishedAt?.trim() || "";
	const match = value.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/) || value.match(/(\d{4})(\d{2})(\d{2})/);
	if (!match) return localDateStamp();
	const [, year, month, day] = match;
	return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function getDouyinRoot(): string {
	return join(getMediaTempRoot(), "douyin");
}

export function getDouyinRunDirectory(sessionId?: string): string {
	const suffix = sessionId ? sanitizePart(sessionId) : "run";
	return join(getMediaTempRoot(), ".runs", `${suffix}-${Date.now()}`);
}

export function getDouyinArtifactDirectory(videoId: string, title?: string, publishedAt?: string): string {
	const date = publishedDateStamp(publishedAt);
	const id = sanitizePart(videoId);
	const titlePart = sanitizePart(title || "video");
	return join(getDouyinRoot(), `${date}_${id}_${titlePart}`);
}

export function getDouyinArtifactPaths(directory: string): DouyinArtifactPaths {
	return {
		directory,
		videoPath: join(directory, "video.mp4"),
		audioPath: join(directory, "audio.m4a"),
		metadataPath: join(directory, "metadata.json"),
	};
}

export async function findDouyinArtifact(videoId: string): Promise<DouyinArtifactPaths | null> {
	const root = getDouyinRoot();
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return null;
	}
	const prefix = `_${sanitizePart(videoId)}_`;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!/^\d{4}-\d{2}-\d{2}_/.test(entry.name) || !entry.name.slice(10).startsWith(prefix)) continue;
		const paths = getDouyinArtifactPaths(join(root, entry.name));
		try {
			await Promise.all([stat(paths.videoPath), stat(paths.audioPath), stat(paths.metadataPath)]);
			return paths;
		} catch {
			// Ignore incomplete directories and continue looking for a complete artifact.
		}
	}
	return null;
}

export async function cleanupStaleDouyinRuns(): Promise<void> {
	const runsRoot = join(getMediaTempRoot(), ".runs");
	let entries;
	try {
		entries = await readdir(runsRoot, { withFileTypes: true });
	} catch {
		return;
	}
	const now = Date.now();
	await Promise.all(entries.map(async (entry) => {
		const path = join(runsRoot, entry.name);
		try {
			const info = await stat(path);
			if (now - info.mtimeMs <= STALE_AFTER_MS) return;
			await rm(path, { recursive: true, force: true });
		} catch {
			// Run cleanup is best effort and must not block media retrieval.
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
