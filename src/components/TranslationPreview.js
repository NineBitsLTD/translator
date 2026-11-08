import { posix } from 'node:path';
import * as vscode from 'vscode';

const SCHEME = 'translator-preview';

/**
 * The translation of a whole file shown next to it, read-only: a `FileSystemProvider` for the scheme
 * `translator-preview` (`translator-preview:<folder>/<name> (<language>).<extension>`). Markdown opens
 * in the preview of VS Code; what it refers to around the file (relative images) is read from the
 * disk. Showing a file again replaces its translation. The address has no query: the preview of VS
 * Code allows the folder of the address as it is, and a query there would deny every image.
 */
export class TranslationPreview {

    constructor() {
        /** @type {vscode.EventEmitter<vscode.FileChangeEvent[]>} */
        this._changed = new vscode.EventEmitter();
        this.onDidChangeFile = this._changed.event;
        /** @type {Map<string, { bytes: Uint8Array, time: number }>} by the path of the address */
        this._previews = new Map();
    }

    /** @returns {vscode.Disposable} */
    register() {
        return vscode.Disposable.from(
            vscode.workspace.registerFileSystemProvider(SCHEME, this, { isCaseSensitive: true, isReadonly: true }),
            this._changed,
        );
    }

    /**
     * @param {vscode.Uri} source the file
     * @param {string} language of the translation
     * @param {boolean} markdown
     * @returns {vscode.Uri} its extension tells VS Code the language of the text (an untitled file has none)
     */
    static _uriOf(source, language, markdown) {
        const { dir, name, ext } = posix.parse(source.path);
        const path = posix.join('/', dir, `${name} (${language})${ext || (markdown ? '.md' : '.txt')}`);
        return vscode.Uri.from({ scheme: SCHEME, path });
    }

    /**
     * @param {vscode.TextDocument} document the file
     * @param {string} text its translation
     * @param {string} language of the translation
     */
    async show(document, text, language) {
        const markdown = document.languageId === 'markdown';
        const uri = TranslationPreview._uriOf(document.uri, language, markdown);
        const shownBefore = this._previews.has(uri.path);
        this._previews.set(uri.path, { bytes: new TextEncoder().encode(text), time: Date.now() });
        if (shownBefore) this._changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        if (!markdown || !await TranslationPreview._showRendered(uri)) await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {Promise<boolean>} false when the Markdown extension of VS Code is turned off
     */
    static async _showRendered(uri) {
        try {
            await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
            return true;
        } catch {
            return false;
        }
    }

    /** @returns {{ bytes: Uint8Array, time: number }} what a preview restored with the window shows: its translation is gone */
    static _gone() {
        return { bytes: new TextEncoder().encode(vscode.l10n.t('This translation is no longer available: open it again with View Translation.')), time: 0 };
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {vscode.Uri} the file on the disk at its path
     */
    static _onDisk(uri) {
        return vscode.Uri.file(uri.path);
    }

    /**
     * @param {{ bytes: Uint8Array, time: number }} preview
     * @returns {vscode.FileStat}
     */
    static _statOf({ bytes, time }) {
        return { type: vscode.FileType.File, ctime: time, mtime: time, size: bytes.length };
    }

    /** @returns {vscode.Disposable} nothing to watch: a preview changes only when it is shown again */
    watch() {
        return new vscode.Disposable(() => {});
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {Promise<vscode.FileStat>}
     */
    async stat(uri) {
        const preview = this._previews.get(uri.path);
        if (preview) return TranslationPreview._statOf(preview);
        return vscode.workspace.fs.stat(TranslationPreview._onDisk(uri)).then(undefined, () => TranslationPreview._statOf(TranslationPreview._gone()));
    }

    /**
     * @param {vscode.Uri} uri
     * @returns {Promise<Uint8Array>}
     */
    async readFile(uri) {
        const preview = this._previews.get(uri.path);
        if (preview) return preview.bytes;
        return vscode.workspace.fs.readFile(TranslationPreview._onDisk(uri)).then(undefined, () => TranslationPreview._gone().bytes);
    }

    readDirectory() {
        throw vscode.FileSystemError.NoPermissions();
    }

    createDirectory() {
        throw vscode.FileSystemError.NoPermissions();
    }

    writeFile() {
        throw vscode.FileSystemError.NoPermissions();
    }

    delete() {
        throw vscode.FileSystemError.NoPermissions();
    }

    rename() {
        throw vscode.FileSystemError.NoPermissions();
    }
}
