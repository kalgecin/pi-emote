# Changelog

All notable changes to pi-emote will be documented in this file.

## v0.2.3

### Added
- **Configurable terminal renderer whitelist** — override image protocol per terminal via `terminals` config array.
- **Community emote sets** — `aza_choi` and `aza_choi_nobg` by [@shennguyenrs](https://github.com/shennguyenrs) (#3).
- **Gallery section** in README showcasing available emote sets.

### Fixed
- **Config merge semantics** — emote entries now correctly append across config layers; terminal entries merge by `match` key.

## v0.2.2

### Fixed
- **Image row overflow** — row calculation now uses the same column count as the actual render, fixing avatar bleeding into content below.
- **Vertical centering** — Kitty renderer uses pixel-level `Y` offset to center the image within its allocated rows, independent of font/cell dimensions.
- **Consistent sizing** — image width, row calculation, and widget padding all use `config.size` consistently (removed off-by-one from `size + 1`).
- Custom Kitty escape sequence builder replaces pi-tui's `encodeKitty`, enabling protocol params (`Y` offset) not exposed by the library.

## v0.2.1

### Added
- **ASCII fallback renderer** — terminals without image support (tmux, Alacritty, VSCode, etc.) now show text-based emotes instead of nothing.
- ASCII emote frames defined in `emotes/ascii/fallback.yaml`.
- Config support for `"emote-set": "ascii"` to force ASCII mode on any terminal.
- Warning notification via `ctx.ui.notify` when falling back to ASCII.

### Changed
- **Renderer architecture split** — rendering logic separated by protocol:
  - `render_kitty.ts` — Kitty graphics protocol (Kitty, Ghostty, WezTerm).
  - `render_iterm.ts` — iTerm2 inline image protocol.
  - `render_ascii.ts` — plain text fallback.
  - `render_image.ts` — shared base class for image renderers.
  - `renderer.ts` — `Renderer` interface and `RenderedFrame` type.
- `animator.ts` is now a pure state machine, delegates all rendering to the `Renderer` interface.
- `widget.ts` handles image, text, and protocol-specific frame rendering.

### Fixed
- Package imports updated from `@mariozechner/*` to `@earendil-works/*`.
- **iTerm2 inline image rendering** — text-first/image-last strategy prevents ghost
  images and `\x1b[2K` erasure artifacts. Uses `preserveAspectRatio` with auto height
  for correct proportions.
- **Kitty image aspect ratio** — no longer forces row count, letting Kitty auto-size
  height to preserve correct proportions.
- Image width increased by 1 cell for better visual sizing in both protocols.
- I/O token stats (`↑input ↓output`) now shown even when zero.

## v0.2.0

Initial alpha release.

- Animated pixel-art emote widget displayed above the editor.
- State machine: hi, idle, think, talk, read, write, tool, success, failure, compact.
- Idle blinking and think swap animations.
- Talk mouth animation synced to token stream with reading-speed pacing.
- Cycling animations for read/write/tool states.
- Per-model emote set selection via glob patterns in config.
- Layered configuration (extension defaults → user global → project local).
- Emote set lookup across project, user, and extension directories.
- Optional `emotes.json` per set for frame configuration (idle/blink, think/hard, talk weights).
