import type { Bindings } from '../types';

// --- FormSubmit (the notifications, the non-urgent) ---
export async function sendFormSubmitEmail(
  env: Bindings,
  toEmail: string,
  subject: string,
  fields: Record<string, string>
): Promise<boolean> {
  const url = `https://formsubmit.co/ajax/${encodeURIComponent(toEmail)}`;
  const body: Record<string, any> = {
    _subject: subject,
    _captcha: 'false',
    _template: 'basic',
    ...fields,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error('FORMSUBMIT_ERROR', res.status, await res.text());
    return res.ok;
  } catch (err: any) {
    console.error('FORMSUBMIT_FETCH_ERROR', err.message);
    return false;
  }
}

// --- Cooper Email (primary) ---
export async function sendCooperEmail(
  env: Bindings,
  toEmail: string,
  subject: string,
  text: string,
  html?: string
): Promise<boolean> {
  if (!env.COOPER_API_KEY || !env.COOPER_INBOX_ID) {
    console.error('COOPER_CONFIG_MISSING');
    return false;
  }
  try {
    const res = await fetch(`https://cooperemail.com/api/v1/inboxes/${env.COOPER_INBOX_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.COOPER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: [toEmail],
        subject,
        text,
        html: html ?? `<p>${text}</p>`,
      }),
    });
    if (!res.ok) console.error('COOPER_ERROR', res.status, await res.text());
    return res.ok;
  } catch (err: any) {
    console.error('COOPER_FETCH_ERROR', err.message);
    return false;
  }
}

// --- OpenMail (fallback) ---
export async function sendOpenMailEmail(
  env: Bindings,
  toEmail: string,
  subject: string,
  text: string,
  html?: string
): Promise<boolean> {
  if (!env.OPENMAIL_API_KEY || !env.OPENMAIL_INBOX_ID) {
    console.error('OPENMAIL_CONFIG_MISSING');
    return false;
  }
  try {
    const res = await fetch(`https://api.openmail.sh/v1/inboxes/${env.OPENMAIL_INBOX_ID}/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENMAIL_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        to: toEmail,
        subject,
        body: text,
        ...(html ? { html } : {}),
      }),
    });
    if (!res.ok) console.error('OPENMAIL_ERROR', res.status, await res.text());
    return res.ok;
  } catch (err: any) {
    console.error('OPENMAIL_FETCH_ERROR', err.message);
    return false;
  }
}

// --- The transactional email (Cooper -> OpenMail -> FormSubmit) ---
export async function sendTransactionalEmail(
  env: Bindings,
  toEmail: string,
  subject: string,
  text: string,
  html?: string,
  fields?: Record<string, string>
): Promise<boolean> {
  const cooperOk = await sendCooperEmail(env, toEmail, subject, text, html);
  if (cooperOk) return true;

  console.warn('COOPER_FAILED_TRYING_OPENMAIL', toEmail);
  const openmailOk = await sendOpenMailEmail(env, toEmail, subject, text, html);
  if (openmailOk) return true;

  console.warn('OPENMAIL_FAILED_TRYING_FORMSUBMIT', toEmail);
  const formFields = fields ?? { 'Message': text };
  return await sendFormSubmitEmail(env, toEmail, subject, formFields);
}
