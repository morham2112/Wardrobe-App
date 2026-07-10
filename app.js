/* =========================================================================
   OUTFIT LINE — app.js
   Everything below is plain, dependency-free JavaScript so the app keeps
   working offline, on your phone, with no build step.

   FILE MAP OF THIS APP:
   1. CONFIG               — flip MOCK_MODE off + add your Gemini key
   2. STORAGE (IndexedDB)  — the "database" of clothes lives on your phone
   3. GEMINI INTAKE        — one AI call per new photo -> structured tags
   4. COLOR SCIENCE        — hex/name -> HSL, neutral detection, harmony
   5. THE RULE ENGINE       — Rules A, B, C — this is the "brain"
   6. STATE + RENDERING    — keeps the UI in sync with storage + selection
   7. EVENT WIRING         — file intake, tabs, taps, modal
   ========================================================================= */


/* =========================================================================
   1. CONFIG
   ========================================================================= */
const CONFIG = {
  // Set this to false once you've added a real Gemini API key below.
  // In MOCK_MODE the app invents plausible tags so you can test the UI
  // and the filtering engine without spending API calls or being online.
  MOCK_MODE: false,

  GEMINI_API_KEY: "AQ.Ab8RN6IbG-lBymBSWF2BVoPnTR3r5oMRMqcx1Dryt-e8VdwFuA",
  GEMINI_MODEL: "gemini-3.5-flash",

  // Neutral colors pair with everything (Rule A). Add to this list if
  // Gemini (or you) describe a color in a way that isn't caught below.
  NEUTRAL_KEYWORDS: ["black","white","gray","grey","navy","tan","beige","cream","charcoal","khaki","stone","ivory"]
};

// Single source of truth for categories — matches the tabs and the
// Category dropdown in index.html. Keep these in sync if you ever add
// or rename a category.
const CATEGORIES = ["Hat","Shirt","Bottom","Belt","Sock","Shoe"];


/* =========================================================================
   2. STORAGE — a tiny IndexedDB wrapper.
   Each clothing item is stored as:
   { id, filename, name, category, exact_color, tone, formality, imageData, dateAdded }
   imageData is a base64 data-URL, so photos are self-contained — nothing
   ever leaves your phone unless you turn MOCK_MODE off to call Gemini.
   ========================================================================= */
const DB_NAME = "outfit-line";
const STORE = "clothes";
let dbPromise = null;

function openDB(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)){
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbGetAll(){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(item){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}


/* =========================================================================
   3. GEMINI INTAKE
   This runs ONCE per new photo. It sends the image + a schema prompt to
   Gemini and expects strict JSON back. Swap MOCK_MODE off and fill in
   CONFIG.GEMINI_API_KEY to make it live.

   ⚠️ Security note: calling Gemini directly from a client-side app means
   your API key ships inside app.js. That's fine for a private tool only
   you install on your own phone, but do NOT publish this app publicly
   with a real key embedded — route it through a small server/proxy first
   if you ever share it.
   ========================================================================= */
async function analyzeClothingImage(file, dataUrl){
  if (CONFIG.MOCK_MODE){
    return mockAnalyze(file.name);
  }

  const base64 = dataUrl.split(",")[1];
  const prompt = `You are tagging a single clothing item photo for a wardrobe app.
Return ONLY raw JSON, no markdown fences, matching exactly this shape:
{"name": string, "category": "Hat"|"Shirt"|"Bottom"|"Belt"|"Sock"|"Shoe", "exact_color": string (a CSS hex code like "#1B3A6B"), "tone": "Light"|"Dark"|"Neutral", "formality": "Casual"|"Sport"|"Dressy"}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: file.type || "image/jpeg", data: base64 } }
      ]
    }]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": CONFIG.GEMINI_API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!res.ok){
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini request failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();

  try{
    return JSON.parse(clean);
  }catch(e){
    console.error("Could not parse Gemini response, falling back to mock:", raw);
    return mockAnalyze(file.name);
  }
}

// Deterministic "fake AI" so the same filename always gets the same mock
// tags — handy for testing the rule engine before you wire up a real key.
function mockAnalyze(filename){
  const colors = [
    { name: "Navy",        hex: "#1B3A6B", tone: "Neutral" },
    { name: "Charcoal",    hex: "#333333", tone: "Neutral" },
    { name: "White",       hex: "#F2F2F2", tone: "Neutral" },
    { name: "Tan",         hex: "#C8A96B", tone: "Neutral" },
    { name: "Olive Green", hex: "#5B6B3E", tone: "Dark" },
    { name: "Burnt Orange",hex: "#C1592B", tone: "Dark" },
    { name: "Sky Blue",    hex: "#7EC1E8", tone: "Light" },
    { name: "Burgundy",    hex: "#6E1F2A", tone: "Dark" }
  ];
  const formalities = ["Casual","Sport","Dressy"];

  const hash = [...filename].reduce((a,c)=>a + c.charCodeAt(0), 0);
  const cat = CATEGORIES[hash % CATEGORIES.length];
  const color = colors[hash % colors.length];
  const formality = formalities[(hash >> 2) % formalities.length];

  return {
    name: filename.replace(/\.[^.]+$/, "").replace(/[_-]/g," "),
    category: cat,
    exact_color: color.hex,
    tone: color.tone,
    formality
  };
}


/* =========================================================================
   4. COLOR SCIENCE
   Converts any CSS-parseable color (hex or name) to HSL using a 1x1
   canvas as the "parser", then implements neutral detection + the
   color-wheel harmony test used by Rule A.
   ========================================================================= */
const _swatchCanvas = document.createElement("canvas");
_swatchCanvas.width = 1; _swatchCanvas.height = 1;
const _swatchCtx = _swatchCanvas.getContext("2d", { willReadFrequently: true });

function colorToRGB(colorStr){
  _swatchCtx.clearRect(0,0,1,1);
  _swatchCtx.fillStyle = "#808080"; // neutral fallback if parsing fails
  try{ _swatchCtx.fillStyle = colorStr; }catch(e){ /* keep fallback */ }
  _swatchCtx.fillRect(0,0,1,1);
  const [r,g,b] = _swatchCtx.getImageData(0,0,1,1).data;
  return { r, g, b };
}

function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s, l = (max+min)/2;
  if (max === min){ h = 0; s = 0; }
  else{
    const d = max-min;
    s = l > 0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h = (g-b)/d + (g<b?6:0); break;
      case g: h = (b-r)/d + 2; break;
      default: h = (r-g)/d + 4;
    }
    h *= 60;
  }
  return { h, s: s*100, l: l*100 };
}

const _hslCache = new Map();
function getHSL(colorStr){
  if (!colorStr) return { h:0, s:0, l:50 };
  if (_hslCache.has(colorStr)) return _hslCache.get(colorStr);
  const { r,g,b } = colorToRGB(colorStr);
  const hsl = rgbToHsl(r,g,b);
  _hslCache.set(colorStr, hsl);
  return hsl;
}

function hueDistance(h1, h2){
  const d = Math.abs(h1 - h2);
  return Math.min(d, 360 - d);
}

function isNeutralItem(item){
  if (item.tone === "Neutral") return true;
  const haystack = `${item.exact_color} ${item.name}`.toLowerCase();
  if (CONFIG.NEUTRAL_KEYWORDS.some(k => haystack.includes(k))) return true;
  const { s, l } = getHSL(item.exact_color);
  if (s < 12) return true;        // near-grayscale
  if (l > 92 || l < 8) return true; // near-white / near-black
  return false;
}

// RULE A — color-wheel harmony. Neutrals pair with anything; otherwise
// require a recognized relationship (monochromatic / analogous / complementary).
function colorHarmony(a, b){
  if (isNeutralItem(a) || isNeutralItem(b)) return { ok: true, type: "neutral" };
  const hA = getHSL(a.exact_color).h;
  const hB = getHSL(b.exact_color).h;
  const d = hueDistance(hA, hB);

  if (d <= 15)  return { ok: true, type: "monochromatic" };
  if (d <= 50)  return { ok: true, type: "analogous" };
  if (d >= 150 && d <= 210) return { ok: true, type: "complementary" };
  return { ok: false, type: "clash" };
}

// RULE C — formality matching. "Casual" acts as the flexible middle
// ground; Sport and Dressy only pair with each other through it.
function formalityCompatible(a, b){
  if (a.formality === b.formality) return true;
  if (a.formality === "Casual" || b.formality === "Casual") return true;
  return false;
}


/* =========================================================================
   5. THE RULE ENGINE
   Heuristics for shorts / socks / belts read the item's NAME (e.g. name
   your photo "White No-Show Socks.jpg" or "Brown Leather Belt.jpg") since
   the Gemini schema doesn't include a sub-type field. Rename items in the
   review modal any time to steer these checks.
   ========================================================================= */
const isShort      = item => /short/i.test(item.name);
const isNoShowSock = item => /(no.?show|ankle|low|invisible|hidden)/i.test(item.name);
const isHighSock   = item => /(crew|high|knee|tall|calf)/i.test(item.name);

// RULE B — height elongation. Checks the candidate item against whatever
// is currently selected (bottoms + shirt) to protect an unbroken vertical line.
function heightElongation(selection, candidate){
  const reasons = [];
  let ok = true;

  // Bottom -> Shoe: keep contrast low so the leg line isn't cut.
  if (candidate.category === "Shoe" && selection.Bottom){
    const bottom = selection.Bottom;
    const sameTone = bottom.tone === candidate.tone;
    const lDiff = Math.abs(getHSL(bottom.exact_color).l - getHSL(candidate.exact_color).l);
    const lowContrast = sameTone || lDiff <= 25 || isNeutralItem(bottom) || isNeutralItem(candidate);
    if (!lowContrast){
      ok = false;
      reasons.push("High contrast with bottoms breaks the leg line");
    }
  }

  // Shorts -> socks: no-show/skin-tone only, high socks chop the leg.
  if (candidate.category === "Sock" && selection.Bottom && isShort(selection.Bottom)){
    if (isHighSock(candidate)){
      ok = false;
      reasons.push("High socks chop the leg line with shorts — try no-show");
    }
  }

  // Belts: must match bottoms/shirt color, unless the shirt is casual/sport
  // (and therefore likely worn untucked, so the belt is hidden anyway).
  if (candidate.category === "Belt"){
    const refs = [selection.Bottom, selection.Shirt].filter(Boolean);
    if (refs.length){
      const likelyUntucked = selection.Shirt && ["Casual","Sport"].includes(selection.Shirt.formality);
      if (!likelyUntucked){
        const matchesSomething = refs.some(ref =>
          isNeutralItem(ref) || isNeutralItem(candidate) ||
          hueDistance(getHSL(ref.exact_color).h, getHSL(candidate.exact_color).h) <= 20
        );
        if (!matchesSomething){
          ok = false;
          reasons.push("Belt should match shirt or bottoms, or shirt should be untucked");
        }
      }
    }
  }

  return { ok, reasons };
}

// Master check: is `candidate` compatible with everything currently selected?
// Only compares against OTHER categories (an item never locks its own category).
// Every category is single-select now, so this is just "every selected item
// in a different category" — no more special-casing a multi-select bucket.
function evaluateCandidate(selection, candidate){
  const refs = Object.entries(selection)
    .filter(([cat, item]) => item && cat !== candidate.category)
    .map(([, item]) => item);

  if (refs.length === 0) return { locked: false, reasons: [], badges: [] };

  let locked = false;
  const reasons = [];

  for (const ref of refs){
    const color = colorHarmony(ref, candidate);
    if (!color.ok){ locked = true; reasons.push(`Clashes with ${ref.name}`); }

    if (!formalityCompatible(ref, candidate)){
      locked = true;
      reasons.push(`${candidate.formality} doesn't match ${ref.name}'s ${ref.formality} formality`);
    }
  }

  const height = heightElongation(selection, candidate);
  if (!height.ok){ locked = true; reasons.push(...height.reasons); }

  // Cosmetic badges (never gate selection, just highlight great picks)
  const badges = [];
  if (!locked){
    if (candidate.category === "Shoe" && selection.Bottom){
      const sameTone = selection.Bottom.tone === candidate.tone;
      if (sameTone) badges.push("elongate");
    }
    const allDarkNeutral = refs.length > 0 && refs.every(r => r.tone === "Dark" || isNeutralItem(r)) &&
                            (candidate.tone === "Dark" || isNeutralItem(candidate));
    if (allDarkNeutral) badges.push("mono");
  }

  return { locked, reasons, badges };
}


/* =========================================================================
   6. STATE + RENDERING
   ========================================================================= */
function emptySelection(){
  const sel = {};
  CATEGORIES.forEach(cat => { sel[cat] = null; });
  return sel;
}

const state = {
  items: [],
  loaded: false,
  activeTab: "All",
  selection: emptySelection()
};

const el = {
  grid: document.getElementById("grid"),
  emptyState: document.getElementById("emptyState"),
  statusLine: document.getElementById("statusLine"),
  tabs: document.getElementById("tabs"),
  outfitStrip: document.getElementById("outfitStrip"),
  outfitStripItems: document.getElementById("outfitStripItems"),
  clearOutfitBtn: document.getElementById("clearOutfitBtn"),
  fileInput: document.getElementById("fileInput"),
  addPhotosBtn: document.getElementById("addPhotosBtn"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  modalTitle: document.getElementById("modalTitle"),
  modalImg: document.getElementById("modalImg"),
  fieldName: document.getElementById("fieldName"),
  fieldCategory: document.getElementById("fieldCategory"),
  fieldColor: document.getElementById("fieldColor"),
  fieldTone: document.getElementById("fieldTone"),
  fieldFormality: document.getElementById("fieldFormality"),
  modalSave: document.getElementById("modalSave"),
  modalCancel: document.getElementById("modalCancel"),
  modalDelete: document.getElementById("modalDelete")
};

function selectedList(){
  return Object.values(state.selection).filter(Boolean);
}

function isSelected(item){
  return state.selection[item.category]?.id === item.id;
}

function toggleSelect(item){
  const current = state.selection[item.category];
  state.selection[item.category] = (current && current.id === item.id) ? null : item;
  renderGrid();
  renderOutfitStrip();
}

function render(){
  renderGrid();
  renderOutfitStrip();
  updateStatusLine();
}

function updateStatusLine(){
  const count = state.items.length;
  if (!state.loaded){
    el.statusLine.textContent = "Loading your closet…";
    return;
  }
  el.statusLine.textContent = count === 0
    ? "Your closet is empty — tap + Add to get started"
    : `${count} item${count === 1 ? "" : "s"} in your closet — tap anything to build an outfit`;
}

function renderGrid(){
  const items = state.activeTab === "All"
    ? state.items
    : state.items.filter(i => i.category === state.activeTab);

  el.grid.innerHTML = "";
  el.emptyState.hidden = state.items.length > 0;

  const selection = state.selection;

  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "item";
    card.dataset.id = item.id;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    let locked = false, badges = [];
    if (selectedList().length > 0 && !isSelected(item)){
      const result = evaluateCandidate(selection, item);
      locked = result.locked;
      badges = result.badges;
    }

    if (isSelected(item)) card.classList.add("selected");
    if (locked) card.classList.add("locked");
    if (badges.length) card.classList.add("recommended");

    card.innerHTML = `
      <button type="button" class="item-edit-btn" title="Edit ${escapeHtml(item.name)}">✎</button>
      <div class="item-photo-wrap">
        <img src="${item.imageData}" alt="${escapeHtml(item.name)}">
        ${badges.includes("elongate") ? '<span class="badge elongate">Elongates</span>' : ""}
        ${badges.includes("mono") ? '<span class="badge mono">Monochrome</span>' : ""}
      </div>
      <div class="item-name">${escapeHtml(item.name)}</div>
      <div class="item-meta">${item.formality} · ${item.tone}</div>
    `;

    card.querySelector(".item-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openEditModal(item);
    });
    card.addEventListener("click", () => toggleSelect(item));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " "){ e.preventDefault(); toggleSelect(item); }
    });
    el.grid.appendChild(card);
  });
}

function renderOutfitStrip(){
  const list = selectedList();
  el.outfitStrip.hidden = list.length === 0;
  el.outfitStripItems.innerHTML = list.map(item => `
    <span class="outfit-chip">
      <img src="${item.imageData}" alt="">
      ${escapeHtml(item.name)}
    </span>
  `).join("");
}

function escapeHtml(str){
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}


/* =========================================================================
   7. EVENT WIRING
   ========================================================================= */

// --- Tabs ---
el.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  el.tabs.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  state.activeTab = btn.dataset.cat;
  renderGrid();
});

// --- Clear outfit ---
el.clearOutfitBtn.addEventListener("click", () => {
  state.selection = emptySelection();
  render();
});

// --- Add photos (the "read the folder" intake) ---
el.addPhotosBtn.addEventListener("click", () => el.fileInput.click());

el.fileInput.addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = ""; // allow re-picking the same file later
  if (!files.length) return;

  const existingNames = new Set(state.items.map(i => i.filename));
  const newFiles = files.filter(f => !existingNames.has(f.name)); // dedupe: already in the closet

  if (!newFiles.length){
    el.statusLine.textContent = "Those photos are already in your closet";
    setTimeout(updateStatusLine, 1800);
    return;
  }

  reviewQueue.push(...newFiles);
  processNextInQueue();
});

const reviewQueue = [];

async function processNextInQueue(){
  if (el.modalBackdrop.hidden === false) return; // a review is already open
  const file = reviewQueue.shift();
  if (!file) { updateStatusLine(); return; }

  el.statusLine.textContent = `Analyzing ${file.name}…`;
  const dataUrl = await fileToDataUrl(file);

  let tags;
  try{
    tags = await analyzeClothingImage(file, dataUrl);
    if (!tags || typeof tags !== "object"){
      throw new Error("AI response was not a usable object");
    }
  }catch(err){
    console.error("Tagging failed for", file.name, err);
    el.statusLine.textContent = `Couldn't fully analyze ${file.name} — check details before saving`;
    tags = {}; // openReviewModal below still fills in safe fallbacks per-field
  }

  openReviewModal(file, dataUrl, tags);
}

function fileToDataUrl(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- Review modal ---
let pendingItem = null;   // set while reviewing a brand-new photo
let editingItemId = null; // set while editing an already-saved item

function openReviewModal(file, dataUrl, tags){
  editingItemId = null;
  pendingItem = {
    id: `${file.name}-${Date.now()}`,
    filename: file.name,
    imageData: dataUrl,
    dateAdded: Date.now()
  };

  if (el.modalTitle) el.modalTitle.textContent = "Confirm item details";
  el.modalSave.textContent = "Save to closet";
  el.modalCancel.textContent = "Skip";
  if (el.modalDelete) el.modalDelete.hidden = true;

  el.modalImg.src = dataUrl;
  el.fieldName.value = tags.name || file.name;
  el.fieldCategory.value = tags.category || "Shirt";
  el.fieldColor.value = tags.exact_color || "#888888";
  el.fieldTone.value = tags.tone || "Neutral";
  el.fieldFormality.value = tags.formality || "Casual";
  el.modalBackdrop.hidden = false;
}

function openEditModal(item){
  pendingItem = null;
  editingItemId = item.id;

  if (el.modalTitle) el.modalTitle.textContent = "Edit item";
  el.modalSave.textContent = "Save changes";
  el.modalCancel.textContent = "Cancel";
  if (el.modalDelete) el.modalDelete.hidden = false;

  el.modalImg.src = item.imageData;
  el.fieldName.value = item.name;
  el.fieldCategory.value = item.category;
  el.fieldColor.value = item.exact_color;
  el.fieldTone.value = item.tone;
  el.fieldFormality.value = item.formality;
  el.modalBackdrop.hidden = false;
}

function closeReviewModal(){
  el.modalBackdrop.hidden = true;
  pendingItem = null;
  editingItemId = null;
  processNextInQueue();
}

el.modalCancel.addEventListener("click", closeReviewModal);

if (el.modalDelete){
  el.modalDelete.addEventListener("click", async () => {
    if (!editingItemId) return;
    if (!confirm("Remove this item from your closet?")) return;
    await dbDelete(editingItemId);
    state.items = state.items.filter(i => i.id !== editingItemId);
    for (const cat of CATEGORIES){
      if (state.selection[cat]?.id === editingItemId) state.selection[cat] = null;
    }
    closeReviewModal();
    render();
  });
}

el.modalSave.addEventListener("click", async () => {
  if (!pendingItem && !editingItemId) return;

  const fields = {
    name: el.fieldName.value.trim() || (pendingItem?.filename ?? "Untitled item"),
    category: el.fieldCategory.value,
    exact_color: el.fieldColor.value.trim() || "#888888",
    tone: el.fieldTone.value,
    formality: el.fieldFormality.value
  };

  if (editingItemId){
    const existing = state.items.find(i => i.id === editingItemId);
    const updated = { ...existing, ...fields };
    await dbPut(updated);
    state.items = state.items.map(i => i.id === editingItemId ? updated : i);
    // keep the outfit strip in sync if this item is currently selected
    for (const cat of CATEGORIES){
      if (state.selection[cat]?.id === editingItemId) state.selection[cat] = updated;
    }
  } else {
    const item = { ...pendingItem, ...fields };
    await dbPut(item);
    state.items.push(item);
  }

  closeReviewModal();
  render();
});


/* =========================================================================
   PWA — service worker registration
   Wrapped in a feature check + try/catch so the app still runs fine in
   any browser or context (e.g. file://) that doesn't support it.
   ========================================================================= */
if ("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  });
}


/* =========================================================================
   INIT
   ========================================================================= */
(async function init(){
  state.items = await dbGetAll();
  state.loaded = true;
  render();
})();

