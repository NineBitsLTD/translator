/**
 * @typedef {{ folder: string, family: string, sources: string[], targets: string[] }} RoutedModel
 * @typedef {{ folder: string, from: string, to: string }} Hop one translation by one model
 */

/** The language two models are joined through when no model translates a pair directly. */
export const PIVOT_LANGUAGE = 'en';

/**
 * @param {RoutedModel[]} models
 * @param {string} from
 * @param {string} to
 * @returns {RoutedModel | undefined} a model of that pair: Opus-MT first (made for it), then a multilingual one
 */
function direct(models, from, to) {
    const able = models.filter(model => model.sources.includes(from) && model.targets.includes(to));
    return able.find(model => model.family === 'marian') ?? able[0];
}

/**
 * @param {string} from
 * @param {string} to
 * @param {RoutedModel[]} models the models ready to use
 * @returns {Hop[] | null} the models to translate through ([] : the same language; null: no way)
 */
export function routeTranslation(from, to, models) {
    if (from === to) return [];
    const one = direct(models, from, to);
    if (one) return [{ folder: one.folder, from, to }];
    if (from === PIVOT_LANGUAGE || to === PIVOT_LANGUAGE) return null;
    const first = direct(models, from, PIVOT_LANGUAGE);
    const second = direct(models, PIVOT_LANGUAGE, to);
    return first && second ? [{ folder: first.folder, from, to: PIVOT_LANGUAGE }, { folder: second.folder, from: PIVOT_LANGUAGE, to }] : null;
}
