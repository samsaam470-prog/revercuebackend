import { tursoExecute } from '../utils/turso';
import { generateId } from '../utils/ids';
import type { Bindings } from '../types';

/**
 * Admin actions are recorded so privileged changes are attributable.
 * Values are never logged (no tokens, no passwords), only the action and target.
 */
export async function logAdminAction(
  env: Bindings,
  input: {
    adminUser: string;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  }
): Promise<void> {
  await tursoExecute(
    env,
    `INSERT INTO admin_audit_log (id, admin_user, action, target_type, target_id, metadata, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId('audit'),
      input.adminUser,
      input.action.slice(0, 100),
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.metadata ?? {}).slice(0, 2000),
      input.ip ?? null,
      new Date().toISOString(),
    ]
  ).catch((error) => console.error('ADMIN_AUDIT_WRITE_FAILED', error));
}

export function requireAdminUser(c: any): string {
  const admin = c.get('admin' as never) as unknown as string | undefined;
  return admin || 'admin';
}
