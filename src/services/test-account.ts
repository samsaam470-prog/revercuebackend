import { tursoQuery, tursoExecute } from '../utils/turso';
import { dbFirst, dbRun } from '../utils/db';
import { sha256Hex } from '../utils/crypto';
import { PLANS, type Plan } from '../config/constants';
import type { Bindings } from '../types';

/**
 * Test account for automated product review.
 *
 * A fixed, non-AuthAction account that an agent can sign in with, switch plans
 * on and inspect every product surface. It is deliberately separate from the
 * AuthAction flow: the credentials live here, the account is flagged, and
 * everything it owns can be deleted in one call.
 *
 * `TEST_ACCOUNT_ENABLED=false` turns the whole feature off. It is on by
 * default because this is a review environment; retire it before launch.
 */

export const TEST_ACCOUNT_ID = 'usr_testagent0001';
export const TEST_ACCOUNT_DEFAULT_EMAIL = 'agent@revercue.test';
export const TEST_ACCOUNT_DEFAULT_PASSWORD = 'ReviewAgent2026!';
export const TEST_ACCOUNT_NAME = 'Revercue Review Agent';
export const TEST_ACCOUNT_BUSINESS = 'Revercue QA Studio';

export type TestAccountPlan = Plan;

export interface TestAccountUser {
  id: string;
  email: string;
  plan: string;
  name?: string | null;
  business_name?: string | null;
  onboarding_step?: number | null;
}

export class TestAccountError extends Error {
  status: 400 | 401 | 404 | 409 | 503;
  code: string;
  constructor(status: TestAccountError['status'], code: string, message: string) {
    super(message);
    this.name = 'TestAccountError';
    this.status = status;
    this.code = code;
  }
}

export function isTestAccountEnabled(env: Bindings): boolean {
  return String(env.TEST_ACCOUNT_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function testAccountLoginEmail(env: Bindings): string {
  return (env.TEST_ACCOUNT_EMAIL ?? '').trim().toLowerCase() || TEST_ACCOUNT_DEFAULT_EMAIL;
}

export function testAccountPassword(env: Bindings): string {
  return (env.TEST_ACCOUNT_PASSWORD ?? '').trim() || TEST_ACCOUNT_DEFAULT_PASSWORD;
}

export function isPlan(value: unknown): value is TestAccountPlan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

export async function getTestAccount(env: Bindings): Promise<TestAccountUser | null> {
  const result = await tursoQuery(
    env,
    `SELECT id, email, plan, name, business_name, onboarding_step FROM users WHERE id = ? LIMIT 1`,
    [TEST_ACCOUNT_ID]
  );
  return (result.rows[0] as TestAccountUser) ?? null;
}

/**
 * Creates the fixed test user, or updates the address/plan of the existing one.
 * Onboarding is marked complete so the account lands on the dashboard.
 */
export async function ensureTestAccount(
  env: Bindings,
  input: { email?: string; plan?: TestAccountPlan } = {}
): Promise<TestAccountUser> {
  const email = (input.email ?? testAccountLoginEmail(env)).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TestAccountError(400, 'invalid_email', 'Enter a valid email address.');
  }
  const plan = input.plan ?? 'growth';
  if (!isPlan(plan)) {
    throw new TestAccountError(400, 'invalid_plan', 'Choose one of the supported plans.');
  }

  const now = new Date().toISOString();
  try {
    await tursoExecute(
      env,
      `INSERT INTO users (id, email, plan, email_verified, onboarding_step, account_type, name, business_name, created_at, updated_at)
       VALUES (?, ?, ?, 1, 6, 'agency', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         plan = excluded.plan,
         email_verified = 1,
         onboarding_step = 6,
         name = excluded.name,
         business_name = excluded.business_name,
         updated_at = excluded.updated_at`,
      [TEST_ACCOUNT_ID, email, plan, TEST_ACCOUNT_NAME, TEST_ACCOUNT_BUSINESS, now, now]
    );
  } catch (error: any) {
    if (String(error?.message ?? '').toLowerCase().includes('unique')) {
      throw new TestAccountError(
        409,
        'email_in_use',
        'That email already belongs to another account. Use a different address for the test account.'
      );
    }
    throw error;
  }

  const user = await getTestAccount(env);
  if (!user) {
    throw new TestAccountError(503, 'test_account_unavailable', 'The test account could not be created.');
  }
  await syncTestSubscription(env, user.plan);
  return user;
}

/** Keeps the billing view consistent with the plan the test account is on. */
export async function syncTestSubscription(env: Bindings, plan: string): Promise<void> {
  try {
    await dbRun(env, `DELETE FROM subscriptions WHERE user_id = ?`, [TEST_ACCOUNT_ID]);
    if (plan === 'free') return;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 86400000);
    await dbRun(
      env,
      `INSERT INTO subscriptions (id, user_id, provider, whop_plan_id, plan_key, status, current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at)
       VALUES (?, ?, 'test', NULL, ?, 'active', ?, ?, 0, ?, ?)`,
      [
        'sub_testagent0001',
        TEST_ACCOUNT_ID,
        plan,
        now.toISOString(),
        periodEnd.toISOString(),
        now.toISOString(),
        now.toISOString(),
      ]
    );
  } catch (error) {
    console.error('TEST_ACCOUNT_SUBSCRIPTION_SYNC_FAILED', error);
  }
}

/* -------------------------------------------------------------------------- */
/* Sample environment                                                         */
/* -------------------------------------------------------------------------- */

const CLIENT_IDS = ['tstcli_northwind', 'tstcli_lumen', 'tstcli_harbor', 'tstcli_fern'];
const PROPOSAL_IDS = ['tstprop_website', 'tstprop_brand', 'tstprop_retainer'];
const CONTRACT_IDS = ['tstcontract_website', 'tstcontract_retainer'];
const FORM_IDS = ['tstform_brief', 'tstform_onboarding'];
const INVOICE_IDS = ['tstinv_deposit', 'tstinv_retainer'];

const OWNED_DOC_IDS = `SELECT id FROM proposals WHERE user_id = ?
  UNION SELECT id FROM contracts WHERE user_id = ?
  UNION SELECT id FROM forms WHERE user_id = ?
  UNION SELECT id FROM invoices WHERE user_id = ?`;

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function dateDaysFromNow(days: number): string {
  return isoDaysFromNow(days).slice(0, 10);
}

export interface SeedSummary {
  skipped: boolean;
  clients: number;
  proposals: number;
  contracts: number;
  forms: number;
  invoices: number;
  notifications: number;
  warnings: string[];
}

async function attempt(warnings: string[], label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error: any) {
    const message = String(error?.message ?? error);
    warnings.push(`${label}: ${message}`);
    console.error('TEST_ACCOUNT_SEED_STEP_FAILED', label, message);
  }
}

export async function seedTestEnvironment(
  env: Bindings,
  options: { force?: boolean } = {}
): Promise<SeedSummary> {
  const warnings: string[] = [];
  const existing = await dbFirst<{ c: number }>(
    env,
    `SELECT COUNT(*) as c FROM proposals WHERE user_id = ?`,
    [TEST_ACCOUNT_ID]
  ).catch(() => null);
  const alreadySeeded = Number(existing?.c ?? 0) > 0;

  if (alreadySeeded && !options.force) {
    return {
      skipped: true,
      clients: CLIENT_IDS.length,
      proposals: PROPOSAL_IDS.length,
      contracts: CONTRACT_IDS.length,
      forms: FORM_IDS.length,
      invoices: INVOICE_IDS.length,
      notifications: 0,
      warnings,
    };
  }

  if (alreadySeeded) await clearTestProductData(env);

  const now = new Date().toISOString();

  /* Clients -------------------------------------------------------------- */
  const clients: [string, string, string, string, string, string, string, number][] = [
    ['tstcli_northwind', 'Amelia North', 'amelia@northwindstudio.co', 'Northwind Studio', 'Design', 'Independent design studio', 'https://northwindstudio.co', 82],
    ['tstcli_lumen', 'Jonas Reed', 'jonas@lumenlabs.io', 'Lumen Labs', 'SaaS', 'B2B analytics platform', 'https://lumenlabs.io', 64],
    ['tstcli_harbor', 'Priya Shah', 'priya@harborandco.com', 'Harbor & Co', 'Consulting', 'Strategy consultancy', 'https://harborandco.com', 47],
    ['tstcli_fern', 'Owen Clarke', 'owen@fernhouse.uk', 'Fern House', 'Hospitality', 'Boutique hotel group', 'https://fernhouse.uk', 30],
  ];
  for (const [id, name, email, company, industry, audience, website, interest] of clients) {
    await dbRun(
      env,
      `INSERT INTO clients (id, user_id, name, email, company, phone, channel, industry, target_audience, website_url, source, status, interest_level, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'email', ?, ?, ?, 'manual', 'active', ?, ?, ?, ?)`,
      [id, TEST_ACCOUNT_ID, name, email, company, industry, audience, website, interest, now, now]
    );
  }

  /* Proposals ------------------------------------------------------------ */
  const websiteContent = {
    problem: 'Northwind needs a site that turns portfolio visits into enquiries.',
    industry: 'Design',
    service: 'Website design and build',
    business_name: TEST_ACCOUNT_BUSINESS,
    client_website: 'https://northwindstudio.co',
    sections: ['The problem', 'What we will build', 'How we will work', 'Investment'],
    packages: [
      { name: 'Essential', price: 3200, description: 'Five-page marketing site, CMS, analytics.' },
      { name: 'Signature', price: 5400, description: 'Eight pages, art direction, motion, CMS.' },
    ],
    currency: 'GBP',
    timeline: '6 weeks',
    tone: 'Warm, direct, no jargon',
    target_audience: 'Independent studios and small product teams',
    call_to_action: 'Book a 20 minute kickoff call',
    drafted: true,
    faqs: [
      { question: 'Who writes the copy?', answer: 'We draft it with you in two working sessions.' },
      { question: 'What happens after launch?', answer: 'Thirty days of fixes and a handover walkthrough.' },
    ],
    blocks: [
      { id: 'tstblk_nw_1', type: 'heading', text: 'A website that sells the work you already do', level: 'h1', align: 'left' },
      { id: 'tstblk_nw_2', type: 'paragraph', text: 'Northwind wins work through referrals. The site should make that trust portable: clear proof, clear offer, one obvious next step.' },
      { id: 'tstblk_nw_3', type: 'pricing_table', items: [{ label: 'Essential', value: 'Five-page site', price: 3200 }, { label: 'Signature', value: 'Eight pages + motion', price: 5400 }] },
      { id: 'tstblk_nw_4', type: 'faq', faqs: [{ question: 'Who writes the copy?', answer: 'We draft it with you in two working sessions.' }] },
      { id: 'tstblk_nw_5', type: 'button', text: 'Start the project', url: 'https://revercue.co.uk' },
    ],
  };

  const brandContent = {
    problem: 'Lumen is launching a second product and the brand reads as one company with two voices.',
    industry: 'SaaS',
    service: 'Brand system',
    business_name: TEST_ACCOUNT_BUSINESS,
    sections: ['Where the brand is today', 'The system', 'Rollout'],
    packages: [{ name: 'Brand sprint', price: 4800, description: 'Two week sprint, naming and visual system.' }],
    currency: 'GBP',
    timeline: '3 weeks',
    tone: 'Confident, plain',
    target_audience: 'Product marketing leads',
    call_to_action: 'Reserve a sprint slot',
    drafted: true,
    blocks: [
      { id: 'tstblk_lm_1', type: 'heading', text: 'One brand, two products, no confusion', level: 'h1', align: 'left' },
      { id: 'tstblk_lm_2', type: 'paragraph', text: 'We will define the shared idea first, then let each product carry its own name without inventing a new look.' },
    ],
  };

  const retainerContent = {
    problem: 'Harbor needs consistent design capacity without hiring a full time designer.',
    industry: 'Consulting',
    service: 'Design retainer',
    business_name: TEST_ACCOUNT_BUSINESS,
    sections: ['The work', 'How the month runs', 'What it costs'],
    packages: [{ name: 'Monthly retainer', price: 2400, description: 'Two active requests at a time, weekly review.' }],
    currency: 'GBP',
    timeline: 'Ongoing, monthly',
    tone: 'Practical',
    target_audience: 'Partners at small consultancies',
    call_to_action: 'Book a review call',
    drafted: true,
    blocks: [
      { id: 'tstblk_hb_1', type: 'heading', text: 'Design capacity that fits a consultancy', level: 'h1', align: 'left' },
      { id: 'tstblk_hb_2', type: 'paragraph', text: 'A queue, a weekly review and a single point of contact. No timesheets, no surprise invoices.' },
    ],
  };

  const proposals: Array<[string, string, string, any, string, string | null, string | null]> = [
    ['tstprop_website', 'tstcli_northwind', 'Northwind Studio — website redesign', websiteContent, 'published', 'TstProposalNorthwind01', isoDaysFromNow(-9)],
    ['tstprop_brand', 'tstcli_lumen', 'Lumen Labs — brand system sprint', brandContent, 'published', 'TstProposalLumen01', isoDaysFromNow(-4)],
    ['tstprop_retainer', 'tstcli_harbor', 'Harbor & Co — design retainer', retainerContent, 'draft', null, null],
  ];
  for (const [id, clientId, title, content, status, publicId, publishedAt] of proposals) {
    await dbRun(
      env,
      `INSERT INTO proposals (id, user_id, client_id, title, content, status, public_id, published_at, total_time_spent_seconds, password_protected, draft_created_at, draft_retention_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 30, ?, ?)`,
      [
        id,
        TEST_ACCOUNT_ID,
        clientId,
        title,
        JSON.stringify(content),
        status,
        publicId,
        publishedAt,
        status === 'published' ? 412 : 0,
        now,
        now,
        now,
      ]
    );
  }

  /* Contracts ------------------------------------------------------------ */
  const contractContent = {
    scope: 'Design and build of a five-page marketing website including CMS setup and analytics.',
    payment_terms: '40% on signature, 40% at design sign-off, 20% on launch.',
    timeline: 'Six weeks from kickoff.',
    revisions: 'Two rounds of revisions per page template.',
    cancellation: 'Either party may cancel with 14 days written notice; work completed is invoiced.',
    currency: 'GBP',
    sections: ['Scope', 'Payment terms', 'Timeline', 'Revisions', 'Cancellation'],
    drafted: true,
    blocks: [
      { id: 'tstblk_ct_1', type: 'heading', text: 'Website design and build agreement', level: 'h1', align: 'left' },
      { id: 'tstblk_ct_2', type: 'paragraph', text: 'This agreement covers the design and build of the Northwind Studio marketing website.' },
    ],
  };

  const retainerContract = {
    scope: 'Ongoing design support, two active requests at a time.',
    payment_terms: 'Monthly in advance, due on the first working day.',
    timeline: 'Rolling monthly, 30 days notice.',
    revisions: 'Unlimited within active requests.',
    cancellation: 'Thirty days written notice.',
    currency: 'GBP',
    sections: ['Scope', 'Payment terms', 'Timeline', 'Cancellation'],
    drafted: true,
  };

  const contractRows: Array<[string, string, string, any, string, string | null, string | null]> = [
    ['tstcontract_website', 'tstcli_northwind', 'Northwind Studio — website agreement', contractContent, 'awaiting_client_signature', 'TstContractNorthwind01', isoDaysFromNow(-6)],
    ['tstcontract_retainer', 'tstcli_harbor', 'Harbor & Co — retainer agreement', retainerContract, 'draft', null, null],
  ];
  for (const [id, clientId, title, content, signingStatus, publicId, publishedAt] of contractRows) {
    await dbRun(
      env,
      `INSERT INTO contracts (id, user_id, client_id, linked_proposal_id, title, content, after_approval, status, signing_status, public_id, published_at, draft_created_at, draft_retention_days, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'pdf_only', ?, ?, ?, ?, ?, 30, ?, ?)`,
      [
        id,
        TEST_ACCOUNT_ID,
        clientId,
        title,
        JSON.stringify(content),
        signedStatusToStatus(signingStatus),
        signingStatus,
        publicId,
        publishedAt,
        now,
        now,
        now,
      ]
    );
    const versionContent = JSON.stringify(content);
    await dbRun(
      env,
      `INSERT INTO contract_versions (id, contract_id, user_id, version_number, title, content, content_hash, status, created_at, locked_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 'draft', ?, NULL)`,
      [
        `tstver_${id}`,
        id,
        TEST_ACCOUNT_ID,
        title,
        versionContent,
        await sha256Hex(versionContent),
        now,
      ]
    ).catch((error) => {
      warnings.push(`contract version ${id}: ${String(error?.message ?? error)}`);
    });
  }

  /* Forms ---------------------------------------------------------------- */
  const briefQuestions = [
    { id: 'tstq_goal', text: 'What should this website achieve?', type: 'long_text', required: true },
    { id: 'tstq_pages', text: 'How many pages do you need?', type: 'dropdown', required: true, options: [{ code: '5', label: 'Five pages' }, { code: '8', label: 'Eight pages' }, { code: 'other', label: 'Something else' }] },
    { id: 'tstq_references', text: 'Sites you like', type: 'short_text', required: false },
    { id: 'tstq_assets', text: 'Upload your logo and any brand files', type: 'file_upload', required: false },
  ];
  const onboardingQuestions = [
    { id: 'tstq_contact', text: 'Who is the main contact for this project?', type: 'short_text', required: true },
    { id: 'tstq_access', text: 'Can you share analytics and domain access?', type: 'single_choice', required: true, options: [{ code: 'yes', label: 'Yes' }, { code: 'no', label: 'Not yet' }] },
    { id: 'tstq_notes', text: 'Anything else we should know?', type: 'long_text', required: false },
  ];

  const formRows: Array<[string, string, string, string, any[], string, string | null, string | null]> = [
    ['tstform_brief', 'tstcli_northwind', 'Website project brief', 'A short brief so the proposal is right the first time.', briefQuestions, 'published', 'TstFormBriefNorthwind01', isoDaysFromNow(-8)],
    ['tstform_onboarding', 'tstcli_harbor', 'Retainer onboarding', 'Everything needed to start the monthly retainer.', onboardingQuestions, 'published', 'TstFormOnboardingHarbor1', isoDaysFromNow(-3)],
  ];
  for (const [id, clientId, title, description, questions, status, publicId, publishedAt] of formRows) {
    await dbRun(
      env,
      `INSERT INTO forms (id, user_id, client_id, title, description, questions, branching, status, public_id, published_at, draft_created_at, draft_retention_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 30, ?, ?)`,
      [id, TEST_ACCOUNT_ID, clientId, title, description, JSON.stringify(questions), status, publicId, publishedAt, now, now, now]
    );
    await dbRun(
      env,
      `INSERT INTO form_settings (form_id, thank_you_config, page_mode, expiry_date, password_protected, created_at, updated_at)
       VALUES (?, ?, 'single', NULL, 0, ?, ?)`,
      [id, JSON.stringify({ heading: 'Thanks — that is everything we need.', body: 'We will reply within one working day.' }), now, now]
    ).catch((error) => {
      warnings.push(`form settings ${id}: ${String(error?.message ?? error)}`);
    });
  }

  /* Invoices ------------------------------------------------------------- */
  const depositItems = [
    { description: 'Website design — deposit', quantity: 1, unit_price: 1280 },
    { description: 'Content workshop', quantity: 1, unit_price: 320 },
  ];
  const retainerItems = [{ description: 'Design retainer — November', quantity: 1, unit_price: 2400 }];
  const paymentArrangement = {
    type: 'account',
    details: {
      bank_name: 'Test Bank',
      account_holder: 'Revercue QA Studio',
      account_number: '00000000',
      sort_code: '00-00-00',
      iban: 'GB00TEST00000000000000',
      swift: 'TESTGB2L',
    },
    allow_proof: true,
  };

  const invoiceRows: Array<[string, string, string, string, string, any[], number, number, string, string]> = [
    ['tstinv_deposit', 'tstcli_northwind', 'tstcontract_website', 'TST-2026-0001', 'published', depositItems, 0, 1600, dateDaysFromNow(14), 'TstInvoiceDepositNorth1'],
    ['tstinv_retainer', 'tstcli_harbor', 'tstcontract_retainer', 'TST-2026-0002', 'proof_submitted', retainerItems, 0, 2400, dateDaysFromNow(-2), 'TstInvoiceRetainerHarb1'],
  ];
  for (const [id, clientId, linkedContract, number, status, items, tax, total, dueDate, publicId] of invoiceRows) {
    await dbRun(
      env,
      `INSERT INTO invoices (id, user_id, client_id, linked_contract_id, invoice_number, line_items, currency, tax, total, payment_arrangement, due_date, notes, status, public_id, published_at, draft_created_at, draft_retention_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'GBP', ?, ?, ?, ?, 'Sample invoice created by the test environment.', ?, ?, ?, ?, 30, ?, ?)`,
      [
        id,
        TEST_ACCOUNT_ID,
        clientId,
        linkedContract,
        number,
        JSON.stringify(items),
        tax,
        total,
        JSON.stringify(paymentArrangement),
        dueDate,
        status,
        publicId,
        now,
        now,
        now,
        now,
      ]
    );
  }

  /* Activity, notes and preferences -------------------------------------- */
  const communication: Array<[string, string, string, string, string | null, string]> = [
    ['tstcomm_1', 'tstcli_northwind', 'message_sent', 'Sent the proposal and asked for a call this week.', 'tstprop_website', isoDaysFromNow(-9)],
    ['tstcomm_2', 'tstcli_northwind', 'reply_received', 'Amelia replied with two questions about scope.', 'tstprop_website', isoDaysFromNow(-7)],
    ['tstcomm_3', 'tstcli_northwind', 'follow_up', 'Chase the signed contract if it is not back by Friday.', 'tstcontract_website', isoDaysFromNow(-1)],
    ['tstcomm_4', 'tstcli_lumen', 'document_shared', 'Shared the brand sprint proposal.', 'tstprop_brand', isoDaysFromNow(-4)],
    ['tstcomm_5', 'tstcli_harbor', 'message_sent', 'Sent the retainer onboarding form.', 'tstform_onboarding', isoDaysFromNow(-3)],
    ['tstcomm_6', 'tstcli_fern', 'message_sent', 'Intro call booked for next Tuesday.', null, isoDaysFromNow(-2)],
  ];
  for (const [id, clientId, entryType, message, documentId, createdAt] of communication) {
    await dbRun(
      env,
      `INSERT INTO communication_log (id, user_id, client_id, entry_type, direction, channel, message_text, estimated_time, linked_document_type, linked_document_id, next_step, follow_up_date, created_at)
       VALUES (?, ?, ?, ?, 'outgoing', 'email', ?, NULL, ?, ?, NULL, ?, ?)`,
      [
        id,
        TEST_ACCOUNT_ID,
        clientId,
        entryType,
        message,
        documentId ? (documentId.startsWith('tstprop') ? 'proposal' : documentId.startsWith('tstcontract') ? 'contract' : 'form') : null,
        documentId,
        entryType === 'follow_up' ? isoDaysFromNow(0) : null,
        createdAt,
      ]
    );
  }

  let notifications = 0;
  const notificationRows: Array<[string, string, string, string | null, string]> = [
    ['tstntf_1', 'document_created', 'Proposal published: Northwind Studio — website redesign', 'tstprop_website', isoDaysFromNow(-9)],
    ['tstntf_2', 'contract_signed', 'Contract sent to Northwind Studio for signature', 'tstcontract_website', isoDaysFromNow(-6)],
    ['tstntf_3', 'invoice_viewed', 'Harbor & Co submitted payment proof', 'tstinv_retainer', isoDaysFromNow(-1)],
  ];
  for (const [id, eventType, title, documentId, createdAt] of notificationRows) {
    await attempt(warnings, `notification ${id}`, async () => {
      await tursoExecute(
        env,
        `INSERT INTO notifications (id, user_id, event_type, client_id, document_id, title, body, read, dismissed, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, 0, 0, ?)`,
        [id, TEST_ACCOUNT_ID, eventType, documentId, title, createdAt]
      );
      notifications += 1;
    });
  }

  await attempt(warnings, 'saved faqs', async () => {
    await dbRun(
      env,
      `INSERT INTO saved_faqs (id, user_id, question, answer, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ['tstfaq_1', TEST_ACCOUNT_ID, 'How long does a website take?', 'Six weeks from kickoff, including two revision rounds.', 'Timeline', now]
    );
    await dbRun(
      env,
      `INSERT INTO saved_faqs (id, user_id, question, answer, title, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ['tstfaq_2', TEST_ACCOUNT_ID, 'What do you need from me to start?', 'Brand files, analytics access and one decision maker.', 'Getting started', now]
    );
  });

  await attempt(warnings, 'saved packages', async () => {
    await dbRun(
      env,
      `INSERT INTO saved_packages (id, user_id, name, price, currency, deliverables, description, is_recommended, created_at) VALUES (?, ?, ?, ?, 'GBP', ?, ?, 1, ?)`,
      [
        'tstpkg_1',
        TEST_ACCOUNT_ID,
        'Website signature package',
        5400,
        JSON.stringify(['Eight pages', 'Art direction', 'CMS setup', 'Analytics']),
        'The complete marketing site build.',
        now,
      ]
    );
  });

  await attempt(warnings, 'revision prices', async () => {
    await dbRun(
      env,
      `INSERT INTO revision_prices (user_id, category, price, updated_at) VALUES (?, ?, ?, ?)`,
      [TEST_ACCOUNT_ID, 'Extra page', 180, now]
    );
    await dbRun(
      env,
      `INSERT INTO revision_prices (user_id, category, price, updated_at) VALUES (?, ?, ?, ?)`,
      [TEST_ACCOUNT_ID, 'Copy rewrite', 90, now]
    );
  });

  await syncTestSubscription(env, (await getTestAccount(env))?.plan ?? 'growth');

  return {
    skipped: false,
    clients: CLIENT_IDS.length,
    proposals: PROPOSAL_IDS.length,
    contracts: CONTRACT_IDS.length,
    forms: FORM_IDS.length,
    invoices: INVOICE_IDS.length,
    notifications,
    warnings,
  };
}

/** Contracts keep the legacy storage status separate from the signing status. */
function signedStatusToStatus(signingStatus: string): string {
  if (signingStatus === 'fully_signed') return 'approved';
  if (signingStatus === 'draft') return 'draft';
  return 'published';
}

/**
 * Removes every product row the test user owns. Each statement is isolated so a
 * table that does not exist on an older deployment cannot block the rest.
 */
export async function clearTestProductData(env: Bindings): Promise<string[]> {
  const warnings: string[] = [];
  const docScoped = [
    `DELETE FROM contract_signatures WHERE contract_id IN (SELECT id FROM contracts WHERE user_id = ?)`,
    `DELETE FROM contract_signing_events WHERE contract_id IN (SELECT id FROM contracts WHERE user_id = ?)`,
    `DELETE FROM contract_versions WHERE user_id = ?`,
    `DELETE FROM signed_documents WHERE document_id IN (${OWNED_DOC_IDS})`,
    `DELETE FROM document_access WHERE document_id IN (${OWNED_DOC_IDS})`,
    `DELETE FROM document_meta WHERE document_id IN (${OWNED_DOC_IDS})`,
    `DELETE FROM document_events WHERE visit_id IN (SELECT id FROM document_visits WHERE document_id IN (${OWNED_DOC_IDS}))`,
    `DELETE FROM document_visits WHERE document_id IN (${OWNED_DOC_IDS})`,
    `DELETE FROM form_settings WHERE form_id IN (SELECT id FROM forms WHERE user_id = ?)`,
    `DELETE FROM form_submissions WHERE user_id = ?`,
  ];
  for (const sql of docScoped) {
    await attempt(warnings, sql.slice(0, 60), async () => {
      await dbRun(env, sql, [TEST_ACCOUNT_ID, TEST_ACCOUNT_ID, TEST_ACCOUNT_ID, TEST_ACCOUNT_ID]);
    });
  }

  const userScoped = [
    'proposals',
    'contracts',
    'forms',
    'invoices',
    'clients',
    'communication_log',
    'saved_faqs',
    'saved_packages',
    'revision_prices',
    'file_uploads',
    'document_uploads',
    'document_archive',
    'retention_warnings',
    'retention_deliveries',
    'suggestion_dismissals',
    'subscriptions',
    'subscription_payments',
    'subscription_change_requests',
  ];
  for (const table of userScoped) {
    await attempt(warnings, table, async () => {
      await dbRun(env, `DELETE FROM ${table} WHERE user_id = ?`, [TEST_ACCOUNT_ID]);
    });
  }
  return warnings;
}

/**
 * Deletes the test account and everything tied to it. Called by the explicit
 * "delete test account" action, never by signup or login.
 */
export async function deleteTestAccount(env: Bindings): Promise<{ warnings: string[]; deleted: boolean }> {
  const warnings = await clearTestProductData(env);

  const tursoTables = [
    'notifications',
    'sessions',
    'payments',
    'payment_requests',
    'user_identities',
    'newsletter_subscribers',
    'announcement_views',
    'admin_notification_deliveries',
  ];
  for (const table of tursoTables) {
    await attempt(warnings, `turso:${table}`, async () => {
      await tursoExecute(env, `DELETE FROM ${table} WHERE user_id = ?`, [TEST_ACCOUNT_ID]);
    });
  }
  await attempt(warnings, 'turso:authaction_identities', async () => {
    await tursoExecute(env, `DELETE FROM authaction_identities WHERE linked_user_id = ?`, [TEST_ACCOUNT_ID]);
  });
  await attempt(warnings, 'turso:users', async () => {
    await tursoExecute(env, `DELETE FROM users WHERE id = ?`, [TEST_ACCOUNT_ID]);
  });

  const remaining = await getTestAccount(env).catch(() => null);
  return { warnings, deleted: !remaining };
}
