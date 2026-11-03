import type { Expression } from '@traqula/rules-sparql-1-2';
import { RESULT_VARIABLE, astFactory, xsdLocalName } from './sparqlAst.ts';
import { CONSTRUCTOR_TYPES, INTEGRAL_TYPES, NUMERIC_TYPES, OPERAND_TYPES } from './xsd.ts';

/**
 * The SPARQL operators that accept any RDF term, as they only use its effective boolean value, or not its value at all.
 */
const ANY_TERM_OPERATORS = new Set([ '!', '&&', '||', 'if', 'bound', 'datatype' ]);

/**
 * The SPARQL operators on numbers, of which the result datatype follows the numeric type promotion of XPath.
 */
const NUMERIC_OPERATORS = new Set([ '+', '-', '*', '/', 'uplus', 'uminus', 'abs', 'ceil', 'floor', 'round' ]);

/**
 * The datatypes of the results of the other SPARQL operators, by operator.
 * TODO: why is this relevant for a test builder like this repo?
 */
const RESULT_TYPES: Record<string, string> = {
  ...Object.fromEntries([
    '!',
    '&&',
    '||',
    '=',
    '!=',
    '<',
    '<=',
    '>',
    '>=',
    'in',
    'bound',
    'strstarts',
    'strends',
    'contains',
    'regex',
  ].map(operator => [ operator, 'boolean' ])),
  ...Object.fromEntries([ 'strlen', 'year', 'month', 'day', 'hours', 'minutes' ]
    .map(operator => [ operator, 'integer' ])),
  ...Object.fromEntries([ 'substr', 'ucase', 'lcase', 'strbefore', 'strafter', 'encode_for_uri', 'concat', 'replace' ]
    .map(operator => [ operator, 'string' ])),
  seconds: 'decimal',
  timezone: 'dayTimeDuration',
};

/**
 * Determine the datatype of the result of a numeric operator, following the numeric type promotion of XPath.
 * @param operator The SPARQL operator.
 * @param types The local names of the XSD datatypes of the operands.
 * @returns The local name of the XSD datatype of the result.
 */
function numericType(operator: string, types: (string | undefined)[]): string {
  // Integer operands give an integer, except for a division
  return [ 'double', 'float', 'decimal' ].find(type => types.includes(type)) ??
    (operator === '/' ? 'decimal' : 'integer');
}

/**
 * TODO: I feel like this is used to create
 *  'prettier test strings pruning result type checks when they are known statically',
 *  but that's really something that should NOT happen in this repo!
 * Determine the XSD datatype of a SPARQL expression, as far as it is known statically,
 * and collect the reasons why it needs more than SPARQL defines.
 * @param expression The SPARQL expression.
 * @param resultType The XSD datatype of ?result, if known.
 * @param reasons The reasons, to which the reasons of this expression are added.
 * @returns The local name of the XSD datatype, or undefined if it is not known.
 */
function datatype(expression: Expression, resultType: string | undefined, reasons: Set<string>): string | undefined {
  if (astFactory.isTermLiteralStr(expression)) {
    return 'string';
  }
  if (astFactory.isTermLiteralTyped(expression)) {
    return xsdLocalName(expression.langOrIri);
  }
  if (astFactory.isTermVariable(expression)) {
    return expression.value === RESULT_VARIABLE ? resultType : undefined;
  }

  const isFunctionCall = astFactory.isExpressionFunctionCall(expression);
  if (!isFunctionCall && !astFactory.isExpressionOperator(expression)) {
    return undefined;
  }

  const types = expression.args.map(arg => datatype(arg, resultType, reasons));
  if (isFunctionCall) {
    const constructorType = xsdLocalName(expression.function)!;
    addOperandReasons(`xsd:${constructorType}`, types, reasons);
    if (!CONSTRUCTOR_TYPES.has(constructorType)) {
      reasons.add(`the constructor function xsd:${constructorType}`);
    }
    return constructorType;
  }

  const { operator } = expression;
  if (ANY_TERM_OPERATORS.has(operator)) {
    return operator === 'if' && types[1] === types[2] ? types[1] : RESULT_TYPES[operator];
  }
  const name = operator.toUpperCase();
  addOperandReasons(name, types, reasons);

  if (NUMERIC_OPERATORS.has(operator)) {
    if (types.includes('dateTime')) {
      reasons.add(`${name} on xsd:dateTime`);
    }
    if (types.every(type => type !== undefined && NUMERIC_TYPES.has(type))) {
      return numericType(operator, types);
    }
    return undefined;
  }
  if (operator === 'substr' && types.slice(1).some(type => type !== undefined && !INTEGRAL_TYPES.has(type))) {
    reasons.add('SUBSTR with a position or length that is not an xsd:integer');
  }
  return RESULT_TYPES[operator];
}

/**
 * Collect a reason for each operand of a function or operator with a datatype that SPARQL does not define.
 * @param name The name of the function or operator, as in the reason.
 * @param types The local names of the XSD datatypes of the operands, if known.
 * @param reasons The reasons, to which the reasons of the operands are added.
 */
function addOperandReasons(name: string, types: (string | undefined)[], reasons: Set<string>): void {
  for (const type of types) {
    if (type !== undefined && !OPERAND_TYPES.has(type)) {
      reasons.add(`${name} on xsd:${type}`);
    }
  }
}

/**
 * Determine why the query of a test needs more than SPARQL defines, as it uses a datatype that is not a SPARQL
 * operand datatype, such as xsd:date, or a function or operator on arguments that SPARQL does not define it for.
 * @param expression The SPARQL expression that is bound to ?result.
 * @param assertion The SPARQL expression of the assertion over ?result.
 * @returns The reasons, which are empty if the query only needs what SPARQL defines.
 */
export function extensionReasons(expression: Expression, assertion: Expression): string[] {
  const reasons = new Set<string>();
  datatype(assertion, datatype(expression, undefined, reasons), reasons);
  return [ ...reasons ];
}
