import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import type { Config } from "./types.js";
import type { Animator } from "./animator.js";
import { log } from "./log.js";

// --- Token formatting ---

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1000)}k`;
  if (count >= 1_000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

// --- Info panel ---

function buildInfoLines(width: number, config: Config, ctxRef: any, pi: any, theme: any): string[] {
  const lines: string[] = [];
  if (!ctxRef) return lines;

  const model = ctxRef.model;
  let modelStr = model?.name ?? "no model";
  const thinkingLevel = pi.getThinkingLevel?.() ?? "high";
  if (model?.reasoning) {
    modelStr += ` • ${thinkingLevel}`;
  }
  lines.push(theme.bold(modelStr));

  const usage = ctxRef.getContextUsage?.();
  if (usage) {
    const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
    const tokens = usage.tokens !== null ? formatTokens(usage.tokens) : "?";
    const window = formatTokens(usage.contextWindow);
    lines.push(`Context: ${tokens}/${window} (${pct})`);
  }

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

  const infoWidth = width - config.size - 5;
  return lines.map(l => {
    if (visibleWidth(l) > infoWidth) return truncateToWidth(l, infoWidth, "…");
    return l;
  });
}

// --- Widget factory ---

export interface WidgetDeps {
  animator: Animator;
  config: Config;
  pi: any;
  getCtxRef: () => any;
  getCurrentEmoteSet: () => string;
}

export function createWidgetFactory(deps: WidgetDeps) {
  return (_tui: any, theme: any) => {
    deps.animator.tuiRef = _tui;
    return {
      render(width: number): string[] {
        const { animator, config } = deps;

        if (width < config.hideBelow) return [];
        if (animator.imageRows === 0) {
          log(`render: imageRows=0, returning empty`);
          return [];
        }

        log(`render: imageRows=${animator.imageRows}, pendingTransmit=${animator.pendingTransmit !== null}, replotSequence=${animator.replotSequence !== null}, set="${deps.getCurrentEmoteSet()}"`);

        const thinkingLevel = deps.pi.getThinkingLevel?.() ?? "high";
        const borderColor = (theme as any).getThinkingBorderColor?.(thinkingLevel)
          ?? ((s: string) => theme.fg("border", s));
        const border = borderColor("─".repeat(width));
        const sep = borderColor("│");
        const leftMargin = " ";
        const avatarPad = " ".repeat(config.size);
        const infoLines = buildInfoLines(width, config, deps.getCtxRef(), deps.pi, theme);

        const lines: string[] = [];
        lines.push(border);

        for (let i = 0; i < animator.imageRows; i++) {
          let line = "";
          if (i === 0) {
            line = leftMargin;
            if (animator.pendingTransmit) {
              line += animator.pendingTransmit + (animator.replotSequence ?? "");
              animator.pendingTransmit = null;
            } else if (animator.replotSequence) {
              line += animator.replotSequence;
            }
            line += `${avatarPad} ${sep} ${infoLines[i] ?? ""}`;
          } else {
            line = `${leftMargin}${avatarPad} ${sep} ${infoLines[i] ?? ""}`;
          }
          lines.push(line);
        }

        return lines;
      },
      invalidate() {},
      dispose() {
        deps.animator.tuiRef = null;
      },
    };
  };
}
