import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  type AppliedMigration,
  MAX_SUPPORTED_SCHEMA_VERSION,
  MigrationHistoryError,
  SCHEMA_MIGRATIONS,
  validateMigrationHistory,
} from '../db/migrations/manifest.js'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { computedBaselineMigrationChecksum } = await import('../db/migrate.js')
const { normalizedConversationMembersChecksum } = await import('../db/migrations/0002-normalized-conversation-members.js')
const { workspaceCleanupJobsChecksum } = await import('../db/migrations/0003-workspace-cleanup-jobs.js')
const { agentRuntimeAssignmentChecksum } = await import('../db/migrations/0004-agent-runtime-assignment.js')
const { searchTrigramIndexChecksum } = await import('../db/migrations/0005-search-trigram-index.js')
const { emailMessagesCompanySmtpIdChecksum } = await import('../db/migrations/0006-email-messages-company-smtp-id.js')
const { organizationalGovernanceChecksum } = await import('../db/migrations/0007-organizational-governance.js')
const { governanceIdempotencyChecksum } = await import('../db/migrations/0008-governance-idempotency.js')
const { governanceInvariantsChecksum } = await import('../db/migrations/0009-governance-invariants.js')
const { governanceBudgetSettlementChecksum } = await import('../db/migrations/0010-governance-budget-settlement.js')
const { governanceMembershipHistoryChecksum } = await import('../db/migrations/0011-governance-membership-history.js')
const { engineDefaultsChecksum } = await import('../db/migrations/0012-engine-defaults.js')
const { agentProviderProfileChecksum } = await import('../db/migrations/0013-agent-provider-profile.js')
const { agentRoutingClaimsChecksum } = await import('../db/migrations/0014-agent-routing-claims.js')
const { channelTaskExecutionChecksum } = await import('../db/migrations/0015-channel-task-execution.js')
const { taskExecutorFencesChecksum } = await import('../db/migrations/0016-task-executor-fences.js')
const { taskLifecycleChecksum } = await import('../db/migrations/0018-task-lifecycle.js')
const { taskDefinitionSnapshotsChecksum } = await import('../db/migrations/0019-task-definition-snapshots.js')
const { configurationWorkbenchChecksum } = await import('../db/migrations/0020-configuration-workbench.js')
const { agentQuoteContextChecksum } = await import('../db/migrations/0022-agent-quote-context.js')
const { threadAgentCoordinationChecksum } = await import('../db/migrations/0023-thread-agent-coordination.js')
const { aidaMessageRoutingChecksum } = await import('../db/migrations/0021-aida-message-routing.js')
const { taskSourceAndGovernanceLinksChecksum } = await import('../db/migrations/0017-task-source-and-governance-links.js')
const { verifySchemaCompatibility } = await import('../db/schema-version.js')
type SchemaVersionQueryable = import('../db/schema-version.js').SchemaVersionQueryable

const current = (): AppliedMigration[] => SCHEMA_MIGRATIONS.map((migration) => ({ ...migration }))

test('the frozen baseline SQL matches its immutable manifest checksum', () => {
  assert.equal(computedBaselineMigrationChecksum(), SCHEMA_MIGRATIONS[0].checksum)
})

test('the normalized membership migration matches its immutable manifest checksum', () => {
  assert.equal(normalizedConversationMembersChecksum(), SCHEMA_MIGRATIONS[1].checksum)
})

test('the workspace cleanup migration matches its immutable manifest checksum', () => {
  assert.equal(workspaceCleanupJobsChecksum(), SCHEMA_MIGRATIONS[2].checksum)
})

test('the runtime assignment migration matches its immutable manifest checksum', () => {
  assert.equal(agentRuntimeAssignmentChecksum(), SCHEMA_MIGRATIONS[3].checksum)
})

test('the search trigram migration matches its immutable manifest checksum', () => {
  assert.equal(searchTrigramIndexChecksum(), SCHEMA_MIGRATIONS[4].checksum)
})

test('the email messages company smtp id migration matches its immutable manifest checksum', () => {
  assert.equal(emailMessagesCompanySmtpIdChecksum(), SCHEMA_MIGRATIONS[5].checksum)
})

test('the organizational governance migration matches its immutable manifest checksum', () => {
  assert.equal(organizationalGovernanceChecksum(), SCHEMA_MIGRATIONS[6].checksum)
})

test('the governance idempotency migration matches its immutable manifest checksum', () => {
  assert.equal(governanceIdempotencyChecksum(), SCHEMA_MIGRATIONS[7].checksum)
})

test('the governance invariant migration matches its immutable manifest checksum', () => {
  assert.equal(governanceInvariantsChecksum(), SCHEMA_MIGRATIONS[8].checksum)
})

test('the governance budget settlement migration matches its immutable manifest checksum', () => {
  assert.equal(governanceBudgetSettlementChecksum(), SCHEMA_MIGRATIONS[9].checksum)
})

test('the governance membership-history migration matches its immutable manifest checksum', () => {
  assert.equal(governanceMembershipHistoryChecksum(), SCHEMA_MIGRATIONS[10].checksum)
})

test('the engine defaults migration matches its immutable manifest checksum', () => {
  assert.equal(engineDefaultsChecksum(), SCHEMA_MIGRATIONS[11].checksum)
})

test('the agent provider profile migration matches its immutable manifest checksum', () => {
  assert.equal(agentProviderProfileChecksum(), SCHEMA_MIGRATIONS[12].checksum)
})

test('the agent routing claims migration matches its immutable manifest checksum', () => {
  assert.equal(agentRoutingClaimsChecksum(), SCHEMA_MIGRATIONS[13].checksum)
})

test('task and routing migrations match checksums; the migrator accepts earlier prefixes', () => {
  assert.equal(channelTaskExecutionChecksum(), SCHEMA_MIGRATIONS[14].checksum)
  assert.equal(taskExecutorFencesChecksum(), SCHEMA_MIGRATIONS[15].checksum)
  assert.equal(taskSourceAndGovernanceLinksChecksum(), SCHEMA_MIGRATIONS[16].checksum)
  assert.equal(taskLifecycleChecksum(), SCHEMA_MIGRATIONS[17].checksum)
  assert.equal(taskDefinitionSnapshotsChecksum(), SCHEMA_MIGRATIONS[18].checksum)
  assert.equal(configurationWorkbenchChecksum(), SCHEMA_MIGRATIONS[19].checksum)
  assert.equal(aidaMessageRoutingChecksum(), SCHEMA_MIGRATIONS[20].checksum)
  assert.equal(agentQuoteContextChecksum(), SCHEMA_MIGRATIONS[21].checksum)
  assert.equal(threadAgentCoordinationChecksum(), SCHEMA_MIGRATIONS[22].checksum)
  assert.throws(() => validateMigrationHistory(current().slice(0, 22)), (error) => error instanceof MigrationHistoryError)
  assert.throws(() => validateMigrationHistory(current().slice(0, 21)), (error) => error instanceof MigrationHistoryError)
  assert.equal(validateMigrationHistory(current().slice(0, 14), { allowPending: true }).currentVersion, 14)
  assert.throws(() => validateMigrationHistory(current().slice(0, 20)), (error) => error instanceof MigrationHistoryError)
})

test('the migration owner accepts an exact prefix and reports its pending suffix', () => {
  const empty = validateMigrationHistory([], { allowPending: true })
  assert.equal(empty.currentVersion, 0)
  assert.deepEqual(empty.pending, SCHEMA_MIGRATIONS)

  const complete = validateMigrationHistory(current(), { allowPending: true })
  assert.equal(complete.currentVersion, MAX_SUPPORTED_SCHEMA_VERSION)
  assert.deepEqual(complete.pending, [])
})

test('application startup rejects uninitialized, changed, and newer histories', () => {
  assert.throws(
    () => validateMigrationHistory([]),
    (err) => err instanceof MigrationHistoryError && err.code === 'schema_uninitialized',
  )
  assert.throws(
    () => validateMigrationHistory([{ ...current()[0], checksum: '0'.repeat(64) }]),
    (err) => err instanceof MigrationHistoryError && err.code === 'migration_history_invalid',
  )
  assert.throws(
    () => validateMigrationHistory([
      ...current(),
      { version: MAX_SUPPORTED_SCHEMA_VERSION + 1, name: 'future', checksum: 'f'.repeat(64) },
    ]),
    (err) => err instanceof MigrationHistoryError && err.code === 'schema_ahead',
  )
})

test('startup compatibility verification is a read-only ledger query', async () => {
  const statements: string[] = []
  const queryable: SchemaVersionQueryable = {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> {
      statements.push(sql)
      return { rows: current() as unknown as T[], rowCount: current().length } as QueryResult<T>
    },
  }

  assert.equal(await verifySchemaCompatibility(queryable), MAX_SUPPORTED_SCHEMA_VERSION)
  assert.equal(statements.length, 1)
  assert.match(statements[0], /^SELECT\s/i)
  assert.doesNotMatch(statements[0], /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i)
})

test('a missing schema_migrations table becomes an actionable startup error', async () => {
  const queryable: SchemaVersionQueryable = {
    async query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> {
      const err = new Error('relation schema_migrations does not exist') as Error & { code: string }
      err.code = '42P01'
      throw err
    },
  }
  await assert.rejects(
    () => verifySchemaCompatibility(queryable),
    (err) => err instanceof MigrationHistoryError && err.code === 'schema_uninitialized',
  )
})
