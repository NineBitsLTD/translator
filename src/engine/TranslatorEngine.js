import { readModelInfo, TranslationModel } from './TranslationModel.js';
import { protectSpans, restoreSpans } from './protectSpans.js';
import { routeTranslation } from './routeTranslation.js';
import { segmentText } from './segmentText.js';
import { guessLanguage } from '../utils/guessLanguage.js';

/** A sentence longer than this is cut (the models take 512 tokens at most, and do worse near it). */
const MAX_TOKENS = 400;
/** Translations remembered per engine. */
const CACHE_SIZE = 5000;
/** Models kept loaded at once (a pair with a pivot takes two). */
const MODELS_KEPT = 3;
const CUT_AT = /[,;:—–]\s+/g;

/**
 * @typedef {import('./routeTranslation.js').Hop} Hop
 * @typedef {object} TranslateOptions
 * @property {string} [from] the language of the texts ('auto' or none: told by their letters)
 * @property {string} to
 * @property {boolean} [markdown] the texts are Markdown: its code and signs stay
 * @property {number} [beams] the width of the search (0 or none: what the model is made with)
 * @property {AbortSignal} [signal]
 * @property {(done: number, total: number) => void} [onProgress] per sentence
 * @typedef {{ texts: string[], from: string, to: string, route: Hop[] }} TranslateResult
 */

/**
 * Translates with ONNX models on the device: chooses the models for a pair of languages (a pivot
 * through English when no model does the pair), cuts a text into sentences, keeps what must not be
 * translated, loads models on demand and frees them when idle. It knows nothing of VS Code: give it
 * onnxruntime-node and the folders of the models.
 */
export class TranslatorEngine {

    /**
     * @param {object} options
     * @param {() => any} options.runtime gives onnxruntime-node (called when first needed)
     * @param {() => string[]} options.folders the folders of the models
     * @param {number} [options.idleMs] models are freed after this long without work (0: never)
     * @param {number} [options.threads] of the model runs (none: what ONNX Runtime chooses)
     */
    constructor({ runtime, folders, idleMs = 0, threads }) {
        this._runtime = runtime;
        this._folders = folders;
        /** Models are freed after this long without work (ms, 0: never). */
        this.idleMs = idleMs;
        this._threads = threads;
        /** @type {Map<string, Promise<TranslationModel>>} loaded models, the last used at the end */
        this._loaded = new Map();
        /** @type {Map<string, string>} */
        this._cache = new Map();
        /** @type {Map<string, Promise<import('./TranslationModel.js').ModelInfo | null>>} */
        this._infos = new Map();
        this._tail = Promise.resolve();
        this._idleTimer = null;
    }

    /** Forgets what was read about the folders (they changed). */
    invalidate() {
        this._infos.clear();
    }

    /**
     * @param {string[]} [folders] those to look at (the folders of the engine by default)
     * @returns {Promise<(import('./TranslationModel.js').ModelInfo & { folder: string })[]>} the models that can be used
     */
    async models(folders = this._folders()) {
        const found = await Promise.all(folders.map(async (folder) => {
            if (!this._infos.has(folder)) this._infos.set(folder, readModelInfo(folder).catch(() => null));
            const info = await this._infos.get(folder);
            return info && { ...info, folder };
        }));
        return found.filter(Boolean);
    }

    /**
     * @param {string} from
     * @param {string} to
     * @param {string[]} [folders] the models to go by (the folders of the engine by default)
     * @returns {Promise<Hop[] | null>} how a pair would be translated, null when no model can
     */
    async route(from, to, folders) {
        return routeTranslation(from, to, await this.models(folders));
    }

    /**
     * @param {string} text
     * @param {string} [fallback]
     * @returns {string} its language, by its letters
     */
    detect(text, fallback = 'en') {
        return guessLanguage(text, fallback);
    }

    /**
     * Translates texts; they wait for the ones asked for earlier.
     * @param {string[]} texts
     * @param {TranslateOptions} options
     * @returns {Promise<TranslateResult>}
     */
    translate(texts, options) {
        const job = this._tail.then(() => this._translate(texts, options));
        this._tail = job.catch(() => {});
        return job;
    }

    /** Frees the loaded models. */
    async release() {
        clearTimeout(this._idleTimer);
        const loaded = [...this._loaded.values()];
        this._loaded.clear();
        await Promise.all(loaded.map(model => model.then(m => m.release()).catch(() => {})));
    }

    /**
     * @param {string[]} texts
     * @param {TranslateOptions} options
     * @returns {Promise<TranslateResult>}
     */
    async _translate(texts, { from, to, markdown = false, beams, signal, onProgress }) {
        clearTimeout(this._idleTimer);
        const source = !from || from === 'auto' ? guessLanguage(texts.join('\n')) : from;
        const route = await this.route(source, to);
        if (!route) throw Object.assign(new Error(`There is no model to translate from ${source} to ${to}.`), { code: 'NO_MODEL', from: source, to });
        try {
            const plans = texts.map(text => (route.length ? segmentText(text, { language: source, markdown }) : []));
            const total = plans.reduce((sum, plan) => sum + plan.filter(segment => segment.translate).length, 0);
            let done = 0;
            const out = [];
            for (let index = 0; index < texts.length; index++) {
                if (!route.length) {
                    out.push(texts[index]);
                    continue;
                }
                let result = '';
                for (const segment of plans[index]) {
                    if (!segment.translate) {
                        result += segment.text;
                        continue;
                    }
                    signal?.throwIfAborted();
                    result += await this._sentence(segment.text, route, { markdown, beams, signal });
                    onProgress?.(++done, total);
                }
                out.push(result);
            }
            return { texts: out, from: source, to, route };
        } finally {
            this._scheduleRelease();
        }
    }

    _scheduleRelease() {
        if (!this.idleMs) return;
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => this.release(), this.idleMs);
        this._idleTimer.unref?.();
    }

    /**
     * @param {string} sentence
     * @param {Hop[]} route
     * @param {{ markdown: boolean, beams?: number, signal?: AbortSignal }} options
     * @returns {Promise<string>} its translation, with what must stay put back
     */
    async _sentence(sentence, route, { markdown, beams, signal }) {
        const hidden = protectSpans(sentence, { markdown });
        const translated = await this._throughRoute(hidden.text, route, beams, signal);
        if (!hidden.spans.length) return translated;
        const restored = restoreSpans(translated, hidden.spans);
        if (restored !== null) return restored;
        // The model lost a mark: the words between the spans are translated on their own
        let out = '';
        for (const part of hidden.parts) {
            if (part.literal || !/\p{L}/u.test(part.text)) {
                out += part.text;
                continue;
            }
            const [, before, body, after] = part.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
            out += before + await this._throughRoute(body, route, beams, signal) + after;
        }
        return out;
    }

    /**
     * @param {string} text
     * @param {Hop[]} route
     * @param {number | undefined} beams
     * @param {AbortSignal | undefined} signal
     * @returns {Promise<string>}
     */
    async _throughRoute(text, route, beams, signal) {
        let current = text;
        for (const hop of route) current = await this._hop(current, hop, beams, signal);
        return current;
    }

    /**
     * @param {string} text
     * @param {Hop} hop
     * @param {number | undefined} beams
     * @param {AbortSignal | undefined} signal
     * @returns {Promise<string>}
     */
    async _hop(text, hop, beams, signal) {
        const key = `${hop.folder}\n${hop.from}\n${hop.to}\n${beams || 0}\n${text}`;
        const known = this._cache.get(key);
        if (known !== undefined) return known;
        const model = await this._model(hop.folder);
        const pieces = TranslatorEngine._cut(text, piece => model.encode(piece, hop.from).length <= MAX_TOKENS);
        const out = [];
        for (const piece of pieces) out.push(await model.translate(piece, hop.from, hop.to, { beams: beams || undefined, signal }));
        const result = out.join(' ');
        this._cache.set(key, result);
        if (this._cache.size > CACHE_SIZE) this._cache.delete(this._cache.keys().next().value);
        return result;
    }

    /**
     * @param {string} text
     * @param {(piece: string) => boolean} fits
     * @returns {string[]} the text cut so that each piece fits: at punctuation near its middle, else at a space
     */
    static _cut(text, fits) {
        if (fits(text)) return [text];
        const middle = text.length / 2;
        const nearest = (positions) => positions.reduce((best, at) => (best < 0 || Math.abs(at - middle) < Math.abs(best - middle) ? at : best), -1);
        let at = nearest([...text.matchAll(CUT_AT)].map(found => found.index + found[0].length));
        if (at <= 0 || at >= text.length) at = nearest([...text.matchAll(/\s+/g)].map(found => found.index + found[0].length));
        if (at <= 0 || at >= text.length) at = Math.floor(middle);
        if (at <= 0) return [text];
        return [...TranslatorEngine._cut(text.slice(0, at).trimEnd(), fits), ...TranslatorEngine._cut(text.slice(at).trimStart(), fits)];
    }

    /**
     * @param {string} folder
     * @returns {Promise<TranslationModel>} loaded, the last used of them kept
     */
    async _model(folder) {
        let model = this._loaded.get(folder);
        if (model) this._loaded.delete(folder);
        else model = TranslationModel.load(this._runtime(), folder, { threads: this._threads });
        this._loaded.set(folder, model);
        try {
            await model;
        } catch (error) {
            this._loaded.delete(folder);
            throw error;
        }
        while (this._loaded.size > MODELS_KEPT) {
            const [oldest, loaded] = this._loaded.entries().next().value;
            this._loaded.delete(oldest);
            loaded.then(m => m.release()).catch(() => {});
        }
        return model;
    }
}
