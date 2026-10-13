// resume-tex.mjs — the web pdf run for installs whose CV is a LaTeX resume.
//
// The module's job is to keep the tailoring agent's output from becoming
// anything but a plan handed to tailor-resume.mjs, and to mark the tracker
// only after a confirmed one-page build. Each test pins one way that could
// quietly go wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  PLAN_OPEN_MARK, PLAN_CLOSE_MARK, parseResumePlan, createResumePlanFilter,
  resumeTexSource, loadResumeSlots, buildResumePlanPrompt, buildAndMarkResume,
} from "../src/lib/resume-tex.mjs";

const wrap = (body) => `Thinking about the role.\n${PLAN_OPEN_MARK}\n${body}\n${PLAN_CLOSE_MARK}\nVERDICT: reordered teams`;

/** A spawn stand-in: answers each script by name, records every call. */
function fakeSpawn(answers) {
  const calls = [];
  const spawnFn = (_exec, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const script = path.basename(args[0]);
    const key = script === "tailor-resume.mjs" ? `tailor:${args[1]}` : script;
    const { code = 0, stdout = "", stderr = "" } = answers[key] ?? {};
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  };
  return { spawnFn, calls };
}

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-tex-web-"));
  const tmp = path.join(root, ".career-ops-web", "pdf-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  return { root, pdfPaths: { html: path.join(tmp, "cv-web-007.html"), finalPdf: path.join(root, "output", "cv-x-007-acme.pdf") } };
}

test("a well-formed envelope yields the plan", () => {
  const r = parseResumePlan(wrap('{"trim":["bullet-1"],"skills":"Go"}'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan, { trim: ["bullet-1"], skills: "Go" });
  assert.deepEqual(r.warnings, []);
});

test("a fenced plan is read; a plan with no trim list is flagged", () => {
  const r = parseResumePlan(wrap('```json\n{"skills":"Go"}\n```'));
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});

test("markers mentioned mid-line do not open an envelope", () => {
  const r = parseResumePlan(`I will emit ${PLAN_OPEN_MARK} and then ${PLAN_CLOSE_MARK} later.`);
  assert.equal(r.ok, false);
  assert.match(r.error, /no <<resume-plan>> envelope/);
});

test("two envelopes are refused rather than guessed at", () => {
  const r = parseResumePlan(`${wrap("{}")}\n${wrap('{"drop":["meta"]}')}`);
  assert.equal(r.ok, false);
  assert.match(r.error, /Found 2/);
});

test("an unclosed, empty, non-JSON or non-object plan fails closed", () => {
  assert.match(parseResumePlan(`${PLAN_OPEN_MARK}\n{"a":1}`).error, /never closed/);
  assert.match(parseResumePlan(wrap("")).error, /empty/);
  assert.match(parseResumePlan(wrap("{not json")).error, /not valid JSON/);
  assert.match(parseResumePlan(wrap('["bullet-1"]')).error, /must be a JSON object/);
});

test("the filter shows the plan and parses across chunk boundaries", () => {
  const f = createResumePlanFilter();
  const text = wrap('{"trim":["bullet-2"]}');
  let shown = "";
  for (let i = 0; i < text.length; i += 7) shown += f.push(text.slice(i, i + 7));
  assert.equal(shown + f.flush(), text);
  assert.deepEqual(f.result().plan, { trim: ["bullet-2"] });
});

test("resumeTexSource: configured file, default file, or null", () => {
  const { root } = scratch();
  assert.equal(resumeTexSource(root), null, "no tailor-resume.mjs means the HTML path");
  fs.writeFileSync(path.join(root, "tailor-resume.mjs"), "");
  assert.equal(resumeTexSource(root), null, "no resume means the HTML path");
  fs.writeFileSync(path.join(root, "resume.tex"), "x");
  assert.equal(resumeTexSource(root), "resume.tex");
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config", "profile.yml"), "latex:\n  source: mine.tex\n");
  assert.equal(resumeTexSource(root), null, "a configured source that does not exist is not silently replaced");
  fs.writeFileSync(path.join(root, "mine.tex"), "x");
  assert.equal(resumeTexSource(root), "mine.tex");
});

test("loadResumeSlots returns the slots without the absolute path, and surfaces a resume that does not compile", async () => {
  const ok = fakeSpawn({ "tailor:slots": { stdout: JSON.stringify({ source: "/abs/resume.tex", bullets: [{ id: "bullet-0" }], fit: { fits: true } }) } });
  const loaded = await loadResumeSlots({ spawnFn: ok.spawnFn, execPath: "node", root: "/r" });
  assert.equal(loaded.ok, true);
  assert.equal("source" in loaded.slots, false);
  const broken = fakeSpawn({ "tailor:slots": { stdout: JSON.stringify({ bullets: [], fit: { error: "! Undefined control sequence." } }) } });
  const failed = await loadResumeSlots({ spawnFn: broken.spawnFn, execPath: "node", root: "/r" });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /does not compile/);
});

test("the prompt carries the slots, the markers mid-line, and no instruction to write files", () => {
  const prompt = buildResumePlanPrompt({ input: "007", reportFile: "reports/007-acme-2026-01-01.md", slots: { bullets: [{ id: "bullet-0", text: "x" }] } });
  assert.ok(prompt.includes('"bullet-0"'));
  assert.ok(prompt.includes("modes/resume-tex.md"));
  // A marker on a line of its own in the prompt would parse as an envelope when
  // a CLI echoes its prompt (codex exec does).
  assert.equal(parseResumePlan(prompt).ok, false);
  assert.match(parseResumePlan(prompt).error, /no <<resume-plan>> envelope/);
});

test("a build that fits marks the tracker and reports what was trimmed", async () => {
  const { root, pdfPaths } = scratch();
  const { spawnFn, calls } = fakeSpawn({
    "tailor:build": { stdout: JSON.stringify({ ok: true, fits: true, pdf: pdfPaths.finalPdf, trimmed: ["bullet-9"], spare_lines: 1, warnings: ["Numbers not found: 45."] }) },
    "mark-pdf-ready.mjs": { stdout: JSON.stringify({ ok: true }) },
  });
  const result = await buildAndMarkResume({ spawnFn, execPath: "node", root, pdfPaths, plan: { trim: ["bullet-9"] }, reportNum: "007" });
  assert.equal(result.kind, "rendered");
  assert.equal(result.warnings.length, 3);
  assert.deepEqual(calls[0].slice(1, 2), ["build"]);
  assert.deepEqual(calls[0].slice(3), ["--out", pdfPaths.finalPdf, "--report", "007"]);
  assert.equal(path.basename(calls[1][0]), "mark-pdf-ready.mjs");
  assert.deepEqual(fs.readdirSync(path.dirname(pdfPaths.html)), [], "the scratch plan is removed");
});

test("a build that runs over the page never marks the tracker", async () => {
  const { root, pdfPaths } = scratch();
  const { spawnFn, calls } = fakeSpawn({ "tailor:build": { code: 2, stdout: JSON.stringify({ ok: true, fits: false, over_by_lines: 2 }) } });
  const result = await buildAndMarkResume({ spawnFn, execPath: "node", root, pdfPaths, plan: {}, reportNum: "007" });
  assert.equal(result.kind, "render-failed");
  assert.match(result.error, /2 line\(s\) over one page/);
  assert.equal(calls.length, 1, "mark-pdf-ready.mjs was not run");
});

test("a rejected plan surfaces tailor-resume's own message and never marks the tracker", async () => {
  const { root, pdfPaths } = scratch();
  const { spawnFn, calls } = fakeSpawn({ "tailor:build": { code: 1, stderr: "tailor-resume: Unknown plan key(s): preamble" } });
  const result = await buildAndMarkResume({ spawnFn, execPath: "node", root, pdfPaths, plan: { preamble: "x" }, reportNum: "007" });
  assert.equal(result.kind, "render-failed");
  assert.match(result.error, /Unknown plan key/);
  assert.equal(calls.length, 1);
});

test("a tracker that could not be marked is a warning, not a failed build", async () => {
  const { root, pdfPaths } = scratch();
  const { spawnFn } = fakeSpawn({
    "tailor:build": { stdout: JSON.stringify({ ok: true, fits: true, pdf: pdfPaths.finalPdf, trimmed: [], warnings: [] }) },
    "mark-pdf-ready.mjs": { code: 2, stdout: JSON.stringify({ ok: false, error: "row not found" }) },
  });
  const result = await buildAndMarkResume({ spawnFn, execPath: "node", root, pdfPaths, plan: {}, reportNum: "007" });
  assert.equal(result.kind, "rendered");
  assert.match(result.warnings[0], /row not found/);
});
