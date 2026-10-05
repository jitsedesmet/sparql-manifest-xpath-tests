<h1 align="center">sparql-manifest-xpath-tests</h1>

<p align="center">
  <strong>The W3C XQuery and XPath Test Suite as SPARQL tests</strong>
  <br />
  <i>Test the XPath functions and operators of any SPARQL engine.</i>
</p>

<p align="center">
  <a href="https://github.com/jitsedesmet/sparql-manifest-xpath-tests/actions/workflows/pages.yml"><img src="https://github.com/jitsedesmet/sparql-manifest-xpath-tests/actions/workflows/pages.yml/badge.svg?branch=main" alt="Build Status"></a>
</p>

**[Use the manifest at https://sparql-manifest-xpath-tests.jitsedesmet.be/manifest.ttl](https://sparql-manifest-xpath-tests.jitsedesmet.be/manifest.ttl).**

The tests are divided over three manifests:

| Manifest | Tests |
| --- | --- |
| [`manifest.ttl`](https://sparql-manifest-xpath-tests.jitsedesmet.be/manifest.ttl) | Tests that only need what SPARQL defines. |
| [`extensions.ttl`](https://sparql-manifest-xpath-tests.jitsedesmet.be/extensions.ttl) | Tests that need XPath functions and operators beyond what SPARQL defines, such as the ones on `xsd:date`, `xsd:time` and the durations, which many engines support as an extension. |
| [`errors.ttl`](https://sparql-manifest-xpath-tests.jitsedesmet.be/errors.ttl) | Tests that accept an error, as their only expected result or as one of the alternatives. As an engine passes these when it fails for any reason, such as not supporting a function, they say little on their own. |

SPARQL defines most of its functions and operators in terms of
[XPath and XQuery Functions and Operators](https://www.w3.org/TR/xpath-functions-31/).
This repository turns the tests of the [W3C XQuery and XPath Test Suite (QT3)](https://github.com/w3c/qt3tests)
for those functions and operators into [SPARQL query evaluation tests](https://www.w3.org/TR/sparql12-query/#conformance),
so that any SPARQL engine can run them with its existing test harness,
such as [rdf-test-suite](https://github.com/rubensworks/rdf-test-suite.js).
Each manifest includes a sub-manifest per QT3 test set.

## Run the tests

With rdf-test-suite, the tests can be run against an engine as follows:

```bash
$ rdf-test-suite path/to/engine.js https://sparql-manifest-xpath-tests.jitsedesmet.be/manifest.ttl -c .rdf-test-suite-cache/
```

and likewise for `extensions.ttl` and `errors.ttl`.

A locally generated version can be run by mapping the URL onto the `dist/` folder,
with `-m 'https://sparql-manifest-xpath-tests.jitsedesmet.be/~path/to/dist/'`.

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
[`left-out.tsv`](https://sparql-manifest-xpath-tests.jitsedesmet.be/left-out.tsv) lists every left-out test case with the reason,
including the ones that depend on more than XPath 3.1 and XSD 1.1 without optional features.
The XPath expressions are parsed with [fontoxpath](https://github.com/FontoXML/fontoxpath),
and the SPARQL is generated with [Traqula](https://github.com/comunica/traqula).

A test needs more than SPARQL defines when it uses a datatype other than the [operand datatypes of SPARQL](https://www.w3.org/TR/sparql12-query/#operandDataTypes),
which are `xsd:string`, `xsd:boolean`, `xsd:dateTime` and the numeric ones,
a constructor function that SPARQL does not have,
or a function or operator on arguments that SPARQL does not define it for, such as `SUBSTR` with an `xsd:double` position.
Such a test explains this in a comment in its query.

## Development Setup

This project requires [Node.JS](http://nodejs.org/) 22.18 or higher and the [Yarn](https://yarnpkg.com/en/) package manager.
It can be setup by cloning and installing it as follows:

```bash
$ git clone https://github.com/jitsedesmet/sparql-manifest-xpath-tests.git
$ cd sparql-manifest-xpath-tests
$ yarn install
```

After that, the tests can be generated into `dist/` as follows:

```bash
$ yarn run generate
```

QT3 is fetched at a fixed commit, which is set in `src/generate.ts`, and cached in `.cache/`.
Another GitHub Actions workflow warns, without failing, when QT3 has a newer commit,
every week and on every push and pull request.

The generated tests in `dist/` are tracked, so that every change to the published tests shows up in the git diff.
After changing the generator, run `yarn run generate` and commit the changes in `dist/`.
A GitHub Actions workflow checks on every push and pull request that `dist/` is up to date with the generator,
and publishes `dist/` on GitHub Pages on every push to `main`.

## License

This software is written by [Jitse De Smet](https://jitsedesmet.be/).

This code is released under the [MIT license](https://opensource.org/license/MIT).

The generated tests are derived from QT3, Copyright © W3C® (MIT, ERCIM, Keio, Beihang),
and are released under the [W3C Software and Document License](https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document),
of which the full text is in [`LICENSE-W3C.txt`](LICENSE-W3C.txt).
The generator publishes it with the tests as [`LICENSE.txt`](https://sparql-manifest-xpath-tests.jitsedesmet.be/LICENSE.txt),
which each manifest links with `dct:license`.
