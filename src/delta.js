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

export class PatchError extends Error {
  constructor(message, quad) {
    super(message);
    this.name = 'PatchError';
    this.quad = quad;
  }
}

const term = (t) => {
  if (!t) return '';
  switch (t.termType) {
    case 'Literal':
      return `L${t.language ? '@' + t.language : '^' + (t.datatype?.value ?? '')}\u0000${t.value}`;
    case 'Quad': return `<<${quadKey(t)}>>`; // RDF-star
    default: return t.termType[0] + '\u0000' + t.value;
  }
};

/** A string that is identical for equal quads, used for dedupe and set arithmetic. */
export const quadKey = (q) =>
  [q.subject, q.predicate, q.object, q.graph].map(term).join('\u0001');

const POSITIONS = ['subject', 'predicate', 'object', 'graph'];
const isVar = (t) => t?.termType === 'Variable';

/** True if any term of the quad is a Variable, i.e. it is a wildcard deletion. */
export const isPattern = (q) => POSITIONS.some((p) => isVar(q[p]));

/** Does the (possibly wildcard) pattern match the ground quad? */
export const matches = (pattern, q) =>
  POSITIONS.every((p) => isVar(pattern[p]) || term(pattern[p]) === term(q[p]));

const toMap = (quads) => {
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
  constructor({ additions = [], deletions = [], strict = false } = {}) {
    this._add = toMap(additions);
    this._del = toMap(deletions);
    this.strict = strict;
    Object.freeze(this);
  }

  get additions() { return [...this._add.values()]; }
  get deletions() { return [...this._del.values()]; }
  get isEmpty() { return this._add.size === 0 && this._del.size === 0; }

  /** The delta that takes `before` to `after`. Both are iterables of quads. */
  static diff(before, after, { strict = false } = {}) {
    const b = toMap(before), a = toMap(after);
    return new Delta({
      deletions: [...b].filter(([k]) => !a.has(k)).map(([, q]) => q),
      additions: [...a].filter(([k]) => !b.has(k)).map(([, q]) => q),
      strict,
    });
  }

  /** The delta that undoes this one (exact when this delta was made by diff()). */
  invert() {
    const wild = this.deletions.find(isPattern);
    if (wild) throw new PatchError('a delta with wildcard deletions cannot be inverted', wild);
    return new Delta({ additions: this._del.values(), deletions: this._add.values(), strict: this.strict });
  }

  /**
   * `this` followed by `next`, as a single delta. The result is not strict:
   * its deletions can include quads that `this` itself adds.
   */
  then(next) {
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
  apply(target) {
    const doomed = new Map();
    for (const q of this._del.values()) {
      if (!isPattern(q)) {
        if (this.strict && !target.has(q))
          throw new PatchError('strict delete of a quad that is not present', q);
        doomed.set(quadKey(q), q);
        continue;
      }
      if (typeof target.match !== 'function')
        throw new TypeError('wildcard deletions need a target with match()');
      const w = (t) => (isVar(t) ? null : t);
      for (const m of [...target.match(w(q.subject), w(q.predicate), w(q.object), w(q.graph))])
        doomed.set(quadKey(m), m);
    }

    const removed = [], added = [];
    try {
      for (const q of doomed.values()) {
        if (target.has(q)) { target.delete(q); removed.push(q); }
      }
      for (const q of this._add.values()) {
        if (!target.has(q)) { target.add(q); added.push(q); }
      }
    } catch (e) {
      for (const q of added) target.delete(q);
      for (const q of removed) target.add(q);
      throw e;
    }
    return target;
  }
}
