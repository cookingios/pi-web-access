import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("media is persisted under a session-specific temporary directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-media-temp-"));
	const previous = process.env.PI_WEB_ACCESS_TEMP_DIR;
	process.env.PI_WEB_ACCESS_TEMP_DIR = root;
	try {
		const { getMediaTempRoot, persistMediaToTemp } = await import("../media-temp.ts");
		const path = await persistMediaToTemp({
			url: "https://pbs.twimg.com/media/example?format=jpg&name=orig",
			mimeType: "image/jpeg",
			bytes: 4,
			data: Buffer.from("test").toString("base64"),
		}, { sessionId: "session/with spaces" });

		assert.equal(getMediaTempRoot(), root);
		assert.match(path, /session-with-spaces\/example-[a-f0-9]{12}\.jpg$/);
		assert.equal(existsSync(path), true);
		assert.equal(readFileSync(path, "utf8"), "test");
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_ACCESS_TEMP_DIR;
		else process.env.PI_WEB_ACCESS_TEMP_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Douyin artifacts use a readable archive directory and stable filenames", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-douyin-temp-"));
	const previous = process.env.PI_WEB_ACCESS_TEMP_DIR;
	process.env.PI_WEB_ACCESS_TEMP_DIR = root;
	try {
		const {
			getDouyinArtifactDirectory,
			getDouyinArtifactPaths,
			getDouyinRunDirectory,
			findDouyinArtifact,
		} = await import("../media-temp.ts");
		const directory = getDouyinArtifactDirectory("7462269663943183642", "深水埗吃早餐", "2025-01-21 12:00");
		assert.equal(directory, join(root, "douyin", "2025-01-21_7462269663943183642_深水埗吃早餐"));
		const paths = getDouyinArtifactPaths(directory);
		assert.equal(paths.videoPath, join(directory, "video.mp4"));
		assert.equal(paths.audioPath, join(directory, "audio.m4a"));
		assert.equal(paths.metadataPath, join(directory, "metadata.json"));
		assert.match(getDouyinRunDirectory("session/with spaces"), /\.runs\/session-with-spaces-\d+$/);

		mkdirSync(directory, { recursive: true });
		for (const path of [paths.videoPath, paths.audioPath, paths.metadataPath]) writeFileSync(path, "test");
		assert.deepEqual(await findDouyinArtifact("7462269663943183642"), paths);
	} finally {
		if (previous === undefined) delete process.env.PI_WEB_ACCESS_TEMP_DIR;
		else process.env.PI_WEB_ACCESS_TEMP_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
