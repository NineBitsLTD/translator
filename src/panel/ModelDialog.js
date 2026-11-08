import { element, icon } from './dom.js';

/**
 * @typedef {object} CatalogItem a model of the catalog, as the dialog shows it
 * @property {string} key
 * @property {string} title
 * @property {string} details its size and license
 * @property {string} state added, or how much is downloaded ('' : it can be chosen)
 * @property {boolean} added installed or being downloaded: it cannot be chosen
 * @property {(query: string) => boolean} matches the filter, in lower case
 */

/**
 * The modal dialog adding a model: a folder on the disk (Browse… opens the open dialog of VS Code)
 * or a model of the catalog to download (a filter by language; those added are shown but cannot be
 * chosen); OK or Cancel.
 */
export class ModelDialog {

    /**
     * @param {import('./HostRequests.js').HostRequests} host
     * @param {Record<string, string>} strings
     */
    constructor(host, strings) {
        const s = strings;
        this._host = host;
        this._noMatch = s.noMatch;
        /** @type {CatalogItem[]} */
        this._items = [];
        this._chosenKey = '';
        this._diskMode = element('input', '', { type: 'radio', name: 'model-source', value: 'disk', checked: true });
        this._catalogMode = element('input', '', { type: 'radio', name: 'model-source', value: 'catalog' });
        const mode = (input, label) => element('label', 'tr-dialog__mode', {}, [input, label]);
        this._path = element('input', 'tr-dialog__input tr-dialog__input--path', { type: 'text', readOnly: true, placeholder: s.noFolder });
        const browse = element('button', 'tr__button tr__button--with-icon', { type: 'button' }, [icon('folder-opened'), s.browse]);
        this._disk = element('div', 'tr-dialog__disk', {}, [this._path, browse, element('p', 'tr-dialog__note', { textContent: s.fromDiskTitle })]);
        this._filter = element('input', 'tr-dialog__input', { type: 'search', placeholder: s.filter, spellcheck: false });
        this._list = element('ul', 'tr-dialog__list', { role: 'listbox' });
        this._catalog = element('div', 'tr-dialog__catalog', { hidden: true }, [this._filter, this._list]);
        this._error = element('p', 'tr-dialog__error', { role: 'alert' });
        this._ok = element('button', 'tr__button tr__button--primary', { type: 'submit', textContent: 'OK' });
        const cancel = element('button', 'tr__button', { type: 'button', textContent: s.cancel });
        const form = element('form', 'tr-dialog__form', { noValidate: true }, [
            element('h2', 'tr-dialog__title', { textContent: s.addModel }),
            element('div', 'tr-dialog__modes', { role: 'radiogroup' }, [mode(this._diskMode, s.folderOnDisk), mode(this._catalogMode, s.download)]),
            this._disk, this._catalog, this._error,
            element('div', 'tr-dialog__buttons', {}, [cancel, this._ok]),
        ]);
        this._dialog = element('dialog', 'tr-dialog', {}, [form]);
        document.body.append(this._dialog);
        for (const input of [this._diskMode, this._catalogMode]) input.addEventListener('change', () => this._showMode());
        browse.addEventListener('click', () => this._browse());
        this._filter.addEventListener('input', () => this._drawList());
        cancel.addEventListener('click', () => this._dialog.close());
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            this._submit();
        });
    }

    open() {
        this._chosenKey = '';
        this._path.value = '';
        this._filter.value = '';
        this._diskMode.checked = true;
        this._showMode();
        this._drawList();
        this._dialog.showModal();
    }

    /** @param {CatalogItem[]} items the catalog now: a download began or ended */
    setItems(items) {
        this._items = items;
        if (items.find(item => item.key === this._chosenKey)?.added) this._chosenKey = '';
        this._drawList();
        this._sync();
    }

    /** @param {string} key @param {string} text how much of a model is downloaded */
    showState(key, text) {
        const state = this._list.querySelector(`[data-key="${CSS.escape(key)}"] .tr__item-state`);
        if (state) state.textContent = text;
    }

    _showMode() {
        const catalog = this._catalogMode.checked;
        this._disk.hidden = catalog;
        this._catalog.hidden = !catalog;
        this._error.textContent = '';
        this._sync();
    }

    async _browse() {
        const folder = await this._host.request('browseFolder');
        if (folder) this._path.value = folder;
        this._error.textContent = '';
        this._sync();
    }

    _drawList() {
        const query = this._filter.value.trim().toLowerCase();
        const shown = this._items.filter(item => !query || item.matches(query));
        if (shown.length) this._list.replaceChildren(...shown.map(item => this._listItem(item)));
        else this._list.replaceChildren(element('li', 'tr-dialog__empty', { textContent: this._noMatch }));
    }

    /**
     * @param {CatalogItem} item
     * @returns {HTMLElement}
     */
    _listItem(item) {
        const chosen = item.key === this._chosenKey;
        const node = element('li', `tr__item tr-dialog__item${chosen ? ' tr-dialog__item--chosen' : ''}${item.added ? ' tr-dialog__item--added' : ''}`, {
            role: 'option', ariaSelected: String(chosen), ariaDisabled: String(item.added), tabIndex: item.added ? -1 : 0, title: item.key,
        }, [
            element('div', 'tr__item-text', {}, [
                element('div', 'tr__item-title', { textContent: item.title }),
                element('div', 'tr__item-sub', { textContent: item.details }),
            ]),
            element('span', 'tr__item-state', { textContent: item.state }),
        ]);
        node.dataset.key = item.key;
        if (item.added) return node;
        node.addEventListener('click', () => this._choose(item.key));
        node.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            this._choose(item.key);
        });
        return node;
    }

    /** @param {string} key of the model chosen (the list stays as it is, with the focus in it) */
    _choose(key) {
        this._chosenKey = key;
        this._error.textContent = '';
        for (const node of this._list.children) {
            const chosen = node.dataset.key === key;
            node.classList.toggle('tr-dialog__item--chosen', chosen);
            node.ariaSelected = String(chosen);
        }
        this._sync();
    }

    /** OK: when a folder or a model is chosen. */
    _sync() {
        this._ok.disabled = this._catalogMode.checked ? !this._chosenKey : !this._path.value;
    }

    async _submit() {
        const choice = this._catalogMode.checked ? { key: this._chosenKey } : { folder: this._path.value };
        if (!(choice.key || choice.folder)) return;
        this._ok.disabled = true;
        const refused = await this._host.request('addModel', choice);
        if (!refused) this._dialog.close();
        this._error.textContent = refused;
        this._sync();
    }
}
