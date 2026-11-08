// Runs inside VS Code's extension host (see run.mjs): the real API of VS Code and the real models.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');

/** @param {string} content @param {string} language */
async function openWith(content, language) {
    const document = await vscode.workspace.openTextDocument({ language, content });
    return vscode.window.showTextDocument(document);
}

exports.run = async function run() {
    const log = [];
    const step = async (name, body) => {
        const started = Date.now();
        try {
            const value = await body();
            log.push({ name, ms: Date.now() - started, value });
        } catch (error) {
            log.push({ name, ms: Date.now() - started, error: String(error?.stack ?? error) });
        }
    };
    const extension = vscode.extensions.getExtension('ninebits.translator');
    let api;
    await step('activate', async () => {
        api = await extension.activate();
        return Object.keys(api);
    });
    await step('download a model of the catalog', async () => {
        const models = () => vscode.workspace.getConfiguration('translator').get('models');
        const before = models().length;
        const added = new Promise(resolve => api.onDidChangeModels(() => { if (models().length > before) resolve(); }));
        assert.equal(await vscode.commands.executeCommand('translator.downloadModel', 'opus-mt-en-ru'), '');
        assert.notEqual(await vscode.commands.executeCommand('translator.downloadModel', 'no-such-model'), '');
        await added;
        const folder = models().at(-1);
        assert.ok(folder.endsWith('opus-mt-en-ru'), folder);
        const sizes = ['config.json', 'tokenizer_config.json', 'vocab.json', 'source.spm', 'target.spm', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'].map(name => fs.statSync(`${folder}/${name}`).size);
        assert.equal(fs.readdirSync(folder).filter(name => name.endsWith('.part')).length, 0);
        return sizes;
    });
    await step('routes', async () => {
        assert.equal(await api.canTranslate('en', 'ru'), true);
        assert.equal(await api.canTranslate('fr', 'uk'), true);
        assert.equal(await api.canTranslate('en', 'zz'), false);
        return 'ok';
    });
    await step('api: a string', async () => {
        const out = await api.translate('The server keeps running after the last window is closed.', { from: 'en', to: 'ru' });
        assert.match(out, /Сервер/u);
        return out;
    });
    await step('api: an array, the language told', async () => {
        const out = await api.translate(['Откройте меню настроек.', 'Файл сохранён.'], { to: 'en' });
        assert.equal(out.length, 2);
        assert.match(out[0], /menu|settings/i);
        return out;
    });
    await step('api: another family (M2M100)', async () => {
        const out = await api.translate('Hello, how are you?', { from: 'en', to: 'uk' });
        assert.match(out, /як/u);
        return out;
    });
    await step('api: no model', async () => {
        await assert.rejects(api.translate('Hello there', { from: 'en', to: 'zz' }), error => error.code === 'NO_MODEL');
        return 'rejected';
    });
    await step('command for extensions', async () => {
        const out = await vscode.commands.executeCommand('translator.translate', 'The file was saved.', { from: 'en', to: 'ru' });
        assert.match(out, /[а-я]/u);
        return out;
    });
    await step('replace selection in Markdown', async () => {
        const editor = await openWith('# Title\n\nThis is **very** important, run `npm install` first.\n', 'markdown');
        const line = editor.document.lineAt(2).range;
        editor.selection = new vscode.Selection(line.start, line.end);
        await vscode.commands.executeCommand('translator.replaceSelection');
        const text = editor.document.getText();
        assert.ok(text.startsWith('# Title\n\n'), text);
        assert.ok(text.includes('`npm install`'), text);
        assert.match(text, /\*\*[^*]+\*\*/u);
        assert.match(text, /[а-я]/u);
        return text;
    });
    await step('translate a file into a new editor', async () => {
        const editor = await openWith('First line of the text.\n\nSecond paragraph here.\n', 'plaintext');
        await vscode.commands.executeCommand('translator.translateFile');
        const opened = vscode.window.activeTextEditor;
        assert.notEqual(opened.document, editor.document);
        assert.match(opened.document.getText(), /[а-я]/u);
        assert.ok(opened.document.getText().includes('\n\n'));
        return opened.document.getText();
    });
    await step('the side bar opens', async () => {
        await vscode.commands.executeCommand('translator.panel.focus');
        return 'ok';
    });
    fs.writeFileSync(process.env.TRANSLATOR_E2E_RESULT, JSON.stringify({ electron: process.versions.electron, node: process.versions.node, log }, null, 2));
};
