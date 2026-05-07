import { getCapabilities, getImageDimensions, renderImage, allocateImageId, deleteKittyImage } from "@mariozechner/pi-tui";
import type { TUI } from "@mariozechner/pi-tui";
import type { EmoteState, Config, EmotesConfig, FrameSet } from "./types.js";
import { log } from "./log.js";

// --- Helpers ---

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

// --- Animator ---

export class Animator {
  // Image rendering state (read by widget)
  pendingTransmit: string | null = null;
  replotSequence: string | null = null;
  imageRows = 0;
  readonly imageId: number;

  // State machine
  currentState: EmoteState = "idle";

  // References
  tuiRef: TUI | null = null;
  private config: Config;
  private emotesConfig: EmotesConfig = {};
  private frameMap: Map<EmoteState, FrameSet> = new Map();
  private lastShownBase64: string | null = null;

  // Timers
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  private talkTimer: ReturnType<typeof setInterval> | null = null;
  private cycleTimer: ReturnType<typeof setInterval> | null = null;
  private thinkTimer: ReturnType<typeof setTimeout> | null = null;
  private talkGapTimer: ReturnType<typeof setTimeout> | null = null;
  private talkDurationTimer: ReturnType<typeof setTimeout> | null = null;

  // Cycle state
  private cycleIndex = 0;
  private cycleDirection = 1;

  // Think state
  private thinkBaseFrame: string | null = null;

  // Hold state
  private holdNextState: EmoteState = "idle";

  // Talk state
  private talkWordCount = 0;
  private talkStartTime = 0;
  private lastTokenTime = 0;
  private talkMouthClosed = false;

  constructor(config: Config) {
    this.config = config;
    this.imageId = allocateImageId();
  }

  updateConfig(config: Config) {
    this.config = config;
  }

  setEmoteSet(emotesConfig: EmotesConfig, frameMap: Map<EmoteState, FrameSet>) {
    this.emotesConfig = emotesConfig;
    this.frameMap = frameMap;
  }

  setHoldNextState(state: EmoteState) {
    this.holdNextState = state;
  }

  // --- Image rendering ---

  showImage(base64: string, force = false) {
    if (!force && base64 === this.lastShownBase64) return;
    this.lastShownBase64 = base64;

    const caps = getCapabilities();
    if (!caps.images) return;

    const dimensions = getImageDimensions(base64, "image/png") ?? { widthPx: 510, heightPx: 510 };
    const result = renderImage(base64, dimensions, {
      maxWidthCells: this.config.size,
      imageId: this.imageId,
    });

    log(`showImage: result=${result !== null && result !== undefined}, tuiRef=${this.tuiRef !== null}, dims=${dimensions.widthPx}x${dimensions.heightPx}`);

    if (result) {
      const transmitSeq = result.sequence.replace("a=T", "a=t");
      const placeSeq = `\x1b_Ga=p,i=${this.imageId},p=1,c=${this.config.size},r=${result.rows},C=1,q=2\x1b\\`;

      this.pendingTransmit = transmitSeq;
      this.replotSequence = placeSeq;
      this.imageRows = result.rows;
    } else {
      this.pendingTransmit = null;
      this.replotSequence = null;
      this.imageRows = 0;
    }
    this.tuiRef?.requestRender();
  }

  resetImageState() {
    this.lastShownBase64 = null;
  }

  deleteImage() {
    process.stdout.write(deleteKittyImage(this.imageId));
    this.pendingTransmit = null;
    this.replotSequence = null;
  }

  // --- Frame access ---

  getFrame(state: EmoteState, filename: string): string | null {
    const frameSet = this.frameMap.get(state);
    if (!frameSet) return null;
    return frameSet.base64Cache.get(filename) ?? null;
  }

  getRandomFrame(state: EmoteState): string | null {
    const frameSet = this.frameMap.get(state);
    if (!frameSet || frameSet.files.length === 0) return null;
    const file = randomPick(frameSet.files);
    return frameSet.base64Cache.get(file) ?? null;
  }

  private getTalkFrame(): string | null {
    const frameSet = this.frameMap.get("talk");
    if (!frameSet || frameSet.files.length === 0) return null;

    if (this.emotesConfig.talk?.weights) {
      const file = weightedRandomPick(this.emotesConfig.talk.weights);
      return frameSet.base64Cache.get(file) ?? this.getRandomFrame("talk");
    }
    return this.getRandomFrame("talk");
  }

  private getTalkCloseFrame(): string | null {
    const frameSet = this.frameMap.get("talk");
    if (!frameSet) return null;
    const closeFile = frameSet.files.find((f) => f.includes("close"));
    if (closeFile) return frameSet.base64Cache.get(closeFile) ?? null;
    return frameSet.base64Cache.get(frameSet.files[0]!) ?? null;
  }

  private getCycleFrame(state: EmoteState): string | null {
    const frameSet = this.frameMap.get(state);
    if (!frameSet || frameSet.files.length === 0) return null;
    const file = frameSet.files[this.cycleIndex % frameSet.files.length]!;
    return frameSet.base64Cache.get(file) ?? null;
  }

  // --- Timer management ---

  clearAllTimers() {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    if (this.blinkTimer) { clearTimeout(this.blinkTimer); this.blinkTimer = null; }
    if (this.talkTimer) { clearInterval(this.talkTimer); this.talkTimer = null; }
    if (this.cycleTimer) { clearInterval(this.cycleTimer); this.cycleTimer = null; }
    if (this.talkGapTimer) { clearTimeout(this.talkGapTimer); this.talkGapTimer = null; }
    if (this.talkDurationTimer) { clearTimeout(this.talkDurationTimer); this.talkDurationTimer = null; }
    if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; }
  }

  private clearStateTimers() {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    if (this.talkTimer) { clearInterval(this.talkTimer); this.talkTimer = null; }
    if (this.cycleTimer) { clearInterval(this.cycleTimer); this.cycleTimer = null; }
    if (this.talkGapTimer) { clearTimeout(this.talkGapTimer); this.talkGapTimer = null; }
    if (this.talkDurationTimer) { clearTimeout(this.talkDurationTimer); this.talkDurationTimer = null; }
    if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; }
  }

  // --- State transitions ---

  transitionTo(state: EmoteState) {
    this.clearStateTimers();
    if (this.currentState === "idle" && this.blinkTimer) {
      clearTimeout(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.currentState = state;

    switch (state) {
      case "hi": this.enterHi(); break;
      case "idle": this.enterIdle(); break;
      case "think": this.enterThink(); break;
      case "talk": this.enterTalk(); break;
      case "read":
      case "write":
      case "tool": this.enterCycle(state); break;
      case "success": this.enterHold(state, this.config.holdDuration.success, this.holdNextState); this.holdNextState = "idle"; break;
      case "failure": this.enterHold(state, this.config.holdDuration.failure, this.holdNextState); this.holdNextState = "idle"; break;
      case "compact": this.enterCompact(); break;
    }
  }

  private enterHi() {
    const frame = this.getRandomFrame("hi");
    if (frame) this.showImage(frame);
    this.holdTimer = setTimeout(() => this.transitionTo("idle"), this.config.holdDuration.hi);
  }

  enterIdle() {
    const defaultFile = this.emotesConfig.idle?.default ?? "idle.png";
    const frame = this.getFrame("idle", defaultFile);
    if (frame) this.showImage(frame);
    this.scheduleBlink();
  }

  private scheduleBlink() {
    if (this.blinkTimer) { clearTimeout(this.blinkTimer); this.blinkTimer = null; }
    const delay = randomInRange(this.config.blinkInterval[0], this.config.blinkInterval[1]);
    this.blinkTimer = setTimeout(() => {
      if (this.currentState !== "idle") return;
      this.doBlink();
    }, delay);
  }

  private doBlink() {
    const blinkFile = this.emotesConfig.idle?.blink ?? "idle_blink.png";
    const blinkFrame = this.getFrame("idle", blinkFile);
    if (!blinkFrame) { this.scheduleBlink(); return; }

    this.showImage(blinkFrame);

    const doubleBlink = Math.random() < 0.15;
    const blinkDuration = 150;

    setTimeout(() => {
      if (this.currentState !== "idle") return;
      const defaultFile = this.emotesConfig.idle?.default ?? "idle.png";
      const defaultFrame = this.getFrame("idle", defaultFile);
      if (defaultFrame) this.showImage(defaultFrame, true);

      if (doubleBlink) {
        setTimeout(() => {
          if (this.currentState !== "idle") return;
          this.showImage(blinkFrame, true);
          setTimeout(() => {
            if (this.currentState !== "idle") return;
            if (defaultFrame) this.showImage(defaultFrame, true);
            this.scheduleBlink();
          }, blinkDuration);
        }, 100);
      } else {
        this.scheduleBlink();
      }
    }, blinkDuration);
  }

  private enterThink() {
    const defaultFile = this.emotesConfig.think?.default ?? "think.png";
    this.thinkBaseFrame = this.getFrame("think", defaultFile);
    if (this.thinkBaseFrame) this.showImage(this.thinkBaseFrame);
    this.scheduleThinkSwap();
  }

  private scheduleThinkSwap() {
    if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; }
    const delay = randomInRange(this.config.blinkInterval[0], this.config.blinkInterval[1]);
    this.thinkTimer = setTimeout(() => {
      if (this.currentState !== "think") return;
      this.doThinkSwap();
    }, delay);
  }

  private doThinkSwap() {
    const hardFile = this.emotesConfig.think?.hard ?? "think_hard.png";
    const hardFrame = this.getFrame("think", hardFile);
    if (!hardFrame) { this.scheduleThinkSwap(); return; }

    this.showImage(hardFrame, true);

    setTimeout(() => {
      if (this.currentState !== "think") return;
      if (this.thinkBaseFrame) this.showImage(this.thinkBaseFrame, true);
      this.scheduleThinkSwap();
    }, 800);
  }

  private enterTalk() {
    this.talkWordCount = 0;
    this.talkStartTime = Date.now();
    this.lastTokenTime = Date.now();
    this.talkMouthClosed = false;

    const frame = this.getTalkFrame();
    if (frame) this.showImage(frame);

    this.talkTimer = setInterval(() => {
      if (this.currentState !== "talk") return;
      if (this.talkMouthClosed) {
        const closeFrame = this.getTalkCloseFrame();
        if (closeFrame) this.showImage(closeFrame);
      } else {
        const f = this.getTalkFrame();
        if (f) this.showImage(f);
      }
    }, this.config.talkTickMs);
  }

  onTalkToken(text: string) {
    if (this.currentState !== "talk") return;

    const words = text.split(/\s+/).filter((w) => w.length > 0).length;
    this.talkWordCount += words;
    this.lastTokenTime = Date.now();

    if (this.talkMouthClosed) {
      this.talkMouthClosed = false;
    }

    if (this.talkGapTimer) { clearTimeout(this.talkGapTimer); this.talkGapTimer = null; }
    this.talkGapTimer = setTimeout(() => {
      if (this.currentState !== "talk") return;
      this.talkMouthClosed = true;
    }, 200);

    this.recalculateTalkDuration();
  }

  private recalculateTalkDuration() {
    if (this.talkDurationTimer) { clearTimeout(this.talkDurationTimer); this.talkDurationTimer = null; }

    const targetDurationMs = (this.talkWordCount / this.config.readingSpeed) * 1000;
    const elapsed = Date.now() - this.talkStartTime;
    const remaining = Math.max(0, targetDurationMs - elapsed);

    this.talkDurationTimer = setTimeout(() => {
      if (this.currentState !== "talk") return;
      const timeSinceLastToken = Date.now() - this.lastTokenTime;
      if (timeSinceLastToken > 200) {
        this.transitionTo("idle");
      } else {
        this.talkDurationTimer = setTimeout(() => {
          if (this.currentState === "talk") this.transitionTo("idle");
        }, 200);
      }
    }, remaining);
  }

  endTalk() {
    if (this.currentState !== "talk") return;
    const targetDurationMs = (this.talkWordCount / this.config.readingSpeed) * 1000;
    const elapsed = Date.now() - this.talkStartTime;
    if (elapsed >= targetDurationMs) {
      this.transitionTo("idle");
    } else {
      // Streaming finished but reading time remains — keep mouth animating
      if (this.talkGapTimer) { clearTimeout(this.talkGapTimer); this.talkGapTimer = null; }
      this.talkMouthClosed = false;
    }
  }

  private enterCycle(state: EmoteState) {
    this.cycleIndex = 0;
    this.cycleDirection = 1;
    const frame = this.getCycleFrame(state);
    if (frame) this.showImage(frame);

    const frameSet = this.frameMap.get(state);
    if (!frameSet || frameSet.files.length <= 1) return;

    this.cycleTimer = setInterval(() => {
      if (this.currentState !== state) return;
      this.cycleIndex += this.cycleDirection;
      if (this.cycleIndex >= frameSet.files.length - 1) this.cycleDirection = -1;
      if (this.cycleIndex <= 0) this.cycleDirection = 1;
      const f = this.getCycleFrame(state);
      if (f) this.showImage(f);
    }, this.config.cycleMs);
  }

  private enterHold(state: EmoteState, duration: number, nextState: EmoteState = "idle") {
    const frame = this.getRandomFrame(state);
    if (frame) this.showImage(frame);
    this.holdTimer = setTimeout(() => this.transitionTo(nextState), duration);
  }

  private enterCompact() {
    const frame = this.getRandomFrame("compact");
    if (frame) this.showImage(frame);
  }
}
