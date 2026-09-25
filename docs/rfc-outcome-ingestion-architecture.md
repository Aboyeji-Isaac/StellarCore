# RFC: Trusted transfer-outcome ingestion architecture

- **Status:** Proposed for maintainer decision
- **Date:** 2026-09-24
- **Issue:** [#20](https://github.com/Aboyeji-Isaac/StellarCore/issues/20)
- **Scope:** Research and architecture only

## Decision summary

StellarCore should not begin production outcome ingestion by choosing a single verification technology. The trust model, evidence contract, source authorization, correction policy, and privacy controls must be agreed before any writer is introduced.

The recommended starting point is a **bounded, manually reviewed discovery pilot with one consenting anchor and one reviewed corridor**. The pilot should remain outside production and should not write to `TransferOutcome` or affect reputation scores. Its purpose is to learn whether a source can report complete terminal outcomes, what evidence is reproducible, and which failures are omitted or ambiguous.

The conditional long-term production candidate is a **hybrid of anchor-signed attestations, Horizon corroboration of the on-chain leg, and human review of exceptions**. Signature verification establishes that a statement was signed under a reviewed trust binding; replay protection separately requires stable event identity, versioning, freshness rules, and durable replay state. None of those controls makes the statement independently true. Horizon provides a reproducible public-ledger observation; it cannot prove that an off-chain bank or fiat leg settled. A third-party custodian or independent settlement attestor should be evaluated only if it introduces real custody or independently enforceable settlement guarantees rather than merely republishing an anchor assertion.

This RFC recommends a starting point for maintainer discussion. It does not select a final vendor, approve a protocol, authorize implementation, or authorize changes to scoring.

## Problem

StellarCore already has a normalized `TransferOutcome` model and deterministic reputation calculations, but it has no authorized production source for those outcomes. The current system deliberately keeps public APIs read-only and does not infer completion from Horizon, a successful Stellar payment, or SEP capability metadata.

An ingestion design must answer a harder question than “did some payment succeed?” It must establish:

1. **Who reported the terminal outcome?**
2. **Which transfer does the report describe?**
3. **What on-chain and off-chain legs were observed?**
4. **When did the transfer reach its terminal state?**
5. **What evidence supports the status?**
6. **How are duplicates, corrections, reversals, and source outages handled?**
7. **What may StellarCore publicly claim?**

A successful payment on Stellar can establish that a payment operation succeeded. It cannot, by itself, establish that an anchor accepted the intended deposit, that a bank transfer or fiat payout cleared, or that the customer received the expected value. Any architecture that collapses those facts into an unqualified `COMPLETED` outcome would create false evidence.

## Current architecture and constraints

The current production architecture has several properties that any future ingestion boundary must preserve:

- StellarCore is an intelligence layer, not a transfer executor.
- Public anchor, corridor, rate, and reputation APIs are read-only.
- Anchor and corridor relationships come from reviewed registries.
- The scheduled refresh ingests reviewed indicative-rate observations and then evaluates persisted reputation evidence. It does not ingest transfer outcomes.
- `TransferOutcome` currently stores an anchor, corridor, status, fill rate, settlement duration, slippage, and `recordedAt` timestamp.
- The current model has no source identifier, source event identifier, evidence reference, signature, reviewer, verification state, ingestion timestamp, coverage declaration, or source-level deduplication key.
- The scoring engine uses `recordedAt` for its 90-day reliability window and its 7-day and 30-day metrics, and counts only `COMPLETED` as success. `PARTIAL`, `REFUNDED`, `EXPIRED`, and `ERROR` are failures.
- A published score also requires at least 30 outcomes, at least one synchronized corridor, and at least one latest rate observation.
- The public reputation response does not expose source provenance. Future publication policy must not describe a source as “independent” merely because its evidence was validated or signed.

The normalized outcome table should therefore be treated as a downstream projection of accepted evidence, not as the evidence record itself. This distinction is architectural, not a proposal to modify the current schema in this RFC.

## Terminology

- **Transfer:** One customer-scoped or partner-scoped movement with a stable source event identity.
- **Terminal outcome:** A final state defined by a specific source and protocol version. Terms such as completed, partial, refunded, expired, and error are examples, not universally terminal states across SEP-24, SEP-31, or private anchor workflows.
- **On-chain observation:** A payment, operation, asset movement, or ledger event visible through Stellar network data at a stated finality policy.
- **Off-chain settlement/transfer leg:** The bank, card, mobile-money, cash, or other conventional movement outside Stellar. Depending on direction, this may represent a deposit into the anchor's fiat system or a payout from it.
- **Source assertion:** A statement made by an anchor, partner, reviewer, or service about a transfer.
- **Attestation:** A source assertion bound to a stable event identity and signed by a controlled key.
- **Review decision:** A human decision that evidence was accepted, rejected, corrected, or escalated.
- **Provenance:** The durable chain identifying who asserted what, when, under which policy, and what evidence supports it.
- **Independence:** Evidence produced by a party with authority and incentives materially separate from the party being evaluated. Cryptographic integrity alone is not independence.

## Conceptual evidence flow

```text
authorized source
  -> source-specific intake
  -> canonical evidence envelope
  -> signature/replay validation
  -> on-chain corroboration where applicable
  -> review or exception handling
  -> accepted provenance record
  -> normalized TransferOutcome projection
  -> existing reputation calculation
```

The source-specific intake should not be a public customer write endpoint. Evidence may contain sensitive bank references, customer identifiers, or payout artifacts and must not flow through the current public API boundary.

A conceptual provenance envelope would need, at minimum:

- source type and stable source identity;
- source event ID and event version;
- anchor and reviewed corridor identity;
- source-native status and StellarCore's versioned status mapping;
- source event time, evidence received time, and optional on-chain observation time;
- source amounts and assets without unnecessary customer data;
- evidence hash or protected reference;
- signing key ID, signature, validity window, and revocation state where applicable;
- reviewer identity and decision for manually reviewed evidence;
- correction, retraction, and supersession links;
- coverage or completeness declaration for the reporting period;
- canonicalization and schema versions.

This is a conceptual contract for maintainer evaluation, not a proposed database schema.

## Cross-cutting viability requirements

Every approach must satisfy the requirements below before any production writer is approved.

### Authorization and identity

- The source must be authorized to report outcomes for the named anchor and corridor.
- The source identity must be bound to a reviewed registry identity, not accepted from an arbitrary request.
- Authentication must be server-side, secret-bearing credentials must remain server-only, and keys must have rotation, revocation, and emergency-disable procedures.
- StellarCore currently discovers SEP-1 metadata and uses scoped SEP-10 authentication; it does not currently persist an outcome-signing trust root or implement a SEP-45 outcome boundary.
- SEP-10 authentication, and SEP-45 if separately adopted, can establish a scoped customer or participant session; neither is, by itself, durable outcome provenance.

### Event identity and idempotency

- Every terminal transfer needs a source-stable event ID.
- A correction needs a new version or explicit supersession relationship, not an unexplained second logical event.
- Logical-event deduplication should use source identity plus stable source event ID. Event version or supersession identifies revisions; counting a correction as another logical outcome would inflate scoring denominators.
- Replays, batches, backfills, and delayed delivery must not inflate the current 30-outcome threshold or reliability denominator.

### Time semantics

- Source event time and ingestion time must be distinct.
- The scoring window must not be manipulable through a late-arriving row with a backdated `recordedAt` value.
- Clock skew, future timestamps, corrections, and backfill inclusion require explicit policy.
- A source outage must not create an artificial increase in completed outcomes or a gap that is silently treated as zero failures.

### Status semantics

- Source-native status must be retained alongside any normalized status.
- Mapping and terminality must be versioned by source and protocol because SEP-24, SEP-31, and private anchor workflows can change and may permit recovery from states whose names resemble terminal states.
- `COMPLETED` must mean the full source-defined transfer reached a successful terminal state, not merely that one leg was observed or that an anchor API returned a source-native status.
- Partial, refunded, expired, and error outcomes must be reportable; selective success-only reporting creates survivorship bias.

### Evidence and corrections

- Evidence must be sufficient for a reviewer or verifier to reproduce the decision where legally and technically possible.
- Every acceptance and rejection needs a durable reason code and actor.
- Corrections and retractions must supersede prior evidence without silently deleting audit history.
- The source's completeness policy must disclose unsupported corridors, excluded transfers, reporting delays, and known gaps.

### Privacy and security

- Collect the minimum customer and banking data needed for verification.
- Keep raw evidence encrypted, access-controlled, redacted, and outside public API responses and routine logs.
- Define retention and deletion requirements with the source and relevant legal/privacy reviewers.
- Protect against replay, batch confusion, source impersonation, key compromise, reviewer collusion, and evidence tampering.
- Define incident handling for compromised credentials, incorrect attestations, leaked evidence, and malicious source behavior.

### Publication policy

StellarCore must describe evidence at the confidence level actually obtained:

- `on-chain observed` is not `off-chain completed`;
- `anchor attested` is not `independently verified`;
- `review accepted` is not a legal or financial endorsement;
- a narrow or biased sample cannot be presented as representative reputation evidence.

## Approach 1: Anchor-signed attestations

### Model

An anchor signs a versioned, canonical statement for a terminal transfer or a batch. The statement binds a stable event ID and version, anchor and corridor identity, event time, terminal status, transfer amounts, and the evidence needed to support the claim. StellarCore verifies the signature against a reviewed, domain-bound trust root. For batches, the signed commitment must bind every included event so an event cannot be added, removed, or reordered after signing.

A SEP-1 `SIGNING_KEY` is a possible discovery input, but it is documented for SEP-10 authentication and is not persisted as an outcome trust root in the current repository. It should not be repurposed for outcome attestation without explicit agreement. A dedicated outcome-signing trust root, or a formally authorized use of an existing key, is required.

### Advantages

- The anchor is closest to the off-chain process that decides whether settlement completed.
- Signature verification protects payload integrity and signer authentication under a reviewed trust binding.
- Replay protection requires signed event identity and version, freshness or validity rules, and durable replay state; it is not a property of a signature alone.
- Signed batches can be processed efficiently without collecting customer authentication contexts.
- The model can evolve from manual report preparation to automated delivery without changing the source's authority.

### Limitations

- A valid signature under a reviewed trust binding establishes signer authorship, not that the statement is true.
- An anchor can lie, omit failures, or report only successful transfers unless coverage is contractually and technically addressed.
- Anchor self-attestation is not independent verification in the strong sense.
- Key compromise, rotation, revocation, historical validity, and source outages require operational processes.
- Existing Stellar SEPs do not define one common outcome-attestation envelope or cross-anchor coverage guarantee.

### Viability gates

Before recommending production use:

- At least one anchor accepts a versioned outcome-attestation contract and commits to complete terminal reporting for an explicit scope.
- Key-to-anchor/domain binding is independently reviewed, with rotation and revocation procedures.
- Canonical serialization, signature algorithm, event identity, timestamp semantics, batch rules, and replay rules are specified.
- Reporting includes failures and discloses exclusions, delays, and unsupported corridors.
- Duplicate, correction, retraction, outage, and backfill handling are defined.
- Privacy, legal basis, retention, and data-processing terms are approved.
- Public wording distinguishes authenticity from truth and anchor attestation from independence.

### Assessment

Conditional long-term production candidate when partner cooperation, maintainer approval, and every governance gate are available. Not a sufficient starting point by itself, because authenticity and correctness are different properties.

## Approach 2: On-chain payment correlation with Horizon

### Model

StellarCore correlates indexed public Stellar payment operations, accounts, assets, memos, amounts, and ledger timing with a reviewed anchor, corridor, and transfer event. The result is a reproducible public-ledger observation at a stated finality policy that may support or contradict another evidence source. Horizon is an API/indexer, not an authority that proves the business meaning of an operation.

### Advantages

- Public ledger evidence is reproducible by third parties under a stated finality and indexing policy.
- It does not require customer authentication credentials.
- It can identify candidate deposits, withdrawals, refunds, and related on-chain movements for review.
- It provides a useful corroborating artifact for an anchor assertion or reviewer decision.

### Critical limitation

A successful indexed Stellar payment shows that the observed on-chain operation met the network's success condition at the indexed finality point. It does **not** establish that:

- the anchor accepted the intended transfer;
- the off-chain bank, card, mobile-money, or fiat payout was initiated;
- the payout cleared or became irrevocable;
- the customer received the expected amount; or
- a failed off-chain process did not later produce a refund or manual adjustment.

Horizon alone therefore must never produce an unqualified `COMPLETED` transfer outcome.

### Additional limitations

- Amount collisions, deposits mistaken for payouts, batched payments, internal ledger movements, absent memos, and unrelated account activity make correlation ambiguous.
- Horizon does not provide reliable off-chain settlement latency, slippage, or terminal partial/refund semantics by itself.
- A source that reports only on-chain successes can systematically omit off-chain failures and bias the denominator.
- The current repository has no Horizon adapter or reviewed account/asset correlation policy.

### Viability gates

- Reviewed mapping of anchor accounts, assets, and corridors.
- Versioned, testable correlation rules with a labeled false-positive and false-negative corpus.
- Ledger finality, reorganization, replay, and backfill policy.
- A separate authorized source for the off-chain terminal state.
- Privacy and retention policy for public-ledger derived evidence.
- A hard product rule that Horizon produces an `on-chain observation`, never off-chain completion by itself.

### Assessment

Useful corroboration only. Not viable as the sole transfer-outcome source.

## Approach 3: Manual reviewed submissions with an audit trail

### Model

A private submitter provides an evidence bundle for a terminal transfer. Authorized reviewers validate source identity, event identity, status, timestamps, amounts, and the relevant off-chain settlement or transfer evidence. A durable review record preserves the decision, reason, reviewer, evidence hash or protected reference, timestamps, and redactions.

### Advantages

- Reviewers can examine off-chain evidence that public ledger data cannot prove.
- The model is flexible across anchor protocols, rails, and jurisdictions.
- It can begin without an immediate protocol, registry, or production schema change.
- A bounded pilot can reveal real status vocabularies, missing evidence, reporting delays, and systematic failure modes.
- The current three-anchor registry may make a narrow pilot operationally plausible, but registry size alone does not establish reviewer capacity, legal authority, or evidence quality.

### Limitations

- It is slow, labor-intensive, and expensive to scale.
- Source self-certification, reviewer error, bias, collusion, and capacity pressure remain risks.
- Screenshots, bank references, and customer identifiers create privacy, retention, and leak risk.
- Evidence may be unavailable, expire, or impossible to reproduce.
- Manual acceptance is not automatically independent verification.

### Viability gates

- Private intake; no public submission API.
- Defined reviewer roles, separation of duties, conflict-of-interest rules, rejection criteria, and escalation.
- Evidence standard covering source event identity, status, timestamps, amounts, and the off-chain settlement/transfer leg.
- Immutable audit record with evidence hash/reference, actor, decision, reason, and redaction.
- Deduplication, correction, revocation, and backfill policy.
- Access control, encryption, retention/deletion, and legal/privacy review.
- Staffing and service levels sufficient to avoid selective or indefinitely delayed review.
- No production `TransferOutcome` writes until the provenance model is separately approved.

### Assessment

Best starting point for controlled discovery, not a final production trust architecture.

## Approach 4: Third-party escrow or independent settlement attestor

### Model

An independent service either holds funds and records an auditable release, or operates as a settlement attestor with explicit authority over the process it observes. A true escrow provider can create stronger evidence because custody and release are governed independently of the anchor's assertion. An observation-only attestor that merely signs an anchor statement does not create meaningful independence, and even a release artifact does not by itself prove fiat finality or customer receipt.

### Advantages

- True escrow can provide an independently governed release artifact.
- On-chain release events can be transparent and auditable.
- A regulated intermediary may provide stronger dispute resolution and consumer protection.
- Multiple providers could introduce redundancy and competition.

### Limitations

- The model requires new contracts, capital, partner integrations, legal review, and operational ownership.
- Fiat finality may still be unproven if the provider signs its own private-rail observation.
- Key management, outages, collusion, vendor lock-in, fees, latency, liquidity, and jurisdiction are substantial risks.
- Existing Stellar price-oracle integrations do not automatically provide neutral fiat-settlement evidence.
- No escrow or independent settlement-attestor relationship is currently present in the repository.

### Viability gates

- A regulated independent partner with clear authority, liability, and dispute responsibilities.
- Actual custody and release semantics rather than attestor branding alone.
- Independent audits plus enforceable service-level, collateral, or slashing commitments where applicable.
- Strong key management, signer diversity, monitoring, and outage fallback.
- Legal/compliance approval and clear privacy and data-processing terms.
- Sustainable economics and sufficient anchor and customer adoption.
- A defined migration path if the provider ceases operations.

### Assessment

Potential long-term independence improvement, but too complex to recommend as the initial step.

## Comparison

| Dimension | Anchor attestation | Horizon correlation | Manual review | Escrow/attestor |
|---|---|---|---|---|
| Establishes source statement integrity | Yes, if trust binding and signature validation are sound | No | Audit record can | Yes, if trust binding and signature validation are sound |
| Supports a claim about the off-chain leg | Only by source assertion | No | Only after evidence review | Potentially, with real custody/release guarantees |
| Independent of anchor | No | Yes for on-chain facts | Depends on reviewer and evidence | Potentially |
| Works before production automation | Yes | Yes | Yes | No |
| Privacy burden | Low to medium | Low | High | Medium to high |
| Operational burden | Medium | Medium | High initially | Very high |
| Primary failure mode | Anchor lies or omits outcomes | False correlation | Review error, bias, or capacity | Vendor/operator failure or weak independence |
| Recommended role | Conditional long-term candidate | Corroboration only | Starting-point discovery and exception review | Later evaluation |

## Recommendation

### Starting point

Begin with a documentation-first, manually reviewed discovery pilot involving one consenting anchor and one already reviewed corridor. Keep all pilot evidence outside production and do not calculate or publish new reputation results from it.

The pilot should test:

- whether the source can identify every terminal event with a stable ID;
- whether failures are reported as consistently as successes;
- which off-chain evidence is reproducible and necessary;
- how corrections, refunds, and duplicate reports occur;
- how source outages and delayed reporting affect the sample;
- what data can be minimized while preserving a defensible audit trail;
- whether the source is willing and technically able to adopt signed attestations.

### Target architecture

If the pilot succeeds, move toward a hybrid model:

1. The anchor supplies a signed, versioned terminal-outcome attestation.
2. Horizon corroborates the on-chain leg where a reviewed correlation rule exists.
3. Exceptions, conflicts, missing on-chain evidence, and corrections receive human review.
4. Accepted evidence retains source identity, event identity, timestamps, verification state, and correction history.
5. A separately approved implementation projects accepted evidence into the current normalized outcome model and scoring semantics.

### Horizon and escrow sequencing

- Horizon should be added only as corroboration, never as a shortcut to `COMPLETED`.
- A signed-attestation pilot could be considered before manual automation only if maintainers approve it and a willing anchor already satisfies the key, canonicalization, authorization, coverage, replay, privacy, and audit gates.
- Escrow or independent settlement-attestor evaluation should wait until maintainers know the evidence contract and have partner demand, legal feasibility, and a credible independent-custody model.

## Phased plan

### Phase 0: Source qualification and evidence contract

- Define terminology, trust boundaries, source-native status mapping, event identity, event time, ingestion time, corrections, coverage, and publication language.
- Identify accountable maintainers for source qualification, privacy, legal review, security response, and scoring governance.
- Make no application, schema, registry, or ingestion changes.

### Phase 1: Bounded manual discovery

- Use one anchor and one reviewed corridor under a private pilot agreement.
- Apply separation of duties, evidence minimization, encryption, redaction, access controls, deduplication, and append-only tamper-evident review records.
- Keep pilot data outside production and do not expose raw evidence publicly.
- Measure completeness, reproducibility, correction rate, review cost, and failure patterns.

### Phase 2: Signed-attestation pilot

- Replace manual report preparation with signed batches only if the source passes the viability gates.
- Retain review for conflicts, exceptions, key changes, and corrections.
- Use Horizon only to corroborate the on-chain leg.

### Phase 3: Separately approved implementation

A future implementation RFC must decide and test:

- source and event identity fields;
- event time versus ingestion time;
- evidence hashes and protected references;
- verification state and reviewer/action history;
- source coverage and exclusion declarations;
- correction, retraction, and deduplication semantics;
- protected server-side ingestion and credential rotation;
- replay/backfill behavior and scoring eligibility;
- schema migration, observability, incident response, and security review.

This RFC does not authorize any of those changes.

### Phase 4: Escrow or independent-settlement evaluation

Proceed only if maintainers identify a partner that supplies real custody/release or independently enforceable settlement guarantees, along with acceptable privacy, legal, resilience, and economic terms.

## Open maintainer decisions

1. What minimum evidence standard applies to each normalized terminal status?
2. Can any source be described as independent, and under what governance test?
3. Which source event ID and version are stable across retries, corrections, and backfills?
4. How should late events and backfills affect the 90-day scoring window?
5. What evidence is necessary, and what customer data must never be persisted?
6. Who can review, reverse, or suspend acceptance?
7. How will source completeness and exclusions be represented and published?
8. What minimum source coverage is required before an anchor may receive a score?
9. What incident and revocation process applies to compromised signing keys or incorrect bulk reports?
10. Should the current status semantics remain unchanged, or should a future scoring RFC revisit them separately?

## Acceptance and go/no-go checklist

A future implementation should not begin unless maintainers can answer yes to all of the following:

- [ ] At least one source is authorized and contractually able to report complete terminal outcomes.
- [ ] Stable source event identity, version, and deduplication are defined.
- [ ] Event time, ingestion time, correction, and backfill semantics are approved.
- [ ] Evidence, signature, review, and correction provenance can be retained securely.
- [ ] Privacy, legal basis, retention, deletion, and access controls are approved.
- [ ] Failure and exclusion reporting cannot be selectively omitted without disclosure.
- [ ] Horizon is constrained to on-chain corroboration and cannot independently produce off-chain completion.
- [ ] Public language accurately reflects source and verification strength.
- [ ] Scoring eligibility and provenance-aware publication policy receive separate approval.
- [ ] Operational owners, service levels, monitoring, rollback, and incident response are funded and assigned.

## Conclusion

StellarCore's immediate need is not a faster parser or an inferred on-chain outcome. It needs a defensible chain of authority, evidence, review, and correction. A bounded manual discovery pilot is the lowest-regret way to learn those requirements without turning a sparse data model into a public trust claim. Anchor-signed attestations are a conditional production candidate if maintainers approve the model, partner commitments are credible, and every governance gate succeeds, with Horizon used only for the leg it can actually observe. Escrow or an independent settlement attestor remains a later option whose value depends on real independence rather than naming or signature alone.

## Repository references

- [`README.md`](../README.md) — architectural invariants, current production state, reputation semantics, and public API boundaries
- [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) — production boundaries and scheduled refresh behavior
- [`prisma/schema.prisma`](../prisma/schema.prisma) — current `TransferOutcome` and reputation persistence models
- [`lib/reputation/repository.ts`](../lib/reputation/repository.ts) — current evidence read projection
- [`lib/reputation/score.ts`](../lib/reputation/score.ts) — current status, window, threshold, and metric semantics
- [`lib/scheduled/refresh.ts`](../lib/scheduled/refresh.ts) — current rate and reputation refresh orchestration
- [`AGENTS.md`](../AGENTS.md) — repository architecture and security guidelines

## External protocol references

- [Stellar Info File (SEP-1)](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep1)
- [Hosted Deposits and Withdrawals (SEP-24)](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep24/integration)
- [Cross-Border Payments (SEP-31)](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31)
- [Horizon API reference](https://developers.stellar.org/docs/data/apis/horizon/api-reference)
- [Stellar ecosystem oracle overview](https://github.com/stellar/ecosystem-resources/blob/main/oracles/README.md)
