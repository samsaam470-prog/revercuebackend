/**
 * Turns a submitted form into a short, concrete project prompt.
 *
 * The form's own answers are the brief: they must reach the prompt, otherwise
 * every submission reads "Requirements: as described".
 */
export function generatePrompt(serviceType: string, answers: Record<string, any>): string {
  const client = String(answers.client_name ?? '').trim();
  const budget = String(answers.budget ?? '').trim();
  const deadline = String(answers.deadline ?? '').trim();
  const requirements = String(answers.requirements ?? '').trim();
  const service = serviceType || 'the project';

  const intro = client ? `I have a client, ${client}, who wants ${service}.` : `I have a client who wants ${service}.`;
  const facts = [
    budget ? `Budget: ${budget}.` : '',
    deadline ? `Deadline: ${deadline}.` : '',
  ].filter(Boolean);

  const brief = requirements || collectAnswers(answers);
  const requirementsLine = brief ? `What they told me: ${brief}` : '';

  return [
    intro,
    ...facts,
    requirementsLine,
    'Help me plan this project step by step: timeline, deliverables, risks, and the first 3 actions.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Every answered field that is not one of the prompt's own labels. */
function collectAnswers(answers: Record<string, any>): string {
  const skip = new Set(['client_name', 'budget', 'deadline', 'requirements', 'service_type', 'client_id']);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(answers)) {
    if (skip.has(key)) continue;
    const text = Array.isArray(value)
      ? value.map((item) => String(item).trim()).filter(Boolean).join(', ')
      : typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    if (text) parts.push(text);
  }
  return parts.join('; ');
}
