import * as vscode from 'vscode';

/**
 * The commands on text: a selection into the panel or replaced by its translation, the clipboard
 * into the panel, a whole file into a new editor, and `translator.translate` for other extensions.
 */
export class TextCommands {

    /**
     * @param {import('./Translation').Translation} translation
     * @param {import('./TranslatorPanel').TranslatorPanel} panel
     */
    constructor(translation, panel) {
        this._translation = translation;
        this._panel = panel;
    }

    /** @returns {vscode.Disposable} */
    register() {
        const command = (id, run) => vscode.commands.registerCommand(id, run);
        return vscode.Disposable.from(
            command('translator.translateSelection', () => this._selection()),
            command('translator.replaceSelection', () => this._replace()),
            command('translator.translateInPlace', () => this._replace()),
            command('translator.translateClipboard', () => this._clipboard()),
            command('translator.translateFile', () => this._file()),
            command('translator.translate', (texts, options) => this._forExtensions(texts, options)),
        );
    }

    /** @returns {{ editor: vscode.TextEditor, selections: vscode.Selection[] } | null} the active editor with text selected */
    static _selected() {
        const editor = vscode.window.activeTextEditor;
        const selections = editor?.selections.filter(selection => !selection.isEmpty) ?? [];
        if (!editor || !selections.length) {
            vscode.window.showInformationMessage(vscode.l10n.t('Select the text to translate.'));
            return null;
        }
        return { editor, selections };
    }

    async _selection() {
        const selected = TextCommands._selected();
        if (!selected) return;
        const { editor, selections } = selected;
        await this._panel.showAndTranslate(selections.map(selection => editor.document.getText(selection)).join('\n'), editor.document.languageId === 'markdown');
    }

    async _clipboard() {
        const text = await vscode.env.clipboard.readText();
        if (!text.trim()) {
            vscode.window.showInformationMessage(vscode.l10n.t('The clipboard has no text.'));
            return;
        }
        await this._panel.showAndTranslate(text, false);
    }

    /**
     * @template T
     * @param {string} title
     * @param {(options: { signal: AbortSignal, onProgress: (done: number, total: number) => void }) => Promise<T>} run
     * @returns {Promise<T | undefined>} undefined when cancelled or failed (what went wrong is shown)
     */
    async _withProgress(title, run) {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
            const abort = new AbortController();
            token.onCancellationRequested(() => abort.abort());
            let last = 0;
            try {
                return await run({
                    signal: abort.signal,
                    onProgress: (done, total) => {
                        progress.report({ increment: ((done - last) / total) * 100, message: `${done} / ${total}` });
                        last = done;
                    },
                });
            } catch (error) {
                if (!abort.signal.aborted) await this._translation.offerDownload(await this._translation.failure(error));
                return undefined;
            }
        });
    }

    async _replace() {
        const selected = TextCommands._selected();
        if (!selected) return;
        const { editor: { document }, selections } = selected;
        const { version } = document;
        const markdown = document.languageId === 'markdown';
        const result = await this._withProgress(vscode.l10n.t('Translating the selection'), options => this._translation.translate(selections.map(selection => document.getText(selection)), { ...options, markdown }));
        if (!result) return;
        // The selection is of the text as it was: edited meanwhile, it would replace something else
        if (document.isClosed || document.version !== version) {
            vscode.window.showWarningMessage(vscode.l10n.t('The file changed while it was being translated: the selection is left as it is.'));
            return;
        }
        // Not through the editor: it may have been hidden by another tab meanwhile
        const edit = new vscode.WorkspaceEdit();
        selections.forEach((selection, index) => edit.replace(document.uri, selection, result.texts[index]));
        await vscode.workspace.applyEdit(edit);
    }

    async _file() {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) {
            vscode.window.showInformationMessage(vscode.l10n.t('Open the file to translate.'));
            return;
        }
        const markdown = document.languageId === 'markdown';
        const result = await this._withProgress(vscode.l10n.t('Translating the file'), options => this._translation.translate([document.getText()], { ...options, markdown }));
        if (!result) return;
        const opened = await vscode.workspace.openTextDocument({ language: document.languageId, content: result.texts[0] });
        await vscode.window.showTextDocument(opened, { preview: false });
    }

    /**
     * @param {string | string[]} texts
     * @param {{ from?: string, to?: string, markdown?: boolean }} [options]
     * @returns {Promise<string | string[]>} in the form given
     */
    async _forExtensions(texts, options) {
        const result = await this._translation.translate(Array.isArray(texts) ? texts.map(String) : [String(texts ?? '')], options ?? {});
        return Array.isArray(texts) ? result.texts : result.texts[0];
    }
}
