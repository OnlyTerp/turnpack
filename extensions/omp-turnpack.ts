/**
 * Optional Tier-1 OMP (oh-my-pi) ExtensionAPI plugin for Turnpack.
 * Never registers before_agent_start hooks, so system prompt and prompt prefix stay untouched.
 */

interface OmpEvent {
  toolName?: string;
}

interface OmpContext {
  ui?: {
    setStatus?: (key: string, text: string | undefined) => void;
  };
}

interface OmpApi {
  on: (event: string, handler: (event: OmpEvent, ctx: OmpContext) => void | Promise<void>) => void;
}

export default function turnpackExtension(pi: OmpApi): void {
  let microBurst = 0;

  pi.on("session_start", (_event, ctx) => {
    microBurst = 0;
    ctx.ui?.setStatus?.("turnpack", "turnpack ready");
  });

  pi.on("tool_result", (event, ctx) => {
    const name = String(event.toolName || "");
    // The single-file tools. `eval` is left out: one eval is already a batch.
    if (["read", "grep", "glob", "find", "edit", "write"].includes(name)) {
      microBurst += 1;
    } else if (name.includes("turnpack") || /(^|_)(pack|ship|batch)$/.test(name)) {
      microBurst = 0;
    }

    if (microBurst >= 4) {
      ctx.ui?.setStatus?.("turnpack", "tip: use pack/ship for multi-file batches");
    }
  });
}
