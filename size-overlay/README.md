# Size overlay

Hold your phone up to a doorway, a boot, a gap between two bits of furniture, and
see roughly whether a thing fits. Type a product name; the server looks its
dimensions up on the web and the page draws it to scale over the camera feed.

It is not AR. There's no depth sensing and no tilt correction. You calibrate by
holding a bank card flat against whatever you're measuring and matching a dashed
outline to it — after that the yellow outline is roughly right *at that distance*.
Treat it as a sense of proportion, not a measurement.

## Running it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or: ant auth login
npm start
```

Then open `http://localhost:3000` on the machine itself.

To use it from your phone — which is the whole point — you need HTTPS, because
`getUserMedia` refuses to hand over the camera on a plain-HTTP page that isn't
localhost:

```bash
./make-certs.sh          # writes certs/, prefers mkcert if installed
npm start                # now serves HTTPS
```

Open `https://<your-lan-ip>:3000` on the phone. On iOS a self-signed certificate
often isn't enough — Safari will load the page and still refuse the camera.
`mkcert` is the reliable route: the script prints the root CA path, and you
install and trust that profile on the phone once. A tunnel (`cloudflared tunnel
--url http://localhost:3000`, `ngrok http 3000`) is the other option and needs no
certificate work, at the cost of routing your page through someone else's server.

### Without an API key

```bash
npm run mock
```

Serves canned dimensions so you can see the interface work. No API calls, no key.

### Tests

```bash
npm test
```

Node's built-in runner, mock mode, no network. Covers path traversal, request
limits, the error statuses, and the validator that decides whether a reply is
usable.

## How the lookup works

`POST /api/dimensions` with `{"query": "..."}` returns:

```json
{
  "product": "...",
  "variants": [
    { "name": "Folded", "l_cm": 54, "w_cm": 46.5, "h_cm": 25,
      "confidence": "high", "note": "where these came from" }
  ],
  "weight_kg": 9.5,
  "caveat": "",
  "sources": [{ "title": "...", "url": "https://..." }]
}
```

The server calls the Messages API with the `web_search` server tool and a system
prompt that asks for JSON only. Notable bits of the implementation:

- **Numbers are validated before they reach the page.** Any variant missing a
  dimension, or carrying a non-numeric one, is dropped rather than rendered as a
  `NaN`-wide box. If nothing survives, the request fails loudly with a 422.
- **`pause_turn` is handled.** A server-tool turn stops with
  `stop_reason: "pause_turn"` when the server-side search loop hits its iteration
  cap. The fix is to resend the conversation with the paused assistant turn
  appended and no new user message; up to `MAX_RESUMES` times. Without this you
  get a silently truncated answer and no error.
- **Sources come from the search result blocks**, so the page can show you what
  was actually read. Web-search errors arrive as HTTP 200 with an error *object*
  where success gives an *array*, so the code checks the shape before iterating.
- **Results are cached** for six hours, keyed on the lowercased query.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Or `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile. |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Exact model ID, no date suffix. |
| `PORT` | `3000` | |
| `LOOKUP_TIMEOUT_MS` | `120000` | Abandon a lookup after this long. |
| `SIZE_OVERLAY_MOCK` | unset | `1` serves canned data. |

## What it won't tell you

Retailer listings disagree constantly, usually because a product was revised
between model years, and the prompt tells the model to report the conflict rather
than average it away. A `mixed` or `low` confidence badge means exactly that —
open "Where these numbers came from" and read the sources before you buy
anything on the strength of a yellow rectangle.

If the lookup is wrong or finds nothing, "Enter dimensions by hand" takes three
numbers in centimetres and skips the API entirely.
