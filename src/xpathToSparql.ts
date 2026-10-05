import type { SubTyped } from '@traqula/core';
import { TransformerSubTyped } from '@traqula/core';
import type { Expression, TermVariable } from '@traqula/rules-sparql-1-1';
import { AstFactory } from '@traqula/rules-sparql-1-2';
import fontoxpath from 'fontoxpath';
import * as slimdom from 'slimdom';

// fontoxpath is a CommonJS module, of which Node.js cannot detect the named exports
const { evaluateXPath, evaluateXPathToStrings, parseScript } = fontoxpath;

export const F = new AstFactory();

export const XSD = 'http://www.w3.org/2001/XMLSchema#';

/**
 * The namespaces of the XPath functions and of the XSD types, mapped onto their prefixes.
 */
const NAMESPACES: Record<string, string> = {
  'http://www.w3.org/2005/xpath-functions': 'fn',
  'http://www.w3.org/2001/XMLSchema': 'xs',
};

/**
 * Thrown for XPath expressions that have no SPARQL equivalent, so the test is left out of the manifest.
 */
export class UnsupportedError extends Error {}

/**
 * An element of the XQueryX syntax tree (https://www.w3.org/TR/xqueryx-31/) of an XPath expression,
 * of which the children are transformed into SPARQL expressions.
 */
interface IXQueryXNode extends SubTyped<'xqueryx', string> {
  attributes: Record<string, string>;
  text: string;
  children: IXQueryXNode[];
}

const transformer = new TransformerSubTyped<IXQueryXNode>();

/**
 * The XSD types for which SPARQL has a cast function.
 */
const CAST_TYPES = new Set([
  'string',
  'boolean',
  'integer',
  'decimal',
  'float',
  'double',
  'dateTime',
  'date',
  'time',
  'duration',
  'dayTimeDuration',
  'yearMonthDuration',
]);

/**
 * The XSD types derived from xsd:integer, which SPARQL has no cast function for, with their value ranges.
 * Constructing them from a string literal results in a typed literal, if the string is a valid value.
 */
export const INTEGER_TYPES: Record<string, [ bigint | undefined, bigint | undefined ]> = {
  nonPositiveInteger: [ undefined, 0n ],
  negativeInteger: [ undefined, -1n ],
  long: [ -(2n ** 63n), (2n ** 63n) - 1n ],
  int: [ -(2n ** 31n), (2n ** 31n) - 1n ],
  short: [ -(2n ** 15n), (2n ** 15n) - 1n ],
  byte: [ -(2n ** 7n), (2n ** 7n) - 1n ],
  nonNegativeInteger: [ 0n, undefined ],
  unsignedLong: [ 0n, (2n ** 64n) - 1n ],
  unsignedInt: [ 0n, (2n ** 32n) - 1n ],
  unsignedShort: [ 0n, (2n ** 16n) - 1n ],
  unsignedByte: [ 0n, (2n ** 8n) - 1n ],
  positiveInteger: [ 1n, undefined ],
};

/**
 * XPath functions, by name and arity, mapped onto the SPARQL operators that the SPARQL specification defines with them.
 */
const FUNCTIONS: Record<string, { arities: number[]; operator: string }> = {
  abs: { arities: [ 1 ], operator: 'abs' },
  ceiling: { arities: [ 1 ], operator: 'ceil' },
  floor: { arities: [ 1 ], operator: 'floor' },
  round: { arities: [ 1 ], operator: 'round' },
  'string-length': { arities: [ 1 ], operator: 'strlen' },
  substring: { arities: [ 2, 3 ], operator: 'substr' },
  'upper-case': { arities: [ 1 ], operator: 'ucase' },
  'lower-case': { arities: [ 1 ], operator: 'lcase' },
  'starts-with': { arities: [ 2 ], operator: 'strstarts' },
  'ends-with': { arities: [ 2 ], operator: 'strends' },
  contains: { arities: [ 2 ], operator: 'contains' },
  'substring-before': { arities: [ 2 ], operator: 'strbefore' },
  'substring-after': { arities: [ 2 ], operator: 'strafter' },
  'encode-for-uri': { arities: [ 1 ], operator: 'encode_for_uri' },
  matches: { arities: [ 2, 3 ], operator: 'regex' },
  replace: { arities: [ 3, 4 ], operator: 'replace' },
  'year-from-dateTime': { arities: [ 1 ], operator: 'year' },
  'year-from-date': { arities: [ 1 ], operator: 'year' },
  'month-from-dateTime': { arities: [ 1 ], operator: 'month' },
  'month-from-date': { arities: [ 1 ], operator: 'month' },
  'day-from-dateTime': { arities: [ 1 ], operator: 'day' },
  'day-from-date': { arities: [ 1 ], operator: 'day' },
  'hours-from-dateTime': { arities: [ 1 ], operator: 'hours' },
  'hours-from-time': { arities: [ 1 ], operator: 'hours' },
  'minutes-from-dateTime': { arities: [ 1 ], operator: 'minutes' },
  'minutes-from-time': { arities: [ 1 ], operator: 'minutes' },
  'seconds-from-dateTime': { arities: [ 1 ], operator: 'seconds' },
  'seconds-from-time': { arities: [ 1 ], operator: 'seconds' },
  'timezone-from-dateTime': { arities: [ 1 ], operator: 'timezone' },
  not: { arities: [ 1 ], operator: '!' },
};

/**
 * The XQueryX elements of XPath operators, mapped onto the SPARQL operators that they correspond to.
 */
const OPERATORS: Record<string, string> = {
  orOp: '||',
  andOp: '&&',
  eqOp: '=',
  neOp: '!=',
  ltOp: '<',
  leOp: '<=',
  gtOp: '>',
  geOp: '>=',
  equalOp: '=',
  notEqualOp: '!=',
  lessThanOp: '<',
  lessThanOrEqualOp: '<=',
  greaterThanOp: '>',
  greaterThanOrEqualOp: '>=',
  addOp: '+',
  subtractOp: '-',
  multiplyOp: '*',
  divOp: '/',
  unaryMinusOp: 'uminus',
  unaryPlusOp: 'uplus',
};

/**
 * The XQueryX elements that only group the parts of an expression.
 */
const GROUPING_ELEMENTS = new Set([
  'firstOperand',
  'secondOperand',
  'operand',
  'arguments',
  'argExpr',
  'ifClause',
  'thenClause',
  'elseClause',
  'functionName',
  'singleType',
  'atomicType',
  'optional',
  'value',
  'name',
]);

function toNode(element: slimdom.Element): IXQueryXNode {
  return {
    type: 'xqueryx',
    subType: element.localName,
    attributes: Object.fromEntries(element.attributes.map(attribute => [ attribute.localName, attribute.value ])),
    text: element.textContent ?? '',
    children: element.children.map(toNode),
  };
}

function xqueryxNode(subType: string, children: IXQueryXNode[] = [], text = '',
  attributes: Record<string, string> = {}): IXQueryXNode {
  return { type: 'xqueryx', subType, attributes, text, children };
}

/**
 * Determine the strings that the source of a quantified expression evaluates to,
 * if it is a call of fn:tokenize on string literals, as in the tests of regular expressions.
 * @returns The strings, or undefined if they are not known statically.
 */
function staticStrings(source: IXQueryXNode): string[] | undefined {
  if (source.subType !== 'functionCallExpr') {
    return undefined;
  }
  const [ functionName, args ] = source.children;
  if (functionName.attributes.URI !== undefined || ![ '', 'fn' ].includes(functionName.attributes.prefix ?? '') ||
    functionName.text !== 'tokenize' || args.children.length < 2 ||
    !args.children.every(arg => arg.subType === 'stringConstantExpr')) {
    return undefined;
  }
  const [ input, pattern, flags ] = args.children.map(arg => arg.text);
  try {
    return evaluateXPathToStrings(
      `tokenize($input, $pattern${flags === undefined ? '' : ', $flags'})`,
      null,
      null,
      { input, pattern, flags: flags ?? '' },
    );
  } catch {
    return undefined;
  }
}

/**
 * Substitute the references to a variable in an XQueryX syntax tree.
 */
function substitute(node: IXQueryXNode, name: string, value: IXQueryXNode): IXQueryXNode {
  if (node.subType === 'varRef' && node.text === name) {
    return value;
  }
  return { ...node, children: node.children.map(child => substitute(child, name, value)) };
}

/**
 * Expand the quantified expressions over a sequence that is known statically into a conjunction (every)
 * or a disjunction (some) of their predicate for each item, as SPARQL has no sequences.
 * Other quantified expressions are left as they are, so they are unsupported.
 */
function expandQuantifiers(node: IXQueryXNode): IXQueryXNode {
  const expanded = { ...node, children: node.children.map(expandQuantifiers) };
  if (expanded.subType !== 'quantifiedExpr') {
    return expanded;
  }
  const [ quantifier, ...parts ] = expanded.children;
  const clauses = parts.filter(child => child.subType === 'quantifiedExprInClause');
  const [ binding, source ] = clauses[0].children;
  const [ varName, ...typeDeclaration ] = binding.children;
  const strings = staticStrings(source.children[0]);
  if (clauses.length !== 1 || typeDeclaration.length > 0 || varName.attributes.prefix || !strings) {
    return expanded;
  }
  const every = quantifier.text === 'every';
  const predicate = parts.find(child => child.subType === 'predicateExpr')!.children[0];
  const operands = strings.map(value =>
    substitute(predicate, varName.text, xqueryxNode('stringConstantExpr', [], value)));
  if (operands.length === 0) {
    return xqueryxNode('functionCallExpr', [
      xqueryxNode('functionName', [], every ? 'true' : 'false', { prefix: 'fn' }),
      xqueryxNode('arguments'),
    ]);
  }
  return operands.reduce((left, right) => xqueryxNode(every ? 'andOp' : 'orOp', [
    xqueryxNode('firstOperand', [ left ]),
    xqueryxNode('secondOperand', [ right ]),
  ]));
}

/**
 * Parse an XPath expression into the XQueryX syntax tree of its body.
 */
function parse(xpath: string): IXQueryXNode {
  let module: slimdom.Element;
  try {
    module = parseScript<slimdom.Element>(
      xpath,
      { language: evaluateXPath.XPATH_3_1_LANGUAGE, annotateAst: false },
      new slimdom.Document(),
    );
  } catch (error: unknown) {
    throw new UnsupportedError(`Invalid XPath: ${(error as Error).message}`);
  }
  const queryBody = module.getElementsByTagNameNS('http://www.w3.org/2005/XQueryX', 'queryBody')[0];
  return expandQuantifiers(toNode(queryBody.children[0]));
}

/**
 * The SPARQL expression of the part of an XQueryX element with the given name.
 */
function part(node: IXQueryXNode, name: string): Expression {
  return node.children.find(child => child.subType === name)!.children[0] as unknown as Expression;
}

/**
 * The prefixed name of an XQueryX element with a name, which has either a prefix or a namespace URI.
 * @param node The XQueryX element.
 * @param defaultPrefix The prefix of a name without prefix.
 * @throws {UnsupportedError} If the namespace is not the one of the XPath functions or of the XSD types.
 */
function prefixedName(node: IXQueryXNode, defaultPrefix = ''): string {
  const { prefix, URI: uri } = node.attributes;
  if (uri !== undefined && !NAMESPACES[uri]) {
    throw new UnsupportedError(`Unsupported namespace ${uri}`);
  }
  return `${uri === undefined ? prefix || defaultPrefix : NAMESPACES[uri]}:${node.text}`;
}

/**
 * Create a SPARQL literal, given its lexical form and the local name of its XSD datatype.
 */
function literal(value: string, datatype: string): Expression {
  return F.termLiteral(F.gen(), value, datatype === 'string' ? undefined : F.termNamed(F.gen(), `${XSD}${datatype}`));
}

/**
 * Create the SPARQL equivalent of an XPath cast to the type with the given prefixed name.
 */
function cast(typeName: string, expression: Expression): Expression {
  const [ prefix, localName ] = typeName.split(':');
  if (prefix !== 'xs') {
    throw new UnsupportedError(`Unsupported cast type ${typeName}`);
  }
  if (CAST_TYPES.has(localName)) {
    return F.expressionFunctionCall(F.termNamed(F.gen(), `${XSD}${localName}`), [ expression ], false, F.gen());
  }
  // Integer types have no cast function, but a string literal with a valid value can become a typed literal.
  // An invalid value would be an error in XPath, but an ill-typed literal in SPARQL, so it has no SPARQL equivalent.
  // Other types, such as xs:untypedAtomic and xs:anyURI, are not SPARQL operand types.
  if (localName in INTEGER_TYPES && F.isTermLiteralStr(expression)) {
    const value = expression.value.trim();
    const [ min, max ] = INTEGER_TYPES[localName];
    if (!/^[+-]?\d+$/u.test(value) || (min !== undefined && BigInt(value) < min) ||
      (max !== undefined && BigInt(value) > max)) {
      throw new UnsupportedError(`Invalid value ${value} for xs:${localName}`);
    }
    return literal(value, localName);
  }
  throw new UnsupportedError(`Unsupported cast type ${typeName}`);
}

/**
 * Create the SPARQL equivalent of a call of the XPath function with the given prefixed name.
 */
function functionCall(name: string, args: Expression[]): Expression {
  const [ prefix, localName ] = name.split(':');
  if (prefix === 'xs' && args.length === 1) {
    return cast(name, args[0]);
  }
  if (prefix !== 'fn') {
    throw new UnsupportedError(`Unsupported function ${name}`);
  }
  if ((localName === 'true' || localName === 'false') && args.length === 0) {
    return literal(localName, 'boolean');
  }
  if (localName === 'boolean' && args.length === 1) {
    // The effective boolean value, as negating twice
    return F.expressionOperation('!', [ F.expressionOperation('!', args, F.gen()) ], F.gen());
  }
  if (localName === 'string' && args.length === 1) {
    // The string value of an atomic value is its cast to xs:string
    return cast('xs:string', args[0]);
  }
  if (localName === 'concat' && args.length >= 2) {
    // XPath converts the arguments to strings, while SPARQL only accepts strings
    return F.expressionOperation('concat', args.map(arg => cast('xs:string', arg)), F.gen());
  }
  const definition = FUNCTIONS[localName];
  if (!definition?.arities.includes(args.length)) {
    throw new UnsupportedError(`Unsupported function ${name}#${args.length}`);
  }
  return F.expressionOperation(definition.operator, args, F.gen());
}

/**
 * Translate an XPath expression into a SPARQL expression, as a Traqula syntax tree.
 * The XQueryX syntax tree is transformed bottom-up, so the children of an element are SPARQL expressions already.
 * @param xpath The XPath expression.
 * @param variables SPARQL expressions to substitute variable references with.
 * @throws {UnsupportedError} If the expression has no SPARQL equivalent.
 */
export function xpathToSparql(xpath: string, variables: Record<string, Expression> = {}): Expression {
  return transformer.transformNodeSpecific<'unsafe', Expression>(parse(xpath), {
    xqueryx: {
      transform(node) {
        if (OPERATORS[node.subType]) {
          return F.expressionOperation(
            OPERATORS[node.subType],
            node.subType.startsWith('unary') ?
                [ part(node, 'operand') ] :
                [ part(node, 'firstOperand'), part(node, 'secondOperand') ],
            F.gen(),
          );
        }
        if (!GROUPING_ELEMENTS.has(node.subType)) {
          throw new UnsupportedError(`Unsupported ${node.subType}`);
        }
        return node;
      },
    },
  }, {
    xqueryx: {
      integerConstantExpr: { transform: ({ text }) => literal(text, 'integer') },
      decimalConstantExpr: { transform: ({ text }) => literal(text, 'decimal') },
      doubleConstantExpr: { transform: ({ text }) => literal(text, 'double') },
      stringConstantExpr: { transform: ({ text }) => literal(text, 'string') },
      varRef: {
        transform({ text }) {
          if (!variables[text]) {
            throw new UnsupportedError(`Unknown variable $${text}`);
          }
          return variables[text];
        },
      },
      ifThenElseExpr: {
        transform: node => F.expressionOperation('if', [
          part(node, 'ifClause'),
          part(node, 'thenClause'),
          part(node, 'elseClause'),
        ], F.gen()),
      },
      castExpr: {
        transform(node) {
          const singleType = node.children.find(child => child.subType === 'singleType')!;
          const [ atomicType, optional ] = singleType.children;
          if (optional) {
            throw new UnsupportedError('Unsupported cast to an optional type');
          }
          return cast(prefixedName(atomicType), part(node, 'argExpr'));
        },
      },
      functionCallExpr: {
        transform(node) {
          const [ functionName, args ] = node.children;
          return functionCall(prefixedName(functionName, 'fn'), args.children as unknown as Expression[]);
        },
      },
    },
  });
}
