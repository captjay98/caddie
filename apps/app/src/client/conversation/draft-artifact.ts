/** Raw author output is inspectable evidence, never an approval surface. */
export function isDraftArtifact(text:string):boolean {
 return /(?:^|\n)#{1,4}[^\n]*(?:Product Requirements Document|Design Brief)|```(?:caddie-theme|caddie-features|caddie-looks|html-mock)/i.test(text);
}
