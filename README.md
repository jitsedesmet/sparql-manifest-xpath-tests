# sparql-manifest-xpath-tests

The tests of the [W3C XQuery and XPath Test Suite (QT3)](https://github.com/w3c/qt3tests)
for the functions and operators that SPARQL defines in terms of XPath,
as [SPARQL query evaluation tests](https://www.w3.org/TR/sparql12-query/#conformance),
so that any SPARQL engine can run them with its existing test harness,
such as [rdf-test-suite](https://github.com/rubensworks/rdf-test-suite.js).

The manifest is published at <https://jitsedesmet.github.io/sparql-manifest-xpath-tests/manifest.ttl>,
with a sub-manifest per QT3 test set.

## How the tests are generated

Each QT3 test case becomes an `ASK` query:

```sparql
ASK {
  BIND(<the XPath expression, translated to SPARQL> AS ?result)
  FILTER(<the assertion of the test case, translated to SPARQL>)
}
```

so the expected result of every test is `true`.
An expected error becomes `!BOUND(?result)`, as an error in `BIND` leaves the variable unbound,
and `all-of`, `any-of` and `not` become `&&`, `||` and `!`.

Test cases that cannot be expressed in SPARQL are left out, such as XPath expressions without SPARQL equivalent,
and invalid values of the types derived from `xsd:integer`, which are an error in XPath but an ill-typed literal in SPARQL.
The XPath expressions are parsed with [fontoxpath](https://github.com/FontoXML/fontoxpath),
and the SPARQL is generated with [Traqula](https://github.com/comunica/traqula).

## Usage

```bash
npm ci
npm run generate
```

writes the tests into `dist/`. QT3 is fetched at a fixed commit and cached in `.cache/`.

With rdf-test-suite, the published tests can be run as follows,
optionally against a local `dist/` with `-m 'https://jitsedesmet.github.io/sparql-manifest-xpath-tests/~dist/'`:

```bash
rdf-test-suite path/to/engine.js https://jitsedesmet.github.io/sparql-manifest-xpath-tests/manifest.ttl
```

## License

The code of this repository is available under the MIT license.
The generated tests are derived from QT3, Copyright © World Wide Web Consortium,
under the [W3C Software and Document License](https://www.w3.org/copyright/software-license/).
