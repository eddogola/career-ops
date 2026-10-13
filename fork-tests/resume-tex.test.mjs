// fork-tests/resume-tex.test.mjs — structural edits on a user-owned LaTeX resume.
//
// lib/resume-tex.mjs rewrites, drops and reorders bullets inside the user's
// own .tex. Each check below pins something that would ship a wrong resume
// without any error: emphasis lost in a rewrite, LaTeX typed into a plan
// reaching the compiler live, a trim leaving a heading with nothing under it,
// or an overflowing page reported as fitting.
//
// Run: node --test "fork-tests/*.test.mjs"
// Lives outside tests/ because that directory belongs to upstream: the updater
// prunes anything in it that upstream does not ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  texToMarkup, markupToTex, parseResume, describeResume, applyPlan,
  instrument, parseFitLog, fitVerdict, tightenCandidates, unverifiedNumbers,
} from '../lib/resume-tex.mjs';

const check = (ok, name, detail = '') => test(name, () => assert.ok(ok, detail));
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const TEX = String.raw`\documentclass{article}
\newcommand{\resumeItem}[1]{\item #1}
\begin{document}
% <block exp>
\resumeSection{EXPERIENCE}
% <block acme>
\resumeSubheading{Acme}{2024}{Engineer}{NYC}
% <block acme-infra>
\resumeTeam{Infra | Storage}
\resumeItemListStart
  \resumeItem{Cut \textbf{p99 latency} by \textbf{40\%} in \code{io_uring} paths.}
  \resumeItem{Led a team of 3 \& shipped R\&D tooling.}
  % \resumeItem{An old bullet kept for reference.}
  \resumeItem{Third bullet.}
\resumeItemListEnd
% </block acme-infra>
% <block acme-ml>
\resumeTeam{ML}
\resumeItemListStart
  \resumeItem{Only ML bullet.}
\resumeItemListEnd
% </block acme-ml>
% </block acme>
% </block exp>
\resumeSkills{SKILLS}{Go, C++}
\end{document}
`;

// ── markup ──────────────────────────────────────────────────────────────
const raw = String.raw`Cut \textbf{p99 latency} by \textbf{40\%} in \code{io_uring} paths.`;
check(texToMarkup(raw) === 'Cut **p99 latency** by **40%** in `io_uring` paths.',
  'texToMarkup turns \\textbf and \\code into markers and undoes escapes', texToMarkup(raw));
check(markupToTex(texToMarkup(raw)) === raw.replace('io_uring', String.raw`io\_uring`),
  'a bullet survives the round trip through markup', markupToTex(texToMarkup(raw)));
check(markupToTex(String.raw`\textbf{x} & 5% {y} $z`) === String.raw`\textbackslash{}textbf\{x\} \& 5\% \{y\} \$z`,
  'LaTeX typed into a plan is escaped, never live', markupToTex(String.raw`\textbf{x} & 5% {y} $z`));
check(markupToTex('a *b* **c** 2 * 3') === String.raw`a \textit{b} \textbf{c} 2 * 3`,
  'italic and bold markers convert; a lone asterisk stays literal', markupToTex('a *b* **c** 2 * 3'));

// ── parse ───────────────────────────────────────────────────────────────
const model = parseResume(TEX);
check(model.bullets.length === 4, 'commented-out and preamble \\resumeItem are not bullets', `${model.bullets.length}`);
check(model.groups.length === 2 && model.groups[0].bullets.length === 3,
  'a comment line between bullets does not split their list');
check(model.bullets[0].context === 'EXPERIENCE > Acme > Infra | Storage' && model.bullets[3].context === 'EXPERIENCE > Acme > ML',
  'each bullet knows its section, entry and team', model.bullets[3].context);
check(model.bullets[0].block === 'acme-infra' && model.blocks.find((b) => b.id === 'acme-ml').parent === 'acme',
  'blocks nest and bullets report their innermost block');
check(describeResume(model).skills.text === 'Go, C++', 'the skills line is read from \\resumeSkills{label}{items}');
check(throws(() => parseResume(TEX.replace('% </block acme-ml>', '')), /mismatch|Unclosed/),
  'an unbalanced block marker is an error, not a silent mis-parse');

// ── apply ───────────────────────────────────────────────────────────────
const same = applyPlan(TEX, model, {});
check(same.tex === TEX, 'an empty plan reproduces the source byte for byte');

const rewritten = applyPlan(TEX, model, { bullets: { 'bullet-1': 'Led **3 engineers** on `tooling`' } });
check(rewritten.tex.includes(String.raw`\resumeItem{Led \textbf{3 engineers} on \code{tooling}}`)
  && rewritten.tex.includes(raw), 'a rewrite replaces one bullet and leaves its neighbours verbatim');

const reordered = applyPlan(TEX, model, { order: [['bullet-2', 'bullet-0']] });
check(reordered.bullets.join() === 'bullet-2,bullet-0,bullet-1,bullet-3',
  'order puts the named bullets first and keeps the rest', reordered.bullets.join());

const dropped = applyPlan(TEX, model, { drop: ['bullet-1', 'acme-ml'] });
check(!dropped.tex.includes('R\\&D') && !dropped.tex.includes('\\resumeTeam{ML}') && dropped.tex.includes('Third bullet.'),
  'drop removes a bullet and a whole block, heading included');
check(!/\n[ \t]*\n[ \t]*\\resumeItem/.test(dropped.tex), 'a dropped bullet leaves no blank line behind');

const swapped = applyPlan(TEX, model, { order: [['acme-ml', 'acme-infra']] });
check(swapped.tex.indexOf('\\resumeTeam{ML}') < swapped.tex.indexOf('\\resumeTeam{Infra')
  && swapped.bullets.join() === 'bullet-3,bullet-0,bullet-1,bullet-2', 'sibling blocks can trade places');

check(applyPlan(TEX, model, { skills: ['Rust', 'C#'] }).tex.includes(String.raw`\resumeSkills{SKILLS}{Rust, C\#}`),
  'skills accepts a list and escapes it');

check(throws(() => applyPlan(TEX, model, {}, ['bullet-3']), /no bullets under it; drop block "acme-ml"/),
  'a trim that would empty a list is refused and names the block to drop instead');
check(applyPlan(TEX, model, { drop: ['bullet-3'] }).emptied.length === 1,
  'the same drop asked for by name is honoured and reported');
check(throws(() => applyPlan(TEX, model, { bullets: { 'bullet-9': 'x' } }), /Unknown bullet id/),
  'a rewrite for a bullet that does not exist is an error');
check(throws(() => applyPlan(TEX, model, { order: [['bullet-0', 'bullet-3']] }), /different lists/),
  'bullets cannot be reordered across lists');

// ── fit ─────────────────────────────────────────────────────────────────
const probed = instrument(TEX);
check(probed.indexOf('ResumeFitProbe') < probed.indexOf('\\begin{document}')
  && probed.indexOf('RESUMEFIT end') < probed.lastIndexOf('\\end{document}'),
  'instrument adds the probe before \\begin{document} and the report before \\end{document}');

const log = (page, total) => [
  'RESUMEFIT item=0 lines=2', 'RESUMEFIT width=0 nat=560.0pt hsize=500.0pt',
  'RESUMEFIT item=1 lines=1', 'RESUMEFIT width=1 nat=300.0pt hsize=500.0pt',
  `RESUMEFIT end page=${page} total=${total}pt goal=800.0pt`,
].join('\n');
const full = fitVerdict(parseFitLog(log(1, '790.0')), 1);
check(full.fits && full.pages === 1 && full.sparePt === 10, 'content under the page height fits and reports its slack');
// The last line is counted before TeX ships the page, so the page counter
// still says 1 when that line does not fit.
const spill = fitVerdict(parseFitLog(log(1, '806.4')), 1);
check(!spill.fits && spill.pages === 2 && spill.overPt === 6.4,
  'content taller than the page is over the limit even while the page counter still reads 1', JSON.stringify(spill));
const second = fitVerdict(parseFitLog(log(2, '30.0')), 1);
check(!second.fits && second.pages === 2 && second.overPt === 30, 'material on a second page is reported as overflow');
check(fitVerdict(parseFitLog(log(2, '30.0')), 2).fits, 'the page limit is configurable');
check(parseFitLog('no report here') === null, 'a log without the report yields null, not a guessed page count');

const tight = tightenCandidates([
  { id: 'bullet-0', lines: 2, naturalPt: 560, measurePt: 500, chars: 112 },
  { id: 'bullet-1', lines: 1, naturalPt: 300, measurePt: 500, chars: 60 },
  { id: 'bullet-2', lines: 2, naturalPt: 950, measurePt: 500, chars: 190 },
]);
check(tight.length === 1 && tight[0].id === 'bullet-0' && tight[0].overhangChars === 15,
  'only a bullet with a short last line is offered for tightening', JSON.stringify(tight));

check(unverifiedNumbers('Cut latency 45% across 3 services', 'latency by 40% on 3 services').join() === '45',
  'a number that appears nowhere in the source material is flagged');
