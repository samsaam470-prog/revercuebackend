import { processDueJobs } from '../services/summary';
import { runRetention } from './retention';
import { runProofCleanup } from './pdf-cleanup';
import { cleanupRateLimits } from '../services/rate-limit';
import type { Bindings } from '../types';

export async function runHourly(env: Bindings): Promise<void> {
  try { await processDueJobs(env); } catch (err) { console.error('SUMMARY_CRON_ERROR', err); }
  try { await runRetention(env); } catch (err) { console.error('RETENTION_CRON_ERROR', err); }
  try { await runProofCleanup(env); } catch (err) { console.error('PROOF_CLEANUP_ERROR', err); }
  try { await cleanupRateLimits(env); } catch (err) { console.error('RATELIMIT_CLEANUP_ERROR', err); }
}
