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
  // A disjunction of sameTerm rather than IN, which is a disjunction of =
  const datatype = operation('datatype', term);
  return combine('||', subTypes(type).map(subType => operation('sameterm', datatype, xsdIri(subType))));
}

/**
 * Combine SPARQL expressions with a binary logical operator, as Traqula only generates two operands per operator.
 * @param operator The SPARQL operator, `&&` or `||`.
 * @param operands The SPARQL expressions, at least one.
 * @returns The SPARQL expression of the combination.
 */
function combine(operator: '&&' | '||', operands: Expression[]): Expression {
  return operands.reduce((left, right) => operation(operator, left, right));
}

/**
 * Create the SPARQL expression that the string value of a term, as XPath casting defines it, is the given string.
 * @param term The SPARQL expression of the term.
 * @param value The string.
 * @returns The SPARQL expression of the comparison.
 */
function hasStringValue(term: Expression, value: string): Expression {
  return operation('sameterm', xsdFunctionCall('string', term), literal(value, 'string'));
}

/**
 * Create the SPARQL expression that a term equals a literal, as XPath's eq, where the type check first ensures that
 * = only compares two numbers, and a string or boolean is compared by its string value, which is canonical.
 * @param term The SPARQL expression of the term.
 * @param expected The literal, which is a number, string or boolean.
 * @returns The SPARQL expression of the comparison.
 */
function equals(term: Expression, expected: TermLiteral): Expression {
  const type = astFactory.isTermLiteralTyped(expected) ? xsdLocalName(expected.langOrIri)! : 'string';
  if (NUMERIC_TYPES.has(type)) {
    // Numbers compare by value, e.g. 1 = 1.0e0
    return operation('&&', hasType(term, 'numeric'), operation('=', term, expected));
  }
  return operation('&&', hasType(term, type), hasStringValue(term, expected.value));
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
      return combine(
        assertion.localName === 'all-of' ? '&&' : '||',
        assertion.children.map(child => assertionToSparql(child)),
      );
    case 'not':
      return operation('!', assertionToSparql(assertion.children[0]));
    case 'assert-true':
    case 'assert-false':
      return equals(result, literal(assertion.localName === 'assert-true' ? 'true' : 'false', 'boolean'));
    case 'assert-eq': {
      const expected = foldLiteral(xpathToSparql(text));
      if (!expected) {
        throw new UnsupportedError('Unsupported expected value', text.trim());
      }
      return equals(result, expected);
    }
    case 'assert-string-value':
      if (assertion.getAttribute('normalize-space') === 'true') {
        throw new UnsupportedError('Unsupported assertion', 'assert-string-value with normalize-space');
      }
      return hasStringValue(result, text);
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
