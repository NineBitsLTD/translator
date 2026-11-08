/** The files of a model of Opus-MT and of M2M100 besides its two ONNX files. */
const ONNX_FILES = ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
const MARIAN_FILES = ['config.json', 'tokenizer_config.json', 'vocab.json', 'source.spm', 'target.spm', ...ONNX_FILES];
const M2M_FILES = ['config.json', 'tokenizer_config.json', 'vocab.json', 'sentencepiece.bpe.model', ...ONNX_FILES];

/** The languages of M2M100, in the order of its tokens. */
const M2M_LANGUAGES = 'af am ar ast az ba be bg bn br bs ca ceb cs cy da de el en es et fa ff fi fr fy ga gd gl gu ha he hi hr ht hu hy id ig ilo is it ja jv ka kk km kn ko lb lg ln lo lt lv mg mk ml mn mr ms my ne nl no ns oc or pa pl ps pt ro ru sd si sk sl so sq sr ss su sv sw ta th tl tn tr uk ur uz vi wo xh yi yo zh zu'.split(' ');

/** Opus-MT converted to ONNX: pair -> [bytes of its files, license]. */
const OPUS = {
    'af-en': [108427637, 'Apache-2.0'], 'ar-en': [114863065, 'Apache-2.0'], 'cs-en': [113892165, 'Apache-2.0'], 'da-de': [108013060, 'Apache-2.0'],
    'da-en': [109981196, 'Apache-2.0'], 'de-en': [108975772, 'Apache-2.0'], 'de-es': [112545986, 'Apache-2.0'], 'de-fr': [112385036, 'Apache-2.0'],
    'en-af': [108427637, 'Apache-2.0'], 'en-ar': [114815190, 'Apache-2.0'], 'en-cs': [113892165, 'Apache-2.0'], 'en-da': [109981198, 'Apache-2.0'],
    'en-de': [108975807, 'CC-BY-4.0'], 'en-es': [116461900, 'Apache-2.0'], 'en-fi': [116481855, 'Apache-2.0'], 'en-fr': [110512589, 'Apache-2.0'],
    'en-hi': [114079702, 'Apache-2.0'], 'en-hu': [113898837, 'Apache-2.0'], 'en-id': [105587056, 'Apache-2.0'], 'en-it': [132683994, 'Apache-2.0'],
    'en-nl': [118595621, 'Apache-2.0'], 'en-ro': [110620126, 'Apache-2.0'], 'en-ru': [115171424, 'Apache-2.0'], 'en-sv': [107317061, 'Apache-2.0'],
    'en-uk': [113911746, 'Apache-2.0'], 'en-vi': [104345943, 'Apache-2.0'], 'en-xh': [112408970, 'Apache-2.0'], 'en-zh': [116473161, 'Apache-2.0'],
    'es-de': [112545986, 'Apache-2.0'], 'es-en': [116461865, 'Apache-2.0'], 'es-fr': [127328193, 'Apache-2.0'], 'es-it': [110143298, 'Apache-2.0'],
    'es-ru': [116135644, 'Apache-2.0'], 'et-en': [109887508, 'Apache-2.0'], 'fi-de': [110652034, 'Apache-2.0'], 'fi-en': [110741542, 'Apache-2.0'],
    'fr-de': [112385038, 'Apache-2.0'], 'fr-en': [110512589, 'Apache-2.0'], 'fr-es': [127328193, 'Apache-2.0'], 'fr-ro': [107587321, 'Apache-2.0'],
    'fr-ru': [117145214, 'Apache-2.0'], 'hi-en': [113182257, 'Apache-2.0'], 'hu-en': [113898837, 'Apache-2.0'], 'id-en': [105587058, 'Apache-2.0'],
    'it-en': [133056637, 'Apache-2.0'], 'it-es': [110143298, 'Apache-2.0'], 'it-fr': [110469325, 'Apache-2.0'], 'ja-en': [111915733, 'Apache-2.0'],
    'ko-en': [116619016, 'Apache-2.0'], 'nl-en': [118595623, 'Apache-2.0'], 'nl-fr': [108638824, 'Apache-2.0'], 'pl-en': [114761458, 'Apache-2.0'],
    'ro-fr': [107587323, 'Apache-2.0'], 'ru-en': [115171424, 'CC-BY-4.0'], 'ru-es': [116135644, 'Apache-2.0'], 'ru-fr': [117145249, 'Apache-2.0'],
    'ru-uk': [111244409, 'Apache-2.0'], 'sv-en': [107317061, 'Apache-2.0'], 'th-en': [114897253, 'Apache-2.0'], 'tr-en': [113754207, 'Apache-2.0'],
    'uk-en': [113911746, 'Apache-2.0'], 'uk-ru': [111244409, 'Apache-2.0'], 'vi-en': [104402977, 'Apache-2.0'], 'xh-en': [112408970, 'Apache-2.0'],
    'zh-en': [116473330, 'CC-BY-4.0'],
};

/**
 * @typedef {object} CatalogEntry a model that can be downloaded (the quantized ONNX files on Hugging Face)
 * @property {string} key its folder in the storage
 * @property {string} repository
 * @property {'marian' | 'm2m_100'} family
 * @property {string[]} sources
 * @property {string[]} targets
 * @property {number} size bytes
 * @property {string} license
 * @property {string[]} files
 */

/** @type {CatalogEntry[]} M2M100 first, then the pairs of Opus-MT */
export const MODEL_CATALOG = [
    { key: 'm2m100_418M', repository: 'Xenova/m2m100_418M', family: 'm2m_100', sources: M2M_LANGUAGES, targets: M2M_LANGUAGES, size: 638118754, license: 'MIT', files: M2M_FILES },
    ...Object.entries(OPUS).map(([pair, [size, license]]) => {
        const [from, to] = pair.split('-');
        return { key: `opus-mt-${pair}`, repository: `Xenova/opus-mt-${pair}`, family: 'marian', sources: [from], targets: [to], size, license, files: MARIAN_FILES };
    }),
];

/** @returns {string[]} every language of the catalog */
export function catalogLanguages() {
    return [...new Set(MODEL_CATALOG.flatMap(entry => [...entry.sources, ...entry.targets]))];
}

/**
 * What to download to translate a pair the installed models cannot: Opus-MT when it has the pair, or
 * both halves through English, and always the multilingual model as a choice.
 * @param {string} from
 * @param {string} to
 * @param {Set<string>} installed the keys of the models installed
 * @returns {{ keys: string[], size: number }[]} ways to get it, the smallest first
 */
export function suggestDownloads(from, to, installed) {
    const find = key => MODEL_CATALOG.find(entry => entry.key === key);
    const ways = [];
    const direct = find(`opus-mt-${from}-${to}`);
    if (direct) ways.push([direct]);
    else if (from !== 'en' && to !== 'en') {
        const first = find(`opus-mt-${from}-en`), second = find(`opus-mt-en-${to}`);
        if (first && second) ways.push([first, second]);
    }
    const multilingual = MODEL_CATALOG.find(entry => entry.family === 'm2m_100' && entry.sources.includes(from) && entry.targets.includes(to));
    if (multilingual) ways.push([multilingual]);
    return ways
        .map(way => way.filter(entry => !installed.has(entry.key)))
        .filter(way => way.length)
        .map(way => ({ keys: way.map(entry => entry.key), size: way.reduce((sum, entry) => sum + entry.size, 0) }))
        .sort((a, b) => a.size - b.size);
}
