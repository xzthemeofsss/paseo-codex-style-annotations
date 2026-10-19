# Codex Style Annotations

[English](README.md) | [简体中文](README.zh-CN.md)

Give your Paseo agent the exact text you mean. Select a passage in a chat, file, Markdown preview, Diff, or terminal, add it to a conversation, and leave a comment when you need one.

![Selected text, an optional comment, and a compact draft annotation. Interface illustration with sample content.](assets/preview.png)

## Add context to a conversation

1. Select the text you want the agent to use.
2. Choose **Add to chat**. The annotation appears in the draft immediately.
3. Add an optional comment, then send the draft through Paseo's normal message controls.

For workspace selections, **Add to {chat}** names the receiving conversation. The toolbar defaults to the most recently focused chat in the same workspace. Use its arrow to choose another chat. The receiving composer does not need to be open.

Adding an annotation does not send a message. You can collect several selections before sending.

## Use text from your workspace

![File, Diff, and terminal selections, with a toolbar that names the receiving chat. Interface illustrations with sample content.](assets/workspace-sources.png)

| Source | When to use it | What the annotation keeps |
| --- | --- | --- |
| Chat | Comment on a specific part of an agent's reply. | Selected rendered text and the host's Markdown serialization. |
| File editor | Ask about a function or request a change to selected code. | One continuous text range, a path, line numbers, and a document fingerprint. |
| Markdown preview | Ask for a rewrite of a paragraph as it appears in the preview. | Rendered text and a file path, without inferred source lines. |
| Diff | Explain or revise a change on one side of a file. | A continuous range from one file and side in split or unified layout. |
| Terminal | Attach the error or log lines that need attention. | Selected text, a terminal session, a buffer kind, and buffer coordinates. |

Capture does not read the clipboard or send input to the terminal. Browser-page capture is not supported.

Source navigation depends on the original content still being available. File highlighting requires matching content, including unsaved edits. Diff capture refuses mixed files, mixed sides, headers, and gaps. Reopening a Diff does not verify the original line position, and working comparison refs can change. Terminal output, resizing, closure, or reload can invalidate exact navigation. Very long locator metadata can be refused.

Saved text remains readable when the source location is lost. Draft annotations remain editable and removable.

## Manage draft and sent annotations

![Illustrated draft and sent annotation views with sample content and labels shown in English.](assets/draft-and-sent.png)

The gallery illustrations use English labels for explanation. Some current runtime popovers still use Chinese labels. The capture below shows the actual draft summary with Chinese sample text in an isolated check.

![Actual draft-summary interface with Chinese sample text, captured at a device scale factor of 3.](assets/interface/draft-summary.png)

Draft and sent annotations collapse into a count capsule. Hover or focus a draft capsule to preview its entries, or click to keep it open. Open an entry's edit card to change its comment or delete the annotation. Click a summary entry to return to its source while its position is still available.

| Action | Keyboard behavior |
| --- | --- |
| Write a new comment | **Enter**, **Esc**, or leaving the field saves the text. **Shift+Enter** inserts a line break. Input-method composition does not confirm the comment. |
| Edit an existing comment | **Enter** inserts a line break. **Cmd+Enter** on macOS, or **Ctrl+Enter** elsewhere, saves the changes. |
| Discard an unsubmitted edit | Cancel, **Esc**, or clicking outside closes the edit card without saving those edits. |
| Read a sent annotation | Click its capsule, or press **Enter** or **Space**, to open the complete text. **Esc** closes the preview and returns focus. |

Sent annotations are read only. Their preview includes the comment as part of the complete text because Paseo no longer retains it as separate metadata after sending. Each sent entry has a copy control.

Validated pending messages keep the same capsule through confirmation. Unsupported rows and rows shown before the native adapter is ready retain native attachment cards.

If a save or deletion is unconfirmed, resolve the error before reloading or disabling the plugin. Retry text is held only in memory. Closing the card does not undo an operation already attempted.

## Choose sources and language

Open **Settings > Plugins > Codex Style Annotations > Annotation types**. Chat, file, Diff, Markdown, and terminal capture each have a switch, and all five start enabled. Settings belong to the host installation. Turning a type off affects new annotations. Saved annotations and chat side questions remain available.

Settings load at startup and are checked again before each addition. Read failures and save conflicts stay visible without resetting saved values.

Settings, the selection toolbar, and the side-question editor follow Paseo's English or Chinese language setting. Other languages use English. Some annotation popovers still use Chinese labels, including the comment edit card and annotation summaries.

## Ask a side question about chat text

For a chat selection, choose **Ask in side chat** and enter a question. The child agent uses the parent's provider, model, mode, and thinking level. It receives the selection, the source message when available, and up to eight recent main-chat turns. Continue in the side panel or open it as a chat tab.

Side questions from file, Markdown, Diff, and terminal selections are not supported.

## Install

Paseo 0.11.4 or later with native plugin Settings support is required. Enable plugins in **Settings > Plugins**. If the original `quote` plugin is installed, disable it before enabling this plugin.

```bash
paseo plugin disable quote
paseo plugin add xzthemeofsss/quote-notes
```

Skip the disable command if `quote` is not installed. The runtime ID remains `quote-notes`. Existing `quote` annotations remain readable, and edits preserve their identity.

To install the source release directly, use:

```bash
paseo plugin add git:xzthemeofsss/paseo-codex-style-annotations --ref v0.2.0
```

The marketplace uses its reviewed revision. The direct command above selects the `v0.2.0` source release.

## Data access and compatibility

The plugin runs as trusted code. It reads selections, source context, same-workspace agents and drafts, sent attachments, annotation settings, and recent conversation text for side questions. Annotations use Paseo's native draft store. Sending a draft or asking a side question sends that content through the configured agent provider. Copy controls write to the clipboard.

Native adapters inspect private app interfaces and fetch Paseo's own JavaScript bundles from the same origin. A Paseo update can require an adapter update. The plugin adds no external backend and installs no software at runtime. Disabling it restores native attachment cards without deleting saved annotations.

The chat UI was checked on macOS with Paseo 0.11.4. Isolated browser checks against the installed 0.12.0-beta.3 renderer cover workspace capture, light and dark toolbars, compact layouts, language changes, and pending capsules. These checks do not certify every running client. Complete browser clients and mobile clients have not been independently verified. Mobile platforms use their system selection menu.

## Develop

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

The retained tests load native modules from the installed macOS Paseo bundle. Set `PASEO_BUNDLE` to use another bundle. Tests do not install the plugin or send agent messages. Runtime modules come from Paseo, so plugin installation requires no build command or dependency installation.

The gallery uses editable SVG sources and committed PNG exports. See [the asset notes](assets/README.md) for the render command and interface-image provenance.

## Credits and license

This plugin is a fork of [paseo-quote by Chechulin Serhii](https://github.com/keefeere/paseo-quote). The original [MIT license](LICENSE) and copyright notice are preserved.
