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
 * - errors.ttl: the tests that expect an error, which also pass on engines that fail for another reason.
 * The left-out test cases are listed with the reason in left-out.tsv.
 *
 * Usage: yarn run generate
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Expression } from '@traqula/rules-sparql-1-1';
import { sparql12GeneratorBuilder } from '@traqula/generator-sparql-1-2';
import { completeGeneratorContext } from '@traqula/rules-sparql-1-2';
import fontoxpath from 'fontoxpath';
import type { Document, Element } from 'slimdom';
import { parseXmlDocument } from 'slimdom';
import { assertionToSparql } from './assertions.ts';
import { extensionReasons } from './extensions.ts';
import { UnsupportedError, xpathToSparql } from './xpathToSparql.ts';

// fontoxpath is a CommonJS module, of which Node.js cannot detect the named exports
const { evaluateXPathToFirstNode, evaluateXPathToNodes, evaluateXPathToString } = fontoxpath;

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
  String.raw`fn-(upper-case|lower-case|starts-with|ends-with|contains|encode-for-uri|concat|matches|replace)`,
  String.raw`fn-((year|month|day)-from-(date|dateTime)|(hours|minutes|seconds)-from-(dateTime|time))`,
  String.raw`fn-(timezone-from-dateTime|not|true|false|boolean|string)`,
  String.raw`op-numeric-(add|subtract|multiply|divide|equal|less-than|greater-than|unary-minus|unary-plus)`,
  String.raw`op-(boolean|string|date|dateTime|time|duration|dayTimeDuration|yearMonthDuration)-.*`,
  String.raw`op-(add|subtract)-.*`,
  String.raw`prod-(CastExpr|ValueComp|GeneralComp\..*|OrExpr|IfExpr|Literal|ParenthesizedExpr)`,
  String.raw`xs-(double|float)`,
].join('|')})$`, 'u');

/**
 * The dependencies of a test case, on the test set and on the test case itself,
 * that an XPath 3.1 and XSD 1.1 implementation without optional features does not satisfy.
 */
const UNSATISFIED_DEPENDENCIES_QUERY = `
(../dependency, dependency)[
  (if (@type = 'spec') then
    (some $spec in tokenize(@value) satisfies
      ($spec = 'XP31' or (matches($spec, '^XP\\d\\d\\+$') and xs:integer(substring($spec, 3, 2)) le 31)))
  else if (@type = 'xsd-version') then @value = '1.1'
  else false()) = (@satisfied = 'false')]`;

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
    label: 'The tests of QT3 that expect an error, which also pass on engines that fail for another reason',
  },
};
type Kind = keyof typeof KINDS;

const PREFIXES = `@prefix mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#> .
@prefix qt: <http://www.w3.org/2001/sw/DataAccess/tests/test-query#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

const generator = sparql12GeneratorBuilder.build();
const generatorContext = completeGeneratorContext({});

/**
 * Fetch the contents of a file of the test suite, from the cache if it was fetched before.
 */
async function fetchQt3(path: string): Promise<string> {
  const file = join(CACHE_DIR, path);
  if (!existsSync(file)) {
    const response = await fetch(`${QT3_BASE}${path}`);
    if (!response.ok) {
      throw new Error(`Could not fetch ${path}: ${response.status}`);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await response.text());
  }
  return readFileSync(file, 'utf8');
}

function write(path: string, contents: string): void {
  const file = join(DIST_DIR, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/**
 * Serialize a string as a Turtle string literal, of which the escapes are the same as the ones of JSON.
 */
function turtleString(value: string): string {
  return JSON.stringify(value);
}

function sparql(expression: Expression): string {
  return generator.expression(expression, generatorContext).trim();
}

/**
 * Determine the SPARQL expressions of the variables of the environment of a test case.
 * @throws {UnsupportedError} If the environment is not supported.
 */
function environmentVariables(testCase: Element, catalog: Document): Record<string, Expression> {
  const variables: Record<string, Expression> = {};
  for (const environment of evaluateXPathToNodes<Element>('environment', testCase)) {
    const ref = environment.getAttribute('ref');
    const definition = ref ?
      evaluateXPathToFirstNode<Element>('/test-set/environment[@name = $ref]', testCase, null, { ref }) ??
      evaluateXPathToFirstNode<Element>('/catalog/environment[@name = $ref]', catalog, null, { ref }) :
      environment;
    if (!definition) {
      throw new UnsupportedError(`Unsupported environment ${ref}`);
    }
    for (const param of definition.children) {
      const select = param.getAttribute('select');
      if (param.localName !== 'param' || !select) {
        throw new UnsupportedError(`Unsupported environment with ${param.localName}`);
      }
      variables[param.getAttribute('name')!] = xpathToSparql(select, variables);
    }
  }
  return variables;
}

/**
 * Determine the URL of the definition of a test case on GitHub, at the line of its test-case element.
 */
function testCaseUrl(testSetFile: string, testSetText: string, name: string): string {
  const escapedName = name.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&');
  const match = new RegExp(`<test-case\\b[^>]*\\bname="${escapedName}"`, 'u').exec(testSetText);
  return `${QT3_VIEW_BASE}${testSetFile}${match ? `#L${testSetText.slice(0, match.index).split('\n').length}` : ''}`;
}

/**
 * Serialize a value as a field of a TSV file, escaping the characters that would end the field or the line.
 */
function tsvField(value: string): string {
  return value.replaceAll(/[\\\t\n\r]/gu, character =>
    ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[character]!);
}

/**
 * Determine why a test case is left out before translating it, as it needs what SPARQL engines cannot be expected to
 * support, or as its test is in a separate file.
 * @returns The reason, or undefined if the test case is not left out for that.
 */
function unsupportedTestCaseReason(testCase: Element): string | undefined {
  const file = evaluateXPathToString('test/@file', testCase);
  if (file) {
    return `Unsupported test in the separate file ${file}`;
  }
  const dependencies = evaluateXPathToNodes<Element>(UNSATISFIED_DEPENDENCIES_QUERY, testCase);
  if (dependencies.length > 0) {
    // A dependency that is not satisfied="false" requires the processor to have it, otherwise to not have it
    return `Unsupported dependencies ${dependencies.map(dependency => `${
      dependency.getAttribute('satisfied') === 'false' ? 'not ' : ''}${dependency.getAttribute('type')} ${
      dependency.getAttribute('value')}`).join(', ')}`;
  }
}

/**
 * Generate the ASK query of a test case, and determine the kind of the test.
 * @throws {UnsupportedError} If the test case cannot be expressed in SPARQL.
 */
function testCaseQuery(testSetName: string, testCase: Element, catalog: Document, url: string):
{ query: string; kind: Kind } {
  const variables = environmentVariables(testCase, catalog);
  const test = evaluateXPathToString('test', testCase);
  const expression = xpathToSparql(test, variables);
  const assertionElement = evaluateXPathToFirstNode<Element>('result/*', testCase)!;
  const assertion = assertionToSparql(assertionElement, variables);
  const reasons = extensionReasons(expression, assertion);
  const kind: Kind = assertionElement.localName === 'error' ? 'errors' : (reasons.length > 0 ? 'extensions' : 'sparql');
  // A SPARQL comment ends at a carriage return as well as at a line feed
  const comment = test.trim().split(/\r\n?|\n/u).map(line => `#   ${line.trim()}`).join('\n');
  const query = `# QT3 test case ${testCase.getAttribute('name')} of test set ${testSetName}, which tests the XPath expression
${comment}
# The test case is defined at ${url}${kind === 'extensions' ? `\n# The test needs ${reasons.join(', ')}, which SPARQL does not define` : ''}
ASK {
  BIND(${sparql(expression)} AS ?result)
  FILTER(${sparql(assertion)})
}
`;
  return { query, kind };
}

async function main(): Promise<void> {
  rmSync(DIST_DIR, { recursive: true, force: true });
  const catalog = parseXmlDocument(await fetchQt3('catalog.xml'));
  const includes: Record<Kind, string[]> = { sparql: [], extensions: [], errors: [] };
  const counts: Record<Kind, number> = { sparql: 0, extensions: 0, errors: 0 };
  let testSetCount = 0;
  const skipReasons: Record<string, number> = {};
  const leftOut: string[] = [];

  for (const testSet of evaluateXPathToNodes<Element>('/catalog/test-set', catalog)) {
    const testSetName = testSet.getAttribute('name')!;
    if (!TEST_SETS.test(testSetName)) {
      continue;
    }
    const testSetFile = testSet.getAttribute('file')!;
    const testSetText = await fetchQt3(testSetFile);
    const testSetXml = parseXmlDocument(testSetText);
    const entries: Record<Kind, { name: string; entry: string }[]> = { sparql: [], extensions: [], errors: [] };
    for (const testCase of evaluateXPathToNodes<Element>('/test-set/test-case', testSetXml)) {
      const name = testCase.getAttribute('name')!;
      const url = testCaseUrl(testSetFile, testSetText, name);
      let query: string;
      let kind: Kind;
      try {
        const reason = unsupportedTestCaseReason(testCase);
        if (reason) {
          throw new UnsupportedError(reason);
        }
        ({ query, kind } = testCaseQuery(testSetName, testCase, catalog, url));
      } catch (error: unknown) {
        if (!(error instanceof UnsupportedError)) {
          throw error;
        }
        leftOut.push([ testSetName, name, url, error.message ].map(tsvField).join('\t'));
        const reason = error.message.replace(/^(Unsupported \w+|Invalid XPath|Unknown variable|Invalid value).*/su, '$1');
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        continue;
      }
      write(`${testSetName}/${name}.rq`, query);
      const description = evaluateXPathToString('description', testCase).trim();
      entries[kind].push({ name: encodeURIComponent(name), entry: `<#${encodeURIComponent(name)}> a mf:QueryEvaluationTest ;
  mf:name ${turtleString(name)} ;${description ? `\n  rdfs:comment ${turtleString(description)} ;` : ''}
  rdfs:seeAlso <${QT3_BASE}${testSetFile}> ;
  mf:action [ qt:query <${encodeURIComponent(name)}.rq> ] ;
  mf:result <../true.srj> .` });
    }
    if (Object.values(entries).some(kindEntries => kindEntries.length > 0)) {
      testSetCount++;
    }
    for (const [ kind, { file } ] of Object.entries(KINDS) as [ Kind, typeof KINDS[Kind] ][]) {
      counts[kind] += entries[kind].length;
      if (entries[kind].length > 0) {
        write(`${testSetName}/${file}`, `${PREFIXES}
<> a mf:Manifest ;
  rdfs:label ${turtleString(`QT3 test set ${testSetName}`)} ;
  mf:entries (
${entries[kind].map(({ name }) => `    <#${name}>`).join('\n')}
  ) .

${entries[kind].map(({ entry }) => entry).join('\n\n')}
`);
        includes[kind].push(`${testSetName}/${file}`);
      }
    }
  }

  for (const [ kind, { file, label } ] of Object.entries(KINDS) as [ Kind, typeof KINDS[Kind] ][]) {
    write(file, `${PREFIXES}
<> a mf:Manifest ;
  rdfs:label ${turtleString(label)} ;
  rdfs:comment ${turtleString(`Generated from ${QT3_BASE}catalog.xml`)} ;
  mf:include (
${includes[kind].map(include => `    <${include}>`).join('\n')}
  ) .
`);
  }
  write('true.srj', '{ "head": {}, "boolean": true }\n');
  write('left-out.tsv', `test-set\ttest-case\turl\treason\n${leftOut.map(row => `${row}\n`).join('')}`);

  process.stdout.write(`Generated ${testSetCount} test sets with\n`);
  for (const [ kind, { file } ] of Object.entries(KINDS) as [ Kind, typeof KINDS[Kind] ][]) {
    process.stdout.write(`  ${counts[kind]} tests in ${file}\n`);
  }
  process.stdout.write(`Left out ${leftOut.length} tests, which left-out.tsv lists\n`);
  for (const [ reason, count ] of Object.entries(skipReasons).sort(([ , a ], [ , b ]) => b - a)) {
    process.stdout.write(`  ${count}: ${reason}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
