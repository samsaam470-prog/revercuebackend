# Product accuracy boundary

Backend responses, prompts and documentation must describe only what the
implementation actually provides.

## Implemented and safe to state

- Proposals, contracts, requirement forms, invoices and CRM records.
- Client-facing workflow links that do not require the client to create a
  Revercue account.
- Simple electronic signing for contracts: a drawn/typed signature, explicit
  consent, version locking, recorded signing evidence and a countersigned PDF.
- Plan-based limits, retention policies and email notifications where the
  relevant configuration exists.

## Do not claim

- Qualified electronic signatures, certificate-based signatures, notarisation
  or identity verification. None of those are implemented.
- Audit certification or legal certification of a signature.
- That Revercue has no e-signature functionality. Simple electronic signing is
  implemented.
- That a model runs locally in the browser, or that AI-generated content is
  never transmitted to a server, unless the specific implementation proves it.
- Any capability that is only planned, inferred or configured in a provider
  dashboard but not implemented in this repository.

The contract consent text deliberately avoids naming a specific statute or
claiming that a signature is legally binding under a particular law. Counsel
should review jurisdiction-specific wording before it is presented as legal
advice.
