# `rdf-kv` — Turn Key-Value Pairs into 

This module is yet another implementation of the
[RDF-KV](https://doriantaylor.com/rdf-kv) protocol. This protocol
defines a method for embedding into an ordinary HTML form a set of
instructions for making changes to an RDF graph.

```js

# initialize the processor
kv = RDF::KV.new subject: my_url, graph: graph_url

# use it to generate a changeset, e.g. from web form POST data
cs = kv.process rack.POST

# now apply it to your RDF::Repository
cs.apply repo
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
