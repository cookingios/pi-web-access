#!/usr/bin/env node
// Execute the submitted script with ONLY the v2 browser surface used by this
// extension. No legacy globals, network, or real browser are available.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';

const statePath = process.env.EGO_TEST_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
state.calls ??= [];
const save = () => writeFileSync(statePath, JSON.stringify(state));
const record = (...entry) => { state.calls.push(entry); save(); };
const page = {
 label: state.pageLabel || 'p1',
 async goto(url, options) {
  assert.equal(options.waitUntil, 'domcontentloaded');
  assert.ok(options.timeout >= 5000, 'timeouts must be milliseconds');
  record('goto', this.label, url, options.timeout);
  if (state.stopOnGoto) throw new Error('TaskSpace inactive: user took control');
  state.url = url;
  save();
 },
 async info() { return { title: 'Fixture page', url: state.url, ...(state.dialog ? { dialog: { type: 'alert' } } : {}) }; },
 async waitForFunction(fn, argument, options) {
  assert.equal(argument, undefined);
  assert.ok(options.timeout >= 5000);
  record('waitForFunction');
 },
 async waitForTimeout(ms) { assert.ok(ms >= 500); record('waitForTimeout', ms); },
 async snapshot(options) { assert.equal(options.scope, 'full_page'); return 'Fixture snapshot'; },
 async evaluate(fn, argument) {
  record('evaluate');
  if (state.stopOnEvaluate) throw new Error('Evaluation safety timeout: mayHaveLateEffects=true');
  const { document } = parseHTML('<html><head><title>Fixture page</title></head><body><p>Fixture browser content</p></body></html>');
  return runInNewContext(typeof fn === 'string' ? fn : `(${fn})(argument)`, {
   document, location: new URL(state.url), argument,
   performance: { getEntriesByType: () => [] },
   fetch: async () => ({ ok: true, url: state.url, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
   btoa: text => Buffer.from(text, 'binary').toString('base64'),
  });
 },
};
const task = {
 spaceId: 42,
 page(label) { assert.equal(label, state.pageLabel || 'p1'); record('page', label); return page; },
 userPage() { return state.unmanaged ? { ...page, label: undefined } : page; },
 async adopt() { record('adopt'); state.pageLabel = 'p2'; page.label = 'p2'; save(); return page; },
 async handOff() { record('handOff'); },
 async finish(options) {
  assert.deepEqual(options, { keep: [] });
  record('finish', 42);
  if (state.failFinish) throw new Error('finish receipt unavailable');
  state.closed = true; save();
  return { closed: ['p1'], kept: [] };
 },
};
const taskSpace = async id => {
 record('taskSpace', id);
 if (!state.created) { assert.equal(typeof id, 'string'); state.created = true; save(); }
 else assert.equal(id, 42, 'later rounds must resume the numeric ID');
 return task;
};
const takeOverTaskSpace = async id => {
 assert.equal(id, 42); record('takeOver', id); return task;
};
const listTaskSpaces = async () => [{ id:42, ownership: state.ownership || 'agent' }];
const claimTaskSpace = async id => { assert.equal(id,42); record('claim',id); return task; };
const script = readFileSync(0, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await new AsyncFunction('taskSpace', 'takeOverTaskSpace', 'listTaskSpaces', 'claimTaskSpace', script)(taskSpace, takeOverTaskSpace, listTaskSpaces, claimTaskSpace);
