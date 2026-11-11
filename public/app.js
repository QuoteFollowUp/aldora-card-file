"use strict";
const CATS = ["Commercial Glazier","Glazier / Glass Shop","Mom-Pop Shop","Shower Door Company","Specialty Company","Dealer / Distributor","Franchised Glass Company","General Contractor / Builder","Architect / Designer","Insulation Company","Other","Unassigned"];
const BRANCHES = ["Charleston","Louisville","Coral Springs","Miami","Orlando","Atlanta","Newport News","New Angle Beveling","VistaView"];
const GROUPS = ["Storefront & Metal","Commercial Glass","Residential Glass","Monolithic & Stock Sheets","Showers & Closets","Custom Fab, Mirror & Railings","VistaView"];
const PAGE = 150, BATCH = 200, TOKEN_KEY = "cardfile.token";
const $ = (id) => document.getElementById(id);

let token = null, me = null, cards = [], reps = [], filter = "All", current = null, editing = null, pendingPhoto = null, readJob = 0, loaded = false, shown = PAGE, showLeft = false;

/* ---------- utils ---------- */
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2600); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fullName(c) { return [c.first, c.last].filter(Boolean).join(" ") || c.company || "Unnamed contact"; }
function today() { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
function isDue(c) { return c.followUp && c.followUp <= today() && c.status !== "left"; }
function digits(p) { return String(p || "").replace(/[^\d+]/g, ""); }
function money(n) { n = +n || 0; return n >= 1e6 ? "$" + (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K" : "$" + n; }
function fmtDate(s) { return s ? new Date(s + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""; }
const normCo = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|co|corp|company|incorporated|ltd|the|dba)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
const fmtPhones = (c) => (c.phones || []).map((p) => `${p.label ? p.label + ": " : ""}${p.number}`).join("; ");
const oneAddr = (a) => [a.address, [[a.city, a.state].filter(Boolean).join(", "), a.zip].filter(Boolean).join(" ")].filter(Boolean).join("\n");
const fmtAddrs = (c) => (c.addresses || []).map((a) => `${a.label ? a.label + ": " : ""}${oneAddr(a).replace(/\n/g, ", ")}`).join("; ");
function personName(c) { return [c.first, c.last].filter(Boolean).join(" "); }
function primaryPhone(c) { return c.office || c.mobile || ((c.phones || [])[0] || {}).number || ""; }
async function copy(text, label) { try { await navigator.clipboard.writeText(text); toast((label || "Text") + " copied"); } catch { toast("Copy blocked. Press and hold the text to copy it."); } }
function download(name, text) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
const csvCell = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

async function api(path, opts = {}) {
  const r = await fetch("/api/" + path, { method: opts.method || "GET", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "login") { signOut(j.error); throw new Error(j.error || "Signed out"); }
  if (!r.ok) throw new Error(j.error || "Something went wrong. Try again.");
  return j;
}

/* ---------- sign in ---------- */
function showLogin(msg) { $("app").hidden = true; $("login").hidden = false; $("loginErr").textContent = msg || ""; setTimeout(() => $("code").focus(), 50); }
function signOut(msg) { token = null; me = null; lsSet(TOKEN_KEY, null); closeSheets(); showLogin(msg); }
$("signout").onclick = () => signOut();
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("loginBtn").disabled = true; $("loginErr").textContent = "";
  try { const j = await api("login", { method: "POST", body: { code: $("code").value } }); token = j.token; lsSet(TOKEN_KEY, token); $("code").value = ""; start(j.user); }
  catch (err) { $("loginErr").textContent = err.message; }
  finally { $("loginBtn").disabled = false; }
});

function start(user) {
  me = user; $("login").hidden = true; $("app").hidden = false;
  const roleLabel = user.role === "admin" ? "Manager, all branches" : user.role === "branch" ? (user.branch === "*" ? `${user.name}, all branches` : `Branch manager, ${user.branch}`) : `${user.name}${user.branch ? ", " + user.branch : ""}`;
  $("whoami").textContent = "Signed in: " + roleLabel;
  const mgr = user.role !== "rep";
  $("tabs").hidden = false;
  document.querySelectorAll("[data-mgr]").forEach((b) => (b.hidden = !mgr));
  document.querySelectorAll("[data-admin]").forEach((b) => (b.hidden = user.role !== "admin"));
  $("fRep").hidden = !mgr;
  $("fBranch").hidden = user.role === "rep" || (user.role === "branch" && user.branch !== "*");
  $("repField").hidden = user.role !== "admin";
  $("dDel").hidden = user.role !== "admin";
  showTab("contacts");
  loadContacts(); loadGroups();
}

/* ---------- tabs ---------- */
function showTab(t) {
  document.querySelectorAll("#tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  ["contacts", "groups", "changes", "people", "import"].forEach((x) => ($("tab-" + x).hidden = x !== t));
  if (t !== "contacts") endSelect();
  if (t === "groups") renderGroups();
  if (t === "import") loadSyncInfo();
  $("filters").hidden = t !== "contacts"; $("bar").hidden = t !== "contacts";
  if (t === "changes") loadChanges(); if (t === "people") loadPeople();
}
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });

/* ---------- contacts ---------- */
async function loadContacts() {
  loaded = false; renderList();
  try {
    const j = await api("contacts"); cards = j.contacts; reps = j.reps || []; loaded = true;
    const keepRep = $("fRep").value;
    $("fRep").innerHTML = `<option value="">All reps</option>` + [...new Set(cards.map((c) => c.rep).filter(Boolean))].sort().map((r) => `<option>${esc(r)}</option>`).join("");
    if ([...$("fRep").options].some((o) => o.value === keepRep)) $("fRep").value = keepRep;
    $("f_rep").innerHTML = `<option value="">Unassigned</option>` + reps.map((r) => `<option>${esc(r.name)}</option>`).join("");
    $("notice").hidden = true; renderList();
  } catch (err) { loaded = true; $("notice").hidden = false; $("notice").textContent = "Couldn't load contacts. " + err.message; renderList(); }
}
$("fBranch").innerHTML += BRANCHES.map((b) => `<option>${esc(b)}</option>`).join("");
function baseFiltered() {
  const br = $("fBranch").value, rp = $("fRep").value, pr = $("fProd").value, q = $("q").value.trim().toLowerCase();
  return cards.filter((c) => {
    if (br && c.branch !== br) return false;
    if (rp && c.rep !== rp) return false;
    if (pr) { if (pr.startsWith("sf:")) { if (c.sfStatus !== pr.slice(3)) return false; } else if (!(c.products || []).includes(pr)) return false; }
    if (q && ![c.first, c.last, c.title, c.company, c.email, c.city, c.state, c.notes, c.met, c.category, c.mobile, c.office, c.rep, c.branch, c.replacedBy, fmtPhones(c), fmtAddrs(c)].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
}
function renderChips(base) {
  const active = base.filter((c) => c.status !== "left");
  const counts = {}; active.forEach((c) => (counts[c.category || "Unassigned"] = (counts[c.category || "Unassigned"] || 0) + 1));
  const due = active.filter(isDue).length, gone = base.length - active.length;
  const opts = ["All", ...(due ? ["Follow-up due"] : []), ...CATS.filter((c) => counts[c]), ...(gone ? ["Former contacts"] : [])];
  if (!opts.includes(filter)) filter = "All";
  $("chips").innerHTML = opts.map((o) => { const n = o === "All" ? active.length : o === "Follow-up due" ? due : o === "Former contacts" ? gone : counts[o]; return `<button class="chip" type="button" data-f="${esc(o)}" aria-pressed="${o === filter}">${esc(o)} · ${n.toLocaleString()}</button>`; }).join("");
}
function visible(base) {
  base = base || baseFiltered();
  const v = base.filter((c) => filter === "Former contacts" ? c.status === "left" : c.status !== "left" && (filter === "All" || (filter === "Follow-up due" ? isDue(c) : (c.category || "Unassigned") === filter)));
  const s = $("sort").value, k = (x) => (x || "").toLowerCase();
  v.sort((a, b) => s === "company" ? k(a.company).localeCompare(k(b.company)) || k(a.last).localeCompare(k(b.last))
    : s === "name" ? k(a.last || a.first || a.company).localeCompare(k(b.last || b.first || b.company))
    : s === "follow" ? (a.followUp || "9999").localeCompare(b.followUp || "9999")
    : s === "lastcall" ? (b.lastCall || "").localeCompare(a.lastCall || "")
    : s === "quote" ? (b.openQuoteUsd || 0) - (a.openQuoteUsd || 0)
    : (b.created || 0) - (a.created || 0));
  return v;
}
function renderList() {
  const base = baseFiltered(); renderChips(base);
  const v = visible(base), mgr = me && me.role !== "rep";
  $("count").textContent = loaded ? `${cards.filter((c) => c.status !== "left").length.toLocaleString()} contacts` : "Loading…";
  $("list").innerHTML = v.slice(0, shown).map((c) => `<li><button class="row${c.status === "left" ? " left" : ""}${selecting ? " selectable" : ""}" type="button" data-id="${esc(c.id)}"${selecting ? ` aria-pressed="${selected.has(c.id)}"` : ""}>
    ${selecting ? `<span class="tick" aria-hidden="true"></span>` : c.thumb ? `<img class="thumb card" src="${esc(c.thumb)}" alt="" loading="lazy">` : `<span class="thumb logo${c.hasPhoto ? " pending" : ""}" aria-hidden="true"></span>`}
    <span class="who"><div class="name">${esc(c.company || personName(c) || "Unnamed contact")}</div><div class="co2">${esc(c.company ? [personName(c) || "No contact name", c.title].filter(Boolean).join(" · ") : c.title || "")}</div><div class="ph">${esc([primaryPhone(c), mgr ? c.rep : ""].filter(Boolean).join(" · "))}</div></span>
    <span class="meta">${c.status === "left" ? `<span class="tag gone">Left</span>` : isDue(c) ? `<span class="tag due">Follow up</span>` : `<span class="tag">${esc(c.category || "Unassigned")}</span>`}${c.branch || c.city ? `<span class="loc">${esc(mgr ? c.branch : [c.city, c.state].filter(Boolean).join(", ") || c.branch)}</span>` : ""}</span>
  </button></li>`).join("");
  $("more").hidden = v.length <= shown; $("more").textContent = `Show more (${(v.length - shown).toLocaleString()} left)`;
  const none = loaded && !v.length; $("empty").hidden = !none;
  if (none && cards.length) { $("emptyTitle").textContent = "No matches"; $("emptyText").textContent = "Nothing in this view matches. Clear the search or change a filter."; }
  else { $("emptyTitle").textContent = "No contacts yet"; $("emptyText").textContent = me && me.role === "admin" ? "Go to Import and upload the Email Distribution Lists workbook to load the call log contacts." : "Tap Scan card and take a photo of a customer's business card."; }
  $("groupbar").hidden = !v.length;
  $("grouplbl").textContent = `${v.length.toLocaleString()} shown · ${v.filter((c) => c.email).length.toLocaleString()} with email`;
}
function reset() { shown = PAGE; $("grouppanel").hidden = true; renderList(); }
$("chips").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; filter = b.dataset.f; reset(); });
["q", "sort", "fBranch", "fRep", "fProd"].forEach((id) => $(id).addEventListener(id === "q" ? "input" : "change", reset));
$("more").onclick = () => { shown += PAGE; renderList(); };
$("list").addEventListener("click", (e) => {
  const b = e.target.closest(".row"); if (!b) return;
  if (!selecting) return openDetail(b.dataset.id);
  const id = b.dataset.id; selected.has(id) ? selected.delete(id) : selected.add(id);
  b.setAttribute("aria-pressed", String(selected.has(id))); updateSelbar();
});
function upsertLocal(c) { const i = cards.findIndex((x) => x.id === c.id); if (i >= 0) cards[i] = c; else cards.push(c); renderList(); }

/* ---------- group email + export ---------- */
let groupAddrs = [];
function viewLabel() { const p = $("fProd").selectedOptions[0]; return [p.value ? p.text : "", $("fBranch").value, $("fRep").value, filter === "All" ? "" : filter, $("q").value ? `"${$("q").value}"` : ""].filter(Boolean).join(" · ") || "all contacts"; }
$("emailGroup").onclick = () => {
  const seen = new Set(); groupAddrs = [];
  visible().forEach((c) => { const e = (c.email || "").trim(); if (e && c.status !== "left" && !seen.has(e.toLowerCase())) { seen.add(e.toLowerCase()); groupAddrs.push(e); } });
  $("groupaddrs").value = groupAddrs.join("; ");
  const nb = Math.ceil(groupAddrs.length / BATCH);
  $("groupnote").textContent = groupAddrs.length ? `${groupAddrs.length.toLocaleString()} addresses for ${viewLabel()}.${nb > 1 ? ` Split into ${nb} batches of up to ${BATCH} to stay under send limits.` : ""} Paste into BCC so customers don't see each other.` : "No email addresses in this view.";
  $("groupBatches").innerHTML = Array.from({ length: nb }, (_, i) => { const a = i * BATCH + 1, b = Math.min((i + 1) * BATCH, groupAddrs.length); return `<button class="btn sm${i === 0 ? " primary" : ""}" type="button" data-b="${i}" style="flex:none">Copy ${nb > 1 ? `${a}–${b}` : "addresses"}</button>`; }).join("") + (nb === 1 ? `<a class="btn sm" href="mailto:?bcc=${encodeURIComponent(groupAddrs.join(","))}">Open in Mail (BCC)</a>` : "");
  $("grouppanel").hidden = false;
};
$("groupBatches").addEventListener("click", (e) => { const b = e.target.closest("[data-b]"); if (!b) return; const i = +b.dataset.b; copy(groupAddrs.slice(i * BATCH, (i + 1) * BATCH).join("; "), `Batch ${i + 1}`); });
$("saveViewGroup").onclick = () => openPicker(visible().filter((c) => c.status !== "left").map((c) => c.id), `the ${visible().filter((c) => c.status !== "left").length.toLocaleString()} contacts in this view`);
$("closeGroup").onclick = () => ($("grouppanel").hidden = true);
$("exportBtn").onclick = () => {
  const head = ["First","Last","Title","Company","Email","Mobile","Office","Other phones","Website","Address","City","State","Zip","Other addresses","Account type","Branch","Sales rep","Status","Replaced by","Products","Storefront status","Last call","Calls logged","Open quotes","Open quote $","Storefront quote $","Where met","Follow up","Notes"];
  const rows = visible().map((c) => [c.first,c.last,c.title,c.company,c.email,c.mobile,c.office,fmtPhones(c),c.website,c.address,c.city,c.state,c.zip,fmtAddrs(c),c.category,c.branch,c.rep,c.status === "left" ? "Left company" : "Active",c.replacedBy,(c.products || []).join("; "),c.sfStatus,c.lastCall,c.calls,c.openQuotes,c.openQuoteUsd,c.sfQuoteUsd,c.met,c.followUp,c.notes]);
  download(`aldora-contacts-${today()}.csv`, [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"));
};

/* ---------- photos and scanning ---------- */
function loadImg(file) { return new Promise((res, rej) => { const u = URL.createObjectURL(file), i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; }); }
function scaled(img, max, q) { const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", q); }
function makeThumb(img) { // 168x100 card-shaped crop, about 4 KB
  const W = 168, H = 100, c = document.createElement("canvas"); c.width = W; c.height = H;
  const r = Math.max(W / img.naturalWidth, H / img.naturalHeight), w = img.naturalWidth * r, h = img.naturalHeight * r;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  return c.toDataURL("image/jpeg", 0.7);
}
let pendingThumb = null;
function smallPhoto(img) { let w = 900, q = 0.62, url; do { url = scaled(img, w, q); w -= 150; q -= 0.08; } while (url.length > 180000 && w > 300); return url; }
function findMatch(out) {
  const em = (out.email || "").trim().toLowerCase();
  if (em) { const m = cards.find((c) => (c.email || "").toLowerCase() === em); if (m) return m; }
  const fn = (out.first || "").toLowerCase(), ln = (out.last || "").toLowerCase(), co = (out.company || "").toLowerCase().slice(0, 8);
  if (ln && co) return cards.find((c) => (c.last || "").toLowerCase() === ln && (c.first || "").toLowerCase().startsWith(fn.slice(0, 3)) && (c.company || "").toLowerCase().startsWith(co)) || null;
  return null;
}
function showRead(text, busy) { $("readStatus").hidden = false; $("readText").textContent = text; $("readStatus").querySelector(".spin").hidden = !busy; }
$("cam").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  openEdit(null);
  let img; try { img = await loadImg(file); } catch { showRead("That photo couldn't be opened. Try again, or type the card in.", false); return; }
  pendingPhoto = smallPhoto(img); pendingThumb = makeThumb(img); $("editPhoto").src = pendingPhoto; $("editPhoto").hidden = false;
  const job = ++readJob; showRead("Reading the card…", true);
  try {
    const { fields: out } = await api("scan", { method: "POST", body: { image: scaled(img, 1400, 0.82) } });
    if (job !== readJob) return;
    const match = out && findMatch(out);
    if (match) { editing = match; $("editTitle").textContent = "Update existing contact"; FIELDS.forEach((k) => ($(fid(k)).value = match[k] || "")); }
    let n = 0;
    for (const k of ["first","last","title","company","email","mobile","office","website","address","city","state","zip"]) { const el = $(fid(k)); if (out && out[k] && !el.value) { el.value = String(out[k]).trim(); n++; } }
    if (!match && out && CATS.includes(out.category)) $("f_category").value = out.category;
    showRead(match ? `${fullName(match)} is already in your file. Added ${n} new field${n === 1 ? "" : "s"} from the card plus the photo. Check and save.` : n ? `Read ${n} field${n === 1 ? "" : "s"}. Check them, add where you met, and save.` : "Nothing readable on that photo. Type the fields in, or retake it in better light.", false);
  } catch (err) { if (job === readJob) showRead(err.message + " You can type the fields in below.", false); }
});

/* ---------- edit ---------- */
$("f_category").innerHTML = CATS.map((c) => `<option>${esc(c)}</option>`).join("");
$("f_branch").innerHTML = `<option value="">None</option>` + BRANCHES.map((b) => `<option>${esc(b)}</option>`).join("");
const FIELDS = ["first","last","title","company","email","mobile","office","website","address","city","state","zip","category","branch","rep","followUp","met","notes"];
const fid = (k) => (k === "followUp" ? "f_followup" : "f_" + k);
let xid = 0;
function addPhoneRow(p = {}) {
  const i = ++xid, el = document.createElement("div"); el.className = "xrow ph-row";
  el.innerHTML = `<div class="f"><label for="xpl${i}">Label</label><input id="xpl${i}" class="xl" placeholder="Shop, Cell 2, Fax" value="${esc(p.label || "")}"></div><div class="f"><label for="xpn${i}">Phone</label><input id="xpn${i}" class="xn" type="tel" value="${esc(p.number || "")}"></div><button class="x" type="button" aria-label="Remove phone">Remove</button>`;
  $("xPhones").appendChild(el); return el;
}
function addAddrRow(a = {}) {
  const i = ++xid, el = document.createElement("div"); el.className = "xrow adr ad-row";
  el.innerHTML = `<div class="f"><label for="xal${i}">Label</label><input id="xal${i}" class="xl" placeholder="Shop, Warehouse, Bill-to" value="${esc(a.label || "")}"></div><div class="f"><label for="xaz${i}">Zip</label><input id="xaz${i}" class="xz" inputmode="numeric" maxlength="10" value="${esc(a.zip || "")}"></div><button class="x" type="button" aria-label="Remove address">Remove</button>
  <div class="f full2"><label for="xas${i}">Street address</label><input id="xas${i}" class="xs" value="${esc(a.address || "")}"></div>
  <div class="f"><label for="xac${i}">City</label><input id="xac${i}" class="xc" value="${esc(a.city || "")}"></div><div class="f"><label for="xat${i}">State</label><input id="xat${i}" class="xt" maxlength="20" value="${esc(a.state || "")}"></div>`;
  $("xAddrs").appendChild(el); return el;
}
function readPhones() { return [...$("xPhones").querySelectorAll(".ph-row")].map((r) => ({ label: r.querySelector(".xl").value.trim(), number: r.querySelector(".xn").value.trim() })).filter((p) => p.number); }
function readAddrs() { return [...$("xAddrs").querySelectorAll(".ad-row")].map((r) => ({ label: r.querySelector(".xl").value.trim(), address: r.querySelector(".xs").value.trim(), city: r.querySelector(".xc").value.trim(), state: r.querySelector(".xt").value.trim().toUpperCase(), zip: r.querySelector(".xz").value.trim() })).filter((a) => a.address || a.city); }
$("addPhone").onclick = () => addPhoneRow().querySelector(".xl").focus();
$("addAddr").onclick = () => addAddrRow().querySelector(".xl").focus();
["xPhones", "xAddrs"].forEach((id) => $(id).addEventListener("click", (e) => { const b = e.target.closest(".x"); if (b) b.closest(".xrow").remove(); }));
function openEdit(c, preset) {
  editing = c; pendingPhoto = null; pendingThumb = null; readJob++;
  $("editTitle").textContent = c ? "Edit contact" : "New card";
  FIELDS.forEach((k) => ($(fid(k)).value = c ? c[k] || "" : ""));
  $("xPhones").innerHTML = ""; $("xAddrs").innerHTML = "";
  ((c && c.phones) || (preset && preset.phones) || []).forEach((p) => addPhoneRow(p));
  ((c && c.addresses) || (preset && preset.addresses) || []).forEach((a) => addAddrRow(a));
  if (!c) { $("f_category").value = "Commercial Glazier"; $("f_branch").value = me.branch || ""; if (me.role === "rep") $("f_rep").value = me.name; }
  if (preset) for (const k in preset) if (FIELDS.includes(k)) $(fid(k)).value = preset[k] ?? "";
  $("f_branch").disabled = me.role === "branch";
  $("editPhoto").hidden = true; $("readStatus").hidden = true; $("saveBtn").disabled = false;
  if (c && c.hasPhoto) loadPhoto(c, $("editPhoto"));
  raise($("edit"));
}
let zTop = 30;
function raise(el) { el.style.zIndex = ++zTop; el.hidden = false; el.scrollTop = 0; document.body.style.overflow = "hidden"; }
function closeSheet(id) { $(id).hidden = true; if (["edit", "detail", "gpick", "gview", "rpick"].every((x) => $(x).hidden)) document.body.style.overflow = ""; }
function closeSheets() { ["edit", "detail", "gpick", "gview", "rpick"].forEach((x) => ($(x).hidden = true)); document.body.style.overflow = ""; }
$("editCancel").onclick = () => { readJob++; if (!$("detail").hidden) $("edit").hidden = true; else closeSheets(); };
$("manual").onclick = () => openEdit(null);
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = {}; FIELDS.forEach((k) => (data[k] = $(fid(k)).value.trim()));
  data.state = data.state.toUpperCase();
  if (me.role !== "admin") delete data.rep;
  const lists = { phones: readPhones(), addresses: readAddrs() };
  if (!data.first && !data.last && !data.company) { toast("Add a name or a company before saving."); return; }
  $("saveBtn").disabled = true;
  try {
    if (editing) {
      const patch = {}; for (const k in data) if ((editing[k] || "") !== data[k]) patch[k] = data[k];
      for (const k in lists) if (JSON.stringify(editing[k] || []) !== JSON.stringify(lists[k])) patch[k] = lists[k];
      if (me.role !== "admin") delete patch.branch;
      if (pendingPhoto) { patch.photo = pendingPhoto; if (pendingThumb) patch.thumb = pendingThumb; }
      if (!Object.keys(patch).length) { $("edit").hidden = true; if ($("detail").hidden) closeSheets(); return; }
      const { contact } = await api("contacts/" + encodeURIComponent(editing.id), { method: "PUT", body: { shard: editing.shard, patch } });
      upsertLocal(contact); $("edit").hidden = true; toast("Contact updated"); openDetail(contact.id);
    } else {
      const { contact } = await api("contacts", { method: "POST", body: { contact: { ...data, ...lists, photo: pendingPhoto || "", thumb: pendingPhoto ? pendingThumb || "" : "" } } });
      upsertLocal(contact); closeSheets(); toast(`${fullName(contact)} filed`);
    }
  } catch (err) { $("saveBtn").disabled = false; toast(err.message); }
});

/* ---------- detail ---------- */
const photoCache = {};
async function loadPhoto(c, imgEl) {
  imgEl.hidden = true;
  try {
    const p = photoCache[c.id] || (photoCache[c.id] = (await api(`contacts/${encodeURIComponent(c.id)}/photo?shard=${encodeURIComponent(c.shard)}`)).photo); imgEl.src = p; imgEl.hidden = false;
    if (!c.thumb && !(me && me.ro)) { const im = new Image(); im.onload = async () => { try { const { contact } = await api("contacts/" + encodeURIComponent(c.id), { method: "PUT", body: { shard: c.shard, patch: { thumb: makeThumb(im) } } }); upsertLocal(contact); } catch {} }; im.src = p; }
  } catch {}
}
function infoRows(el, lines, copyable) {
  const canCopy = (l) => copyable ? copyable.includes(l[0]) : l[3] === "tel" || l[0] === "Email" || /\n|\d{5}/.test(l[1]) && !/^(Met|Notes|Replaced by)$/.test(l[0]);
  el.innerHTML = lines.map((l, i) => `<div class="ln"><dt>${esc(l[0])}</dt><dd class="${l[2] ? "num" : ""}" style="white-space:pre-line">${l[3] === "tel" ? `<a href="tel:${esc(digits(String(l[1]).split(" x")[0]))}">${esc(l[1])}</a>` : l[3] === "mail" ? `<a href="mailto:${esc(l[1])}">${esc(l[1])}</a>` : esc(l[1])}</dd>${canCopy(l) ? `<button class="copy" type="button" data-i="${i}">Copy</button>` : "<span></span>"}</div>`).join("");
  el.onclick = (e) => { const b = e.target.closest(".copy"); if (b) { const l = lines[+b.dataset.i]; copy(l[1], l[0]); } };
}
function openDetail(id) {
  const c = cards.find((x) => x.id === id); if (!c) return; current = c;
  $("dName").textContent = c.company || personName(c) || "Unnamed contact";
  $("dCompany").textContent = c.company ? personName(c) || "No contact name" : ""; $("dCompany").className = "c person";
  $("dTitle").textContent = c.title || "";
  const sfLabel = { GAP: "Storefront gap", ADD: "Storefront quoted, untagged", Aligned: "Storefront aligned" }[c.sfStatus];
  $("dTags").innerHTML = (c.status === "left" ? `<span class="tag gone">Left company ${esc(fmtDate(c.leftDate))}</span>` : "") + `<span class="tag">${esc(c.category || "Unassigned")}</span>` + (sfLabel ? `<span class="tag${c.sfStatus === "GAP" ? " due" : ""}">${sfLabel}</span>` : "") + (c.followUp ? `<span class="tag${isDue(c) ? " due" : ""}">Follow up ${esc(fmtDate(c.followUp))}</span>` : "");
  const phone = c.mobile || c.office || ((c.phones || [])[0] || {}).number;
  $("qEmail").href = c.email ? "mailto:" + encodeURIComponent(c.email) : "#"; $("qEmail").style.opacity = c.email ? 1 : 0.4;
  $("qCall").href = phone ? "tel:" + digits(phone.split(" x")[0]) : "#"; $("qCall").style.opacity = phone ? 1 : 0.4;
  const lines = [["Email", c.email, 0, "mail"], ["Mobile", c.mobile, 1, "tel"], ["Office", c.office, 1, "tel"]];
  (c.phones || []).forEach((p) => lines.push([p.label || "Phone", p.number, 1, "tel"]));
  lines.push(["Website", c.website, 0], ["Address", oneAddr(c), 0]);
  (c.addresses || []).forEach((a) => lines.push([a.label || "Address", oneAddr(a), 0]));
  lines.push(["Replaced by", c.replacedBy, 0], ["Met", c.met, 0], ["Notes", c.notes, 0]);
  infoRows($("dInfo"), lines.filter((l) => l[1]), null);
  const co = normCo(c.company), others = co ? cards.filter((x) => x.id !== c.id && normCo(x.company) === co).sort((a, b) => (a.status === "left") - (b.status === "left") || personName(a).localeCompare(personName(b))) : [];
  $("dCoLbl").textContent = others.length ? `${others.length} other contact${others.length === 1 ? "" : "s"} at ${c.company}` : c.company ? `No other contacts at ${c.company}` : "Company";
  $("dCoList").innerHTML = others.map((x) => `<li><button class="row${x.status === "left" ? " left" : ""}" type="button" data-id="${esc(x.id)}" style="grid-template-columns:1fr auto"><span class="who"><div class="name">${esc(personName(x) || "No contact name")}</div><div class="co2">${esc([x.title, x.email].filter(Boolean).join(" · "))}</div></span><span class="meta">${x.status === "left" ? `<span class="tag gone">Left</span>` : `<span class="loc">${esc(x.mobile || x.office || "")}</span>`}</span></button></li>`).join("");
  $("dAddCo").hidden = !c.company;
  const acct = [["Branch", c.branch, 0], ["Rep", c.rep, 0], ["Top focus", c.topGroup, 0], ["Products", (c.products || []).join(", "), 0], ["Last call", fmtDate(c.lastCall), 1], ["Call notes", c.lastNote, 0], ["Calls", c.calls ? String(c.calls) : "", 1], ["Open quotes", c.openQuotes ? `${c.openQuotes} · ${money(c.openQuoteUsd)}` : "", 1], ["Storefront $", c.sfQuoteUsd ? money(c.sfQuoteUsd) : "", 1], ["Last edit", c.updatedBy ? `${c.updatedBy}, ${new Date(c.updated).toLocaleDateString()}` : "", 0]].filter((l) => l[1]);
  $("dAcctWrap").hidden = !acct.length; infoRows($("dAcct"), acct, []);
  $("dPhoto").hidden = true; if (c.hasPhoto) loadPhoto(c, $("dPhoto"));
  $("dLeft").textContent = c.status === "left" ? "Undo left" : "Left company";
  $("draft").hidden = true; $("delConfirm").hidden = true; $("leftBox").hidden = true;
  renderDetailGroups(c);
  loadCalls(c);
  raise($("detail"));
}
$("qEmail").addEventListener("click", (e) => { if (!current || !current.email) { e.preventDefault(); toast("No email on this contact."); } });
$("qCall").addEventListener("click", (e) => { if (!current || !(current.mobile || current.office)) { e.preventDefault(); toast("No phone on this contact."); } });
$("dBack").onclick = () => { closeSheet("detail"); if (!$("gview").hidden) renderGroupView(); };
$("dCoList").addEventListener("click", (e) => { const b = e.target.closest(".row"); if (b) openDetail(b.dataset.id); });
$("dAddCo").onclick = () => {
  const c = current;
  openEdit(null, { company: c.company, category: c.category || "Commercial Glazier", branch: c.branch, rep: c.rep || "", office: c.office, website: c.website, address: c.address, city: c.city, state: c.state, zip: c.zip, phones: (c.phones || []).filter((p) => !/cell|mobile/i.test(p.label)), addresses: c.addresses || [] });
  $("editTitle").textContent = "New contact at " + c.company; $("detail").hidden = true;
};
$("dEdit").onclick = () => openEdit(current);
$("dLeft").onclick = async () => {
  if (current.status === "left") {
    try { const { contact } = await api(`contacts/${encodeURIComponent(current.id)}/restore`, { method: "POST", body: { shard: current.shard } }); upsertLocal(contact); openDetail(contact.id); toast("Marked active again"); } catch (err) { toast(err.message); }
    return;
  }
  $("replacedBy").value = ""; $("leftBox").hidden = false;
};
$("leftNo").onclick = () => ($("leftBox").hidden = true);
$("leftYes").onclick = async () => {
  const rb = $("replacedBy").value.trim(), add = $("addReplacement").checked && rb, old = current;
  try {
    const { contact } = await api(`contacts/${encodeURIComponent(old.id)}/left`, { method: "POST", body: { shard: old.shard, replacedBy: rb } });
    upsertLocal(contact); toast(`${fullName(old)} marked as left`);
    if (add) { const parts = rb.split(/\s+/); openEdit(null, { first: parts.slice(0, -1).join(" ") || parts[0], last: parts.length > 1 ? parts[parts.length - 1] : "", company: old.company, category: old.category || "Commercial Glazier", branch: old.branch, rep: old.rep || "", office: old.office, website: old.website, address: old.address, city: old.city, state: old.state, zip: old.zip, met: `Replaced ${fullName(old)}` }); $("detail").hidden = true; }
    else openDetail(contact.id);
  } catch (err) { toast(err.message); }
};
$("dDel").onclick = () => ($("delConfirm").hidden = false);
$("delNo").onclick = () => ($("delConfirm").hidden = true);
$("delYes").onclick = async () => { try { await api(`contacts/${encodeURIComponent(current.id)}?shard=${encodeURIComponent(current.shard)}`, { method: "DELETE" }); cards = cards.filter((c) => c.id !== current.id); closeSheets(); renderList(); toast("Contact deleted"); } catch (err) { toast(err.message); } };

let draftText = "";
$("qDraft").onclick = async () => {
  const c = current; if (!c) return;
  $("draft").hidden = false; $("draftStatus").hidden = false; $("draftSubj").textContent = ""; $("draftBody").textContent = ""; $("draftActions").hidden = true;
  try {
    const d = await api("draft", { method: "POST", body: { contact: c } });
    $("draftSubj").textContent = d.subject || ""; $("draftBody").textContent = d.body || ""; draftText = d.body || "";
    $("draftMail").href = `mailto:${encodeURIComponent(c.email || "")}?subject=${encodeURIComponent(d.subject || "")}&body=${encodeURIComponent(d.body || "")}`;
    $("draftActions").hidden = false;
  } catch (err) { $("draftBody").textContent = err.message; }
  finally { $("draftStatus").hidden = true; }
};
$("draftCopy").onclick = () => copy(`Subject: ${$("draftSubj").textContent}\n\n${draftText}`, "Email");

/* ---------- changes ---------- */
let changes = [];
const FIELD_LABEL = { first: "first name", last: "last name", followUp: "follow-up", met: "where met", rep: "rep", zip: "zip" };
function describe(e) {
  if (e.action === "left company") return `Left company${e.replacedBy ? `. Replaced by ${e.replacedBy}` : ""}`;
  if (e.changes) return Object.entries(e.changes).map(([k, [a, b]]) => `${FIELD_LABEL[k] || k}: ${a ? `${a} → ` : ""}${b || "(cleared)"}`).join("\n");
  return e.action.charAt(0).toUpperCase() + e.action.slice(1);
}
function filteredChanges() {
  const t = $("chType").value;
  return changes.filter((e) => !t || (t === "field" ? e.action === "updated" && e.role !== "admin" : e.action === t));
}
function renderChanges() {
  const v = filteredChanges();
  $("chBody").innerHTML = v.length ? v.map((e) => `<tr><td class="num">${esc(new Date(e.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</td><td>${esc(e.by)}</td><td><strong>${esc(e.contact || "")}</strong>${e.company && e.company !== e.contact ? `<br><span style="color:var(--muted)">${esc(e.company)}</span>` : ""}${e.branch ? `<br><span class="pill">${esc(e.branch)}</span>` : ""}</td><td style="white-space:pre-line">${esc(describe(e))}</td></tr>`).join("") : `<tr><td colspan="4" style="color:var(--muted)">No changes in this period.</td></tr>`;
}
async function loadChanges() {
  $("chBody").innerHTML = `<tr><td colspan="4" style="color:var(--muted)">Loading…</td></tr>`;
  try { changes = (await api("changes?days=" + $("chDays").value)).changes; renderChanges(); } catch (err) { $("chBody").innerHTML = `<tr><td colspan="4">${esc(err.message)}</td></tr>`; }
}
$("chDays").onchange = loadChanges; $("chType").onchange = renderChanges;
$("chExport").onclick = () => {
  const rows = filteredChanges().map((e) => [new Date(e.ts).toISOString().slice(0, 10), e.by, e.contact, e.company, e.branch, e.rep, e.action, describe(e).replace(/\n/g, "; ")]);
  download(`aldora-contact-changes-${today()}.csv`, [["Date", "By", "Contact", "Company", "Branch", "Rep", "Action", "Detail"], ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"));
};

/* ---------- people ---------- */
$("pBranch").innerHTML = BRANCHES.map((b) => `<option>${esc(b)}</option>`).join("");
let people = [];
async function loadPeople() {
  $("pBody").innerHTML = `<tr><td colspan="6" style="color:var(--muted)">Loading…</td></tr>`;
  try {
    const j = await api("users"); people = j.users;
    $("pBody").innerHTML = (people.length ? people.map((u) => `<tr data-slug="${esc(u.slug)}"><td><strong>${esc(u.name)}</strong></td><td>${u.role === "branch" ? "Branch mgr" : "Rep"}</td><td><select data-act="branch" aria-label="Branch for ${esc(u.name)}"><option value="">None</option>${BRANCHES.map((b) => `<option${b === u.branch ? " selected" : ""}>${esc(b)}</option>`).join("")}</select></td><td class="num">${u.role === "branch" ? "" : u.contacts.toLocaleString()}</td><td>${u.active ? `<span class="pill on">Active</span>` : `<span class="pill">No access</span>`}</td><td style="white-space:nowrap"><button class="textbtn" data-act="code" type="button">${u.hasCode ? "Reset code" : "Create code"}</button>${u.active ? ` · <button class="textbtn" data-act="deactivate" type="button" style="color:var(--danger)">Turn off</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="6" style="color:var(--muted)">Nobody yet. Import the call log and every rep in it shows up here.</td></tr>`) + (j.unassigned ? `<tr><td colspan="6" style="color:var(--muted)">${j.unassigned.toLocaleString()} contacts have no rep. Only you can see them.</td></tr>` : "");
  } catch (err) { $("pBody").innerHTML = `<tr><td colspan="6">${esc(err.message)}</td></tr>`; }
}
$("pBody").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const slug = b.closest("tr").dataset.slug, u = people.find((p) => p.slug === slug), act = b.dataset.act;
  try {
    const j = await api(`users/${encodeURIComponent(slug)}/${act}`, { method: "POST", body: {} });
    if (j.code) {
      const msg = `${u.name.split(" ")[0]}, here is your access to the Aldora Card File. It holds your customer contacts. Scan business cards with it, and update people, phones and addresses as they change.\n\nOpen this link on your phone: ${location.origin}\nYour access code: ${j.code}\n\nAdd it to your home screen. On iPhone, tap Share in Safari, then Add to Home Screen. On Android, tap the Chrome menu, then Add to Home screen. Keep the code to yourself. It opens your list only.`;
      $("codeOut").hidden = false;
      $("codeOut").innerHTML = `<div style="display:grid;gap:8px"><div>New code for <strong>${esc(u.name)}</strong>. Send it now. It won't be shown again.</div><div class="codebox">${esc(j.code)}</div><div class="actions"><button class="btn sm primary" type="button" id="copyCodeMsg" style="flex:none">Copy message</button><a class="btn sm" href="mailto:?subject=${encodeURIComponent("Your Aldora Card File access")}&body=${encodeURIComponent(msg)}">Email it</a><a class="btn sm" href="sms:?&body=${encodeURIComponent(msg)}">Text it</a></div></div>`;
      $("copyCodeMsg").onclick = () => copy(msg, "Message");
    } else toast(`${u.name} can no longer sign in`);
    loadPeople();
  } catch (err) { toast(err.message); }
});
$("pBody").addEventListener("change", async (e) => {
  const s = e.target.closest("select[data-act=branch]"); if (!s) return;
  const slug = s.closest("tr").dataset.slug;
  try { await api(`users/${encodeURIComponent(slug)}/branch`, { method: "POST", body: { branch: s.value } }); toast("Branch saved"); } catch (err) { toast(err.message); }
});
$("pAdd").onclick = async () => {
  const name = $("pName").value.trim(); if (!name) { toast("Enter a name."); return; }
  try { await api("users", { method: "POST", body: { name, role: $("pRole").value, branch: $("pBranch").value } }); $("pName").value = ""; toast(`${name} added. Create a code to give them access.`); loadPeople(); } catch (err) { toast(err.message); }
};

/* ---------- import: call log workbook ---------- */
const TYPEMAP = { Showers: "Shower Door Company", "General Contractor": "General Contractor / Builder" };
const BADNAMES = new Set(["unknown", "have never spoken to him", "none", "na", "n/a"]);
const SUFFIX = { INC: "Inc", "INC.": "Inc.", CO: "Co", "CO.": "Co.", MFG: "Mfg", CORP: "Corp", "CORP.": "Corp.", COMPANY: "Company" };
function tcCompany(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length > 4 && s === s.toUpperCase() && s.includes(" ")) return s.split(" ").map((w) => SUFFIX[w] || (["LLC", "USA", "LLC.", "II", "III"].includes(w) || w.replace(/[^A-Z]/g, "").length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(" ");
  return s;
}
function fmt10(d) { return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; }
function phones(raw) {
  if (!raw) return ["", ""]; const s = String(raw); if (s.includes("@")) return ["", ""];
  const nums = [];
  for (const p of s.split(/\s*(?:\/|;(?=\d{3})|\bcell\b|\bc:)\s*/i)) {
    const ext = p.match(/(?:ext\.?:?|x)\s*(\d+)/i) || p.match(/;(\d{3,5})$/);
    let d = p.replace(/(?:ext\.?:?|x)\s*\d+/gi, "").replace(/;\d+$/, "").replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    if (d.length === 10) nums.push(fmt10(d) + (ext ? ` x${ext[1]}` : "")); else if (d) nums.push(p.trim());
  }
  return [nums[0] || "", nums[1] || ""];
}
function splitName(n) {
  n = String(n || "").replace(/\s+/g, " ").trim();
  if (!n || BADNAMES.has(n.toLowerCase())) return ["", ""];
  const t = n.split(" "); if (t.length === 1 || / and /i.test(n)) return [n, ""];
  let suffix = "";
  if (t.length > 2 && /^(jr|sr|ii|iii|iv)\.?$/i.test(t[t.length - 1])) suffix = " " + t.pop();
  let first = t.slice(0, -1).join(" "), last = t[t.length - 1] + suffix;
  if (last === last.toLowerCase()) last = last[0].toUpperCase() + last.slice(1);
  if (first === first.toLowerCase()) first = first[0].toUpperCase() + first.slice(1);
  return [first, last];
}
function dateStr(v) { if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); if (typeof v === "number") { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : ""; } return ""; }
function sheetRows(wb, preferName, mustHave) {
  const names = [preferName, ...wb.SheetNames.filter((n) => n !== preferName)].filter((n) => wb.Sheets[n]);
  for (const n of names) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, cellDates: true, defval: null });
    const hi = aoa.findIndex((r) => r && mustHave.every((m) => r.some((c) => String(c || "").trim().toLowerCase() === m.toLowerCase())));
    if (hi >= 0) { const hdr = aoa[hi].map((c) => String(c || "").trim()); return { sheet: n, hdr, rows: aoa.slice(hi + 1).filter((r) => r && r.some((c) => c != null && c !== "")).map((r) => Object.fromEntries(hdr.map((h, i) => [h, r[i]]))) }; }
  }
  return null;
}
function cleanCallLog(rows) {
  const out = [], seen = new Map(), stats = { emailFixed: 0, placeholderEmail: 0, placeholderName: 0, merged: 0 };
  for (const r of rows) {
    let email = String(r["Email"] || "").trim(); const issue = String(r["Email Issue"] || ""); let note = "";
    if (/^(placeholder|malformed)/i.test(issue)) {
      if (/^malformed/i.test(issue) && /\.com1$/.test(email)) { note = `Email corrected from ${email}`; email = email.slice(0, -1); stats.emailFixed++; }
      else { email = ""; stats.placeholderEmail++; }
    } else if (/^likely typo of @/i.test(issue)) { const dom = issue.split("@")[1].trim(); note = `Email corrected from ${email}`; email = email.split("@")[0] + "@" + dom; stats.emailFixed++; }
    const [first, last] = splitName(r["Contact Name"]); if (r["Contact Name"] && !first) stats.placeholderName++;
    const [office, mobile] = phones(r["Phone"]);
    const lc = dateStr(r["Last Call"]);
    const c = {
      first, last, company: tcCompany(r["Customer"]), email, office, mobile,
      category: TYPEMAP[r["Account Type"]] || r["Account Type"] || "Unassigned",
      branch: r["Branch"] || "", rep: r["Sales Rep"] || "",
      products: GROUPS.filter((g) => r[g]), topGroup: r["Top Opportunity Group"] || "",
      sfStatus: String(r["Storefront Status"] || "").split(":")[0], lastCall: lc,
      lastNote: String(r["Last Call Notes"] ?? r["Last Call Note"] ?? r["Last Call Summary"] ?? r["Call Notes"] ?? r["Notes"] ?? "").trim().slice(0, 1500), calls: +r["Calls Logged"] || 0,
      openQuotes: +r["Customer Open Quotes"] || 0, openQuoteUsd: Math.round(+r["Customer Open Quote $"] || 0), sfQuoteUsd: Math.round(+r["Customer Storefront Quote $"] || 0),
      met: "Call log import", notes: note, created: lc ? new Date(lc + "T12:00").getTime() : 0,
    };
    const key = (email || c.company + "|" + r["Contact Name"]).toLowerCase();
    const prev = seen.get(key);
    if (prev) { stats.merged++; if (c.calls > prev.calls) out[out.indexOf(prev)] = c, seen.set(key, c); continue; }
    seen.set(key, c); out.push(c);
  }
  return { contacts: out, stats };
}
let importPayload = null;
$("impFile").onchange = async (e) => {
  const f = e.target.files[0]; importPayload = null; $("impGo").disabled = true; $("impOut").hidden = true; if (!f) return;
  $("impPreview").textContent = "Reading…";
  try {
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    const found = sheetRows(wb, "All Contacts", ["Contact Name", "Email", "Customer", "Sales Rep"]);
    if (!found) { $("impPreview").textContent = "Couldn't find a tab with Contact Name, Email, Customer and Sales Rep columns."; return; }
    const { contacts, stats } = cleanCallLog(found.rows);
    importPayload = contacts;
    $("impPreview").textContent = `${contacts.length.toLocaleString()} contacts from the "${found.sheet}" tab. ${stats.emailFixed} emails fixed, ${stats.placeholderEmail} placeholder emails removed, ${stats.merged} duplicates merged.`;
    $("impGo").disabled = false;
  } catch (err) { $("impPreview").textContent = "That file couldn't be read. " + err.message; }
};
$("impGo").onclick = async () => {
  if (!importPayload) return; $("impGo").disabled = true; $("impPreview").textContent = "Importing…";
  try { const j = await api("import", { method: "POST", body: { contacts: importPayload } }); $("impOut").hidden = false; $("impOut").textContent = `Done. ${j.added.toLocaleString()} added, ${j.updated.toLocaleString()} updated, ${j.moved} moved to a new rep.${j.newReps ? ` ${j.newReps} reps added under Reps & codes. Create their codes there.` : ""}`; $("impPreview").textContent = ""; loadContacts(); }
  catch (err) { $("impPreview").textContent = err.message; $("impGo").disabled = false; }
};

/* ---------- import: ERP addresses ---------- */
let adrRows = null;
const ADR_FIELDS = [["company", /^(customer|customer name|name|account|bill.?to name|company)$/i], ["address", /(address|street|addr 1|address 1|line 1)/i], ["city", /^city/i], ["state", /^(state|st|province)/i], ["zip", /(zip|postal)/i]];
$("adrFile").onchange = async (e) => {
  const f = e.target.files[0]; adrRows = null; $("adrGo").disabled = true; $("adrOut").hidden = true; if (!f) return;
  try {
    const wb = XLSX.read(await f.arrayBuffer());
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });
    const hi = aoa.findIndex((r) => r.filter((c) => String(c).trim()).length >= 3);
    const hdr = aoa[hi].map((c) => String(c).trim());
    adrRows = { hdr, rows: aoa.slice(hi + 1) };
    $("adrMap").innerHTML = ADR_FIELDS.map(([k, re]) => { const guess = hdr.findIndex((h) => re.test(h)); return `<label style="display:grid;gap:2px;font-size:12px;color:var(--muted)">${k}<select data-k="${k}"><option value="-1">(none)</option>${hdr.map((h, i) => `<option value="${i}"${i === guess ? " selected" : ""}>${esc(h || "Column " + (i + 1))}</option>`).join("")}</select></label>`; }).join("");
    $("adrMap").hidden = false; $("adrGo").disabled = false;
  } catch (err) { toast("That file couldn't be read."); }
};
$("adrGo").onclick = async () => {
  const idx = {}; $("adrMap").querySelectorAll("select").forEach((s) => (idx[s.dataset.k] = +s.value));
  if (idx.company < 0 || idx.address < 0) { toast("Pick the customer name and street address columns."); return; }
  const rows = adrRows.rows.map((r) => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i >= 0 ? String(r[i] ?? "").trim() : ""]))).filter((r) => r.company && r.address);
  $("adrGo").disabled = true;
  try { const j = await api("import-addresses", { method: "POST", body: { rows } }); $("adrOut").hidden = false; $("adrOut").textContent = `Filled addresses for ${j.filled.toLocaleString()} contacts at ${j.companies.toLocaleString()} customers, from ${j.rows.toLocaleString()} rows.`; loadContacts(); }
  catch (err) { toast(err.message); }
  finally { $("adrGo").disabled = false; }
};

/* ---------- new contacts from the Call Log app ---------- */
async function loadSyncInfo() {
  try { const m = await api("sync-calllog"); $("syncInfo").textContent = m.at ? `Last pulled ${new Date(m.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}: ${m.added} new contact${m.added === 1 ? "" : "s"}.` : "Not pulled yet."; } catch {}
}
$("syncNow").onclick = async () => {
  $("syncNow").disabled = true; $("syncOut").hidden = false; $("syncOut").textContent = "Reading the Call Log app…";
  try {
    const j = await api("sync-calllog", { method: "POST", body: {} });
    const per = Object.entries(j.byRep || {}).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ");
    $("syncOut").textContent = j.added ? `Added ${j.added} new contact${j.added === 1 ? "" : "s"} from ${j.calls.toLocaleString()} logged calls. ${per}.` : `No new contacts. All ${j.people.toLocaleString()} people in ${j.calls.toLocaleString()} logged calls are already in Card File.`;
    loadSyncInfo(); if (j.added) loadContacts();
  } catch (err) { $("syncOut").textContent = "Couldn't reach the Call Log app. " + err.message; }
  finally { $("syncNow").disabled = false; }
};

/* ---------- recent calls from the Call Log app ---------- */
const callCache = {};
async function loadCalls(c) {
  const wrap = $("dCallsWrap"), box = $("dCalls"); wrap.hidden = true; box.innerHTML = "";
  try {
    const r = callCache[c.id] || (callCache[c.id] = await api(`contacts/${encodeURIComponent(c.id)}/calls?shard=${encodeURIComponent(c.shard)}`));
    if (current !== c) return;
    const all = [...r.calls, ...r.companyCalls];
    if (!all.length) return;
    box.innerHTML = all.map((x) => `<div class="call"><div class="meta"><span>${esc(fmtDate(x.date))}</span><span>${esc(x.rep)}</span>${x.contact ? `<span>with ${esc(x.contact)}</span>` : ""}${x.match === "company" ? `<span class="pill">At this company</span>` : ""}${x.opportunity ? `<span class="pill on">${esc(x.opportunity)}</span>` : ""}</div><div class="txt">${esc(x.notes)}</div></div>`).join("");
    wrap.hidden = false;
  } catch {}
}

/* ---------- my groups ---------- */
let addTarget = null, gdoc = { myEmail: "", groups: {} }, gLoaded = false, selecting = false, selected = new Set(), pickIds = [], openGroupId = null;
const MAIL_MAX = 1800; // Outlook on Windows drops mailto links much past 2,000 characters
async function loadGroups() { try { gdoc = await api("groups"); gdoc.groups = gdoc.groups || {}; gLoaded = true; renderGroups(); } catch {} }
async function saveGroups(msg) {
  try { gdoc = await api("groups", { method: "PUT", body: gdoc }); if (msg) toast(msg); }
  catch (err) { toast(err.message); loadGroups(); }
  renderGroups(); if (current && !$("detail").hidden) renderDetailGroups(current);
}
const gList = () => Object.entries(gdoc.groups || {}).map(([id, g]) => ({ id, ...g })).sort((a, b) => a.name.localeCompare(b.name));
const byId = (id) => cards.find((c) => c.id === id);
function groupMembers(g) { return (g.members || []).map(byId).filter(Boolean); }
function newGroup(name) {
  name = String(name || "").trim(); if (!name) { toast("Name the group first."); return null; }
  const hit = gList().find((g) => g.name.toLowerCase() === name.toLowerCase()); if (hit) return hit.id;
  const id = "g-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  gdoc.groups[id] = { name, members: [], created: Date.now() }; return id;
}
function renderGroups() {
  const gs = gList();
  $("groupEmpty").hidden = gs.length > 0;
  $("groupList").innerHTML = gs.map((g) => { const m = groupMembers(g), em = m.filter((c) => c.email && c.status !== "left").length; return `<li><button class="grow" type="button" data-g="${esc(g.id)}"><span><div class="gn">${esc(g.name)}</div><div class="gc">${m.length} contact${m.length === 1 ? "" : "s"} · ${em} with email</div></span><span class="tag">Open</span></button></li>`; }).join("");
}
$("groupList").addEventListener("click", (e) => { const b = e.target.closest("[data-g]"); if (b) openGroup(b.dataset.g); });
$("newGroupBtn").onclick = async () => { const id = newGroup($("newGroupName").value); if (!id) return; $("newGroupName").value = ""; await saveGroups("Group created. Add people from Contacts."); openGroup(id); };

// select mode on the contact list
function updateSelbar() {
  $("selCount").textContent = `${selected.size} selected`; $("selAdd").disabled = !selected.size;
  const adm = me && me.role === "admin";
  ["selMove", "selDel"].forEach((id) => { $(id).hidden = !adm; $(id).disabled = !selected.size; });
  $("selDelConfirm").hidden = true;
}
function startSelect() { selecting = true; selected.clear(); $("bar").querySelector(".wrap").hidden = true; $("selbar").hidden = false; $("selectBtn").textContent = "Done"; updateSelbar(); renderList(); }
function endSelect() { addTarget = null; $("selAdd").textContent = "Add to group"; if (!selecting) return; selecting = false; selected.clear(); $("bar").querySelector(".wrap").hidden = false; $("selbar").hidden = true; $("selectBtn").textContent = "Select"; renderList(); }
$("selectBtn").onclick = () => (selecting ? endSelect() : startSelect());
$("selDone").onclick = endSelect;
// Manager: move or delete everything selected
const selItems = () => [...selected].map(byId).filter(Boolean).map((c) => ({ id: c.id, shard: c.shard }));
$("selMove").onclick = () => {
  $("rpickNote").textContent = `Moving ${selected.size} contact${selected.size === 1 ? "" : "s"}. The move sticks: later call log imports won't move them back.`;
  const opts = [{ name: "", label: "Unassigned (only managers see these)" }, ...reps.map((r) => ({ name: r.name, label: r.name + (r.branch ? " · " + r.branch : "") }))];
  $("rpickList").innerHTML = opts.map((o) => `<li><button class="grow" type="button" data-rep="${esc(o.name)}"><span><div class="gn">${esc(o.label)}</div></span><span class="tag">Move</span></button></li>`).join("");
  raise($("rpick"));
};
$("rpickCancel").onclick = () => closeSheet("rpick");
$("rpickList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-rep]"); if (!b) return;
  const rep = b.dataset.rep; b.disabled = true;
  try { const j = await api("bulk", { method: "POST", body: { action: "move", rep, items: selItems() } }); closeSheet("rpick"); endSelect(); toast(`${j.done} moved to ${rep || "Unassigned"}`); loadContacts(); }
  catch (err) { b.disabled = false; toast(err.message); }
});
$("selDel").onclick = () => { $("selDelText").textContent = `Delete ${selected.size} contact${selected.size === 1 ? "" : "s"} for good? This can't be undone. A later call log import adds back any that are still in the call log.`; $("selDelConfirm").hidden = false; };
$("selDelNo").onclick = () => ($("selDelConfirm").hidden = true);
$("selDelYes").onclick = async () => {
  try { const j = await api("bulk", { method: "POST", body: { action: "delete", items: selItems() } }); endSelect(); toast(`${j.done} deleted`); loadContacts(); }
  catch (err) { toast(err.message); }
};
$("selAll").onclick = () => { visible().filter((c) => c.status !== "left").forEach((c) => selected.add(c.id)); updateSelbar(); renderList(); };
$("selAdd").onclick = () => { if (addTarget && gdoc.groups[addTarget]) { const g = addTarget; pickIds = [...selected]; addTo(g).then(() => openGroup(g)); } else openPicker([...selected], `${selected.size} contact${selected.size === 1 ? "" : "s"}`); };

// group picker
function openPicker(ids, label) {
  pickIds = ids; if (!ids.length) { toast("Nothing to add."); return; }
  $("gpickNote").textContent = `Adding ${label}. Pick a group.`;
  const gs = gList();
  $("gpickList").innerHTML = gs.length ? gs.map((g) => { const have = ids.filter((id) => (g.members || []).includes(id)).length; return `<li><button class="grow" type="button" data-g="${esc(g.id)}"><span><div class="gn">${esc(g.name)}</div><div class="gc">${(g.members || []).length} contacts${have ? ` · ${have === ids.length ? "already in" : have + " already in"}` : ""}</div></span><span class="tag">Add</span></button></li>`; }).join("") : `<li style="color:var(--muted);font-size:14px">No groups yet. Name your first one below.</li>`;
  $("gpickNew").value = ""; raise($("gpick"));
}
async function addTo(id) {
  const g = gdoc.groups[id]; const before = g.members.length;
  g.members = [...new Set([...g.members, ...pickIds])];
  closeSheet("gpick"); endSelect();
  await saveGroups(`${g.members.length - before} added to ${g.name}`);
  if (!$("gview").hidden) renderGroupView();
}
$("gpickList").addEventListener("click", (e) => { const b = e.target.closest("[data-g]"); if (b) addTo(b.dataset.g); });
$("gpickCreate").onclick = () => { const id = newGroup($("gpickNew").value); if (id) addTo(id); };
$("gpickCancel").onclick = () => closeSheet("gpick");

// groups on a contact's page
function renderDetailGroups(c) {
  const ins = gList().filter((g) => (g.members || []).includes(c.id));
  $("dGroups").innerHTML = ins.map((g) => `<button class="gchip" type="button" data-g="${esc(g.id)}">${esc(g.name)}</button>`).join("") + `<button class="gchip add" type="button" id="dAddGroup">+ Add to group</button>`;
}
$("dGroups").addEventListener("click", (e) => {
  if (e.target.closest("#dAddGroup")) return openPicker([current.id], fullName(current));
  const b = e.target.closest("[data-g]"); if (b) { closeSheet("detail"); openGroup(b.dataset.g); }
});

// one group
function openGroup(id) { openGroupId = id; $("gvDelConfirm").hidden = true; $("myEmail").value = gdoc.myEmail || ""; $("gvSubject").value = gdoc.groups[id].name; renderGroupView(); raise($("gview")); }
function groupBatches(to, addrs, subject) {
  const base = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&bcc=`;
  const out = []; let cur = [];
  for (const a of addrs) { const next = [...cur, a]; if (cur.length && (base + next.map(encodeURIComponent).join(",")).length > MAIL_MAX) { out.push(cur); cur = [a]; } else cur = next; }
  if (cur.length) out.push(cur);
  return out.map((b) => ({ list: b, href: base + b.map(encodeURIComponent).join(",") }));
}
let gvAddrs = [];
function renderGroupView() {
  const g = gdoc.groups[openGroupId]; if (!g) return closeSheet("gview");
  const m = groupMembers(g).sort((a, b) => (a.company || "").localeCompare(b.company || "") || personName(a).localeCompare(personName(b)));
  const missing = (g.members || []).length - m.length;
  const seen = new Set(); gvAddrs = [];
  m.forEach((c) => { const e = (c.email || "").trim(); if (e && c.status !== "left" && !seen.has(e.toLowerCase())) { seen.add(e.toLowerCase()); gvAddrs.push(e); } });
  $("gvName").textContent = g.name; $("gvRename").value = g.name;
  $("gvCount").textContent = `${m.length} contact${m.length === 1 ? "" : "s"} · ${gvAddrs.length} email address${gvAddrs.length === 1 ? "" : "es"}${missing ? ` · ${missing} no longer in your list` : ""}`;
  const to = $("myEmail").value.trim(), subj = $("gvSubject").value.trim() || g.name;
  const batches = gvAddrs.length ? groupBatches(to, gvAddrs, subj) : [];
  $("gvMail").innerHTML = !gvAddrs.length ? "" : batches.map((b, i) => `<a class="btn sm${i === 0 ? " primary" : ""}" href="${esc(b.href)}" style="flex:none">${batches.length > 1 ? `Open email ${i + 1} of ${batches.length} (${b.list.length})` : `Open in Outlook (${b.list.length} in BCC)`}</a>`).join("") + `<button class="btn sm" type="button" id="gvCopy">Copy BCC list</button>`;
  $("gvMailNote").textContent = !gvAddrs.length ? "Nobody in this group has an email address yet." : (batches.length > 1 ? `Outlook can't take this many addresses in one link, so it opens ${batches.length} emails. Send the same attachment on each, or use Copy BCC list and paste into one email's BCC line. ` : "") + (to ? "" : "Add your email above so it fills the To line.");
  $("gvList").innerHTML = m.map((c) => `<li class="mrow"><button class="row${c.status === "left" ? " left" : ""}" type="button" data-id="${esc(c.id)}" style="grid-template-columns:1fr"><span class="who"><div class="name">${esc(c.company || personName(c))}</div><div class="co2">${esc(c.company ? personName(c) || "No contact name" : c.title || "")}</div><div class="ph">${c.email ? esc(c.email) : `<span class="noemail">No email</span>`}${c.status === "left" ? ` · <span class="noemail">Left company</span>` : ""}</div></span></button><button class="x" type="button" data-rm="${esc(c.id)}">Remove</button></li>`).join("") || `<li style="color:var(--muted);font-size:14px">No one in this group yet. Tap Add people.</li>`;
}
$("gvMail").addEventListener("click", (e) => { if (e.target.closest("#gvCopy")) copy(gvAddrs.join("; "), "BCC list"); });
$("gvList").addEventListener("click", async (e) => {
  const rm = e.target.closest("[data-rm]");
  if (rm) { const g = gdoc.groups[openGroupId]; g.members = g.members.filter((x) => x !== rm.dataset.rm); renderGroupView(); await saveGroups("Removed from group"); return; }
  const b = e.target.closest(".row"); if (b) openDetail(b.dataset.id);
});
$("myEmail").addEventListener("change", () => { gdoc.myEmail = $("myEmail").value.trim(); renderGroupView(); saveGroups(); });
$("myEmail").addEventListener("input", renderGroupView);
$("gvSubject").addEventListener("input", renderGroupView);
$("gvBack").onclick = () => { closeSheet("gview"); renderGroups(); };
$("gvAdd").onclick = () => { const id = openGroupId; closeSheets(); showTab("contacts"); startSelect(); addTarget = id; $("selAdd").textContent = `Add to ${gdoc.groups[id].name}`; toast("Search or filter, tap people, then tap Add."); };
$("gvRenameBtn").onclick = () => { const n = $("gvRename").value.trim(); if (!n) return; gdoc.groups[openGroupId].name = n; renderGroupView(); saveGroups("Group renamed"); };
$("gvDel").onclick = () => ($("gvDelConfirm").hidden = false);
$("gvDelNo").onclick = () => ($("gvDelConfirm").hidden = true);
$("gvDelYes").onclick = async () => { const n = gdoc.groups[openGroupId].name; delete gdoc.groups[openGroupId]; closeSheet("gview"); await saveGroups(`${n} deleted`); };

/* ---------- boot ---------- */
(async () => {
  // Signed in from the Sales Hub: the hub passes the Call Log code as #ac=... once.
  const hub = /[#&]ac=([^&]+)/.exec(location.hash || "");
  if (hub) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
    try { const j = await api("login", { method: "POST", body: { code: decodeURIComponent(hub[1]) } }); token = j.token; lsSet(TOKEN_KEY, token); return start(j.user); } catch {}
  }
  token = lsGet(TOKEN_KEY);
  if (!token) return showLogin();
  try { const { user } = await api("me"); start(user); } catch { if (!me) showLogin(); }
})();
