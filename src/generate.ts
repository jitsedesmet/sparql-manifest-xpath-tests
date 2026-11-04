/**
 * Generates SPARQL query evaluation tests (https://www.w3.org/TR/sparql12-query/#conformance) in dist/
 * from the tests of the W3C XQuery and XPath Test Suite (QT3, https://github.com/w3c/qt3tests)
 * for the functions and operators that SPARQL defines in terms of XPath.
 *
 * Each test case becomes an ASK query that binds the result of the XPath expression to ?result,
 * and that filters on the assertion of the test case, so the expected result of every test is true.
 * Test cases that cannot be expressed in SPARQL are left out.
 * The tests are divided over three manifests:
 * - manifest.ttl: the tests that only need what SPARQL defines,
 * - extensions.ttl: the tests that need XPath functions or operators beyond what SPARQL defines, such as on xsd:date,
 * - errors.ttl: the tests that accept an error, which also pass on engines that fail for another reason.
 * The left-out test cases are listed with the reason in left-out.tsv,
 * and LICENSE.txt holds the license of the tests, which are derived from QT3.
 *
 * Usage: yarn run generate
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sparql12GeneratorBuilder } from '@traqula/generator-sparql-1-2';
import type { Expression } from '@traqula/rules-sparql-1-2';
import { completeGeneratorContext } from '@traqula/rules-sparql-1-2';
import type { Element } from 'slimdom';
import { parseXmlDocument, serializeToWellFormedString } from 'slimdom';
import { acceptsError, assertionToSparql } from './assertions.ts';
import { extensionReasons } from './extensions.ts';
import { RESULT_VARIABLE, XSD_PREFIX_DECLARATION } from './sparqlAst.ts';
import { UnsupportedError } from './UnsupportedError.ts';
import { xpathToSparql } from './xpathToSparql.ts';

// A fixed commit of the test suite, so that the generated tests are reproducible.
const QT3_COMMIT = '201a6e466940cdfc727f4babfedcde5332b9f578';
const QT3_BASE = `https://raw.githubusercontent.com/w3c/qt3tests/${QT3_COMMIT}/`;
const QT3_VIEW_BASE = `https://github.com/w3c/qt3tests/blob/${QT3_COMMIT}/`;
const ROOT = join(import.meta.dirname, '..');
const CACHE_DIR = join(ROOT, '.cache', 'qt3', QT3_COMMIT);
const DIST_DIR = join(ROOT, 'dist');

// The test sets for the functions and operators that SPARQL defines in terms of XPath,
// and for the ones on the XSD datatypes that SPARQL engines commonly support as an extension, such as xsd:date.
const TEST_SETS = new RegExp(`^(${[
  String.raw`fn-(abs|ceiling|floor|round|string-length|substring|substring-before|substring-after)`,
  String.raw`fn-(upper-case|lower-case|starts-with|ends-with|contains|encode-for-uri|concat|matches|matches\.re|replace)`,
  String.raw`fn-((year|month|day)-from-(date|dateTime)|(hours|minutes|seconds)-from-(dateTime|time))`,
  String.raw`fn-(timezone-from-dateTime|not|true|false|boolean|string)`,
  String.raw`op-numeric-(add|subtract|multiply|divide|equal|less-than|greater-than|unary-minus|unary-plus)`,
  String.raw`op-(boolean|string|date|dateTime|time|duration|dayTimeDuration|yearMonthDuration)-.*`,
  String.raw`op-(add|subtract)-.*`,
  String.raw`prod-(CastExpr|ValueComp|GeneralComp\..*|OrExpr|IfExpr|Literal|ParenthesizedExpr)`,
  String.raw`xs-(double|float)`,
].join('|')})$`, 'u');

/**
 * The manifests that the tests are divided over, by kind of test.
 */
const KINDS = {
  sparql: {
    file: 'manifest.ttl',
    label: 'The W3C XQuery and XPath Test Suite (QT3) as SPARQL query evaluation tests',
  },
  extensions: {
    file: 'extensions.ttl',
    label: 'The tests of QT3 that need XPath functions or operators beyond what SPARQL defines',
  },
  errors: {
    file: 'errors.ttl',
    label: 'The tests of QT3 that accept an error. NOTE: engines that fail for another reason will also PASS',
  },
};
type Kind = keyof typeof KINDS;
const KIND_NAMES = Object.keys(KINDS) as Kind[];

// The values of spec dependencies that XPath 3.1 satisfies, where a `+` means that version or a later one.
const XPATH_31_SPECS = new Set([ 'XP20+', 'XP30+', 'XP31', 'XP31+' ]);

const PREFIXES = `@prefix dct: <http://purl.org/dc/terms/> .
@prefix mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#> .
@prefix qt: <http://www.w3.org/2001/sw/DataAccess/tests/test-query#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

/**
 * A test case of a test set, translated into a SPARQL query evaluation test.
 */
interface GeneratedTest {
  name: string;
  kind: Kind;
  query: string;
  description: string;
  url: string;
}

/**
 * A test case of a test set that is left out, with the reason.
 */
interface LeftOutTest {
  testSetName: string;
  name: string;
  url: string;
  error: UnsupportedError;
}

const generator = sparql12GeneratorBuilder.build();
const generatorContext = completeGeneratorContext({});

/**
 * Fetch the contents of a file of the test suite, from the cache if it was fetched before.
 * @param path The path of the file in the test suite.
 * @returns The contents of the file.
 */
async function fetchQt3(path: string): Promise<string> {
  const file = join(CACHE_DIR, path);
  if (existsSync(file)) {
    return readFileSync(file, 'utf8');
  }
  const response = await fetch(`${QT3_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`Could not fetch ${path}: ${response.status}`);
  }
  const contents = await response.text();
  mkdirSync(dirname(file), { recursive: true });
  // Write atomically, so an interrupted run does not leave a truncated file in the cache
  writeFileSync(`${file}.tmp`, contents);
  renameSync(`${file}.tmp`, file);
  return contents;
}

/**
 * Write a file into dist/, of which the directory must exist.
 * @param path The path of the file in dist/.
 * @param contents The contents of the file.
 */
function write(path: string, contents: string): void {
  writeFileSync(join(DIST_DIR, path), contents);
}

/**
 * Serialize a string as a Turtle string literal, of which the escapes are the same as the ones of JSON.
 * @param value The string.
 * @returns The Turtle string literal.
 */
function turtleString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Serialize a SPARQL expression.
 * @param expression The SPARQL expression.
 * @returns The SPARQL text.
 */
function sparql(expression: Expression): string {
  return generator.expression(expression, generatorContext).trim();
}

/**
 * Find the child elements with the given local name.
 * @param element The parent element.
 * @param localName The local name of the children.
 * @returns The matching child elements.
 */
function childElements(element: Element, localName: string): Element[] {
  return element.children.filter(child => child.localName === localName);
}

/**
 * Index the environment definitions that are children of an element by name.
 * @param element The test-set or catalog element.
 * @returns The environment elements, by name.
 */
function environmentsByName(element: Element): Map<string, Element> {
  return new Map(childElements(element, 'environment')
    .map(environment => [ environment.getAttribute('name')!, environment ]));
}

/**
 * Check that the environment of a test case is empty, as a query has no context item, sources or parameters.
 * Parameters only occur in XQuery tests, which are left out by their dependencies.
 * @param testCase The test-case element.
 * @param environments The environment definitions that the test case can refer to, by name.
 * @throws {UnsupportedError} If the environment is not empty.
 * @example
 *   The `<environment ref="emptydoc"/>` of fn-floornni1args-3 is supported,
 *   but the `<environment ref="e0"/>` with a `<source>` of K2-ABSFunc-35 is not.
 */
function checkEnvironment(testCase: Element, environments: Map<string, Element>): void {
  for (const environment of childElements(testCase, 'environment')) {
    const ref = environment.getAttribute('ref');
    const definition = ref ? environments.get(ref) : environment;
    if (!definition) {
      throw new UnsupportedError('Unsupported environment', ref!);
    }
    if (definition.children.length > 0) {
      throw new UnsupportedError('Unsupported environment', `with ${definition.children[0].localName}`);
    }
  }
}

/**
 * Find the line of each test case in the XML text of a test set, for the `#L` anchors of the GitHub URLs.
 * @param testSetText The XML text of the test set.
 * @returns The line numbers, by test case name.
 */
function testCaseLines(testSetText: string): Map<string, number> {
  const lines = new Map<string, number>();
  let line = 1;
  let index = 0;
  for (const match of testSetText.matchAll(/<test-case\b[^>]*?\bname="([^"]*)"/gu)) {
    line += testSetText.slice(index, match.index).split('\n').length - 1;
    index = match.index;
    if (!lines.has(match[1])) {
      lines.set(match[1], line);
    }
  }
  return lines;
}

/**
 * Serialize a value as a field of a TSV file, escaping the characters that would end the field or the line.
 * @param value The value.
 * @returns The TSV field.
 */
function tsvField(value: string): string {
  return value.replaceAll(/[\\\t\n\r]/gu, character =>
    ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[character]!);
}

/**
 * Determine whether an XPath 3.1 and XSD 1.1 implementation without optional features satisfies a dependency.
 * @param dependency The dependency element.
 * @returns Whether the dependency is satisfied.
 * @example
 *   <dependency type="spec" value="XP30+ XQ30+"/> is satisfied, <dependency type="spec" value="XP40+"/> is not.
 */
function satisfiesDependency(dependency: Element): boolean {
  const value = dependency.getAttribute('value') ?? '';
  const type = dependency.getAttribute('type');
  let supported = false;
  if (type === 'spec') {
    supported = value.trim().split(/\s+/u).some(spec => XPATH_31_SPECS.has(spec));
  } else if (type === 'xsd-version') {
    supported = value === '1.1';
  }
  // A dependency with satisfied="false" requires the implementation to not have it
  return supported !== (dependency.getAttribute('satisfied') === 'false');
}

/**
 * Check that a test case does not need what SPARQL engines cannot be expected to support,
 * and that its test is not in a separate file.
 * @param testCase The test-case element.
 * @param unsatisfiedTestSetDependencies The unsatisfied dependencies of the test set.
 * @param environments The environment definitions that the test case can refer to, by name.
 * @throws {UnsupportedError} If the test case is not supported.
 * @example
 *   <test file="Literal/K2-Literals-28.xq"/> and <dependency type="spec" value="XQ10+"/> are not supported.
 */
function checkSupported(
  testCase: Element,
  unsatisfiedTestSetDependencies: Element[],
  environments: Map<string, Element>,
): void {
  const file = childElements(testCase, 'test')[0]?.getAttribute('file');
  if (file) {
    throw new UnsupportedError('Unsupported test', `in the separate file ${file}`);
  }
  const dependencies = [
    ...unsatisfiedTestSetDependencies,
    ...childElements(testCase, 'dependency').filter(dependency => !satisfiesDependency(dependency)),
  ];
  if (dependencies.length > 0) {
    throw new UnsupportedError('Unsupported dependencies', dependencies.map(dependency => `${
      dependency.getAttribute('satisfied') === 'false' ? 'not ' : ''}${dependency.getAttribute('type')} ${
      dependency.getAttribute('value')}`).join(', '));
  }
  checkEnvironment(testCase, environments);
}

/**
 * Serialize a text of the test suite as the lines of a SPARQL comment, without the indentation that the lines after
 * the first all share.
 * @param text The text, of which the lines after the first are indented as in the source.
 * @returns The lines of the comment.
 */
function commentLines(text: string): string {
  // A SPARQL comment ends at a carriage return as well as at a line feed
  const [ firstLine, ...otherLines ] = text.trim().split(/\r\n?|\n/u);
  const indentation = Math.min(...otherLines
    .filter(line => line.trim() !== '')
    .map(line => line.length - line.trimStart().length));
  return [ firstLine, ...otherLines.map(line => line.slice(indentation)) ]
    .map(line => `#   ${line}`.trimEnd())
    .join('\n');
}

/**
 * Generate the ASK query of a test case, and determine the kind of the test.
 * @param testSetName The name of the test set.
 * @param testCase The test-case element.
 * @param url The URL of the definition of the test case.
 * @returns The query and the kind of the test.
 * @throws {UnsupportedError} If the test case cannot be expressed in SPARQL.
 */
function testCaseQuery(
  testSetName: string,
  testCase: Element,
  url: string,
): { query: string; kind: Kind } {
  const test = childElements(testCase, 'test')[0].textContent!;
  const expression = xpathToSparql(test);

  // <result> <assert-string-value>2030</assert-string-value> </result>
  // NOTE: only one root assertion, otherwise wrapped in `any-of` or `all-of`
  const assertionElement = childElements(testCase, 'result')[0].children[0];
  const assertion = assertionToSparql(assertionElement);
  const reasons = extensionReasons(expression, assertion);
  const kind: Kind = acceptsError(assertion) ? 'errors' : (reasons.length > 0 ? 'extensions' : 'sparql');

  // The serializer declares the namespace of the test set on the element, which the test set declares on its root
  const expected = serializeToWellFormedString(assertionElement)
    .replace(` xmlns="${assertionElement.namespaceURI}"`, '');
  const query = `# QT3 test case ${testCase.getAttribute('name')} of test set ${testSetName}, which tests the XPath expression
${commentLines(test)}
# Expecting:
${commentLines(expected)}
# The test case is defined at ${url}${kind === 'extensions' ? `\n# The test needs ${reasons.join(', ')}, which SPARQL does not define` : ''}
${XSD_PREFIX_DECLARATION}
ASK {
  BIND(${sparql(expression)} AS ?${RESULT_VARIABLE})
  FILTER(${sparql(assertion)})
}
`;
  return { query, kind };
}

/**
 * Translate the test cases of a test set.
 * @param testSetName The name of the test set.
 * @param testSetFile The path of the test set in the test suite.
 * @param testSetText The XML text of the test set.
 * @param catalogEnvironments The environment definitions of the catalog, by name.
 * @returns The generated tests and the left-out test cases.
 */
function translateTestSet(
  testSetName: string,
  testSetFile: string,
  testSetText: string,
  catalogEnvironments: Map<string, Element>,
): { tests: GeneratedTest[]; leftOut: LeftOutTest[] } {
  const testSet = parseXmlDocument(testSetText).documentElement!;
  const environments = new Map([ ...catalogEnvironments, ...environmentsByName(testSet) ]);
  const unsatisfiedTestSetDependencies = childElements(testSet, 'dependency')
    .filter(dependency => !satisfiesDependency(dependency));
  const lines = testCaseLines(testSetText);
  const tests: GeneratedTest[] = [];
  const leftOut: LeftOutTest[] = [];
  for (const testCase of childElements(testSet, 'test-case')) {
    const name = testCase.getAttribute('name')!;
    const line = lines.get(name);
    const url = `${QT3_VIEW_BASE}${testSetFile}${line ? `#L${line}` : ''}`;
    try {
      checkSupported(testCase, unsatisfiedTestSetDependencies, environments);
      const description = childElements(testCase, 'description')[0]?.textContent?.trim() ?? '';
      tests.push({ name, url, description, ...testCaseQuery(testSetName, testCase, url) });
    } catch (error: unknown) {
      if (!(error instanceof UnsupportedError)) {
        throw error;
      }
      leftOut.push({ testSetName, name, url, error });
    }
  }
  return { tests, leftOut };
}

/**
 * Serialize a manifest in Turtle.
 * @param options The label, license, optional comment, list property with its items, and the entries of the manifest.
 * @returns The manifest in Turtle.
 */
function manifest({ label, license, comment, listProperty, items, entries = []}: {
  label: string;
  license: string;
  comment?: string;
  listProperty: 'mf:entries' | 'mf:include';
  items: string[];
  entries?: string[];
}): string {
  return `${PREFIXES}
<> a mf:Manifest ;
  rdfs:label ${turtleString(label)} ;
  dct:license <${license}> ;
${comment ? `  rdfs:comment ${turtleString(comment)} ;\n` : ''}  ${listProperty} (
${items.map(item => `    <${item}>`).join('\n')}
  ) .
${entries.length > 0 ? `\n${entries.join('\n\n')}\n` : ''}`;
}

/**
 * Serialize a generated test as an entry of a manifest in Turtle.
 * @param test The generated test.
 * @returns The manifest entry in Turtle.
 */
function manifestEntry({ name, description, url }: GeneratedTest): string {
  const id = encodeURIComponent(name);
  return `<#${id}> a mf:QueryEvaluationTest ;
  mf:name ${turtleString(name)} ;${description ? `\n  rdfs:comment ${turtleString(description)} ;` : ''}
  rdfs:seeAlso <${url}> ;
  mf:action [ qt:query <${id}.rq> ] ;
  mf:result <../true.srj> .`;
}

/**
 * Generate the tests, manifests, license, and list of left-out test cases in dist/, and print a summary.
 * @returns A promise that resolves when the tests are generated.
 */
async function main(): Promise<void> {
  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });

  const catalog = parseXmlDocument(await fetchQt3('catalog.xml')).documentElement!;
  const catalogEnvironments = environmentsByName(catalog);

  const testSets = childElements(catalog, 'test-set')
    .map(testSet => ({
      name: testSet.getAttribute('name')!,
      file: testSet.getAttribute('file')!,
    }))
    .filter(({ name }) => TEST_SETS.test(name));

  const testSetTexts = await Promise.all(
    testSets.map(({ file }) => fetchQt3(file)),
  );
  const results = testSets
    .map(({ name, file }, index) => ({
      name,
      ...translateTestSet(name, file, testSetTexts[index], catalogEnvironments),
    }));

  const includes: Record<Kind, string[]> = { sparql: [], extensions: [], errors: []};
  const nonEmptyTestSets = results.filter(({ tests }) => tests.length > 0);
  for (const { name: testSetName, tests } of nonEmptyTestSets) {
    mkdirSync(join(DIST_DIR, testSetName));
    for (const { name, query } of tests) {
      write(`${testSetName}/${name}.rq`, query);
    }
    for (const kind of KIND_NAMES) {
      const kindTests = tests.filter(test => test.kind === kind);
      if (kindTests.length > 0) {
        write(`${testSetName}/${KINDS[kind].file}`, manifest({
          label: `QT3 test set ${testSetName}`,
          license: '../LICENSE.txt',
          listProperty: 'mf:entries',
          items: kindTests.map(({ name }) => `#${encodeURIComponent(name)}`),
          entries: kindTests.map(manifestEntry),
        }));
        includes[kind].push(`${testSetName}/${KINDS[kind].file}`);
      }
    }
  }
  for (const kind of KIND_NAMES) {
    write(KINDS[kind].file, manifest({
      label: KINDS[kind].label,
      license: 'LICENSE.txt',
      comment: `Generated from ${QT3_BASE}catalog.xml`,
      listProperty: 'mf:include',
      items: includes[kind],
    }));
  }
  write('true.srj', '{ "head": {}, "boolean": true }\n');
  const w3cLicense = readFileSync(join(ROOT, 'LICENSE-W3C.txt'), 'utf8');
  write('LICENSE.txt', `The tests in this directory are generated from the W3C XQuery and XPath Test Suite (QT3),
https://github.com/w3c/qt3tests/tree/${QT3_COMMIT}, by translating its test cases into SPARQL.

This software or document includes material copied from or derived from
the W3C XQuery and XPath Test Suite (QT3), https://github.com/w3c/qt3tests.
Copyright © W3C® (MIT, ERCIM, Keio, Beihang).

${w3cLicense}`);

  const leftOut = results.flatMap(result => result.leftOut);
  const rows = leftOut.map(({ testSetName, name, url, error }) =>
    `${[ testSetName, name, url, error.message ].map(tsvField).join('\t')}\n`).join('');
  write(
    'left-out.tsv',
    `test-set\ttest-case\turl\treason\n${rows}`,
  );

  const tests = results.flatMap(result => result.tests);
  process.stdout.write(`Generated ${nonEmptyTestSets.length} test sets with\n`);
  for (const kind of KIND_NAMES) {
    const testsCount = tests.filter(test => test.kind === kind).length;
    process.stdout.write(`  ${testsCount} tests in ${KINDS[kind].file}\n`);
  }
  process.stdout.write(`Left out ${leftOut.length} tests, which left-out.tsv lists\n`);
  const categoryCounts = Map.groupBy(leftOut, ({ error }) => error.category);
  const sortedCategories = [ ...categoryCounts ].sort(([ , a ], [ , b ]) => b.length - a.length);
  for (const [ category, categoryTests ] of sortedCategories) {
    process.stdout.write(`  ${categoryTests.length}: ${category}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
