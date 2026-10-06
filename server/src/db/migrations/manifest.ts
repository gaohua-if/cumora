/**
 * Immutable database-migration ledger understood by this application build.
 *
 * Append new entries; never edit or reorder an applied entry. The checksum is
 * stored in PostgreSQL and compared on every migration run and application
 * startup, so changing historical SQL fails closed instead of silently
 * redefining what an old version meant.
 */
export interface MigrationMetadata {
  version: number
  name: string
  checksum: string
}

export interface AppliedMigration extends MigrationMetadata {
  applied_at?: Date | string
}

export const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: '0001_legacy_baseline',
    checksum: '5250b63e17bb5a028483b72a799b868418b875e7c0802be4168175b9930aa7d0',
  },
  {
    version: 2,
    name: '0002_normalized_conversation_members',
    checksum: '489abe15a28b6c1ee11e7a3e03f79c2949574687333de1d97e7b7eff33c6d2b3',
  },
  {
    version: 3,
    name: '0003_workspace_cleanup_jobs',
    checksum: 'cd4047a09fb585ba166e7e0a48a21169168da567728dcb63ae8e6ff5bd204d89',
  },
  {
    version: 4,
    name: '0004_agent_runtime_assignment',
    checksum: '59956150df026c36238298603ed47438abf154cfc779034758d7141a79ae00b2',
  },
  {
    version: 5,
    name: '0005_search_trigram_index',
    checksum: 'eac389304940a9af260ebc51e13b97f5d0d9d0148460debceaf328d8bbcd76f2',
  },
  {
    version: 6,
    name: '0006_email_messages_company_smtp_id',
    checksum: 'a4a37d6d293f4b36eca5471f20ba3a6e5e40d8c15435133843ef9cb28a636331',
  },
  {
    version: 7,
    name: '0007_organizational_governance',
    checksum: '34a4e3c40b06d07265962337be98be9d9d2c9c289d78c32d9fc57e77ffc2637e',
  },
  {
    version: 8,
    name: '0008_governance_idempotency',
    checksum: '7a40750c1859071285a64c663dad8197937818eee72160924f1998f1677c0c47',
  },
  {
    version: 9,
    name: '0009_governance_invariants',
    checksum: 'a85d78aa39bd47d7e6072e3d65533ed8c23de88bce17421c315919b509eeb37a',
  },
  {
    version: 10,
    name: '0010_governance_budget_settlement',
    checksum: '06c2814b248f53af314d26bd2275a1b39b4b46ffb269a5a6ba287d7b58c48a39',
  },
  {
    version: 11,
    name: '0011_governance_membership_history',
    checksum: 'd60384f35e0f4205163ec04965c2fa411b37c8f378dcf8dc5c584a0cd23f92bc',
  },
  {
    version: 12,
    name: '0012_engine_defaults',
    checksum: '1d81ce74821ff467e73feac0d8116520c742775b7ef31badab22480e7c679632',
  },
  {
    version: 13,
    name: '0013_agent_provider_profile',
    checksum: '8816423a0ad867d4781c6a9e323e6e34ecadca0ecaf82bd0b9541f164a199fa0',
  },
  {
    version: 14,
    name: '0014_agent_routing_claims',
    checksum: '2bf97e295fef3fa7e42cdc476867e89b4d9c976362dfad7e7256bf74308c30fc',
  },
  {
    version: 15,
    name: '0015_channel_task_execution',
    checksum: '0a7de9da13e1f04d1925151ea47c516b9f53e0a16065dde2e02effd92eccbf4c',
  },
  { version: 16, name: '0016_task_executor_fences', checksum: '6213d837322fe5f5891eb280088b3e91c2480d69434d6025df1bbd6ef17db3f1' },
  { version: 17, name: '0017_task_source_and_governance_links', checksum: 'd771ea49796bcbce59db2c1cb7b28fc297d736f99b866b86b37e9094c07d7563' },
  { version: 18, name: '0018_task_lifecycle', checksum: '7eeecb2e7e42c56329e9b3236c1494fc79401b74fd9472917923325a254421ec' },
  { version: 19, name: '0019_task_definition_snapshots', checksum: '646162621abd01727e41be3354ecce7e71fc7bf42281eccfad36b72e5bb5374f' },
  { version: 20, name: '0020_configuration_workbench', checksum: '41871132f398ac3989a0e29c177694d18f919b469c9017c79a2f40f9b9399be1' },
] as const satisfies readonly MigrationMetadata[]

/** This build intentionally supports one exact schema range. Expand/contract
 * releases may widen the range, but both bounds must remain explicit. */
export const MIN_SUPPORTED_SCHEMA_VERSION = 14
export const MAX_SUPPORTED_SCHEMA_VERSION = 20

function assertManifestShape(): void {
  for (let i = 0; i < SCHEMA_MIGRATIONS.length; i++) {
    const migration = SCHEMA_MIGRATIONS[i]
    if (migration.version !== i + 1) throw new Error('schema migration versions must be contiguous from 1')
    if (!/^\d{4}_[a-z0-9_]+$/.test(migration.name)) throw new Error(`invalid migration name: ${migration.name}`)
    if (!/^[a-f0-9]{64}$/.test(migration.checksum)) throw new Error(`invalid migration checksum: ${migration.name}`)
  }
  if (MAX_SUPPORTED_SCHEMA_VERSION !== SCHEMA_MIGRATIONS.at(-1)?.version) {
    throw new Error('maximum supported schema version must match the manifest tip')
  }
  if (MIN_SUPPORTED_SCHEMA_VERSION < 1 || MIN_SUPPORTED_SCHEMA_VERSION > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new Error('invalid supported schema version range')
  }
}

assertManifestShape()

export class MigrationHistoryError extends Error {
  readonly code: 'schema_uninitialized' | 'schema_behind' | 'schema_ahead' | 'migration_history_invalid'

  constructor(
    code: MigrationHistoryError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'MigrationHistoryError'
    this.code = code
  }
}

export interface MigrationHistoryState {
  currentVersion: number
  pending: readonly MigrationMetadata[]
}

/**
 * Validate that the persisted ledger is an exact, contiguous prefix of this
 * build's immutable manifest. Migrators may accept a pending suffix; normal
 * application startup requires the supported range to already be present.
 */
export function validateMigrationHistory(
  appliedRows: readonly AppliedMigration[],
  opts: { allowPending?: boolean } = {},
): MigrationHistoryState {
  const applied = [...appliedRows].sort((a, b) => a.version - b.version)

  if ((applied.at(-1)?.version ?? 0) > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${applied.at(-1)?.version} is newer than this application supports (${MAX_SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  if (applied.length > SCHEMA_MIGRATIONS.length) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${applied.at(-1)?.version ?? 'unknown'} is newer than this application supports (${MAX_SUPPORTED_SCHEMA_VERSION})`,
    )
  }

  for (let i = 0; i < applied.length; i++) {
    const actual = applied[i]
    const expected = SCHEMA_MIGRATIONS[i]
    if (!expected || actual.version !== expected.version) {
      throw new MigrationHistoryError(
        'migration_history_invalid',
        `migration history is not a contiguous prefix at position ${i + 1}`,
      )
    }
    if (actual.name !== expected.name || actual.checksum !== expected.checksum) {
      throw new MigrationHistoryError(
        'migration_history_invalid',
        `migration ${actual.version} does not match immutable manifest metadata`,
      )
    }
  }

  const currentVersion = applied.at(-1)?.version ?? 0
  const pending = SCHEMA_MIGRATIONS.slice(applied.length)
  if (opts.allowPending) return { currentVersion, pending }

  if (currentVersion === 0) {
    throw new MigrationHistoryError(
      'schema_uninitialized',
      'database schema is uninitialized; run `npm run migrate` before starting the server',
    )
  }
  if (currentVersion < MIN_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_behind',
      `database schema version ${currentVersion} is behind the supported range ${MIN_SUPPORTED_SCHEMA_VERSION}-${MAX_SUPPORTED_SCHEMA_VERSION}; run ` +
        '`npm run migrate` before starting the server',
    )
  }
  if (currentVersion > MAX_SUPPORTED_SCHEMA_VERSION) {
    throw new MigrationHistoryError(
      'schema_ahead',
      `database schema version ${currentVersion} is newer than the supported range ${MIN_SUPPORTED_SCHEMA_VERSION}-${MAX_SUPPORTED_SCHEMA_VERSION}`,
    )
  }

  return { currentVersion, pending }
}
