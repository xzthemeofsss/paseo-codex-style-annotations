# Codex Style Annotations

Attach selected chat, file, Markdown preview, Diff, or terminal text to a Paseo conversation with an optional comment. Draft and sent annotations collapse into a count capsule. Edit draft comments, read complete sent text, or return to a source while its position remains available.

For workspace selections, the toolbar names the receiving chat and defaults to the most recently focused conversation in the same workspace. Use the arrow to change it. Adding an annotation updates the native draft without sending a message or requiring an open composer.

Chat selections also support side questions. A child agent uses the parent's provider, model, mode, and thinking level, with the selection, the source message when available, and up to eight recent main-chat turns.

## Setup

Paseo 0.11.4 or later with native plugin Settings support is required. Disable the original `quote` plugin before enabling this plugin. Existing `quote` annotations remain readable; editing preserves their identity. New annotations use the `quote-notes` runtime ID. No additional account or token is required.

The Annotation types settings control chat, file, Diff, Markdown, and terminal capture independently. All five start enabled. These host settings affect new annotations; saved annotations and chat side questions remain available. Read failures and save conflicts are visible and preserve saved values.

Settings, the selection toolbar, annotation popovers, and messages follow Paseo's English or Chinese language setting, with English as the fallback.

## Data and limits

File annotations retain exact text, paths, ranges, and document fingerprints. Exact highlighting requires matching content. Markdown retains rendered text and a path without inferred source lines. Diff capture accepts one continuous file and side; reopening does not verify the original line position, and working comparison refs can change. Terminal locations use buffer coordinates that later output, resizing, closure, or reload can invalidate.

Saved text remains readable after source loss, and draft annotations remain editable. Sent annotations retain complete text, including comments, and are read only. Browser-page capture and workspace-source side questions are not supported. Resolve unconfirmed writes before reloading or disabling the plugin; retry text lives only in memory.

The plugin runs as trusted code. It reads selections and their context, same-workspace agents and drafts, sent attachments, settings, and recent conversation text for side questions. Sending a draft or side question sends that content through the configured provider. Copy controls write to the clipboard. Source capture uses neither clipboard access nor terminal input.

Private adapters fetch Paseo's own bundles from the same origin. App updates can require compatibility updates. The plugin adds no external backend and installs no runtime software. Disabling it restores native attachment cards without deleting annotations.

Chat was checked on macOS Paseo 0.11.4. Isolated checks against the installed 0.12.0-beta.3 renderer cover workspace capture, light and dark toolbars, compact layouts, language changes, and pending capsules. Complete browser and mobile clients have not been independently verified. Mobile platforms use the system selection menu.
