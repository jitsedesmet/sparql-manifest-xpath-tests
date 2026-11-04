import type * as T11 from '@traqula/rules-sparql-1-1';
import type { Expression, TermIri, TermLiteral } from '@traqula/rules-sparql-1-2';
import { AstFactory } from '@traqula/rules-sparql-1-2';
import { XSD } from './xsd.ts';

export const astFactory = new AstFactory();

/**
 * The name of the variable that the result of the tested XPath expression is bound to.
 */
export const RESULT_VARIABLE = 'result';

/**
 * Create a SPARQL operation.
 * @param operator The SPARQL operator.
 * @param args The arguments.
 * @returns The SPARQL operation.
 */
export function operation(operator: string, ...args: Expression[]): Expression {
  return astFactory.expressionOperation(
    operator,
    args as T11.Expression[],
    astFactory.gen(),
  );
}

const XSD_PREFIX = 'xsd';

/**
 * The declaration of the prefix of the XSD IRIs, which every query needs.
 */
export const XSD_PREFIX_DECLARATION = `PREFIX ${XSD_PREFIX}: <${XSD}>`;

/**
 * Create the IRI of an XSD datatype, as a prefixed name.
 * @param localName The local name of the datatype.
 * @returns The IRI term.
 */
export function xsdIri(localName: string): TermIri {
  return astFactory.termNamed(astFactory.gen(), localName, XSD_PREFIX);
}

/**
 * Determine the local name of an XSD IRI.
 * @param iri The IRI term.
 * @returns The local name, or undefined if the IRI is not an XSD prefixed name.
 */
export function xsdLocalName(iri: TermIri): string | undefined {
  return 'prefix' in iri && iri.prefix === XSD_PREFIX ? iri.value : undefined;
}

/**
 * Create a SPARQL literal.
 * @param value The lexical form.
 * @param datatype The local name of the XSD datatype, where `string` creates a simple literal.
 * @returns The SPARQL literal.
 */
export function literal(value: string, datatype: string): TermLiteral {
  return datatype === 'string' ?
    astFactory.termLiteral(astFactory.gen(), value) :
    astFactory.termLiteral(astFactory.gen(), value, xsdIri(datatype));
}

/**
 * Create a SPARQL call of the constructor function of an XSD datatype.
 * @param localName The local name of the datatype.
 * @param arg The argument of the call.
 * @returns The SPARQL function call.
 */
export function xsdFunctionCall(localName: string, arg: Expression): Expression {
  return astFactory.expressionFunctionCall(
    xsdIri(localName),
    [ arg ] as T11.Expression[],
    false,
    astFactory.gen(),
  );
}
