import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, "public");
const PORT = Number(process.env.PORT || 3000);

// claude-opus-5 and web_search_20260209 were checked against the current API
// reference. Both are exact strings — never append a date suffix to the model.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 8 };

// A server-tool turn stops with stop_reason "pause_turn" when the server-side
// loop hits its iteration cap. You resume by resending the conversation with the
// paused assistant turn appended and NO new user message.
const MAX_RESUMES = 5;

const MAX_BODY_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = Number(process.env.LOOKUP_TIMEOUT_MS || 120_000);
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 200;
const MOCK = process.env.SIZE_OVERLAY_MOCK === "1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

const PROMPT = `You look up the physical dimensions of consumer products.

Search the web for the product named by the user. Report its dimensions in
centimetres. If the product folds, collapses or packs down, report BOTH the
folded/packed and the open/assembled dimensions.

Retailer listings frequently disagree, often because a product was revised
between model years. When sources conflict, report the range you found and
say so. Never average conflicting figures into a single invented number, and
never state a dimension you did not find in a source.

Every variant needs all three of l_cm, w_cm and h_cm as plain numbers. If a
source gives only two of the three, search for the third rather than guessing
it; if it genuinely cannot be found, leave that variant out and say why in the
caveat.

Reply with a JSON object and nothing else. No prose, no markdown fences.

{
  "product": "the product as you identified it",
  "variants": [
    {
      "name": "Folded",
      "l_cm": number, "w_cm": number, "h_cm": number,
      "confidence": "high" | "mixed" | "low",
      "note": "one short sentence: where the numbers came from, and any conflict"
    }
  ],
  "weight_kg": number or null,
  "caveat": "one sentence, or empty string"
}

If you cannot find dimensions at all, return {"error": "what you could not find"}.`;

const MOCK_REPLY = {
  product: "Mock product (SIZE_OVERLAY_MOCK=1 — no API call was made)",
  variants: [
    { name: "Folded", l_cm: 54, w_cm: 46.5, h_cm: 25, confidence: "high", note: "Canned mock data." },
    { name: "Unfolded", l_cm: 82, w_cm: 46.5, h_cm: 105, confidence: "mixed", note: "Canned mock data." }
  ],
  weight_kg: 9.5,
  caveat: "Mock mode is on, so these numbers are fixed and mean nothing.",
  sources: [{ title: "Mock source", url: "https://example.com/mock" }]
};

/** An error carrying the HTTP status the client should see. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

let client;
function getClient() {
  if (!client) {
    // The SDK resolves credentials itself: ANTHROPIC_API_KEY, then
    // ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile. Constructing with
    // none of those throws, which we turn into a clear 503 below.
    client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
  }
  return client;
}

/** Text blocks only. The response also carries server_tool_use and
 *  web_search_tool_result blocks — collect by type, never by position. */
function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Web search errors arrive as HTTP 200 with an error OBJECT where a successful
 *  block has an ARRAY of results, so branch on the shape before iterating. */
function sourcesOf(messages) {
  const seen = new Map();
  for (const message of messages) {
    for (const block of message.content || []) {
      if (block.type !== "web_search_tool_result") continue;
      if (!Array.isArray(block.content)) continue;
      for (const result of block.content) {
        if (result?.type === "web_search_result" && result.url && !seen.has(result.url)) {
          seen.set(result.url, { title: result.title || result.url, url: result.url });
        }
      }
    }
  }
  return [...seen.values()].slice(0, 12);
}

function extractJson(text) {
  const cleaned = text.replace(/^```(?:json)?/gm, "").replace(/```$/gm, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new HttpError(502, "The model did not return JSON. It said: " + text.slice(0, 200));
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new HttpError(502, "The model returned JSON that would not parse.");
  }
}

const CONFIDENCE = new Set(["high", "mixed", "low"]);

/** Never hand the front end a dimension the model did not actually produce —
 *  a NaN here becomes a silently wrong box on screen. */
function validate(raw, sources) {
  if (raw && typeof raw.error === "string") {
    throw new HttpError(422, raw.error);
  }
  if (!raw || !Array.isArray(raw.variants)) {
    throw new HttpError(502, "The model's reply had no variants array.");
  }

  const variants = [];
  for (const v of raw.variants) {
    const dims = ["l_cm", "w_cm", "h_cm"].map((k) => Number(v?.[k]));
    if (dims.some((n) => !Number.isFinite(n) || n <= 0 || n > 2000)) continue;
    variants.push({
      name: String(v.name || `Variant ${variants.length + 1}`).slice(0, 40),
      l_cm: dims[0],
      w_cm: dims[1],
      h_cm: dims[2],
      confidence: CONFIDENCE.has(v.confidence) ? v.confidence : "low",
      note: String(v.note || "").slice(0, 300)
    });
  }

  if (!variants.length) {
    throw new HttpError(422, "No usable dimensions came back — every variant was missing a measurement.");
  }

  const weight = Number(raw.weight_kg);
  return {
    product: String(raw.product || "Unnamed product").slice(0, 120),
    variants,
    weight_kg: Number.isFinite(weight) && weight > 0 ? weight : null,
    caveat: String(raw.caveat || "").slice(0, 300),
    sources
  };
}

async function lookup(query) {
  if (MOCK) return { ...MOCK_REPLY, product: `${query} — ${MOCK_REPLY.product}` };

  let api;
  try {
    api = getClient();
  } catch {
    throw new HttpError(503, "No Anthropic credentials. Set ANTHROPIC_API_KEY, or run `ant auth login`.");
  }

  const messages = [{ role: "user", content: query }];
  const turns = [];

  let message;
  try {
    message = await api.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: PROMPT,
      tools: [WEB_SEARCH],
      messages
    });
    turns.push(message);

    let resumes = 0;
    while (message.stop_reason === "pause_turn" && resumes < MAX_RESUMES) {
      messages.push({ role: "assistant", content: message.content });
      message = await api.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: PROMPT,
        tools: [WEB_SEARCH],
        messages
      });
      turns.push(message);
      resumes += 1;
    }
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionTimeoutError) {
      throw new HttpError(504, "The lookup took too long and was abandoned.");
    }
    if (e instanceof Anthropic.RateLimitError) {
      throw new HttpError(429, "Rate limited by the API. Wait a moment and try again.");
    }
    if (e instanceof Anthropic.AuthenticationError) {
      throw new HttpError(401, "The API rejected the credentials.");
    }
    if (e instanceof Anthropic.APIStatusError) {
      throw new HttpError(502, `API ${e.status}: ${String(e.message).slice(0, 200)}`);
    }
    if (e instanceof Anthropic.APIConnectionError) {
      throw new HttpError(502, "Could not reach the API.");
    }
    throw e;
  }

  if (message.stop_reason === "pause_turn") {
    throw new HttpError(504, "The search kept going past the resume limit. Try a more specific product name.");
  }
  if (message.stop_reason === "refusal") {
    throw new HttpError(422, "The model declined this request.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new HttpError(502, "The reply was cut off before the JSON was complete.");
  }

  return validate(extractJson(textOf(message)), sourcesOf(turns));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res) {
  let rel;
  try {
    rel = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (rel === "/") rel = "/index.html";

  // path.resolve collapses "..", and the separator on the prefix stops
  // "/../public-backup/x" from passing a bare startsWith(PUBLIC) check.
  const file = path.resolve(PUBLIC, "." + path.posix.normalize(rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleDimensions(req, res) {
  const body = await readBody(req);
  let query;
  try {
    query = JSON.parse(body || "{}").query;
  } catch {
    throw new HttpError(400, "Body was not valid JSON");
  }
  if (typeof query !== "string" || !query.trim()) {
    throw new HttpError(400, "No product given");
  }
  query = query.trim().slice(0, 200);

  const key = query.toLowerCase();
  const cached = cacheGet(key);
  if (cached) {
    sendJson(res, 200, { ...cached, cached: true });
    return;
  }

  const result = await lookup(query);
  cacheSet(key, result);
  sendJson(res, 200, result);
}

const handler = (req, res) => {
  if (req.url.split("?")[0] === "/api/dimensions") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Use POST" });
      return;
    }
    handleDimensions(req, res).catch((e) => {
      if (res.headersSent) return;
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error("lookup failed:", e);
      sendJson(res, status, { error: String(e.message || e) });
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("Method not allowed");
    return;
  }
  serveStatic(req, res);
};

const keyPath = path.join(DIR, "certs", "key.pem");
const certPath = path.join(DIR, "certs", "cert.pem");

export const __test = { extractJson, validate, HttpError };

export function createServer() {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      server: https.createServer(
        { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
        handler
      ),
      secure: true
    };
  }
  return { server: http.createServer(handler), secure: false };
}

// Only listen when run directly, so the tests can import createServer.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { server, secure } = createServer();
  server.listen(PORT, () => {
    if (MOCK) console.log("MOCK MODE — canned data, no API calls.");
    if (secure) {
      console.log(`https://localhost:${PORT} — open your LAN address on your phone for the camera`);
    } else {
      console.log(`http://localhost:${PORT}`);
      console.log("No certs found. The camera will NOT work from your phone over plain HTTP.");
      console.log("Run ./make-certs.sh, or see the README for the tunnel option.");
    }
  });
}
