// delta.mjs
//
// An atomic RDF delta: a set of quads to delete and a set of quads to add,
// applied as (target \ deletions) ∪ additions. Works with any RDF/JS-style
// quads and any target exposing add(quad), delete(quad) and has(quad)
// (DatasetCore, N3.Store, rdf-ext datasets, ...). No dependencies.
//
// A deletion may be a *pattern*: a quad in which any term is a Variable
// (termType 'Variable') matches every quad that agrees with it on the
// non-variable positions, i.e. a wildcard. Patterns need the target to
// implement match(s, p, o, g), as DatasetCore does.

import { isQuad, isVariable, isStore, Formula } from 'rdflib';

export class PatchError extends Error {
    constructor(message, statement) {
        super(message);
        this.name = 'PatchError';
        this.statement = statement;
    }
}

const term = (t) => {
    if (!t) return '';
    return t.toCanonical();
};

/** A string that is identical for equal quads, used for dedupe and set arithmetic. */
export const quadKey = (q) => {
    if (!isQuad(q)) throw TypeError(`${q} is not a quad`);
    return q.toCanonical();
};

const POSITIONS = ['subject', 'predicate', 'object', 'graph'];

/** True if any term of the quad is a Variable, i.e. it is a wildcard deletion. */
export const isPattern = (q) => POSITIONS.some((p) => isVariable(q[p]));

/** Does the (possibly wildcard) pattern match the ground quad? */
export const matches = (pattern, q) =>
    POSITIONS.every((p) => isVariable(pattern[p]) || term(pattern[p]) === term(q[p]));

const toMap = (quads) => {
    if (quads.statements) quads = quads.statements;
    const m = new Map();
    for (const q of quads ?? []) m.set(quadKey(q), q);
    return m;
};

export class Delta {
    /**
     * @param {object} [o]
     * @param {Iterable<Quad>} [o.additions]
     * @param {Iterable<Quad>} [o.deletions] ground quads or wildcard patterns
     * @param {boolean} [o.strict=false] if true, apply() fails (changing nothing)
     *   when any ground deletion is absent from the target
     */
    constructor ({ additions = [], deletions = [], strict = false } = {}) {
        this._add = toMap(additions);
        this._del = toMap(deletions);
        this.strict = strict;
        Object.freeze(this);
    }

    get additions () { return [...this._add.values()]; }
    get deletions () { return [...this._del.values()]; }
    get isEmpty () { return this._add.size === 0 && this._del.size === 0; }

    /** The delta that takes `before` to `after`. Both are Formulas. */
    static diff (before, after, { strict = false } = {}) {
        const te = (name) => new TypeError(`${name} must be either a Formula (Store) or an Array`);
        if (!isStore(before)) {
            if (!Array.isArray(before)) throw te('before');
            before = new Formula(before);
        }
        if (!isStore(after)) {
            if (!Array.isArray(after)) throw te('after');
            after = new Formula(after);
        }

        const dels = new Map(), adds = new Map ();
        const state = [
            [before, after, dels],
            [after, before, adds],
        ];

        for (const [src, tgt, map] of state)
            for (const stmt of src.statements)
                if (!tgt.holdsStatement(stmt)) map.set(quadKey(stmt), stmt);

        return new Delta({
            deletions: [...dels.values()],
            additions: [...adds.values()],
            strict
        });
    }

    /** The delta that undoes this one (exact when this delta was made by diff()). */
    invert () {
        const wild = this.deletions.find(isPattern);
        if (wild) throw new PatchError('a delta with wildcard deletions cannot be inverted', wild);
        return new Delta({ additions: this.deletions, deletions: this.additions, strict: this.strict });
    }

    /**
     * `this` followed by `next`, as a single delta. The result is not strict:
     * its deletions can include quads that `this` itself adds.
     */
    merge (next) {
        const pats = next.deletions.filter(isPattern);
        const additions = [...this._add].filter(([k, q]) =>
            !next._del.has(k) && !pats.some((p) => matches(p, q))).map(([, q]) => q);
        return new Delta({
            additions: [...additions, ...next._add.values()],
            deletions: [...this._del.values(), ...next._del.values()],
        });
    }

    /**
     * Apply to `target`, all or nothing. Strict preconditions are checked and
     * wildcards expanded before anything is touched; if the target throws
     * partway through, every change made so far is rolled back, then the
     * error is rethrown. (This is atomic with respect to *this* call only. If
     * the target is shared and mutable by others, or has real transactions,
     * use those instead.)
     */
    apply (target) {
        if (!isStore(target)) throw new TypeError(`${target.toString()} is not a Store`);

        const doomed = new Map();
        for (const [k, q] of this._del.entries()) {
            if (isPattern(q)) {
                const args = POSITIONS.map(p => isVariable(q[p]) ? null : q[p]);

                for (const m of [...target.match(...args)])
                    doomed.set(quadKey(m), m);
            }
            else if (target.holdsStatement(q)) doomed.set(k, q);
            else if (this.strict)
                throw new PatchError('strict delete of a quad that is not present', q);
        }

        target.remove(Array.from(doomed.values()));
        target.add(Array.from(this._add.values()));

        return target;
    }
}
