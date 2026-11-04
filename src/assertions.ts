import type { Expression, TermLiteral } from '@traqula/rules-sparql-1-2';
import type { Element } from 'slimdom';
import {
  RESULT_VARIABLE,
  astFactory,
  literal,
  literalType,
  operation,
  xsdFunctionCall,
  xsdIri,
  xsdLocalName,
} from './sparqlAst.ts';
import { UnsupportedError } from './UnsupportedError.ts';
import { foldStringLiteralCast, xpathToSparql } from './xpathToSparql.ts';
import { NUMERIC_TYPES, isSubType, numericResultType, subTypes } from './xsd.ts';

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
 * The SPARQL variable that the result of the tested XPath expression is bound to.
 */
const RESULT = astFactory.termVariable(RESULT_VARIABLE, astFactory.gen());

/**
 * The SPARQL operations that the assertions use, which the README lists, as the tests rely on them being correct.
 */
const ASSERTION_OPERATIONS = new Set([ '!', '&&', '||', 'bound', 'datatype', 'sameterm', 'xsd:string', '=' ]);

/**
 * Check that an assertion only uses the operations that the README lists, where = has a numeric literal operand.
 * @param expression The SPARQL expression of the assertion.
 * @throws {Error} If the assertion uses another operation, which is a bug of the generator.
 */
function checkOperations(expression: Expression): void {
  if (!astFactory.isExpressionFunctionCall(expression) && !astFactory.isExpressionOperator(expression)) {
    return;
  }
  const name = astFactory.isExpressionFunctionCall(expression) ?
    `xsd:${xsdLocalName(expression.function)}` :
    expression.operator;
  const isListed = ASSERTION_OPERATIONS.has(name) && (name !== '=' ||
    expression.args.some(arg => astFactory.isTermLiteral(arg) && NUMERIC_TYPES.has(literalType(arg) ?? '')));
  if (!isListed) {
    throw new Error(`An assertion uses ${name}, which the README does not list`);
  }
  for (const arg of expression.args) {
    checkOperations(arg);
  }
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
  const type = operand && literalType(operand);
  if (!operand || type === undefined || !NUMERIC_TYPES.has(type)) {
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
 * Combine SPARQL expressions with a logical operator, where a single expression stays as it is.
 * @param operator The SPARQL operator, `&&` or `||`.
 * @param operands The SPARQL expressions, at least one.
 * @returns The SPARQL expression of the combination.
 */
function combine(operator: '&&' | '||', operands: Expression[]): Expression {
  return operands.length === 1 ? operands[0] : operation(operator, ...operands);
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
 * An assertion that ?result equals a literal, as XPath's eq, split into the comparison of the value and the datatype
 * that ?result needs for it.
 */
interface Equality {
  comparison: Expression;
  requiredType: string;
}

/**
 * Split an assert-eq, assert-true or assert-false into the comparison of the value and the datatype it requires,
 * where a number compares by value and a string or boolean by its canonical string value.
 * @param assertion The assertion element.
 * @returns The equality, or undefined if the assertion is of another kind.
 * @throws {UnsupportedError} If the expected value is not a constant.
 */
function equality(assertion: Element): Equality | undefined {
  let expected: TermLiteral | undefined;
  switch (assertion.localName) {
    case 'assert-true':
    case 'assert-false':
      expected = literal(assertion.localName === 'assert-true' ? 'true' : 'false', 'boolean');
      break;
    case 'assert-eq':
      expected = foldLiteral(xpathToSparql(assertion.textContent!));
      if (!expected) {
        throw new UnsupportedError('Unsupported expected value', assertion.textContent!.trim());
      }
      break;
    default:
      return undefined;
  }
  const type = literalType(expected)!;
  const isNumber = NUMERIC_TYPES.has(type);
  return {
    // Numbers compare by value, e.g. 1 = 1.0e0
    comparison: isNumber ? operation('=', RESULT, expected) : hasStringValue(RESULT, expected.value),
    requiredType: isNumber ? 'numeric' : type,
  };
}

/**
 * Create the SPARQL expression of an equality, followed by its type check unless an enclosing assert-type implies it.
 * @param equality The equality.
 * @param checkedType The datatype that an assert-type in an enclosing all-of checks ?result for, if any.
 * @returns The SPARQL expression of the equality.
 */
function checkedEquality({ comparison, requiredType }: Equality, checkedType?: string): Expression {
  // A conjoined type check makes the whole conjunction false for any other type, whatever the comparison gives
  return checkedType !== undefined && isSubType(checkedType, requiredType) ?
    comparison :
    operation('&&', comparison, hasType(RESULT, requiredType));
}

/**
 * Determine the XSD datatype that an assert-type assertion checks.
 * @param assertion The assert-type element.
 * @returns The local name of the datatype.
 * @throws {UnsupportedError} If the type is not an XSD datatype.
 */
function assertedType(assertion: Element): string {
  const typeName = assertion.textContent!.trim();
  const match = /^xs:(\w+)$/u.exec(typeName);
  if (!match) {
    throw new UnsupportedError('Unsupported type', typeName);
  }
  return match[1];
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
  const expression = translateAssertion(assertion);
  checkOperations(expression);
  return expression;
}

/**
 * Translate an assertion, or one nested in another, as assertionToSparql.
 * @param assertion The assertion element.
 * @param checkedType The datatype that an assert-type in an enclosing all-of checks ?result for, if any.
 * @returns The SPARQL expression of the assertion over ?result.
 * @throws {UnsupportedError} If the assertion needs other operations.
 */
function translateAssertion(assertion: Element, checkedType?: string): Expression {
  switch (assertion.localName) {
    case 'error':
      return operation('!', operation('bound', RESULT));
    case 'all-of': {
      const typeAssertion = assertion.children.find(child => child.localName === 'assert-type');
      const childCheckedType = typeAssertion ? assertedType(typeAssertion) : checkedType;
      return combine('&&', assertion.children.map(child => translateAssertion(child, childCheckedType)));
    }
    case 'any-of': {
      // Equalities that require the same datatype share one type check, as && distributes over ||
      const equalities = assertion.children.map(equality);
      const requiredTypes = new Set(equalities.map(childEquality => childEquality?.requiredType));
      if (requiredTypes.size === 1 && !requiredTypes.has(undefined)) {
        return checkedEquality({
          comparison: combine('||', equalities.map(childEquality => childEquality!.comparison)),
          requiredType: equalities[0]!.requiredType,
        }, checkedType);
      }
      return combine('||', assertion.children.map(child => translateAssertion(child, checkedType)));
    }
    case 'not':
      return operation('!', translateAssertion(assertion.children[0], checkedType));
    case 'assert-true':
    case 'assert-false':
    case 'assert-eq':
      return checkedEquality(equality(assertion)!, checkedType);
    case 'assert-string-value':
      if (assertion.getAttribute('normalize-space') === 'true') {
        throw new UnsupportedError('Unsupported assertion', 'assert-string-value with normalize-space');
      }
      return hasStringValue(RESULT, assertion.textContent!);
    case 'assert-type':
      return hasType(RESULT, assertedType(assertion));
    default:
      throw new UnsupportedError('Unsupported assertion', assertion.localName);
  }
}
