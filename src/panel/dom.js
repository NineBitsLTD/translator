/**
 * @param {string} tag
 * @param {string} className
 * @param {object} [properties]
 * @param {(Node | string)[]} [children]
 * @returns {any}
 */
export function element(tag, className, properties = {}, children = []) {
    const node = Object.assign(document.createElement(tag), { className }, properties);
    node.append(...children);
    return node;
}

/**
 * @param {string} name of a codicon
 * @returns {HTMLElement}
 */
export function icon(name) {
    return element('i', `codicon codicon-${name}`);
}

/**
 * @param {string} text with {0}, {1}…
 * @param {...any} values
 * @returns {string}
 */
export function format(text, ...values) {
    return text.replace(/\{(\d+)\}/g, (found, index) => String(values[Number(index)] ?? found));
}
