//
// Copy for the sections a template asks for beyond the core proposal intro and
// scope. Every sentence is assembled from what the author supplied, or it asks
// for the decision instead of inventing one. Commercial and legal specifics are
// marked in square brackets for the author to complete: nothing here claims to
// be jurisdiction-specific legal advice.
//

export interface SectionCopyContext {
  client: string;
  businessName: string;
  businessWebsite: string;
  businessDescription: string;
  industry: string;
  service: string;
  problem: string;
  audience: string;
  timeline: string;
  cta: string;
  scopeClause: string;
  deliverables: string[];
  packagesNote: string;
  documentType: 'proposal' | 'contract';
  templateName?: string;
}

function clean(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sentence(value: string): string {
  const text = clean(value).replace(/[.]+$/, '');
  if (!text) return '';
  return `${text}.`;
}

function list(values: string[]): string {
  const items = values.map((value) => clean(value).replace(/[.]+$/, '')).filter(Boolean);
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const subject = (c: SectionCopyContext) => c.service || c.industry || 'the work';

const authorLine = (c: SectionCopyContext) =>
  c.businessName
    ? `Prepared by ${c.businessName}${c.businessWebsite ? ` (${c.businessWebsite})` : ''}.`
    : '';

const clientName = (c: SectionCopyContext) => c.client || 'The client';

/**
 * A section writer returns the draft copy for one section key. A missing key
 * returns an empty string, so the document keeps its own placeholder instead of
 * receiving invented content.
 */
type Writer = (c: SectionCopyContext) => string;

const PROPOSAL_COPY: Record<string, Writer> = {
  executive_summary: (c) =>
    [
      `${clientName(c)}${c.industry ? ` operates in ${c.industry}` : ''}${c.service ? ` and is considering ${c.service}` : ''}.`,
      `This proposal sets out the recommended approach, the work included, the schedule and the investment.`,
      c.problem ? `The brief describes the starting point: ${sentence(c.problem)}` : '',
      c.businessName ? authorLine(c) : '',
      'Confirm the commercial details before sharing.',
    ]
      .filter(Boolean)
      .join(' '),

  client_background: (c) =>
    [
      `${clientName(c)}${c.industry ? ` works in ${c.industry}` : ''}.`,
      c.problem ? `The situation described in the brief is: ${sentence(c.problem)}` : 'Add what you know about the client, its market and the people involved.',
      c.audience ? `The work is aimed at ${c.audience.replace(/[.]+$/, '')}.` : '',
      c.businessDescription ? `The business website describes the provider as: ${sentence(c.businessDescription)}` : '',
      'Keep this section factual: use only what the client has told you or published.',
    ]
      .filter(Boolean)
      .join(' '),

  understanding_the_requirements: (c) =>
    [
      `The brief for ${clientName(c)} asks for ${subject(c)}.`,
      c.problem ? `The priority described is: ${sentence(c.problem)}` : '',
      c.audience ? `The audience for the work is ${c.audience.replace(/[.]+$/, '')}.` : '',
      c.scopeClause ? `The scope supplied is: ${sentence(c.scopeClause)}` : '',
      'Confirm the priorities, constraints and any deadlines that are missing before the work starts.',
    ]
      .filter(Boolean)
      .join(' '),

  objectives: (c) =>
    [
      `The engagement is intended to achieve the outcomes agreed with ${clientName(c)}.`,
      c.problem ? `It responds to this situation: ${sentence(c.problem)}` : 'Write each objective as a result the client wants, not as a task you will perform.',
      c.audience ? `Success is judged by the people the work is aimed at: ${c.audience.replace(/[.]+$/, '')}.` : '',
      'Add measurable targets where the client has supplied them; do not estimate them yourself.',
    ]
      .filter(Boolean)
      .join(' '),

  proposed_solution: (c) =>
    [
      `The recommendation is a ${subject(c)} engagement delivered in stages, with a review point before each new commitment.`,
      c.scopeClause ? `The agreed scope is: ${sentence(c.scopeClause)}` : '',
      c.deliverables.length ? `The outputs supplied are ${list(c.deliverables.slice(0, 4))}.` : '',
      'Explain why this approach fits the client’s situation, and name anything you have deliberately left out.',
    ]
      .filter(Boolean)
      .join(' '),

  methodology: (c) =>
    [
      `A typical delivery sequence for ${subject(c)} is: agree the brief, agree the plan, deliver in stages, then review and hand over.`,
      c.timeline ? `The timeline supplied is ${sentence(c.timeline)}` : '',
      'Confirm which review and approval points apply to this engagement, and who signs each one off.',
    ]
      .filter(Boolean)
      .join(' '),

  milestones: (c) =>
    [
      `Each milestone below is a point where ${clientName(c)} reviews progress and approves the next stage.`,
      c.timeline ? `The agreed timeline is ${sentence(c.timeline)}` : 'Add the dates and the approvals required at each milestone.',
    ]
      .filter(Boolean)
      .join(' '),

  team: (c) =>
    [
      c.businessName ? `The work will be delivered by ${c.businessName}.` : 'Name the business delivering the work.',
      'Add each person’s role, their responsibility for this engagement and their availability.',
      'Do not list credentials or experience you cannot evidence.',
    ].join(' '),

  experience: () =>
    [
      'Summarise only relevant, verifiable experience: sectors served, the type of work delivered, and outcomes the client can substantiate.',
      'Name former clients only where you have permission to do so.',
      'Leave this section out if there is no evidence to cite rather than inventing a case study.',
    ].join(' '),

  investment: (c) =>
    [
      `The investment for the scope described is set out below${c.packagesNote ? `: ${c.packagesNote}` : ''}.`,
      'State what each option includes, what is excluded, and whether taxes are included.',
      'Do not present an estimate as a fixed price unless the scope is fixed.',
    ]
      .filter(Boolean)
      .join(' '),

  pricing: (c) =>
    [
      'The figures below come from the details supplied for this proposal.',
      'Confirm the package contents, the currency and whether taxes are included before sharing.',
      c.packagesNote ? `Supplied options: ${c.packagesNote}.` : 'Add confirmed prices where they are missing.',
    ].join(' '),

  payment_terms: (c) =>
    [
      c.scopeClause && c.documentType === 'contract'
        ? 'Invoices are issued against the milestones in the scope.'
        : 'Invoices are issued at the points agreed with the client.',
      'Add the payment period, the currency, and the method, and state what happens if an invoice is paid late.',
    ].join(' '),

  assumptions: () =>
    [
      'This proposal assumes the client will provide timely access to the people, information and approvals needed to deliver the work.',
      'List each assumption that affects price, scope or dates so it can be confirmed before work starts.',
    ].join(' '),

  exclusions: () =>
    [
      'Work that is not described in the scope is excluded and would be quoted separately.',
      'List the specific exclusions the client might otherwise expect to be included.',
    ].join(' '),

  outcomes: (c) =>
    [
      `The expected outcomes are the changes ${clientName(c)} will see once the work is delivered.`,
      'Describe them in the client’s terms, and separate what this engagement will deliver from what depends on the client’s own actions.',
      'Remove any outcome you cannot reasonably attribute to this work.',
    ].join(' '),

  approval: (c) =>
    [
      `${clientName(c)} can approve this proposal using the approval step in this document.`,
      'State who is authorised to approve on the client side and what happens after approval.',
    ].join(' '),

  about: (c) =>
    [
      c.businessName ? `${c.businessName}${c.businessWebsite ? ` (${c.businessWebsite})` : ''} is the business delivering this work.` : 'Add the business delivering this work.',
      c.businessDescription ? `Its website describes its work as: ${sentence(c.businessDescription)}` : '',
      'Keep this factual and short: what the business does, who it serves and how it works.',
    ]
      .filter(Boolean)
      .join(' '),

  risks: () =>
    [
      'The principal risks for this engagement are dependencies on client input, changes to scope, and availability of the people involved.',
      'Add the risks specific to this project, their likelihood, and the mitigation you propose.',
    ].join(' '),

  governance: (c) =>
    [
      `A named contact at ${clientName(c)} and at the provider will own decisions for this engagement.`,
      'Agree the meeting rhythm, the escalation route and who can approve scope or budget changes.',
    ].join(' '),

  governance_model: (c) =>
    [
      `The operating model names a decision-maker at ${clientName(c)} and a delivery lead for ${subject(c)}.`,
      'Set the meeting rhythm, the reporting line and the escalation route, and say who can approve a change.',
    ].join(' '),

  support: () =>
    [
      'Support after delivery covers the items listed in this section.',
      'State the support hours, the response expectation and what is excluded, so both sides know what “support” means.',
    ].join(' '),

  reporting: () =>
    [
      'Reporting keeps the client informed without requiring them to chase.',
      'Agree what is reported, how often, in what format, and who receives it.',
    ].join(' '),

  implementation: (c) =>
    [
      `Implementation is sequenced so ${clientName(c)} can review each stage before the next begins.`,
      'Add the stages, the dependencies, and what must be in place before the first stage starts.',
    ].join(' '),

  training: (c) =>
    [
      `Training is provided for the people at ${clientName(c)} who will use or maintain the work.`,
      'State who is trained, on what, in what format and how competence is confirmed.',
    ].join(' '),

  audit: () =>
    [
      'This section records what was reviewed, what was found and what is recommended.',
      'Separate observed facts from recommendations, and state any limitation on the review.',
    ].join(' '),

  research_questions: (c) =>
    [
      `The study will answer the questions ${clientName(c)} needs in order to decide.`,
      'Write each question so it can be answered with evidence, and say what is out of scope.',
    ].join(' '),

  discovery_questions: () =>
    [
      'The planning work starts with the questions that have to be settled before a plan can be agreed.',
      'List each question with the decision it informs and who needs to answer it.',
    ].join(' '),

  budget: (c) =>
    [
      'The budget is shown by the lines supplied for this proposal.',
      'Confirm what the budget covers, what it excludes, and whether it includes taxes and expenses.',
    ].join(' '),

  market_context: (c) =>
    [
      `This section sets out the market context for ${subject(c)}.`,
      'Use published or client-supplied evidence, cite where it came from, and keep it separate from claims about the client.',
    ].join(' '),

  partnership_value: (c) =>
    [
      `The partnership is intended to create value for both ${clientName(c)} and ${c.businessName || 'the other party'}.`,
      'State what each side contributes and what each side gains, without overstating either.',
    ].join(' '),

  partnership_structure: () =>
    [
      'The structure below describes how the partnership would be owned, operated and governed.',
      'Confirm the legal form, the ownership split, the decision rights and the exit route with advisers before signing.',
    ].join(' '),

  roles_and_responsibilities: () =>
    [
      'This section records what each party contributes and who decides what.',
      'Assign every material responsibility to a named party, and flag anything that remains unallocated.',
    ].join(' '),

  commercial_terms: () =>
    [
      'The commercial terms set out how revenue, costs and any shared investment are handled.',
      'Complete the percentages and payment mechanics, and confirm the treatment of tax.',
    ].join(' '),

  term_and_review: () =>
    [
      'The arrangement has an initial term, a review point and an agreed way to end it.',
      'Set the dates, the review cadence and the notice each party must give.',
    ].join(' '),

  approval_and_signatures: () =>
    [
      'Approval records the client’s decision to proceed on the terms in this proposal.',
      'Add the authorised signatories, their titles and the date of approval.',
    ].join(' '),

  recommended_strategy: (c) =>
    [
      `The recommended strategy for ${clientName(c)} focuses on ${subject(c)}.`,
      c.problem ? `It addresses this situation: ${sentence(c.problem)}` : '',
      'Explain the reasoning, the alternatives considered and why this route is preferred.',
    ]
      .filter(Boolean)
      .join(' '),

  strategic_priorities: (c) =>
    [
      `The planning work is organised around the priorities ${clientName(c)} has identified.`,
      'List the priorities in the client’s words, and note where they conflict so the plan can resolve them.',
    ].join(' '),

  current_position: (c) =>
    [
      `This section records where ${clientName(c)} is now, using the information supplied.`,
      'Separate what is known from what still needs to be verified, and do not fill gaps with assumptions.',
    ].join(' '),

  workshop_programme: () =>
    [
      'The workshop programme sets out who attends each session and what it must produce.',
      'Add dates, participants, pre-work and the decision each workshop is expected to reach.',
    ].join(' '),

  growth_opportunity: (c) =>
    [
      `The commercial opportunity identified for ${clientName(c)} is described below.`,
      c.problem ? `The brief describes the starting point: ${sentence(c.problem)}` : '',
      'Support the opportunity with evidence, and state the assumptions behind any forecast.',
    ]
      .filter(Boolean)
      .join(' '),

  success_criteria: (c) =>
    [
      `The engagement will be judged against criteria agreed with ${clientName(c)} before work starts.`,
      'Make each criterion observable, assign an owner and state when it will be measured.',
    ].join(' '),

  channels: () =>
    [
      'This section sets out the channels proposed, the role each one plays and the effort involved.',
      'Explain why each channel fits the audience, and what will be measured.',
    ].join(' '),

  community_and_engagement: () =>
    [
      'Replies, comments and direct messages are handled within the response expectations agreed with the client.',
      'Agree the tone, the escalation route and what the team will not answer without approval.',
    ].join(' '),

  content_plan: () =>
    [
      'The content plan sets the themes, formats and publishing rhythm for the programme.',
      'Add the owners, approval steps and the number of pieces included each month.',
    ].join(' '),

  editorial_process: () =>
    [
      'Every piece moves from brief to draft to approval before publication.',
      'State who writes, who edits and who signs off, and the turnaround expected at each step.',
    ].join(' '),

  campaign_plan: () =>
    [
      'The campaign plan sequences activity against the agreed dates and budget.',
      'Add the launch date, the review points and the decision that ends or extends the campaign.',
    ].join(' '),

  creative_direction: () =>
    [
      'The creative direction describes the visual and verbal territory proposed for this work.',
      'Show the references and the reasoning, and state what the client must approve before production.',
    ].join(' '),

  seo_findings: (c) =>
    [
      `The findings below come from the review of ${clientName(c)}’s search presence.`,
      'Separate technical issues from content issues, and state the evidence for each finding.',
      'Do not promise rankings or traffic figures that cannot be supported.',
    ].join(' '),

  technical_approach: (c) =>
    [
      `The technical approach for ${subject(c)} is described below, together with the standards and constraints that apply.`,
      'Name the platforms, integrations and environments, and flag anything that depends on a third party.',
    ].join(' '),

  architecture_and_stack: () =>
    [
      'This section records the proposed architecture, the stack and the constraints it must work within.',
      'Confirm hosting, data residency and any existing systems the work must integrate with.',
    ].join(' '),

  integration_plan: () =>
    [
      'The integration plan names the systems involved, the data that moves between them and the owner of each connection.',
      'Add the test approach, the rollback plan and the sequence of cutover.',
    ].join(' '),

  data_and_reporting: () =>
    [
      'The data collected, the reports produced and the people who receive them are set out below.',
      'Agree the definitions behind each measure so the numbers mean the same thing to both sides.',
    ].join(' '),

  saas_phases: () =>
    [
      'The rollout is phased so each group of users can be supported properly.',
      'Add the users in each phase, the configuration required and the go-live criteria.',
    ].join(' '),

  app_platforms: () =>
    [
      'This section records the platforms and devices the application will support.',
      'State the minimum versions, the devices tested and what happens on unsupported devices.',
    ].join(' '),

  qa_plan: () =>
    [
      'Quality is checked before anything is handed over: functional testing, review on real devices and a documented sign-off.',
      'Add the acceptance tests, who runs them and what counts as a defect.',
    ].join(' '),

  ai_opportunities: (c) =>
    [
      `The processes where automation is likely to help ${clientName(c)} are assessed below.`,
      'For each opportunity, state the current process, the proposed change, the data required and how the result will be checked.',
      'Do not claim accuracy or savings that have not been measured.',
    ].join(' '),

  it_roadmap: (c) =>
    [
      `The roadmap sequences the IT work ${clientName(c)} needs, in an order that keeps the business running.`,
      'Add the dependencies, the decisions required and the owner for each phase.',
    ].join(' '),

  security: () =>
    [
      'This section records the security requirements and the controls in scope.',
      'Name the standards being applied, the responsibilities of each party, and the assumptions about the client’s environment.',
    ].join(' '),

  compliance: (c) =>
    [
      `The legal and regulatory obligations that apply to this work for ${clientName(c)} are listed below.`,
      'Confirm the jurisdictions and regimes that apply; this section is a drafting aid, not legal advice.',
    ].join(' '),

  logistics: () =>
    [
      'This section records the venue, suppliers, scheduling and on-the-day responsibilities.',
      'Assign an owner to each item and note the deadline for confirming it.',
    ].join(' '),

  staffing: () =>
    [
      'The roles required to deliver the work are listed below, with how each is covered.',
      'Confirm who supplies each role and what happens if someone becomes unavailable.',
    ].join(' '),

  event_brief: (c) =>
    [
      `The event is being planned for ${clientName(c)}.`,
      'State the purpose, the audience, the date and the measures that will define success.',
    ].join(' '),

  event_flow: () =>
    [
      'The run of show sets out what happens, when, and who is responsible at each point.',
      'Add the setup and breakdown windows, the speaker timings and the contingency if the schedule slips.',
    ].join(' '),

  maintenance: () =>
    [
      'Maintenance covers the routine checks, updates and fixes listed in this section.',
      'State the response expectation, the planned maintenance windows and what is excluded.',
    ].join(' '),

  warranty: () =>
    [
      'The warranty covers defects in the work delivered under this engagement.',
      'State the warranty period, what it covers, what it excludes and how a claim is made.',
    ].join(' '),

  warranty_period: () =>
    [
      'The warranty period starts on acceptance and covers defects that appear in normal use.',
      'State the period, the remedy offered and the exclusions, including misuse and third-party changes.',
    ].join(' '),

  site_survey: () =>
    [
      'The site survey records the conditions observed before work is priced or scheduled.',
      'Add the date of the survey, who attended, the access constraints and any condition that affects the work.',
    ].join(' '),

  materials: () =>
    [
      'The materials and finishes specified for this project are listed below.',
      'Confirm availability and lead times, and state how substitutions will be agreed.',
    ].join(' '),

  safety: () =>
    [
      'Safety responsibilities on site are shared between the client, the contractor and anyone else working there.',
      'State the standards applied, the responsible person, and the method for reporting an incident.',
    ].join(' '),

  programme: () =>
    [
      'The programme sets out the sequence of work and the dates agreed with the client.',
      'Add the start date, the key stages, the dependencies and the completion date.',
    ].join(' '),

  engineering_approach: (c) =>
    [
      `The engineering approach for ${subject(c)} is described below, including the standards and calculations that govern it.`,
      'Name the codes or standards applied and the assumptions behind the design.',
    ].join(' '),

  curriculum: () =>
    [
      'The curriculum sets out the modules, their order and the time allocated to each.',
      'Add the learning objective for each module and the materials participants receive.',
    ].join(' '),

  assessment: () =>
    [
      'Assessment confirms whether participants can apply what they have learned.',
      'State the method, who assesses, and what happens if someone does not meet the standard.',
    ].join(' '),

  training_outcomes: (c) =>
    [
      `The programme is designed so participants at ${clientName(c)} can do the tasks listed below unaided.`,
      'Write each outcome as something observable, not as a topic that will be covered.',
    ].join(' '),

  candidate_profile: (c) =>
    [
      `The search is for a candidate who can deliver the role ${clientName(c)} has described.`,
      'Separate essential requirements from desirable ones, and confirm the salary range and location.',
    ].join(' '),

  recruitment_process: () =>
    [
      'The process runs from role briefing through search, screening, interview and offer.',
      'Add the stages, the timescales and who on the client side is involved at each one.',
    ].join(' '),

  replacement_guarantee: () =>
    [
      'The replacement arrangement applies if a placement ends within the agreed period.',
      'State the period, the conditions and what is and is not refundable. Confirm the position locally before offering it.',
    ].join(' '),

  services_in_scope: (c) =>
    [
      `The services provided to ${clientName(c)} are listed below.`,
      'State precisely where each process starts and ends, and name the activities that remain with the client.',
    ].join(' '),

  transition_plan: (c) =>
    [
      `The transition moves ${subject(c)} from the current arrangement to the new service without interrupting the work.`,
      'Add the stages, the data and knowledge transfer, and the point at which responsibility passes.',
    ].join(' '),

  bpo_governance: () =>
    [
      'Governance sets how performance is reviewed, how issues are escalated and how changes are agreed.',
      'Add the meeting rhythm, the reporting pack and the escalation timescales.',
    ].join(' '),

  property_portfolio: (c) =>
    [
      `The properties managed for ${clientName(c)} are listed below.`,
      'Confirm the address, tenure, occupancy and any property-specific obligations for each one.',
    ].join(' '),

  management_scope: () =>
    [
      'The management services covered by this appointment are listed below.',
      'State what the manager does, what the owner retains, and where the boundary sits.',
    ].join(' '),

  financial_analysis: (c) =>
    [
      `The analysis for ${clientName(c)} is based on the financial information supplied for this engagement.`,
      'State the periods covered, the assumptions made and any information that was unavailable.',
      'Do not present an estimate as an audited figure.',
    ].join(' '),

  funding: (c) =>
    [
      `This section records the funding requirement for ${clientName(c)} and what it will be used for.`,
      'Set out the amount, the use of funds, the proposed structure and the repayment or return expectations.',
    ].join(' '),

  recruitment_fees: () =>
    [
      'The fee is calculated on the agreed basis and becomes payable at the point stated in this proposal.',
      'Complete the percentage or fixed fee, the salary definition and the invoicing trigger.',
    ].join(' '),

  management_fees: () =>
    [
      'The management fee is payable for the services in scope and is invoiced on the agreed cycle.',
      'State the fee basis, what it includes and which costs are rechargeable.',
    ].join(' '),

  workstreams: (c) =>
    [
      `The engagement is organised into the workstreams below, each with an owner and an output.`,
      'Add the sequence, the dependencies and how progress is reported between workstreams.',
    ].join(' '),

  typical_tasks: () =>
    [
      'The tasks normally covered are listed below.',
      'Confirm anything that falls outside them, and agree how additional work is requested and charged.',
    ].join(' '),

  working_hours: () =>
    [
      'Availability and working hours are agreed in advance so expectations are clear.',
      'State the hours, the time zone, the response expectation and how agreed overtime is handled.',
    ].join(' '),

  usage_and_licensing: () =>
    [
      'The licence below sets out where the work may be used, for how long and by whom.',
      'Confirm the media, the territory, the duration and whether exclusivity is included.',
    ].join(' '),

  review_and_revisions: (c) =>
    [
      `The fee includes the revision rounds stated below for ${clientName(c)}.`,
      'Define what counts as a revision, how feedback is consolidated, and how additional rounds are charged.',
    ].join(' '),

  design_process: () =>
    [
      'The design process runs from research and structure through design, review and handover.',
      'Add the artefacts produced at each stage and who approves them.',
    ].join(' '),

  production_approach: () =>
    [
      'The production runs through planning, shooting, editing and delivery.',
      'Add the crew, the equipment, the shoot days and the review points included in the fee.',
    ].join(' '),

  kpi: (c) =>
    [
      `The measures below are how ${clientName(c)} will judge whether the work is succeeding.`,
      'Define each measure, the baseline it will be compared with and how often it is reported.',
      'Do not set a target that has not been agreed with the client.',
    ].join(' '),

  revisions: (c) =>
    [
      `The fee includes the revision rounds stated below for ${clientName(c)}.`,
      'Define what counts as a revision, how feedback is consolidated, and how additional rounds are charged.',
    ].join(' '),

  legal_review: () =>
    [
      'This agreement is a drafting aid, not legal advice. Have it reviewed by a qualified lawyer in the governing jurisdiction before it is signed.',
      'Confirm the governing law, the mandatory local requirements and any registration or filing that applies.',
    ].join(' '),

  quality_assurance: () =>
    [
      'Quality is checked at agreed points before anything is handed over.',
      'State the checks performed, who performs them and the standard that must be met.',
    ].join(' '),

  escalation: () =>
    [
      'Issues are raised with the named contact and escalated if they are not resolved within the agreed time.',
      'Add the contacts, the timescales and what counts as an escalation.',
    ].join(' '),

  dependencies: () =>
    [
      'Delivery depends on the items listed below being available when they are needed.',
      'Assign an owner and a date to each dependency, and state the effect of a delay.',
    ].join(' '),

  scope: (c) =>
    [
      c.scopeClause
        ? `The work covered by this engagement is: ${sentence(c.scopeClause)}`
        : `The scope for ${clientName(c)} is set out below.`,
      c.deliverables.length ? `The outputs supplied are ${list(c.deliverables.slice(0, 4))}.` : '',
      'Confirm the boundary of the work before it starts: what is included, and what would need a separate agreement.',
    ]
      .filter(Boolean)
      .join(' '),

  scope_boundaries: () =>
    [
      'This section marks the edge of the engagement: what is included, and what would need a new agreement.',
      'Be specific about handover points and ongoing responsibilities after the engagement ends.',
    ].join(' '),

  change_management: () =>
    [
      'Changes are requested in writing, assessed for cost and schedule impact, and approved before work continues.',
      'State who can approve a change and how it is recorded.',
    ].join(' '),

  risk_management: () =>
    [
      'The principal risks and their controls are set out below.',
      'Add the owner of each risk and how often it is reviewed.',
    ].join(' '),

  delivery_model: () =>
    [
      'This section describes how the work is staffed, scheduled and reviewed.',
      'Add the team shape, the cadence and the reporting the client receives.',
    ].join(' '),

  budget_and_investment: () =>
    [
      'The budget and investment are set out below.',
      'Confirm what each figure covers, whether taxes are included, and which costs are estimates.',
    ].join(' '),
};

const CONTRACT_COPY: Record<string, Writer> = {
  parties: (c) =>
    [
      `This Agreement is made between ${clientName(c)} (the “Client”) and ${c.businessName || '[Service provider legal name]'} (the “Provider”).`,
      'Add the full legal name, registration number, registered address and notice details for each party before signing.',
    ].join(' '),

  recitals: (c) =>
    [
      `${clientName(c)} wishes to engage the Provider for ${subject(c)}, and the Provider has the capability to provide it.`,
      'The parties enter this Agreement on the terms below. Confirm that this background is accurate before signing.',
    ].join(' '),

  definitions: () =>
    [
      '“Agreement” means this document together with its schedules. “Services” means the services described in the Scope. “Deliverables” means the items to be provided under this Agreement. “Fees” means the amounts payable under the Fees and payment clause. “Business Day” means a day other than a Saturday, Sunday or public holiday where the Provider is established.',
      'Add any further defined term used in this Agreement, and use it consistently.',
    ].join(' '),

  obligations: (c) =>
    [
      `The Provider will perform the Services with reasonable skill and care and in accordance with this Agreement. ${clientName(c)} will provide the information, access, decisions and approvals reasonably required for the Provider to perform.`,
      'Add any specific obligations agreed for this engagement, and confirm who is responsible for third-party approvals.',
    ].join(' '),

  fees_and_payment: (c) =>
    [
      c.scopeClause ? 'The Fees are payable as set out in the payment schedule for the Services described in this Agreement.' : 'The Fees for the Services are set out in this Agreement.',
      'Complete the amount or rate, the currency, the invoicing cycle and the payment period, and state whether taxes are included.',
      'State what happens if an invoice is disputed or paid late.',
    ].join(' '),

  payment_terms: () =>
    [
      'Invoices are issued in accordance with the payment schedule in this Agreement.',
      'Complete the payment period, the currency, the method and the late-payment position. Confirm the statutory default position in the applicable jurisdiction.',
    ].join(' '),

  term: () =>
    [
      'This Agreement starts on the Effective Date and continues until the Services are complete or it is terminated earlier under the Termination clause.',
      'Complete the end date or duration, and confirm whether the Agreement can be extended and how.',
    ].join(' '),

  renewal: () =>
    [
      'This Agreement renews for successive periods unless either party gives written notice before the renewal date.',
      'Complete the renewal period and notice period, or delete this clause if the Agreement is for a fixed term only.',
    ].join(' '),

  confidentiality: () =>
    [
      'Each party will keep the other’s confidential information confidential, use it only for the purposes of this Agreement, and disclose it only to those who need it and are bound by equivalent obligations.',
      'Complete the confidentiality period after termination, and list any permitted disclosures such as a legal or regulatory requirement.',
    ].join(' '),

  confidential_information: () =>
    [
      'Confidential information means information disclosed by one party to the other that is marked confidential or would reasonably be understood to be confidential, in any form.',
      'Add any categories that must be treated as confidential for this relationship, and confirm the exclusions that apply.',
    ].join(' '),

  intellectual_property: (c) =>
    [
      'Each party retains ownership of its pre-existing intellectual property. Ownership of the Deliverables transfers to the Client on payment of the Fees, and the Provider grants the Client a licence to use any pre-existing material embedded in them.',
      'Confirm the point at which ownership passes, whether the Provider may reuse generic know-how, and how third-party assets are licensed.',
    ].join(' '),

  warranties: () =>
    [
      'Each party warrants that it has authority to enter this Agreement. The Provider warrants that the Services will be performed with reasonable skill and care by suitably qualified people.',
      'Add any further warranties agreed for this engagement, and remove anything you cannot stand behind.',
    ].join(' '),

  liability: () =>
    [
      'Neither party excludes liability that cannot lawfully be excluded. Subject to that, each party’s total liability under this Agreement is limited to [amount or multiple of Fees paid], and neither party is liable for indirect or consequential loss.',
      'Complete the liability cap and confirm the position on death, personal injury, fraud and other non-excludable liability under the applicable law.',
    ].join(' '),

  indemnification: () =>
    [
      'Each party will indemnify the other against losses arising from its own breach of this Agreement, negligence or infringement of third-party rights.',
      'Confirm the scope of the indemnity and whether it is mutual. Indemnities are interpreted differently across jurisdictions and need local review.',
    ].join(' '),

  termination: () =>
    [
      'Either party may terminate this Agreement on [notice period] written notice, or immediately if the other party commits a material breach that is not remedied within [remedy period] of notice, or becomes insolvent.',
      'Complete the notice and remedy periods, and state what is payable on termination.',
    ].join(' '),

  dispute_resolution: () =>
    [
      'The parties will first try to resolve any dispute through discussion between senior representatives. If that fails within [period], the dispute will be referred to [mediation, arbitration or the courts of the governing law].',
      'Complete the escalation period and the forum. Choose a forum that matches the governing law.',
    ].join(' '),

  governing_law: () =>
    [
      'This Agreement is governed by the laws of [jurisdiction], and the parties submit to the exclusive jurisdiction of the courts of [jurisdiction].',
      'Choose the governing law and jurisdiction deliberately. Do not assume either: they change the effect of the whole Agreement.',
    ].join(' '),

  notices: () =>
    [
      'Formal notices must be in writing and sent to the addresses and email addresses set out in this Agreement, or to another address notified in writing.',
      'Complete the notice details for each party and confirm when a notice is treated as received.',
    ].join(' '),

  general_provisions: () =>
    [
      'This Agreement is the entire agreement between the parties on its subject matter and replaces any earlier discussion on that subject. No variation is effective unless agreed in writing by both parties. If a provision is found unenforceable, the remaining provisions continue in force.',
      'Add any further standard provisions required in the applicable jurisdiction, such as counterparts or third-party rights.',
    ].join(' '),

  schedules: () =>
    [
      'The schedules form part of this Agreement: Schedule 1 (Scope), Schedule 2 (Fees and payment) and Schedule 3 (Service levels, if applicable).',
      'Attach each schedule and confirm that a conflict between a schedule and the main body is resolved in the way you intend.',
    ].join(' '),

  signatures: () =>
    [
      'Signed by the authorised representatives of each party.',
      'Add the name, title, signature and date for each party. Confirm that each signatory has authority to bind their organisation.',
    ].join(' '),

  data_protection: () =>
    [
      'Each party will comply with the data protection law that applies to it. Where one party processes personal data on behalf of the other, it will act only on documented instructions, apply appropriate security measures and assist with data-subject requests and breach notification.',
      'Confirm the controller and processor roles, the applicable law and the international transfer position for this engagement.',
    ].join(' '),

  processing_instructions: () =>
    [
      'The processor will process personal data only on the controller’s documented instructions, including for transfers to a third country where the controller has confirmed a lawful mechanism.',
      'Attach or describe the processing: categories of data, data subjects, purpose and duration.',
    ].join(' '),

  data_subject_rights: () =>
    [
      'The processor will assist the controller in responding to requests from individuals, taking into account the nature of the processing.',
      'Confirm the timescales for assistance and who is the contact for requests.',
    ].join(' '),

  breach_notification: () =>
    [
      'The processor will notify the controller without undue delay after becoming aware of a personal data breach, and will provide the information the controller needs to meet its own obligations.',
      'Complete the notification timescale and the contact route, and confirm the statutory deadline that applies.',
    ].join(' '),

  data_return: () =>
    [
      'On termination, the processor will return or delete personal data at the controller’s choice, and confirm what has been done, unless a law requires it to be retained.',
      'State the period for return or deletion and the exceptions that apply.',
    ].join(' '),

  security: () =>
    [
      'Each party will apply appropriate technical and organisational measures to protect the data and systems it is responsible for, and will notify the other of any incident that affects the other party.',
      'Name the standards or controls required, and confirm who is responsible for which part of the environment.',
    ].join(' '),

  audit_rights: () =>
    [
      'The controller may audit the processor’s compliance with this Agreement on reasonable notice, no more than [frequency], and may rely on an independent certification where it covers the relevant controls.',
      'Complete the notice period and frequency, and set out how confidentiality is protected during an audit.',
    ].join(' '),

  service_levels: () =>
    [
      'The service levels set out below measure availability, response and resolution. Performance is reported each [period].',
      'Complete the targets, the measurement method, the reporting period and the remedy when a target is missed.',
    ].join(' '),

  service_credits: () =>
    [
      'If a service level is missed, the customer is entitled to the credit set out below. Credits are the agreed remedy for the missed level and do not limit other rights for a persistent failure.',
      'Complete the credit calculation and cap, and confirm how a credit is claimed and applied.',
    ].join(' '),

  support_hours: () =>
    [
      'Support is available during the hours set out below. Requests are raised through the agreed channel and prioritised by impact.',
      'Complete the hours, the time zone, the channel and the priority definitions.',
    ].join(' '),

  response_targets: () =>
    [
      'Response and resolution targets are set by priority. The clock starts when a request is received through the agreed channel.',
      'Complete the targets for each priority and state what happens when a target is missed.',
    ].join(' '),

  service_levels_and_credits: () =>
    [
      'This section records the measured service levels and the credits that apply when they are missed.',
      'Complete the targets, the measurement method and the credit calculation.',
    ].join(' '),

  license_grant: (c) =>
    [
      `The Provider grants ${clientName(c)} a non-exclusive, non-transferable licence to use the software for its internal business purposes during the subscription or licence term.`,
      'Complete the permitted users, territory, environments and any permitted affiliate use.',
    ].join(' '),

  restrictions: () =>
    [
      'The licensee must not copy, modify, sublicense, resell or reverse engineer the software except as permitted by law, or use it to provide a competing service.',
      'Confirm the restrictions that are enforceable in the applicable jurisdiction, particularly any reverse-engineering limit.',
    ].join(' '),

  subscription: () =>
    [
      'The subscription begins on the start date and continues for the subscription term. Fees are payable in advance for each period.',
      'Complete the term, the number of users, the renewal behaviour and the notice required to stop renewal.',
    ].join(' '),

  acceptance: () =>
    [
      'The Client will review each Deliverable against the acceptance criteria within [period] and either accept it or give written reasons for rejection. A Deliverable not rejected within that period is treated as accepted.',
      'Complete the review period and the acceptance criteria, and state how long the Provider has to correct a rejection.',
    ].join(' '),

  personnel: () =>
    [
      'The Provider will assign suitably qualified personnel to the Services and may replace them with people of equivalent competence.',
      'Name the key personnel, if any, and confirm whether the Client has a right to object to a replacement.',
    ].join(' '),

  subcontracting: () =>
    [
      'The Provider may not subcontract any part of the Services without the Client’s prior written consent, and remains responsible for any subcontracted work.',
      'Confirm whether consent is required for each subcontractor and whether any are pre-approved.',
    ].join(' '),

  insurance: () =>
    [
      'Each party will maintain the insurance cover required by law and the cover set out below for the duration of this Agreement, and will provide evidence on request.',
      'Complete the types and limits of cover. Do not state a limit you have not confirmed with the insurer.',
    ].join(' '),

  force_majeure: () =>
    [
      'Neither party is liable for a failure to perform caused by an event outside its reasonable control, provided it notifies the other promptly and takes reasonable steps to reduce the effect. If the event continues for more than [period], either party may terminate.',
      'Complete the period and confirm which events are included or excluded.',
    ].join(' '),

  assignment: () =>
    [
      'Neither party may assign or transfer this Agreement without the other’s written consent, except to a successor of the whole of its business.',
      'Confirm whether assignment within a group requires consent.',
    ].join(' '),

  commission: () =>
    [
      'Commission is calculated on the net value of qualifying sales, excluding taxes and refunds, at the rate set out below. Commission is earned when the customer’s payment is received.',
      'Complete the rate, the qualifying sales definition, the payment date and the position on cancelled or refunded orders.',
    ].join(' '),

  payment_of_commission: () =>
    [
      'Commission is paid with the payroll or invoice cycle following the period in which it is earned, subject to the clawback provisions.',
      'Complete the payment date, the statement provided and the clawback conditions.',
    ].join(' '),

  referral_fee: () =>
    [
      'A referral fee is payable for each eligible referral that becomes a paying customer, calculated as set out below.',
      'Complete the fee or percentage, the basis of calculation and whether it is payable once or recurring.',
    ].join(' '),

  payment_of_referral_fee: () =>
    [
      'The referral fee is paid within [period] after the referred customer’s first payment has cleared.',
      'Complete the payment period and how the referrer is told the referral has qualified.',
    ].join(' '),

  referral_process: () =>
    [
      'A referral must be submitted through the agreed channel before any contact with the prospective customer, and is only eligible if the customer is not already in discussion with the business.',
      'Confirm the submission method, the validity period and the exclusions.',
    ].join(' '),

  duties: (c) =>
    [
      `The role is ${subject(c)}. The post holder will carry out the duties set out in this Agreement and any other reasonable duties consistent with the role.`,
      'Add the specific responsibilities, reporting line and any place-of-work requirement.',
    ].join(' '),

  appointment: (c) =>
    [
      `${clientName(c)} appoints the other party on the terms of this Agreement, and that appointment begins on the Effective Date.`,
      'Confirm the role, the start date, the reporting line and whether the appointment is exclusive.',
    ].join(' '),

  probation: () =>
    [
      'The first [period] of the appointment is a probationary period, during which either party may terminate on the notice set out in this Agreement.',
      'Complete the probation length and notice. Confirm the statutory position on probation in the applicable jurisdiction.',
    ].join(' '),

  remuneration: () =>
    [
      'Remuneration is payable at the rate set out below, subject to deductions required by law, and is paid on the agreed cycle.',
      'Complete the amount, the cycle, the currency and the treatment of any variable element.',
    ].join(' '),

  benefits: () =>
    [
      'The benefits set out below apply in addition to remuneration, subject to the terms of the relevant scheme.',
      'List the benefits, the eligibility conditions and whether they are contractual or discretionary.',
    ].join(' '),

  working_hours: () =>
    [
      'Normal working hours are set out below. Any additional hours are worked in line with the applicable law and the agreed policy.',
      'Complete the hours, the location, any hybrid arrangement and the overtime position. Confirm the statutory limits that apply.',
    ].join(' '),

  leave: () =>
    [
      'Annual leave, sickness and other leave are set out below, in addition to the statutory entitlements that apply.',
      'Complete the entitlements and the notice required. Confirm the statutory minimum in the applicable jurisdiction.',
    ].join(' '),

  restrictive_covenants: () =>
    [
      'The post holder agrees to the restrictions set out below after the appointment ends, limited to what is necessary to protect legitimate business interests.',
      'Confirm the duration, geography and activity for each restriction. Enforceability varies significantly by jurisdiction and requires local advice.',
    ].join(' '),

  non_solicitation: () =>
    [
      'During the appointment and for [period] afterwards, neither party will knowingly solicit the other’s staff or clients in connection with a competing service.',
      'Complete the period, confirm the scope, and check that the restriction is enforceable where the parties are based.',
    ].join(' '),

  non_solicit: () =>
    [
      'During the appointment and for [period] afterwards, neither party will knowingly solicit the other’s staff or clients in connection with a competing service.',
      'Complete the period and scope, and take local advice on enforceability.',
    ].join(' '),

  non_compete: () =>
    [
      'The restrictions on competing activity after termination are set out below, limited to the period and territory necessary to protect legitimate interests.',
      'Complete the period, territory and activities. Non-compete clauses are restricted in several jurisdictions and need local review.',
    ].join(' '),

  taxes: () =>
    [
      'Each party is responsible for its own taxes arising from this Agreement. The Provider is responsible for its own income tax and social security contributions and is not treated as an employee.',
      'Confirm the tax and employment-status position in the applicable jurisdiction before relying on this clause.',
    ].join(' '),

  independent_contractor_status: () =>
    [
      'The Provider is an independent contractor. Nothing in this Agreement creates an employment, partnership or agency relationship, and the Provider decides how the Services are performed.',
      'Confirm that the working arrangements match this clause. Status tests differ by jurisdiction and a mismatch can carry penalties.',
    ].join(' '),

  expenses: () =>
    [
      'Reasonable expenses are reimbursed at cost where they are agreed in advance and supported by receipts.',
      'Complete the rates, the approval process and the items that are not reimbursable.',
    ].join(' '),

  delivery: () =>
    [
      'Goods are delivered to the address and by the date agreed in each order. Delivery dates are estimates unless expressly agreed as firm dates.',
      'Complete the delivery terms, the risk point and what happens if delivery is late.',
    ].join(' '),

  orders_and_forecasts: () =>
    [
      'Orders are placed in writing and are binding when accepted. Forecasts are given in good faith and do not create a binding obligation to order.',
      'Complete the order process, the acceptance period and the forecast horizon.',
    ].join(' '),

  risk_and_title: () =>
    [
      'Risk in the goods passes to the buyer on delivery. Title passes only when the price has been paid in full.',
      'Confirm the risk and title points, especially where goods are stored or installed before acceptance.',
    ].join(' '),

  product_standards: () =>
    [
      'Goods must meet the specification, any agreed samples and the standards that apply to them.',
      'Name the standards, the inspection method and the remedy if goods do not conform.',
    ].join(' '),

  inspection: () =>
    [
      'The buyer may inspect goods on delivery and reject any that do not conform. Rejected goods are returned at the supplier’s cost.',
      'Complete the inspection period and the rejection process.',
    ].join(' '),

  price_variation: () =>
    [
      'Prices may be varied only by written agreement or as set out in this clause, with [notice period] notice and no change to orders already accepted.',
      'Complete the notice period and any index or mechanism used to vary prices.',
    ].join(' '),

  variations: () =>
    [
      'A variation is only effective when recorded in writing and priced before the work is carried out, unless it is an urgent instruction confirmed afterwards.',
      'Confirm who may instruct a variation, how it is valued and how it affects the programme.',
    ].join(' '),

  works: (c) =>
    [
      `The works to be carried out for ${clientName(c)} are described in the scope, together with the standard they must meet.`,
      'Add the specification, the drawings or schedules that define the works, and the completion criteria.',
    ].join(' '),

  programme: () =>
    [
      'The works will be carried out in accordance with the programme agreed by the parties.',
      'Attach the programme, confirm the start and completion dates, and state the effect of a delay caused by either party.',
    ].join(' '),

  site_conditions: () =>
    [
      'The parties have recorded the site conditions on which the price and programme are based. A material difference must be notified and dealt with as a variation.',
      'Attach the site records, the survey and the allocation of risk for unforeseen conditions.',
    ].join(' '),

  defects: () =>
    [
      'The contractor will remedy defects notified during the defects liability period at no additional cost.',
      'Complete the period, the notification process and the response time for a defect.',
    ].join(' '),

  defects_liability: () =>
    [
      'The contractor will remedy defects notified during the defects liability period at no additional cost.',
      'Complete the period, the notification process and what is excluded, such as fair wear and tear.',
    ].join(' '),

  retention: () =>
    [
      'A retention of [percentage] is held from each payment and released in accordance with this clause.',
      'Complete the percentage, the release points and the position on interest. Confirm the statutory rules that apply.',
    ].join(' '),

  payment_schedule: () =>
    [
      'Payments are made against the stages set out below, subject to the agreed certification process.',
      'Complete the stage values, the due dates and the evidence required for each payment.',
    ].join(' '),

  instalments: () =>
    [
      'The balance is repaid in the instalments set out below. Each instalment is due on the date shown.',
      'Complete the amounts, dates and payment method, and confirm the total reconciles to the amount owed.',
    ].join(' '),

  amount_owed: () =>
    [
      'The amount owed under this Agreement is the balance set out below, calculated from the invoices identified in this Agreement.',
      'Complete the opening balance and confirm it against your records before the plan is signed.',
    ].join(' '),

  default: () =>
    [
      'If an instalment is missed, the plan may be cancelled and the remaining balance becomes payable immediately, subject to any notice required by law.',
      'Complete the notice period and confirm the default position in the applicable jurisdiction.',
    ].join(' '),

  late_payment: () =>
    [
      'Late payment may attract interest at [rate] from the due date until payment is received, and the payer is responsible for reasonable recovery costs.',
      'Complete the rate and confirm the statutory interest position that applies.',
    ].join(' '),

  early_repayment: () =>
    [
      'The payer may repay the balance early without penalty, subject to written notice.',
      'Confirm the notice period and whether any discount applies.',
    ].join(' '),

  rent_and_deposit: () =>
    [
      'The rental charge and deposit are set out below. The deposit is refunded when the equipment is returned in the condition required by this Agreement, less any agreed charges.',
      'Complete the charge, the deposit, the payment dates and the refund timescale.',
    ].join(' '),

  equipment: () =>
    [
      'The equipment rented under this Agreement is listed below, together with its condition on delivery.',
      'Add serial numbers, accessories and the condition record signed at handover.',
    ].join(' '),

  care_of_equipment: () =>
    [
      'The hirer will use the equipment only for its intended purpose, keep it secure and carry out the routine checks set out below.',
      'Add the operating instructions, the servicing requirements and the restrictions on alteration.',
    ].join(' '),

  return_of_equipment: () =>
    [
      'The equipment must be returned to the agreed location on the return date, in the condition required by this Agreement.',
      'Complete the return date, the location and the collection arrangement.',
    ].join(' '),

  damage_and_loss: () =>
    [
      'The hirer is responsible for loss of or damage to the equipment beyond fair wear and tear, and will pay the reasonable cost of repair or replacement.',
      'State how the cost is assessed and whether insurance is required.',
    ].join(' '),

  cancellation: () =>
    [
      'Either party may cancel on written notice. Cancellation charges apply on the scale set out below to cover commitments already made.',
      'Complete the notice period and the cancellation scale, and state what happens to work already performed.',
    ].join(' '),

  event_date_and_venue: () =>
    [
      'The event will take place on the date and at the venue set out below.',
      'Complete the date, timings, venue and access arrangements, and confirm the position if the venue becomes unavailable.',
    ].join(' '),

  authority: () =>
    [
      'The manager may act on the owner’s behalf only within the authority set out below, and must obtain approval for anything above that limit.',
      'Complete the financial and operational limits, and confirm who can authorise expenditure.',
    ].join(' '),

  property_scope: () =>
    [
      'The properties covered by this appointment are listed below.',
      'Add the address, tenure, occupancy and any property-specific obligation for each property.',
    ].join(' '),

  rights_and_benefits: () =>
    [
      'The sponsor receives the rights and benefits set out below in exchange for the sponsorship fee.',
      'List each deliverable, the date it is provided and who at the organiser is responsible.',
    ].join(' '),

  sponsorship_fee: () =>
    [
      'The sponsorship fee is payable as set out below and is exclusive of any applicable taxes.',
      'Complete the amount, the payment dates and the treatment of taxes.',
    ].join(' '),

  brand_approvals: () =>
    [
      'Each party must approve the use of its name and marks before publication, and approval will not be unreasonably withheld.',
      'Complete the approval timescale and the brand guidelines that apply.',
    ].join(' '),

  brand_use: () =>
    [
      'The partner may use the brand assets only as permitted by the brand guidelines and only during the term.',
      'Attach the guidelines and confirm what happens to materials bearing the brand when the Agreement ends.',
    ].join(' '),

  exclusivity: () =>
    [
      'The sponsor’s exclusivity, if any, is limited to the category, territory and period set out below. No exclusivity applies to any other category.',
      'Complete the category, territory and period, and state what happens if exclusivity is breached.',
    ].join(' '),

  publicity: () =>
    [
      'Neither party will publicise this Agreement or use the other’s name without written approval, except as required by law.',
      'Agree the approved announcement, the timing and the spokesperson.',
    ].join(' '),

  portfolio_use: () =>
    [
      'The designer may show the work in a portfolio and on its website unless the client objects in writing for a stated confidentiality reason.',
      'Confirm the position, and remove anything that identifies the client without permission.',
    ].join(' '),

  client_approvals: () =>
    [
      'The client must approve each stage in writing before the next stage begins. Approval confirms the direction but does not relieve the provider of its obligation to work with reasonable skill and care.',
      'Complete the approval points and the response time, and state what happens if approval is delayed.',
    ].join(' '),

  client_materials: () =>
    [
      'The client will supply the materials, brand assets, access and information needed for the work, and confirms it has the rights to use them.',
      'List the materials and the date they are needed. Confirm who clears third-party rights.',
    ].join(' '),

  client_responsibilities: () =>
    [
      'The client will provide the information, access, decisions and approvals reasonably required, and will respond to review requests within the agreed time.',
      'Add any client-specific responsibilities and the effect of a delay on the schedule.',
    ].join(' '),

  customer_obligations: () =>
    [
      'The customer will use the service only as permitted, keep credentials secure, and ensure its users comply with this Agreement.',
      'Add the acceptable-use rules and the customer’s responsibility for its own data and integrations.',
    ].join(' '),

  responsibilities: () =>
    [
      'Each party’s responsibilities for the activity are set out below.',
      'Assign every material responsibility and name the person accountable for it.',
    ].join(' '),

  resources: () =>
    [
      'Each party will contribute the resources set out below for the duration of the activity.',
      'Add the staff, facilities or funding, the timing and what happens if a contribution is delayed.',
    ].join(' '),

  costs: () =>
    [
      'Each party bears its own costs of participating unless a cost is expressly shared below.',
      'Confirm which costs are shared, how they are approved and how they are invoiced.',
    ].join(' '),

  purpose: () =>
    [
      'The purpose of this Agreement is set out below and limits how the information or access provided may be used.',
      'Describe the purpose precisely. A vague purpose weakens the protection the Agreement provides.',
    ].join(' '),

  areas_of_cooperation: () =>
    [
      'The parties intend to cooperate in the areas set out below.',
      'Add the scope, the lead contact for each area and any exclusions.',
    ].join(' '),

  non_binding_nature: () =>
    [
      'This memorandum records the parties’ intentions and is not legally binding, except for the clauses on confidentiality, costs and governing law.',
      'Confirm which clauses are intended to bind, and remove this clause if the whole document is meant to be binding.',
    ].join(' '),

  duration: () =>
    [
      'The obligations in this Agreement continue for the period set out below, and confidentiality obligations continue after it ends.',
      'Complete the duration and any survival period, and confirm the position on trade secrets where relevant.',
    ].join(' '),

  return_of_information: () =>
    [
      'On written request, the receiving party will return or destroy the confidential information and confirm in writing that it has done so.',
      'Confirm the timescale and the exception for copies required by law or by internal compliance records.',
    ].join(' '),

  return_and_destruction: () =>
    [
      'On termination or on request, the receiving party will return or destroy the confidential information and confirm completion in writing.',
      'Confirm the timescale and the retention required by law.',
    ].join(' '),

  permitted_disclosures: () =>
    [
      'Confidential information may be disclosed to professional advisers, insurers and employees who need it, provided they are bound by equivalent obligations, or where disclosure is required by law.',
      'Add any other permitted disclosure and the notice required before a legally compelled disclosure.',
    ].join(' '),

  no_licence: () =>
    [
      'Disclosure of confidential information does not grant any licence or other right in the information or in any intellectual property.',
      'Confirm that no implied licence is intended.',
    ].join(' '),

  remedies: () =>
    [
      'The parties agree that damages may not be an adequate remedy for a breach of confidentiality, and that injunctive relief may be sought in addition to other remedies.',
      'Confirm the remedies available under the applicable law before relying on this clause.',
    ].join(' '),

  consideration: () =>
    [
      'The assignment is made in exchange for the consideration set out below, receipt of which the assignor acknowledges.',
      'Complete the consideration. Where the assignment is made under employment or a services agreement, state that it is part of the overall arrangement.',
    ].join(' '),

  further_assurance: () =>
    [
      'Each party will sign any further documents reasonably required to give effect to the assignment.',
      'Confirm who is responsible for registering the transfer where registration applies.',
    ].join(' '),

  moral_rights: () =>
    [
      'To the extent permitted by law, the author waives moral rights in the assigned work. Where waiver is not permitted, the author consents to the acts that would otherwise infringe those rights.',
      'Confirm the moral-rights position in the applicable jurisdiction. It cannot be waived everywhere.',
    ].join(' '),

  copyright: () =>
    [
      'Copyright in the images remains with the photographer. The client receives the licence set out in this Agreement.',
      'Confirm the licence scope, the credit requirement and what happens to unused images.',
    ].join(' '),

  image_storage: () =>
    [
      'Images are stored for the period set out below and then deleted. The client is responsible for downloading and backing up the delivered files.',
      'Complete the storage period and the retrieval process.',
    ].join(' '),

  model_releases: () =>
    [
      'The photographer will obtain the model and property releases required for the agreed use where the shoot involves people or private property.',
      'Confirm who arranges and holds the releases, and which uses they cover.',
    ].join(' '),

  third_party_ip: () =>
    [
      'Third-party assets used in the work are licensed to the client under the terms of the relevant supplier, and the client is responsible for complying with those terms.',
      'List the third-party assets, their licences and any renewal cost the client will carry.',
    ].join(' '),

  third_party_components: () =>
    [
      'Third-party components are licensed under their own terms. The provider passes those terms on and does not warrant the third party’s performance.',
      'List each component, its licence and whether it carries an ongoing fee.',
    ].join(' '),

  third_party_platforms: () =>
    [
      'The services rely on third-party platforms. Their availability, terms and costs are outside the provider’s control, and the client is responsible for its own accounts and compliance.',
      'Name the platforms, confirm who owns the accounts and what happens if access is lost.',
    ].join(' '),

  development_process: () =>
    [
      'Development runs in stages: discovery, build, review and release. Each stage ends with a review against the agreed scope.',
      'Add the stage gates, the acceptance criteria and the release process.',
    ].join(' '),

  change_management: () =>
    [
      'A change request is assessed for impact on scope, cost and schedule before it is accepted. Work outside the agreed scope is charged at the agreed rate.',
      'Confirm who can approve a change and how it is recorded and priced.',
    ].join(' '),

  quality_control: () =>
    [
      'The licensor will maintain the quality of licensed material and may inspect samples to protect the value of the rights.',
      'Confirm the approval process and the consequences of failing a quality check.',
    ].join(' '),

  records: () =>
    [
      'Each party will keep accurate records relating to this Agreement for the period required by law and will make them available where this Agreement provides for audit.',
      'Complete the retention period and the access arrangements.',
    ].join(' '),

  audit_rights_generic: () =>
    [
      'The parties may audit compliance with this Agreement on reasonable notice and during business hours, subject to confidentiality.',
      'Complete the notice period and the frequency of audits.',
    ].join(' '),

  suspension: () =>
    [
      'The provider may suspend the service if fees are overdue or use breaches this Agreement, after giving notice where it is reasonable to do so.',
      'Complete the notice period and the process for restoring the service.',
    ].join(' '),

  backups: () =>
    [
      'Backups are taken on the schedule set out below and restoration is tested. The client remains responsible for its own data exports.',
      'Complete the schedule, the retention period and the restoration target.',
    ].join(' '),

  hosting_services: () =>
    [
      'Hosting covers the infrastructure, monitoring and routine maintenance described below.',
      'Confirm the environment, the region, the maintenance windows and what is excluded.',
    ].join(' '),

  reseller_obligations: () =>
    [
      'The reseller will market the product accurately, provide first-line support and comply with the brand and pricing requirements in this Agreement.',
      'Add the sales targets, the certification requirements and the support responsibilities.',
    ].join(' '),

  pricing_and_payment: () =>
    [
      'The reseller buys at the prices set out below and is responsible for its own margin and for collecting payment from its customers.',
      'Complete the price list, the payment terms and the treatment of taxes.',
    ].join(' '),

  territory_and_customers: () =>
    [
      'The reseller may sell only in the territory and to the customer groups set out below.',
      'Complete the territory and any excluded accounts that the provider retains.',
    ].join(' '),

  supervision: () =>
    [
      'The placement is supervised by the named supervisor, who will set the work, provide feedback and complete the end-of-placement review.',
      'Confirm the supervisor, the review points and the process if the placement is not working.',
    ].join(' '),

  stipend: () =>
    [
      'A stipend is payable at the rate set out below for the duration of the placement.',
      'Complete the rate, the payment cycle and the treatment of expenses. Confirm the local rules on intern pay before signing.',
    ].join(' '),

  parts_and_materials: () =>
    [
      'Spare parts and materials are supplied as set out below. Parts are charged at the agreed rates unless included in the maintenance fee.',
      'Complete the rates, the lead times and the position on obsolete parts.',
    ].join(' '),

  review: () =>
    [
      'The parties will review performance against this Agreement at the intervals set out below.',
      'Complete the frequency, the attendees and the decisions the review can make.',
    ].join(' '),

  roles: () =>
    [
      'The roles and decision rights for this arrangement are set out below.',
      'Assign each role to a named person and confirm the limits of their authority.',
    ].join(' '),

  roles_and_responsibilities: () =>
    [
      'This section records what each party contributes and who decides what.',
      'Assign every material responsibility to a named party and flag anything that remains unallocated.',
    ].join(' '),

  capital_and_profit_share: () =>
    [
      'The capital each party contributes and the basis on which profit is shared are set out below.',
      'Complete the contribution, the profit split and how losses are shared. Confirm the tax treatment with an adviser.',
    ].join(' '),

  decision_making: () =>
    [
      'The decisions that require agreement between the parties are listed below, together with the approval needed.',
      'Complete the matters reserved for unanimous approval and the deadlock process if agreement cannot be reached.',
    ].join(' '),

  commercial_terms: () =>
    [
      'The commercial terms of this arrangement are set out below.',
      'Complete the revenue split, the cost allocation and the payment mechanics, and confirm the treatment of tax.',
    ].join(' '),

  term_and_review: () =>
    [
      'The arrangement has an initial term, a review point and an agreed way to end it.',
      'Set the dates, the review cadence and the notice each party must give.',
    ].join(' '),

  credit: () =>
    [
      'The author may be credited on published work in the form agreed below.',
      'Confirm whether credit is required or optional, and how it should read.',
    ].join(' '),

  campaign_approval: () =>
    [
      'Campaign materials are submitted for written approval before publication, and approval is not unreasonably withheld or delayed.',
      'Confirm who approves, the response time and what happens if a deadline is missed.',
    ].join(' '),

  agreement: () =>
    [
      'The parties agree to the activity described in this document on the terms set out below.',
      'Confirm that the description of the activity is complete and matches what the parties intend.',
    ].join(' '),

  appointment_of_reseller: () =>
    [
      'The provider appoints the reseller on the terms of this Agreement, and the appointment is non-exclusive unless stated otherwise.',
      'Confirm exclusivity, territory and any performance conditions.',
    ].join(' '),
};

// A few template sections use a heading whose natural key is not one of the
// shared writers above. Aliases keep the copy specific without duplicating it.
const ALIASED: Record<string, string> = {
  appointment_of_reseller: 'appointment',
  service_levels_and_credits: 'service_levels',
  audit_rights_generic: 'audit_rights',
  publicty: 'publicity',
  scope_of_work: 'scope',
  quality_assurance: 'quality_assurance',
};

/** Every section key with a bespoke writer, for coverage tests. */
export const SECTION_COPY_KEYS = Array.from(
  new Set([...Object.keys(PROPOSAL_COPY), ...Object.keys(CONTRACT_COPY), ...Object.keys(ALIASED)]),
).sort();

/**
 * The draft copy for a section a template introduced. Core sections
 * (introduction, about, scope, what is included, timeline, next step, pricing)
 * are handled by the organiser's own writers before this is called.
 */
export function draftSectionCopy(key: string, context: SectionCopyContext): string {
  const name = ALIASED[key] ?? key;
  const writer = PROPOSAL_COPY[name] ?? CONTRACT_COPY[name] ?? PROPOSAL_COPY[key] ?? CONTRACT_COPY[key];
  if (!writer) return '';
  try {
    return writer(context);
  } catch {
    return '';
  }
}

/** True when this section key has a bespoke writer in this module. */
export function hasSectionCopy(key: string): boolean {
  const name = ALIASED[key] ?? key;
  return Boolean(PROPOSAL_COPY[name] ?? CONTRACT_COPY[name]);
}
