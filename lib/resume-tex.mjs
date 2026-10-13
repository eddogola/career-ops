/**
 * resume-tex.mjs — structural edits on a user-owned LaTeX resume.
 *
 * lib/latex-content.mjs can swap the text of a bullet. Tailoring a one-page
 * resume to a job needs more than that: bullets get dropped and reordered,
 * whole entries come out, and the emphasis the author put on a phrase
 * (\textbf, inline \code) has to survive a rewrite. This module does those
 * edits on the source text and never touches the preamble, so the layout the
 * author tuned is the layout that ships.
 *
 * The resume is read as a tree:
 *
 *   blocks   `% <block id>` ... `% </block id>` comment pairs. The author
 *            marks what may be dropped or reordered as a unit (an entry, a
 *            team, a section). Blocks nest.
 *   groups   runs of consecutive \resumeItem{...} calls: one bullet list.
 *   bullets  a single \resumeItem{...}, addressed as bullet-N in document
 *            order — the same numbering extract-latex-content.mjs produces.
 *   skills   the items argument of \resumeSkills{label}{items}.
 *
 * Text crosses the boundary as a small markup instead of LaTeX, so whoever
 * writes the plan never has to escape anything:
 *
 *   **bold**   \textbf{bold}
 *   `code`     \code{code}
 *   *italic*   \textit{italic}
 */

import { escapeLatex } from './latex-escape.mjs';
import { findMatchingBrace } from './latex-content.mjs';

const BLOCK_OPEN_RE = /^[ \t]*%[ \t]*<block[ \t]+([A-Za-z0-9_-]+)>[ \t]*$/;
const BLOCK_CLOSE_RE = /^[ \t]*%[ \t]*<\/block[ \t]+([A-Za-z0-9_-]+)>[ \t]*$/;

const WRAPPERS = {
  textbf: ['**', '**'],
  textit: ['*', '*'],
  emph: ['*', '*'],
  code: ['`', '`'],
  texttt: ['`', '`'],
};

const UNESCAPES = [
  [/\\textasciitilde(?:\{\}|\s+|(?![a-zA-Z]))/g, '~'],
  [/\\textasciicircum(?:\{\}|\s+|(?![a-zA-Z]))/g, '^'],
  [/\\textbar(?:\{\}|\s+|(?![a-zA-Z]))/g, '|'],
  [/\\textless(?:\{\}|\s+|(?![a-zA-Z]))/g, '<'],
  [/\\textgreater(?:\{\}|\s+|(?![a-zA-Z]))/g, '>'],
  [/\$\\pm\$/g, '±'],
  [/\$\\rightarrow\$/g, '→'],
  [/\\([&%$#_{}])/g, '$1'],
];

/**
 * LaTeX prose -> plan markup. Emphasis macros become their markers and the
 * escapes are undone; anything else is left as it stands.
 *
 * @param {string} raw
 * @returns {string}
 */
export function texToMarkup(raw) {
  let out = '';
  let i = 0;
  const macroRe = /\\(textbf|textit|emph|code|texttt)\{/g;
  for (;;) {
    macroRe.lastIndex = i;
    const m = macroRe.exec(raw);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = findMatchingBrace(raw, open);
    if (close === -1) break;
    const [pre, post] = WRAPPERS[m[1]];
    out += raw.slice(i, m.index) + pre + texToMarkup(raw.slice(open + 1, close)) + post;
    i = close + 1;
  }
  out += raw.slice(i);
  for (const [re, to] of UNESCAPES) out = out.replace(re, to);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Plan markup -> LaTeX prose. Escaping runs before the markers are read, so
 * LaTeX typed into a plan stays inert text.
 *
 * @param {string} text
 * @returns {string}
 */
export function markupToTex(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.split(/(`[^`]+`)/).map((part) => {
    if (/^`[^`]+`$/.test(part)) return `\\code{${escapeLatex(part.slice(1, -1))}}`;
    return escapeLatex(part)
      .replace(/\*\*([^*]+)\*\*/g, (_, inner) => `\\textbf{${inner}}`)
      .replace(/\*([^*]+)\*/g, (_, inner) => `\\textit{${inner}}`);
  }).join('');
}

/** Markup with the emphasis markers removed: what a reader sees. */
export function markupToPlain(text) {
  return String(text).replace(/\*\*|\*|`/g, '');
}

function isCommentedAt(tex, idx) {
  const lineStart = tex.lastIndexOf('\n', idx - 1) + 1;
  for (let i = lineStart; i < idx; i++) {
    if (tex[i] === '\\') { i++; continue; }
    if (tex[i] === '%') return true;
  }
  return false;
}

// Widen a macro call to its whole line when it has the line to itself, so
// that dropping it leaves no blank line behind.
function lineSpan(tex, start, end) {
  let s = start;
  while (s > 0 && (tex[s - 1] === ' ' || tex[s - 1] === '\t')) s--;
  let e = end;
  while (e < tex.length && (tex[e] === ' ' || tex[e] === '\t')) e++;
  const ownLine = (s === 0 || tex[s - 1] === '\n') && (e >= tex.length || tex[e] === '\n');
  return ownLine ? { start: s, end: Math.min(e + 1, tex.length) } : { start, end };
}

// What may sit between two bullets of the same list: blank lines and
// ordinary comments (an old bullet kept for reference). A block marker is a
// comment too, but it ends the list.
function isListGap(text) {
  return text.split('\n').every((line) => {
    const t = line.trim();
    return t === '' || (t.startsWith('%') && !BLOCK_OPEN_RE.test(line) && !BLOCK_CLOSE_RE.test(line));
  });
}

function bodyRange(tex) {
  const begin = tex.indexOf('\\begin{document}');
  const end = tex.lastIndexOf('\\end{document}');
  return { start: begin === -1 ? 0 : begin, end: end === -1 ? tex.length : end };
}

function readGroup(tex, from) {
  let i = from;
  while (i < tex.length && /\s/.test(tex[i])) i++;
  if (tex[i] !== '{') return null;
  const close = findMatchingBrace(tex, i);
  return close === -1 ? null : { open: i, close };
}

function parseBlocks(tex, body) {
  const blocks = [];
  const stack = [];
  let pos = body.start;
  while (pos < body.end) {
    const nl = tex.indexOf('\n', pos);
    const lineEnd = nl === -1 ? tex.length : nl;
    const line = tex.slice(pos, lineEnd);
    const open = line.match(BLOCK_OPEN_RE);
    const close = line.match(BLOCK_CLOSE_RE);
    if (open) {
      if (blocks.some((b) => b.id === open[1])) throw new Error(`Duplicate block id "${open[1]}"`);
      const block = {
        id: open[1],
        start: pos,
        end: -1,
        parent: stack.length ? stack[stack.length - 1].id : null,
      };
      blocks.push(block);
      stack.push(block);
    } else if (close) {
      const top = stack.pop();
      if (!top || top.id !== close[1]) {
        throw new Error(`Block marker mismatch: </block ${close[1]}> closes ${top ? `<block ${top.id}>` : 'nothing'}`);
      }
      top.end = Math.min(lineEnd + 1, tex.length);
    }
    pos = lineEnd + 1;
  }
  if (stack.length) throw new Error(`Unclosed block "${stack[stack.length - 1].id}"`);
  return blocks;
}

function parseHeadings(tex, body) {
  const headings = [];
  const re = /\\(resumeSection|resumeSubheading|resumeTeam|resumeProjectHeading)\s*\{/g;
  re.lastIndex = body.start;
  let m;
  while ((m = re.exec(tex)) !== null && m.index < body.end) {
    if (isCommentedAt(tex, m.index)) continue;
    const open = m.index + m[0].length - 1;
    const close = findMatchingBrace(tex, open);
    if (close === -1) continue;
    headings.push({
      at: m.index,
      level: m[1] === 'resumeSection' ? 'section' : m[1] === 'resumeTeam' ? 'team' : 'entry',
      title: markupToPlain(texToMarkup(tex.slice(open + 1, close))),
    });
  }
  return headings;
}

function contextAt(headings, at) {
  const ctx = { section: null, entry: null, team: null };
  for (const h of headings) {
    if (h.at > at) break;
    if (h.level === 'section') { ctx.section = h.title; ctx.entry = null; ctx.team = null; }
    else if (h.level === 'entry') { ctx.entry = h.title; ctx.team = null; }
    else ctx.team = h.title;
  }
  return ctx;
}

/**
 * Read a resume into blocks, bullet groups, bullets and the skills line.
 *
 * @param {string} tex
 * @returns {object} model — every span is an absolute offset into `tex`
 */
export function parseResume(tex) {
  const body = bodyRange(tex);
  const blocks = parseBlocks(tex, body);
  const headings = parseHeadings(tex, body);
  const innermost = (at) => {
    let best = null;
    for (const b of blocks) {
      if (b.start <= at && at < b.end && (!best || b.start > best.start)) best = b;
    }
    return best ? best.id : null;
  };

  const bullets = [];
  const needle = '\\resumeItem{';
  let from = body.start;
  for (;;) {
    const idx = tex.indexOf(needle, from);
    if (idx === -1 || idx >= body.end) break;
    from = idx + needle.length;
    if (isCommentedAt(tex, idx)) continue;
    const open = idx + needle.length - 1;
    const close = findMatchingBrace(tex, open);
    if (close === -1) break;
    from = close + 1;
    const raw = tex.slice(open + 1, close);
    const line = lineSpan(tex, idx, close + 1);
    const text = texToMarkup(raw);
    const ctx = contextAt(headings, idx);
    bullets.push({
      id: `bullet-${bullets.length}`,
      raw,
      text,
      // True when the markup cannot express the source exactly (a macro this
      // module does not know). Leaving the bullet alone keeps it verbatim.
      complex: /\\[a-zA-Z]|[{}$]/.test(text),
      call: { start: idx, end: close + 1 },
      line,
      lead: tex.slice(line.start, idx),
      trail: tex.slice(close + 1, line.end),
      block: innermost(idx),
      context: [ctx.section, ctx.entry, ctx.team].filter(Boolean).join(' > '),
    });
  }

  const groups = [];
  for (const b of bullets) {
    const last = groups[groups.length - 1];
    const prev = last && last.bullets[last.bullets.length - 1];
    if (prev && isListGap(tex.slice(prev.line.end, b.line.start))) {
      last.separators.push(tex.slice(prev.line.end, b.line.start));
      last.bullets.push(b);
      last.end = b.line.end;
    } else {
      groups.push({ index: groups.length, start: b.line.start, end: b.line.end, bullets: [b], separators: [] });
    }
    b.group = groups[groups.length - 1].index;
  }

  let skills = null;
  const skillsAt = tex.indexOf('\\resumeSkills', body.start);
  if (skillsAt !== -1 && skillsAt < body.end && !isCommentedAt(tex, skillsAt)) {
    const label = readGroup(tex, skillsAt + '\\resumeSkills'.length);
    const items = label && readGroup(tex, label.close + 1);
    if (items) {
      skills = {
        label: texToMarkup(tex.slice(label.open + 1, label.close)),
        text: texToMarkup(tex.slice(items.open + 1, items.close)),
        span: { start: items.open + 1, end: items.close },
      };
    }
  }

  return { body, blocks, groups, bullets, skills };
}

/**
 * The model as the plan author sees it: ids, where each bullet sits, and the
 * text in plan markup.
 *
 * @param {object} model
 * @returns {object}
 */
export function describeResume(model) {
  return {
    blocks: model.blocks.map((b) => ({
      id: b.id,
      parent: b.parent,
      bullets: model.bullets.filter((x) => x.line.start >= b.start && x.line.end <= b.end).map((x) => x.id),
    })),
    bullets: model.bullets.map((b) => ({
      id: b.id,
      context: b.context,
      block: b.block,
      group: b.group,
      text: b.text,
      ...(b.complex ? { complex: true, raw: b.raw } : {}),
    })),
    skills: model.skills ? { label: model.skills.label, text: model.skills.text } : null,
  };
}

function bulletTex(value) {
  if (value && typeof value === 'object' && typeof value.tex === 'string') return value.tex;
  if (typeof value === 'string') return markupToTex(value);
  throw new Error('A bullet rewrite must be a string, or {"tex": "..."} for raw LaTeX');
}

/**
 * Check a plan against the model and normalise it. Throws on the first thing
 * that cannot be honoured: a plan that half-applies would ship a resume the
 * author did not ask for.
 *
 * @param {object} model
 * @param {object} plan
 * @param {string[]} [extraDrops] ids dropped on top of plan.drop (fit trimming)
 * @returns {object} resolved edits
 */
export function resolvePlan(model, plan, extraDrops = []) {
  const bulletById = new Map(model.bullets.map((b) => [b.id, b]));
  const blockById = new Map(model.blocks.map((b) => [b.id, b]));
  const known = (id) => bulletById.has(id) || blockById.has(id);

  const rewrites = new Map();
  for (const [id, value] of Object.entries(plan.bullets ?? {})) {
    if (!bulletById.has(id)) throw new Error(`Unknown bullet id "${id}"`);
    rewrites.set(id, bulletTex(value));
  }

  const dropped = new Set();
  for (const id of [...(plan.drop ?? []), ...extraDrops]) {
    if (!known(id)) throw new Error(`Unknown id "${id}" in drop`);
    dropped.add(id);
  }
  const asked = new Set(plan.drop ?? []);
  const emptied = [];

  const inDroppedBlock = (at) => model.blocks.some((b) => dropped.has(b.id) && b.start <= at && at < b.end);

  const groupOrder = new Map();
  for (const order of plan.order ?? []) {
    if (!Array.isArray(order) || order.length === 0) throw new Error('Each entry of "order" must be a non-empty list of ids');
    if (new Set(order).size !== order.length) throw new Error(`"order" repeats an id: ${order.join(', ')}`);
    if (order.every((id) => bulletById.has(id))) {
      const g = bulletById.get(order[0]).group;
      if (order.some((id) => bulletById.get(id).group !== g)) {
        throw new Error(`"order" mixes bullets from different lists: ${order.join(', ')}`);
      }
      if (groupOrder.has(g)) throw new Error(`"order" lists the same bullet list twice: ${order.join(', ')}`);
      groupOrder.set(g, order);
    } else if (!order.every((id) => blockById.has(id))) {
      throw new Error(`"order" must list only bullets or only blocks: ${order.join(', ')}`);
    }
  }

  // Sibling blocks trade places: the block named first lands in the earliest
  // of their slots, and so on.
  const blockSwap = new Map();
  for (const order of plan.order ?? []) {
    if (!order.every((id) => blockById.has(id))) continue;
    const parent = blockById.get(order[0]).parent;
    if (order.some((id) => blockById.get(id).parent !== parent)) {
      throw new Error(`"order" mixes blocks that are not siblings: ${order.join(', ')}`);
    }
    const slots = [...order].sort((a, b) => blockById.get(a).start - blockById.get(b).start);
    slots.forEach((slot, i) => {
      if (blockSwap.has(slot)) throw new Error(`Block "${slot}" appears in two "order" lists`);
      blockSwap.set(slot, order[i]);
    });
  }

  const finalGroups = new Map();
  for (const g of model.groups) {
    if (inDroppedBlock(g.start)) continue;
    const ids = g.bullets.map((b) => b.id);
    const wanted = groupOrder.get(g.index);
    const ordered = wanted ? [...wanted, ...ids.filter((id) => !wanted.includes(id))] : ids;
    const kept = ordered.filter((id) => !dropped.has(id));
    if (kept.length === 0) {
      // A heading left with nothing under it is sometimes wanted (a degree
      // line with no coursework). That is the plan author's call to make by
      // name in "drop"; trimming to fit must never do it on its own.
      if (!ids.every((id) => asked.has(id))) {
        const block = g.bullets[0].block;
        throw new Error(
          `Dropping ${ids.join(', ')} leaves a heading with no bullets under it` +
          (block ? `; drop block "${block}" instead` : ''),
        );
      }
      emptied.push(g.bullets[0].context);
    }
    finalGroups.set(g.index, kept);
  }

  let skillsTex = null;
  if (plan.skills !== undefined && plan.skills !== null) {
    if (!model.skills) throw new Error('The plan sets "skills" but the resume has no \\resumeSkills{label}{items} line');
    const text = Array.isArray(plan.skills) ? plan.skills.join(', ') : plan.skills;
    if (typeof text !== 'string' || !text.trim()) throw new Error('"skills" must be a non-empty string or list');
    skillsTex = markupToTex(text);
  }

  return { rewrites, dropped, blockSwap, finalGroups, skillsTex, emptied, bulletById, blockById };
}

/**
 * Apply a plan to the source and return the tailored LaTeX.
 *
 * @param {string} tex
 * @param {object} model parseResume(tex)
 * @param {object} plan
 * @param {string[]} [extraDrops]
 * @returns {{tex: string, bullets: string[], dropped: string[], emptied: string[]}}
 *   `bullets` is the surviving bullet ids in the order they now appear;
 *   `emptied` names each heading the plan left with no bullets
 */
export function applyPlan(tex, model, plan, extraDrops = []) {
  const r = resolvePlan(model, plan, extraDrops);
  const order = [];

  const renderBullet = (b) => {
    order.push(b.id);
    const inner = r.rewrites.has(b.id) ? r.rewrites.get(b.id) : b.raw;
    return `${b.lead}\\resumeItem{${inner}}${b.trail}`;
  };

  const renderGroup = (g) => {
    const kept = r.finalGroups.get(g.index).map((id) => r.bulletById.get(id));
    return kept.map((b, i) => (i > 0 ? (g.separators[i - 1] ?? '') : '') + renderBullet(b)).join('');
  };

  // Children of a span: the blocks, groups and skills value that sit directly
  // inside it, not inside one of its child blocks.
  const childrenOf = (start, end, parentId) => {
    const kids = [];
    for (const b of model.blocks) {
      if (b.parent === parentId && b.start >= start && b.end <= end) kids.push({ kind: 'block', start: b.start, end: b.end, node: b });
    }
    const insideChildBlock = (at) => kids.some((k) => k.kind === 'block' && k.start <= at && at < k.end);
    for (const g of model.groups) {
      if (g.start >= start && g.end <= end && !insideChildBlock(g.start)) kids.push({ kind: 'group', start: g.start, end: g.end, node: g });
    }
    const s = model.skills;
    if (s && s.span.start >= start && s.span.end <= end && !insideChildBlock(s.span.start)) {
      kids.push({ kind: 'skills', start: s.span.start, end: s.span.end, node: s });
    }
    return kids.sort((a, b) => a.start - b.start);
  };

  const renderSpan = (start, end, parentId) => {
    let out = '';
    let pos = start;
    for (const kid of childrenOf(start, end, parentId)) {
      out += tex.slice(pos, kid.start);
      if (kid.kind === 'block') {
        const shown = r.blockById.get(r.blockSwap.get(kid.node.id) ?? kid.node.id);
        if (!r.dropped.has(shown.id)) out += renderSpan(shown.start, shown.end, shown.id);
      } else if (kid.kind === 'group') {
        out += renderGroup(kid.node);
      } else {
        out += r.skillsTex ?? tex.slice(kid.start, kid.end);
      }
      pos = kid.end;
    }
    return out + tex.slice(pos, end);
  };

  return {
    tex: renderSpan(0, tex.length, null),
    bullets: order,
    dropped: [...r.dropped],
    emptied: r.emptied,
  };
}

/**
 * Numbers that appear in the tailored text but nowhere in the candidate's
 * own material. A rewrite may rephrase a metric; it may not mint one.
 *
 * @param {string} tailored plain text of the rewritten bullets and skills
 * @param {string} corpus everything the candidate has actually written
 * @returns {string[]}
 */
export function unverifiedNumbers(tailored, corpus) {
  const numbers = (s) => s.match(/\d+(?:\.\d+)?/g) ?? [];
  const have = new Set(numbers(corpus));
  return [...new Set(numbers(tailored).filter((n) => !have.has(n)))];
}

// ── Fit measurement ─────────────────────────────────────────────────────

const PROBE_PREAMBLE = [
  '% --- resume-fit probe (build copy only) ---',
  '\\newcount\\ResumeFitN',
  '\\newcount\\ResumeFitLines',
  '\\providecommand{\\ResumeFitProbe}[1]{}',
  // \prevgraf reads 0 from inside \typeout, so it goes through a register.
  '\\renewcommand{\\ResumeFitProbe}[1]{%',
  '  \\ResumeFitLines=\\prevgraf',
  '  \\typeout{RESUMEFIT item=\\the\\ResumeFitN\\space lines=\\the\\ResumeFitLines}%',
  '  \\setbox0=\\hbox{#1}%',
  '  \\typeout{RESUMEFIT width=\\the\\ResumeFitN\\space nat=\\the\\wd0 \\space hsize=\\the\\dimexpr\\hsize-\\leftskip-\\rightskip\\relax}%',
  '  \\global\\advance\\ResumeFitN by 1 }',
  '',
].join('\n');

const PROBE_END =
  '\\par\\typeout{RESUMEFIT end page=\\the\\value{page}\\space total=\\the\\pagetotal\\space goal=\\the\\pagegoal}\n';

/**
 * Add the measurement hooks to a build copy. The resume's own
 * \ResumeFitProbe call (inside \resumeItem) reports each bullet; the line
 * before \end{document} reports how full the last page is.
 *
 * @param {string} tex
 * @returns {string}
 */
export function instrument(tex) {
  const begin = tex.indexOf('\\begin{document}');
  const end = tex.lastIndexOf('\\end{document}');
  if (begin === -1 || end === -1) throw new Error('Not a complete LaTeX document (missing \\begin{document} or \\end{document})');
  return tex.slice(0, begin) + PROBE_PREAMBLE + tex.slice(begin, end) + PROBE_END + tex.slice(end);
}

/**
 * Read the probe's lines back out of a TeX log.
 *
 * The end-of-document line is written before TeX ships the last page, so a
 * final line that does not fit still reports the page it started on. The
 * page count is therefore derived from how much material there is, not from
 * the page counter alone.
 *
 * @param {string} log
 * @returns {{contentPt: number, pagePt: number|null,
 *   items: Array<{lines: number, naturalPt: number|null, measurePt: number|null}>}|null}
 *   `contentPt` is the height of everything set, `pagePt` what one page
 *   holds; null when the log carries no end-of-document report
 */
export function parseFitLog(log) {
  // TeX wraps log lines at 79 columns; the probe's lines are short enough
  // not to wrap, but rejoin continuation lines anyway.
  let text = '';
  for (const line of log.split('\n')) text += line.length === 79 ? line : `${line}\n`;
  const items = [];
  for (const m of text.matchAll(/RESUMEFIT item=(\d+) lines=(\d+)/g)) {
    items[Number(m[1])] = { lines: Number(m[2]), naturalPt: null, measurePt: null };
  }
  for (const m of text.matchAll(/RESUMEFIT width=(\d+) nat=([\d.]+)pt\s+hsize=([\d.]+)pt/g)) {
    const item = items[Number(m[1])];
    if (item) { item.naturalPt = Number(m[2]); item.measurePt = Number(m[3]); }
  }
  const ends = [...text.matchAll(/RESUMEFIT end page=(\d+) total=([\d.]+)pt goal=([\d.]+)pt/g)];
  if (ends.length === 0) return null;
  const [, pageStr, totalStr, goalStr] = ends[ends.length - 1];
  const page = Number(pageStr);
  // \pagegoal is \maxdimen while the current page is still empty: the
  // material ended exactly at a page boundary.
  if (Number(goalStr) > 16000) return { contentPt: page - 1, pagePt: null, pagesExact: page - 1, items };
  const pagePt = Number(goalStr);
  return { contentPt: (page - 1) * pagePt + Number(totalStr), pagePt, pagesExact: null, items };
}

/**
 * Does the measured material fit in `maxPages`?
 *
 * @param {{contentPt: number, pagePt: number|null, pagesExact: number|null}} fit
 * @param {number} maxPages
 * @returns {{fits: boolean, pages: number, sparePt: number|null, overPt: number|null}}
 */
export function fitVerdict(fit, maxPages) {
  if (fit.pagePt === null) {
    const pages = Math.max(1, fit.pagesExact);
    return { fits: pages <= maxPages, pages, sparePt: pages <= maxPages ? 0 : null, overPt: null };
  }
  const capacity = maxPages * fit.pagePt;
  // A hundredth of a point of slack for rounding in the log's decimals.
  const fits = fit.contentPt <= capacity + 0.01;
  return {
    fits,
    pages: Math.max(1, Math.ceil((fit.contentPt - 0.01) / fit.pagePt)),
    sparePt: fits ? +(capacity - fit.contentPt).toFixed(2) : null,
    overPt: fits ? null : +(fit.contentPt - capacity).toFixed(2),
  };
}

/**
 * Bullets whose last line holds only a few words. Tightening one of these
 * gives a whole line back, which is cheaper than dropping a bullet.
 *
 * The estimate assumes full lines run about 15pt short of the measure (half a
 * typical word), so treat the character count as a floor.
 *
 * @param {Array<{id: string, lines: number, naturalPt: number|null, measurePt: number|null, chars: number}>} bullets
 * @returns {Array<{id: string, lines: number, overhangChars: number}>}
 */
export function tightenCandidates(bullets) {
  const out = [];
  for (const b of bullets) {
    if (b.lines < 2 || !b.naturalPt || !b.measurePt || !b.chars) continue;
    const overhang = b.naturalPt - (b.lines - 1) * (b.measurePt - 15);
    if (overhang <= 0 || overhang > 0.3 * b.measurePt) continue;
    out.push({ id: b.id, lines: b.lines, overhangChars: Math.ceil(overhang / (b.naturalPt / b.chars)) });
  }
  return out.sort((a, b) => a.overhangChars - b.overhangChars);
}
