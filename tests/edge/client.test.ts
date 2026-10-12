import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJson } from "../../lib/edge/client";

test("an HTML 404 becomes an actionable message instead of a JSON parse error", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("Not found", {status:404}));
  await assert.rejects(fetchJson('/missing'), /endpoint was not found/);
});
test("a missing scan retains its specific recovery message", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({error:"scan_not_found"}, {status:404}));
  await assert.rejects(fetchJson('/missing'), /Start again with your wallet/);
});
test("a network failure explains that the server cannot be reached", async t => {
  t.mock.method(globalThis, "fetch", async () => {throw new TypeError('fetch failed')});
  await assert.rejects(fetchJson('/offline'), /Unable to reach the server/);
});
test("a hanging fetch times out rather than leaving the scan loading forever", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  t.mock.method(globalThis,"fetch",(_url: unknown, init: RequestInit)=>new Promise((_resolve,reject)=>{
    init.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));
  }));
  const request = fetchJson('/hanging');
  const assertion = assert.rejects(request, /request timed out/);
  t.mock.timers.tick(20_000);
  await assertion;
});
