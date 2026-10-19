# Codex Style Annotations

Attach selected text to a Paseo conversation and add an optional comment. Capture from chat, file editors, Markdown previews, Diffs, and terminal output. Draft and sent annotations stay compact in a count capsule, with the complete text available when you open it.

## Add context without retyping it

1. Select the passage, code, or output you want the agent to use.
2. Choose **Add to chat**. The annotation appears in the native draft immediately.
3. Add a comment if needed, then send the draft through Paseo's normal message controls.

For workspace selections, the toolbar shows **Add to {chat}** and defaults to the most recently focused conversation in the same workspace. Use the arrow to choose another chat. The receiving composer does not need to be open. Adding an annotation does not send a message.

| Source | Example |
| --- | --- |
| Chat | Comment on a specific sentence in an agent's reply. |
| File editor | Select a function and describe the change you want. |
| Markdown preview | Select a rendered paragraph and ask for a rewrite. |
| Diff | Attach a changed range from one side of a file for explanation or revision. |
| Terminal | Attach the error lines that need attention. |

## Work with draft and sent annotations

Preview the draft capsule to read its entries, edit a comment, or remove an annotation. Return to the source while its position is still available. Saved text remains readable after the source location is lost, and draft annotations remain editable.

Open a sent capsule to read or copy the complete text. Sent annotations are read only. Their complete text includes the comment because Paseo no longer keeps it as separate metadata after sending. Validated pending messages retain their capsule through confirmation. Unsupported rows and rows shown before the native adapter is ready retain native attachment cards.

Chat selections also support **Ask in side chat**. The child agent uses the parent's provider, model, mode, and thinking level. It receives the selection, the source message when available, and up to eight recent main-chat turns. Continue in the side panel or open it as a chat tab.

## Settings and requirements

Paseo 0.11.4 or later with native plugin Settings support is required. Disable the original `quote` plugin before enabling this plugin. Existing `quote` annotations remain readable, and editing preserves their identity. The runtime ID remains `quote-notes`. No additional account or token is required.

Open **Settings > Plugins > Codex Style Annotations > Annotation types** to choose capture sources. Chat, file, Diff, Markdown, and terminal capture have separate switches, all enabled by default. These host settings affect new annotations. Saved annotations and chat side questions remain available. Read failures and save conflicts are visible and preserve saved values.

Settings, the selection toolbar, and the side-question editor follow Paseo's English or Chinese language setting. Other languages use English. Some annotation popovers still use Chinese labels, including the comment edit card and annotation summaries.

## Source and navigation limits

File capture keeps one continuous range, its path, lines, and a document fingerprint. Exact highlighting requires matching content, including unsaved edits. Markdown capture keeps rendered text and a path without inferred source lines.

Diff capture accepts one continuous file and side in split or unified layout. Mixed files, mixed sides, headers, and gaps are refused. Reopening a Diff does not verify its original line position, and working comparison refs can change.

Terminal locations use a session, buffer kind, and buffer coordinates. Later output, resizing, closure, or reload can invalidate exact navigation. Very long locator metadata can be refused. Browser-page capture and side questions from workspace selections are not supported.

Resolve unconfirmed saves or deletions before reloading or disabling the plugin. Retry text lives only in memory. Closing the edit card does not undo an operation already attempted.

## Data access and compatibility

The plugin runs as trusted code. It reads selections and source context, same-workspace agents and drafts, sent attachments, settings, and recent conversation text for side questions. Annotations use Paseo's native draft store. Sending a draft or side question sends that content through the configured agent provider. Copy controls write to the clipboard. Source capture does not read the clipboard or send input to the terminal.

Private adapters inspect app interfaces and fetch Paseo's own JavaScript bundles from the same origin. App updates can require compatibility updates. The plugin adds no external backend and installs no software at runtime. Disabling it restores native attachment cards without deleting annotations.

Chat was checked on macOS Paseo 0.11.4. Isolated browser checks against the installed 0.12.0-beta.3 renderer cover workspace capture, light and dark toolbars, compact layouts, language changes, and pending capsules. Complete browser and mobile clients have not been independently verified. Mobile platforms use their system selection menu.
