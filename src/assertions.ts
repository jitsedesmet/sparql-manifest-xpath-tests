import type { Expression } from '@traqula/rules-sparql-1-1';
import type { Element } from 'slimdom';
import { F, UnsupportedError, XSD, xpathToSparql } from './xpathToSparql.ts';

/**
 * The XSD datatypes, mapped onto the datatype that they are derived from.
 */
const PARENT_TYPES: Record<string, string> = {
  integer: 'decimal',
  nonPositiveInteger: 'integer',
  negativeInteger: 'nonPositiveInteger',
  long: 'integer',
  int: 'long',
  short: 'int',
  byte: 'short',
  nonNegativeInteger: 'integer',
  unsignedLong: 'nonNegativeInteger',
  unsignedInt: 'unsignedLong',
  unsignedShort: 'unsignedInt',
  unsignedByte: 'unsignedShort',
  positiveInteger: 'nonNegativeInteger',
  normalizedString: 'string',
  token: 'normalizedString',
  language: 'token',
  NMTOKEN: 'token',
  Name: 'token',
  NCName: 'Name',
  ID: 'NCName',
  IDREF: 'NCName',
  ENTITY: 'NCName',
  dayTimeDuration: 'duration',
  yearMonthDuration: 'duration',
  dateTimeStamp: 'dateTime',
};

/**
 * The primitive XSD datatypes, which are not derived from another one.
 */
const PRIMITIVE_TYPES = [
  'string',
  'boolean',
  'decimal',
  'float',
  'double',
  'duration',
  'dateTime',
  'time',
  'date',
  'gYearMonth',
  'gYear',
  'gMonthDay',
  'gDay',
  'gMonth',
  'hexBinary',
  'base64Binary',
  'anyURI',
  'QName',
  'NOTATION',
  'untypedAtomic',
];

const ALL_TYPES = [ ...PRIMITIVE_TYPES, ...Object.keys(PARENT_TYPES) ];

/**
 * Determine the XSD datatypes that are the given datatype or derived from it,
 * where xs:numeric and xs:anyAtomicType are the unions of their member types.
 */
function subTypes(type: string): string[] {
  if (type === 'anyAtomicType') {
    return ALL_TYPES;
  }
  if (type === 'numeric') {
    return [ 'double', 'float', ...subTypes('decimal') ];
  }
  if (!ALL_TYPES.includes(type)) {
    throw new UnsupportedError(`Unsupported type xs:${type}`);
  }
  return [ type, ...Object.keys(PARENT_TYPES).filter(child => PARENT_TYPES[child] === type).flatMap(subTypes) ];
}

function operation(operator: string, ...args: Expression[]): Expression {
  return F.expressionOperation(operator, args, F.gen());
}

function string(value: string): Expression {
  return F.termLiteral(F.gen(), value);
}

function iri(value: string): Expression {
  return F.termNamed(F.gen(), value);
}

/**
 * Normalize the whitespace of a SPARQL string, as XPath's fn:normalize-space.
 */
function normalizeSpace(expression: Expression): Expression {
  return operation('replace', operation('replace', expression, string(String.raw`^\s+|\s+$`), string('')),
    string(String.raw`\s+`), string(' '));
}

/**
 * Translate an assertion of the test suite into a SPARQL expression over ?result, the result of the test,
 * which is true if the result satisfies the assertion. An error of the test leaves ?result unbound.
 * @param assertion The assertion element.
 * @param variables SPARQL expressions to substitute the variable references of the environment with.
 * @throws {UnsupportedError} If the assertion has no SPARQL equivalent.
 */
export function assertionToSparql(assertion: Element, variables: Record<string, Expression>): Expression {
  const result = F.termVariable('result', F.gen());
  const text = assertion.textContent!.trim();
  switch (assertion.localName) {
    case 'error':
      return operation('!', operation('bound', result));
    case 'all-of':
    case 'any-of':
      return assertion.children.map(child => assertionToSparql(child, variables))
        .reduce((left, right) => operation(assertion.localName === 'all-of' ? '&&' : '||', left, right));
    case 'not':
      return operation('!', assertionToSparql(assertion.children[0], variables));
    case 'assert-true':
      return operation('&&', operation('=', operation('datatype', result), iri(`${XSD}boolean`)), result);
    case 'assert-false':
      return operation('&&', operation('=', operation('datatype', result), iri(`${XSD}boolean`)), operation('!', result));
    case 'assert-eq':
      return operation('=', result, xpathToSparql(text, variables));
    case 'assert-deep-eq': {
      // Deep equality also considers NaN equal to itself
      const expected = xpathToSparql(text, variables);
      return operation('||', operation('=', result, expected), operation('&&',
        operation('!=', result, result),
        operation('!=', expected, expected)));
    }
    case 'assert-string-value': {
      const actual = F.expressionFunctionCall(F.termNamed(F.gen(), `${XSD}string`), [ result ], false, F.gen());
      return assertion.getAttribute('normalize-space') === 'true' ?
        operation('=', normalizeSpace(actual), string(assertion.textContent!.replaceAll(/\s+/gu, ' ').trim())) :
        operation('=', actual, string(assertion.textContent!));
    }
    case 'assert-type': {
      const match = /^xs:(\w+)$/u.exec(text);
      if (!match) {
        throw new UnsupportedError(`Unsupported type ${text}`);
      }
      return operation('in', operation('datatype', result), ...subTypes(match[1]).map(type => iri(`${XSD}${type}`)));
    }
    case 'assert':
      return xpathToSparql(text, { ...variables, result });
    default:
      throw new UnsupportedError(`Unsupported assertion ${assertion.localName}`);
  }
}
