import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.js";

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function loadJsonFile(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

const DEFAULTS: Config = {
  enabled: true,
  debug: false,
  size: 8,
  readingSpeed: 4,
  hideBelow: 80,
  holdDuration: { hi: 2000, success: 1200, failure: 1200 },
  blinkInterval: [3000, 6000],
  talkTickMs: 120,
  cycleMs: 500,
  emotes: [{ model: "*", "emote-set": "default" }],
};

export function loadLayeredConfig(extDir: string, cwd: string): Config {
  // Layer 1: Extension config (lowest priority)
  const extConfig = loadJsonFile(join(extDir, "config.json"));

  // Layer 2: User global config
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const userConfig = loadJsonFile(join(homeDir, ".pi", "agent", "extensions", "pi-emote", "config.json"));

  // Layer 3: Project config (highest priority)
  const projectConfig = loadJsonFile(join(cwd, ".pi", "extensions", "pi-emote", "config.json"));

  // Deep merge in priority order
  let merged = DEFAULTS;
  if (extConfig) merged = deepMerge(merged, extConfig);
  if (userConfig) merged = deepMerge(merged, userConfig);
  if (projectConfig) merged = deepMerge(merged, projectConfig);

  // "emotes" array uses replace semantics — highest priority layer wins
  if (projectConfig?.emotes) {
    merged.emotes = projectConfig.emotes;
  } else if (userConfig?.emotes) {
    merged.emotes = userConfig.emotes;
  } else if (extConfig?.emotes) {
    merged.emotes = extConfig.emotes;
  }

  return merged;
}
