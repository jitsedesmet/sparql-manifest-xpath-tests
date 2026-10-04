/**
 * Generates SPARQL query evaluation tests (https://www.w3.org/TR/sparql12-query/#conformance) in dist/
 * from the tests of the W3C XQuery and XPath Test Suite (QT3, https://github.com/w3c/qt3tests)
 * for the functions and operators that SPARQL defines in terms of XPath.
 *
 * Each test case becomes an ASK query that binds the result of the XPath expression to ?result,
 * and that filters on the assertion of the test case, so the expected result of every test is true.
 * Test cases that cannot be expressed in SPARQL are left out.
 *
 * Usage: yarn run generate
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GeneratorBuilder } from '@traqula/core';
import type { Expression } from '@traqula/rules-sparql-1-1';
import { sparql12GeneratorBuilder } from '@traqula/generator-sparql-1-2';
import { completeGeneratorContext } from '@traqula/rules-sparql-1-2';
import fontoxpath from 'fontoxpath';
import type { Document, Element } from 'slimdom';
import { parseXmlDocument } from 'slimdom';
import { assertionToSparql } from './assertions.ts';
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

// The test sets for the functions and operators that SPARQL defines in terms of XPath.
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
 * The test cases that an XPath 3.1 and XSD 1.1 implementation without optional features can run,
 * and that have their test in the test set itself.
 */
const TEST_CASES_QUERY = `
/test-set/test-case[
  (every $dependency in (../dependency, dependency) satisfies
    (if ($dependency/@type = 'spec') then
      (some $spec in tokenize($dependency/@value) satisfies
        ($spec = 'XP31' or (matches($spec, '^XP\\d\\d\\+$') and xs:integer(substring($spec, 3, 2)) le 31)))
    else if ($dependency/@type = 'xsd-version') then $dependency/@value = '1.1'
    else false()) = not($dependency/@satisfied = 'false'))
  and not(test/@file)]`;

const PREFIXES = `@prefix mf: <http://www.w3.org/2001/sw/DataAccess/tests/test-manifest#> .
@prefix qt: <http://www.w3.org/2001/sw/DataAccess/tests/test-query#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

// Traqula prints a prefix operator directly before its operand, which is not valid SPARQL when the operand has a prefix
// operator too, such as `- - 1`, so such an operand is printed between brackets.
const PREFIX_OPERATORS: Record<string, string> = { '!': '!', uplus: '+', uminus: '-' };

function prefixOperator(expression: unknown): string | undefined {
  return typeof expression === 'object' && expression !== null && 'operator' in expression ?
    PREFIX_OPERATORS[expression.operator as string] :
    undefined;
}

const expressionRule = sparql12GeneratorBuilder.getRule('expression');
const generator = GeneratorBuilder.create(sparql12GeneratorBuilder).patchRule({
  name: 'expression',
  gImpl: (def) => {
    const original = expressionRule.gImpl(def);
    return (ast, context) => {
      const operator = prefixOperator(ast);
      const operand = operator ? (ast as { args: Expression[] }).args[0] : undefined;
      if (operator && prefixOperator(operand)) {
        def.PRINT_WORD(operator, '(');
        def.SUBRULE(expressionRule, operand!);
        def.PRINT_WORD(')');
      } else {
        original(ast as Expression, context);
      }
    };
  },
}).build();
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
 * Generate the ASK query of a test case.
 * @throws {UnsupportedError} If the test case cannot be expressed in SPARQL.
 */
/**
 * Determine the URL of the definition of a test case on GitHub, at the line of its test-case element.
 */
function testCaseUrl(testSetFile: string, testSetText: string, name: string): string {
  const escapedName = name.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&');
  const match = new RegExp(`<test-case\\b[^>]*\\bname="${escapedName}"`, 'u').exec(testSetText);
  return `${QT3_VIEW_BASE}${testSetFile}${match ? `#L${testSetText.slice(0, match.index).split('\n').length}` : ''}`;
}

function testCaseQuery(testSetName: string, testCase: Element, catalog: Document, url: string): string {
  const variables = environmentVariables(testCase, catalog);
  const test = evaluateXPathToString('test', testCase);
  const expression = xpathToSparql(test, variables);
  const assertion = assertionToSparql(evaluateXPathToFirstNode<Element>('result/*', testCase)!, variables);
  const comment = test.trim().split('\n').map(line => `#   ${line.trim()}`).join('\n');
  return `# QT3 test case ${testCase.getAttribute('name')} of test set ${testSetName}, which tests the XPath expression
${comment}
# The test case is defined at ${url}
ASK {
  BIND(${sparql(expression)} AS ?result)
  FILTER(${sparql(assertion)})
}
`;
}

async function main(): Promise<void> {
  rmSync(DIST_DIR, { recursive: true, force: true });
  const catalog = parseXmlDocument(await fetchQt3('catalog.xml'));
  const includes: string[] = [];
  const skipReasons: Record<string, number> = {};
  let generated = 0;

  for (const testSet of evaluateXPathToNodes<Element>('/catalog/test-set', catalog)) {
    const testSetName = testSet.getAttribute('name')!;
    if (!TEST_SETS.test(testSetName)) {
      continue;
    }
    const testSetFile = testSet.getAttribute('file')!;
    const testSetText = await fetchQt3(testSetFile);
    const testSetXml = parseXmlDocument(testSetText);
    const names: string[] = [];
    const entries: string[] = [];
    for (const testCase of evaluateXPathToNodes<Element>(TEST_CASES_QUERY, testSetXml)) {
      const name = testCase.getAttribute('name')!;
      let query: string;
      try {
        query = testCaseQuery(testSetName, testCase, catalog, testCaseUrl(testSetFile, testSetText, name));
      } catch (error: unknown) {
        if (!(error instanceof UnsupportedError)) {
          throw error;
        }
        const reason = error.message.replace(/^(Unsupported \w+|Invalid XPath|Unknown variable|Invalid value).*/su, '$1');
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
        continue;
      }
      write(`${testSetName}/${name}.rq`, query);
      names.push(encodeURIComponent(name));
      const description = evaluateXPathToString('description', testCase).trim();
      entries.push(`<#${encodeURIComponent(name)}> a mf:QueryEvaluationTest ;
  mf:name ${turtleString(name)} ;${description ? `\n  rdfs:comment ${turtleString(description)} ;` : ''}
  rdfs:seeAlso <${QT3_BASE}${testSetFile}> ;
  mf:action [ qt:query <${encodeURIComponent(name)}.rq> ] ;
  mf:result <../true.srj> .`);
      generated++;
    }
    if (entries.length > 0) {
      write(`${testSetName}/manifest.ttl`, `${PREFIXES}
<> a mf:Manifest ;
  rdfs:label ${turtleString(`QT3 test set ${testSetName}`)} ;
  mf:entries (
${names.map(name => `    <#${name}>`).join('\n')}
  ) .

${entries.join('\n\n')}
`);
      includes.push(`${testSetName}/manifest.ttl`);
    }
  }

  write('manifest.ttl', `${PREFIXES}
<> a mf:Manifest ;
  rdfs:label "The W3C XQuery and XPath Test Suite (QT3) as SPARQL query evaluation tests" ;
  rdfs:comment ${turtleString(`Generated from ${QT3_BASE}catalog.xml`)} ;
  mf:include (
${includes.map(include => `    <${include}>`).join('\n')}
  ) .
`);
  write('true.srj', '{ "head": {}, "boolean": true }\n');

  process.stdout.write(`Generated ${generated} tests in ${includes.length} test sets\n`);
  for (const [ reason, count ] of Object.entries(skipReasons).sort(([ , a ], [ , b ]) => b - a)) {
    process.stdout.write(`  left out ${count}: ${reason}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
