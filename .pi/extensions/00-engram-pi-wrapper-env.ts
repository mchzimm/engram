/**
 * Project-local shim that tunes the global engram-pi-wrapper extension.
 *
 * The global wrapper reads ENGRAM_LEARN_TIMEOUT_MS at module load time.
 * Setting it here lets this project use a longer /learn timeout on the
 * larger engramx graph without requiring a manual edit in every local PI
 * install.
 */
process.env.ENGRAM_LEARN_TIMEOUT_MS ??= "30000";

export default function () {
  // No-op: this extension exists only to seed env vars for later extensions.
}
