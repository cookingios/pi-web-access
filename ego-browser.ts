import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { getWebSearchConfigPath } from "./utils.ts";
import { loadFetchContentDomainPolicy, loadSsrfConfig, validateRemoteUrl } from "./ssrf-protection.ts";
import {
	cleanupStaleDouyinRuns,
	findDouyinArtifact,
	getDouyinArtifactDirectory,
	getDouyinArtifactPaths,
	getDouyinRunDirectory,
} from "./media-temp.ts";

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
	"xueqiu.com",
	"articles.zsxq.com",
	"douyin.com",
];
const DEFAULT_MEDIA_DOMAINS = [
	"pbs.twimg.com",
	"video.twimg.com",
	"i.pximg.net",
	"preview.redd.it",
	"i.redd.it",
	"v.redd.it",
	"xhscdn.com",
	"xqimg.imedao.com",
	"sinaimg.cn",
	"weibocdn.com",
	"article-images.zsxq.com",
	"douyinvod.com",
	"douyinpic.com",
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

export interface DouyinFavoriteItem {
	url: string;
	title: string;
	author: string;
}

export interface DouyinFavoritesResult {
	taskSpaceId?: string | number;
	folder: string;
	creator?: string;
	totalVisible: number;
	matched: number;
	items: DouyinFavoriteItem[];
}

export interface DouyinVideoResult {
	taskSpaceId?: string | number;
	url: string;
	title: string;
	author?: string;
	publishedAt?: string;
	caption?: string;
	collectionName?: string;
	collectionId?: string;
	collectionUrl?: string;
	text: string;
	description: string;
	duration?: number;
	videoPath: string;
	audioPath?: string;
	videoBytes: number;
	audioBytes?: number;
}

const spaceLocks = new Map<string, Promise<void>>();
interface BrowserGoal {
	name: string;
	sessionKey: string;
	spaceId?: number;
	pageLabel: string;
	stopped?: string;
	finishAttempted?: boolean;
}
const activeSpaces = new Map<string, BrowserGoal>();
const SPACE_PREFIX = "__PI_WEB_ACCESS_EGO_SPACE__";

export class EgoBrowserStoppedError extends Error {
	constructor(message: string) { super(message); this.name = "EgoBrowserStoppedError"; }
}
export function isEgoBrowserStoppedError(error: unknown): boolean {
	return error instanceof EgoBrowserStoppedError;
}

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

function buildSpaceName(_url: string, config: EgoBrowserConfig, sessionId?: string): string {
	const sessionKey = sessionId || "session";
	const existing = [...activeSpaces.values()].find(goal => goal.sessionKey === sessionKey);
	if (existing) return existing.name;
	const name = `${config.spacePrefix}-${safePart(sessionKey)}-${randomUUID().slice(0, 8)}`;
	activeSpaces.set(name, { name, sessionKey, pageLabel: "p1" });
	return name;
}

function browserPrelude(spaceName: string): string {
	const goal = activeSpaces.get(spaceName);
	return `
const task = await taskSpace(${JSON.stringify(goal?.spaceId ?? spaceName)})
console.log(${JSON.stringify(SPACE_PREFIX)} + JSON.stringify({ spaceId: task.spaceId, pageLabel: ${JSON.stringify(goal?.pageLabel || "p1")} }))
const browserPage = task.page(${JSON.stringify(goal?.pageLabel || "p1")})
const checkDialog = async () => {
 const info = await browserPage.info()
 if (info?.dialog) {
  await task.handOff()
  throw new Error("Browser dialog requires user action; handle it then run /web-browser-resume")
 }
 return info
}
await checkDialog()
`;
}

function buildScript(url: string, spaceName: string, timeoutMs: number): string {
	return `
${browserPrelude(spaceName)}
await browserPage.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: ${timeoutMs} })
await browserPage.waitForFunction(() => Boolean(document.body?.innerText?.trim()), undefined, { timeout: ${timeoutMs} })
const info = await checkDialog()
let dom = {}
try {
  dom = await browserPage.evaluate(String.raw\`(() => {
    const hostname = location.hostname.toLowerCase()
    const isX = hostname === 'x.com' || hostname.endsWith('.x.com') || hostname === 'twitter.com' || hostname.endsWith('.twitter.com')
    const isPixiv = hostname === 'pixiv.net' || hostname.endsWith('.pixiv.net')
    const isReddit = hostname === 'reddit.com' || hostname.endsWith('.reddit.com')
    const isXiaohongshu = hostname === 'xiaohongshu.com' || hostname.endsWith('.xiaohongshu.com')
    const isXueqiu = hostname === 'xueqiu.com' || hostname.endsWith('.xueqiu.com')
    const isWeibo = hostname === 'weibo.com' || hostname.endsWith('.weibo.com')
    const isZsxq = hostname === 'articles.zsxq.com'
    const isDouyin = hostname === 'douyin.com' || hostname.endsWith('.douyin.com')
    const xueqiuArticle = isXueqiu
      ? document.querySelector('article.article__bd, .article__bd')
      : null
    const weiboPost = isWeibo
      ? document.querySelector('article, [class*="_detail_"]')
      : null
    const zsxqPost = isZsxq
      ? document.querySelector('.post.js_watermark.quill-editor, .post.quill-editor, .quill-editor')
      : null
    const article = !isPixiv && !isReddit && !isXiaohongshu && !isXueqiu && !isWeibo && !isZsxq
      ? [...document.querySelectorAll('article[data-testid="tweet"], article')].find((el) => el.querySelector('time')) || null
      : null
    const redditPost = isReddit
      ? document.querySelector('shreddit-post, [data-testid="post-container"], article')
      : null
    const scope = xueqiuArticle || article || redditPost || weiboPost || zsxqPost || document
    const scopedToPost = Boolean(xueqiuArticle || article || redditPost || weiboPost || zsxqPost)
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
      if (isXueqiu) {
        const primary = [...scope.querySelectorAll('img.ke_img[src]')]
        const candidates = (primary.length > 0 ? primary : [...scope.querySelectorAll('img[src]')])
          .map((el) => el.currentSrc || el.src)
          .filter((src) => hostMatchesUrl(src, 'xqimg.imedao.com'))
        return unique(candidates.map(normalizeUrl))
      }
      if (isWeibo) {
        const primary = [...scope.querySelectorAll('img.woo-picture-img, img[class*="_focusImg_"], .woo-picture-slot img')]
        const candidates = (primary.length > 0 ? primary : [...scope.querySelectorAll('img[src]')])
          .map((el) => el.currentSrc || el.src)
          .filter((src) => hostMatchesUrl(src, 'sinaimg.cn') || hostMatchesUrl(src, 'weibocdn.com'))
          .filter((src) => !/\\/avatar|\\/crop\\.|\\/upload\\/|\\/expression\\/|\\/face\\./i.test(src))
        return unique(candidates.map(normalizeUrl))
      }
      if (isZsxq) {
        const candidates = [...scope.querySelectorAll('img[src]')]
          .map((el) => el.currentSrc || el.src)
          .filter((src) => hostMatchesUrl(src, 'article-images.zsxq.com'))
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
      if (isDouyin) {
        const networkVideos = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((src) => hostMatchesUrl(src, 'douyinvod.com') && src.includes('media-video'))
        return unique([...candidates, ...networkVideos])
      }
      if (isXiaohongshu) return unique(candidates.filter((src) => hostMatchesUrl(src, 'xhscdn.com')))
      if (isReddit) return unique(candidates.filter((src) => hostMatchesUrl(src, 'redd.it') || hostMatchesUrl(src, 'redditmedia.com')))
      if (isXueqiu) return unique(candidates.filter((src) => hostMatchesUrl(src, 'imedao.com')))
      if (isWeibo) return unique(candidates.filter((src) => hostMatchesUrl(src, 'weibocdn.com') || hostMatchesUrl(src, 'sinaimg.cn')))
      if (isZsxq) return unique(candidates)
      return unique(candidates)
    })()
    const sourceUrl = location.href
    const media = [
      ...imageUrls.map((url) => ({ kind: 'image', url, source: scopedToPost ? 'article' : 'page', sourceUrl })),
      ...videoUrls.map((url) => ({ kind: 'video', url, source: scopedToPost ? 'article' : 'page', sourceUrl })),
    ]
    return {
    text: ((isXueqiu || isWeibo || isZsxq) ? (scope?.innerText || document.body?.innerText || '') : document.body?.innerText || ''),
    links: [...document.querySelectorAll('a[href]')].map((el) => el.href).filter(Boolean).slice(0, 200),
    images: [...new Set(imageUrls)].slice(0, 100),
    videos: [...new Set(videoUrls)].slice(0, 100),
    media: media.slice(0, 100),
    }
  })()\`)
} catch (error) {
  throw error
}
const snapshot = dom?.text?.trim() ? "" : await browserPage.snapshot({ scope: "full_page" })
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({
  taskSpaceId: task.spaceId,
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

function buildDouyinFavoritesScript(
	folder: string,
	creator: string | undefined,
	spaceName: string,
	timeoutMs: number,
	limit: number,
): string {

	const creatorFilter = creator?.trim() || null;
	return `
${browserPrelude(spaceName)}
await browserPage.goto('https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection', { waitUntil: "domcontentloaded", timeout: ${timeoutMs} })
await browserPage.waitForFunction(() => Boolean(document.body?.innerText?.trim()), undefined, { timeout: ${timeoutMs} })
const selection = await browserPage.evaluate(String.raw\`(() => {
  const wanted = ${JSON.stringify(folder)}
  const visible = (el) => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
  const folderCard = [...document.querySelectorAll('[data-tip]')]
    .find((el) => el.getAttribute('data-tip') === wanted && visible(el))
  const candidates = [...document.querySelectorAll('p,button,span,div')]
    .filter((el) => el.children.length === 0 && (el.textContent || '').trim() === wanted && visible(el))
  const el = folderCard?.querySelector('p') || candidates.find((item) => item.tagName === 'P') || candidates[0]
  if (!el) return { found: false }
  el.click()
  return { found: true, tag: el.tagName, className: typeof el.className === 'string' ? el.className : '', cardClassName: folderCard?.className || '' }
})()\`)
await checkDialog()
if (!selection?.found) {
  console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ taskSpaceId: task.spaceId, error: 'Could not find Douyin favorite folder: ' + ${JSON.stringify(folder)} }))
} else {
  const collectionStateScript = String.raw\`(() => {
    const wanted = ${JSON.stringify(folder)}
    const visible = (el) => { const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
    const folderCard = [...document.querySelectorAll('[data-tip]')]
      .find((el) => el.getAttribute('data-tip') === wanted && visible(el))
    let scope = folderCard || document.body
    while (scope && scope !== document.body) {
      const hasList = [...scope.querySelectorAll('ul')].some((list) => [...list.children].some((child) => child.querySelector('a[href*="/video/"]')))
      if (hasList) break
      scope = scope.parentElement
    }
    const lists = [...scope.querySelectorAll('ul')].map((list) => {
      const anchors = [...list.children].flatMap((child) => [...child.querySelectorAll('a[href*="/video/"]')])
      return { list, count: anchors.length }
    }).filter((entry) => entry.count > 0).sort((a, b) => b.count - a.count)
    const list = lists[0]?.list || null
    const route = [...document.querySelectorAll('.route-scroll-container')]
      .find((el) => el.contains(folderCard) || (list && el.contains(list)))
    if (route) {
      const step = Math.max(500, route.clientHeight - 100)
      route.scrollTop = Math.min(route.scrollHeight, route.scrollTop + step)
      route.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    const scopeText = scope?.innerText || ''
    return {
      count: list ? list.querySelectorAll('a[href*="/video/"]').length : 0,
      empty: !list && /暂无内容|没有内容|还没有收藏/.test(scopeText),
      atBottom: !route || route.scrollTop + route.clientHeight >= route.scrollHeight - 8,
    }
  })()\`
  let previousCount = -1
  let stableSteps = 0
  for (let i = 0; i < 30; i++) {
    const state = await browserPage.evaluate(collectionStateScript)
    if (state?.empty) break
    if (state?.count === previousCount && state?.atBottom) stableSteps++
    else stableSteps = 0
    previousCount = state?.count ?? previousCount
    if ((state?.count || 0) > 0 && stableSteps >= 3) break
    await browserPage.waitForTimeout(1500)
  }
  const result = await browserPage.evaluate(String.raw\`(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
    const creator = ${JSON.stringify(creatorFilter)}
    const wanted = ${JSON.stringify(folder)}
    const folderCard = [...document.querySelectorAll('[data-tip]')]
      .find((el) => el.getAttribute('data-tip') === wanted)
    let scope = folderCard || document.body
    while (scope && scope !== document.body) {
      const hasList = [...scope.querySelectorAll('ul')].some((list) => [...list.children].some((child) => child.querySelector('a[href*="/video/"]')))
      if (hasList) break
      scope = scope.parentElement
    }
    const list = [...scope.querySelectorAll('ul')].map((candidate) => {
      const anchors = [...candidate.children].flatMap((child) => [...child.querySelectorAll('a[href*="/video/"]')])
      return { candidate, count: anchors.length }
    }).filter((entry) => entry.count > 0).sort((a, b) => b.count - a.count)[0]?.candidate
    const rows = (list ? [...list.querySelectorAll('a[href*="/video/"]')] : []).map((anchor) => {
      let url = ''
      try {
        const parsed = new URL(anchor.href, location.href)
        parsed.search = ''
        parsed.hash = ''
        url = parsed.toString()
      } catch {}
      const image = anchor.querySelector('img[alt]')
      const alt = normalize(image?.alt || '')
      const match = alt.match(/^([^：:]{1,120})[：:]\\s*(.*)$/)
      const author = normalize(match?.[1] || '')
      const title = normalize(match?.[2] || anchor.innerText || alt)
      return { url, title, author, searchable: normalize([author, title, alt].join(' ')).toLowerCase() }
    }).filter((item) => item.url && item.title)
    const unique = []
    const seen = new Set()
    for (const item of rows) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      if (creator && !item.searchable.includes(creator.toLowerCase())) continue
      unique.push({ url: item.url, title: item.title, author: item.author })
    }
    return { totalVisible: rows.length, matched: unique.length, items: unique.slice(0, ${limit}) }
  })()\`)
  console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ taskSpaceId: task.spaceId, folder: ${JSON.stringify(folder)}, creator: ${JSON.stringify(creatorFilter)}, selection, ...result }))
}
`;
}

export function buildDouyinVideoScript(url: string, spaceName: string, timeoutMs: number, outputDir: string): string {
	return [
		"const { mkdir, writeFile } = await import('node:fs/promises')",
		"const { join } = await import('node:path')",
		browserPrelude(spaceName),
		"const bounded = async (promise, limitMs, label) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), limitMs) })]) } finally { clearTimeout(timer) } }",
		'await browserPage.goto(' + JSON.stringify(url) + ', { waitUntil: "domcontentloaded", timeout: ' + timeoutMs + ' })',
		"await mkdir(" + JSON.stringify(outputDir) + ", { recursive: true })",
		"const errors = []",
		"const deadline = Date.now() + " + String(timeoutMs),
		"const mediaDeadline = Date.now() + 15000",
		"const pageScript = String.raw`(() => {",
		"  const resources = performance.getEntriesByType('resource').map((entry) => entry.name)",
		"  const video = [...document.querySelectorAll('video')].find((item) => item.readyState > 0 || item.src)",
		"  const currentTitle = document.title || ''",
		"  const title = currentTitle.endsWith(' - 抖音') ? currentTitle.slice(0, -5).trim() : currentTitle.trim()",
		"  const description = document.querySelector('meta[name=description]')?.content || ''",
		"  const bodyText = document.body?.innerText || ''",
		"  const authorMatch = description.match(/-\\s*(.+?)于\\d{8}发布在抖音/)",
		"  const publishedMatch = bodyText.match(/(?:^|\\n)发布时间[:：]\\s*(\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:\\s+\\d{1,2}:\\d{2})?)/)",
		"  const collectionLink = [...document.querySelectorAll('a[href*=\"/collection/\"]')].map((item) => ({ name: (item.innerText || item.textContent || '').trim(), url: item.href })).find((item) => item.name)",
		"  const collectionMatch = bodyText.match(/(?:^|\\n)合集\\s*[·•]\\s*([^\\n]+)/)",
		"  const collectionName = collectionMatch?.[1]?.trim() || collectionLink?.name || ''",
		"  const collectionUrl = collectionLink?.url || ''",
		"  const collectionId = collectionUrl.match(/\\/collection\\/(\\d+)/)?.[1] || ''",
		"  const findMedia = (part) => resources.filter((item) => item.includes('douyinvod.com') && item.includes(part)).at(-1) || ''",
		"  const directUrl = /^https?:\\/\\//.test(video?.currentSrc || video?.src || '') ? (video.currentSrc || video.src) : ''",
		"  return { title, author: authorMatch?.[1]?.trim() || '', publishedAt: publishedMatch?.[1] || '', caption: title, collectionName, collectionId, collectionUrl, description, text: bodyText, duration: Number.isFinite(video?.duration) ? video.duration : undefined, userAgent: navigator.userAgent, referrer: location.href, videoUrl: findMedia('media-video') || directUrl, audioUrl: findMedia('media-audio') }",
		"})()`",
		"let metadata = {}",
		"let videoUrl = ''",
		"let audioUrl = ''",
		"while (Date.now() < deadline && (!videoUrl || (!audioUrl && Date.now() < mediaDeadline))) {",
		"  {",
		"    await checkDialog()",
		"    const fresh = await browserPage.evaluate(pageScript)",
		"    if (fresh?.title || fresh?.description || fresh?.text || fresh?.duration) metadata = { ...metadata, ...fresh }",
		"    if (fresh?.videoUrl) videoUrl = fresh.videoUrl",
		"    if (fresh?.audioUrl) audioUrl = fresh.audioUrl",
		"  }",
		"  if (videoUrl && audioUrl) break",
		"  await browserPage.waitForTimeout(500)",
		"}",
		"const resultBase = { taskSpaceId: task.spaceId, url: " + JSON.stringify(url) + ", title: metadata.title || '', author: metadata.author || '', publishedAt: metadata.publishedAt || '', caption: metadata.caption || metadata.title || '', collectionName: metadata.collectionName || '', collectionId: metadata.collectionId || '', collectionUrl: metadata.collectionUrl || '', description: metadata.description || '', text: metadata.text || '', duration: metadata.duration, videoPath: undefined, audioPath: undefined, videoBytes: 0, audioBytes: undefined, errors }",
		"const downloadTrack = async (kind, resourceUrl, filename, headers) => {",
		"  let response",
		"  try { response = await bounded(fetch(resourceUrl, { headers: { ...headers, Range: 'bytes=0-', Accept: '*/*' } }), 15000, 'Douyin ' + kind + ' request') } catch { throw new Error('network request failed') }",
		"  if (!response.ok && response.status !== 206) throw new Error('HTTP ' + response.status)",
		"  let body",
		"  try { body = Buffer.from(await bounded(response.arrayBuffer(), 60000, 'Douyin ' + kind + ' body')) } catch { throw new Error('response body read failed') }",
		"  const rawRange = String(response.headers.get('content-range') || '').replace('bytes ', '')",
		"  const slash = rawRange.split('/')",
		"  const bounds = slash[0]?.split('-') || []",
		"  const total = bounds.length === 2 && slash.length === 2 ? Number(slash[1]) : Number(response.headers.get('content-length') || 0)",
		"  if (!Number.isFinite(total) || total <= 0 || total > 50 * 1024 * 1024 || body.length < total) throw new Error('incomplete or oversized response')",
		"  const path = join(" + JSON.stringify(outputDir) + ", filename)",
		"  await writeFile(path, body.subarray(0, total), { mode: 0o600 })",
		"  return { path, bytes: total }",
		"}",
		"if (!videoUrl) {",
		"  console.log(" + JSON.stringify(RESULT_PREFIX) + " + JSON.stringify({ ...resultBase, error: 'Could not find a playable Douyin video resource in the logged-in page' }))",
		"} else {",
		"  const headers = { 'User-Agent': metadata.userAgent || '', Referer: metadata.referrer || " + JSON.stringify(url) + " }",
		"  let videoFile = null",
		"  let audioFile = null",
		"  try { videoFile = await downloadTrack('video', videoUrl, 'video-source.mp4', headers) } catch (error) { errors.push('Could not download Douyin video: ' + error.message) }",
		"  if (audioUrl) { try { audioFile = await downloadTrack('audio', audioUrl, 'audio-source.m4a', headers) } catch (error) { errors.push('Could not download Douyin audio: ' + error.message) } }",
		"  const page = { ...resultBase, videoPath: videoFile?.path, audioPath: audioFile?.path, videoBytes: videoFile?.bytes || 0, audioBytes: audioFile?.bytes }",
		"  console.log(" + JSON.stringify(RESULT_PREFIX) + " + JSON.stringify(videoFile ? page : { ...page, error: errors.join(' / ') || 'Could not download a complete Douyin video resource' }))",
		"}",
	].join('\n')
}

function buildMediaScript(url: string, spaceName: string, timeoutMs: number, maxBytes: number, sourceUrl?: string): string {
	return `
${browserPrelude(spaceName)}
${sourceUrl ? `await browserPage.goto(${JSON.stringify(sourceUrl)}, { waitUntil: "domcontentloaded", timeout: ${timeoutMs} })` : ""}
await browserPage.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: ${timeoutMs} })
const result = await browserPage.evaluate(String.raw\`(async () => {
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
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ taskSpaceId: task.spaceId, ...result }))
`;
}

function appendOutput(target: { value: string }, chunk: Buffer | string, maxBytes: number): void {
	target.value += chunk.toString();
	if (Buffer.byteLength(target.value, "utf8") > maxBytes) {
		throw new Error("Ego Browser output exceeded the safety limit");
	}
}

async function runEgoScript<T>(script: string, timeoutMs: number, signal?: AbortSignal, maxOutputBytes = MAX_PAGE_OUTPUT_BYTES, onSpace?: (spaceId: number, pageLabel: string) => void): Promise<T> {
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
			try {
				appendOutput(stdout, chunk, maxOutputBytes);
				for (const line of stdout.value.split(/\r?\n/).slice(0, -1)) {
					if (!line.startsWith(SPACE_PREFIX)) continue;
					const state = JSON.parse(line.slice(SPACE_PREFIX.length));
					if (Number.isInteger(state.spaceId)) onSpace?.(state.spaceId, state.pageLabel);
				}
			} catch (error) { child.kill("SIGTERM"); finish(new Error(errorMessage(error))); }
		});
		child.stderr.on("data", (chunk) => {
			try { appendOutput(stderr, chunk, maxOutputBytes); } catch (error) { child.kill("SIGTERM"); finish(new Error(errorMessage(error))); }
		});
		child.on("close", (code, closeSignal) => {
			if (signal?.aborted) { finish(new EgoBrowserStoppedError("Ego Browser operation aborted; space retained.")); return; }
			if (code !== 0) {
				finish(new Error(`Ego Browser failed: ${(stderr.value || stdout.value || `exit=${code}`).slice(-2000)}`));
				return;
			}
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

async function withSpaceLock<T>(spaceName: string, task: () => Promise<T>, control = false): Promise<T> {
	const previous = spaceLocks.get(spaceName) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => { release = resolve; });
	spaceLocks.set(spaceName, current);
	await previous;
	try {
		const goal = activeSpaces.get(spaceName);
		if (!control && !goal) throw new EgoBrowserStoppedError("Browser goal already finished; retry in a new goal.");
		if (!control && goal?.stopped) throw new EgoBrowserStoppedError(goal.stopped);
		return await task();
	} catch (error) {
		const goal = activeSpaces.get(spaceName);
		if (goal && !goal.stopped) goal.stopped = `Ego Browser stopped (space ${goal.spaceId ?? "unknown"}): ${errorMessage(error)}. Resolve the browser state, then explicitly run /web-browser-resume.`;
		if (!control && goal?.spaceId !== undefined && !isEgoBrowserStoppedError(error)) throw new EgoBrowserStoppedError(goal.stopped!);
		throw error;
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
	return withSpaceLock(spaceName, async () => {
		const page = await runBrowserScript<EgoBrowserPageData>(spaceName, buildScript(url, spaceName, config.timeoutMs), config.timeoutMs, signal);
		const text = (page.text || page.snapshot || "").trim();
		if (!text) throw new Error("Ego Browser opened the page but exposed no readable content");
		return { page: { ...page, text }, spaceName };
	});
}

export function isDouyinVideoURL(url: string): boolean {
	return getDouyinVideoId(url) !== null;
}

export function getDouyinVideoId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		if (!hostMatches(parsed.hostname.toLowerCase(), "douyin.com")) return null;
		const directMatch = parsed.pathname.match(/^\/video\/(\d+)\/?$/);
		if (directMatch) return directMatch[1];
		const modalId = parsed.searchParams.get("modal_id")?.trim() || "";
		if (/^\d+$/.test(modalId)) return modalId;
		const embeddedId = parsed.searchParams.get("vid")?.trim() || "";
		return /^\d+$/.test(embeddedId) ? embeddedId : null;
	} catch {
		return null;
	}
}

export function normalizeDouyinVideoURL(url: string): string | null {
	const videoId = getDouyinVideoId(url);
	return videoId ? `https://www.douyin.com/video/${videoId}` : null;
}

export async function fetchDouyinFavoritesWithEgoBrowser(
	options: { folder?: string; creator?: string; limit?: number; sessionId?: string; signal?: AbortSignal } = {},
): Promise<DouyinFavoritesResult> {
	const config = loadEgoBrowserConfig();
	if (!config.enabled) throw new Error("Ego Browser is disabled in web-search.json");
	const folder = options.folder?.trim() || "美食";
	const limit = Math.min(20, Math.max(1, Math.floor(options.limit ?? 5)));
	const spaceName = buildSpaceName("https://www.douyin.com", config, options.sessionId);
	return withSpaceLock(spaceName, async () => {
		const result = await runBrowserScript<DouyinFavoritesResult & { error?: string }>(spaceName,
			buildDouyinFavoritesScript(folder, options.creator, spaceName, config.timeoutMs, limit),
			config.timeoutMs,
			options.signal,
		);
		if (result.error) throw new Error(result.error);
		return result;
	});
}

function readCachedDouyinArtifact(paths: ReturnType<typeof getDouyinArtifactPaths>, canonicalUrl: string): DouyinVideoResult | null {
	try {
		const metadata = JSON.parse(readFileSync(paths.metadataPath, "utf8")) as Record<string, unknown>;
		const collection = metadata.collection && typeof metadata.collection === "object" && !Array.isArray(metadata.collection)
			? metadata.collection as Record<string, unknown>
			: {};
		const duration = typeof metadata.durationSeconds === "number" ? metadata.durationSeconds : undefined;
		return {
			url: typeof metadata.canonicalUrl === "string" ? metadata.canonicalUrl : canonicalUrl,
			title: typeof metadata.title === "string" ? metadata.title : "",
			author: typeof metadata.author === "string" ? metadata.author : undefined,
			publishedAt: typeof metadata.publishedAt === "string" ? metadata.publishedAt : undefined,
			caption: typeof metadata.caption === "string" ? metadata.caption : undefined,
			collectionName: typeof collection.name === "string" ? collection.name : undefined,
			collectionId: typeof collection.id === "string" ? collection.id : undefined,
			collectionUrl: typeof collection.url === "string" ? collection.url : undefined,
			text: typeof metadata.pageText === "string" ? metadata.pageText : "",
			description: typeof metadata.description === "string" ? metadata.description : "",
			duration,
			videoPath: paths.videoPath,
			audioPath: paths.audioPath,
			videoBytes: statSync(paths.videoPath).size,
			audioBytes: statSync(paths.audioPath).size,
		};
	} catch {
		return null;
	}
}

function remapDouyinArtifactPaths(result: DouyinVideoResult, sourceDirectory: string, targetDirectory: string): DouyinVideoResult {
		const remap = (path: string): string => {
			const suffix = relative(sourceDirectory, path);
			return suffix.startsWith("..") ? path : join(targetDirectory, suffix);
		};
		return {
			...result,
			videoPath: remap(result.videoPath),
			...(result.audioPath ? { audioPath: remap(result.audioPath) } : {}),
		};
}

export async function fetchDouyinVideoWithEgoBrowser(
	url: string,
	signal?: AbortSignal,
	options?: { sessionId?: string },
): Promise<DouyinVideoResult> {
	const canonicalUrl = normalizeDouyinVideoURL(url);
	if (!canonicalUrl) throw new Error("Not a supported Douyin video URL");
	const config = loadEgoBrowserConfig();
	if (!config.enabled) throw new Error("Ego Browser is disabled in web-search.json");
	const videoId = getDouyinVideoId(canonicalUrl) || "video";
	await cleanupStaleDouyinRuns();
	const cachedPaths = await findDouyinArtifact(videoId);
	const cached = cachedPaths ? readCachedDouyinArtifact(cachedPaths, canonicalUrl) : null;
	if (cached) return cached;
	const outputDir = getDouyinRunDirectory(options?.sessionId);
	await mkdir(outputDir, { recursive: true, mode: 0o700 });
	const spaceName = buildSpaceName(canonicalUrl, config, options?.sessionId);
	const captureTimeoutMs = Math.max(config.timeoutMs, 120_000);
	const scriptTimeoutMs = Math.max(15_000, captureTimeoutMs - 15_000);
	return withSpaceLock(spaceName, async () => {
		const result = await runBrowserScript<DouyinVideoResult & { error?: string }>(spaceName,
			buildDouyinVideoScript(canonicalUrl, spaceName, scriptTimeoutMs, outputDir),
			captureTimeoutMs,
			signal,
			MAX_PAGE_OUTPUT_BYTES,
		);
		if (result.error) throw new Error(result.error);
		if (!result.videoPath || !existsSync(result.videoPath)) {
			throw new Error("Douyin video resource was not downloaded");
		}
		const racedPaths = await findDouyinArtifact(videoId);
		const raced = racedPaths ? readCachedDouyinArtifact(racedPaths, canonicalUrl) : null;
		if (raced) {
			await rm(outputDir, { recursive: true, force: true });
			return raced;
		}
		const requestedDirectory = getDouyinArtifactDirectory(videoId, result.caption || result.title, result.publishedAt);
		const outputDirectory = existsSync(requestedDirectory)
			? `${requestedDirectory}-retry-${Date.now()}`
			: requestedDirectory;
		await mkdir(join(outputDirectory, ".."), { recursive: true, mode: 0o700 });
		await rename(outputDir, outputDirectory);
		return { ...remapDouyinArtifactPaths(result, outputDir, outputDirectory), url: canonicalUrl };
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
	return withSpaceLock(spaceName, async () => runBrowserScript<EgoBrowserMediaData>(spaceName,
		buildMediaScript(normalizedUrl, spaceName, config.timeoutMs, MAX_MEDIA_BYTES, options?.sourceUrl),
		config.timeoutMs,
		signal,
		MAX_MEDIA_OUTPUT_BYTES,
	));
}


async function runBrowserScript<T>(spaceName: string, script: string, timeoutMs: number, signal?: AbortSignal, maxOutputBytes = MAX_PAGE_OUTPUT_BYTES): Promise<T> {
	const goal = activeSpaces.get(spaceName);
	try {
		const result = await runEgoScript<T & { browserError?: string; error?: string }>(`
try {
${script}
} catch (error) {
 console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ browserError: String(error?.message || error), code: error?.code, executionStopped: error?.executionStopped, mayHaveLateEffects: error?.mayHaveLateEffects }))
}
`, timeoutMs, signal, maxOutputBytes, (spaceId, pageLabel) => {
			if (goal) { goal.spaceId = spaceId; goal.pageLabel = pageLabel; }
		});
		if (result.browserError) throw new EgoBrowserStoppedError(result.browserError);
		if (result.error) throw new Error(result.error);
		return result;
	} catch (error) {
		// Once a space exists, never route around a stopped/failed browser round.
		if (goal?.spaceId !== undefined || isEgoBrowserStoppedError(error)) {
			throw new EgoBrowserStoppedError(`Space ${goal?.spaceId ?? "unknown"}: ${errorMessage(error)}. Browser work stopped; resolve the browser state, then explicitly run /web-browser-resume.`);
		}
		throw error;
	}
}

/** Called only at the successful goal boundary, never as error/shutdown cleanup. */
export async function closeEgoBrowserSpaces(sessionId?: string): Promise<void> {
	const goals = [...activeSpaces.values()].filter(goal => sessionId === undefined || goal.sessionKey === sessionId);
	for (const goal of goals) {
		await withSpaceLock(goal.name, async () => {
			if (goal.stopped || goal.finishAttempted || goal.spaceId === undefined) return;
			goal.finishAttempted = true;
			const receipt = await runEgoScript<{ finished: boolean }>(`
const task = await taskSpace(${goal.spaceId})
await task.finish({ keep: [] })
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ finished: true }))
`, 15_000);
			if (!receipt.finished) throw new Error("Ego Browser did not confirm finish");
			activeSpaces.delete(goal.name);
		}, true);
	}
}

/** Only an explicit user command may authorize takeover; never called by a tool retry. */
export async function resumeEgoBrowserSpace(sessionId?: string): Promise<number> {
	const goal = [...activeSpaces.values()].find(item => item.sessionKey === (sessionId || "session"));
	if (!goal || goal.spaceId === undefined) throw new Error("No recorded browser space to resume. Inspect Ego Lite manually; no new space was created.");
	if (goal.finishAttempted) throw new Error("Finish was already attempted. Inspect the retained space manually; it will not be finished twice.");
	return withSpaceLock(goal.name, async () => {
		if (activeSpaces.get(goal.name) !== goal || goal.finishAttempted) throw new Error("Browser goal already finished or finish was attempted; inspect it manually.");
		const result = await runEgoScript<{ spaceId: number; pageLabel: string }>(`
const spaces = await listTaskSpaces()
const existing = spaces.find(space => space.id === ${goal.spaceId})
if (!existing) throw new Error("Recorded space no longer exists; no replacement was created")
const task = existing.ownership === "agent"
 ? await takeOverTaskSpace(${goal.spaceId})
 : await claimTaskSpace(${goal.spaceId})
let page = task.userPage() || task.page(${JSON.stringify(goal.pageLabel)})
if (!page.label) page = await task.adopt(page)
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify({ spaceId: task.spaceId, pageLabel: page.label }))
`, 15_000);
		if (result.spaceId !== goal.spaceId || !result.pageLabel) throw new Error("Unexpected browser resume receipt");
		goal.pageLabel = result.pageLabel;
		goal.stopped = undefined;
		return result.spaceId;
	}, true);
}
