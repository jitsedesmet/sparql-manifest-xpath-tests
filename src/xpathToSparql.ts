import type { SubTyped } from '@traqula/core';
import { TransformerSubTyped } from '@traqula/core';
import type { Expression } from '@traqula/rules-sparql-1-2';
import fontoxpath from 'fontoxpath';
import * as slimdom from 'slimdom';
import { astFactory, literal, operation, xsdFunctionCall } from './sparqlAst.ts';
import { UnsupportedError } from './UnsupportedError.ts';
import { CAST_TYPES, INTEGER_RANGES } from './xsd.ts';

// The fontoxpath package is a CommonJS module, of which Node.js cannot detect the named exports
const { evaluateXPath, evaluateXPathToStrings, parseScript } = fontoxpath;

/**
 * The namespaces of the XPath functions and of the XSD types, mapped onto their prefixes.
 */
const NAMESPACES: Record<string, string> = {
  'http://www.w3.org/2005/xpath-functions': 'fn',
  'http://www.w3.org/2001/XMLSchema': 'xs',
};

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
 * The SPARQL equivalent of an XPath function, for the numbers of arguments that it accepts.
 */
interface FunctionTranslation {
  accepts: (argumentCount: number) => boolean;
  translate: (args: Expression[]) => Expression;
}

/**
 * Create the translation of an XPath function into the SPARQL operator that the SPARQL specification defines with it.
 * @param operator The SPARQL operator.
 * @param arities The numbers of arguments that the function accepts.
 * @returns The translation of the function.
 */
function sparqlOperator(operator: string, arities = [ 1 ]): FunctionTranslation {
  return { accepts: count => arities.includes(count), translate: args => operation(operator, ...args) };
}

/**
 * The XPath functions, by local name, mapped onto their SPARQL equivalent.
 */
const FUNCTIONS: Record<string, FunctionTranslation> = {
  abs: sparqlOperator('abs'),
  ceiling: sparqlOperator('ceil'),
  floor: sparqlOperator('floor'),
  round: sparqlOperator('round'),
  'string-length': sparqlOperator('strlen'),
  substring: sparqlOperator('substr', [ 2, 3 ]),
  'upper-case': sparqlOperator('ucase'),
  'lower-case': sparqlOperator('lcase'),
  'starts-with': sparqlOperator('strstarts', [ 2 ]),
  'ends-with': sparqlOperator('strends', [ 2 ]),
  contains: sparqlOperator('contains', [ 2 ]),
  'substring-before': sparqlOperator('strbefore', [ 2 ]),
  'substring-after': sparqlOperator('strafter', [ 2 ]),
  'encode-for-uri': sparqlOperator('encode_for_uri'),
  matches: sparqlOperator('regex', [ 2, 3 ]),
  replace: sparqlOperator('replace', [ 3, 4 ]),
  'year-from-dateTime': sparqlOperator('year'),
  'year-from-date': sparqlOperator('year'),
  'month-from-dateTime': sparqlOperator('month'),
  'month-from-date': sparqlOperator('month'),
  'day-from-dateTime': sparqlOperator('day'),
  'day-from-date': sparqlOperator('day'),
  'hours-from-dateTime': sparqlOperator('hours'),
  'hours-from-time': sparqlOperator('hours'),
  'minutes-from-dateTime': sparqlOperator('minutes'),
  'minutes-from-time': sparqlOperator('minutes'),
  'seconds-from-dateTime': sparqlOperator('seconds'),
  'seconds-from-time': sparqlOperator('seconds'),
  'timezone-from-dateTime': sparqlOperator('timezone'),
  not: sparqlOperator('!'),
  true: { accepts: count => count === 0, translate: () => literal('true', 'boolean') },
  false: { accepts: count => count === 0, translate: () => literal('false', 'boolean') },
  // The effective boolean value, as negating twice
  boolean: { accepts: count => count === 1, translate: args => operation('!', operation('!', ...args)) },
  // The string value of an atomic value is its cast to xs:string
  string: { accepts: count => count === 1, translate: ([ arg ]) => cast('string', arg) },
  // XPath converts the arguments to strings, while SPARQL only accepts strings
  concat: {
    accepts: count => count >= 2,
    translate: args => operation('concat', ...args.map(arg => cast('string', arg))),
  },
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

function xqueryxNode(
  subType: string,
  children: IXQueryXNode[] = [],
  text = '',
  attributes: Record<string, string> = {},
): IXQueryXNode {
  return { type: 'xqueryx', subType, attributes, text, children };
}

function toNode(element: slimdom.Element): IXQueryXNode {
  return xqueryxNode(
    element.localName,
    element.children.map(toNode),
    element.textContent ?? '',
    Object.fromEntries(element.attributes.map(attribute => [ attribute.localName, attribute.value ])),
  );
}

/**
 * Find the child of an XQueryX element with the given name.
 * @param node The XQueryX element.
 * @param subType The name of the child.
 * @returns The child, or undefined if there is none.
 */
function child(node: IXQueryXNode, subType: string): IXQueryXNode | undefined {
  return node.children.find(candidate => candidate.subType === subType);
}

/**
 * A name, of which the prefix is resolved to one of the NAMESPACES.
 */
interface QualifiedName {
  prefix: string;
  localName: string;
}

/**
 * Determine the qualified name of an XQueryX element with a name, which has either a prefix or a namespace URI.
 * @param node The XQueryX element.
 * @param defaultPrefix The prefix of a name without prefix.
 * @returns The prefix and local name.
 * @throws {UnsupportedError} If the namespace is not the one of the XPath functions or of the XSD types.
 */
function qualifiedName(node: IXQueryXNode, defaultPrefix = ''): QualifiedName {
  const { prefix, URI: uri } = node.attributes;
  if (uri !== undefined && !Object.hasOwn(NAMESPACES, uri)) {
    throw new UnsupportedError('Unsupported namespace', uri);
  }
  return { prefix: uri === undefined ? prefix || defaultPrefix : NAMESPACES[uri], localName: node.text };
}

/**
 * Determine the strings that the source of a quantified expression evaluates to,
 * if it is a call of fn:tokenize on string literals, as in the tests of regular expressions.
 * @param source The XQueryX element of the source.
 * @returns The strings, or undefined if they are not known statically.
 */
function staticStrings(source: IXQueryXNode): string[] | undefined {
  if (source.subType !== 'functionCallExpr') {
    return undefined;
  }
  const [ functionName, args ] = source.children;
  const { prefix, localName } = qualifiedName(functionName, 'fn');
  if (prefix !== 'fn' || localName !== 'tokenize' || args.children.length < 2 ||
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
 * @param node The XQueryX syntax tree.
 * @param name The name of the variable.
 * @param value The XQueryX element to substitute the references with.
 * @returns The XQueryX syntax tree with the references substituted.
 */
function substitute(node: IXQueryXNode, name: string, value: IXQueryXNode): IXQueryXNode {
  if (node.subType === 'varRef' && node.text === name) {
    return value;
  }
  return { ...node, children: node.children.map(child => substitute(child, name, value)) };
}

/**
 * Expand the quantified expressions over a statically known sequence into a conjunction (every)
 * or disjunction (some) of their predicate per item, as SPARQL has no sequences. Others are left unsupported.
 * @param node The XQueryX syntax tree.
 * @returns The XQueryX syntax tree with the quantified expressions expanded.
 */
function expandQuantifiers(node: IXQueryXNode): IXQueryXNode {
  const expanded = { ...node, children: node.children.map(expandQuantifiers) };
  if (expanded.subType !== 'quantifiedExpr') {
    return expanded;
  }
  const [ quantifier, ...parts ] = expanded.children;
  const clauses = parts.filter(part => part.subType === 'quantifiedExprInClause');
  if (clauses.length !== 1) {
    return expanded;
  }
  const [ binding, source ] = clauses[0].children;
  const [ varName, ...typeDeclaration ] = binding.children;
  if (typeDeclaration.length > 0 || varName.attributes.prefix) {
    return expanded;
  }
  const strings = staticStrings(source.children[0]);
  if (!strings) {
    return expanded;
  }
  const every = quantifier.text === 'every';
  const predicate = child(expanded, 'predicateExpr')!.children[0];
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
 * @param xpath The XPath expression.
 * @returns The XQueryX syntax tree of the body of the expression.
 * @throws {UnsupportedError} If the expression is not valid XPath 3.1.
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
    throw new UnsupportedError('Invalid XPath', `expression: ${(error as Error).message}`);
  }
  const queryBody = module.getElementsByTagNameNS('http://www.w3.org/2005/XQueryX', 'queryBody')[0];
  return expandQuantifiers(toNode(queryBody.children[0]));
}

/**
 * The SPARQL expression of the part of an XQueryX element with the given name, which is transformed already.
 * @param node The XQueryX element.
 * @param name The name of the part.
 * @returns The SPARQL expression of the part.
 */
function part(node: IXQueryXNode, name: string): Expression {
  return child(node, name)!.children[0] as unknown as Expression;
}

/**
 * Create the SPARQL equivalent of an XPath cast.
 * @param localName The local name of the XSD type to cast to.
 * @param expression The SPARQL expression to cast.
 * @returns The SPARQL expression of the cast.
 * @throws {UnsupportedError} If the cast has no SPARQL equivalent.
 */
function cast(localName: string, expression: Expression): Expression {
  if (CAST_TYPES.has(localName)) {
    return xsdFunctionCall(localName, expression);
  }
  // Integer types have no cast function, but a string literal with a valid value can become a typed literal.
  // An invalid value would be an error in XPath, but an ill-typed literal in SPARQL, so it has no SPARQL equivalent.
  // Other types, such as xs:untypedAtomic and xs:anyURI, are not SPARQL operand types.
  if (Object.hasOwn(INTEGER_RANGES, localName) && astFactory.isTermLiteralStr(expression)) {
    // XSD only collapses spaces, tabs and line breaks, unlike String.prototype.trim
    const value = expression.value.replaceAll(/^[ \t\n\r]+|[ \t\n\r]+$/gu, '');
    const [ min, max ] = INTEGER_RANGES[localName];
    if (!/^[+-]?\d+$/u.test(value) || (min !== undefined && BigInt(value) < min) ||
      (max !== undefined && BigInt(value) > max)) {
      throw new UnsupportedError('Invalid value', `${value} for xs:${localName}`);
    }
    return literal(value, localName);
  }
  throw new UnsupportedError('Unsupported cast', `type xs:${localName}`);
}

/**
 * Create the SPARQL equivalent of a call of an XPath function, where a call of an XSD type is a cast.
 * @param name The name of the function.
 * @param args The SPARQL expressions of the arguments.
 * @returns The SPARQL expression of the call.
 * @throws {UnsupportedError} If the call has no SPARQL equivalent.
 */
function functionCall({ prefix, localName }: QualifiedName, args: Expression[]): Expression {
  if (prefix === 'xs' && args.length === 1) {
    return cast(localName, args[0]);
  }
  const translation = prefix === 'fn' && Object.hasOwn(FUNCTIONS, localName) ? FUNCTIONS[localName] : undefined;
  if (!translation?.accepts(args.length)) {
    throw new UnsupportedError('Unsupported function', `${prefix}:${localName}#${args.length}`);
  }
  return translation.translate(args);
}

/**
 * Translate an XPath expression into a SPARQL expression, transforming its XQueryX syntax tree bottom-up.
 * @param xpath The XPath expression.
 * @param variables SPARQL expressions to substitute variable references with.
 * @returns The SPARQL expression, as a Traqula syntax tree.
 * @throws {UnsupportedError} If the expression has no SPARQL equivalent.
 */
export function xpathToSparql(xpath: string, variables: Record<string, Expression> = {}): Expression {
  return transformer.transformNodeSpecific<'unsafe', Expression>(parse(xpath), {
    xqueryx: {
      transform(node) {
        if (OPERATORS[node.subType]) {
          return node.subType.startsWith('unary') ?
            operation(OPERATORS[node.subType], part(node, 'operand')) :
            operation(OPERATORS[node.subType], part(node, 'firstOperand'), part(node, 'secondOperand'));
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
          if (!Object.hasOwn(variables, text)) {
            throw new UnsupportedError('Unknown variable', `$${text}`);
          }
          return variables[text];
        },
      },
      ifThenElseExpr: {
        transform: node => operation(
          'if',
          part(node, 'ifClause'),
          part(node, 'thenClause'),
          part(node, 'elseClause'),
        ),
      },
      castExpr: {
        transform(node) {
          const [ atomicType, optional ] = child(node, 'singleType')!.children;
          if (optional) {
            throw new UnsupportedError('Unsupported cast', 'to an optional type');
          }
          const typeName = qualifiedName(atomicType);
          if (typeName.prefix !== 'xs') {
            throw new UnsupportedError('Unsupported cast', `type ${typeName.prefix}:${typeName.localName}`);
          }
          return cast(typeName.localName, part(node, 'argExpr'));
        },
      },
      functionCallExpr: {
        transform(node) {
          const [ functionName, args ] = node.children;
          return functionCall(qualifiedName(functionName, 'fn'), args.children as unknown as Expression[]);
        },
      },
    },
  });
}
