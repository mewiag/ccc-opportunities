// Size overlay — draw a looked-up product to scale over the camera feed.
// No build step; this file is served as-is.

const CARD_W = 8.56; // ISO/IEC 7810 ID-1
const CARD_H = 5.4;
const STORE_SCALE = "size-overlay:pxpercm";
const STORE_LAST = "size-overlay:last";

const $ = (id) => document.getElementById(id);
const box = $("box");
const card = $("card");
const statusEl = $("status");
const variantRow = $("variantRow");
const faceRow = $("faceRow");
const scale = $("scale");
const detail = $("detail");
const detailBody = $("detailBody");

let product = null;   // {product, variants, weight_kg, caveat, sources}
let variantIx = 0;
let faceIx = 0;
let pxPerCm = 5;
let busy = false;

/* ---------- storage (fails closed: private mode, blocked site data) ---------- */

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not worth telling the user about */
  }
}

/* ---------- geometry ---------- */

function faces(v) {
  return [
    { name: "Side", w: v.l_cm, h: v.h_cm },
    { name: "End", w: v.w_cm, h: v.h_cm },
    { name: "Top", w: v.l_cm, h: v.w_cm }
  ];
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function render() {
  card.style.width = CARD_W * pxPerCm + "px";
  card.style.height = CARD_H * pxPerCm + "px";

  if (!product) {
    box.hidden = true;
    return;
  }

  const v = product.variants[variantIx];
  const f = faces(v)[faceIx];
  box.hidden = false;
  box.style.width = f.w * pxPerCm + "px";
  box.style.height = f.h * pxPerCm + "px";
  box.dataset.label = `${round(f.w)} × ${round(f.h)} cm`;
}

/** Centre in the strip of camera that is actually visible — the search bar and
 *  the control panel are opaque, and the panel gets tall when its details open. */
function centre(el, offsetY) {
  const r = el.getBoundingClientRect();
  const top = $("search").getBoundingClientRect().bottom;
  const bottom = Math.max($("panel").getBoundingClientRect().top, top + 80);
  el.style.left = Math.max(8, (window.innerWidth - r.width) / 2) + "px";
  el.style.top = Math.max(top + 8, (top + bottom - r.height) / 2 + (offsetY || 0)) + "px";
}

function draggable(el) {
  let sx = 0, sy = 0, ox = 0, oy = 0, on = false;

  el.addEventListener("pointerdown", (e) => {
    on = true;
    el.setPointerCapture(e.pointerId);
    sx = e.clientX;
    sy = e.clientY;
    ox = parseFloat(el.style.left) || 0;
    oy = parseFloat(el.style.top) || 0;
    el.style.cursor = "grabbing";
  });

  el.addEventListener("pointermove", (e) => {
    if (!on) return;
    el.style.left = ox + e.clientX - sx + "px";
    el.style.top = oy + e.clientY - sy + "px";
  });

  const end = () => {
    on = false;
    el.style.cursor = "grab";
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

/* ---------- controls ---------- */

function buttonRow(row, items, activeIx, onPick) {
  row.textContent = "";
  if (items.length < 2 && row === variantRow) return; // one variant needs no switch
  items.forEach((item, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = item;
    b.setAttribute("aria-pressed", i === activeIx ? "true" : "false");
    b.addEventListener("click", () => onPick(i));
    row.appendChild(b);
  });
}

function buildControls() {
  if (!product) {
    variantRow.textContent = "";
    faceRow.textContent = "";
    return;
  }
  buttonRow(variantRow, product.variants.map((v) => v.name), variantIx, (i) => {
    variantIx = i;
    faceIx = 0;
    buildControls();
    render();
  });
  buttonRow(faceRow, faces(product.variants[variantIx]).map((f) => f.name), faceIx, (i) => {
    faceIx = i;
    buildControls();
    render();
  });
}

/* ---------- provenance ---------- */

function buildDetail() {
  detailBody.textContent = "";
  if (!product) {
    detail.hidden = true;
    return;
  }
  detail.hidden = false;

  for (const v of product.variants) {
    const p = document.createElement("p");
    const label = document.createElement("strong");
    label.textContent = `${v.name}: ${round(v.l_cm)} × ${round(v.w_cm)} × ${round(v.h_cm)} cm `;
    const conf = document.createElement("span");
    conf.className = "conf-" + v.confidence;
    conf.textContent = `(${v.confidence} confidence)`;
    p.append(label, conf);
    if (v.note) p.append(document.createElement("br"), document.createTextNode(v.note));
    detailBody.appendChild(p);
  }

  if (product.weight_kg) {
    const p = document.createElement("p");
    p.textContent = `Weight: about ${product.weight_kg} kg.`;
    detailBody.appendChild(p);
  }

  if (product.caveat) {
    const p = document.createElement("p");
    p.textContent = product.caveat;
    detailBody.appendChild(p);
  }

  if (product.sources && product.sources.length) {
    const p = document.createElement("p");
    p.textContent = "Sources searched:";
    const ul = document.createElement("ul");
    for (const s of product.sources) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = s.title;
      li.appendChild(a);
      ul.appendChild(li);
    }
    detailBody.append(p, ul);
  } else {
    const p = document.createElement("p");
    p.textContent = "No sources were returned — treat these numbers as unverified.";
    detailBody.appendChild(p);
  }
}

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", Boolean(isError));
}

function adopt(data, note) {
  product = data;
  variantIx = 0;
  faceIx = 0;
  buildControls();
  buildDetail();
  render();
  centre(box, -20);
  const first = data.variants[0];
  setStatus(note || `${data.product} — ${first.confidence} confidence. Open the details below before trusting it.`);
}

/* ---------- lookup ---------- */

async function lookup(query) {
  if (busy) return;
  busy = true;
  $("go").disabled = true;
  setStatus(`Searching for “${query}”… this takes a few seconds.`);

  try {
    const res = await fetch("/api/dimensions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    adopt(data, data.cached ? `${data.product} — from cache.` : undefined);
    save(STORE_LAST, JSON.stringify(data));
  } catch (e) {
    setStatus(e.message || String(e), true);
  } finally {
    busy = false;
    $("go").disabled = false;
  }
}

/* ---------- wiring ---------- */

const savedScale = parseFloat(load(STORE_SCALE));
if (Number.isFinite(savedScale) && savedScale > 0) pxPerCm = savedScale;
scale.value = pxPerCm;

scale.addEventListener("input", function () {
  pxPerCm = parseFloat(this.value);
  render();
  save(STORE_SCALE, String(pxPerCm));
});

$("calib").addEventListener("click", function () {
  const on = document.body.classList.toggle("calibrating");
  this.setAttribute("aria-pressed", on ? "true" : "false");
  if (on) centre(card, -60);
});

$("lookupForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("query").value.trim();
  if (q) lookup(q);
});

$("manualForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const nums = ["mL", "mW", "mH"].map((id) => Number($(id).value));
  if (nums.some((n) => !Number.isFinite(n) || n <= 0)) {
    setStatus("Three positive numbers, please.", true);
    return;
  }
  adopt(
    {
      product: "Entered by hand",
      variants: [
        {
          name: "Manual",
          l_cm: nums[0],
          w_cm: nums[1],
          h_cm: nums[2],
          confidence: "high",
          note: "You typed these in."
        }
      ],
      weight_kg: null,
      caveat: "",
      sources: []
    },
    `${round(nums[0])} × ${round(nums[1])} × ${round(nums[2])} cm, as entered.`
  );
});

// Restore the last lookup so reopening the page isn't a blank screen.
try {
  const last = JSON.parse(load(STORE_LAST) || "null");
  if (last && Array.isArray(last.variants) && last.variants.length) {
    adopt(last, `${last.product} — from your last lookup.`);
  }
} catch {
  /* stored JSON was junk; start empty */
}

buildControls();
render();
centre(card, -60);
if (!product) centre(box, -20);
draggable(box);
draggable(card);

/* ---------- camera ---------- */

const video = $("cam");
if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
    .then((stream) => {
      video.srcObject = stream;
    })
    .catch(() => {
      $("camFail").hidden = false;
      video.hidden = true;
    });
} else {
  $("camFail").hidden = false;
  video.hidden = true;
}
