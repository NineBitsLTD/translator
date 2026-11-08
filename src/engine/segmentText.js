/**
 * @typedef {{ text: string, translate: boolean }} Segment a piece of a text; together they make it exactly
 */

const HAS_LETTERS = /\p{L}/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLOCK_PREFIX = /^(\s*(?:#{1,6}\s+|>+\s?|(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)+)/;
const LITERAL_LINE = /^(?: {4}|\t|\s*<\/?[a-zA-Z!]|\s*\[[^\]]+\]:\s|\s*(?:[-*_]\s*){3,}$|\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$)/;

/** What a sentence of Markdown cannot end inside: code in backticks, a link, an image (`!` is no end there). */
const UNBREAKABLE = /`+[^`\n]+`+|!?\[[^\]\n]*\]\([^)\n]*\)/g;

/**
 * @param {string} text
 * @param {string} language
 * @param {boolean} markdown
 * @returns {string[]} its sentences
 */
function sentencesOf(text, language, markdown) {
    const segmenter = new Intl.Segmenter(language, { granularity: 'sentence' });
    const sentences = [...segmenter.segment(text)].map(({ segment }) => segment);
    if (!markdown) return sentences;
    const spans = [...text.matchAll(UNBREAKABLE)].map(found => [found.index, found.index + found[0].length]);
    const joined = [];
    let at = 0;
    let goesOn = false;
    for (const sentence of sentences) {
        if (goesOn) joined[joined.length - 1] += sentence;
        else joined.push(sentence);
        at += sentence.length;
        goesOn = spans.some(([start, end]) => start < at && at < end);
    }
    return joined;
}

/**
 * Splits a part of a text into sentences; whitespace around them and parts without letters stay as they are.
 * @param {string} text
 * @param {string} language
 * @param {Segment[]} out
 * @param {boolean} [markdown]
 */
function pushSentences(text, language, out, markdown = false) {
    for (const segment of sentencesOf(text, language, markdown)) {
        const [, before, body, after] = segment.match(/^(\s*)([\s\S]*?)(\s*)$/);
        if (before) out.push({ text: before, translate: false });
        if (body) out.push({ text: body, translate: HAS_LETTERS.test(body) });
        if (after) out.push({ text: after, translate: false });
    }
}

/**
 * @param {Segment[]} segments
 * @returns {Segment[]} neighbours left as they are joined
 */
function mergeLiterals(segments) {
    const out = [];
    for (const segment of segments) {
        const last = out[out.length - 1];
        if (last && !last.translate && !segment.translate) last.text += segment.text;
        else if (segment.text) out.push({ ...segment });
    }
    return out;
}

/**
 * @param {string} line a row of a Markdown table
 * @param {string} language
 * @param {Segment[]} out its cells are translated one by one
 */
function pushTableRow(line, language, out) {
    for (const part of line.split(/(\|)/)) {
        if (part === '|') out.push({ text: part, translate: false });
        else pushSentences(part, language, out, true);
    }
}

/**
 * The lines of Markdown: code stays as it is, the signs of headings, lists and quotes stay out of the
 * translation, a paragraph wrapped over several lines is translated as one (it comes out on one line).
 * @param {string[]} parts lines and their line ends, alternating
 * @param {string} language
 * @param {Segment[]} out
 */
function pushMarkdown(parts, language, out) {
    let fence = null;
    /** @type {string[]} the lines of the paragraph being read */
    let paragraph = [];
    let paragraphEnd = '';
    const flush = () => {
        if (!paragraph.length) return;
        pushSentences(paragraph.join(' '), language, out, true);
        paragraph = [];
        out.push({ text: paragraphEnd, translate: false });
        paragraphEnd = '';
    };
    for (let at = 0; at < parts.length; at += 2) {
        const line = parts[at], end = parts[at + 1] ?? '';
        const opened = line.match(FENCE);
        if (fence) {
            out.push({ text: line + end, translate: false });
            if (opened && opened[1][0] === fence[0] && opened[1].length >= fence.length) fence = null;
            continue;
        }
        if (opened) {
            flush();
            fence = opened[1];
            out.push({ text: line + end, translate: false });
        } else if (!line.trim() || (LITERAL_LINE.test(line) && !paragraph.length) || /^\s*[-*_]{3,}\s*$/.test(line)) {
            flush();
            out.push({ text: line + end, translate: false });
        } else if (line.includes('|') && /^\s*\|/.test(line)) {
            flush();
            pushTableRow(line, language, out);
            out.push({ text: end, translate: false });
        } else {
            const prefix = line.match(BLOCK_PREFIX)?.[1] ?? '';
            if (prefix) {
                flush();
                out.push({ text: prefix, translate: false });
                paragraph = [line.slice(prefix.length)];
            } else {
                paragraph.push(line.trim());
            }
            paragraphEnd = end;
        }
    }
    flush();
}

/**
 * Splits a text into the parts to translate (sentences) and the parts that stay as they are (line
 * breaks, indentation, spaces around sentences, parts without letters, code and signs of Markdown).
 * @param {string} text
 * @param {{ language?: string, markdown?: boolean }} [options] language: of the text, tells sentences apart
 * @returns {Segment[]}
 */
export function segmentText(text, { language = 'en', markdown = false } = {}) {
    const parts = text.split(/(\r\n|\n|\r)/);
    /** @type {Segment[]} */
    const out = [];
    if (markdown) {
        pushMarkdown(parts, language, out);
    } else {
        parts.forEach((part, index) => {
            if (index % 2) out.push({ text: part, translate: false });
            else pushSentences(part, language, out);
        });
    }
    return mergeLiterals(out);
}
