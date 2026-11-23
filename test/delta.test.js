import { Store, DataFactory } from 'n3';
import { Delta, PatchError, quadKey } from '../src/delta.js';
const { namedNode: n, literal: l, quad: q, blankNode: b, defaultGraph } = DataFactory;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } };
const ex = (x) => n('http://ex.org/' + x);

const A = q(ex('s'), ex('p'), l('1'));
const B = q(ex('s'), ex('p'), l('1', 'en'));
const C = q(ex('s'), ex('p'), ex('o'), ex('g'));
const D = q(ex('s'), ex('p'), l('1', n('http://www.w3.org/2001/XMLSchema#integer')));
ok(new Set([A, B, C, D].map(quadKey)).size === 4, 'keys distinguish lang/datatype/graph');
ok(quadKey(A) === quadKey(q(ex('s'), ex('p'), l('1'), defaultGraph())), 'equal quads, equal keys');

// diff / apply / invert round trip
const before = new Store([A, B]), after = new Store([B, C, D]);
const d = Delta.diff(before, after);
ok(d.deletions.length === 1 && d.additions.length === 2, 'diff sizes');
const s = new Store([A, B]); d.apply(s);
ok(s.size === 3 && s.has(C) && s.has(D) && s.has(B) && !s.has(A), 'apply result');
d.invert().apply(s);
ok(s.size === 2 && s.has(A) && s.has(B), 'invert restores');

// delete-then-add overlap leaves the quad present
const o = new Delta({ additions: [A], deletions: [A] }); const s2 = new Store([A]); o.apply(s2);
ok(s2.has(A), 'overlap: present');

// strict fails cleanly, changes nothing
const st = new Delta({ deletions: [C], additions: [D], strict: true }); const s3 = new Store([A]);
let err; try { st.apply(s3); } catch (e) { err = e; }
ok(err instanceof PatchError && s3.size === 1 && !s3.has(D), 'strict precondition, untouched');
ok(new Delta({ deletions: [C], additions: [D] }).apply(new Store([A])).size === 2, 'non-strict tolerates absent delete');

// rollback when the target throws midway
class Flaky extends Store { add(x) { if (x === C) throw new Error('boom'); return super.add(x); } }
const fl = new Flaky([A, B]);
const r = new Delta({ deletions: [A], additions: [D, C] });
err = null; try { r.apply(fl); } catch (e) { err = e; }
ok(err?.message === 'boom' && fl.size === 2 && fl.has(A) && fl.has(B) && !fl.has(D), 'rollback');

// composition matches sequential application
const rnd = () => [A, B, C, D, q(ex('x'), ex('p'), b('z'))].filter(() => Math.random() < .5);
for (let i = 0; i < 2000; i++) {
  const s0 = rnd(), s1 = rnd(), s2 = rnd();
  const d1 = Delta.diff(s0, s1), d2 = Delta.diff(s1, s2);
  const x = new Store(s0), y = new Store(s0);
  d1.apply(x); d2.apply(x); d1.then(d2).apply(y);
  ok(x.size === y.size && [...x].every((t) => y.has(t)), 'then() == sequential');
  const z = new Store(s0); d1.apply(z); d1.invert().apply(z);
  ok(z.size === s0.length && s0.every((t) => z.has(t)), 'diff then invert is identity');
}
console.log(fails ? `${fails} failures` : 'all passed');
process.exitCode = fails ? 1 : 0;
