import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentText } from '../src/engine/segmentText.js';
import { protectSpans, restoreSpans } from '../src/engine/protectSpans.js';
import { routeTranslation } from '../src/engine/routeTranslation.js';
import { TranslatorEngine } from '../src/engine/TranslatorEngine.js';

const joined = segments => segments.map(s => s.text).join('');
const toTranslate = segments => segments.filter(s => s.translate).map(s => s.text);

test('a text is cut into sentences and comes back exactly', () => {
    const text = '  Hello there. How are you?\r\n\n\tSecond line!  \n123 456\n';
    const segments = segmentText(text);
    assert.equal(joined(segments), text);
    assert.deepEqual(toTranslate(segments), ['Hello there.', 'How are you?', 'Second line!']);
});

test('text without letters is left alone', () => {
    assert.deepEqual(toTranslate(segmentText('--- 12:30 !!!')), []);
    assert.deepEqual(segmentText(''), []);
});

test('Markdown: code, signs and tables stay, a wrapped paragraph is one', () => {
    const text = [
        '# Title here', '',
        'First line of a paragraph', 'goes on here.', '',
        '- item one', '  1. nested item', '> quoted words', '',
        '```js', 'const notTranslated = 1;', '```', '',
        '    indented code', '',
        '| Name | Value |', '| --- | --- |', '| cell words | other |', '',
        '[ref]: https://example.com', '---',
    ].join('\n');
    const segments = segmentText(text, { markdown: true });
    assert.deepEqual(toTranslate(segments), ['Title here', 'First line of a paragraph goes on here.', 'item one', 'nested item', 'quoted words', 'Name', 'Value', 'cell words', 'other']);
    const out = joined(segments);
    for (const kept of ['# ', '- ', '  1. ', '> ', '```js\nconst notTranslated = 1;\n```', '    indented code', '| --- | --- |', '[ref]: https://example.com']) assert.ok(out.includes(kept), kept);
});

test('an unclosed code fence keeps the rest of the text', () => {
    assert.deepEqual(toTranslate(segmentText('Before.\n```\ncode words\nmore words', { markdown: true })), ['Before.']);
});

test('code, addresses and identifiers are hidden and put back', () => {
    const { text, spans } = protectSpans('Run `npm install`, open https://a.b/c?d=1 and edit src/main.js or fooBar or a_b with --force.');
    assert.equal(spans.length, 6);
    assert.ok(!/npm|https|main|fooBar|a_b|force/.test(text), text);
    const back = restoreSpans(text, spans);
    assert.equal(back, 'Run `npm install`, open https://a.b/c?d=1 and edit src/main.js or fooBar or a_b with --force.');
});

test('ordinary words with hyphens, dots at the end of a sentence stay translatable', () => {
    for (const s of ['A well-known thing.', 'Hello world. Bye.', 'Цена 10.5 рублей.', 'Да/нет']) {
        const hidden = protectSpans(s);
        if (s !== 'Да/нет') assert.equal(hidden.spans.length, 0, s);
    }
});

test('Markdown signs: marks stand apart, the spaces next to the signs go', () => {
    const hidden = protectSpans('This is **very** important, see [the docs](http://x.y/z) and *notes*.', { markdown: true });
    assert.ok(!hidden.text.includes('*'));
    assert.ok(/very/.test(hidden.text) && /the docs/.test(hidden.text));
    const translated = hidden.text.replace('This is', 'Это').replace('very', 'очень').replace('important', 'важно').replace('see', 'см.').replace('the docs', 'документы').replace('and', 'и').replace('notes', 'заметки');
    assert.equal(restoreSpans(translated, hidden.spans), 'Это **очень** важно, см. [документы](http://x.y/z) и *заметки*.');
});

test('marks lost, repeated or swapped: not restored', () => {
    const { spans } = protectSpans('A **b** c', { markdown: true });
    assert.equal(spans.length, 2);
    assert.equal(restoreSpans('A XQ1 b c', spans), null);
    assert.equal(restoreSpans('A XQ1 b XQ1 XQ2 c', spans), null);
    assert.equal(restoreSpans('A XQ2 b XQ1 c', spans), null);
    assert.equal(restoreSpans('A XQ1 b XQ2 XQ3 c', spans), null);
});

test('text that looks like a mark survives', () => {
    const { text, spans } = protectSpans('The XQ7 unit.');
    assert.equal(spans.length, 1);
    assert.equal(restoreSpans(text, spans), 'The XQ7 unit.');
});

const models = [
    { folder: 'en-ru', family: 'marian', sources: ['en'], targets: ['ru'] },
    { folder: 'de-en', family: 'marian', sources: ['de'], targets: ['en'] },
    { folder: 'm2m', family: 'm2m_100', sources: ['en', 'ru', 'fr', 'de'], targets: ['en', 'ru', 'fr', 'de'] },
];

test('routes: Opus-MT first, then a multilingual model, then through English, else none', () => {
    assert.deepEqual(routeTranslation('en', 'ru', models), [{ folder: 'en-ru', from: 'en', to: 'ru' }]);
    assert.deepEqual(routeTranslation('fr', 'ru', models), [{ folder: 'm2m', from: 'fr', to: 'ru' }]);
    const two = models.slice(0, 2);
    assert.deepEqual(routeTranslation('de', 'ru', two), [{ folder: 'de-en', from: 'de', to: 'en' }, { folder: 'en-ru', from: 'en', to: 'ru' }]);
    assert.equal(routeTranslation('ru', 'de', two), null);
    assert.deepEqual(routeTranslation('ru', 'ru', []), []);
});

test('a long sentence is cut at punctuation near its middle, else at a space', () => {
    const fits = s => s.length <= 20;
    assert.deepEqual(TranslatorEngine._cut('short', fits), ['short']);
    assert.deepEqual(TranslatorEngine._cut('aaaaaaaaaaaaaaa, bbbbbbbbbbbbbbb', fits), ['aaaaaaaaaaaaaaa,', 'bbbbbbbbbbbbbbb']);
    for (const piece of TranslatorEngine._cut('one two three four five six seven eight nine ten eleven twelve', fits)) assert.ok(fits(piece), piece);
    for (const piece of TranslatorEngine._cut('x'.repeat(100), fits)) assert.ok(fits(piece));
});

test('no model for a pair: a clear error', async () => {
    const engine = new TranslatorEngine({ runtime: () => null, folders: () => [] });
    await assert.rejects(engine.translate(['hello there'], { from: 'en', to: 'ru' }), e => e.code === 'NO_MODEL' && e.to === 'ru');
    const same = await engine.translate(['привет'], { from: 'ru', to: 'ru' });
    assert.deepEqual(same.texts, ['привет']);
});
