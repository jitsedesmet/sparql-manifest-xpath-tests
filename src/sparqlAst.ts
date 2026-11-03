import type { Expression, TermIriFull } from '@traqula/rules-sparql-1-2';
import { AstFactory } from '@traqula/rules-sparql-1-2';
import { XSD } from './xsd.ts';

export const astFactory = new AstFactory();

/**
 * The name of the variable that the result of the tested XPath expression is bound to.
 */
export const RESULT_VARIABLE = 'result';

/**
 * The arguments of the expression constructors of the AstFactory, which it inherits from SPARQL 1.1 with their types,
 * while a SPARQL 1.2 expression extends the same tree.
 */
type FactoryArguments = Parameters<typeof astFactory.expressionOperation>[1];

/**
 * Create a SPARQL operation.
 * @param operator The operator.
 * @param args The arguments of the operation.
 */
export function operation(operator: string, ...args: Expression[]): Expression {
  return astFactory.expressionOperation(operator, args as FactoryArguments, astFactory.gen());
}

/**
 * Create the IRI of an XSD datatype.
 * @param localName The local name of the datatype.
 */
export function xsdIri(localName: string): TermIriFull {
  return astFactory.termNamed(astFactory.gen(), `${XSD}${localName}`);
}

/**
 * Determine the local name of an XSD IRI.
 * @param iri The IRI term.
 * @returns The local name, or undefined if the IRI is not in the XSD namespace.
 */
export function xsdLocalName(iri: { value: string }): string | undefined {
  return iri.value.startsWith(XSD) ? iri.value.slice(XSD.length) : undefined;
}

/**
 * Create a SPARQL literal.
 * @param value The lexical form.
 * @param datatype The local name of the XSD datatype, where `string` creates a simple literal.
 */
export function literal(value: string, datatype: string): Expression {
  return datatype === 'string' ?
    astFactory.termLiteral(astFactory.gen(), value) :
    astFactory.termLiteral(astFactory.gen(), value, xsdIri(datatype));
}

/**
 * Create a SPARQL call of the constructor function of an XSD datatype.
 * @param localName The local name of the datatype.
 * @param arg The argument of the call.
 */
export function xsdFunctionCall(localName: string, arg: Expression): Expression {
  return astFactory.expressionFunctionCall(xsdIri(localName), [ arg ] as FactoryArguments, false, astFactory.gen());
}
