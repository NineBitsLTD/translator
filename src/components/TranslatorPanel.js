import * as vscode from 'vscode';
import { createNonce } from '../utils/createNonce';
import { catalogLanguages } from './modelCatalog';
import { Translation } from './Translation';
import { TranslatorSettings } from './TranslatorSettings';

/** The languages at the top of the lists. */
const FIRST_LANGUAGES = ['ru', 'uk', 'en'];

/**
 * The side bar of the translator (`translator.panel`): languages, the text and its translation, and
 * the models. The webview (`src/panel.js`) asks and shows; everything is done here.
 * @implements {vscode.WebviewViewProvider}
 */
export class TranslatorPanel {

    /**
     * @param {vscode.ExtensionContext} context
     * @param {import('./TranslatorSettings').TranslatorSettings} settings
     * @param {Translation} translation
     * @param {import('./SpeechExtension').SpeechExtension} speech
     */
    constructor(context, settings, translation, speech) {
        this._context = context;
        this._settings = settings;
        this._translation = translation;
        this._speech = speech;
        /** @type {vscode.WebviewView | null} */
        this._view = null;
        /** @type {any} what to show once the webview is ready */
        this._waiting = null;
        /** @type {AbortController | null} */
        this._running = null;
        this._ready = false;
    }

    /** @returns {vscode.Disposable} */
    register() {
        const { models } = this._translation;
        return vscode.Disposable.from(
            vscode.window.registerWebviewViewProvider('translator.panel', this, { webviewOptions: { retainContextWhenHidden: true } }),
            this._settings.onDidChange(() => this._sendState()),
            models.onDidChange(() => this._sendState()),
            this._speech.onDidChange(() => this._sendState()),
            models.onProgress(progress => this._post({ type: 'progress', ...progress })),
        );
    }

    /** @param {any} message */
    _post(message) {
        this._view?.webview.postMessage(message);
    }

    /** @param {vscode.WebviewView} view */
    resolveWebviewView(view) {
        this._view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'dist')] };
        view.webview.html = this._html(view.webview);
        view.webview.onDidReceiveMessage(message => this._onMessage(message));
        view.onDidDispose(() => {
            this._view = null;
            this._ready = false;
            this._speech.stopSpeaking();
            this._speech.stopRecording();
        });
    }

    /**
     * Shows a text in the side bar and translates it.
     * @param {string} text
     * @param {boolean} markdown
     */
    async showAndTranslate(text, markdown) {
        await vscode.commands.executeCommand('translator.panel.focus');
        const message = { type: 'translateText', text, markdown };
        if (this._ready) this._post(message);
        else this._waiting = message;
    }

    async _sendState() {
        if (!this._view) return;
        const settings = this._settings.get();
        const { models } = this._translation;
        const languages = [...new Set([...catalogLanguages(), ...(await models.list()).flatMap(model => [...model.sources, ...model.targets])])]
            .map(code => ({ code, name: Translation.languageName(code) }))
            .sort((a, b) => TranslatorPanel._rank(a.code) - TranslatorPanel._rank(b.code) || a.name.localeCompare(b.name));
        this._post({
            type: 'state',
            from: settings.source,
            to: settings.target || TranslatorSettings.uiLanguage(),
            languages,
            models: await models.list(),
            catalog: models.catalog().map(({ key, family, sources, targets, size, license, added }) => ({ key, family, sources: family === 'marian' ? sources : [], targets: family === 'marian' ? targets : [], languageCount: sources.length, size, license, added })),
            pending: Object.fromEntries(models.pending),
            speech: this._speech.found,
        });
    }

    /** @param {string} code @returns {number} */
    static _rank(code) {
        const at = FIRST_LANGUAGES.indexOf(code);
        return at < 0 ? FIRST_LANGUAGES.length : at;
    }

    /** @param {any} message */
    async _onMessage(message) {
        const { models } = this._translation;
        const reply = result => this._post({ type: 'hostReply', requestId: message.requestId, result });
        switch (message?.type) {
            case 'ready':
                this._ready = true;
                this._post({ type: 'init', strings: TranslatorPanel._strings() });
                await this._sendState();
                if (this._waiting) this._post(this._waiting);
                this._waiting = null;
                break;
            case 'translate':
                reply(await this._translate(message));
                break;
            case 'cancel':
                this._running?.abort();
                break;
            case 'languages':
                await this._settings.update('sourceLanguage', message.from);
                await this._settings.update('targetLanguage', message.to);
                break;
            case 'selection': {
                const editor = vscode.window.activeTextEditor;
                const selected = editor?.selections.filter(selection => !selection.isEmpty) ?? [];
                reply({ text: selected.map(selection => editor.document.getText(selection)).join('\n'), markdown: editor?.document.languageId === 'markdown' });
                break;
            }
            case 'clipboard':
                reply({ text: await vscode.env.clipboard.readText() });
                break;
            case 'copy':
                await vscode.env.clipboard.writeText(String(message.text ?? ''));
                break;
            case 'replace':
                reply(await TranslatorPanel._replaceSelection(String(message.text ?? '')));
                break;
            case 'speak': {
                const text = String(message.text ?? '');
                reply(await this._speech.speak(text, message.language === 'auto' ? this._translation.engine.detect(text) : message.language));
                break;
            }
            case 'stopSpeaking':
                this._speech.stopSpeaking();
                break;
            case 'record':
                reply(await this._speech.record());
                break;
            case 'stopRecording':
                this._speech.stopRecording();
                break;
            case 'download': {
                const refused = models.download(message.key);
                if (refused) vscode.window.showWarningMessage(refused);
                break;
            }
            case 'browseFolder':
                reply(await models.browseFolder());
                break;
            case 'addModel':
                reply(message.key ? models.download(String(message.key)) : await models.addFolder(String(message.folder ?? '')));
                break;
            case 'modelActive':
                await models.setActive(message.folder, !!message.active);
                break;
            case 'remove':
                await models.remove(message.folder);
                break;
            case 'reveal':
                models.reveal(message.folder);
                break;
        }
    }

    /**
     * @param {{ text: string, from?: string, to?: string, markdown?: boolean }} message
     * @returns {Promise<object>} the translation, or a failure to show
     */
    async _translate({ text, from, to, markdown }) {
        this._running?.abort();
        const abort = new AbortController();
        this._running = abort;
        try {
            const result = await this._translation.translate([String(text ?? '')], {
                from, to, markdown: !!markdown, signal: abort.signal,
                onProgress: (done, total) => this._post({ type: 'translating', done, total }),
            });
            return { text: result.texts[0], from: result.from, to: result.to, route: result.route.map(hop => hop.folder.split(/[/\\]/).pop()) };
        } catch (error) {
            return abort.signal.aborted ? { cancelled: true } : await this._translation.failure(error);
        } finally {
            if (this._running === abort) this._running = null;
        }
    }

    /**
     * @param {string} text
     * @returns {Promise<{ error?: string }>}
     */
    static async _replaceSelection(text) {
        const editor = vscode.window.visibleTextEditors.find(item => item === vscode.window.activeTextEditor) ?? vscode.window.visibleTextEditors.find(item => !item.selection.isEmpty);
        if (!editor || editor.selection.isEmpty) return { error: vscode.l10n.t('Select the text to replace in an editor.') };
        await editor.edit(edit => edit.replace(editor.selection, text));
        return {};
    }

    /**
     * @param {vscode.Webview} webview
     * @returns {string}
     */
    _html(webview) {
        const nonce = createNonce();
        const dist = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', ...parts));
        const csp = ["default-src 'none'", `script-src 'nonce-${nonce}'`, `style-src ${webview.cspSource} 'unsafe-inline'`, `font-src ${webview.cspSource}`].join('; ');
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${dist('codicons', 'codicon.css')}" rel="stylesheet">
<link href="${dist('css', 'panel.css')}" rel="stylesheet">
<title>Translator</title>
</head>
<body>
<div class="tr"></div>
<script nonce="${nonce}" src="${dist('js', 'panel.js')}"></script>
</body>
</html>`;
    }

    /** @returns {Record<string, string>} the texts of the webview in the language of VS Code */
    static _strings() {
        const t = vscode.l10n.t;
        return {
            auto: t('Auto'),
            autoTitle: t('Tell the language by the letters of the text'),
            swap: t('Swap the languages'),
            source: t('Text to translate (⌘Enter or Ctrl+Enter translates)'),
            translation: t('Translation'),
            translate: t('Translate'),
            stop: t('Stop'),
            selection: t('Selection'),
            selectionTitle: t('Take the text selected in the editor and translate it'),
            clipboard: t('Clipboard'),
            clipboardTitle: t('Take the text of the clipboard and translate it'),
            copy: t('Copy'),
            replace: t('Replace selection'),
            replaceTitle: t('Put the translation in place of the text selected in the editor'),
            speak: t('Read aloud'),
            stopSpeaking: t('Stop reading aloud'),
            record: t('Record speech and translate it'),
            stopRecording: t('End the recording'),
            listening: t('Listening: a pause ends the recording'),
            nothingHeard: t('No speech was heard.'),
            working: t('Translating: {0} of {1}'),
            done: t('{0} → {1}, by {2}'),
            same: t('The text is in {0} already.'),
            nothingSelected: t('No text is selected in the editor.'),
            emptyClipboard: t('The clipboard has no text.'),
            models: t('Models'),
            noModels: t('No models yet: download one below.'),
            broken: t('cannot be used: {0}'),
            useModel: t('Use this model'),
            reveal: t('Show in the file manager'),
            remove: t('Remove'),
            addModel: t('Add a model'),
            filter: t('Filter by language'),
            noMatch: t('No model matches the filter.'),
            folderOnDisk: t('Folder on the disk'),
            noFolder: t('No folder chosen'),
            browse: t('Browse…'),
            cancel: t('Cancel'),
            fromDiskTitle: t('Use a model already on the disk (a folder with config.json, the tokenizer and ONNX files)'),
            download: t('Download'),
            downloadWay: t('Download {0} ({1} MB)'),
            downloading: t('downloading {0}%'),
            downloadingTitle: t('Downloading {0}%; the notification can cancel it'),
            amount: t('{0} of {1} {2}'),
            megabytes: t('MB'),
            gigabytes: t('GB'),
            added: t('added'),
            sizeMb: t('{0} MB'),
            multilingual: t('all pairs of {0} languages'),
        };
    }
}
