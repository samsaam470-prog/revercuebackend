/**
 * Onboarding state is already represented by `users.onboarding_step`.
 *
 * The product uses steps 1, 2, 4 and 5; step 3 is a legacy route that the
 * frontend redirects to step 4. Step 6 means onboarding is complete. Legacy
 * accounts that stored 0 (or no value) are treated as complete, matching the
 * existing frontend guard (`step > 0 && step < 6`).
 */

const ONBOARDING_STEPS = [1, 2, 4, 5] as const;
export const ONBOARDING_COMPLETE_STEP = 6;

export interface OnboardingState {
  step: number;
  required: boolean;
  complete: boolean;
  next_step: number | null;
  destination: string;
}

export interface OnboardingUserLike {
  onboarding_step?: unknown;
}

export function normalizeOnboardingStep(value: unknown): number {
  const step = Number(value);
  if (!Number.isFinite(step) || step <= 0) return ONBOARDING_COMPLETE_STEP;
  return Math.trunc(step);
}

export function getOnboardingState(user: OnboardingUserLike): OnboardingState {
  const step = normalizeOnboardingStep(user.onboarding_step);
  const complete = step >= ONBOARDING_COMPLETE_STEP;
  const next = complete
    ? null
    : ONBOARDING_STEPS.find((candidate) => candidate >= step) ?? 5;
  return {
    step,
    required: !complete,
    complete,
    next_step: next,
    destination: complete || next === null ? '/dashboard' : `/onboarding/step-${next}`,
  };
}
