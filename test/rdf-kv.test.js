import { Store, DataFactory } from 'rdflib';
import { KV, KVError, defaultFactory } from '../src/rdf-kv.js';
import { quadKey, isPattern } from '../src/delta.js';

let fails = 0, count = 0;
const ok = (c, m) => { count++; if (!c) { fails++; console.log('  FAIL', m); } };
const throws = (fn, cls, m) => {
    try {
        fn();
        ok(false, m + ' (no throw)');
    } catch (e) {
        ok(e instanceof cls, m + ' ' + e.message);
    }
};

for (const [fname, f] of [['builtin', defaultFactory], ['rdflib', DataFactory]]) {
    console.log('factory:', fname);
    const n = f.namedNode, lit = f.literal;
    const suri = n('https://my.website/internet/home/page');
    const root = n('https://my.website/');
    const DC = 'http://purl.org/dc/terms/', XHV = 'http://www.w3.org/1999/xhtml/vocab#';
    const prefixes = {
        dct: DC,
        foaf: 'http://xmlns.com/foaf/0.1/',
        skos: 'http://www.w3.org/2004/02/skos/core#',
        ibis: 'https://vocab.methodandstructure.com/ibis#' };

    const mk = (o = {}) => new KV({ subject: suri, prefixes, factory: f, ...o });
    const has = (list, q) => list.some((x) => quadKey(x) === quadKey(q));
    const st = (s, p, o, g) => f.quad(s, p, o, g ?? f.defaultGraph());
    const title = n(DC + 'title');

    // -- basic operation
    let p = new KV({ subject: suri, prefixes: { xhv: XHV }, factory: f })
        .process({ 'xhv:index :': '/', [DC + 'title']: 'Hi!' });
    ok(has(p.additions, st(suri, n(XHV + 'index'), root)), 'resource stmt');
    ok(has(p.additions, st(suri, title, lit('Hi!'))), 'literal stmt');

    p = mk().process({ '- dct:title': 'Hi!' });
    ok(has(p.deletions, st(suri, title, lit('Hi!'))), 'delete');

    p = mk().process({ '- dct:title': '' });
    const wc = p.deletions.filter(isPattern);
    ok(wc.length === 1 && wc[0].object.termType === 'Variable' && wc[0].subject.equals(suri) && wc[0].predicate.equals(title), 'wildcard delete');

    // -- macros
    let kv = mk();
    kv.process({
        '$ GRAPH': 'http://foo.com/lol',
        '$ SUBJECT': 'urn:uuid:7c04f768-e23f-488b-9357-de15e7e1ac70',
        '$ PREFIX': 'foo: http://foo.bar/prefix' });
    ok(kv.graph.value === 'http://foo.com/lol', 'GRAPH');
    ok(kv.subject.value === 'urn:uuid:7c04f768-e23f-488b-9357-de15e7e1ac70', 'SUBJECT');
    ok(kv.prefixes.get('foo') === 'http://foo.bar/prefix', 'PREFIX');

    p = mk().process({ '$ lol': 'Hi!', 'dct:title $': '$lol' });
    ok(has(p.additions, st(suri, title, lit('Hi!'))), 'set macro');

    p = mk().process({ 'dct:audience : $': '$NEW_UUID_URN' });
    ok(p.additions[0].object.termType === 'NamedNode' && /^urn:uuid:[0-9a-f-]{36}$/.test(p.additions[0].object.value), 'generated urn');

    p = mk().process({
        '$ PREFIX': 'dct: http://purl.org/dc/terms/',
        '$ lol $': '$NEW_UUID_URN',
        'dct:creator : $': '$lol' });

    ok(p.additions.length === 1 && p.additions[0].object.value.startsWith('urn:uuid:'), 'macro set to generated value');

    p = mk().process({ '$ lol': ['Hi!', 'lolwut'], 'dct:title $': '$lol' });
    ok(has(p.additions, st(suri, title, lit('lolwut'))) &&
        has(p.additions, st(suri, title, lit('Hi!'))), 'multi-valued macro');

    p = mk().process({ 'dct:created ^xsd:dateTime $': '$NEW_TIME_UTC' });
    const ts = p.additions[0].object;
    ok(ts.datatype.value === 'http://www.w3.org/2001/XMLSchema#dateTime' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(ts.value), 'timestamp');

    // the big one: applied to a store
    const scheme = 'http://localhost:10101/7b59bc41-a915-428a-9d2e-d62b123d1905';
    const post = {
        '$ SUBJECT $': '$NEW_UUID_URN',
        'ibis:suggested-by :': 'http://localhost:10101/45aa5cec-60dd-4091-af9d-3fc25722db38',
        'dct:created ^xsd:dateTime $': '$NEW_TIME_UTC',
        'dct:creator :': 'http://localhost:10101/person/dorian-taylor#me',
        'skos:inScheme :': scheme,
        '$ type': 'ibis:Issue',
        '= rdf:value $': '$label',
        '= rdf:type : $': '$type',
        '$ label': 'grrr come on',
    };
    const store = new Store();
    kv = mk();
    const d = kv.process(post);
    d.apply(store);
    const inScheme = store.match(null, n('http://www.w3.org/2004/02/skos/core#inScheme'), null, null);
    ok(inScheme.length === 1 && [...inScheme][0].object.value === scheme, 'weird test: inScheme');
    ok(kv.subject.value.startsWith('urn:uuid:'), 'weird test: new subject');
    ok(store.match(null, n('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), n('https://vocab.methodandstructure.com/ibis#Issue'), null).length === 1, 'weird test: type via macro');
    ok(store.match(null, n('http://www.w3.org/1999/02/22-rdf-syntax-ns#value'), lit('grrr come on'), null).length === 1, 'weird test: value via macro');

    // -- the rest of the protocol
    p = mk().process({ 'dct:description @en': 'hello' });
    ok(has(p.additions, st(suri, n(DC + 'description'), lit('hello', 'en'))), 'language tag');

    p = mk().process({ [DC + 'created ^http://www.w3.org/2001/XMLSchema#date']: '2013-09-17' });
    ok(p.additions[0].object.datatype.value.endsWith('#date'), 'full-IRI datatype');

    p = mk().process({ 'http://example.com/other dct:title': 'x' });
    ok(has(p.additions, st(n('http://example.com/other'), title, lit('x'))), 'explicit subject');

    p = mk().process({ 'dct:title \' http://example.com/g': 'x' });
    ok(has(p.additions, st(suri, title, lit('x'), n('http://example.com/g'))), 'graph via designator');

    p = mk().process({ 'http://example.com/s dct:title http://example.com/g': 'x' });
    ok(has(p.additions, st(n('http://example.com/s'), title, lit('x'), n('http://example.com/g'))), 'subject + graph');

    p = mk().process({ '! dct:creator': 'http://example.com/bob' });
    ok(has(p.additions, st(n('http://example.com/bob'), n(DC + 'creator'), suri)), 'reverse');
    p = mk().process({ '! dct:creator ': 'x' }); // ('x' relative => resolved; still a resource)
    ok(p.additions.length === 1 && p.additions[0].object.equals(suri), 'reverse with relative value');

    p = mk().process({ 'dct:relation _': 'foo' });
    ok(p.additions[0].object.termType === 'BlankNode' && p.additions[0].object.value === 'foo', 'bnode designator');
    p = mk().process({ 'dct:relation _': '_:bar' });
    ok(p.additions[0].object.value === 'bar', 'bnode with prefix');

    p = mk().process({ '+ dct:title': 'x', 'unrelated': 'junk', 'name': 'also junk' });
    ok(p.additions.length === 1 && p.deletions.length === 0, 'plus modifier; non-matching input ignored');

    // add/subtract/overwrite against a store
    const s2 = new Store();
    s2.addAll([st(suri, title, lit('old')), st(suri, title, lit('older')), st(suri, n(DC + 'creator'), n('http://example.com/bob'))]);
    mk().process({ '= dct:title': 'new' }).apply(s2);
    ok(s2.length === 2 && s2.holdsStatement(st(suri, title, lit('new'))) && !s2.holdsStatement(st(suri, title, lit('old'))), '= overwrites');
    mk().process({ '- dct:title': '' }).apply(s2);
    ok(s2.length === 1 && !s2.holdsStatement(st(suri, title, lit('new'))), '- with empty value wipes sp pairs');
    mk().process({ '- dct:creator :': 'http://example.com/bob' }).apply(s2);
    ok(s2.length === 0, '- with a value deletes just that one');

    // doc example: the three-select date
    p = mk().process({ '$ y': '2013', '$ m': '09', '$ d': '17', 'dct:created ^xsd:date $': '${y}-${m}-${d}' });
    ok(p.additions.length === 1 && p.additions[0].object.value === '2013-09-17', 'date macro example');

    p = mk().process({ '$ y': '2013', 'dct:created $': '$y-x' });
    ok(p.additions[0].object.value === '$y-x', 'hyphen belongs to the macro name (as in the Ruby)');

    // cartesian product of multi-valued macros
    p = mk().process({ '$ first': ['a', 'b'], '$ last': ['x', 'y'], 'dct:contributor $': '$first $last' });
    ok(p.additions.length === 4, 'cartesian product');

    // braces, recursion, unbound macros left alone, literal $ preserved
    p = mk().process({ '$ a': 'foo', '$ b $': '${a}bar', 'dct:title $': '$b $nope $5' });
    ok(p.additions[0].object.value === 'foobar $nope $5', 'braces, recursion, unbound');

    // mixed values (macro + plain) must not spawn an empty literal
    p = mk().process({ '$ a': 'x', 'dct:title $': ['$a', 'plain'] });
    ok(p.additions.length === 2 && !p.additions.some((q) => q.object.value === ''), 'mixed values, no stray empty');

    // multiline values with macros keep their newlines
    p = mk().process({ '$ a': 'x', 'dct:description $': 'line1\r\nline2 $a' });
    ok(p.additions[0].object.value === 'line1\r\nline2 x', 'multiline value');

    // the indented multi-line examples in the protocol doc arrive as runs of spaces (HTML4 drops the newlines)
    p = mk().process({ 'http://example.com/other                      dct:title                  http://example.com/g': 'x' });
    ok(has(p.additions, st(n('http://example.com/other'), title, lit('x'), n('http://example.com/g'))), 'wide-spaced key');

    // URLSearchParams / pair list inputs, repeated keys
    p = mk().process(new URLSearchParams('dct:title=a&dct:title=b'));
    ok(p.additions.length === 2, 'URLSearchParams with repeated key');
    p = mk().process([['dct:title', 'a'], ['dct:title', 'b']]);
    ok(p.additions.length === 2, 'pair list');
    p = mk().process(new Map([['dct:title', ['a', 'b']]]));
    ok(p.additions.length === 2, 'Map');

    // callback sees terms
    const seen = [];
    mk({ callback: (t) => { seen.push(t.value); return t; } }).process({ 'dct:title': 'x' });
    ok(seen.includes(DC + 'title') && seen.includes('x'), 'callback');

    // errors
    throws(() => mk().process({ '$ a $': '$b', '$ b $': '$a' }), KVError, 'cycle');
    throws(() => mk().process({ '$ a $': 'x$a' }), KVError, 'self-reference');
    throws(() => mk().process('nope'), TypeError, 'non-hash');
    throws(() => new KV({}), TypeError, 'subject required');
    throws(() => new KV({ subject: suri, graph: 'x' }), TypeError, 'graph type');

    // idGenerator hook
    p = mk({ idGenerator: () => 'fixed' }).process({ 'dct:relation : $': '$NEW_BNODE', '= dct:title': 'x' });
    ok(p.additions.some((q) => q.object.termType === 'BlankNode' && q.object.value === 'fixed'), 'NEW_BNODE via idGenerator');
    ok(p.deletions.some((q) => q.object.termType === 'Variable' && q.object.value === 'fixed'), 'variable name via idGenerator');
}
console.log(`${count} checks, ${fails} failures`);
process.exitCode = fails ? 1 : 0;
