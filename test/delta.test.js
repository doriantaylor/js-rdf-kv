import { Store, DataFactory, defaultGraph, isQuad } from 'rdflib';
import { Delta, PatchError, quadKey } from '../src/delta.js';
const { namedNode: n, literal: l, quad: q, blankNode: b } = DataFactory;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
const ex = (x) => n('http://ex.org/' + x);

const store = (a, c = Store) => {
    const s = new c();
    s.addAll(a);
    return s;
};

const A = q(ex('s'), ex('p'), l('1'));
const B = q(ex('s'), ex('p'), l('1', 'en'));
const C = q(ex('s'), ex('p'), ex('o'), ex('g'));
const D = q(ex('s'), ex('p'), l('1', n('http://www.w3.org/2001/XMLSchema#integer')));
ok(new Set([A, B, C, D].map(quadKey)).size === 4, 'keys distinguish lang/datatype/graph');
ok(quadKey(A) === quadKey(q(ex('s'), ex('p'), l('1'), defaultGraph())), 'equal quads, equal keys');

// diff / apply / invert round trip
const before = store([A, B]), after = store([B, C, D]);
//console.log(before, after);
const d = Delta.diff(before, after);
ok(d.deletions.length === 1 && d.additions.length === 2, 'diff sizes');
const s = store([A, B]); d.apply(s);
ok(s.length === 3 && s.holdsStatement(C) && s.holdsStatement(D) && s.holdsStatement(B) && !s.holdsStatement(A), 'apply result');
d.invert().apply(s);
ok(s.length === 2 && s.holdsStatement(A) && s.holdsStatement(B), 'invert restores');

// delete-then-add overlap leaves the quad present
const o = new Delta({ additions: [A], deletions: [A] }); const s2 = store([A]); o.apply(s2);
ok(s2.holdsStatement(A), 'overlap: present');

// strict fails cleanly, changes nothing
const st = new Delta({ deletions: [C], additions: [D], strict: true }); const s3 = store([A]);
let err; try { st.apply(s3); } catch (e) { err = e; }
ok(err instanceof PatchError && s3.length === 1 && !s3.holdsStatement(D), 'strict precondition, untouched');
ok(new Delta({ deletions: [C], additions: [D] }).apply(store([A])).length === 2, 'non-strict tolerates absent delete');

// rollback when the target throws midway
class Flaky extends Store {
    add(...x) {
        // console.log(x[0]);
        if (isQuad(x[0]) && C.equals(x[0])) throw new Error('boom');
        return super.add(...x);
    }
}
const fl = store([A, B], Flaky);
const r = new Delta({ deletions: [A], additions: [D, C] });
err = null; try { r.apply(fl); } catch (e) { err = e; }
//console.log(err);
ok(err?.message === 'boom', 'rollback 1');
ok(fl.length === 2, 'rollback 2');
// ok(fl.holdsStatement(A) && fl.holdsStatement(B) && !fl.holdsStatement(D), 'rollback 3');
//    o&& fl.length === 2 && fl.holdsStatement(A) && fl.holdsStatement(B) && !fl.holdsStatement(D), 'rollback');

// composition matches sequential application
const rnd = () => [A, B, C, D, q(ex('x'), ex('p'), b('z'))].filter(() => Math.random() < .5);
for (let i = 0; i < 20; i++) {
    const s0 = rnd(), s1 = rnd(), s2 = rnd();
    // console.log(s0, s1, s2);
    const d1 = Delta.diff(s0, s1), d2 = Delta.diff(s1, s2);
    const x = store(s0), y = store(s0);
    d1.apply(x); d2.apply(x); d1.merge(d2).apply(y);
    ok(x.length === y.length && [...x.statements].every((t) => y.holdsStatement(t)), 'then() == sequential');
    const z = store(s0); d1.apply(z); d1.invert().apply(z);
    ok(z.length === s0.length && s0.every((t) => z.holdsStatement(t)), 'diff then invert is identity');
}
console.log(fails ? `${fails} failures` : 'all passed');
process.exitCode = fails ? 1 : 0;
