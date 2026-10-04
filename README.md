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

SPARQL defines most of its functions and operators in terms of
[XPath and XQuery Functions and Operators](https://www.w3.org/TR/xpath-functions-31/).
This repository turns the tests of the [W3C XQuery and XPath Test Suite (QT3)](https://github.com/w3c/qt3tests)
for those functions and operators into [SPARQL query evaluation tests](https://www.w3.org/TR/sparql12-query/#conformance),
so that any SPARQL engine can run them with its existing test harness,
such as [rdf-test-suite](https://github.com/rubensworks/rdf-test-suite.js).
The manifest includes a sub-manifest per QT3 test set.

## Run the tests

With rdf-test-suite, the tests can be run against an engine as follows:

```bash
$ rdf-test-suite path/to/engine.js https://sparql-manifest-xpath-tests.jitsedesmet.be/manifest.ttl -c .rdf-test-suite-cache/
```

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
The XPath expressions are parsed with [fontoxpath](https://github.com/FontoXML/fontoxpath),
and the SPARQL is generated with [Traqula](https://github.com/comunica/traqula).

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

QT3 is fetched at a fixed commit, and cached in `.cache/`.

The generated tests in `dist/` are tracked, so that every change to the published tests shows up in the git diff.
After changing the generator, run `yarn run generate` and commit the changes in `dist/`.
A GitHub Actions workflow checks on every push and pull request that `dist/` is up to date with the generator,
and publishes `dist/` on GitHub Pages on every push to `main`.

## License

This code is copyrighted by Jitse De Smet and released under the [MIT license](http://opensource.org/licenses/MIT).

The generated tests are derived from QT3, Copyright © World Wide Web Consortium,
and are released under the [W3C Software and Document License](https://www.w3.org/copyright/software-license/).
