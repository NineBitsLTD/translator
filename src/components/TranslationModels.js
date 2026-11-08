import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';
import { readModelInfo } from '../engine/TranslationModel.js';
import { MODEL_CATALOG } from './modelCatalog';

/** How often the bytes written of a model being downloaded are told (ms). */
const PROGRESS_INTERVAL = 250;

/**
 * @typedef {object} InstalledModel a model of the settings, as its files tell
 * @property {string} folder
 * @property {string} name
 * @property {string} family `marian`, `m2m_100` ('' : not a model)
 * @property {string[]} sources
 * @property {string[]} targets
 * @property {number} size bytes
 * @property {boolean} stored whether it is in the storage of the extension
 * @property {boolean} ready whether it can be used
 * @property {boolean} active whether translations use it
 * @property {string} error why not
 * @property {string} license of a model of the catalog
 */

/**
 * @param {string} folder
 * @returns {Promise<number>} the bytes of the files in it
 */
async function folderSize(folder) {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const sizes = await Promise.all(entries.map(entry => (entry.isDirectory() ? folderSize(join(folder, entry.name)) : stat(join(folder, entry.name)).then(info => info.size, () => 0))));
    return sizes.reduce((sum, size) => sum + size, 0);
}

/**
 * The translation models (`translator.models`): folders chosen on the disk, used where they are, or
 * downloaded from the catalog into the storage of the extension (`models/<key>/`) in the background
 * with a notification that can cancel it — listed as downloading meanwhile, added when ready.
 * Removing a model of the storage deletes its folder; one used where it is only leaves the list.
 */
export class TranslationModels {

    /**
     * @param {vscode.ExtensionContext} context
     * @param {import('./TranslatorSettings').TranslatorSettings} settings
     */
    constructor(context, settings) {
        this._settings = settings;
        this.folder = join(context.globalStorageUri.fsPath, 'models');
        /** @type {Map<string, { done: number, total: number }>} the models being downloaded, by key */
        this.pending = new Map();
        /** @type {vscode.EventEmitter<void>} */
        this._changed = new vscode.EventEmitter();
        /** A download began or ended. */
        this.onDidChange = this._changed.event;
        /** @type {vscode.EventEmitter<{ key: string, done: number, total: number }>} */
        this._progress = new vscode.EventEmitter();
        /** The bytes written of a model being downloaded, every `PROGRESS_INTERVAL` at most. */
        this.onProgress = this._progress.event;
    }

    dispose() {
        this._changed.dispose();
        this._progress.dispose();
    }

    /** @param {string} folder @returns {boolean} */
    isStored(folder) {
        const inside = relative(this.folder, folder);
        return !!inside && !inside.startsWith('..') && !isAbsolute(inside) && inside.split(sep).length === 1;
    }

    /** @returns {Set<string>} the keys of the models installed or being downloaded */
    installedKeys() {
        return new Set([...this._settings.get().models.map(folder => basename(folder)), ...this.pending.keys()]);
    }

    /** @returns {Promise<InstalledModel[]>} */
    list() {
        return Promise.all(this._settings.get().models.map(folder => this._describe(folder)));
    }

    /**
     * @param {string} folder
     * @returns {Promise<InstalledModel>}
     */
    async _describe(folder) {
        const name = basename(folder);
        const base = { folder, name, stored: this.isStored(folder), active: this._settings.activeModels().includes(folder), license: MODEL_CATALOG.find(entry => entry.key === name)?.license ?? '' };
        try {
            const info = await readModelInfo(folder);
            return { ...base, family: info.family, sources: info.sources, targets: info.targets, size: await folderSize(folder), ready: true, error: '' };
        } catch (error) {
            return { ...base, family: '', sources: [], targets: [], size: 0, ready: false, error: error?.message ?? String(error) };
        }
    }

    /**
     * @returns {(import('./modelCatalog').CatalogEntry & { added: boolean })[]}
     */
    catalog() {
        const installed = this.installedKeys();
        return MODEL_CATALOG.map(entry => ({ ...entry, added: installed.has(entry.key) }));
    }

    /**
     * Begins downloading a model of the catalog; added when ready.
     * @param {string} key
     * @returns {string} why it does not begin ('' : it began)
     */
    download(key) {
        const entry = MODEL_CATALOG.find(item => item.key === key);
        if (!entry) return vscode.l10n.t('There is no model {0}.', key);
        if (this.installedKeys().has(key)) return vscode.l10n.t('{0} is installed or being downloaded already.', key);
        this.pending.set(key, { done: 0, total: entry.size });
        this._changed.fire();
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Downloading the translation model {0}', key), cancellable: true }, (progress, token) => this._write(entry, progress, token))
            .then(folder => this._settings.addModel(folder), (error) => {
                if (error?.name !== 'AbortError') vscode.window.showErrorMessage(vscode.l10n.t('The model {0} could not be downloaded: {1}', key, error?.message || String(error)));
            })
            .finally(() => {
                this.pending.delete(key);
                this._changed.fire();
            });
        return '';
    }

    /**
     * @param {import('./modelCatalog').CatalogEntry} entry
     * @param {vscode.Progress<{ message?: string, increment?: number }>} progress
     * @param {vscode.CancellationToken} token
     * @returns {Promise<string>} the folder of the model (removed when it fails)
     */
    async _write(entry, progress, token) {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        const folder = join(this.folder, entry.key);
        const pending = this.pending.get(entry.key);
        let told = 0;
        const onBytes = (count) => {
            pending.done += count;
            progress.report({ increment: (count / entry.size) * 100, message: `${Math.min(100, Math.round((pending.done / entry.size) * 100))}%` });
            if (Date.now() - told < PROGRESS_INTERVAL) return;
            told = Date.now();
            this._progress.fire({ key: entry.key, ...pending });
        };
        try {
            for (const file of entry.files) await TranslationModels._fetchFile(`https://huggingface.co/${entry.repository}/resolve/main/${file}`, join(folder, file), abort.signal, onBytes);
            await readModelInfo(folder);
            return folder;
        } catch (error) {
            await rm(folder, { recursive: true, force: true });
            throw token.isCancellationRequested ? Object.assign(new Error('Cancelled'), { name: 'AbortError' }) : error;
        }
    }

    /**
     * Writes a download to `<target>.part`, renamed when complete.
     * @param {string} url
     * @param {string} target
     * @param {AbortSignal} signal
     * @param {(count: number) => void} onBytes
     */
    static async _fetchFile(url, target, signal, onBytes) {
        const response = await fetch(url, { signal });
        if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}: ${url}`);
        const expected = Number(response.headers.get('content-length')) || 0;
        const part = `${target}.part`;
        let received = 0;
        const count = async function* (chunks) {
            for await (const chunk of chunks) {
                received += chunk.length;
                onBytes(chunk.length);
                yield chunk;
            }
        };
        await mkdir(dirname(target), { recursive: true });
        await pipeline(Readable.fromWeb(response.body), count, createWriteStream(part), { signal });
        if (expected && received !== expected) throw new Error(`${basename(target)} came incomplete (${received} of ${expected} bytes)`);
        await rename(part, target);
    }

    /** @returns {Promise<string>} the folder chosen in the open dialog of VS Code ('' : none) */
    async browseFolder() {
        const [uri] = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: vscode.l10n.t('Use this model') }) ?? [];
        return uri?.fsPath ?? '';
    }

    /**
     * Adds a model folder on the disk, used where it is.
     * @param {string} folder
     * @returns {Promise<string>} why it is not added ('' : added)
     */
    async addFolder(folder) {
        try {
            await readModelInfo(folder);
        } catch (error) {
            return vscode.l10n.t('This folder is not a model the translator can use: {0}', error?.message ?? String(error));
        }
        if (this._settings.get().models.includes(folder)) return vscode.l10n.t('This model is in the list already.');
        await this._settings.addModel(folder);
        return '';
    }

    /**
     * Removes a model from the list after asking; one of the storage with its folder.
     * @param {string} folder
     */
    async remove(folder) {
        if (!this._settings.get().models.includes(folder)) return;
        const stored = this.isStored(folder);
        const remove = vscode.l10n.t('Remove');
        const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Remove the translation model {0}?', basename(folder)), {
            modal: true,
            detail: stored ? vscode.l10n.t('Its files in the storage of the extension are deleted.') : vscode.l10n.t('It leaves the list; its files stay on the disk.'),
        }, remove);
        if (answer !== remove) return;
        await this._settings.removeModel(folder);
        if (stored) await rm(folder, { recursive: true, force: true });
    }

    /**
     * @param {string} folder only a folder of the list
     * @param {boolean} active whether translations use the model
     * @returns {Promise<void> | undefined}
     */
    setActive(folder, active) {
        return this._settings.get().models.includes(folder) ? this._settings.setModelActive(folder, active) : undefined;
    }

    /** @param {string} folder shown in the file manager (only a folder of the list) */
    reveal(folder) {
        if (this._settings.get().models.includes(folder)) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
    }
}
