/** Graphics quality levels (Options → Qualité graphique, or ?q=low|medium|high|ultra). */
export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export type QualitySetting = 'auto' | QualityLevel;

export interface QualityProfile {
  level: QualityLevel;
  label: string;
  /** Upper bound of the render scale (the dynamic resolution only goes down from here). */
  maxPixelRatio: number;
  /** false: render straight to the screen, no bloom or lens post-processing. */
  post: boolean;
  /** MSAA samples of the HDR post-processing target. */
  msaa: number;
  /** Cubemap face size of the baked sky. */
  skySize: number;
  /** Multiplier on explosion and impact particle counts. */
  particles: number;
}

export const QUALITY: Record<QualityLevel, QualityProfile> = {
  low: { level: 'low', label: 'Bas', maxPixelRatio: 1, post: false, msaa: 0, skySize: 512, particles: 0.35 },
  medium: { level: 'medium', label: 'Moyen', maxPixelRatio: 1, post: true, msaa: 0, skySize: 1024, particles: 0.7 },
  high: { level: 'high', label: 'Élevé', maxPixelRatio: 1.5, post: true, msaa: 4, skySize: 1024, particles: 1 },
  ultra: { level: 'ultra', label: 'Ultra', maxPixelRatio: 2, post: true, msaa: 4, skySize: 2048, particles: 1 },
};

export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export function isQualityLevel(v: unknown): v is QualityLevel {
  return typeof v === 'string' && (QUALITY_LEVELS as string[]).includes(v);
}

/**
 * The level in use: ?q= in the address wins, then the player's choice; "auto"
 * picks Bas on phones and tablets and Élevé elsewhere.
 */
export function resolveQuality(setting: QualitySetting, touch: boolean, param: string | null): QualityLevel {
  if (isQualityLevel(param)) return param;
  if (isQualityLevel(setting)) return setting;
  return touch ? 'low' : 'high';
}
