import { UnsupportedError } from './UnsupportedError.ts';

export const XSD = 'http://www.w3.org/2001/XMLSchema#';

type Range = [ bigint | undefined, bigint | undefined ];

/**
 * The XSD datatypes that are derived from another one, mapped onto that datatype and, for integer types, their range.
 * The ranges tell which values of an integer type are valid, see isValidNumber.
 */
const DERIVED_TYPES: Record<string, { parent: string; range?: Range }> = {
  integer: { parent: 'decimal' },
  nonPositiveInteger: { parent: 'integer', range: [ undefined, 0n ]},
  negativeInteger: { parent: 'nonPositiveInteger', range: [ undefined, -1n ]},
  long: { parent: 'integer', range: [ -(2n ** 63n), (2n ** 63n) - 1n ]},
  int: { parent: 'long', range: [ -(2n ** 31n), (2n ** 31n) - 1n ]},
  short: { parent: 'int', range: [ -(2n ** 15n), (2n ** 15n) - 1n ]},
  byte: { parent: 'short', range: [ -(2n ** 7n), (2n ** 7n) - 1n ]},
  nonNegativeInteger: { parent: 'integer', range: [ 0n, undefined ]},
  unsignedLong: { parent: 'nonNegativeInteger', range: [ 0n, (2n ** 64n) - 1n ]},
  unsignedInt: { parent: 'unsignedLong', range: [ 0n, (2n ** 32n) - 1n ]},
  unsignedShort: { parent: 'unsignedInt', range: [ 0n, (2n ** 16n) - 1n ]},
  unsignedByte: { parent: 'unsignedShort', range: [ 0n, (2n ** 8n) - 1n ]},
  positiveInteger: { parent: 'nonNegativeInteger', range: [ 1n, undefined ]},
  normalizedString: { parent: 'string' },
  token: { parent: 'normalizedString' },
  language: { parent: 'token' },
  NMTOKEN: { parent: 'token' },
  Name: { parent: 'token' },
  NCName: { parent: 'Name' },
  ID: { parent: 'NCName' },
  IDREF: { parent: 'NCName' },
  ENTITY: { parent: 'NCName' },
  dayTimeDuration: { parent: 'duration' },
  yearMonthDuration: { parent: 'duration' },
  dateTimeStamp: { parent: 'dateTime' },
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

const ALL_TYPES = [ ...PRIMITIVE_TYPES, ...Object.keys(DERIVED_TYPES) ];

/**
 * Determine the XSD datatypes that are the given datatype or derived from it.
 * @param type The local name of the datatype, where `numeric` and `anyAtomicType` are the unions of their members.
 * @returns The local names of the datatypes.
 */
export function subTypes(type: string): string[] {
  if (type === 'anyAtomicType') {
    return ALL_TYPES;
  }
  if (type === 'numeric') {
    return [ 'double', 'float', ...subTypes('decimal') ];
  }
  if (!ALL_TYPES.includes(type)) {
    throw new UnsupportedError('Unsupported type', `xs:${type}`);
  }
  const children = Object.entries(DERIVED_TYPES).filter(([ , { parent }]) => parent === type);
  return [ type, ...children.flatMap(([ child ]) => subTypes(child)) ];
}

/**
 * Determine whether an XSD datatype is another one or derived from it.
 * @param type The local name of the datatype.
 * @param superType The local name of the other datatype, where `numeric` and `anyAtomicType` are unions.
 * @returns Whether the datatype is a subtype of the other one.
 */
export function isSubType(type: string, superType: string): boolean {
  return type === superType || subTypes(superType).includes(type);
}

export const INTEGRAL_TYPES = new Set(subTypes('integer'));
export const NUMERIC_TYPES = new Set(subTypes('numeric'));

const DECIMAL_PATTERN = String.raw`[+-]?(\d+(\.\d*)?|\.\d+)`;
const FLOATING_POINT_PATTERN = new RegExp(String.raw`^(${DECIMAL_PATTERN}([Ee][+-]?\d+)?|[+-]?INF|NaN)$`, 'u');

/**
 * The lexical spaces of the numeric XSD datatypes, where the types derived from xsd:integer share the one of integer.
 */
const LEXICAL_SPACES: Record<string, RegExp> = {
  integer: /^[+-]?\d+$/u,
  decimal: new RegExp(`^${DECIMAL_PATTERN}$`, 'u'),
  float: FLOATING_POINT_PATTERN,
  double: FLOATING_POINT_PATTERN,
};

/**
 * Determine whether a lexical form is a valid value of a numeric XSD datatype, within the range of an integer type.
 * Fontoxpath cannot check this, as it loses precision beyond 2^53.
 * @param value The lexical form.
 * @param type The local name of the numeric datatype.
 * @returns Whether the lexical form is valid.
 */
export function isValidNumber(value: string, type: string): boolean {
  const [ min, max ] = DERIVED_TYPES[type]?.range ?? [];
  return LEXICAL_SPACES[INTEGRAL_TYPES.has(type) ? 'integer' : type].test(value) &&
    (min === undefined || BigInt(value) >= min) &&
    (max === undefined || BigInt(value) <= max);
}

/**
 * Determine the datatype of the result of a numeric operator, following the numeric type promotion of XPath.
 * @param operator The SPARQL operator.
 * @param types The local names of the XSD datatypes of the operands.
 * @returns The local name of the XSD datatype of the result.
 */
export function numericResultType(operator: string, types: string[]): string {
  // Integer operands give an integer, except for a division
  return [ 'double', 'float', 'decimal' ].find(type => types.includes(type)) ??
    (operator === '/' ? 'decimal' : 'integer');
}

/**
 * The XSD datatypes that SPARQL defines its operators and functions for
 * (https://www.w3.org/TR/sparql12-query/#operandDataTypes).
 */
export const OPERAND_TYPES = new Set([ ...NUMERIC_TYPES, 'string', 'boolean', 'dateTime' ]);

/**
 * The XSD datatypes that SPARQL has a constructor function for (https://www.w3.org/TR/sparql12-query/#FunctionMapping).
 */
export const CONSTRUCTOR_TYPES = new Set([ 'string', 'float', 'double', 'decimal', 'integer', 'dateTime', 'boolean' ]);

/**
 * The XSD datatypes that casts are translated into constructor functions for,
 * which includes the ones that SPARQL engines commonly support as an extension.
 */
export const CAST_TYPES = new Set([
  ...CONSTRUCTOR_TYPES,
  'date',
  'time',
  'duration',
  'dayTimeDuration',
  'yearMonthDuration',
]);
