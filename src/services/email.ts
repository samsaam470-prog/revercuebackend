import type { Bindings } from '../types';

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
    return res.ok;
  } catch (err) {
    console.error('FormSubmit send failed:', err);
    return false;
  }
}
