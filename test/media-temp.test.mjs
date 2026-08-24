import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
