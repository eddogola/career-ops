#!/usr/bin/env node

/**
 * tailor-resume.mjs — tailor a user-owned LaTeX resume to a job and keep it
 * on one page.
 *
 * The resume's formatting lives in resume.tex and is never rewritten. This
 * script applies a plan (which bullets to rewrite, drop or reorder, and the
 * skills line), compiles the result, and measures it. If it runs over the
 * page limit it drops the plan's "trim" candidates one at a time, in the
 * order given, until it fits. It never touches fonts, margins or spacing to
 * make something fit: the only lever is content.
 *
 * Zero-token: the plan comes from the agent (modes/latex-tex.md) or from a
 * person; this script only edits, compiles and measures.
 *
 * Usage:
 *   node tailor-resume.mjs slots [--source resume.tex] [--no-compile]
 *   node tailor-resume.mjs build <plan.json> [--out output/x.pdf] [--source resume.tex] [--pages 1] [--report N]
 *   node tailor-resume.mjs check [file.tex] [--pages 1]
 *
 * --report N records the PDF in data/pdf-index.tsv against that report number,
 * which is how the tracker, the web UI and outcome.mjs find an application's CV.
 *
 * Exit codes: 0 fits · 2 compiled but over the page limit · 1 anything else.
 */

import { readFile, writeFile, mkdtemp, mkdir, rm, cp, copyFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve, sep } from 'path';
import { load as loadYaml } from 'js-yaml';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags, flagValue, hasFlag } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { resolvePdfIndexPath, resolveTrackerPath, resolveWorkspaceRootFor, writeFileAtomic } from './tracker-utils.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { localToday } from './lib/local-today.mjs';
import {
  parseResume, describeResume, applyPlan, instrument, parseFitLog, fitVerdict,
  tightenCandidates, unverifiedNumbers, markupToPlain, texToMarkup,
} from './lib/resume-tex.mjs';

const execFileAsync = promisify(execFile);

const ASSET_DIR = 'resume-assets';
const VALUE_FLAGS = ['--source', '--out', '--pages', '--report'];
const KNOWN_FLAGS = [...VALUE_FLAGS, '--no-compile', '--help', '-h'];

const USAGE = `Usage:
  node tailor-resume.mjs slots [--source resume.tex] [--no-compile]
      List the editable bullets, blocks and skills line, with how many lines each bullet takes.
  node tailor-resume.mjs build <plan.json> [--out output/x.pdf] [--source resume.tex] [--pages 1] [--report N]
      Apply a plan, compile, and trim to the page limit. Writes the PDF and the .tex beside it.
      --report N also records the PDF against report N in data/pdf-index.tsv.
  node tailor-resume.mjs check [file.tex] [--pages 1]
      Compile a .tex as it stands and report whether it fits.

Plan (JSON). Text uses **bold**, \`code\` and *italic*; never LaTeX.
  {
    "job":     { "company": "Acme", "role": "ML Engineer" },
    "bullets": { "bullet-3": "Rewritten text with **emphasis**" },
    "order":   [["bullet-2", "bullet-0", "bullet-1"], ["meta-zerotrust", "meta-pytorch"]],
    "drop":    ["bullet-9", "csail"],
    "trim":    ["bullet-13", "samaki"],
    "skills":  "Python, C++, Go"
  }
  drop  comes out unconditionally.    trim  comes out only if needed to fit, first id first.

Requires tectonic (brew install tectonic) or xelatex on PATH.`;

/**
 * Locate the resume source: --source, then config/profile.yml latex.source,
 * then resume.tex / cv.tex in the data root.
 *
 * @param {string} root data root
 * @param {string|undefined} flag
 * @returns {Promise<string>} absolute path
 */
export async function resolveSource(root, flag) {
  if (flag) return resolve(flag);
  try {
    const profile = loadYaml(await readFile(join(root, 'config', 'profile.yml'), 'utf-8'));
    if (profile?.latex?.source) return resolve(root, profile.latex.source);
  } catch { /* no profile yet */ }
  for (const name of ['resume.tex', 'cv.tex']) {
    if (existsSync(join(root, name))) return join(root, name);
  }
  throw new Error('No resume source found. Add resume.tex to the project root or set latex.source in config/profile.yml.');
}

async function resolveEngine() {
  for (const engine of ['tectonic', 'xelatex']) {
    try {
      await execFileAsync(engine, ['--version']);
      return engine;
    } catch { /* not on PATH */ }
  }
  return null;
}

/**
 * Compile an instrumented copy in a scratch directory and read back the fit.
 *
 * @param {string} tex un-instrumented source
 * @param {string} sourceDir directory of the resume, for its resume-assets/
 * @returns {Promise<object>} { ok, fit, pdf, dir, error }
 */
export async function compileAndMeasure(tex, sourceDir) {
  const engine = await resolveEngine();
  if (!engine) {
    return { ok: false, error: 'No LaTeX engine found. Install tectonic (brew install tectonic) or xelatex.' };
  }
  const dir = await mkdtemp(join(tmpdir(), 'resume-fit-'));
  const texPath = join(dir, 'resume.tex');
  await writeFile(texPath, instrument(tex), 'utf-8');
  const assets = join(sourceDir, ASSET_DIR);
  if (existsSync(assets)) await cp(assets, join(dir, ASSET_DIR), { recursive: true });

  const args = engine === 'tectonic'
    ? ['--keep-logs', '--outdir', dir, texPath]
    : ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'resume.tex'];
  let failure = null;
  try {
    await execFileAsync(engine, args, { cwd: dir, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    failure = err;
  }

  let log = '';
  try { log = await readFile(join(dir, 'resume.log'), 'utf-8'); } catch { /* no log */ }
  const pdf = join(dir, 'resume.pdf');
  if (failure || !existsSync(pdf)) {
    const texErrors = log.split('\n').filter((l) => l.startsWith('!')).slice(0, 5).join('\n');
    const error = texErrors || String(failure?.stderr || failure?.message || 'compile produced no PDF').trim().split('\n').slice(-8).join('\n');
    await rm(dir, { recursive: true, force: true });
    return { ok: false, engine, error };
  }
  const fit = parseFitLog(log);
  if (!fit) {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, engine, error: 'Compiled, but the log carries no fit report, so the page count is unknown.' };
  }
  return { ok: true, engine, fit, pdf, dir };
}

// Height of one bullet line in TeX points, the unit the log reports in.
function lineHeight(tex) {
  const m = tex.match(/\\newcommand\{\\resumeBulletLead\}\{([\d.]+)(pt|bp)\}/);
  if (!m) return 14;
  return m[2] === 'bp' ? Number(m[1]) * 72.27 / 72 : Number(m[1]);
}

// Join the probe's per-bullet measurements to bullet ids. `order` is the ids
// as they appear in the compiled document.
function bulletReport(order, fit, textById) {
  if (fit.items.length !== order.length) return [];
  return order.map((id, i) => ({
    id,
    lines: fit.items[i].lines,
    naturalPt: fit.items[i].naturalPt,
    measurePt: fit.items[i].measurePt,
    chars: markupToPlain(textById.get(id) ?? '').length,
  }));
}

function fitSummary(fit, maxPages, lead) {
  const v = fitVerdict(fit, maxPages);
  return {
    fits: v.fits,
    pages: v.pages,
    max_pages: maxPages,
    ...(v.sparePt !== null ? { spare_lines: Math.floor(v.sparePt / lead), spare_pt: v.sparePt } : {}),
    ...(v.overPt !== null ? { over_by_lines: Math.max(1, Math.ceil(v.overPt / lead)), over_by_pt: v.overPt } : {}),
  };
}

function parsePages(args) {
  const raw = flagValue(args, '--pages');
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--pages must be a positive integer, got "${raw}"`);
  return n;
}

/**
 * Record the PDF against its report number in data/pdf-index.tsv, the same
 * row generate-pdf.mjs writes for an HTML-rendered CV, so every reader of
 * that file finds a LaTeX-built CV the same way.
 *
 * @param {string} root data root
 * @param {string} reportNum
 * @param {string} pdfPath absolute path of the built PDF
 * @returns {Promise<string>} the manifest path
 */
async function recordPdf(root, reportNum, pdfPath) {
  // generate-pdf.mjs owns the row format; imported on demand because it pulls
  // in Playwright, which nothing else here needs.
  const { applyManifestRow } = await import('./generate-pdf.mjs');
  const manifestPath = resolvePdfIndexPath(resolveTrackerPath(root));
  const workspace = resolveWorkspaceRootFor(root);
  await mkdir(dirname(manifestPath), { recursive: true });
  await withPipelineLock(manifestPath, () => {
    const existing = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf-8').split('\n') : [];
    const lines = applyManifestRow(existing, {
      reportNum,
      pdf: relative(workspace, pdfPath).split(sep).join('/'),
      html: '',
      format: 'a4',
      date: localToday(),
      kind: 'cv',
    });
    writeFileAtomic(
      manifestPath,
      '# report\tpdf\thtml\tformat\tdate\tkind - written by generate-pdf.mjs, do not edit\n' + lines.join('\n') + '\n',
    );
  });
  return manifestPath;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'resume';
}

async function cmdSlots(args, root) {
  const source = await resolveSource(root, flagValue(args, '--source'));
  const tex = await readFile(source, 'utf-8');
  const model = parseResume(tex);
  const out = { source, ...describeResume(model) };
  if (!hasFlag(args, '--no-compile')) {
    const built = await compileAndMeasure(tex, dirname(source));
    if (!built.ok) {
      out.fit = { error: built.error };
    } else {
      const lead = lineHeight(tex);
      const textById = new Map(model.bullets.map((b) => [b.id, b.text]));
      const measured = bulletReport(model.bullets.map((b) => b.id), built.fit, textById);
      const linesById = new Map(measured.map((b) => [b.id, b.lines]));
      out.bullets = out.bullets.map((b) => ({ ...b, lines: linesById.get(b.id) ?? null }));
      out.fit = { ...fitSummary(built.fit, parsePages(args), lead), tighten: tightenCandidates(measured) };
      await rm(built.dir, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

async function cmdCheck(args, positional, root) {
  const source = positional[0] ? resolve(positional[0]) : await resolveSource(root, flagValue(args, '--source'));
  const tex = await readFile(source, 'utf-8');
  const built = await compileAndMeasure(tex, dirname(source));
  if (!built.ok) {
    console.log(JSON.stringify({ source, ok: false, error: built.error }, null, 2));
    return 1;
  }
  const summary = fitSummary(built.fit, parsePages(args), lineHeight(tex));
  await rm(built.dir, { recursive: true, force: true });
  console.log(JSON.stringify({ source, ok: true, engine: built.engine, ...summary }, null, 2));
  return summary.fits ? 0 : 2;
}

async function readCorpus(root, sourceTex) {
  let corpus = texToMarkup(sourceTex.slice(sourceTex.indexOf('\\begin{document}')));
  for (const name of ['cv.md', 'article-digest.md']) {
    try { corpus += `\n${await readFile(join(root, name), 'utf-8')}`; } catch { /* optional */ }
  }
  return corpus;
}

async function cmdBuild(args, positional, root) {
  const planPath = positional[0];
  if (!planPath) throw new Error('build needs a plan file: node tailor-resume.mjs build <plan.json>');
  const plan = JSON.parse(await readFile(resolve(planPath), 'utf-8'));
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('The plan must be a JSON object');
  const knownKeys = ['job', 'bullets', 'order', 'drop', 'trim', 'skills'];
  const stray = Object.keys(plan).filter((k) => !knownKeys.includes(k));
  if (stray.length) throw new Error(`Unknown plan key(s): ${stray.join(', ')}. Known: ${knownKeys.join(', ')}`);

  const source = await resolveSource(root, flagValue(args, '--source'));
  const tex = await readFile(source, 'utf-8');
  const model = parseResume(tex);
  const maxPages = parsePages(args);
  const lead = lineHeight(tex);
  const reportNum = flagValue(args, '--report');
  if (reportNum !== undefined && !/^\d+$/.test(reportNum)) throw new Error(`--report must be a report number, got "${reportNum}"`);

  const ids = new Set([...model.bullets.map((b) => b.id), ...model.blocks.map((b) => b.id)]);
  const badTrim = (plan.trim ?? []).filter((id) => !ids.has(id));
  if (badTrim.length) throw new Error(`Unknown id(s) in trim: ${badTrim.join(', ')}`);

  const date = localToday();
  const outPdf = resolve(flagValue(args, '--out') ?? join(root, 'output', `resume-${slug(plan.job?.company)}-${date}.pdf`));
  const outTex = outPdf.replace(/\.pdf$/i, '') + '.tex';

  const trimQueue = [...(plan.trim ?? [])];
  const trimmed = [];
  const skipped = [];
  let applied = applyPlan(tex, model, plan, trimmed);
  let built;
  for (;;) {
    built = await compileAndMeasure(applied.tex, dirname(source));
    if (!built.ok) {
      console.log(JSON.stringify({ ok: false, source, error: built.error }, null, 2));
      return 1;
    }
    if (fitVerdict(built.fit, maxPages).fits) break;
    // Over the limit: take the next trim candidate that can actually go.
    let next = null;
    while (trimQueue.length && !next) {
      const id = trimQueue.shift();
      if (applied.dropped.includes(id)) continue;
      try {
        next = { id, applied: applyPlan(tex, model, plan, [...trimmed, id]) };
      } catch (err) {
        skipped.push({ id, reason: err.message });
      }
    }
    if (!next) break;
    await rm(built.dir, { recursive: true, force: true });
    trimmed.push(next.id);
    applied = next.applied;
  }

  const summary = fitSummary(built.fit, maxPages, lead);
  const textById = new Map(model.bullets.map((b) => [b.id, b.text]));
  for (const [id, value] of Object.entries(plan.bullets ?? {})) {
    textById.set(id, typeof value === 'string' ? value : texToMarkup(value.tex));
  }
  const measured = bulletReport(applied.bullets, built.fit, textById);

  const rewritten = Object.keys(plan.bullets ?? {}).filter((id) => applied.bullets.includes(id));
  const tailoredText = [
    ...rewritten.map((id) => markupToPlain(textById.get(id))),
    plan.skills ? (Array.isArray(plan.skills) ? plan.skills.join(', ') : plan.skills) : '',
  ].join('\n');
  const strayNumbers = unverifiedNumbers(tailoredText, await readCorpus(root, tex));

  const warnings = [];
  if (strayNumbers.length) {
    warnings.push(`Numbers not found in the resume, cv.md or article-digest.md: ${strayNumbers.join(', ')}. Confirm each one is true before sending.`);
  }
  for (const s of skipped) warnings.push(`Could not trim ${s.id}: ${s.reason}`);
  for (const heading of applied.emptied) warnings.push(`"${heading}" now has no bullets under it.`);

  const report = {
    ok: true,
    ...summary,
    source,
    job: plan.job ?? null,
    rewritten,
    dropped: (plan.drop ?? []),
    trimmed,
    bullets: measured.map(({ id, lines }) => ({ id, lines })),
    tighten: tightenCandidates(measured),
    warnings,
  };

  if (summary.fits) {
    await mkdir(dirname(outPdf), { recursive: true });
    await copyFile(built.pdf, outPdf);
    await writeFile(outTex, applied.tex, 'utf-8');
    report.pdf = outPdf;
    report.tex = outTex;
    if (reportNum !== undefined) {
      try {
        report.indexed = await recordPdf(root, reportNum, outPdf);
      } catch (err) {
        warnings.push(`The PDF was built, but could not be recorded against report ${reportNum}: ${err.message}`);
      }
    }
  } else {
    report.hint = trimQueue.length === 0 && (plan.trim ?? []).length
      ? 'Every trim candidate is gone and it still runs over. Shorten the bullets listed under "tighten", or add more ids to "trim".'
      : 'Over the page limit and the plan names nothing to trim. Add ids to "trim" (least important first), or shorten the bullets listed under "tighten".';
  }
  await rm(built.dir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  return summary.fits ? 0 : 2;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  validateFlags(rawArgs, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  // Positionals are whatever is left once flags and their values are removed.
  const positional = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (VALUE_FLAGS.includes(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    positional.push(a);
  }
  const command = positional.shift();
  const root = getCareerOpsRoot();

  try {
    if (command === 'slots') process.exit(await cmdSlots(rawArgs, root));
    if (command === 'check') process.exit(await cmdCheck(rawArgs, positional, root));
    if (command === 'build') process.exit(await cmdBuild(rawArgs, positional, root));
    console.error(USAGE);
    process.exit(1);
  } catch (err) {
    console.error(`tailor-resume: ${err.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
