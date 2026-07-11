/* =========================================================================
   OUTFIT LINE — app.js
   Everything below is plain, dependency-free JavaScript so the app keeps
   working offline, on your phone, with no build step.

   FILE MAP OF THIS APP:
   1. CONFIG               — flip MOCK_MODE off + add your Claude key
   2. STORAGE (IndexedDB)  — the "database" of clothes lives on your phone
   3. CLAUDE INTAKE        — one AI call per new photo -> structured tags
   4. AI OUTFIT SUGGESTIONS — on-demand: research + compose real outfits
   5. STATE + RENDERING    — keeps the UI in sync with storage + selection
   6. EVENT WIRING         — file intake, tabs, taps, modal, suggestions
   ========================================================================= */


/* =========================================================================
   1. CONFIG
   ========================================================================= */
const CONFIG = {
  // Set this to false once you've added a real Claude API key below.
  // In MOCK_MODE the app invents plausible tags/outfits so you can test
  // the UI without spending API calls or being online.
  MOCK_MODE: true,

  CLAUDE_API_KEY: "YOUR_CLAUDE_API_KEY_HERE",

  // Cheap/fast model for simple per-photo tagging.
  CLAUDE_MODEL: "claude-haiku-4-5-20251001",

  // Stronger model for actual outfit-composition reasoning — this is a
  // harder judgment call than tagging a single photo, so it's worth the
  // extra cost (still cheap in absolute terms since it only runs when you
  // tap "Suggest Outfits", not on every tap).
  SUGGEST_MODEL: "claude-sonnet-5"
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
   ever leaves your phone unless you turn MOCK_MODE off to call Claude.
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
   3. CLAUDE INTAKE
   This runs ONCE per new photo. It sends the image to Claude and forces a
   structured tool call back, so every field (name, category, color, tone,
   formality) is guaranteed present — Claude can't skip one the way it
   could when just asked to write JSON as text.

   ⚠️ Security note: calling the API directly from a client-side app means
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
  const prompt = `Look closely at this clothing item photo and tag it for a wardrobe app.
Give it a short, descriptive name that combines its color and what it is
(e.g. "Navy Golf Shorts", "White No-Show Socks", "Brown Leather Belt"). Be
specific about cut/style whenever it's visible (e.g. "shorts" vs "pants",
"crew socks" vs "no-show socks") since that wording drives some of the
app's styling rules. Use the tag_clothing_item tool to record your answer.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CONFIG.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: CONFIG.CLAUDE_MODEL,
      max_tokens: 300,
      tools: [{
        name: "tag_clothing_item",
        description: "Record structured tags for a single clothing item photo.",
        input_schema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short descriptive name combining color and item type." },
            category: { type: "string", enum: CATEGORIES },
            exact_color: { type: "string", description: "A CSS hex code like #1B3A6B." },
            tone: { type: "string", enum: ["Light","Dark","Neutral"] },
            formality: { type: "string", enum: ["Casual","Sport","Dressy"] }
          },
          required: ["name","category","exact_color","tone","formality"]
        }
      }],
      tool_choice: { type: "tool", name: "tag_clothing_item" },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: base64 } },
          { type: "text", text: prompt }
        ]
      }]
    })
  });

  if (!res.ok){
    const errText = await res.text().catch(() => "");
    throw new Error(`Claude request failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const toolCall = data.content?.find(block => block.type === "tool_use");
  if (!toolCall){
    throw new Error("Claude didn't return a tool call — check the response shape.");
  }
  return toolCall.input; // already a clean, schema-matching object — no JSON parsing needed
}

// Deterministic "fake AI" so the same filename always gets the same mock
// tags — handy for testing the app before you wire up a real key.
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
   4. AI OUTFIT SUGGESTIONS
   Runs only when you tap "Suggest Outfits" — not on every tap, since this
   is a heavier, slower, costlier call than tagging a single photo.

   Two Claude calls, on purpose:
   1. RESEARCH — Claude uses the web_search tool to pull in a bit of
      current men's style context relevant to what you're building around.
   2. COMPOSE — a second call, forced into a structured tool response,
      turns that research + your actual closet inventory into 3-4 real
      outfits built ONLY from items you own (referenced by id).
   Splitting these two steps is what lets Claude both browse the web AND
   guarantee a clean, parseable answer — forcing structured output on the
   first call would prevent it from searching at all.
   ========================================================================= */
async function suggestOutfits(anchorItems, occasion){
  if (CONFIG.MOCK_MODE){
    return mockSuggestOutfits(anchorItems);
  }

  const inventory = state.items.map(i => ({
    id: i.id, name: i.name, category: i.category,
    exact_color: i.exact_color, tone: i.tone, formality: i.formality
  }));

  const anchorDesc = anchorItems.length
    ? anchorItems.map(i => `${i.name} (${i.category}, ${i.exact_color})`).join(", ")
    : null;

  const occasionDesc = occasion ? occasion.hint : null;

  // --- Call 1: research ---
  const researchPrompt = [
    occasionDesc ? `I want to put together ${occasionDesc}.` : "I want a few complete men's outfit ideas for today.",
    anchorDesc ? `It should be built around: ${anchorDesc}.` : "",
    "Briefly research current men's styling conventions relevant to this — 2-3 sentences, this is just context for a follow-up step, not a final answer."
  ].filter(Boolean).join(" ");

  const researchRes = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: claudeHeaders(),
    body: JSON.stringify({
      model: CONFIG.SUGGEST_MODEL,
      max_tokens: 500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: researchPrompt }]
    })
  });
  if (!researchRes.ok){
    const errText = await researchRes.text().catch(() => "");
    throw new Error(`Research call failed: ${researchRes.status} ${errText}`);
  }
  const researchData = await researchRes.json();
  const trendSummary = (researchData.content || [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join(" ")
    .trim() || "No specific trend research available.";

  // --- Call 2: compose, forced structured output ---
  const composePrompt = `Current style context: ${trendSummary}

My full closet inventory (JSON): ${JSON.stringify(inventory)}

${occasionDesc ? `The goal is specifically ${occasionDesc}. Every outfit should fit that occasion.` : ""}
${anchorDesc ? `Build every outfit around these specific items (match by id): ${anchorItems.map(i => i.id).join(", ")}.` : ""}
Using ONLY items from the inventory above — never invent an item, only reference the exact ids provided — propose 3 to 4 complete outfits. Pick at most one item per category per outfit. Hat, Belt, and Sock are optional — include them where they genuinely add to the look, not in every single outfit by default, but don't systematically avoid them either (a hat or shorts shouldn't be treated as a last resort). Make the 3-4 outfits genuinely different from each other, not near-duplicates with one item swapped — vary bottom style (shorts vs. pants, where both exist), formality within the occasion, and use of optional categories across the set. I'm a shorter man who is colorblind, so prioritize outfits with a clean, unbroken vertical line (monochromatic or low-contrast pairings work best) and safe, unambiguous color combinations. Give each outfit a one-sentence rationale. Use the propose_outfits tool to answer.`;

  const composeRes = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: claudeHeaders(),
    body: JSON.stringify({
      model: CONFIG.SUGGEST_MODEL,
      max_tokens: 1000,
      tools: [{
        name: "propose_outfits",
        description: "Record 3-4 complete outfit suggestions built from the given closet inventory.",
        input_schema: {
          type: "object",
          properties: {
            outfits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  item_ids: { type: "array", items: { type: "string" }, description: "Inventory ids making up this outfit." },
                  rationale: { type: "string" }
                },
                required: ["item_ids", "rationale"]
              }
            }
          },
          required: ["outfits"]
        }
      }],
      tool_choice: { type: "tool", name: "propose_outfits" },
      messages: [{ role: "user", content: composePrompt }]
    })
  });
  if (!composeRes.ok){
    const errText = await composeRes.text().catch(() => "");
    throw new Error(`Compose call failed: ${composeRes.status} ${errText}`);
  }
  const composeData = await composeRes.json();
  const toolCall = composeData.content?.find(block => block.type === "tool_use");
  if (!toolCall){
    throw new Error("Claude didn't return outfit suggestions — check the response shape.");
  }

  // Map ids back to real item objects, dropping anything hallucinated.
  const byId = new Map(state.items.map(i => [i.id, i]));
  return toolCall.input.outfits
    .map(o => ({
      rationale: o.rationale,
      items: o.item_ids.map(id => byId.get(id)).filter(Boolean)
    }))
    .filter(o => o.items.length > 0);
}

// Quick one-tap occasion presets. Each just biases the research + compose
// prompts above toward a specific kind of look — same underlying flow.
const OCCASION_PRESETS = [
  { id: "golf-shorts", label: "⛳ Golf (Shorts)", hint: "a golf outfit using golf shorts (not pants) as the bottom, with appropriate golf-style top, shoes, and accessories" },
  { id: "golf-pants",  label: "⛳ Golf (Pants)",  hint: "a golf outfit using golf pants (not shorts) as the bottom, with appropriate golf-style top, shoes, and accessories" },
  { id: "business",    label: "💼 Business Casual", hint: "a business casual outfit suitable for an office that isn't full formal" },
  { id: "casual",      label: "👕 Casual",         hint: "a relaxed, everyday casual outfit — shorts are completely fair game as the bottom if the vibe fits, and a hat is welcome too, not just reserved for golf" },
  { id: "dinner",      label: "🍽️ Nice Dinner",   hint: "a polished outfit appropriate for a nice dinner out, dressier than casual but not black-tie" }
];

function claudeHeaders(){
  return {
    "content-type": "application/json",
    "x-api-key": CONFIG.CLAUDE_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };
}

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

// Mock version so the suggestion UI is testable without an API key —
// just randomly assembles a few outfits from whatever's in the closet.
function mockSuggestOutfits(anchorItems, occasion){
  const byCategory = {};
  CATEGORIES.forEach(cat => { byCategory[cat] = state.items.filter(i => i.category === cat); });
  const anchorCats = new Set(anchorItems.map(i => i.category));

  const outfits = [];
  for (let n = 0; n < 3; n++){
    const items = [...anchorItems];
    CATEGORIES.forEach(cat => {
      if (anchorCats.has(cat)) return;
      const pool = byCategory[cat];
      if (pool.length) items.push(pool[(n + cat.length) % pool.length]);
    });
    if (items.length){
      outfits.push({ items, rationale: "(Mock suggestion — turn off MOCK_MODE for real AI-composed outfits.)" });
    }
  }
  return outfits;
}


/* =========================================================================
   5. STATE + RENDERING
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
  suggestBtn: document.getElementById("suggestOutfitsBtn"),
  occasionBar: document.getElementById("occasionBar"),
  suggestBackdrop: document.getElementById("suggestBackdrop"),
  suggestList: document.getElementById("suggestList"),
  suggestStatus: document.getElementById("suggestStatus"),
  suggestClose: document.getElementById("suggestClose"),
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
    : `${count} item${count === 1 ? "" : "s"} in your closet`;
}

function renderGrid(){
  const items = state.activeTab === "All"
    ? state.items
    : state.items.filter(i => i.category === state.activeTab);

  el.grid.innerHTML = "";
  el.emptyState.hidden = state.items.length > 0;

  items.forEach(item => {
    const card = document.createElement("div");
    card.className = "item";
    card.dataset.id = item.id;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");

    if (isSelected(item)) card.classList.add("selected");

    card.innerHTML = `
      <button type="button" class="item-edit-btn" title="Edit ${escapeHtml(item.name)}">✎</button>
      <div class="item-photo-wrap">
        <img src="${item.imageData}" alt="${escapeHtml(item.name)}">
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
   6. EVENT WIRING
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

function renderOccasionBar(){
  el.occasionBar.innerHTML = OCCASION_PRESETS.map(o =>
    `<button type="button" class="occasion-btn" data-occasion="${o.id}">${o.label}</button>`
  ).join("");
}

// --- Suggest Outfits ---
async function runSuggestFlow(anchors, occasion){
  el.suggestBackdrop.hidden = false;
  el.suggestList.innerHTML = "";
  const occasionLabel = occasion ? occasion.label.replace(/^\S+\s/, "") : null; // drop the emoji for status text
  el.suggestStatus.textContent = anchors.length
    ? `Researching ${occasionLabel ? occasionLabel.toLowerCase() + " " : ""}ideas for ${anchors.map(a => a.name).join(", ")}…`
    : occasionLabel
      ? `Researching ${occasionLabel.toLowerCase()} ideas…`
      : "Researching a few outfit ideas…";

  try{
    const outfits = await suggestOutfits(anchors, occasion);
    if (!outfits.length){
      el.suggestStatus.textContent = "Couldn't come up with anything — try adding a few more items to your closet first.";
      return;
    }
    el.suggestStatus.textContent = "";
    renderSuggestions(outfits);
  }catch(err){
    console.error("Outfit suggestion failed:", err);
    el.suggestStatus.textContent = "Something went wrong getting suggestions — check the console for details.";
  }
}

el.suggestBtn.addEventListener("click", () => runSuggestFlow(selectedList(), null));

el.occasionBar.addEventListener("click", (e) => {
  const btn = e.target.closest(".occasion-btn");
  if (!btn) return;
  const occasion = OCCASION_PRESETS.find(o => o.id === btn.dataset.occasion);
  runSuggestFlow(selectedList(), occasion);
});

el.suggestClose.addEventListener("click", () => {
  el.suggestBackdrop.hidden = true;
});

function renderSuggestions(outfits){
  el.suggestList.innerHTML = outfits.map((outfit, idx) => `
    <div class="suggestion-card">
      <div class="suggestion-thumbs">
        ${outfit.items.map(i => `<img src="${i.imageData}" alt="${escapeHtml(i.name)}" title="${escapeHtml(i.name)}">`).join("")}
      </div>
      <p class="suggestion-rationale">${escapeHtml(outfit.rationale)}</p>
      <button type="button" class="btn-primary suggestion-wear" data-idx="${idx}">Wear This</button>
    </div>
  `).join("");

  el.suggestList.querySelectorAll(".suggestion-wear").forEach(btn => {
    btn.addEventListener("click", () => {
      const outfit = outfits[Number(btn.dataset.idx)];
      state.selection = emptySelection();
      outfit.items.forEach(item => { state.selection[item.category] = item; });
      el.suggestBackdrop.hidden = true;
      render();
    });
  });
}

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
  renderOccasionBar();
  state.items = await dbGetAll();
  state.loaded = true;
  render();
})();
