// Run with: npm test
// Boots the real server in mock mode — no API key, no network.
process.env.SIZE_OVERLAY_MOCK = "1";

import net from "node:net";
import assert from "node:assert/strict";
import test from "node:test";

// Dynamic, not a static import: static imports are hoisted above the env
// assignment above, and the server reads SIZE_OVERLAY_MOCK at module scope.
const { createServer, __test } = await import("../server.js");

const { server } = createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

test("serves the page at /", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /<title>Size overlay<\/title>/);
});

test("serves assets with the right content type", async () => {
  const css = await fetch(base + "/styles.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);

  const js = await fetch(base + "/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
});

test("404s an unknown path", async () => {
  assert.equal((await fetch(base + "/nope.html")).status, 404);
});

test("a raw ../ path cannot escape public/", async () => {
  // fetch() normalises the path away, so write the request by hand.
  const raw = await rawGet("/../package.json");
  assert.match(raw, /^HTTP\/1\.1 (403|404)/);
  assert.doesNotMatch(raw, /"name": "size-overlay"/);
});

test("an encoded ../ path cannot escape public/ either", async () => {
  const raw = await rawGet("/..%2F..%2Fpackage.json");
  assert.match(raw, /^HTTP\/1\.1 (403|404)/);
  assert.doesNotMatch(raw, /"name": "size-overlay"/);
});

test("a sibling directory sharing the public/ prefix is refused", async () => {
  const raw = await rawGet("/../public-backup/secret.txt");
  assert.match(raw, /^HTTP\/1\.1 (403|404)/);
});

test("GET on the API is 405", async () => {
  const res = await fetch(base + "/api/dimensions");
  assert.equal(res.status, 405);
});

test("an empty query is 400", async () => {
  const res = await post({ query: "  " });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /No product/);
});

test("a non-JSON body is 400, not a crash", async () => {
  const res = await fetch(base + "/api/dimensions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json"
  });
  assert.equal(res.status, 400);
});

test("an oversized body is refused", async () => {
  const res = await fetch(base + "/api/dimensions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "x".repeat(20000) })
  }).catch((e) => e);
  // The server destroys the socket, so either a 413 or a transport error is fine.
  if (res instanceof Error) return;
  assert.equal(res.status, 413);
});

test("a lookup returns usable variants, then caches", async () => {
  const first = await (await post({ query: "test widget" })).json();
  assert.ok(Array.isArray(first.variants) && first.variants.length >= 1);
  for (const v of first.variants) {
    for (const k of ["l_cm", "w_cm", "h_cm"]) {
      assert.ok(Number.isFinite(v[k]) && v[k] > 0, `${v.name}.${k} must be a positive number`);
    }
  }
  const second = await (await post({ query: "TEST WIDGET" })).json();
  assert.equal(second.cached, true);
});

test("extractJson survives fenced and chatty replies", () => {
  assert.deepEqual(__test.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(__test.extractJson('Sure! {"a":1} hope that helps'), { a: 1 });
  assert.throws(() => __test.extractJson("no object here"), /did not return JSON/);
  assert.throws(() => __test.extractJson("{oops}"), /would not parse/);
});

test("validate drops variants with unusable numbers", () => {
  const out = __test.validate(
    {
      product: "Thing",
      variants: [
        { name: "Good", l_cm: 10, w_cm: 20, h_cm: 30, confidence: "high", note: "" },
        { name: "Missing height", l_cm: 10, w_cm: 20, confidence: "high" },
        { name: "Nonsense", l_cm: "about 40", w_cm: 20, h_cm: 30 },
        { name: "Negative", l_cm: -1, w_cm: 20, h_cm: 30 }
      ],
      weight_kg: 2
    },
    []
  );
  assert.equal(out.variants.length, 1);
  assert.equal(out.variants[0].name, "Good");
});

test("validate rejects a reply with nothing usable", () => {
  assert.throws(() => __test.validate({ variants: [{ name: "x" }] }, []), /No usable dimensions/);
  assert.throws(() => __test.validate({ error: "couldn't find it" }, []), /couldn't find it/);
  assert.throws(() => __test.validate({}, []), /no variants array/);
});

test("validate defaults an unknown confidence down, not up", () => {
  const out = __test.validate(
    { variants: [{ name: "V", l_cm: 1, w_cm: 1, h_cm: 1, confidence: "certain" }] },
    []
  );
  assert.equal(out.variants[0].confidence, "low");
});

test.after(() => server.close());

function post(body) {
  return fetch(base + "/api/dimensions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

/** fetch() and URL both collapse "..", so talk to the socket directly. */
function rawGet(pathname) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let out = "";
    socket.on("data", (c) => (out += c));
    socket.on("end", () => resolve(out));
    socket.on("error", reject);
  });
}
