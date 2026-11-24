// rdf-kv.mjs
//
// RDF-KV (https://doriantaylor.com/rdf-kv): turn ordinary key-value pairs,
// e.g. an application/x-www-form-urlencoded POST body, into an RDF changeset.
// A port of RDF::KV (https://github.com/doriantaylor/rb-rdf-kv). The
// changeset is a Delta (see delta.mjs).
//
// Terms are made with an RDF/JS DataFactory (N3.DataFactory, rdf-ext, ...);
// a minimal built-in one is used if you don't pass `factory`.
//
//   const kv = new KV({ subject: factory.namedNode('https://x.org/page') });
//   const delta = kv.process(new URLSearchParams(body));
//   delta.apply(store);

import {
    NamedNode, BlankNode, Variable, Literal, Statement, // classes
    isTerm, isNamedNode, isBlankNode, isLiteral, // predicate tests
    sym, lit, blankNode, variable, defaultGraph, quad // factories
} from 'rdflib';

import { toNCName } from '@methodandstructure/uuid-ncname';

import { Delta } from './delta.js';

export class KVError extends Error {
    constructor(message) {
        super(message);
        this.name = 'KVError';
    }
}

// ---- a minimal RDF/JS data factory -----------------------------------------

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANGSTRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

const DEFAULT_GRAPH = defaultGraph();

export const defaultFactory = {
    namedNode:    sym,
    blankNode:    blankNode,
    variable:     variable,
    defaultGraph: defaultGraph,
    literal:      lit,
    quad:         quad
};

// ---- grammar -----------------------------------------------------------------
//
// Mirrors the Ruby. Whitespace is ASCII-only, as in Ruby's \s, and the ^/$
// anchors are line anchors (the 'm' flag), also as in Ruby, so keys may span
// lines. (One fix: the Ruby has a single \s, not \s+, between the predicate
// and the graph of a subject/predicate/graph key, which rejects the
// multi-line examples in the protocol document.)

const WS = '[ \\t\\r\\n\\f\\v]';
const NWS = '[^ \\t\\r\\n\\f\\v]';

// some xml grammar
const NCNSCHAR = 'A-Za-z_\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02ff' +
    '\\u0370-\\u037d\\u037f-\\u1fff\\u200c-\\u200d\\u2070-\\u218f' +
    '\\u2c00-\\u2fef\\u3001-\\ud7ff\\uf900-\\ufdcf\\ufdf0-\\ufffd' +
    '\\u{10000}-\\u{effff}';
const NCNAMECHAR = `-.0-9${NCNSCHAR}\\u00b7\\u0300-\\u036f\\u203f-\\u2040`;
const NCNAME = `[${NCNSCHAR}][${NCNAMECHAR}]*`;

// the actual rdf-kv grammar
const MODIFIER = '(?:[!=+-]|[+-]!|![+-])';
const PREFIX = `(?:${NCNAME}|[A-Za-z][0-9A-Za-z.+-]*)`;
const TERM = `(?:${PREFIX}:${NWS}*)`;
const RFC5646 = '(?:[A-Za-z]+(?:-[0-9A-Za-z]+)*)';
const DESIGNATOR = `(?:[:_']|@${RFC5646}|\\^${TERM})`;
// (the Ruby original ends this with a literal space-star rather than \s*)
const DECLARATION = new RegExp(`^${WS}*\\$${WS}+(${NCNAME})(?:${WS}+(\\$))? *$`, 'mu');
const MACRO = `(?:\\$\\{(${NCNAME})\\}|\\$(${NCNAME}))`;
const MACRO_RE = new RegExp(MACRO, 'u');
const PARTIAL_STMT =
    `^${WS}*(?:(${MODIFIER})${WS}+)?` +
        `(?:(${TERM})(?:${WS}+(${TERM}))?(?:${WS}+(${DESIGNATOR}))?|` +
        `(${TERM})${WS}+(${DESIGNATOR})${WS}+(${TERM})|` +
        `(${TERM})${WS}+(${TERM})(?:${WS}+(${DESIGNATOR}))?${WS}+(${TERM}))` +
        `(?:${WS}+(\\$))?${WS}*$`;
const GRAMMAR = new RegExp(PARTIAL_STMT, 'mu');
const MAP = ['modifier', 'term1', 'term2', 'designator', 'term1', 'designator', 'graph',
    'term1', 'term2', 'designator', 'graph', 'deref'];

// keys that could be statement templates: two tokens on a line, or a ':' or '$'
const CANDIDATE = new RegExp(`(?:^${WS}*${NWS}+${WS}+${NWS}+.*?$|[:\\$])`, 'mu');
const PREFIXED = new RegExp(`^(${NCNAME}):(${NWS}*)$`, 'mu');
const PREFIX_DECL = new RegExp(`^${WS}*(${NCNAME}):${WS}+(.*)$`, 'mu');

// ---- helpers -------------------------------------------------------------------

const strip = (s) => s.replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/g, '');

const isResource = (x) => isNamedNode(x) || isBlankNode(x);
const macroNames = (s) => [...s.matchAll(new RegExp(MACRO, 'gu'))].map((m) => m[1] ?? m[2]);

const UUID = () => globalThis.crypto.randomUUID();
const UUIDNCName = () => toNCName(UUID());

// resolve a (possibly relative) IRI reference against a base IRI
function resolveAgainst(base, ref) {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) return ref; // already absolute
    try {
        return new URL(ref, base).href;
    } catch {
        throw new KVError(`Cannot resolve ${JSON.stringify(ref)} against ${base}`);
    }
}

// normalize the input to a Map of key -> flat array of strings
function entriesOf(data) {
    const grouped = new Map();
    const add = (k, v) => {
        k = String(k);
        if (!grouped.has(k)) grouped.set(k, []);
        const list = grouped.get(k);
        if (Array.isArray(v)) list.push(...v.flat(Infinity).map((x) => String(x ?? '')));
        else list.push(String(v ?? ''));
    };
    if (Array.isArray(data)) {
        for (const [k, v] of data) add(k, v);
    }
    else if (data && typeof data.entries === 'function') {
        for (const [k, v] of data.entries()) add(k, v); // Map, URLSearchParams, FormData
    }
    else if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) add(k, v);
    }
    else {
        throw new TypeError('data must be an Object or Map');
    }
    return grouped;
}

// Given a map of macro name -> values (strings, or functions that make them),
// dereference the given strings and return the (Cartesian) product.
function derefContent(strings, macros) {
    if (!Array.isArray(strings)) strings = [strings];
    // bail out early if there is nothing to do
    if (!strings.some((s) => MACRO_RE.test(s))) return strings;

    const out = [];
    for (const s of strings) {
        const found = [...s.matchAll(new RegExp(MACRO, 'gu'))];
        // (the Ruby yields a spurious extra '' for a macro-free string here)
        if (found.length === 0) { out.push(s); continue; }

        let chunks = [];
        found.forEach((m, i) => {
            const name = m[1] ?? m[2];
            const pre = i === 0 ? s.slice(0, m.index) : '';
            const post = s.slice(m.index + m[0].length, found[i + 1]?.index ?? s.length);
            const vals = macros.get(name);
            // an unbound macro is left as-is
            const x = vals
                ? vals.map((v) => pre + (typeof v === 'function' ? v() : v) + post)
                : [pre + m[0] + post];

            if (chunks.length === 0) chunks = x;
            else if (x.length) chunks = chunks.flatMap((c) => x.map((d) => c + d));
        });
        out.push(...chunks);
    }
    return out;
}

// ---- the processor -------------------------------------------------------------

export class KV {
    /**
     * @param {object} o
     * @param {Term}   o.subject  default subject (NamedNode or BlankNode). Required.
     * @param {Term}   [o.graph]  default graph
     * @param {object|Map} [o.prefixes] prefix -> namespace IRI (string or NamedNode)
     * @param {Function} [o.callback] called with each term, returns a term
     * @param {object} [o.factory] RDF/JS DataFactory (default: a minimal built-in)
     * @param {Function} [o.idGenerator] returns a fresh identifier, used for blank
     *   node labels and wildcard variable names. TODO: this is where uuid-ncname plugs in.
     */
    constructor({ subject, graph = null, prefixes = {}, callback = null,
        factory = defaultFactory, idGenerator = UUIDNCName } = {}) {
            if (!isResource(subject)) throw new TypeError('subject must be a resource');
            if (graph !== null && !isResource(graph)) throw new TypeError('graph must be a resource');
            if (callback !== null && typeof callback !== 'function')
                throw new TypeError('callback must be callable');

            this.factory = factory;
            this.subject = subject;
            this.graph = graph;
            this.callback = callback;
            this._newId = idGenerator;

            // just the classics
            this.prefixes = new Map(Object.entries({
                rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
                rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
                owl: 'http://www.w3.org/2002/07/owl#',
                xsd: 'http://www.w3.org/2001/XMLSchema#',
            }));
            const given = prefixes instanceof Map ? prefixes.entries() : Object.entries(prefixes);
            for (const [k, v] of given) this.prefixes.set(String(k), isTerm(v) ? v.value : String(v));

            // generated macros: each reference calls the function afresh
            this._generated = {
                NEW_UUID: () => UUID(),
                NEW_UUID_URN: () => `urn:uuid:${UUID()}`,
                NEW_BNODE: () => `_:${this._newId()}`,
                NEW_TIME_UTC: () => new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
            };
        }

    // unconditionally return a uri or bnode
    _resolve(term) {
        if (isTerm(term)) return term;
        term = String(term);
        const f = this.factory;

        // bnode ahoy
        if (term.startsWith('_:')) return f.blankNode(term.slice(2));

        // ugh now we gotta do urls
        const m = PREFIXED.exec(term);
        if (m) {
            const [, prefix, slug] = m;
            const ns = this.prefixes.get(prefix);
            if (!slug.startsWith('/') && ns !== undefined) return f.namedNode(ns + slug);
        }

        // now resolve against base
        return f.namedNode(resolveAgainst(this.subject.value, term));
    }

    // may accept and respond with null
    _coerce(token, hint = ':', langdt = null) {
        if (token === null || token === undefined) return null;
        if (isTerm(token)) return token;
        const f = this.factory;
        let term;
        if (hint === ':' || hint === '_') {
            if (token === '') return null;
            if (hint === '_' && !token.startsWith('_:')) token = '_:' + token;
            term = this._resolve(token);
        }
        else if (hint === '@') {
            term = f.literal(token, String(langdt ?? ''));
        }
        else if (hint === '^') {
            if (!isResource(langdt)) throw new TypeError('datatype must be a resource');
            term = f.literal(token, langdt);
        }
        else if (hint === "'") {
            term = f.literal(token);
        }
        else {
            throw new TypeError(`Unrecognized hint (${hint})`);
        }

        // call the callback if we have one
        return this.callback ? this.callback(term) : term;
    }

    // Given the macro declarations (name -> [[value, deref flag], ...]),
    // dereference any recursively-defined macros and return a map of name ->
    // array of values.
    _massage(macros) {
        const seen = new Set();
        const done = new Map(Object.entries(this._generated).map(([k, fn]) => [k, [fn]]));
        const pending = new Map([...macros].filter(([k]) => !(k in this._generated)));
        let queue = pending.size ? [pending.keys().next().value] : [];

        while (queue.length) {
            const k = queue.shift();
            seen.add(k);
            const vals = macros.get(k);

            // done and pending macros within the macros
            const dm = new Set(), pm = new Set();
            for (const pair of vals) {
                const [val, deref] = pair;
                if (!deref) continue;

                if (Array.isArray(deref)) {
                    // see below where deref is replaced
                    for (const m of deref) (done.has(m) ? dm : pm).add(m);
                }
                else {
                    const m = new Set();
                    for (const x of macroNames(val)) {
                        if (!macros.has(x)) continue;
                        if (x === k) throw new Error(`Self-reference found: ${x}`);
                        m.add(x);
                        (done.has(x) ? dm : pm).add(x);
                    }
                    // replace the deref flag with the elements to deref with
                    pair[1] = m.size ? [...m].sort() : false;
                }
            }

            // macro values have pending matches
            if (pm.size) {
                const q = [];
                for (const m of pm) {
                    if (seen.has(m)) throw new Error(`Cycle detected between ${k} and ${m}`);
                    q.push(m);
                }
                // put the current key back on the queue but put the dependencies first
                queue = [...q, k, ...queue];
                continue;
            }

            const raw = vals.map((p) => p[0]);
            done.set(k, dm.size ? derefContent(raw, done) : raw);

            // remember to remove this guy or we'll loop forever
            pending.delete(k);

            // replenish the queue with another pending object
            if (queue.length === 0 && pending.size) queue.push(pending.keys().next().value);
        }

        return done;
    }

    /**
     * Process a hash of form input.
     *
     * This may change the state of the processor (subject, graph, prefixes), so
     * while it can be reused for multiple hashes, don't reuse it across requests.
     *
     * @param {object|Map|URLSearchParams|FormData|Array<[string, string|string[]]>} data
     * @returns {Delta} a delta containing the results
     */
    process(data) {
        const f = this.factory;
        const input = entriesOf(data);
        let macros = new Map(Object.entries(this._generated).map(([k, fn]) => [k, [[fn, false]]]));
        const maybe = new Map(); // candidates (the discard pile is just ignored)

        for (const [k, v] of input) {
            // step 1: pull out all the macro declarations
            const m = DECLARATION.exec(k);
            if (m) {
                const name = m[1];
                const sigil = !!m[2];
                // skip over generated macros
                if (name in this._generated) continue;
                // step 1.0.1: create [content, deref flag] pairs
                if (!macros.has(name)) macros.set(name, []);
                macros.get(name).push(...v.map((x) => [x, sigil]));
            }
            else if (CANDIDATE.test(k)) {
                maybe.set(k, v);
            }
        }

        // step 2: dereference all the macros (that asked to be dereferenced)
        try {
            macros = this._massage(macros);
        } catch (e) {
            throw new KVError(e.message);
        }

        // step 3: apply special control macros (which modify self)
        try {
            const subj = macros.get('SUBJECT');
            if (subj && subj.length) this.subject = this._resolve(subj[subj.length - 1]);
            const grph = macros.get('GRAPH');
            if (grph && grph.length) this.graph = this._resolve(grph[grph.length - 1]);
            for (const v of macros.get('PREFIX') ?? []) {
                const m = PREFIX_DECL.exec(v);
                if (m) this.prefixes.set(m[1], m[2]);
            }
        } catch (e) {
            throw e instanceof KVError ? e : new KVError(e.message);
        }

        // this will be our output
        const ins = [], del = [];

        for (const [key, vals] of maybe) {
            // this will return an array now
            const templates = derefContent(key, macros);
            const values0 = [...new Set(vals.map(strip))];

            // this is only this way because of macros
            for (const template of templates) {
                const tokens = GRAMMAR.exec(template);
                if (!tokens) continue;
                const caps = tokens.slice(1);
                if (caps.length !== MAP.length)
                    throw new Error('INTERNAL ERROR: Regexp captures do not match template');

                // first match wins for each slot
                const c = {};
                MAP.forEach((slot, i) => { if (c[slot] == null) c[slot] = caps[i]; });

                const mod = new Set((c.modifier ?? '').split(''));

                let desig;
                if (c.designator) {
                    const sigil = c.designator[0];
                    let symbol = c.designator.slice(1);
                    if (sigil === '^') symbol = this._resolve(symbol);
                    desig = symbol === '' ? [sigil] : [sigil, symbol];
                }
                else {
                    desig = [mod.has('!') ? ':' : "'"];
                }

                for (const which of ['term1', 'term2', 'graph']) {
                    if (!c[which]) continue;
                    let t = this._resolve(c[which]);
                    if (this.callback) t = this.callback(t);
                    c[which] = t;
                }

                // these are the values we actually use; ensure they are duplicated
                const values = [...(c.deref ? derefContent(values0, macros) : values0)];

                const g = this._coerce(c.graph) ?? this.graph ?? f.defaultGraph();
                let s, p, o;

                // shorthand for reverse
                const reverse = mod.has('!');
                if (reverse) {
                    // literals make no sense on reverse statements
                    if (desig[0] !== '_' && desig[0] !== ':') continue;
                    // these terms have already been resolved/coerced
                    p = c.term1;
                    o = c.term2 ?? this.subject;
                }
                else {
                    // XXX DO WE NEED THIS ANYMORE? (the callback is applied twice here,
                    // as in the Ruby original)
                    [s, p] = (c.term2 ? [c.term1, c.term2] : [this.subject, c.term1]).map((t) => {
                        t = this._resolve(t);
                        return this.callback ? this.callback(t) : t;
                    });
                }

                // the operation depends on whether the `-` modifier is present
                const target = mod.has('-') ? del : ins;

                // if we're deleting triples and the values contain an empty
                // string then we're deleting a wildcard, same if we `=` overwrite
                if (!reverse && ((target === del && values.includes('')) || mod.has('='))) {
                    // we don't do this in reverse, probably because it is too easy to
                    // shoot yourself in the foot
                    del.push(f.quad(s, p, f.variable(this._newId()), g));

                    // nuke these since it will be pointless to evaluate further
                    if (target === del) values.length = 0;
                }

                // otherwise the code is basically the same
                for (const x of values) {
                    // get what should be guaranteed to be an RDF term or null
                    const t = this._coerce(x, ...desig);
                    if (!t) continue;

                    // now we assign the appropriate direction
                    if (reverse) s = t; else o = t;

                    // this will be either insert or delete
                    target.push(f.quad(s, p, o, g));
                }
            }
        }

        return new Delta({ additions: ins, deletions: del });
    }
}
