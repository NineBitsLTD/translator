/**
 * @typedef {{ text: string, glue: 'none' | 'next' | 'previous' }} Span a protected part; glue: the
 *   whitespace after it (an opening sign) or before it (a closing sign) is not kept
 * @typedef {{ text: string, spans: Span[], parts: { text: string, literal: boolean }[] }} Protected
 *   text: with a mark in place of each span; parts: the sentence, cut at the spans
 */

const mark = index => `XQ${index}`;
const MARKS = /XQ(\d+)/g;
const MARKS_ONLY = /^XQ\d+$/;

/** Code in backticks: hidden first, whatever is inside it stays. */
const BACKTICKS = /`+[^`\n]+`+/g;
/** A link of Markdown: `[text](address)`, its text is translated. */
const LINK = /(!?\[)([^\]\n]*)(\]\([^)\n]*\))/gu;
/** What is never translated, in any text: addresses, names of files and identifiers. */
const CODE = new RegExp([
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()"'`]+/.source,
    /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.source,
    /(?<![\p{L}\p{N}])--?[a-zA-Z][\w-]*/.source,
    /(?<![\p{L}\p{N}])[~.]{0,2}[\w.-]*[/\\][\w./\\-]*[\w/\\]/.source,
    /(?<![\p{L}\p{N}])[\w-]+\.(?:[a-z][a-z0-9]{0,4})(?![\p{L}\p{N}])/.source,
    /(?<![\p{L}\p{N}])[a-z]+(?:[A-Z][a-z0-9]*)+(?![\p{L}\p{N}])/.source,
    /(?<![\p{L}\p{N}])\w+_\w+(?![\p{L}\p{N}])/.source,
    /(?<![\p{L}\p{N}])[\w.]+\(\)/.source,
].join('|'), 'gu');

/** Signs of emphasis with text inside: `**text**`, `__text__`, `~~text~~`, `*text*`, `_text_`. */
const EMPHASIS = [
    /(\*\*)(?=\S)([^\n]*?\S)(\*\*)/gu,
    /(?<![\p{L}\p{N}_])(__)(?=\S)([^\n]*?\S)(__)(?![\p{L}\p{N}_])/gu,
    /(~~)(?=\S)([^\n]*?\S)(~~)/gu,
    /(?<![\p{L}\p{N}*])(\*)(?=[^\s*])([^*\n]*?[^\s*])(\*)(?![\p{L}\p{N}*])/gu,
    /(?<![\p{L}\p{N}_])(_)(?=[^\s_])([^_\n]*?[^\s_])(_)(?![\p{L}\p{N}_])/gu,
];

/**
 * Hides from a translation model what it would spoil: each span becomes a mark it carries over
 * (`XQ1`). The marks of paired signs stand apart from the words inside them.
 * @param {string} sentence
 * @param {{ markdown?: boolean }} [options]
 * @returns {Protected}
 */
export function protectSpans(sentence, { markdown = false } = {}) {
    /** @type {Span[]} */
    const spans = [];
    const hide = (text, glue = 'none') => {
        spans.push({ text, glue });
        return mark(spans.length);
    };
    const hidePair = (found, open, inside, close) => `${hide(open, 'next')} ${inside} ${hide(close, 'previous')}`;
    // A mark never ends up inside a span: what holds an address or code is hidden before them
    let text = sentence.replace(/XQ\d+/g, found => hide(found)).replace(BACKTICKS, found => hide(found));
    if (markdown) text = text.replace(LINK, hidePair);
    text = text.replace(CODE, found => (MARKS_ONLY.test(found) ? found : hide(found)));
    if (markdown) for (const pattern of EMPHASIS) text = text.replace(pattern, hidePair);
    return { text, spans, parts: cutAtMarks(text, spans) };
}

/**
 * @param {string} text with marks
 * @param {Span[]} spans
 * @returns {{ text: string, literal: boolean }[]} the words and the spans in their order
 */
function cutAtMarks(text, spans) {
    const parts = [];
    let from = 0;
    for (const found of text.matchAll(MARKS)) {
        const span = spans[Number(found[1]) - 1];
        let before = text.slice(from, found.index);
        let next = found.index + found[0].length;
        if (span.glue === 'previous') before = before.trimEnd();
        if (span.glue === 'next' && text[next] === ' ') next++;
        if (before) parts.push({ text: before, literal: false });
        parts.push({ text: span.text, literal: true });
        from = next;
    }
    if (from < text.length) parts.push({ text: text.slice(from), literal: false });
    return parts;
}

/**
 * Puts the spans back into a translation.
 * @param {string} translated
 * @param {Span[]} spans
 * @returns {string | null} null when the model lost, repeated or swapped the marks of a pair
 */
export function restoreSpans(translated, spans) {
    const positions = new Map();
    for (const found of translated.matchAll(MARKS)) {
        const index = Number(found[1]);
        if (positions.has(index) || index < 1 || index > spans.length) return null;
        positions.set(index, found.index);
    }
    if (positions.size !== spans.length) return null;
    for (let index = 1; index <= spans.length; index++) {
        // A closing sign follows its opening sign, the mark before it in the source
        if (spans[index - 1].glue === 'previous' && !(positions.get(index - 1) < positions.get(index))) return null;
    }
    return translated.replace(/(\s*)XQ(\d+)(\s*)/g, (found, before, number, after) => {
        const span = spans[Number(number) - 1];
        return `${span.glue === 'previous' ? '' : before}${span.text}${span.glue === 'next' ? '' : after}`;
    });
}
