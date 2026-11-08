import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Seq2Seq } from './Seq2Seq.js';
import { SentencePiece } from './SentencePiece.js';

const ENCODER_FILES = ['onnx/encoder_model_quantized.onnx', 'encoder_model_quantized.onnx', 'onnx/encoder_model.onnx', 'encoder_model.onnx'];
const DECODER_FILES = ['onnx/decoder_model_merged_quantized.onnx', 'decoder_model_merged_quantized.onnx', 'onnx/decoder_model_merged.onnx', 'decoder_model_merged.onnx'];
/** A result is at most this many times longer than its source, plus LENGTH_SPARE tokens. */
const LENGTH_FACTOR = 3;
const LENGTH_SPARE = 16;

/** Three-letter codes some Opus-MT models name their languages by. */
const TWO_LETTERS = { eng: 'en', ara: 'ar', spa: 'es', hin: 'hi', vie: 'vi', zho: 'zh', fin: 'fi', kor: 'ko', nor: 'no', rus: 'ru', tha: 'th', ukr: 'uk', deu: 'de', fra: 'fr', ita: 'it', por: 'pt', pol: 'pl', tur: 'tr', jpn: 'ja', nld: 'nl', swe: 'sv', ces: 'cs', dan: 'da', hun: 'hu', ron: 'ro', ind: 'id' };

/**
 * @param {string} code
 * @returns {string} its two-letter form, when it has one
 */
function languageCode(code) {
    return TWO_LETTERS[code] ?? code;
}

/**
 * @typedef {object} ModelInfo what the files of a model folder tell, without loading it
 * @property {'marian' | 'm2m_100'} family
 * @property {string[]} sources languages it translates from
 * @property {string[]} targets languages it translates into
 * @property {string} encoder the path of the encoder
 * @property {string} decoder the path of the decoder
 */

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * @param {string} folder
 * @param {string[]} names
 * @returns {Promise<string>} the first of the files that exists ('' : none)
 */
async function firstFile(folder, names) {
    for (const name of names) {
        const path = join(folder, name);
        if ((await stat(path).catch(() => null))?.isFile()) return path;
    }
    return '';
}

/**
 * @param {string} folder of a model
 * @returns {Promise<ModelInfo>}
 * @throws {Error} why it is not a model this engine can use
 */
export async function readModelInfo(folder) {
    const config = await readJson(join(folder, 'config.json')).catch(() => null);
    if (!config) throw new Error('There is no config.json in the folder.');
    const tokenizer = await readJson(join(folder, 'tokenizer_config.json')).catch(() => ({}));
    const [encoder, decoder] = await Promise.all([firstFile(folder, ENCODER_FILES), firstFile(folder, DECODER_FILES)]);
    if (!encoder) throw new Error('There is no encoder_model*.onnx in the folder.');
    if (!decoder) throw new Error('There is no decoder_model_merged*.onnx in the folder.');
    if (config.model_type === 'marian') {
        if (!tokenizer.source_lang || !tokenizer.target_lang) throw new Error('tokenizer_config.json does not name the languages of the model.');
        return { family: 'marian', sources: [languageCode(tokenizer.source_lang)], targets: [languageCode(tokenizer.target_lang)], encoder, decoder };
    }
    if (config.model_type === 'm2m_100') {
        const languages = (tokenizer.additional_special_tokens ?? []).map(token => token.match(/^__(\w+)__$/)?.[1]).filter(Boolean);
        return { family: 'm2m_100', sources: languages, targets: languages, encoder, decoder };
    }
    throw new Error(`Models of the type ${config.model_type} are not supported.`);
}

/**
 * The tokens of a model: its pieces of SentencePiece to the numbers of its vocabulary and back.
 */
class Vocabulary {

    /** @param {Record<string, number>} vocabulary @param {number} unknown */
    constructor(vocabulary, unknown) {
        this.ids = new Map(Object.entries(vocabulary));
        this.unknown = unknown;
        /** @type {string[]} */
        this.pieces = [];
        for (const [piece, id] of this.ids) this.pieces[id] = piece;
    }

    /** @param {string[]} pieces @returns {number[]} */
    toIds(pieces) {
        return pieces.map(piece => this.ids.get(piece) ?? this.unknown);
    }
}

/**
 * A translation model loaded from its folder: Opus-MT (Marian, one direction) or M2M100 (one model,
 * a language token on both sides).
 */
export class TranslationModel {

    /**
     * @param {typeof import('onnxruntime-node')} ort
     * @param {string} folder
     * @param {{ threads?: number }} [options]
     * @returns {Promise<TranslationModel>}
     */
    static async load(ort, folder, { threads } = {}) {
        const info = await readModelInfo(folder);
        const config = await readJson(join(folder, 'config.json'));
        const vocabulary = await readJson(join(folder, 'vocab.json'));
        const tokenizer = await readJson(join(folder, 'tokenizer_config.json')).catch(() => ({}));
        const spm = async name => new SentencePiece(new Uint8Array(await readFile(join(folder, name))));
        const [source, target] = info.family === 'marian' ? await Promise.all([spm('source.spm'), spm('target.spm')]) : [await spm('sentencepiece.bpe.model'), null];
        const seq2seq = await Seq2Seq.load(ort, info.encoder, info.decoder, { heads: config.decoder_attention_heads, dimension: config.d_model, threads });
        return new TranslationModel(folder, info, config, tokenizer, vocabulary, source, target ?? source, seq2seq);
    }

    constructor(folder, info, config, tokenizer, vocabulary, source, target, seq2seq) {
        this.folder = folder;
        this.info = info;
        this._config = config;
        this._source = source;
        this._target = target;
        this._seq2seq = seq2seq;
        this._vocabulary = new Vocabulary(vocabulary, info.family === 'marian' ? vocabulary['<unk>'] : 3);
        /** @type {Map<string, number>} the token of each language of M2M100 (after the vocabulary, in the order of its list) */
        this._languages = new Map();
        if (info.family === 'm2m_100') {
            const size = this._vocabulary.ids.size;
            (tokenizer.additional_special_tokens ?? []).forEach((token, index) => {
                const language = token.match(/^__(\w+)__$/)?.[1];
                if (language) {
                    this._languages.set(language, size + index);
                    this._vocabulary.pieces[size + index] = token;
                }
            });
        }
        this.maxLength = config.max_length;
    }

    async release() {
        await this._seq2seq.release();
    }

    /**
     * @param {string} language
     * @returns {number}
     */
    _languageToken(language) {
        const token = this._languages.get(language);
        if (token === undefined) throw new Error(`The model does not know the language ${language}.`);
        return token;
    }

    /**
     * @param {string} text
     * @param {string} from
     * @returns {number[]} the source tokens, as the model was trained on them
     */
    encode(text, from) {
        const ids = this._vocabulary.toIds(this._source.encode(text));
        const eos = this._config.eos_token_id;
        return this.info.family === 'm2m_100' ? [this._languageToken(from), ...ids, eos] : [...ids, eos];
    }

    /**
     * @param {number[]} tokens generated
     * @returns {string} the text
     */
    decode(tokens) {
        const special = new Set([this._config.eos_token_id, this._config.pad_token_id, this._config.bos_token_id, ...this._languages.values()]);
        return SentencePiece.decode(tokens.filter(token => !special.has(token)).map(token => this._vocabulary.pieces[token] ?? ''));
    }

    /**
     * Translates one sentence.
     * @param {string} text
     * @param {string} from
     * @param {string} to
     * @param {{ beams?: number, signal?: AbortSignal }} [options]
     * @returns {Promise<string>}
     */
    async translate(text, from, to, { beams = this._config.num_beams ?? 4, signal } = {}) {
        const ids = this.encode(text, from);
        const marian = this.info.family === 'marian';
        const tokens = await this._seq2seq.generate(ids, {
            start: this._config.decoder_start_token_id,
            eos: this._config.eos_token_id,
            banned: marian ? [this._config.pad_token_id] : [],
            forcedFirst: marian ? undefined : this._languageToken(to),
            beams,
            maxLength: Math.min(this.maxLength, ids.length * LENGTH_FACTOR + LENGTH_SPARE),
            earlyStopping: !!this._config.early_stopping,
            signal,
        });
        return this.decode(tokens);
    }

    /**
     * How well each candidate fits as a translation of a text: the average log-probability per token
     * the model gives it (higher is better; comparable between the candidates of one text).
     * @param {string} text
     * @param {string[]} candidates
     * @param {string} from
     * @param {string} to
     * @returns {Promise<{ text: string, score: number }[]>} the best first
     */
    async score(text, candidates, from, to) {
        const ids = this.encode(text, from);
        const marian = this.info.family === 'marian';
        const eos = this._config.eos_token_id;
        const start = this._config.decoder_start_token_id;
        const banned = marian ? [this._config.pad_token_id] : [];
        const scored = [];
        for (const candidate of candidates) {
            const body = [...this._vocabulary.toIds(this._target.encode(candidate)), eos];
            const target = marian ? body : [this._languageToken(to), ...body];
            const sum = await this._seq2seq.logProbability(ids, target, { start, banned, skip: marian ? 0 : 1 });
            scored.push({ text: candidate, score: sum / body.length });
        }
        return scored.sort((a, b) => b.score - a.score);
    }
}
