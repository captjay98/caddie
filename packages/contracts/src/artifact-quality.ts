import * as v from 'valibot';
export const ARTIFACT_QUALITY_POLICY = 'quality-v1';
export const QualityFindingSchema = v.strictObject({
 severity:v.picklist(['blocking','advisory']),
 criterion:v.pipe(v.string(),v.minLength(1),v.maxLength(120)),
 detail:v.pipe(v.string(),v.minLength(1),v.maxLength(1200)),
});
export const ArtifactQualityReviewSchema = v.strictObject({
 verdict:v.picklist(['pass','revise']),
 findings:v.pipe(v.array(QualityFindingSchema),v.maxLength(30)),
});
export type ArtifactQualityReview = v.InferOutput<typeof ArtifactQualityReviewSchema>;
export type QualityStage = 'prd'|'looks'|'design';
export interface ReviewImage {
 stateId:string; viewport:'phone'|'desktop'; width:number; height:number;
 documentHash:string; pngSha256:string; pngBase64:string;
}
/** Review text is untrusted data, never permission to publish, build, or approve. */
export function parseArtifactQualityReview(value:unknown):ArtifactQualityReview {
 const parsed=v.safeParse(ArtifactQualityReviewSchema,value);
 if(!parsed.success) throw new Error('Invalid independent review response');
 if(parsed.output.verdict==='pass' && parsed.output.findings.some(row=>row.severity==='blocking'))
  throw new Error('A blocking finding cannot receive a passing verdict');
 return parsed.output;
}
