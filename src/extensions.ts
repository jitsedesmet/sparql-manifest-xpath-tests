import type { Expression } from '@traqula/rules-sparql-1-2';
import { F, INTEGER_TYPES, XSD } from './xpathToSparql.ts';

/**
 * The XSD datatypes that SPARQL defines its operators and functions for
 * (https://www.w3.org/TR/sparql12-query/#operandDataTypes), by local name.
 */
const INTEGRAL_TYPES = new Set([ 'integer', ...Object.keys(INTEGER_TYPES) ]);
const NUMERIC_TYPES = new Set([ ...INTEGRAL_TYPES, 'decimal', 'float', 'double' ]);
const OPERAND_TYPES = new Set([ ...NUMERIC_TYPES, 'string', 'boolean', 'dateTime' ]);

/**
 * The XSD datatypes that SPARQL has a constructor function for (https://www.w3.org/TR/sparql12-query/#FunctionMapping).
 */
const CONSTRUCTOR_TYPES = new Set([ 'string', 'float', 'double', 'decimal', 'integer', 'dateTime', 'boolean' ]);

/**
 * The SPARQL operators that accept any RDF term, as they only use its effective boolean value, or not its value at all.
 */
const ANY_TERM_OPERATORS = new Set([ '!', '&&', '||', 'if', 'bound', 'datatype' ]);

/**
 * The datatypes of the results of SPARQL operators, by operator.
 */
const RESULT_TYPES: Record<string, string> = {
  '!': 'boolean',
  '&&': 'boolean',
  '||': 'boolean',
  '=': 'boolean',
  '!=': 'boolean',
  '<': 'boolean',
  '<=': 'boolean',
  '>': 'boolean',
  '>=': 'boolean',
  in: 'boolean',
  bound: 'boolean',
  strstarts: 'boolean',
  strends: 'boolean',
  contains: 'boolean',
  regex: 'boolean',
  strlen: 'integer',
  year: 'integer',
  month: 'integer',
  day: 'integer',
  hours: 'integer',
  minutes: 'integer',
  seconds: 'decimal',
  timezone: 'dayTimeDuration',
  substr: 'string',
  ucase: 'string',
  lcase: 'string',
  strbefore: 'string',
  strafter: 'string',
  encode_for_uri: 'string',
  concat: 'string',
  replace: 'string',
};

/**
 * The datatype of the result of a numeric operator, given the datatypes of its numeric operands,
 * following the numeric type promotion of XPath.
 */
function numericType(operator: string, types: string[]): string {
  for (const type of [ 'double', 'float', 'decimal' ]) {
    if (types.includes(type)) {
      return type;
    }
  }
  return operator === '/' ? 'decimal' : 'integer';
}

/**
 * Determine the XSD datatype of a SPARQL expression, as far as it is known statically,
 * and collect the reasons why it needs more than SPARQL defines.
 * @param expression The SPARQL expression.
 * @param resultType The XSD datatype of ?result, if known.
 * @param reasons The reasons, to which the reasons of this expression are added.
 * @returns The local name of the XSD datatype, or undefined if it is not known.
 */
function datatype(expression: Expression, resultType: string | undefined, reasons: Set<string>): string | undefined {
  if (F.isTermLiteral(expression)) {
    if (expression.langOrIri === undefined) {
      return 'string';
    }
    return typeof expression.langOrIri !== 'string' && expression.langOrIri.value.startsWith(XSD) ?
      expression.langOrIri.value.slice(XSD.length) :
      undefined;
  }
  if (F.isTermVariable(expression)) {
    return expression.value === 'result' ? resultType : undefined;
  }
  if (!F.isExpressionFunctionCall(expression) && !F.isExpressionOperator(expression)) {
    return undefined;
  }
  const args = expression.args as Expression[];
  const types = args.map(arg => datatype(arg, resultType, reasons));
  const name = F.isExpressionFunctionCall(expression) ?
    `xsd:${(expression.function as { value: string }).value.slice(XSD.length)}` :
    expression.operator.toUpperCase();
  if (!F.isExpressionFunctionCall(expression) && ANY_TERM_OPERATORS.has(expression.operator)) {
    return expression.operator === 'if' && types[1] === types[2] ? types[1] : RESULT_TYPES[expression.operator];
  }
  for (const type of types) {
    if (type !== undefined && !OPERAND_TYPES.has(type)) {
      reasons.add(`${name} on xsd:${type}`);
    }
  }

  if (F.isExpressionFunctionCall(expression)) {
    const type = (expression.function as { value: string }).value.slice(XSD.length);
    if (!CONSTRUCTOR_TYPES.has(type)) {
      reasons.add(`the constructor function xsd:${type}`);
    }
    return type;
  }
  const { operator } = expression;
  if ([ '+', '-', '*', '/', 'uplus', 'uminus', 'abs', 'ceil', 'floor', 'round' ].includes(operator)) {
    if (types.includes('dateTime')) {
      reasons.add(`${name} on xsd:dateTime`);
    }
    return types.every(type => type !== undefined && NUMERIC_TYPES.has(type)) ?
      numericType(operator, types as string[]) :
      undefined;
  }
  if (operator === 'substr' && types.slice(1).some(type => type !== undefined && !INTEGRAL_TYPES.has(type))) {
    reasons.add('SUBSTR with a position or length that is not an xsd:integer');
  }
  return RESULT_TYPES[operator];
}

/**
 * Determine why the query of a test needs more than SPARQL defines,
 * which is the case if it uses a datatype that is not a SPARQL operand datatype, such as xsd:date or xsd:duration,
 * or a function or operator with arguments of a datatype that SPARQL does not define it for.
 * @param expression The SPARQL expression that is bound to ?result.
 * @param assertion The SPARQL expression of the assertion over ?result.
 * @returns The reasons, which are empty if the query only needs what SPARQL defines.
 */
export function extensionReasons(expression: Expression, assertion: Expression): string[] {
  const reasons = new Set<string>();
  datatype(assertion, datatype(expression, undefined, reasons), reasons);
  return [ ...reasons ];
}
