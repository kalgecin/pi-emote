export type EmoteState = "hi" | "idle" | "think" | "talk" | "read" | "write" | "tool" | "success" | "failure" | "compact";

export interface Config {
  enabled: boolean;
  debug: boolean;
  size: number;
  readingSpeed: number;
  hideBelow: number;
  holdDuration: { hi: number; success: number; failure: number };
  blinkInterval: [number, number];
  talkTickMs: number;
  cycleMs: number;
  emotes: EmoteMapping[];
}

export interface EmoteMapping {
  model: string;
  "emote-set": string;
}

export interface EmotesConfig {
  idle?: { default?: string; blink?: string };
  think?: { default?: string; hard?: string };
  talk?: { weights?: Record<string, number> };
}

export interface FrameSet {
  files: string[];
  base64Cache: Map<string, string>;
}
