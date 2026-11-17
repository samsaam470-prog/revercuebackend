import { processDueJobs } from '../services/summary';
import { runRetention } from './retention';
import { runProofCleanup } from './pdf-cleanup';
import { cleanupRateLimits } from '../services/rate-limit';
import { retryFailedDeliveries } from '../services/email';
import { processDueSubmissions } from '../services/form-submissions';
import type { Bindings } from '../types';

/**
 * Hourly cron. Each job is isolated: one failing job never prevents the others
 * from running, and every failure is logged with enough context to diagnose it.
 */
export async function runHourly(env: Bindings): Promise<void> {
  try {
    await processDueJobs(env);
  } catch (error) {
    console.error('SUMMARY_CRON_ERROR', error);
  }

  try {
    await retryFailedDeliveries(env);
  } catch (error) {
    console.error('EMAIL_RETRY_CRON_ERROR', error);
  }

  try {
    const result = await processDueSubmissions(env);
    if (result.processed > 0) console.log('FORM_ENRICHMENT_CRON', JSON.stringify(result));
  } catch (error) {
    console.error('FORM_ENRICHMENT_CRON_ERROR', error);
  }

  try {
    await runRetention(env);
  } catch (error) {
    console.error('RETENTION_CRON_ERROR', error);
  }

  try {
    await runProofCleanup(env);
  } catch (error) {
    console.error('PROOF_CLEANUP_ERROR', error);
  }

  try {
    await cleanupRateLimits(env);
  } catch (error) {
    console.error('RATELIMIT_CLEANUP_ERROR', error);
  }
}
