import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getCapabilities } from "@mariozechner/pi-tui";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { EmoteState } from "./types.js";
import { log, setDebug } from "./log.js";
import { loadLayeredConfig } from "./config.js";
import { resolveEmoteSet, findEmoteSetDir, loadEmotesConfig, discoverFrames } from "./emotes.js";
import { Animator } from "./animator.js";
import { createWidgetFactory } from "./widget.js";

function toolNameToState(toolName: string): EmoteState {
  switch (toolName) {
    case "read": return "read";
    case "write":
    case "edit": return "write";
    default: return "tool";
  }
}

export default function (pi: ExtensionAPI) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const extDir = dirname(__dirname);

  let cwd = process.cwd();
  let config = loadLayeredConfig(extDir, cwd);
  setDebug(config.debug);

  if (!config.enabled) return;

  // Emote set state
  let currentEmoteSet = "default";
  let ctxRef: any = null;
  let widgetActive = false;

  const animator = new Animator(config);

  function loadEmoteSet(setName: string) {
    const setDir = findEmoteSetDir(setName, extDir, cwd);
    currentEmoteSet = setName;
    const emotesConfig = loadEmotesConfig(setDir);
    const frameMap = discoverFrames(setDir);
    animator.setEmoteSet(emotesConfig, frameMap);
  }

  loadEmoteSet("default");

  function switchEmoteSetForModel(modelId: string) {
    const setName = resolveEmoteSet(modelId, config.emotes);
    if (setName !== currentEmoteSet) {
      loadEmoteSet(setName);
      log(`switchEmoteSet: loaded "${setName}", state="${animator.currentState}"`);
      animator.resetImageState();
      if (widgetActive && animator.currentState === "idle") {
        animator.enterIdle();
      } else if (widgetActive) {
        const frame = animator.getRandomFrame(animator.currentState);
        if (frame) animator.showImage(frame, true);
      }
    }
  }

  // --- Events ---

  pi.on("session_start", async (_event, ctx) => {
    log(`session_start: hasUI=${ctx.hasUI}`);
    if (!ctx.hasUI) return;

    const caps = getCapabilities();
    if (!caps.images) {
      log(`no image support`);
      return;
    }

    animator.clearAllTimers();
    cwd = ctx.cwd;
    config = loadLayeredConfig(extDir, cwd);
    setDebug(config.debug);
    animator.updateConfig(config);
    ctxRef = ctx;

    if (!config.enabled) return;

    // Resolve emote set for current model
    const modelId = ctx.model?.id ?? "";
    const setName = resolveEmoteSet(modelId, config.emotes);
    log(`session_start: model="${modelId}" set="${setName}" dir="${findEmoteSetDir(setName, extDir, cwd)}"`);
    loadEmoteSet(setName);

    // Create widget
    ctx.ui.setWidget("emote", createWidgetFactory({
      animator,
      config,
      pi,
      getCtxRef: () => ctxRef,
      getCurrentEmoteSet: () => currentEmoteSet,
    }), { placement: "aboveEditor" });

    widgetActive = true;
    setTimeout(() => animator.transitionTo("hi"), 500);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    animator.clearAllTimers();
    animator.deleteImage();
    if (widgetActive && ctx.hasUI) {
      ctx.ui.setWidget("emote", undefined);
      widgetActive = false;
    }
    animator.tuiRef = null;
    ctxRef = null;
  });

  pi.on("model_select", async (event) => {
    if (!widgetActive) return;
    const modelId = event.model?.id ?? "";
    const resolved = resolveEmoteSet(modelId, config.emotes);
    log(`model_select: model="${modelId}" resolved="${resolved}" current="${currentEmoteSet}"`);
    switchEmoteSetForModel(modelId);
  });

  pi.on("message_update", async (event) => {
    if (!widgetActive) return;
    if (event.message?.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (!streamEvent) return;

    if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta") {
      if (animator.currentState !== "think") {
        animator.transitionTo("think");
      }
      return;
    }

    if (streamEvent.type === "toolcall_start") {
      const partial = streamEvent.partial;
      const block = partial?.content?.[streamEvent.contentIndex];
      if (block && "name" in block && block.name) {
        animator.transitionTo(toolNameToState(block.name));
      } else {
        animator.transitionTo("tool");
      }
      return;
    }

    if (streamEvent.type !== "text_delta") return;
    const text = streamEvent.delta;
    if (!text) return;

    if (animator.currentState !== "talk") {
      animator.transitionTo("talk");
    }
    animator.onTalkToken(text);
  });

  pi.on("agent_end", async () => {
    if (!widgetActive) return;
    if (animator.currentState === "talk") {
      animator.endTalk();
    } else if (animator.currentState !== "idle" && animator.currentState !== "hi" && animator.currentState !== "compact") {
      animator.transitionTo("idle");
    }
  });

  pi.on("tool_execution_start", async (event) => {
    if (!widgetActive) return;
    animator.transitionTo(toolNameToState(event.toolName));
  });

  pi.on("tool_execution_end", async (event) => {
    if (!widgetActive) return;
    if (event.toolName === "bash" && event.isError) {
      animator.setHoldNextState("read");
      animator.transitionTo("failure");
    } else {
      animator.transitionTo("read");
    }
  });

  pi.on("session_before_compact", async () => {
    if (!widgetActive) return;
    animator.transitionTo("compact");
  });

  pi.on("session_compact", async () => {
    if (!widgetActive) return;
    animator.transitionTo("idle");
  });
}
