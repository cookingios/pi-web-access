import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const moduleUrl = new URL('../ego-browser.ts', import.meta.url).href;
const extractUrl = new URL('../extract.ts', import.meta.url).href;
const fixture = fileURLToPath(new URL('../test-support/ego-v2-cli.mjs', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function runScenario(body, initial = {}) {
 const root = mkdtempSync(join(tmpdir(), 'ego-v2-contract-'));
 try {
  const bin = join(root, 'ego-cli');
  const statePath = join(root, 'state.json');
  writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`);
  chmodSync(bin, 0o755);
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(join(root, 'web-search.json'), JSON.stringify({ egoBrowser: { enabled: true, firstPartyDomains: ['example.com', 'example.org'], timeoutMs: 5000 } }));
  const child = spawnSync(process.execPath, ['--input-type=module'], {
   input: `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fetchWithEgoBrowser, fetchMediaWithEgoBrowser, fetchDouyinFavoritesWithEgoBrowser, closeEgoBrowserSpaces, resumeEgoBrowserSpace, isEgoBrowserStoppedError } from ${JSON.stringify(moduleUrl)};
const sessionId = 'goal-test';
const read = () => JSON.parse(readFileSync(process.env.EGO_TEST_STATE, 'utf8'));
const change = patch => writeFileSync(process.env.EGO_TEST_STATE, JSON.stringify({ ...read(), ...patch }));
${body}
`,
   env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_EGO_BROWSER_BIN: bin, EGO_TEST_STATE: statePath },
   encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(readFileSync(statePath, 'utf8'));
 } finally { rmSync(root, { recursive: true, force: true }); }
}

test('v2 scripts execute, reuse one space across domains and rounds, and finish once', () => {
 const state = runScenario(`
const [a,b] = await Promise.all([
 fetchWithEgoBrowser('https://example.com/a', undefined, {sessionId}),
 fetchWithEgoBrowser('https://example.org/b', undefined, {sessionId}),
]);
assert.equal(a.page.taskSpaceId, 42);
assert.equal(b.page.taskSpaceId, 42);
assert.match(a.page.text, /Fixture browser content/);
await closeEgoBrowserSpaces('different-session');
assert.equal(read().closed, undefined);
await closeEgoBrowserSpaces(sessionId);
await closeEgoBrowserSpaces(sessionId);
`);
 assert.deepEqual(state.calls.filter(c => c[0] === 'taskSpace').map(c => typeof c[1]), ['string', 'number', 'number']);
 assert.equal(state.calls.filter(c => c[0] === 'finish').length, 1);
 assert.deepEqual(state.calls.filter(c => c[0] === 'page').map(c => c[1]), ['p1', 'p1']);
});

test('user takeover blocks fallback and queued work; explicit resume adopts the user page', () => {
 const state = runScenario(`
globalThis.fetch = async () => { throw new Error('HTTP fallback must not run'); };
const { extractContent } = await import(${JSON.stringify(extractUrl)});
const result = await extractContent('https://example.com/a', undefined, {sessionId});
assert.equal(result.source, 'ego-browser');
assert.match(result.error, /inactive/);
const calls = read().calls.length;
await assert.rejects(fetchWithEgoBrowser('https://example.org/b', undefined, {sessionId}), isEgoBrowserStoppedError);
await closeEgoBrowserSpaces(sessionId);
assert.equal(read().calls.length, calls);
change({ stopOnGoto: false, unmanaged: true });
await resumeEgoBrowserSpace(sessionId);
await fetchWithEgoBrowser('https://example.org/b', undefined, {sessionId});
await closeEgoBrowserSpaces(sessionId);
`, { stopOnGoto: true });
 assert.equal(state.calls.filter(c => c[0] === 'takeOver').length, 1);
 assert.equal(state.calls.filter(c => c[0] === 'adopt').length, 1);
 assert.ok(state.calls.some(c => c[0] === 'page' && c[1] === 'p2'));
 assert.equal(state.calls.filter(c => c[0] === 'taskSpace' && typeof c[1] === 'string').length, 1);
});

test('failed finish is retained and never dispatched twice', () => {
 const state = runScenario(`
await fetchWithEgoBrowser('https://example.com/a', undefined, {sessionId});
await assert.rejects(closeEgoBrowserSpaces(sessionId), /finish receipt/);
await closeEgoBrowserSpaces(sessionId);
await assert.rejects(resumeEgoBrowserSpace(sessionId), /already attempted/);
await assert.rejects(fetchWithEgoBrowser('https://example.com/b', undefined, {sessionId}), isEgoBrowserStoppedError);
`, { failFinish: true });
 assert.equal(state.calls.filter(c => c[0] === 'finish').length, 1);
 assert.equal(state.closed, undefined);
});

test('dialogs hand off without accepting or dismissing and error rounds do not finish', () => {
 const state = runScenario(`
await assert.rejects(fetchWithEgoBrowser('https://example.com/a', undefined, {sessionId}), /requires user action/);
await closeEgoBrowserSpaces(sessionId);
`, { dialog: true });
 assert.equal(state.calls.filter(c => c[0] === 'handOff').length, 1);
 assert.equal(state.calls.filter(c => c[0] === 'goto' || c[0] === 'finish').length, 0);
});

test('evaluation safety timeouts stop the goal without a retry or finish', () => {
 const state = runScenario(`
await assert.rejects(fetchWithEgoBrowser('https://example.com/a', undefined, {sessionId}), isEgoBrowserStoppedError);
await assert.rejects(fetchWithEgoBrowser('https://example.org/b', undefined, {sessionId}), isEgoBrowserStoppedError);
await closeEgoBrowserSpaces(sessionId);
`, { stopOnEvaluate: true });
 assert.equal(state.calls.filter(c => c[0] === 'evaluate').length, 1);
 assert.equal(state.calls.filter(c => c[0] === 'finish').length, 0);
});

test('all generated browser programs are syntactically valid v2 scripts', async () => {
 const { buildDouyinVideoScript } = await import(moduleUrl);
 const script = buildDouyinVideoScript('https://www.douyin.com/video/123', 'test', 5000, '/tmp/not-executed');
 const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
 assert.doesNotThrow(() => new AsyncFunction('taskSpace', script));
 assert.doesNotMatch(script, /useOrCreateTaskSpace|gotoUrl|cliLog|\bjs\(|await wait\(/);
});


test('media script executes in the same goal and preserves original bytes', () => {
 const state = runScenario(`
await fetchWithEgoBrowser('https://example.com/a', undefined, {sessionId});
const media = await fetchMediaWithEgoBrowser('https://example.com/image.png', undefined, {sessionId, sourceUrl:'https://example.com/a'});
assert.equal(media.taskSpaceId, 42);
assert.equal(media.data, 'AQID');
assert.equal(media.bytes, 3);
await closeEgoBrowserSpaces(sessionId);
`);
 assert.equal(state.calls.filter(c => c[0] === 'taskSpace' && typeof c[1] === 'string').length, 1);
});

test('favorites script executes and reports a missing folder without creating another space', () => {
 const state = runScenario(`
await fetchWithEgoBrowser('https://example.com/a', undefined, {sessionId});
await assert.rejects(fetchDouyinFavoritesWithEgoBrowser({sessionId, folder:'Missing folder'}), /Could not find Douyin favorite folder/);
await closeEgoBrowserSpaces(sessionId);
`);
 assert.equal(state.calls.filter(c => c[0] === 'taskSpace' && typeof c[1] === 'string').length, 1);
 assert.equal(state.calls.filter(c => c[0] === 'finish').length, 0);
});


test('explicit resume claims a user-owned space by its numeric list ID', () => {
 const state = runScenario(`
await assert.rejects(fetchWithEgoBrowser('https://example.com/a', undefined, {sessionId}));
change({ stopOnGoto:false, ownership:'user' });
await resumeEgoBrowserSpace(sessionId);
await fetchWithEgoBrowser('https://example.com/b', undefined, {sessionId});
await closeEgoBrowserSpaces(sessionId);
`, {stopOnGoto:true});
 assert.equal(state.calls.filter(c => c[0] === 'claim').length, 1);
 assert.equal(state.calls.filter(c => c[0] === 'takeOver').length, 0);
});

test('Pi closes only at successful settled boundary, not agent_end or shutdown', () => {
 const state = runScenario(`
const {default: initialize} = await import(${JSON.stringify(new URL('../index.ts', import.meta.url).href)});
const handlers = {};
initialize({on(name, fn) {handlers[name]=fn;}, registerCommand(){}, registerTool(){}, registerShortcut(){}});
const ctx = {sessionManager:{getSessionId:()=>sessionId},ui:{notify(){}}};
await handlers.agent_start({},ctx);
await fetchWithEgoBrowser('https://example.com/a', undefined, {sessionId});
await handlers.agent_end({messages:[{role:'assistant',stopReason:'aborted'}]},ctx);
await handlers.agent_settled({},ctx);
assert.equal(read().closed, undefined);
await handlers.session_shutdown({},ctx);
assert.equal(read().closed, undefined);
await handlers.agent_start({},ctx);
await handlers.agent_end({messages:[{role:'assistant',stopReason:'stop'}]},ctx);
assert.equal(read().closed, undefined);
await handlers.agent_settled({},ctx);
assert.equal(read().closed,true);
`);
 assert.equal(state.calls.filter(c=>c[0]==='finish').length,1);
});
