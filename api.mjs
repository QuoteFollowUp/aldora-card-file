// Aldora Card File API. One function, routed by path. Data lives in Netlify Blobs.
//
// Store "cardfile" keys:
//   users              {users: {slug: {name, role, branch, active, codeHash, ver, created}}}
//   shard/<repSlug>    {contacts: {id: contact}}   one shard per rep, plus shard/_unassigned
//   photo/<shard>/<id> card photo as a data URL
//   log/<ms>-<rand>    one change-log entry
//   meta               {lastImport, ...}
//
// Access is enforced here, never in the browser:
//   admin  (MANAGER_CODE)  everything
//   branch (branch mgr)    contacts whose branch matches theirs, read and edit
//   rep                    their own shard only
//   Shared Call Log codes (REP_ACCESS_CODES, team-level Netlify variable) also sign in:
//     rep -> their Card File record; branch manager -> their branch; ownership / Fred -> every
//     contact, edit like a branch manager (no import, codes or delete); view-only -> read only.
//   A person turned off in Reps & codes stays out even with their Call Log code.

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { whoIs as sharedWho, listIsSet, codeMap, canonBranch, REP_BRANCH } from "../lib/access.mjs";

export const config = { path: "/api/*" };

const STORE = "cardfile";
const UNASSIGNED = "_unassigned";
const TOKEN_DAYS = 60;
const EDITABLE = ["first", "last", "title", "company", "email", "mobile", "office", "website", "address", "city", "state", "zip", "category", "followUp", "met", "notes"];
const ADMIN_ONLY = ["rep", "branch"];
const LISTS = ["phones", "addresses"];
// Extra phones: [{label, number}]. Extra addresses: [{label, address, city, state, zip}].
function cleanList(k, v) {
  if (!Array.isArray(v)) return [];
  const t = (x, n) => String(x ?? "").trim().slice(0, n);
  if (k === "phones") return v.slice(0, 10).map((p) => ({ label: t(p.label, 40), number: t(p.number, 40) })).filter((p) => p.number);
  return v.slice(0, 10).map((a) => ({ label: t(a.label, 40), address: t(a.address, 200), city: t(a.city, 80), state: t(a.state, 20).toUpperCase(), zip: t(a.zip, 12) })).filter((a) => a.address || a.city);
}
const REP_ALIASES = { "jim wanamaker": "Jim Wannamaker" };

const store = () => getStore({ name: STORE, consistency: "strong" });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status, message) => json(status, { error: message });
const slugify = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || UNASSIGNED;
const canonRep = (name) => { const n = String(name || "").trim().replace(/\s+/g, " "); return REP_ALIASES[n.toLowerCase()] || n; };
const now = () => Date.now();
const rid = (n = 6) => crypto.randomBytes(n).toString("hex");

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  return crypto.createHash("sha256").update("cardfile:" + (process.env.MANAGER_CODE || "")).digest("hex");
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return body + "." + mac;
}
function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const want = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > now() ? p : null; } catch { return null; }
}
const codeHash = (code) => crypto.createHmac("sha256", secret()).update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
// ---------- shared Call Log codes ----------
const looseKey = (s) => String(canonRep(s) || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");
const isOff = (u) => !!u && (u.off || (u.codeHash && !u.active));
const sharedHash = (code) => crypto.createHmac("sha256", secret()).update("shared:" + String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
// A shared sign-in stays valid only while that code is still on the shared list for the same person.
function sharedStillValid(t) {
  for (const k of Object.keys(codeMap())) if (sharedHash(k) === t.ch) { const w = sharedWho(k); return !!w && w.name === t.sn; }
  return false;
}
async function sharedLogin(code) {
  if (!listIsSet()) return null;
  const s = sharedWho(code);
  if (!s || s.role === "team") return null;
  const base = { shared: true, ch: sharedHash(code), sn: s.name, name: s.name, exp: now() + TOKEN_DAYS * 864e5 };
  if (s.role === "all") {
    const user = { role: "branch", name: s.name, slug: "all-" + slugify(s.name), branch: "*", ro: !!s.readOnly };
    return { token: sign({ ...base, ...user }), user };
  }
  let slug, out;
  await mutate("users", { users: {} }, (d) => {
    const want = s.role === "rep" ? "rep" : "branch";
    const hit = Object.entries(d.users).find(([, u]) => u.role === want && looseKey(u.name) === looseKey(s.name) && (want === "rep" || canonBranch(u.branch) === s.branch));
    if (hit) { [slug] = hit; if (isOff(hit[1])) { out = "off"; return; } }
    else {
      slug = want === "rep" ? slugify(canonRep(s.name)) : "bm-" + slugify(s.name);
      d.users[slug] = { name: canonRep(s.name), role: want, branch: want === "rep" ? (REP_BRANCH[s.rep] || "") : s.branch, active: false, ver: 0, created: now() };
    }
    const u = d.users[slug];
    out = { role: u.role, name: u.name, slug, branch: u.branch || "" };
  });
  if (!out || out === "off") return out || null;
  return { token: sign({ ...base, ...out }), user: out };
}

function newCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = "";
  for (const b of crypto.randomBytes(8)) s += A[b % A.length];
  return s.slice(0, 4) + "-" + s.slice(4);
}

// ---------- blob helpers ----------
async function getJSON(key, fallback) { const v = await store().get(key, { type: "json" }); return v ?? fallback; }
// Read-modify-write with an etag check, retried on conflict.
async function mutate(key, fallback, fn) {
  const s = store();
  for (let i = 0; i < 5; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const data = cur ? cur.data : structuredClone(fallback);
    const result = await fn(data);
    const opts = cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const w = await s.setJSON(key, data, opts);
    if (w.modified !== false) return result;
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
  }
  throw new Error("Busy. Try again.");
}
const getUsers = () => getJSON("users", { users: {} });
async function listShards() {
  const { blobs } = await store().list({ prefix: "shard/" });
  return blobs.map((b) => b.key.slice(6));
}
async function loadShards(slugs) {
  const out = {};
  await Promise.all(slugs.map(async (s) => { out[s] = (await getJSON("shard/" + s, { contacts: {} })).contacts || {}; }));
  return out;
}
async function writeLog(entry) {
  await store().setJSON(`log/${String(now()).padStart(14, "0")}-${rid(3)}`, { ts: now(), ...entry });
}
function publicUser(slug, u) { return { slug, name: u.name, role: u.role, branch: u.branch || "", active: !!u.active, hasCode: !!u.codeHash, created: u.created || 0 }; }

// ---------- auth ----------
async function auth(req) {
  const t = verify((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  if (!t) return null;
  if (t.role === "admin") return t;
  if (t.shared) {
    if (!sharedStillValid(t)) return null;
    if (t.branch === "*") return t;
    const { users } = await getUsers();
    const u = users[t.slug];
    if (!u || isOff(u)) return null;
    return { ...t, name: u.name, branch: u.branch || t.branch || "", role: u.role };
  }
  const { users } = await getUsers();
  const u = users[t.slug];
  if (!u || !u.active || u.ver !== t.ver) return null;
  return { ...t, name: u.name, branch: u.branch || "", role: u.role };
}
function canSee(user, shard, contact) {
  if (user.role === "admin") return true;
  if (user.role === "rep") return shard === user.slug;
  if (user.role === "branch") return user.branch === "*" || (!!contact && (contact.branch === user.branch || canonBranch(contact.branch) === canonBranch(user.branch)));
  return false;
}

// ---------- contact helpers ----------
function clean(c) { const o = { ...c }; delete o.photo; return o; }
const fmtList = (k, v) => (v || []).map((x) => k === "phones" ? `${x.label ? x.label + ": " : ""}${x.number}` : `${x.label ? x.label + ": " : ""}${[x.address, x.city, x.state, x.zip].filter(Boolean).join(", ")}`).join("; ");
function diff(a, b, keys) { const d = {}; for (const k of keys) { if (LISTS.includes(k)) { const x = fmtList(k, a[k]), y = fmtList(k, b[k]); if (x !== y) d[k] = [x, y]; continue; } const x = a[k] ?? "", y = b[k] ?? ""; if (String(x) !== String(y)) d[k] = [x, y]; } return d; }
async function savePhoto(shard, id, dataUrl) {
  if (!dataUrl) return false;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl) || dataUrl.length > 600000) throw new Error("Photo format not accepted.");
  await store().set(`photo/${shard}/${id}`, dataUrl);
  return true;
}
async function findContact(user, id, shardHint) {
  const slugs = user.role === "rep" ? [user.slug] : shardHint ? [shardHint] : await listShards();
  const shards = await loadShards(slugs);
  for (const s of slugs) if (shards[s][id]) return { shard: s, contact: shards[s][id] };
  if (shardHint && user.role !== "rep") return findContact(user, id, null);
  return null;
}

// ---------- Claude ----------
async function claude({ model, max_tokens, content }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("Card reading isn't set up yet. Add ANTHROPIC_API_KEY in Netlify."), { status: 503 });
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 24000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ac.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens, messages: [{ role: "user", content }] }),
    });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j?.error?.message || "Claude request failed."), { status: 502 });
    const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw Object.assign(new Error("Couldn't read a result. Try again."), { status: 502 });
    return JSON.parse(m[0]);
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("That took too long. Try again."), { status: 504 });
    throw e;
  } finally { clearTimeout(t); }
}
const CATS = ["Commercial Glazier", "Glazier / Glass Shop", "Mom-Pop Shop", "Shower Door Company", "Specialty Company", "Dealer / Distributor", "Franchised Glass Company", "General Contractor / Builder", "Architect / Designer", "Insulation Company", "Other"];

// ---------- routes ----------
export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const body = method === "GET" || method === "DELETE" ? {} : await req.json().catch(() => ({}));

  try {
    // ---- login (no auth) ----
    if (parts[0] === "login" && method === "POST") {
      const code = String(body.code || "").trim();
      if (!code) return err(400, "Enter your access code.");
      const mgr = process.env.MANAGER_CODE;
      if (mgr && code.toUpperCase().replace(/[^A-Z0-9]/g, "") === mgr.toUpperCase().replace(/[^A-Z0-9]/g, "")) {
        const user = { role: "admin", name: "Manager", slug: "admin", branch: "" };
        return json(200, { token: sign({ ...user, exp: now() + TOKEN_DAYS * 864e5 }), user });
      }
      const h = codeHash(code);
      const { users } = await getUsers();
      const hit = Object.entries(users).find(([, u]) => u.active && u.codeHash === h);
      if (!hit) {
        const sh = await sharedLogin(code);
        if (sh === "off") return err(401, "Your Card File access is turned off. Check with your manager.");
        if (sh) return json(200, sh);
        await new Promise((r) => setTimeout(r, 700)); return err(401, "That code didn't work. Check it with your manager.");
      }
      const [slug, u] = hit;
      const user = { role: u.role, name: u.name, slug, branch: u.branch || "" };
      return json(200, { token: sign({ ...user, ver: u.ver, exp: now() + TOKEN_DAYS * 864e5 }), user });
    }

    const user = await auth(req);
    if (!user) return err(401, "Your session ended. Sign in again.");
    const isAdmin = user.role === "admin";
    if (user.ro && method !== "GET") return err(403, "This code can view contacts but not change them.");

    // ---- me ----
    if (parts[0] === "me") return json(200, { user: { role: user.role, name: user.name, slug: user.slug, branch: user.branch || "" } });

    // ---- contacts ----
    if (parts[0] === "contacts" && !parts[1] && method === "GET") {
      const slugs = user.role === "rep" ? [user.slug] : await listShards();
      const shards = await loadShards(slugs);
      const list = [];
      for (const s of slugs) for (const [id, c] of Object.entries(shards[s])) if (canSee(user, s, c)) list.push({ id, shard: s, ...c });
      let reps = [];
      if (user.role !== "rep") { const { users } = await getUsers(); reps = Object.entries(users).filter(([, u]) => u.role === "rep").map(([slug, u]) => ({ slug, name: u.name, branch: u.branch || "" })).sort((a, b) => a.name.localeCompare(b.name)); }
      return json(200, { contacts: list, reps });
    }

    if (parts[0] === "contacts" && !parts[1] && method === "POST") {
      const c = {}; for (const k of EDITABLE) c[k] = String(body.contact?.[k] ?? "").trim().slice(0, 2000);
      for (const k of LISTS) c[k] = cleanList(k, body.contact?.[k]);
      if (!c.first && !c.last && !c.company) return err(400, "Add a name or a company.");
      let shard, rep, branch;
      if (user.role === "rep") { shard = user.slug; rep = user.name; branch = String(body.contact?.branch || user.branch || ""); }
      else {
        rep = canonRep(body.contact?.rep); shard = rep ? slugify(rep) : UNASSIGNED;
        branch = String(body.contact?.branch || "");
        if (user.role === "branch" && user.branch !== "*") branch = user.branch;
      }
      const id = "c-" + rid(6);
      const hasPhoto = await savePhoto(shard, id, body.contact?.photo);
      const rec = { ...c, rep, branch, hasPhoto, status: "", created: now(), updated: now(), createdBy: user.name, editedFields: [] };
      await mutate("shard/" + shard, { contacts: {} }, (d) => { d.contacts[id] = rec; });
      await writeLog({ by: user.name, role: user.role, action: "added", id, shard, contact: [c.first, c.last].filter(Boolean).join(" ") || c.company, company: c.company, branch, rep });
      return json(200, { contact: { id, shard, ...rec } });
    }

    if (parts[0] === "contacts" && parts[1]) {
      const id = parts[1], action = parts[2] || "";
      const found = await findContact(user, id, body.shard || url.searchParams.get("shard"));
      if (!found || !canSee(user, found.shard, found.contact)) return err(404, "Contact not found.");
      const { shard } = found;

      if (method === "PUT" && !action) {
        const patch = body.patch || {};
        let out, moved = null, changes = {};
        const target = isAdmin && patch.rep !== undefined ? (canonRep(patch.rep) ? slugify(canonRep(patch.rep)) : UNASSIGNED) : shard;
        const photo = patch.photo;
        await mutate("shard/" + shard, { contacts: {} }, (d) => {
          const cur = d.contacts[id]; if (!cur) throw Object.assign(new Error("Contact not found."), { status: 404 });
          const next = { ...cur };
          for (const k of EDITABLE) if (patch[k] !== undefined) next[k] = String(patch[k]).trim().slice(0, 2000);
          for (const k of LISTS) if (patch[k] !== undefined) next[k] = cleanList(k, patch[k]);
          if (isAdmin) for (const k of ADMIN_ONLY) if (patch[k] !== undefined) next[k] = k === "rep" ? canonRep(patch[k]) : String(patch[k]).trim();
          changes = diff(cur, next, [...EDITABLE, ...LISTS, ...ADMIN_ONLY]);
          next.editedFields = [...new Set([...(cur.editedFields || []), ...Object.keys(changes).filter((k) => !ADMIN_ONLY.includes(k))])];
          next.updated = now(); next.updatedBy = user.name;
          out = next;
          if (target !== shard) { delete d.contacts[id]; moved = target; } else d.contacts[id] = next;
        });
        const finalShard = moved || shard;
        if (moved) await mutate("shard/" + moved, { contacts: {} }, (d) => { d.contacts[id] = out; });
        if (photo) {
          if (moved) await store().delete(`photo/${shard}/${id}`);
          out.hasPhoto = await savePhoto(finalShard, id, photo);
          await mutate("shard/" + finalShard, { contacts: {} }, (d) => { if (d.contacts[id]) d.contacts[id].hasPhoto = true; });
          changes.photo = ["", "card photo added"];
        } else if (moved && out.hasPhoto) {
          const p = await store().get(`photo/${shard}/${id}`); if (p) { await store().set(`photo/${moved}/${id}`, p); await store().delete(`photo/${shard}/${id}`); }
        }
        if (Object.keys(changes).length) await writeLog({ by: user.name, role: user.role, action: moved ? "reassigned" : "updated", id, shard: finalShard, contact: [out.first, out.last].filter(Boolean).join(" ") || out.company, company: out.company, branch: out.branch, rep: out.rep, changes });
        return json(200, { contact: { id, shard: finalShard, ...out } });
      }

      if (method === "POST" && (action === "left" || action === "restore")) {
        let out;
        await mutate("shard/" + shard, { contacts: {} }, (d) => {
          const c = d.contacts[id];
          if (action === "left") { c.status = "left"; c.leftDate = new Date().toISOString().slice(0, 10); c.replacedBy = String(body.replacedBy || "").trim().slice(0, 200); }
          else { c.status = ""; c.leftDate = ""; c.replacedBy = ""; }
          c.updated = now(); c.updatedBy = user.name; out = c;
        });
        await writeLog({ by: user.name, role: user.role, action: action === "left" ? "left company" : "restored", id, shard, contact: [out.first, out.last].filter(Boolean).join(" ") || out.company, company: out.company, branch: out.branch, rep: out.rep, replacedBy: out.replacedBy || "" });
        return json(200, { contact: { id, shard, ...out } });
      }

      if (method === "GET" && action === "photo") {
        const p = await store().get(`photo/${shard}/${id}`);
        return p ? json(200, { photo: p }) : err(404, "No photo.");
      }

      if (method === "DELETE" && !action) {
        if (!isAdmin) return err(403, "Only the manager can delete contacts. Use Left company instead.");
        const c = found.contact;
        await mutate("shard/" + shard, { contacts: {} }, (d) => { delete d.contacts[id]; });
        await store().delete(`photo/${shard}/${id}`);
        await writeLog({ by: user.name, role: user.role, action: "deleted", id, shard, contact: [c.first, c.last].filter(Boolean).join(" ") || c.company, company: c.company, branch: c.branch, rep: c.rep });
        return json(200, { ok: true });
      }
      return err(404, "Not found.");
    }

    // ---- Claude: read a card ----
    if (parts[0] === "scan" && method === "POST") {
      const img = String(body.image || "");
      const m = img.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!m || img.length > 3_000_000) return err(400, "Send a JPEG or PNG photo.");
      const out = await claude({
        model: process.env.CLAUDE_SCAN_MODEL || "claude-haiku-5-5", max_tokens: 600,
        content: [
          { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
          { type: "text", text: `This photo is a business card handed to a commercial glass and aluminum (storefront, entrances, curtain wall) salesperson. Read it and return ONLY a JSON object with these string keys: first, last, title, company, email, mobile, office, website, address, city, state, zip, category.
Rules: copy text exactly as printed. If a phone is marked cell, mobile, M or C put it in mobile; office, O, T, P, main or direct goes in office; one unlabeled phone goes in office. Format US phones as (xxx) xxx-xxxx and keep any extension as " x123". state = 2-letter US abbreviation. address = street line only. category = best guess from exactly one of: ${CATS.join(", ")}. Use "" for anything not on the card. No commentary.` },
        ],
      });
      return json(200, { fields: out });
    }

    // ---- Claude: draft a follow-up ----
    if (parts[0] === "draft" && method === "POST") {
      const c = body.contact || {};
      const sf = c.sfStatus === "GAP" ? "has storefront opportunity but no storefront quotes with us" : c.sfStatus === "ADD" ? "we are quoting them storefront" : c.sfStatus === "Aligned" ? "active storefront quoting" : "";
      const sender = isAdmin ? "Fred Haas, Corporate Commercial Metal Manager" : `${user.name}, Aldora sales`;
      const out = await claude({
        model: process.env.CLAUDE_DRAFT_MODEL || "claude-sonnet-5-5", max_tokens: 700,
        content: [{ type: "text", text: `Write a short follow-up email from ${sender} at Aldora Aluminum & Glass Products (commercial storefront, entrances, aluminum framing and glass; fabrication branches across the South and Mid-Atlantic) to this contact.
Contact: ${JSON.stringify({ name: [c.first, c.last].filter(Boolean).join(" "), title: c.title, company: c.company, accountType: c.category, branch: c.branch, aldoraRep: isAdmin ? c.rep : "", products: c.products, storefrontStatus: sf, met: c.met && !String(c.met).startsWith("Call log") ? c.met : "", notes: c.notes })}
Style: plain, direct, short sentences. 60 to 110 words. No em dashes. No filler words like leverage, synergy, robust, seamless. Reference where they met or the notes if given. If they have a storefront gap, invite them to send their next storefront or entrance takeoff for pricing. If an Aldora rep is named, say that rep stays their day-to-day contact. End with one concrete next step. Sign off with the sender's name, then "Aldora Aluminum & Glass Products".
Return ONLY JSON: {"subject": "...", "body": "..."}` }],
      });
      return json(200, out);
    }

    // ---- change log (admin and branch) ----
    if (parts[0] === "changes" && method === "GET") {
      if (user.role === "rep") return err(403, "Not available.");
      const days = Math.min(365, Math.max(1, +url.searchParams.get("days") || 30));
      const since = String(now() - days * 864e5).padStart(14, "0");
      const { blobs } = await store().list({ prefix: "log/" });
      const keys = blobs.map((b) => b.key).filter((k) => k.slice(4, 18) >= since).sort().reverse().slice(0, 1500);
      const entries = (await Promise.all(keys.map((k) => getJSON(k, null)))).filter(Boolean);
      return json(200, { changes: user.role === "branch" && user.branch !== "*" ? entries.filter((e) => e.branch === user.branch || canonBranch(e.branch) === canonBranch(user.branch)) : entries });
    }

    // ---------- admin only below ----------
    if (!isAdmin) return err(403, "Manager access only.");

    if (parts[0] === "users" && method === "GET") {
      const { users } = await getUsers();
      const shards = await loadShards(await listShards());
      const counts = {}; for (const [s, cs] of Object.entries(shards)) counts[s] = Object.keys(cs).length;
      return json(200, { users: Object.entries(users).map(([s, u]) => ({ ...publicUser(s, u), contacts: counts[s] || 0 })).sort((a, b) => a.name.localeCompare(b.name)), unassigned: counts[UNASSIGNED] || 0 });
    }
    if (parts[0] === "users" && !parts[1] && method === "POST") {
      const name = canonRep(body.name); const role = body.role === "branch" ? "branch" : "rep";
      if (!name) return err(400, "Enter a name.");
      const slug = role === "branch" ? "bm-" + slugify(name) : slugify(name);
      if (role === "branch" && !body.branch) return err(400, "Pick the branch this manager runs.");
      await mutate("users", { users: {} }, (d) => { const u = d.users[slug] || { created: now(), active: false, ver: 0 }; d.users[slug] = { ...u, name, role, branch: String(body.branch || u.branch || "") }; });
      return json(200, { slug });
    }
    if (parts[0] === "users" && parts[1] && method === "POST") {
      const slug = parts[1], act = parts[2];
      let code = null;
      await mutate("users", { users: {} }, (d) => {
        const u = d.users[slug]; if (!u) throw Object.assign(new Error("Person not found."), { status: 404 });
        if (act === "code") { code = newCode(); u.codeHash = codeHash(code); u.ver = (u.ver || 0) + 1; u.active = true; u.off = false; }
        else if (act === "deactivate") { u.active = false; u.off = true; u.ver = (u.ver || 0) + 1; }
        else if (act === "branch") { u.branch = String(body.branch || ""); }
        else throw Object.assign(new Error("Unknown action."), { status: 400 });
      });
      return json(200, { ok: true, code });
    }

    // ---- call log import: merge, never wipe rep edits ----
    if (parts[0] === "import" && method === "POST") {
      const incoming = Array.isArray(body.contacts) ? body.contacts : [];
      if (!incoming.length) return err(400, "No contacts in that file.");
      const slugs = await listShards(); const shards = await loadShards(slugs);
      const keyOf = (c) => (c.email ? c.email.toLowerCase() : ((c.company || "") + "|" + (c.first || "") + " " + (c.last || "")).toLowerCase());
      const index = {};
      for (const [s, cs] of Object.entries(shards)) for (const [id, c] of Object.entries(cs)) index[keyOf(c)] = { s, id };
      const LOG_FIELDS = ["products", "topGroup", "sfStatus", "lastCall", "calls", "openQuotes", "openQuoteUsd", "sfQuoteUsd"];
      const SOFT = ["first", "last", "company", "email", "office", "mobile", "category"];
      const dirty = new Set(); let added = 0, updated = 0, movedN = 0; const moves = []; const repBranches = {};
      for (const raw of incoming) {
        const rep = canonRep(raw.rep); const target = rep ? slugify(rep) : UNASSIGNED;
        if (rep) { repBranches[rep] = repBranches[rep] || {}; repBranches[rep][raw.branch || ""] = (repBranches[rep][raw.branch || ""] || 0) + 1; }
        const k = keyOf(raw); const hit = index[k];
        if (hit) {
          const cur = shards[hit.s][hit.id]; const next = { ...cur };
          for (const f of LOG_FIELDS) if (raw[f] !== undefined) next[f] = raw[f];
          for (const f of SOFT) if (raw[f] && !(cur.editedFields || []).includes(f)) next[f] = raw[f];
          next.rep = rep; next.branch = raw.branch || cur.branch || ""; next.updated = now();
          if (target !== hit.s) {
            delete shards[hit.s][hit.id]; (shards[target] = shards[target] || {})[hit.id] = next;
            dirty.add(hit.s); dirty.add(target); movedN++; index[k] = { s: target, id: hit.id };
            moves.push({ id: hit.id, from: hit.s, to: target, name: [next.first, next.last].filter(Boolean).join(" ") || next.company, company: next.company, branch: next.branch, fromRep: cur.rep, rep });
          } else { shards[hit.s][hit.id] = next; dirty.add(hit.s); }
          updated++;
        } else {
          const id = "cl-" + crypto.createHash("sha1").update(k).digest("hex").slice(0, 12);
          const rec = {}; for (const f of [...EDITABLE, ...LOG_FIELDS]) if (raw[f] !== undefined) rec[f] = raw[f];
          Object.assign(rec, { rep, branch: raw.branch || "", status: "", imported: true, hasPhoto: false, editedFields: [], created: raw.created || now(), updated: now(), createdBy: "Call log import" });
          (shards[target] = shards[target] || {})[id] = rec; dirty.add(target); index[k] = { s: target, id }; added++;
        }
      }
      await Promise.all([...dirty].map((s) => store().setJSON("shard/" + s, { contacts: shards[s] || {} })));
      for (const m of moves) {
        const p = await store().get(`photo/${m.from}/${m.id}`); if (p) { await store().set(`photo/${m.to}/${m.id}`, p); await store().delete(`photo/${m.from}/${m.id}`); }
        await writeLog({ by: "Call log import", role: "admin", action: "reassigned", id: m.id, shard: m.to, contact: m.name, company: m.company, branch: m.branch, rep: m.rep, changes: { rep: [m.fromRep || "", m.rep || ""] } });
      }
      let newReps = 0;
      await mutate("users", { users: {} }, (d) => {
        for (const [rep, br] of Object.entries(repBranches)) {
          const slug = slugify(rep); const home = Object.entries(br).sort((a, b) => b[1] - a[1])[0][0];
          if (!d.users[slug]) { d.users[slug] = { name: rep, role: "rep", branch: home, active: false, ver: 0, created: now() }; newReps++; }
        }
      });
      await store().setJSON("meta", { lastImport: now(), lastImportCount: incoming.length });
      await writeLog({ by: user.name, role: "admin", action: "imported call log", contact: `${added} added, ${updated} updated, ${movedN} reassigned`, branch: "", rep: "" });
      return json(200, { added, updated, moved: movedN, newReps });
    }

    // ---- ERP address import: fill blanks by customer name ----
    if (parts[0] === "import-addresses" && method === "POST") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const norm = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|co|corp|company|incorporated|ltd|the|dba)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
      const map = {}; for (const r of rows) { const k = norm(r.company); if (k && r.address && !map[k]) map[k] = r; }
      const slugs = await listShards(); const shards = await loadShards(slugs);
      let filled = 0, companies = new Set(); const dirty = new Set();
      for (const [s, cs] of Object.entries(shards)) for (const c of Object.values(cs)) {
        const r = map[norm(c.company)]; if (!r) continue;
        const ed = c.editedFields || []; let hit = false;
        for (const f of ["address", "city", "state", "zip"]) if (r[f] && !c[f] && !ed.includes(f)) { c[f] = String(r[f]).trim(); hit = true; }
        if (hit) { filled++; companies.add(norm(c.company)); dirty.add(s); }
      }
      await Promise.all([...dirty].map((s) => store().setJSON("shard/" + s, { contacts: shards[s] })));
      await writeLog({ by: user.name, role: "admin", action: "imported addresses", contact: `${filled} contacts at ${companies.size} customers`, branch: "", rep: "" });
      return json(200, { filled, companies: companies.size, rows: rows.length });
    }

    return err(404, "Not found.");
  } catch (e) {
    console.error(e);
    return err(e.status || 500, e.message || "Something went wrong.");
  }
};
