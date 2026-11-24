# `rdf-kv` — Turn HTML Key-Value Form Pairs into a Graph Delta

This module is yet another implementation of the
[RDF-KV](https://doriantaylor.com/rdf-kv) protocol. This protocol
defines a method for embedding into an ordinary HTML form a set of
instructions for making changes to an RDF graph.

```js
import * as RDF from 'rdflib';
import { KV } from '@methodandstructure/rdf-kv';

// let's say we're doing this in the browser
window.graph ||= new RDF.Store();

// initialize the processor
const kv = new KV();

// how about some form data
const fd = new FormData(document.forms[0]);

// this will give us a delta object
const delta = KV.process(fd);

// now apply it to your graph
delta.apply(window.graph);
```

## Protocol Documentation

See [the very tentative spec](https://doriantaylor.com/rdf-kv).

## Installation

You know how to do this:

    $ npm install @methodandstructure/rdf-kv

## Contributing

Bug reports and pull requests are welcome at
[the GitHub repository](https://github.com/doriantaylor/js-rdf-kv/issues).

## Copyright & License

©2026 [Dorian Taylor](https://doriantaylor.com/)

This software is provided under
the [Apache License, 2.0](https://www.apache.org/licenses/LICENSE-2.0).
