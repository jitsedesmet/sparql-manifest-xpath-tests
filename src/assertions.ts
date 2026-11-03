import type { Expression } from '@traqula/rules-sparql-1-2';
import type { Element } from 'slimdom';
import { RESULT_VARIABLE, astFactory, literal, operation, xsdFunctionCall, xsdIri } from './sparqlAst.ts';
import { UnsupportedError } from './UnsupportedError.ts';
import { xpathToSparql } from './xpathToSparql.ts';
import { subTypes } from './xsd.ts';

/**
 * Normalize the whitespace of a SPARQL string, as XPath's fn:normalize-space.
 * @param expression The SPARQL expression of the string.
 */
function normalizeSpace(expression: Expression): Expression {
  return operation(
    'replace',
    operation(
      'replace',
      expression,
      literal(String.raw`^\s+|\s+$`, 'string'),
      literal('', 'string'),
    ),
    literal(String.raw`\s+`, 'string'),
    literal(' ', 'string'),
  );
}

/**
 * Evaluate the SPARQL expression of an assertion for an unbound ?result, as when the test errors,
 * following the error treatment of the logical operators of SPARQL, where any other expression is an error.
 * @param expression The SPARQL expression of the assertion.
 * @returns The value, or undefined for an error.
 */
function valueWhenUnbound(expression: Expression): boolean | undefined {
  if (!astFactory.isExpressionOperator(expression)) {
    return undefined;
  }
  const values = expression.args.map(valueWhenUnbound);
  switch (expression.operator) {
    case 'bound':
      return false;
    case '!':
      return values[0] === undefined ? undefined : !values[0];
    case '&&':
      return values.includes(false) ? false : (values.includes(undefined) ? undefined : true);
    case '||':
      return values.includes(true) ? true : (values.includes(undefined) ? undefined : false);
    default:
      return undefined;
  }
}

/**
 * Determine whether an assertion is satisfied when the test errors, so it also passes on engines failing otherwise.
 * @param assertion The SPARQL expression of the assertion.
 */
export function acceptsError(assertion: Expression): boolean {
  return valueWhenUnbound(assertion) === true;
}

/**
 * Translate an assertion of the test suite into a SPARQL expression that is true if ?result satisfies it,
 * where an error of the test leaves ?result unbound.
 * @param assertion The assertion element.
 * @param variables SPARQL expressions to substitute the variable references of the environment with.
 * @throws {UnsupportedError} If the assertion has no SPARQL equivalent.
 */
export function assertionToSparql(assertion: Element, variables: Record<string, Expression>): Expression {
  const result = astFactory.termVariable(RESULT_VARIABLE, astFactory.gen());
  const isBoolean = operation('=', operation('datatype', result), xsdIri('boolean'));
  const text = assertion.textContent!.trim();
  switch (assertion.localName) {
    case 'error':
      return operation('!', operation('bound', result));
    case 'all-of':
    case 'any-of':
      return assertion.children
        .map(child => assertionToSparql(child, variables))
        .reduce((left, right) =>
          operation(assertion.localName === 'all-of' ? '&&' : '||', left, right));
    case 'not':
      return operation('!', assertionToSparql(assertion.children[0], variables));
    case 'assert-true':
      return operation('&&', isBoolean, result);
    case 'assert-false':
      return operation('&&', isBoolean, operation('!', result));
    case 'assert-eq':
      return operation('=', result, xpathToSparql(text, variables));
    case 'assert-deep-eq': {
      // Deep equality also considers NaN equal to itself
      const expected = xpathToSparql(text, variables);
      const bothNaN = operation('&&', operation('!=', result, result), operation('!=', expected, expected));
      return operation('||', operation('=', result, expected), bothNaN);
    }
    case 'assert-string-value': {
      const actual = xsdFunctionCall('string', result);
      if (assertion.getAttribute('normalize-space') === 'true') {
        const expected = assertion.textContent!.replaceAll(/[ \t\n\r]+/gu, ' ').replaceAll(/^ | $/gu, '');
        return operation('=', normalizeSpace(actual), literal(expected, 'string'));
      }
      return operation('=', actual, literal(assertion.textContent!, 'string'));
    }
    case 'assert-type': {
      const match = /^xs:(\w+)$/u.exec(text);
      if (!match) {
        throw new UnsupportedError('Unsupported type', text);
      }
      return operation('in', operation('datatype', result), ...subTypes(match[1]).map(xsdIri));
    }
    case 'assert':
      return xpathToSparql(text, { ...variables, result });
    default:
      throw new UnsupportedError('Unsupported assertion', assertion.localName);
  }
}
