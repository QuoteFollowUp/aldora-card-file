// Aldora shared access codes. The same file is copied into every app's functions folder.
//
// One code list for every app: the Netlify environment variable REP_ACCESS_CODES, set once at
// TEAM level (Team settings > Environment variables) so every site reads the same list. Same
// format the Quote Follow-Up / Call Log app already uses, a JSON map of code -> who:
//   "first-last"                         rep: only their own data
//   "@branch:louisville:first-last"      branch manager: that branch's reps
//   "@reps:rep-one+rep-two:first-last"   manager of a hand-picked set of reps
//   "@all:first-last"                    everything
//   "@view:first-last"                   everything, read only
// Codes ignore case, spaces and dashes ("VCDR-TDMR" = "vcdr tdmr").

// Field reps and their branch (same list the hub and Call Log app use)
export const REP_BRANCH = {
  "Steve Crum": "Louisville", "Jim Wanamaker": "Louisville", "Christian Kelley": "Louisville",
  "Clarke Haas": "Charleston", "Zachary Mangum": "Charleston",
  "Andrea Harmon": "Atlanta", "Michael Eidson": "Atlanta",
  "Chad Parrish": "Newport News", "Kyle Pitsenberger": "Newport News", "Anthony Ante": "Newport News",
  "Eric Pegouske": "Orlando", "Troy Patnode": "Orlando",
  "Ben Gless": "Coral Springs", "Shawn Levine": "Coral Springs", "Jordan Freeman": "Coral Springs",
  "Mark Williams": "Miami",
  "Adam Tarkenton": "New Angle Beveling",
};
const BRANCHES = ["Atlanta", "Charleston", "Coral Springs", "Louisville", "Miami", "New Angle Beveling", "Newport News", "Orlando"];

export const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
const titleName = (slug) => String(slug || "").split(/[-_\s]+/).filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).map((w) => w.replace(/^(Mc)([a-z])/, (m, a, c) => a + c.toUpperCase())).join(" ");

// "louisville", "Newport-News", "Miami (Peterson)", "LPG", "NN VA" -> canonical branch name
export function canonBranch(b) {
  const t = String(b || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (/newport|^nn\b/.test(t)) return "Newport News";
  if (/coral|^cs\b/.test(t)) return "Coral Springs";
  if (/louis|^lpg\b/.test(t)) return "Louisville";
  if (/orlan|^orl\b/.test(t)) return "Orlando";
  if (/atlan|^atl\b/.test(t)) return "Atlanta";
  if (/charl|^chs\b/.test(t)) return "Charleston";
  if (/miami|peterson/.test(t)) return "Miami";
  if (/angle|bevel/.test(t)) return "New Angle Beveling";
  return BRANCHES.find((x) => x.toLowerCase() === t) || titleName(t);
}

// Rep name as it appears anywhere ("Mccall", "christian-kelley") -> the roster spelling when known
const ROSTER_BY_KEY = Object.fromEntries(Object.keys(REP_BRANCH).map((n) => [nameKey(n), n]));
const ALIASES = { "jim wannamaker": "Jim Wanamaker", "jim wannmaker": "Jim Wanamaker", "clark haas": "Clarke Haas", "chad parish": "Chad Parrish",
  "christian kelly": "Christian Kelley", "kyle pitzenberger": "Kyle Pitsenberger", "benjamin gless": "Ben Gless", "mike eidson": "Michael Eidson" };
export function canonRep(name) {
  const k = nameKey(name);
  return ALIASES[k] || ROSTER_BY_KEY[k] || titleName(k);
}

let BAD = false;
export function codeMap() {
  const raw = String(process.env.REP_ACCESS_CODES || process.env.ACCESS_CODES || "{}")
    .replace(/[“”„″]/g, '"').replace(/[‘’]/g, "'").replace(/[\r\n]+/g, " ").trim();
  try { const m = JSON.parse(raw); BAD = false; return m && typeof m === "object" ? m : {}; }
  catch { BAD = true; return {}; }
}
export const listIsBad = () => BAD;
export const listIsSet = () => !!(process.env.REP_ACCESS_CODES || process.env.ACCESS_CODES);

// Code -> who, or null.  { role: "all"|"branch"|"team"|"rep", readOnly, name, rep, branch, reps, label }
export function whoIs(code) {
  const c = normCode(code);
  if (!c) return null;
  const m = codeMap();
  const hit = Object.keys(m).find((k) => normCode(k) === c);
  if (!hit) return null;
  const v = String(m[hit] || "").trim();
  if (!v) return null;
  let x = v.match(/^@(view|all|owner|ownership|admin)(?::(.+))?$/i);
  if (x) {
    const name = x[2] ? titleName(x[2]) : x[1].toLowerCase() === "view" ? "View-only" : "Ownership";
    return { role: "all", readOnly: x[1].toLowerCase() === "view", name, label: name + " · All branches" };
  }
  x = v.match(/^@reps:([^:]+)(?::(.+))?$/i);
  if (x) {
    const reps = x[1].split("+").map((s) => canonRep(s)).filter(Boolean);
    const name = x[2] ? titleName(x[2]) : "Manager";
    return { role: "team", readOnly: false, name, reps, label: name + " · " + reps.join(", ") };
  }
  x = v.match(/^@branch:([^:]+)(?::(.+))?$/i);
  if (x) {
    const branch = canonBranch(x[1]);
    const name = x[2] ? titleName(x[2]) : branch + " manager";
    return { role: "branch", readOnly: false, name, branch, label: name + " · " + branch + " reps" };
  }
  const rep = canonRep(v);
  return { role: "rep", readOnly: false, name: rep, rep, branch: REP_BRANCH[rep] || "", label: rep };
}

// Reps this person may see: null = everyone, otherwise a Set of roster names
export function repsFor(who) {
  if (!who || who.role === "all") return null;
  if (who.role === "rep") return new Set([who.rep]);
  if (who.role === "team") return new Set(who.reps);
  return new Set(Object.keys(REP_BRANCH).filter((r) => REP_BRANCH[r] === who.branch));
}
export function canSeeRep(who, repName) {
  const s = repsFor(who);
  return !s || s.has(canonRep(repName));
}
