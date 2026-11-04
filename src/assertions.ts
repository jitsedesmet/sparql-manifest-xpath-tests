import type { Expression, TermLiteral } from '@traqula/rules-sparql-1-2';
import type { Element } from 'slimdom';
import { RESULT_VARIABLE, astFactory, literal, operation, xsdFunctionCall, xsdIri, xsdLocalName } from './sparqlAst.ts';
import { UnsupportedError } from './UnsupportedError.ts';
import { foldStringLiteralCast, xpathToSparql } from './xpathToSparql.ts';
import { NUMERIC_TYPES, numericResultType, subTypes } from './xsd.ts';

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
 * @returns Whether the assertion accepts an error.
 */
export function acceptsError(assertion: Expression): boolean {
  return valueWhenUnbound(assertion) === true;
}

/**
 * Negate the lexical form of a number.
 * @param value The lexical form.
 * @returns The lexical form of the negated number.
 */
function negate(value: string): string {
  if (value === 'NaN') {
    return value;
  }
  return value.startsWith('-') ? value.slice(1) : `-${value.replace(/^\+/u, '')}`;
}

/**
 * Fold a constant SPARQL expression into a literal, so an assertion does not depend on the operators that build it.
 * @param expression A literal, a signed numeric literal, or a cast of a string literal to a string or number.
 * @returns The literal, or undefined if the expression is not such a constant.
 * @example `- "0"^^xsd:integer` becomes `"-0"^^xsd:integer`, and `xsd:float("1e0")` becomes `"1e0"^^xsd:float`.
 */
function foldLiteral(expression: Expression): TermLiteral | undefined {
  if (astFactory.isTermLiteral(expression)) {
    return expression;
  }
  if (astFactory.isExpressionFunctionCall(expression)) {
    return foldStringLiteralCast(xsdLocalName(expression.function)!, expression.args[0]);
  }
  if (!astFactory.isExpressionOperator(expression) || ![ 'uminus', 'uplus' ].includes(expression.operator)) {
    return undefined;
  }
  const operand = foldLiteral(expression.args[0]);
  if (!operand || !astFactory.isTermLiteralTyped(operand)) {
    return undefined;
  }
  const type = xsdLocalName(operand.langOrIri);
  if (type === undefined || !NUMERIC_TYPES.has(type)) {
    return undefined;
  }
  return literal(
    expression.operator === 'uminus' ? negate(operand.value) : operand.value,
    numericResultType(expression.operator, [ type ]),
  );
}

/**
 * Create the SPARQL expression that a term has an XSD datatype, or one derived from it.
 * @param term The SPARQL expression of the term.
 * @param type The local name of the datatype.
 * @returns The SPARQL expression of the type check.
 */
function hasType(term: Expression, type: string): Expression {
  return operation('in', operation('datatype', term), ...subTypes(type).map(xsdIri));
}

/**
 * Translate an assertion of the test suite into a SPARQL expression that is true if ?result satisfies it,
 * where an error of the test leaves ?result unbound.
 * Only the operations that the README lists are used, so a failing test points at the tested expression.
 * @param assertion The assertion element.
 * @returns The SPARQL expression of the assertion over ?result.
 * @throws {UnsupportedError} If the assertion needs other operations.
 */
export function assertionToSparql(assertion: Element): Expression {
  const result = astFactory.termVariable(RESULT_VARIABLE, astFactory.gen());
  const text = assertion.textContent!;
  switch (assertion.localName) {
    case 'error':
      return operation('!', operation('bound', result));
    case 'all-of':
    case 'any-of':
      return assertion.children
        .map(child => assertionToSparql(child))
        .reduce((left, right) =>
          operation(assertion.localName === 'all-of' ? '&&' : '||', left, right));
    case 'not':
      return operation('!', assertionToSparql(assertion.children[0]));
    case 'assert-true':
    case 'assert-false': {
      // = rather than the effective boolean value, which is false for an ill-typed xsd:boolean
      const expected = literal(assertion.localName === 'assert-true' ? 'true' : 'false', 'boolean');
      return operation('&&', hasType(result, 'boolean'), operation('=', result, expected));
    }
    case 'assert-eq': {
      // QT3 compares by value, as XPath's eq, which is = rather than sameTerm, e.g. 1 = 1.0e0
      const expected = foldLiteral(xpathToSparql(text));
      if (!expected) {
        throw new UnsupportedError('Unsupported expected value', text.trim());
      }
      return operation('=', result, expected);
    }
    case 'assert-string-value':
      if (assertion.getAttribute('normalize-space') === 'true') {
        throw new UnsupportedError('Unsupported assertion', 'assert-string-value with normalize-space');
      }
      return operation('sameterm', xsdFunctionCall('string', result), literal(text, 'string'));
    case 'assert-type': {
      const typeName = text.trim();
      const match = /^xs:(\w+)$/u.exec(typeName);
      if (!match) {
        throw new UnsupportedError('Unsupported type', typeName);
      }
      return hasType(result, match[1]);
    }
    default:
      throw new UnsupportedError('Unsupported assertion', assertion.localName);
  }
}
