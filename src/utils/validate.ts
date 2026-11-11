import { z } from 'zod';

export const emailSchema = z.string().email().max(320);
export const passwordSchema = z.string().min(8).max(128);
export const urlSchema = z.string().url().max(2048);
export const slugSchema = z.string().min(1).max(200);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
});

export const signupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  tos_accepted: z.literal(true),
  newsletter_opt_in: z.boolean().default(false),
});

export const otpSchema = z.object({
  code: z.string().length(6),
});

export const onboardingStep1Schema = z.object({
  account_type: z.enum(['freelancer', 'agency']),
});

export const onboardingStep2Schema = z.object({
  name: z.string().min(1).max(200),
  business_name: z.string().max(200).optional().nullable(),
  services: z.array(z.string()).default([]),
  volume_per_month: z.string().max(20).optional().nullable(),
  website: z.string().max(2048).optional().nullable(),
  fiverr_profile: z.string().max(2048).optional().nullable(),
  agency_name: z.string().max(200).optional().nullable(),
  agency_size: z.string().max(20).optional().nullable(),
  brand_primary: z.string().max(20).optional().nullable(),
  brand_secondary: z.string().max(20).optional().nullable(),
});

export const onboardingStep4Schema = z.object({
  tos_accepted: z.literal(true),
  newsletter_opt_in: z.boolean().default(false),
});

export const onboardingStep5Schema = z.object({
  plan: z.enum(['free', 'waitlist']),
});

export const tutorialSchema = z.object({
  completed: z.boolean().optional(),
  skipped: z.boolean().optional(),
});
