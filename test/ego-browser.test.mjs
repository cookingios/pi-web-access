import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;

test("dynamic first-party URLs use Ego Browser before HTTP fetch", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ego-browser-"));
	const fakeEgo = join(root, "fake-ego-browser");
	const payload = JSON.stringify({
		taskSpaceId: "42",
		url: "https://x.com/example/status/1",
		title: "Example post",
		snapshot: "",
		text: "This content came from the isolated Ego Browser Space.",
		links: ["https://x.com/example/status/1"],
		images: ["https://pbs.twimg.com/example.jpg"],
		videos: [],
	});
	writeFileSync(fakeEgo, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '__PI_WEB_ACCESS_EGO_RESULT__${payload}'\n`, "utf8");
	chmodSync(fakeEgo, 0o755);
	writeFileSync(join(root, "web-search.json"), JSON.stringify({
		egoBrowser: { enabled: true, firstPartyDomains: ["x.com"] },
	}) + "\n", "utf8");

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
globalThis.fetch = async () => { throw new Error("HTTP should not run before Ego Browser"); };
const { extractContent } = await import(${JSON.stringify(extractUrl)});
const result = await extractContent("https://x.com/example/status/1", undefined, { sessionId: "session-123" });
console.log(JSON.stringify(result));
`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: root,
			HOME: root,
			USERPROFILE: root,
			PI_EGO_BROWSER_BIN: fakeEgo,
		},
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.error, null);
	assert.equal(result.source, "ego-browser");
	assert.equal(result.taskSpaceId, "42");
	assert.match(result.content, /isolated Ego Browser Space/);
	assert.match(result.content, /pbs\.twimg\.com\/example\.jpg/);
});

test("built-in dynamic domains include Pixiv, Reddit, Xiaohongshu, Xueqiu, Weibo, and Zhishixingqiu", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ego-default-domains-"));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
const { shouldUseEgoBrowser, shouldUseEgoBrowserMedia } = await import(${JSON.stringify(new URL("../ego-browser.ts", import.meta.url).href)});
const pages = [
  shouldUseEgoBrowser("https://www.pixiv.net/artworks/148780243"),
  shouldUseEgoBrowser("https://www.reddit.com/r/example/comments/abc/post/"),
  shouldUseEgoBrowser("https://www.xiaohongshu.com/explore/abc"),
  shouldUseEgoBrowser("https://xueqiu.com/4641860462/406244638"),
  shouldUseEgoBrowser("https://weibo.com/2634877355/ReQqI8KaY"),
  shouldUseEgoBrowser("https://articles.zsxq.com/id_example.html"),
  shouldUseEgoBrowser("https://www.douyin.com/video/7675681543088752115"),
  shouldUseEgoBrowser("https://www.douyin.com/user/example?vid=7675681543088752115"),
];
const media = [
  shouldUseEgoBrowserMedia("https://i.pximg.net/img-master/example.jpg"),
  shouldUseEgoBrowserMedia("https://preview.redd.it/example.jpg"),
  shouldUseEgoBrowserMedia("https://sns-webpic-qc.xhscdn.com/example"),
  shouldUseEgoBrowserMedia("https://xqimg.imedao.com/example.jpg"),
  shouldUseEgoBrowserMedia("https://wx2.sinaimg.cn/large/example.jpg"),
  shouldUseEgoBrowserMedia("https://f.video.weibocdn.com/example.mp4"),
  shouldUseEgoBrowserMedia("https://article-images.zsxq.com/example.jpg"),
  shouldUseEgoBrowserMedia("https://v26-web.douyinvod.com/example.mp4"),
];
console.log(JSON.stringify({ pages, media }));
`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: root,
			HOME: root,
			USERPROFILE: root,
		},
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		pages: [true, true, true, true, true, true, true, true],
		media: [true, true, true, true, true, true, true, true],
	});
});

test("Douyin collection links prefer the modal video id over the embedded vid", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ego-douyin-url-"));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
const { getDouyinVideoId, isDouyinVideoURL, normalizeDouyinVideoURL } = await import(${JSON.stringify(new URL("../ego-browser.ts", import.meta.url).href)});
const collectionUrl = "https://www.douyin.com/user/example?modal_id=7434048670523329832&vid=7675681543088752115";
const vidOnlyUrl = "https://www.douyin.com/user/example?vid=7675681543088752115";
console.log(JSON.stringify({
  collectionId: getDouyinVideoId(collectionUrl),
  collectionSupported: isDouyinVideoURL(collectionUrl),
  normalized: normalizeDouyinVideoURL(collectionUrl),
  vidOnlyId: getDouyinVideoId(vidOnlyUrl),
  invalid: isDouyinVideoURL("https://www.douyin.com/user/example"),
}));
`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: root,
			HOME: root,
			USERPROFILE: root,
		},
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), {
		collectionId: "7434048670523329832",
		collectionSupported: true,
		normalized: "https://www.douyin.com/video/7434048670523329832",
		vidOnlyId: "7675681543088752115",
		invalid: false,
	});
});

test("Douyin video downloads stage source tracks separately from final artifact names", async () => {
	const { buildDouyinVideoScript } = await import("../ego-browser.ts");
	const script = buildDouyinVideoScript(
		"https://www.douyin.com/video/7462269663943183642",
		"pi-web-access-test-douyin",
		30_000,
		"/tmp/pi-web-access-douyin-run",
	);
	assert.match(script, /video-source\.mp4/);
	assert.match(script, /audio-source\.m4a/);
	assert.doesNotMatch(script, /douyin-video-track\.mp4/);
	assert.doesNotMatch(script, /douyin-audio-track\.m4a/);
});

test("configured media hosts return original image bytes through Ego Browser", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-ego-media-"));
	const fakeEgo = join(root, "fake-ego-browser");
	const payload = JSON.stringify({
		taskSpaceId: "43",
		url: "https://example.com/assets/example.jpg",
		mimeType: "image/jpeg",
		bytes: 4,
		data: "/9j/AA==",
	});
	writeFileSync(fakeEgo, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '__PI_WEB_ACCESS_EGO_RESULT__${payload}'\n`, "utf8");
	chmodSync(fakeEgo, 0o755);
	writeFileSync(join(root, "web-search.json"), JSON.stringify({
		egoBrowser: { enabled: true, firstPartyDomains: ["example.com"], mediaDomains: ["pbs.twimg.com"] },
	}) + "\n", "utf8");

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
const { fetchMediaWithEgoBrowser, shouldUseEgoBrowserMedia } = await import(${JSON.stringify(new URL("../ego-browser.ts", import.meta.url).href)});
	const url = "https://example.com/assets/example.jpg";
	const sourceUrl = "https://example.com/post/1";
if (!shouldUseEgoBrowserMedia(url, { sourceUrl })) throw new Error("source-page media host was not enabled");
const result = await fetchMediaWithEgoBrowser(url, undefined, { sessionId: "session-123", sourceUrl });
console.log(JSON.stringify(result));
`,
		encoding: "utf8",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: root,
			HOME: root,
			USERPROFILE: root,
			PI_EGO_BROWSER_BIN: fakeEgo,
		},
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.taskSpaceId, "43");
	assert.equal(result.mimeType, "image/jpeg");
	assert.equal(result.bytes, 4);
	assert.equal(result.data, "/9j/AA==");
});
