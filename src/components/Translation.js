import * as vscode from 'vscode';
import { suggestDownloads } from './modelCatalog';

/**
 * @typedef {import('../engine/TranslatorEngine.js').TranslateResult} TranslateResult
 * @typedef {{ keys: string[], size: number }} Download a way to get the models of a pair
 * @typedef {{ error: string, from?: string, to?: string, downloads?: Download[] }} TranslationFailure
 */

/**
 * What the panel, the commands and the API share: the languages of a request (the settings fill in
 * what it leaves out) and the engine's answers with what to download when no model can do the pair.
 */
export class Translation {

    /**
     * @param {import('./TranslatorSettings').TranslatorSettings} settings
     * @param {import('./TranslationModels').TranslationModels} models
     * @param {import('../engine/TranslatorEngine.js').TranslatorEngine} engine
     */
    constructor(settings, models, engine) {
        this._settings = settings;
        this.models = models;
        this.engine = engine;
    }

    /**
     * @param {string} language of the text
     * @returns {string} the language to translate it into: the target, or the alternate one when it is in the target already
     */
    targetFor(language) {
        const target = this._settings.target();
        return language === target ? this._settings.get().alternate : target;
    }

    /**
     * @param {string[]} texts
     * @param {{ from?: string, to?: string, markdown?: boolean, signal?: AbortSignal, onProgress?: (done: number, total: number) => void }} [options]
     * @returns {Promise<TranslateResult>}
     * @throws {Error} code `NO_MODEL` when no model can do the pair (`from`, `to`)
     */
    translate(texts, { from, to, ...rest } = {}) {
        const settings = this._settings.get();
        const source = from || settings.source;
        const language = source === 'auto' ? this.engine.detect(texts.join('\n')) : source;
        // A text told to be in the very language chosen goes into the other one (selected Russian with Russian as the target)
        const target = to && !(source === 'auto' && to === language) ? to : this.targetFor(language);
        return this.engine.translate(texts, { ...rest, from: language, to: target, beams: settings.beams });
    }

    /**
     * @param {string} from
     * @param {string} to
     * @returns {Download[]} what can be downloaded for a pair
     */
    downloads(from, to) {
        return suggestDownloads(from, to, this.models.installedKeys());
    }

    /**
     * @param {any} error from `translate`
     * @returns {Promise<TranslationFailure>} for showing
     */
    async failure(error) {
        if (error?.code !== 'NO_MODEL') return { error: error?.message ?? String(error) };
        const { from, to } = error;
        const names = [Translation.languageName(from), Translation.languageName(to)];
        // Models that were turned off can do it: nothing is to be downloaded
        if (await this.engine.route(from, to, this._settings.get().models)) {
            return { error: vscode.l10n.t('The models that translate from {0} to {1} are turned off: check them in the list of models.', ...names), from, to };
        }
        return { error: vscode.l10n.t('No model translates from {0} to {1} yet.', ...names), from, to, downloads: this.downloads(from, to) };
    }

    /**
     * @param {string} code
     * @returns {string} the name of a language in the language of VS Code
     */
    static languageName(code) {
        try {
            return new Intl.DisplayNames([vscode.env.language], { type: 'language' }).of(code) ?? code;
        } catch {
            return code;
        }
    }

    /**
     * Tells that no model can do a pair and offers the smallest download.
     * @param {TranslationFailure} failure
     */
    async offerDownload(failure) {
        const way = failure.downloads?.[0];
        if (!way) {
            vscode.window.showErrorMessage(failure.error);
            return;
        }
        const download = vscode.l10n.t('Download {0} ({1} MB)', way.keys.join(', '), Math.round(way.size / 2 ** 20));
        if (await vscode.window.showWarningMessage(failure.error, download) !== download) return;
        for (const key of way.keys) {
            const refused = this.models.download(key);
            if (refused) vscode.window.showWarningMessage(refused);
        }
    }
}
