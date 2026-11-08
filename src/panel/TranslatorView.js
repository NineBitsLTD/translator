import { element, format, icon } from './dom.js';
import { ModelDialog } from './ModelDialog.js';

/**
 * The side bar: the languages, the text and its translation, the models and those to download.
 */
export class TranslatorView {

    /**
     * @param {HTMLElement} root
     * @param {import('./HostRequests.js').HostRequests} host
     * @param {Record<string, string>} strings
     */
    constructor(root, host, strings) {
        this._host = host;
        this._s = strings;
        this._state = null;
        this._markdown = false;
        this._running = false;
        this._languagesKey = '';
        /** @type {string} the language of the translation shown */
        this._outputLanguage = '';
        /** @type {'input' | 'output' | null} the field being spoken */
        this._speaking = null;
        /** Which speech is the last one asked for: an earlier one ending says nothing */
        this._speechTurn = 0;
        this._recording = false;
        this._build(root);
    }

    /** @param {HTMLElement} root */
    _build(root) {
        const s = this._s;
        const button = (label, title, onClick, modifier = '') => {
            const node = element('button', `tr__button${modifier ? ` tr__button--${modifier}` : ''}`, { type: 'button', textContent: label, title });
            node.addEventListener('click', onClick);
            return node;
        };
        this._from = element('select', 'tr__language', { title: s.autoTitle });
        this._to = element('select', 'tr__language');
        this._swap = button('⇄', s.swap, () => this._swapLanguages(), 'icon');
        for (const select of [this._from, this._to]) select.addEventListener('change', () => this._languagesChanged());
        this._input = element('textarea', 'tr__text', { rows: 6, placeholder: s.source, spellcheck: false });
        this._input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                this.translate();
            }
        });
        this._translate = button(s.translate, s.translate, () => this.translate(), 'primary');
        this._stop = button(s.stop, s.stop, () => this._host.send('cancel'));
        this._stop.hidden = true;
        this._status = element('div', 'tr__status', { role: 'status' });
        this._output = element('textarea', 'tr__text', { rows: 6, readOnly: true, placeholder: s.translation });
        this._models = element('div', 'tr__list');
        this._dialog = new ModelDialog(this._host, s);
        const addModel = element('button', 'tr__button tr__button--with-icon', { type: 'button' }, [icon('add'), s.addModel]);
        addModel.addEventListener('click', () => this._dialog.open());
        const speechButton = (title, onClick) => Object.assign(button('', title, onClick, 'icon'), { hidden: true });
        this._speakInput = speechButton(s.speak, () => this._speak('input'));
        this._speakOutput = speechButton(s.speak, () => this._speak('output'));
        this._record = speechButton(s.record, () => this._recordSpeech());
        root.append(
            element('div', 'tr__row', {}, [this._from, this._swap, this._to]),
            this._input,
            element('div', 'tr__row', {}, [
                this._translate, this._stop,
                button(s.selection, s.selectionTitle, () => this._takeSelection()),
                button(s.clipboard, s.clipboardTitle, () => this._takeClipboard()),
                element('div', 'tr__speech', {}, [this._speakInput, this._record]),
            ]),
            this._status,
            this._output,
            element('div', 'tr__row', {}, [
                button(s.copy, s.copy, () => this._host.send('copy', { text: this._output.value })),
                button(s.replace, s.replaceTitle, () => this._replace()),
                element('div', 'tr__speech', {}, [this._speakOutput]),
            ]),
            element('h3', 'tr__heading', { textContent: s.models }),
            this._models,
            element('div', 'tr__row', {}, [addModel]),
        );
    }

    /** @param {string} code @returns {string} */
    _name(code) {
        return this._state?.languages.find(language => language.code === code)?.name ?? code;
    }

    /** @param {any} state languages, from, to, models, catalog, pending */
    setState(state) {
        this._state = state;
        const key = JSON.stringify(state.languages);
        if (key !== this._languagesKey) {
            this._languagesKey = key;
            const options = () => state.languages.map(language => element('option', '', { value: language.code, textContent: language.name }));
            this._from.replaceChildren(element('option', '', { value: 'auto', textContent: this._s.auto }), ...options());
            this._to.replaceChildren(...options());
        }
        this._from.value = state.from;
        this._to.value = state.to;
        this._swap.disabled = state.from === 'auto';
        if (!state.speech) this._forgetSpeech();
        this._drawSpeech();
        this._drawModels();
        this._drawCatalog();
    }

    /** The extension that speaks is gone: what it was doing will not end by itself. */
    _forgetSpeech() {
        this._speechTurn++;
        this._speaking = null;
        this._recording = false;
    }

    _drawSpeech() {
        const s = this._s;
        const found = !!this._state?.speech;
        for (const [node, field] of [[this._speakInput, 'input'], [this._speakOutput, 'output']]) {
            const speaking = this._speaking === field;
            node.hidden = !found;
            node.disabled = this._recording;
            node.title = speaking ? s.stopSpeaking : s.speak;
            node.replaceChildren(icon(speaking ? 'debug-stop' : 'unmute'));
        }
        this._record.hidden = !found;
        this._record.title = this._recording ? s.stopRecording : s.record;
        this._record.classList.toggle('tr__button--recording', this._recording);
        this._record.replaceChildren(icon(this._recording ? 'stop-circle' : 'record'));
    }

    _languagesChanged() {
        this._swap.disabled = this._from.value === 'auto';
        this._host.send('languages', { from: this._from.value, to: this._to.value });
    }

    _swapLanguages() {
        if (this._from.value === 'auto') return;
        [this._from.value, this._to.value] = [this._to.value, this._from.value];
        if (this._output.value) {
            [this._input.value, this._output.value] = [this._output.value, this._input.value];
            // What was the source is now the translation: spoken in its language
            this._outputLanguage = this._to.value;
        }
        this._languagesChanged();
    }

    /** @param {any} model @returns {string} */
    _modelTitle(model) {
        if (model.family === 'marian') return `${this._name(model.sources[0])} → ${this._name(model.targets[0])}`;
        if (model.family === 'm2m_100') return `M2M100 · ${format(this._s.multilingual, model.languageCount ?? model.sources.length)}`;
        return model.name ?? model.key;
    }

    /** @param {number} size @returns {string} */
    _megabytes(size) {
        return format(this._s.sizeMb, Math.round(size / 2 ** 20));
    }

    _drawModels() {
        const s = this._s;
        const { models, catalog, pending } = this._state;
        const action = (content, title, type, folder) => {
            const node = element('button', 'tr__action', { type: 'button', title }, [content]);
            node.addEventListener('click', () => this._host.send(type, { folder }));
            return node;
        };
        const checkbox = (model) => {
            const node = element('input', 'tr__check', { type: 'checkbox', checked: model.active && model.ready, disabled: !model.ready, title: s.useModel });
            node.addEventListener('change', () => this._host.send('modelActive', { folder: model.folder, active: node.checked }));
            return node;
        };
        // Added to the settings just before it stops being a download: not listed twice
        const downloading = catalog.filter(entry => pending[entry.key] && !models.some(model => model.name === entry.key));
        const installed = models.map(model => element('div', `tr__item${model.active ? '' : ' tr__item--inactive'}`, {}, [
            checkbox(model),
            element('div', 'tr__item-text', { title: model.folder }, [
                element('div', 'tr__item-title', { textContent: this._modelTitle(model) }),
                element('div', `tr__item-sub${model.ready ? '' : ' tr__item-sub--error'}`, { textContent: model.ready ? [model.name, this._megabytes(model.size), model.license].filter(Boolean).join(' · ') : format(s.broken, model.error) }),
            ]),
            action(icon('folder-opened'), s.reveal, 'reveal', model.folder),
            action('✕', s.remove, 'remove', model.folder),
        ]));
        this._models.replaceChildren(...installed, ...downloading.map(entry => this._downloadingItem(entry)));
        if (!models.length && !downloading.length) this._models.append(element('div', 'tr__empty', { textContent: s.noModels }));
    }

    /**
     * @param {any} entry of the catalog, being downloaded
     * @returns {HTMLElement} its line among the models: how much of it is there
     */
    _downloadingItem(entry) {
        const { done, total } = this._state.pending[entry.key];
        const line = element('div', 'tr__item-sub', {}, [icon('loading codicon-modifier-spin'), element('span', '')]);
        line.dataset.key = entry.key;
        this._showAmount(line, done, total);
        return element('div', 'tr__item tr__item--downloading', {}, [
            element('div', 'tr__item-text', { title: entry.key }, [
                element('div', 'tr__item-title', { textContent: this._modelTitle(entry) }),
                line,
            ]),
        ]);
    }

    /**
     * Only the text changes: a new icon would begin its spinning again at every step.
     * @param {HTMLElement} line of a model being downloaded
     * @param {number} done
     * @param {number} total
     */
    _showAmount(line, done, total) {
        line.lastChild.textContent = this._amount(done, total);
        line.title = format(this._s.downloadingTitle, this._share(done, total));
    }

    /**
     * @param {number} done bytes
     * @param {number} total bytes
     * @returns {string} "12.3 of 99.0 MB" (GB from 1 GB on: "1.02 of 1.70 GB")
     */
    _amount(done, total) {
        const [unit, size, digits] = total >= 2 ** 30 ? [this._s.gigabytes, 2 ** 30, 2] : [this._s.megabytes, 2 ** 20, 1];
        const value = bytes => (bytes / size).toFixed(digits);
        return format(this._s.amount, value(Math.min(done, total)), value(total), unit);
    }

    /** The models of the catalog, for the dialog that adds one. */
    _drawCatalog() {
        const { catalog, pending } = this._state;
        this._dialog.setItems(catalog.map((entry) => {
            const going = pending[entry.key];
            return {
                key: entry.key,
                title: this._modelTitle(entry),
                details: [this._megabytes(entry.size), entry.license].join(' · '),
                state: going ? this._percent(going.done, going.total) : entry.added ? this._s.added : '',
                added: entry.added,
                matches: query => this._matchesFilter(entry, query),
            };
        }));
    }

    /**
     * @param {any} entry of the catalog
     * @param {string} query in lower case
     * @returns {boolean} a multilingual model always does: it has every pair
     */
    _matchesFilter(entry, query) {
        if (entry.family !== 'marian') return true;
        return [...entry.sources, ...entry.targets].some(code => code.includes(query) || this._name(code).toLowerCase().includes(query)) || this._modelTitle(entry).toLowerCase().includes(query);
    }

    /** @param {number} done @param {number} total @returns {string} */
    _percent(done, total) {
        return format(this._s.downloading, this._share(done, total));
    }

    /** @param {number} done @param {number} total @returns {number} percents */
    _share(done, total) {
        return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    }

    /** @param {string} key @param {number} done @param {number} total a download went on */
    setDownload(key, done, total) {
        if (this._state?.pending[key]) Object.assign(this._state.pending[key], { done, total });
        this._dialog.showState(key, this._percent(done, total));
        const line = this._models.querySelector(`[data-key="${CSS.escape(key)}"]`);
        if (line) this._showAmount(line, done, total);
    }

    /** @param {number} done @param {number} total */
    setWorking(done, total) {
        if (this._running) this._setStatus(format(this._s.working, done, total));
    }

    /**
     * @param {string} text
     * @param {boolean} [error]
     * @param {{ keys: string[], size: number }[]} [downloads]
     */
    _setStatus(text, error = false, downloads = []) {
        this._status.textContent = text;
        this._status.classList.toggle('tr__status--error', error);
        for (const way of downloads) {
            const node = element('button', 'tr__button', { type: 'button', textContent: format(this._s.downloadWay, way.keys.join(', '), Math.round(way.size / 2 ** 20)) });
            node.addEventListener('click', () => {
                for (const key of way.keys) this._host.send('download', { key });
                this._setStatus('');
            });
            this._status.append(node);
        }
    }

    /**
     * @param {string} text
     * @param {boolean} [markdown]
     */
    translateText(text, markdown = false) {
        this._input.value = text;
        this._markdown = markdown;
        this.translate();
    }

    async translate() {
        const text = this._input.value;
        if (!text.trim()) return;
        this._running = true;
        this._translate.hidden = true;
        this._stop.hidden = false;
        this._setStatus(format(this._s.working, 0, '…'));
        const result = await this._host.request('translate', { text, from: this._from.value, to: this._to.value, markdown: this._markdown });
        this._running = false;
        this._translate.hidden = false;
        this._stop.hidden = true;
        if (result.cancelled) return this._setStatus('');
        if (result.error) return this._setStatus(result.error, true, result.downloads);
        this._output.value = result.text;
        this._outputLanguage = result.to;
        if (result.from === result.to) this._setStatus(format(this._s.same, this._name(result.from)));
        else this._setStatus(format(this._s.done, this._name(result.from), this._name(result.to), result.route.join(', ')));
    }

    async _takeSelection() {
        const { text, markdown } = await this._host.request('selection');
        if (text.trim()) this.translateText(text, markdown);
        else this._setStatus(this._s.nothingSelected, true);
    }

    async _takeClipboard() {
        const { text } = await this._host.request('clipboard');
        if (text.trim()) this.translateText(text);
        else this._setStatus(this._s.emptyClipboard, true);
    }

    async _replace() {
        if (!this._output.value) return;
        const { error } = await this._host.request('replace', { text: this._output.value });
        if (error) this._setStatus(error, true);
    }

    /**
     * Speaks a field, or ends its speech when it is being spoken.
     * @param {'input' | 'output'} field
     */
    async _speak(field) {
        if (this._speaking === field) return this._host.send('stopSpeaking');
        const [text, language] = field === 'input' ? [this._input.value, this._from.value] : [this._output.value, this._outputLanguage];
        if (!text.trim()) return;
        const turn = ++this._speechTurn;
        this._speaking = field;
        this._drawSpeech();
        const { error } = await this._host.request('speak', { text, language });
        if (turn !== this._speechTurn) return;
        this._speaking = null;
        this._drawSpeech();
        if (error) this._setStatus(error, true);
    }

    /** Records a phrase and translates it, or ends the recording going on. */
    async _recordSpeech() {
        if (this._recording) return this._host.send('stopRecording');
        // The host ends the speech: the microphone would hear it
        this._speechTurn++;
        this._speaking = null;
        this._recording = true;
        this._drawSpeech();
        this._setStatus(this._s.listening);
        const { text, error } = await this._host.request('record');
        this._recording = false;
        this._drawSpeech();
        if (error) this._setStatus(error, true);
        else if (text) this.translateText(text);
        else this._setStatus(this._s.nothingHeard, true);
    }
}
