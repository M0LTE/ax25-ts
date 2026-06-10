#!/usr/bin/env node
/**
 * Cross-repo parity drift guard: @packet-net/ax25 (this repo) vs the C#
 * reference implementation in m0lte/packet.net.
 *
 * The C# libraries are the reference runtime ("runtime behaviour questions
 * defer to the C# reference" — CLAUDE.md). Historically the TS side drifted
 * behind it silently: new named parse flags, session quirks, and listener
 * surface (the TEST/axping responder, the per-listener compat knobs) landed
 * in C# with no TS counterpart and nothing failed. This script makes that
 * drift a CI failure on BOTH sides:
 *
 *   - in this repo's ci.yml: a job shallow-clones packet.net main and runs
 *     this script — a TS PR can't merge while the inventories disagree;
 *   - in packet.net's interop.yml: the existing ax25-ts checkout runs the
 *     same script — a C# PR adding a named flag fails until the TS leg
 *     exists (or an exception is consciously recorded here first).
 *
 * What is compared (C# is the reference; the check is C# ⊆ TS modulo the
 * alias maps below; TS-only extras are reported as info, not failures):
 *
 *   1. Ax25ParseOptions flag inventory + preset inventory
 *   2. Ax25SessionQuirks flag inventory + preset inventory
 *   3. XidParseOptions flag inventory
 *   4. Ax25ListenerOptions member inventory
 *   5. Ax25Listener public method/event surface
 *
 * Intentional divergences live in scripts/parity-exceptions.json with a
 * reason each — an exception is a *reviewed decision*, not a hole. The guard
 * fails on any gap that is neither aliased nor excepted.
 *
 * Extraction is regex-over-source on purpose: no build of either repo is
 * needed, so the check runs in seconds on a shallow sparse clone. It leans
 * on both repos' stable formatting (root-level class braces at column 0,
 * one property per line). If a refactor breaks extraction the guard fails
 * loudly with "inventory came back empty" — fix the regex, don't skip the
 * check.
 *
 * Usage: node scripts/parity-check.mjs --csharp <packet.net root> [--ts <ax25-ts root>]
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const tsRoot = argValue("--ts", join(dirname(fileURLToPath(import.meta.url)), ".."));
const csRoot = argValue("--csharp", null);
if (!csRoot) {
  console.error("usage: parity-check.mjs --csharp <packet.net root> [--ts <ax25-ts root>]");
  process.exit(2);
}

const exceptions = JSON.parse(
  readFileSync(join(tsRoot, "scripts", "parity-exceptions.json"), "utf8"),
);

const read = (p) => readFileSync(p, "utf8");
const camel = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** All `public bool X { get; init; }` property names in a C# file. */
function csBoolProps(text) {
  return [...text.matchAll(/^\s*public bool (\w+)\s*\{\s*get;/gm)].map((m) => m[1]);
}

/** All `public static <Type> X { get; }` preset names in a C# file. */
function csStaticPresets(text, type) {
  const re = new RegExp(`^\\s*public static ${type} (\\w+)\\s*\\{\\s*get;`, "gm");
  return [...text.matchAll(re)].map((m) => m[1]);
}

/** Member names of a named TS interface (one `readonly x?: T;` / `x?: T;` per line). */
function tsInterfaceMembers(text, name) {
  const start = text.indexOf(`export interface ${name}`);
  if (start < 0) return [];
  const body = sliceBalanced(text, text.indexOf("{", start));
  return [...body.matchAll(/^\s*(?:readonly\s+)?(\w+)\??\s*[:(]/gm)].map((m) => m[1]);
}

/** Slice a balanced `{ … }` block starting at the given `{` index. */
function sliceBalanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(openIdx + 1, i);
  }
  return text.slice(openIdx + 1);
}

/** Body of a C# class (root-level `^}` closes it in both repos' style). */
function csClassBody(text, className) {
  const m = text.match(new RegExp(`(class|record) ${className}[^{]*`, ""));
  if (!m) return "";
  return sliceBalanced(text, text.indexOf("{", m.index + m[0].length - 1));
}

let failures = 0;
let notes = 0;
function check(section, missing, extras, exceptionMap = {}) {
  const realMissing = missing.filter((name) => {
    if (exceptionMap[name]) {
      console.log(`  ~ ${name} — EXCEPTED: ${exceptionMap[name]}`);
      notes++;
      return false;
    }
    return true;
  });
  for (const name of realMissing) {
    console.log(`  ✗ ${name} — present in C#, missing in TS`);
    failures++;
  }
  for (const name of extras) {
    console.log(`  + ${name} — TS-only (informational)`);
  }
  if (realMissing.length === 0) console.log("  ✓ in sync");
}

function compare(section, csNames, tsNames, mapCsToTs, exceptionMap) {
  console.log(`\n${section}:`);
  const tsSet = new Set(tsNames);
  const expected = csNames.map((n) => [n, mapCsToTs(n)]);
  const missing = expected.filter(([, ts]) => !tsSet.has(ts)).map(([cs]) => cs);
  const expectedTs = new Set(expected.map(([, ts]) => ts));
  const extras = tsNames.filter((n) => !expectedTs.has(n));
  check(section, missing, extras, exceptionMap);
}

// ─── 1. Ax25ParseOptions flags + presets ──────────────────────────────
const csParse = read(join(csRoot, "src/Packet.Core/Ax25ParseOptions.cs"));
const tsFrame = read(join(tsRoot, "src/frame.ts"));

compare(
  "Ax25ParseOptions flags",
  csBoolProps(csParse),
  tsInterfaceMembers(tsFrame, "Ax25ParseOptions"),
  camel,
  exceptions.parseOptionFlags ?? {},
);

compare(
  "Ax25ParseOptions presets",
  csStaticPresets(csParse, "Ax25ParseOptions"),
  [...tsFrame.matchAll(/^export const (\w+)_PARSE\b/gm)].map((m) => `${m[1]}_PARSE`),
  (n) => `${n.toUpperCase()}_PARSE`,
  exceptions.parsePresets ?? {},
);

// ─── 2. Ax25SessionQuirks flags + presets ─────────────────────────────
const csQuirks = read(join(csRoot, "src/Packet.Ax25/Session/Ax25SessionQuirks.cs"));
const tsQuirks = read(join(tsRoot, "src/sdl/session-quirks.ts"));

compare(
  "Ax25SessionQuirks flags",
  csBoolProps(csQuirks),
  tsInterfaceMembers(tsQuirks, "Ax25SessionQuirks"),
  camel,
  exceptions.quirkFlags ?? {},
);

compare(
  "Ax25SessionQuirks presets",
  csStaticPresets(csQuirks, "Ax25SessionQuirks"),
  [...tsQuirks.matchAll(/^export const (\w+)\s*:\s*Ax25SessionQuirks/gm)].map((m) => m[1]),
  (n) => `${camel(n)}SessionQuirks`,
  exceptions.quirkPresets ?? {},
);

// ─── 3. XidParseOptions flags ─────────────────────────────────────────
const csXid = read(join(csRoot, "src/Packet.Ax25/Xid/XidParseOptions.cs"));
const tsXid = read(join(tsRoot, "src/xid.ts"));

compare(
  "XidParseOptions flags",
  csBoolProps(csXid),
  tsInterfaceMembers(tsXid, "XidParseOptions"),
  camel,
  exceptions.xidFlags ?? {},
);

// ─── 4 + 5. Listener options + listener public surface ───────────────
const csListener = read(join(csRoot, "src/Packet.Ax25/Session/Ax25Listener.cs"));
const tsListener = read(join(tsRoot, "src/listener.ts"));

const csListenerOptionsBody = csClassBody(csListener, "Ax25ListenerOptions");
const csOptionNames = [
  ...csListenerOptionsBody.matchAll(/^\s*public [\w?<>. ]+? (\w+)\s*\{\s*get;/gm),
].map((m) => m[1]);

// C# option name → TS option name. Timer values are milliseconds-suffixed in
// TS (numbers, not TimeSpans) — an idiom difference, not drift.
const optionAlias = {
  MyCall: "myCall",
  T1V: "t1Ms",
  T2: "t2Ms",
  T3: "t3Ms",
  N2: "n2",
  K: "k",
  MaxCachedPeers: "maxCachedPeers",
  ParseOptions: "parseOptions",
  Quirks: "quirks",
  ConfigureSession: "configureSession",
};
compare(
  "Ax25ListenerOptions members",
  csOptionNames,
  tsInterfaceMembers(tsListener, "Ax25ListenerOptions"),
  (n) => optionAlias[n] ?? camel(n),
  exceptions.listenerOptions ?? {},
);

const csListenerBody = csClassBody(csListener, "Ax25Listener ");
const csSurface = [
  // public methods (Async suffix is a C# idiom — stripped by the alias map)
  ...[...csListenerBody.matchAll(/^\s{4}public (?:async )?[\w<>?. ]+? (\w+)\(/gm)].map((m) => m[1]),
  // public events
  ...[...csListenerBody.matchAll(/^\s{4}public event [\w<>?. ]+? (\w+);/gm)].map((m) => m[1]),
].filter((n) => n !== "Ax25Listener"); // constructors

const methodAlias = {
  StartAsync: "start",
  StopAsync: "stop",
  DisposeAsync: "dispose",
  ConnectAsync: "connect",
  SendUiAsync: "sendUi",
  SendTestAsync: "sendTest",
  SessionAccepted: "onSessionAccepted",
  FrameTraced: "onFrameTraced",
};
const tsListenerClassBody = sliceBalanced(
  tsListener,
  tsListener.indexOf("{", tsListener.indexOf("export class Ax25Listener ")),
);
const tsSurface = [
  ...tsListenerClassBody.matchAll(/^  (?:async )?(?:get )?(\w+)\s*[(<]/gm),
].map((m) => m[1]).filter((n) => n !== "constructor");

compare(
  "Ax25Listener public surface",
  [...new Set(csSurface)],
  [...new Set(tsSurface)],
  (n) => methodAlias[n] ?? camel(n),
  exceptions.listenerSurface ?? {},
);

// ─── verdict ──────────────────────────────────────────────────────────
console.log("");
if (failures > 0) {
  console.log(
    `PARITY DRIFT: ${failures} gap(s). Either add the TS counterpart, or record ` +
      `a reviewed exception (with a reason) in scripts/parity-exceptions.json.`,
  );
  process.exit(1);
}
console.log(
  `Parity check passed${notes > 0 ? ` (${notes} documented exception(s))` : ""}.`,
);
