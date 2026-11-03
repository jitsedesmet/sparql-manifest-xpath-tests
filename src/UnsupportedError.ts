/**
 * Thrown for test cases that have no SPARQL equivalent, so the test is left out of the manifest.
 */
export class UnsupportedError extends Error {
  public readonly category: string;

  /**
   * @param category The kind of reason, by which the left-out test cases are counted.
   * @param detail What exactly is unsupported, appended to the category in the message.
   */
  public constructor(category: string, detail?: string) {
    super(detail === undefined ? category : `${category} ${detail}`);
    this.category = category;
  }
}
