import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type TUI, getCapabilities, getImageDimensions, renderImage, allocateImageId, deleteKittyImage, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- Types ---

type EmoteState = "hi" | "idle" | "think" | "talk" | "read" | "write" | "tool" | "success" | "failure" | "compact";

interface Config {
  enabled: boolean;
  size: number;
  readingSpeed: number;
  hideBelow: number;
  holdDuration: { hi: number; success: number; failure: number };
  blinkInterval: [number, number];
  talkTickMs: number;
  cycleMs: number;
}

interface EmotesConfig {
  idle?: { default?: string; blink?: string };
  think?: { default?: string; hard?: string };
  talk?: { weights?: Record<string, number> };
}

interface FrameSet {
  files: string[];
  base64Cache: Map<string, string>;
}

// --- Helpers ---

function loadConfig(extDir: string): Config {
  const configPath = join(extDir, "config.json");
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }
  return {
    enabled: true,
    size: 8,
    readingSpeed: 4,
    hideBelow: 80,
    holdDuration: { hi: 2000, success: 1200, failure: 1200 },
    blinkInterval: [3000, 6000],
    talkTickMs: 120,
    cycleMs: 500,
  };
}

function loadEmotesConfig(extDir: string): EmotesConfig {
  const emotesConfigPath = join(extDir, "emotes", "emotes.json");
  if (existsSync(emotesConfigPath)) {
    return JSON.parse(readFileSync(emotesConfigPath, "utf-8"));
  }
  return {};
}

function discoverFrames(extDir: string): Map<string, FrameSet> {
  const emotesDir = join(extDir, "emotes");
  const frameMap = new Map<string, FrameSet>();
  const states: EmoteState[] = ["hi", "idle", "think", "talk", "read", "write", "tool", "success", "failure", "compact"];

  for (const state of states) {
    const stateDir = join(emotesDir, state);
    if (!existsSync(stateDir)) continue;

    const files = readdirSync(stateDir).filter((f) => f.endsWith(".png")).sort();
    const base64Cache = new Map<string, string>();

    for (const file of files) {
      const data = readFileSync(join(stateDir, file));
      base64Cache.set(file, data.toString("base64"));
    }

    frameMap.set(state, { files, base64Cache });
  }

  return frameMap;
}

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function weightedRandomPick(weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [file, weight] of entries) {
    r -= weight;
    if (r <= 0) return file;
  }
  return entries[entries.length - 1]![0];
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const extDir = dirname(__dirname);
  const config = loadConfig(extDir);

  if (!config.enabled) return;

  const emotesConfig = loadEmotesConfig(extDir);
  const frameMap = discoverFrames(extDir);

  // Rendering state
  let tuiRef: TUI | null = null;
  let widgetActive = false;
  let imageRows = 0;
  let pendingTransmit: string | null = null;
  let replotSequence: string | null = null;
  let lastShownBase64: string | null = null;
  let ctxRef: any = null; // captured ExtensionContext for stats access
  const emoteImageId = allocateImageId();

  // State machine
  let currentState: EmoteState = "idle";
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let blinkTimer: ReturnType<typeof setTimeout> | null = null;
  let talkTimer: ReturnType<typeof setInterval> | null = null;
  let cycleTimer: ReturnType<typeof setInterval> | null = null;
  let cycleIndex = 0;
  let cycleDirection = 1;

  // Think animation state
  let thinkTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkBaseFrame: string | null = null;

  // Hold state: what to transition to after hold expires
  let holdNextState: EmoteState = "idle";

  // Talk state
  let talkWordCount = 0;
  let talkStartTime = 0;
  let lastTokenTime = 0;
  let talkMouthClosed = false;
  let talkGapTimer: ReturnType<typeof setTimeout> | null = null;
  let talkDurationTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Core rendering ---

  function showImage(base64: string, force = false) {
    // Skip if same image already shown (avoid unnecessary re-renders)
    if (!force && base64 === lastShownBase64) return;
    lastShownBase64 = base64;

    const caps = getCapabilities();
    if (!caps.images) return;

    const dimensions = getImageDimensions(base64, "image/png") ?? { widthPx: 510, heightPx: 510 };
    const result = renderImage(base64, dimensions, {
      maxWidthCells: config.size,
      imageId: emoteImageId,
    });

    if (result) {
      // Transmit-only: change a=T (transmit+display) to a=t (transmit, no display).
      // Re-transmitting with the same ID deletes old data + placements (per Kitty spec).
      // The placement command below immediately re-creates the placement in the same render.
      const transmitSeq = result.sequence.replace("a=T", "a=t");
      // Lightweight placement command with fixed placement ID.
      // Kitty replaces existing placement p=1, so no delete needed.
      // C=1 prevents cursor movement after placement (avoids scrolling at bottom of screen).
      const placeSeq = `\x1b_Ga=p,i=${emoteImageId},p=1,c=${config.size},r=${result.rows},C=1,q=2\x1b\\`;

      // One-shot: upload new data (emitted once per frame change)
      pendingTransmit = transmitSeq;
      // Reusable: lightweight re-place at current widget position (emitted every render)
      replotSequence = placeSeq;
      imageRows = result.rows;
    } else {
      pendingTransmit = null;
      replotSequence = null;
      imageRows = 0;
    }
    tuiRef?.requestRender();
  }

  // --- Frame access ---

  function getFrame(state: EmoteState, filename: string): string | null {
    const frameSet = frameMap.get(state);
    if (!frameSet) return null;
    return frameSet.base64Cache.get(filename) ?? null;
  }

  function getRandomFrame(state: EmoteState): string | null {
    const frameSet = frameMap.get(state);
    if (!frameSet || frameSet.files.length === 0) return null;
    const file = randomPick(frameSet.files);
    return frameSet.base64Cache.get(file) ?? null;
  }

  function getTalkFrame(): string | null {
    const frameSet = frameMap.get("talk");
    if (!frameSet || frameSet.files.length === 0) return null;

    if (emotesConfig.talk?.weights) {
      const file = weightedRandomPick(emotesConfig.talk.weights);
      return frameSet.base64Cache.get(file) ?? getRandomFrame("talk");
    }
    return getRandomFrame("talk");
  }

  function getTalkCloseFrame(): string | null {
    const frameSet = frameMap.get("talk");
    if (!frameSet) return null;
    const closeFile = frameSet.files.find((f) => f.includes("close"));
    if (closeFile) return frameSet.base64Cache.get(closeFile) ?? null;
    return frameSet.base64Cache.get(frameSet.files[0]!) ?? null;
  }

  function getCycleFrame(state: EmoteState): string | null {
    const frameSet = frameMap.get(state);
    if (!frameSet || frameSet.files.length === 0) return null;
    const file = frameSet.files[cycleIndex % frameSet.files.length]!;
    return frameSet.base64Cache.get(file) ?? null;
  }

  // --- Timer management ---

  function clearAllTimers() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; }
    if (talkTimer) { clearInterval(talkTimer); talkTimer = null; }
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
    if (talkGapTimer) { clearTimeout(talkGapTimer); talkGapTimer = null; }
    if (talkDurationTimer) { clearTimeout(talkDurationTimer); talkDurationTimer = null; }
    if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
  }

  function clearStateTimers() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (talkTimer) { clearInterval(talkTimer); talkTimer = null; }
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
    if (talkGapTimer) { clearTimeout(talkGapTimer); talkGapTimer = null; }
    if (talkDurationTimer) { clearTimeout(talkDurationTimer); talkDurationTimer = null; }
    if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
  }

  // --- State transitions ---

  function transitionTo(state: EmoteState) {
    if (!widgetActive) return;
    clearStateTimers();
    if (currentState === "idle" && blinkTimer) {
      clearTimeout(blinkTimer);
      blinkTimer = null;
    }
    currentState = state;

    switch (state) {
      case "hi": enterHi(); break;
      case "idle": enterIdle(); break;
      case "think": enterThink(); break;
      case "talk": enterTalk(); break;
      case "read":
      case "write":
      case "tool": enterCycle(state); break;
      case "success": enterHold(state, config.holdDuration.success, holdNextState); holdNextState = "idle"; break;
      case "failure": enterHold(state, config.holdDuration.failure, holdNextState); holdNextState = "idle"; break;
      case "compact": enterCompact(); break;
    }
  }

  function enterHi() {
    const frame = getRandomFrame("hi");
    if (frame) showImage(frame);
    holdTimer = setTimeout(() => transitionTo("idle"), config.holdDuration.hi);
  }

  function enterIdle() {
    const defaultFile = emotesConfig.idle?.default ?? "idle.png";
    const frame = getFrame("idle", defaultFile);
    if (frame) showImage(frame);
    scheduleBlink();
  }

  function scheduleBlink() {
    if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; }
    const delay = randomInRange(config.blinkInterval[0], config.blinkInterval[1]);
    blinkTimer = setTimeout(() => {
      if (currentState !== "idle") return;
      doBlink();
    }, delay);
  }

  function doBlink() {
    const blinkFile = emotesConfig.idle?.blink ?? "idle_blink.png";
    const blinkFrame = getFrame("idle", blinkFile);
    if (!blinkFrame) { scheduleBlink(); return; }

    showImage(blinkFrame);

    const doubleBlink = Math.random() < 0.15;
    const blinkDuration = 150;

    setTimeout(() => {
      if (currentState !== "idle") return;
      const defaultFile = emotesConfig.idle?.default ?? "idle.png";
      const defaultFrame = getFrame("idle", defaultFile);
      if (defaultFrame) showImage(defaultFrame, true);

      if (doubleBlink) {
        setTimeout(() => {
          if (currentState !== "idle") return;
          showImage(blinkFrame, true);
          setTimeout(() => {
            if (currentState !== "idle") return;
            if (defaultFrame) showImage(defaultFrame, true);
            scheduleBlink();
          }, blinkDuration);
        }, 100);
      } else {
        scheduleBlink();
      }
    }, blinkDuration);
  }

  function enterThink() {
    const defaultFile = emotesConfig.think?.default ?? "think.png";
    thinkBaseFrame = getFrame("think", defaultFile);
    if (thinkBaseFrame) showImage(thinkBaseFrame);
    scheduleThinkSwap();
  }

  function scheduleThinkSwap() {
    if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
    const delay = randomInRange(config.blinkInterval[0], config.blinkInterval[1]);
    thinkTimer = setTimeout(() => {
      if (currentState !== "think") return;
      doThinkSwap();
    }, delay);
  }

  function doThinkSwap() {
    const hardFile = emotesConfig.think?.hard ?? "think_hard.png";
    const hardFrame = getFrame("think", hardFile);
    if (!hardFrame) { scheduleThinkSwap(); return; }

    showImage(hardFrame, true);

    // Hold hard-think briefly, then return to default
    setTimeout(() => {
      if (currentState !== "think") return;
      if (thinkBaseFrame) showImage(thinkBaseFrame, true);
      scheduleThinkSwap();
    }, 800);
  }

  function enterTalk() {
    talkWordCount = 0;
    talkStartTime = Date.now();
    lastTokenTime = Date.now();
    talkMouthClosed = false;

    const frame = getTalkFrame();
    if (frame) showImage(frame);

    talkTimer = setInterval(() => {
      if (currentState !== "talk") return;
      if (talkMouthClosed) {
        const closeFrame = getTalkCloseFrame();
        if (closeFrame) showImage(closeFrame);
      } else {
        const f = getTalkFrame();
        if (f) showImage(f);
      }
    }, config.talkTickMs);
  }

  function onTalkToken(text: string) {
    if (currentState !== "talk") return;

    const words = text.split(/\s+/).filter((w) => w.length > 0).length;
    talkWordCount += words;
    lastTokenTime = Date.now();

    if (talkMouthClosed) {
      talkMouthClosed = false;
    }

    // Reset gap timer
    if (talkGapTimer) { clearTimeout(talkGapTimer); talkGapTimer = null; }
    talkGapTimer = setTimeout(() => {
      if (currentState !== "talk") return;
      talkMouthClosed = true;
    }, 200);

    // Recalculate duration
    recalculateTalkDuration();
  }

  function recalculateTalkDuration() {
    if (talkDurationTimer) { clearTimeout(talkDurationTimer); talkDurationTimer = null; }

    const targetDurationMs = (talkWordCount / config.readingSpeed) * 1000;
    const elapsed = Date.now() - talkStartTime;
    const remaining = Math.max(0, targetDurationMs - elapsed);

    talkDurationTimer = setTimeout(() => {
      if (currentState !== "talk") return;
      const timeSinceLastToken = Date.now() - lastTokenTime;
      if (timeSinceLastToken > 200) {
        transitionTo("idle");
      } else {
        // Tokens still flowing, re-check in 200ms
        talkDurationTimer = setTimeout(() => {
          if (currentState === "talk") transitionTo("idle");
        }, 200);
      }
    }, remaining);
  }

  function endTalk() {
    if (currentState !== "talk") return;
    const targetDurationMs = (talkWordCount / config.readingSpeed) * 1000;
    const elapsed = Date.now() - talkStartTime;
    if (elapsed >= targetDurationMs) {
      transitionTo("idle");
    }
    // Otherwise talkDurationTimer will handle it
  }

  function enterCycle(state: EmoteState) {
    cycleIndex = 0;
    cycleDirection = 1;
    const frame = getCycleFrame(state);
    if (frame) showImage(frame);

    const frameSet = frameMap.get(state);
    if (!frameSet || frameSet.files.length <= 1) return;

    cycleTimer = setInterval(() => {
      if (currentState !== state) return;
      cycleIndex += cycleDirection;
      if (cycleIndex >= frameSet.files.length - 1) cycleDirection = -1;
      if (cycleIndex <= 0) cycleDirection = 1;
      const f = getCycleFrame(state);
      if (f) showImage(f);
    }, config.cycleMs);
  }

  function enterHold(state: EmoteState, duration: number, nextState: EmoteState = "idle") {
    const frame = getRandomFrame(state);
    if (frame) showImage(frame);
    holdTimer = setTimeout(() => transitionTo(nextState), duration);
  }

  function enterCompact() {
    const frame = getRandomFrame("compact");
    if (frame) showImage(frame);
  }

  // --- Map tool names to emote states ---

  function toolNameToState(toolName: string): EmoteState {
    switch (toolName) {
      case "read": return "read";
      case "write":
      case "edit": return "write";
      default: return "tool";
    }
  }

  // --- Token formatting helper ---

  function formatTokens(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 10_000) return `${Math.round(count / 1000)}k`;
    if (count >= 1_000) return `${(count / 1000).toFixed(1)}k`;
    return count.toString();
  }

  // --- Build info panel lines ---

  function buildInfoLines(width: number, theme: any): string[] {
    const lines: string[] = [];
    if (!ctxRef) return lines;

    // Model name + thinking level
    const model = ctxRef.model;
    let modelStr = model?.name ?? "no model";
    const thinkingLevel = pi.getThinkingLevel?.() ?? "high";
    if (model?.reasoning) {
      modelStr += ` • ${thinkingLevel}`;
    }
    lines.push(theme.bold(modelStr));

    // Context usage
    const usage = ctxRef.getContextUsage?.();
    if (usage) {
      const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
      const tokens = usage.tokens !== null ? formatTokens(usage.tokens) : "?";
      const window = formatTokens(usage.contextWindow);
      lines.push(`Context: ${tokens}/${window} (${pct})`);
    }

    // Token stats from session entries
    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    try {
      for (const entry of ctxRef.sessionManager.getEntries()) {
        if (entry.type === "message" && entry.message.role === "assistant") {
          totalInput += entry.message.usage?.input ?? 0;
          totalOutput += entry.message.usage?.output ?? 0;
          totalCost += entry.message.usage?.cost?.total ?? 0;
        }
      }
    } catch (_) { /* ignore if not available */ }

    if (totalInput || totalOutput) {
      lines.push(`↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`);
    }

    lines.push(`$${totalCost.toFixed(3)}`);

    // Truncate lines to fit available width
    const infoWidth = width - config.size - 5; // 5 = " " (left pad) + " │ " (separator)
    return lines.map(l => {
      if (visibleWidth(l) > infoWidth) return truncateToWidth(l, infoWidth, "…");
      return l;
    });
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Check if terminal supports images
    const caps = getCapabilities();
    if (!caps.images) return;

    clearAllTimers();
    ctxRef = ctx;

    // Create widget above the editor (JRPG-style portrait beside stats panel)
    ctx.ui.setWidget("emote", (tui, theme) => {
      tuiRef = tui;
      return {
        render(width: number): string[] {
          // Hide when terminal is too narrow
          if (width < config.hideBelow) return [];
          if (imageRows === 0) return [];

          // Use the same border color as the prompt bar (thinking-level aware)
          const thinkingLevel = pi.getThinkingLevel?.() ?? "high";
          const borderColor = (theme as any).getThinkingBorderColor?.(thinkingLevel)
            ?? ((s: string) => theme.fg("border", s));
          const border = borderColor("─".repeat(width));
          const sep = borderColor("│");
          const leftMargin = " "; // left padding for image
          const avatarPad = " ".repeat(config.size); // image area placeholder
          const infoLines = buildInfoLines(width, theme);

          const lines: string[] = [];

          // Top border
          lines.push(border);

          // Image rows with info panel
          for (let i = 0; i < imageRows; i++) {
            let line = "";
            if (i === 0) {
              // First row: left margin + Kitty placement (image starts at col 1)
              line = leftMargin;
              if (pendingTransmit) {
                line += pendingTransmit + (replotSequence ?? "");
                pendingTransmit = null;
              } else if (replotSequence) {
                line += replotSequence;
              }
              line += `${avatarPad} ${sep} ${infoLines[i] ?? ""}`;
            } else {
              // Subsequent rows: left margin + avatar space + separator + info
              line = `${leftMargin}${avatarPad} ${sep} ${infoLines[i] ?? ""}`;
            }
            lines.push(line);
          }

          // No bottom border — the editor's own top border serves as separator

          return lines;
        },
        invalidate() {},
        dispose() {
          tuiRef = null;
          ctxRef = null;
        },
      };
    }, { placement: "aboveEditor" });

    widgetActive = true;

    // Let widget initialize, then show hi
    setTimeout(() => transitionTo("hi"), 500);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearAllTimers();
    // Clean up Kitty image data from terminal
    process.stdout.write(deleteKittyImage(emoteImageId));
    if (widgetActive && ctx.hasUI) {
      ctx.ui.setWidget("emote", undefined);
      widgetActive = false;
    }
    tuiRef = null;
    ctxRef = null;
    pendingTransmit = null;
    replotSequence = null;
  });

  pi.on("turn_start", async () => {
    // Don't transition to think here — wait for actual thinking tokens.
    // Keep showing the current state (last action / idle).
  });

  pi.on("message_update", async (event) => {
    if (!widgetActive) return;
    if (event.message?.role !== "assistant") return;

    // Extract text delta from streaming event
    const streamEvent = event.assistantMessageEvent;
    if (!streamEvent) return;

    // Transition to think when actual thinking tokens arrive
    if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta") {
      if (currentState !== "think") {
        transitionTo("think");
      }
      return;
    }

    // Transition to tool emote when tool call arguments are being streamed
    if (streamEvent.type === "toolcall_start") {
      const partial = streamEvent.partial;
      const block = partial?.content?.[streamEvent.contentIndex];
      if (block && "name" in block && block.name) {
        const state = toolNameToState(block.name);
        transitionTo(state);
      } else {
        transitionTo("tool");
      }
      return;
    }

    if (streamEvent.type !== "text_delta") return;
    const text = streamEvent.delta;
    if (!text) return;

    if (currentState !== "talk") {
      transitionTo("talk");
    }
    onTalkToken(text);
  });

  pi.on("agent_end", async () => {
    if (!widgetActive) return;
    if (currentState === "talk") {
      endTalk();
    } else if (currentState !== "idle" && currentState !== "hi" && currentState !== "compact") {
      transitionTo("idle");
    }
  });

  pi.on("tool_execution_start", async (event) => {
    if (!widgetActive) return;
    const state = toolNameToState(event.toolName);
    transitionTo(state);
  });

  pi.on("tool_execution_end", async (event) => {
    if (!widgetActive) return;
    if (event.toolName === "bash" && event.isError) {
      // Show failure briefly, then transition to reading the output
      holdNextState = "read";
      transitionTo("failure");
    } else {
      // Agent is now reading the tool output
      transitionTo("read");
    }
  });

  pi.on("session_before_compact", async () => {
    if (!widgetActive) return;
    transitionTo("compact");
  });

  pi.on("session_compact", async () => {
    if (!widgetActive) return;
    transitionTo("idle");
  });
}
