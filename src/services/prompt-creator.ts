import type { Bindings } from '../types';

export function generatePrompt(serviceType: string, answers: Record<string, any>): string {
  const client = answers.client_name ?? 'the client';
  const budget = answers.budget ?? 'not specified';
  const deadline = answers.deadline ?? 'not specified';
  const requirements = answers.requirements ?? 'as described';
  const service = serviceType || 'the project';

  return `I have a client ${client} who wants ${service}. Budget: ${budget}. Deadline: ${deadline}. Requirements: ${requirements}. Help me plan this project step by step: timeline, deliverables, risks, and the first 3 actions.`;
}
