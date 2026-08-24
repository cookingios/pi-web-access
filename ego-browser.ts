import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.ts";
import { loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl } from "./ssrf-protection.ts";

const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();
const RESULT_PREFIX = "__PI_WEB_ACCESS_EGO_RESULT__";
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_PAGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;
const DEFAULT_DOMAINS = [
	"x.com",
	"twitter.com",
	"pixiv.net",
	"instagram.com",
	"facebook.com",
	"threads.net",
	"weibo.com",
	"mp.weixin.qq.com",
	"feishu.cn",
	"larksuite.com",
	"reddit.com",
	"xiaohongshu.com",
];
const DEFAULT_MEDIA_DOMAINS = [
	"pbs.twimg.com",
	"video.twimg.com",
	"i.pximg.net",
	"preview.redd.it",
	"i.redd.it",
	"v.redd.it",
	"xhscdn.com",
];

export interface EgoBrowserConfig {
	enabled: boolean;
	firstPartyDomains: string[];
	mediaDomains: string[];
	timeoutMs: number;
	spacePrefix: string;
}

export interface EgoBrowserMedia {
	kind: "image" | "video";
	url: string;
	source: "article" | "page";
	sourceUrl?: string;
}

export interface EgoBrowserMediaData {
	url: string;
	mimeType: string;
	bytes: number;
	data: string;
	taskSpaceId?: string | number;
}

export interface EgoBrowserPageData {
	url: string;
	title: string;
	text: string;
	snapshot: string;
	links: string[];
	images: string[];
	videos: string[];
	media?: EgoBrowserMedia[];
	taskSpaceId?: string | number;
}

export interface EgoBrowserFetchResult {
	page: EgoBrowserPageData;
	spaceName: string;
}

const spaceLocks = new Map<string, Promise<void>>();
const activeSpaces = new Set<string>();

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function loadRootConfig(): Record<string, unknown> {
	if (!existsSync(WEB_SEARCH_CONFIG_PATH)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(WEB_SEARCH_CONFIG_PATH, "utf8"));
	} catch (error) {
		throw new Error(`Failed to parse ${WEB_SEARCH_CONFIG_PATH}: ${errorMessage(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid config in ${WEB_SEARCH_CONFIG_PATH}: expected a JSON object`);
	}
	return value as Record<string, unknown>;
}

function normalizeDomain(value: string): string {
	return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
}

function normalizeDomains(value: unknown): string[] {
	if (!Array.isArray(value)) return DEFAULT_DOMAINS;
	const domains = value
		.filter((entry): entry is string => typeof entry === "string")
		.map(normalizeDomain)
		.filter(Boolean);
	if (domains.length === 0) throw new Error(`egoBrowser.firstPartyDomains in ${WEB_SEARCH_CONFIG_PATH} must contain at least one hostname`);
	return [...new Set(domains)];
}

function normalizeOptionalDomains(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	const domains = value
		.filter((entry): entry is string => typeof entry === "string")
		.map(normalizeDomain)
		.filter(Boolean);
	if (domains.length === 0) throw new Error(`egoBrowser.mediaDomains in ${WEB_SEARCH_CONFIG_PATH} must contain at least one hostname`);
	return [...new Set(domains)];
}

function normalizeTimeout(value: unknown): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 5_000) {
		throw new Error(`egoBrowser.timeoutMs in ${WEB_SEARCH_CONFIG_PATH} must be a number >= 5000`);
	}
	return Math.min(Math.floor(value), 180_000);
}

export function loadEgoBrowserConfig(): EgoBrowserConfig {
	const root = loadRootConfig();
	const raw = root.egoBrowser;
	if (raw === undefined) {
		return {
			enabled: true,
			firstPartyDomains: DEFAULT_DOMAINS,
			mediaDomains: DEFAULT_MEDIA_DOMAINS,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			spacePrefix: "pi-web-access",
		};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`egoBrowser in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const config = raw as Record<string, unknown>;
	if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
		throw new Error(`egoBrowser.enabled in ${WEB_SEARCH_CONFIG_PATH} must be a boolean`);
	}
	const prefix = typeof config.spacePrefix === "string" && config.spacePrefix.trim()
		? config.spacePrefix.trim()
		: "pi-web-access";
	return {
		enabled: config.enabled !== false,
		firstPartyDomains: normalizeDomains(config.firstPartyDomains),
		mediaDomains: normalizeOptionalDomains(config.mediaDomains, DEFAULT_MEDIA_DOMAINS),
		timeoutMs: normalizeTimeout(config.timeoutMs),
		spacePrefix: prefix,
	};
}

function hostMatches(hostname: string, domain: string): boolean {
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function shouldUseEgoBrowser(url: string, options: { mode?: string; authFetchProfile?: unknown } = {}): boolean {
	if (options.mode === "raw" || options.authFetchProfile) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	const config = loadEgoBrowserConfig();
	return config.enabled && config.firstPartyDomains.some((domain) => hostMatches(parsed.hostname.toLowerCase(), domain));
}

export function shouldUseEgoBrowserMedia(url: string, options: { sourceUrl?: string } = {}): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	const config = loadEgoBrowserConfig();
	if (!config.enabled) return false;
	if (config.mediaDomains.some((domain) => hostMatches(parsed.hostname.toLowerCase(), domain))) return true;
	if (!options.sourceUrl) return false;
	return shouldUseEgoBrowser(options.sourceUrl);
}

function normalizeMediaUrl(value: string): string {
	try {
		const parsed = new URL(value);
		if (parsed.hostname.toLowerCase() === "pbs.twimg.com" && parsed.pathname.startsWith("/media/")) {
			parsed.searchParams.set("name", "orig");
		}
		return parsed.toString();
	} catch {
		return value;
	}
}

async function validateBrowserMediaUrls(url: string, sourceUrl?: string): Promise<void> {
	const ssrf = loadSsrfConfig();
	const domainPolicy = loadFetchContentDomainPolicy();
	const options = {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		domainPolicy,
	};
	await validateRemoteUrl(url, options);
	if (sourceUrl) await validateRemoteUrl(sourceUrl, options);
}

function safePart(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "page";
}

function buildSpaceName(url: string, config: EgoBrowserConfig, sessionId?: string): string {
	const parsed = new URL(url);
	const sessionPart = sessionId ? safePart(sessionId.slice(0, 24)) : "session";
	return `${config.spacePrefix}-${sessionPart}-${safePart(parsed.hostname)}`;
}

function buildScript(url: string, spaceName: string, timeoutMs: number): string {
	const timeoutSeconds = Math.max(5, Math.ceil(timeoutMs / 1000));
	return `
const task = await useOrCreateTaskSpace(${JSON.stringify(spaceName)})
await openOrReuseTab(${JSON.stringify(url)}, { wait: true, timeout: ${timeoutSeconds} })
await wait(3)
const info = await pageInfo()
const snapshot = await snapshotText()
let dom = {}
try {
  dom = await js(String.raw\`(() => {
    const hostname = location.hostname.toLowerCase()
    const isX = hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com')
    const isPixiv = hostname === 'pixiv.net' || hostname.endsWith('.pixiv.net')
    const isReddit = hostname === 'reddit.com' || hostname.endsWith('.reddit.com')
    const isXiaohongshu = hostname === 'xiaohongshu.com' || hostname.endsWith('.xiaohongshu.com')
    const article = !isPixiv && !isReddit && !isXiaohongshu
      ? [...document.querySelectorAll('article[data-testid="tweet"], article')].find((el) => el.querySelector('time')) || null
      : null
    const redditPost = isReddit
      ? document.querySelector('shreddit-post, [data-testid="post-container"], article')
      : null
    const scope = article || redditPost || document
    const scopedToPost = Boolean(article || redditPost)
    const unique = (values) => [...new Set(values.filter(Boolean))]
    const hostMatchesUrl = (src, domain) => {
      try {
        const host = new URL(src).hostname.toLowerCase()
        return host === domain || host.endsWith('.' + domain)
      } catch { return false }
    }
    const normalizeUrl = (src) => {
      try {
        const parsed = new URL(src)
        if (parsed.hostname === 'pbs.twimg.com' && parsed.pathname.startsWith('/media/')) parsed.searchParams.set('name', 'orig')
        return parsed.toString()
      } catch { return src }
    }
    const imageUrls = (() => {
      if (isPixiv) {
        const originalLinks = [...document.querySelectorAll('a[href*="/img-original/"]')]
          .map((el) => el.href)
        const renderedImages = [...document.querySelectorAll('a[href*="/img-original/"] img[src]')]
          .map((el) => el.currentSrc || el.src)
        return unique([...originalLinks, ...renderedImages].map(normalizeUrl))
      }
      if (isReddit) {
        const primary = [...scope.querySelectorAll('img.media-lightbox-img, shreddit-gallery img')]
        const candidates = (primary.length > 0 ? primary : [...scope.querySelectorAll('img[src]')])
          .map((el) => el.currentSrc || el.src)
          .filter((src) => hostMatchesUrl(src, 'preview.redd.it') || hostMatchesUrl(src, 'i.redd.it'))
          .filter((src) => !src.toLowerCase().includes('snoovatar') && !src.toLowerCase().includes('/avatars/'))
        return unique(candidates.map(normalizeUrl))
      }
      if (isXiaohongshu) {
        const candidates = [...document.querySelectorAll('[elementtiming="note-cover"] img[src], .note-slider-img img[src], img[src*="/notes_pre_post/"]')]
          .map((el) => el.currentSrc || el.src)
          .filter((src) => hostMatchesUrl(src, 'xhscdn.com') && src.includes('/notes_pre_post/'))
        return unique(candidates.map(normalizeUrl))
      }
      return unique([...scope.querySelectorAll('img[src]')]
        .map((el) => el.currentSrc || el.src)
        .filter(Boolean)
        .filter((src) => !isX || /pbs\\.twimg\\.com\\/media\\//.test(src))
        .map(normalizeUrl))
    })()
    const videoUrls = (() => {
      const candidates = [...scope.querySelectorAll('video, video source')]
        .map((el) => el.currentSrc || el.src)
        .filter(Boolean)
      if (isXiaohongshu) return unique(candidates.filter((src) => hostMatchesUrl(src, 'xhscdn.com')))
      if (isReddit) return unique(candidates.filter((src) => hostMatchesUrl(src, 'redd.it') || hostMatchesUrl(src, 'redditmedia.com')))
      return unique(candidates)
    })()
    const sourceUrl = location.href
    const media = [
      ...imageUrls.map((url) => ({ kind: 'image', url, source: scopedToPost ? 'article' : 'page', sourceUrl })),
      ...videoUrls.map((url) => ({ kind: 'video', url, source: scopedToPost ? 'article' : 'page', sourceUrl })),
    ]
    return {
    text: document.body?.innerText || '',
    links: [...document.querySelectorAll('a[href]')].map((el) => el.href).filter(Boolean).slice(0, 200),
    images: [...new Set(imageUrls)].slice(0, 100),
    videos: [...new Set(videoUrls)].slice(0, 100),
    media: media.slice(0, 100),
    }
  })()\`)
} catch (error) {
  dom = { error: String(error) }
}
cliLog(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({
  taskSpaceId: task.id,
  url: info?.url || ${JSON.stringify(url)},
  title: info?.title || '',
  snapshot: typeof snapshot === 'string' ? snapshot : '',
  text: typeof dom?.text === 'string' ? dom.text : '',
  links: Array.isArray(dom?.links) ? dom.links : [],
  images: Array.isArray(dom?.images) ? dom.images : [],
  videos: Array.isArray(dom?.videos) ? dom.videos : [],
  media: Array.isArray(dom?.media) ? dom.media : [],
}))
`;
}

function buildMediaScript(url: string, spaceName: string, timeoutMs: number, maxBytes: number, sourceUrl?: string): string {
	const timeoutSeconds = Math.max(5, Math.ceil(timeoutMs / 1000));
	return `
const task = await useOrCreateTaskSpace(${JSON.stringify(spaceName)})
${sourceUrl ? `await openOrReuseTab(${JSON.stringify(sourceUrl)}, { wait: true, timeout: ${timeoutSeconds} })` : ""}
await openOrReuseTab(${JSON.stringify(url)}, { wait: true, timeout: ${timeoutSeconds} })
const result = await js(String.raw\`(async () => {
  const target = ${JSON.stringify(normalizeMediaUrl(url))}
  const response = await fetch(target, { credentials: 'include', cache: 'force-cache' })
  if (!response.ok) throw new Error('Media request failed: HTTP ' + response.status)
  const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
  if (!contentType.startsWith('image/')) throw new Error('Expected an image response, received ' + (contentType || 'unknown content type'))
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > ${maxBytes}) throw new Error('Media exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB safety limit')
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return {
    url: response.url || target,
    mimeType: contentType,
    bytes: bytes.byteLength,
    data: btoa(binary),
  }
})()\`)
cliLog(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ taskSpaceId: task.id, ...result }))
`;
}

function appendOutput(target: { value: string }, chunk: Buffer | string, maxBytes: number): void {
	target.value += chunk.toString();
	if (Buffer.byteLength(target.value, "utf8") > maxBytes) {
		throw new Error("Ego Browser output exceeded the safety limit");
	}
}

async function runEgoScript<T>(script: string, timeoutMs: number, signal?: AbortSignal, maxOutputBytes = MAX_PAGE_OUTPUT_BYTES): Promise<T> {
	if (signal?.aborted) throw new Error("Aborted");
	const command = process.env.PI_EGO_BROWSER_BIN || "ego-browser";
	const child = spawn(command, ["nodejs"], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
	});
	let stdout = { value: "" };
	let stderr = { value: "" };
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const abort = () => child.kill("SIGTERM");

	return await new Promise<T>((resolve, reject) => {
		const finish = (error?: Error, result?: T) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else if (result) resolve(result);
			else reject(new Error("Ego Browser returned no result"));
		};

		child.on("error", (error) => finish(error));
		child.stdout.on("data", (chunk) => {
			try { appendOutput(stdout, chunk, maxOutputBytes); } catch (error) { child.kill("SIGTERM"); finish(new Error(errorMessage(error))); }
		});
		child.stderr.on("data", (chunk) => {
			try { appendOutput(stderr, chunk, maxOutputBytes); } catch (error) { child.kill("SIGTERM"); finish(new Error(errorMessage(error))); }
		});
		child.on("close", (code, closeSignal) => {
			const combinedOutput = `${stdout.value}\n${stderr.value}`;
			const markerIndex = combinedOutput.lastIndexOf(RESULT_PREFIX);
			const line = markerIndex >= 0
				? combinedOutput.slice(markerIndex + RESULT_PREFIX.length).split(/\r?\n/, 1)[0].trim()
				: null;
			if (line) {
				try {
					const parsed = JSON.parse(line) as T;
					finish(undefined, parsed);
					return;
				} catch (error) {
					finish(new Error(`Invalid Ego Browser result: ${errorMessage(error)}`));
					return;
				}
			}
			const detail = stderr.value.trim() || stdout.value.trim() || `exit=${code ?? "unknown"}${closeSignal ? ` signal=${closeSignal}` : ""}`;
			finish(new Error(`Ego Browser failed: ${detail.slice(-2000)}`));
		});
		timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error(`Ego Browser timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		child.stdin.end(script);
	});
}

async function withSpaceLock<T>(spaceName: string, task: () => Promise<T>): Promise<T> {
	const previous = spaceLocks.get(spaceName) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => { release = resolve; });
	spaceLocks.set(spaceName, current);
	await previous;
	try {
		return await task();
	} finally {
		release();
		if (spaceLocks.get(spaceName) === current) spaceLocks.delete(spaceName);
	}
}

export async function fetchWithEgoBrowser(
	url: string,
	signal?: AbortSignal,
	options?: { sessionId?: string },
): Promise<EgoBrowserFetchResult> {
	const config = loadEgoBrowserConfig();
	const spaceName = buildSpaceName(url, config, options?.sessionId);
	activeSpaces.add(spaceName);
	return withSpaceLock(spaceName, async () => {
		const page = await runEgoScript<EgoBrowserPageData>(buildScript(url, spaceName, config.timeoutMs), config.timeoutMs, signal);
		const text = (page.text || page.snapshot || "").trim();
		if (!text) throw new Error("Ego Browser opened the page but exposed no readable content");
		return { page: { ...page, text }, spaceName };
	});
}

export async function fetchMediaWithEgoBrowser(
	url: string,
	signal?: AbortSignal,
	options?: { sessionId?: string; sourceUrl?: string },
): Promise<EgoBrowserMediaData> {
	if (!shouldUseEgoBrowserMedia(url, options?.sourceUrl ? { sourceUrl: options.sourceUrl } : undefined)) {
		let host = "the requested host";
		try { host = new URL(url).hostname; } catch {}
		throw new Error(`Ego Browser media fetching is not enabled for ${host}`);
	}
	const config = loadEgoBrowserConfig();
	const normalizedUrl = normalizeMediaUrl(url);
	await validateBrowserMediaUrls(normalizedUrl, options?.sourceUrl);
	const spaceName = buildSpaceName(options?.sourceUrl || normalizedUrl, config, options?.sessionId);
	activeSpaces.add(spaceName);
	return withSpaceLock(spaceName, async () => runEgoScript<EgoBrowserMediaData>(
		buildMediaScript(normalizedUrl, spaceName, config.timeoutMs, MAX_MEDIA_BYTES, options?.sourceUrl),
		config.timeoutMs,
		signal,
		MAX_MEDIA_OUTPUT_BYTES,
	));
}

export async function closeEgoBrowserSpaces(): Promise<void> {
	const spaces = [...activeSpaces];
	activeSpaces.clear();
	if (spaces.length === 0) return;
	const script = `
for (const name of ${JSON.stringify(spaces)}) {
  try { await completeTaskSpace(name, { keep: false }) } catch {}
}
cliLog(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ closed: ${spaces.length} }))
`;
	try {
		await runEgoScript(script, 15_000);
	} catch {
		// Session shutdown must not fail just because the browser is unavailable.
	}
}
