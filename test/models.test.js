// Runs the real models: TRANSLATOR_TEST_MODELS=<folder with opus-mt-en-ru, opus-mt-ru-en, m2m100_418M> npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { TranslatorEngine } from '../src/engine/TranslatorEngine.js';

const root = process.env.TRANSLATOR_TEST_MODELS;
const options = { skip: root ? false : 'TRANSLATOR_TEST_MODELS is not set' };
const folder = name => join(root, name);
const runtime = () => createRequire(import.meta.url)('onnxruntime-node');
const engine = names => new TranslatorEngine({ runtime, folders: () => names.map(folder) });

test('Opus-MT: both directions', options, async () => {
    const e = engine(['opus-mt-en-ru', 'opus-mt-ru-en']);
    const to = await e.translate(['The server keeps running after the last window is closed.'], { from: 'en', to: 'ru' });
    assert.equal(to.texts[0], 'Сервер продолжает работать после закрытия последнего окна.');
    const back = await e.translate(['Откройте меню настроек и выберите нужную модель.'], { to: 'en' });
    assert.equal(back.from, 'ru');
    assert.match(back.texts[0], /menu/);
    await e.release();
});

test('M2M100: a language pair by its tokens', options, async () => {
    const e = engine(['m2m100_418M']);
    const out = await e.translate(['Hello, how are you?'], { from: 'en', to: 'uk' });
    assert.match(out.texts[0], /як/u);
    await e.release();
});

test('Opus-MT is taken before a multilingual model', options, async () => {
    const e = engine(['opus-mt-en-ru', 'm2m100_418M']);
    const route = await e.route('en', 'ru');
    assert.equal(route.length, 1);
    assert.ok(route[0].folder.endsWith('opus-mt-en-ru'));
    await e.release();
});

test('a whole text: lines kept, code untouched, whitespace exact', options, async () => {
    const e = engine(['opus-mt-en-ru']);
    const text = '  The file was saved.\n\nRun `npm install` before building the project.  \n';
    const { texts: [out] } = await e.translate([text], { from: 'en', to: 'ru' });
    assert.ok(out.startsWith('  '), JSON.stringify(out));
    assert.ok(out.endsWith('  \n'), JSON.stringify(out));
    assert.ok(out.includes('\n\n'));
    assert.ok(out.includes('`npm install`'), out);
    assert.match(out, /[а-я]/u);
    await e.release();
});

test('Markdown keeps its signs and code blocks', options, async () => {
    const e = engine(['opus-mt-en-ru']);
    const { texts: [out] } = await e.translate(['# Getting started\n\nThis is **very** important, see [the docs](https://x.y/z).\n\n```sh\nnpm run build\n```\n'], { from: 'en', to: 'ru', markdown: true });
    assert.ok(out.startsWith('# '), out);
    assert.ok(/\*\*[^*\s][^*]*\*\*/.test(out), out);
    assert.ok(out.includes('](https://x.y/z)'), out);
    assert.ok(out.includes('```sh\nnpm run build\n```'), out);
    await e.release();
});

test('progress per sentence, cancelling, the cache', options, async () => {
    const e = engine(['opus-mt-en-ru']);
    const seen = [];
    await e.translate(['One sentence here. Another sentence there.'], { from: 'en', to: 'ru', onProgress: (d, t) => seen.push([d, t]) });
    assert.deepEqual(seen, [[1, 2], [2, 2]]);
    const started = Date.now();
    await e.translate(['One sentence here. Another sentence there.'], { from: 'en', to: 'ru' });
    assert.ok(Date.now() - started < 30, 'a repeated text comes from the cache');
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(e.translate(['A new sentence to translate.'], { from: 'en', to: 'ru', signal: abort.signal }));
    await e.release();
});

test('a candidate that fits ranks first', options, async () => {
    const { TranslationModel } = await import('../src/engine/TranslationModel.js');
    const model = await TranslationModel.load(runtime(), folder('opus-mt-ru-en'));
    const ranked = await model.score('Разрешить', ['Allow', 'Deny', 'Cancel'], 'ru', 'en');
    assert.equal(ranked[0].text, 'Allow');
    await model.release();
});
