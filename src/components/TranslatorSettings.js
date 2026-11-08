import * as vscode from 'vscode';

const SECTION = 'translator';

/**
 * @typedef {object} Settings
 * @property {string[]} models the folders of the models
 * @property {string[]} inactiveModels those of them that translations do not use
 * @property {string} source the language to translate from (`auto`: told by the letters of the text)
 * @property {string} target the language to translate into ('' : that of VS Code)
 * @property {string} alternate the language to translate into when the text is in the target language already
 * @property {number} beams the width of the search (0: what each model is made with)
 * @property {number} idleMinutes models are freed after this long without work (0: never)
 */

/**
 * The settings of the translator (`translator.*`, scope `application`), checked as they are read.
 */
export class TranslatorSettings {

    constructor() {
        /** @type {vscode.EventEmitter<void>} */
        this._changed = new vscode.EventEmitter();
        this.onDidChange = this._changed.event;
        this._subscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(SECTION)) this._changed.fire();
        });
        /** Check boxes changed one after another: each change reads what the one before it wrote. */
        this._activeWrites = Promise.resolve();
    }

    dispose() {
        this._subscription.dispose();
        this._changed.dispose();
    }

    /** @returns {Settings} */
    get() {
        const config = vscode.workspace.getConfiguration(SECTION);
        const beams = Number(config.get('beams'));
        const idle = Number(config.get('idleMinutes'));
        return {
            models: (config.get('models') ?? []).filter(path => typeof path === 'string' && path),
            inactiveModels: (config.get('inactiveModels') ?? []).filter(path => typeof path === 'string' && path),
            source: String(config.get('sourceLanguage') || 'auto'),
            target: String(config.get('targetLanguage') || ''),
            alternate: String(config.get('alternateLanguage') || 'en'),
            beams: Number.isFinite(beams) ? Math.min(8, Math.max(0, Math.round(beams))) : 0,
            idleMinutes: Number.isFinite(idle) ? Math.max(0, idle) : 5,
        };
    }

    /** @returns {string} the language of VS Code, in two letters */
    static uiLanguage() {
        return vscode.env.language.split('-')[0].toLowerCase();
    }

    /** @returns {string} the language to translate into */
    target() {
        return this.get().target || TranslatorSettings.uiLanguage();
    }

    /**
     * @param {'sourceLanguage' | 'targetLanguage' | 'models' | 'inactiveModels'} key
     * @param {any} value
     */
    update(key, value) {
        return vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
    }

    /** @param {string} folder */
    addModel(folder) {
        const { models } = this.get();
        return models.includes(folder) ? undefined : this.update('models', [...models, folder]);
    }

    /** @param {string} folder */
    async removeModel(folder) {
        await this.update('models', this.get().models.filter(path => path !== folder));
        await this.setModelActive(folder, true);
    }

    /** @returns {string[]} the folders of the models that translations use */
    activeModels() {
        const { models, inactiveModels } = this.get();
        return models.filter(folder => !inactiveModels.includes(folder));
    }

    /**
     * @param {string} folder
     * @param {boolean} active whether translations use the model
     * @returns {Promise<void>} when it is written
     */
    setModelActive(folder, active) {
        const write = async () => {
            const { inactiveModels } = this.get();
            if (inactiveModels.includes(folder) !== active) return;
            await this.update('inactiveModels', active ? inactiveModels.filter(path => path !== folder) : [...inactiveModels, folder]);
        };
        this._activeWrites = this._activeWrites.then(write, write);
        return this._activeWrites;
    }
}
