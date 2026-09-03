export const CAMPAIGN_MOVIE_CHOICES_REQUIRED = 3;
export const LICENSING_TRIGGER_PERCENTAGE = 70;
export const INTEREST_MULTIPLIER = 2;

export const BACKING_REMEDY_POLICY = {
  autoCarryInterestOnReplacement: true,
  autoCarryBackingOnReplacement: false,
} as const;

export type CampaignStatus =
  | "draft"
  | "active"
  | "licensing-pending"
  | "theater-check"
  | "movie-available"
  | "tipped"
  | "scheduled"
  | "confirmed"
  | "screening"
  | "completed"
  | "suspended"
  | "expired"
  | "cancelled";

export function calculateInterestThreshold(backingThreshold: number): number {
  return Math.max(0, Math.ceil(Number(backingThreshold || 0) * INTEREST_MULTIPLIER));
}

export function calculateLicensingTrigger(threshold: number): number {
  return Math.max(1, Math.ceil((Number(threshold || 0) * LICENSING_TRIGGER_PERCENTAGE) / 100));
}
