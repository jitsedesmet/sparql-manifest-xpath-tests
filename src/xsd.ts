import { UnsupportedError } from './UnsupportedError.ts';

export const XSD = 'http://www.w3.org/2001/XMLSchema#';

type Range = [ bigint | undefined, bigint | undefined ];

/**
 * TODO: why does this repo care about the range?
 * The XSD datatypes that are derived from another one, mapped onto that datatype and, for integer types, their range.
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
  return [
    type,
    ...Object.entries(DERIVED_TYPES).filter(([ , { parent }]) => parent === type).flatMap(([ child ]) => subTypes(child)),
  ];
}

/**
 * The value ranges of the XSD datatypes derived from xsd:integer, which SPARQL has no constructor function for.
 */
export const INTEGER_RANGES: Record<string, Range> = Object.fromEntries(Object.entries(DERIVED_TYPES)
  .flatMap(([ type, { range }]) => range ? [[ type, range ]] : []));

export const INTEGRAL_TYPES = new Set(subTypes('integer'));
export const NUMERIC_TYPES = new Set(subTypes('numeric'));

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
