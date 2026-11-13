export { runPack, type PackArgs, type PackFileSpec, type ClientContext } from "./tools/pack.js";
export {
  isVerifyAllowed,
  runShip,
  type ShipArgs,
  type ShipEditChange,
  type ShipEditOp,
  type ShipInternalOptions,
  type ShipMoveOp,
  type ShipResult,
  type ShipStatus,
  type ShipWriteOp,
  type RestoreOps,
} from "./tools/ship.js";
export {
  runBatch,
  runBatchDetailed,
  type BatchArgs,
  type BatchCtx,
  type BatchIsolation,
  type BatchOutcome,
} from "./tools/batch.js";
export {
  getShardCacheDir,
  isInsideDir,
  isProtectedPath,
  isSecretPath,
  resolveSafePath,
  resolveWorkspaceRoot,
  writePrivateShard,
  type SafePathResult,
} from "./security.js";
export {
  applyClientRoots,
  configScope,
  createRootPolicy,
  isBroadDirectory,
  resolveToolRoot,
  type RootPolicy,
} from "./roots.js";
export { describeChecks, detectChecks, type ProjectCheck } from "./checks.js";
export { applySearchReplace, type EditOutcome, type MatchHow } from "./tools/edit-match.js";
export {
  SERVER_INSTRUCTIONS,
  TOOLS,
  listTools,
  serverInstructions,
  resolveClientContext,
  startMcpServer,
  type McpServerOptions,
  type McpToolDefinition,
} from "./mcp-server.js";
export { VERSION } from "./version.js";
export { serverCommand } from "./cli/installer.js";
