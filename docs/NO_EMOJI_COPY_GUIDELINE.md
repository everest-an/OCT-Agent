# OCT-Agent No-Emoji Content Guideline v1.0

Last Updated: 2026-04-05
Owner: Product + Design + Frontend
Scope: Desktop UI text, labels, badges, alerts, empty states, action copy

## 1. Why This Guideline Exists

This guideline defines a unified no-emoji writing system for OCT-Agent product surfaces.

Goals:
- Keep the product tone professional and stable in business contexts
- Improve readability in both light and dark modes
- Replace emoji semantics with icon system + text hierarchy
- Make UI copy easier to localize and maintain

## 2. External Product Signals (Web Research Summary)

Observed patterns from major AI products:
- Kimi: Uses short module names (Websites, Docs, Slides, Sheets, Deep Research), no emoji-based structure
- ChatGPT: Uses action-oriented and benefit-oriented microcopy, relies on icons and layout hierarchy
- Claude: Uses clear task taxonomy (Tasks, Learn, Code, Research, Analyze), minimal decorative symbols
- Gemini: Uses trust-oriented explanatory copy and explicit limitation text, avoids emoji in core product messaging

Conclusion:
- Leading AI products generally do not use emoji as primary information architecture
- Semantic clarity is delivered by iconography, typography hierarchy, and concise wording

## 3. Core Principles

1. Icon first, emoji never
- Use Lucide icons as the only visual semantic marker in product UI
- Emoji can appear only in user-generated content, never in product-owned labels

2. Action clarity
- Buttons and commands must start with a clear action verb
- Avoid ambiguous labels like Do it, Handle, Process

3. Information hierarchy
- Heading: what this area is for
- Supporting text: what user gets
- Metadata: secondary status only

4. Risk communication
- Warnings and destructive actions must use explicit consequence text
- Never rely on color alone to communicate risk

5. Tone consistency
- Professional, calm, direct
- No playful punctuation, no decorative wording

## 4. Naming Rules

### 4.1 Navigation
Use noun phrases, 1 to 2 words preferred.

Preferred:
- Timeline
- Knowledge
- Graph
- Settings

Avoid:
- Smart Memory Hub
- Let us organize your memory

### 4.2 Section Titles
Use functional titles, not marketing slogans.

Preferred:
- Capture and Recall
- Storage and Sync
- Privacy by Source
- Danger Zone

Avoid:
- Memory Superpowers
- Keep things magical

### 4.3 Buttons
Use verb-first labels.

Preferred:
- Connect Cloud
- Disconnect
- Save Changes
- Delete All
- Retry

Avoid:
- Confirm
- Continue
- Submit (unless in form context)

## 5. Icon and Status Standard

Use one canonical icon for each semantic class.

- Info: CircleAlert
- Success: CheckCircle2
- Warning: TriangleAlert
- Danger: ShieldAlert or Trash2 (destructive action)
- Sync/Cloud: Cloud
- Local: HardDrive

Status chips:
- Active
- Connected
- Disconnected
- Pending
- Disabled
- Failed

Rule:
- Chip text must be explicit and readable without color

## 6. Alert Copy Templates (Bilingual)

### 6.1 Info
Title (EN): Information
Body (EN): This change affects current session behavior.
Title (ZH): 信息
Body (ZH): 此变更将影响当前会话行为。

### 6.2 Warning
Title (EN): Action Required
Body (EN): Some features may be unavailable until configuration is complete.
Title (ZH): 需要处理
Body (ZH): 在配置完成前，部分功能可能不可用。

### 6.3 Danger
Title (EN): Danger Zone
Body (EN): Deleting local memory cannot be undone.
Title (ZH): 高风险操作区
Body (ZH): 删除本地记忆后不可恢复。

## 7. Empty State Templates

Preferred format:
- Title: state summary
- Body: what to do next
- Action: single primary CTA

Example:
- Title: No knowledge cards yet
- Body: Start a conversation to let the system capture memory.
- Action: Go to Chat

## 8. Error Message Templates

Structure:
- What failed
- Why it likely happened
- What user can do now

Template:
- EN: Connection failed. The local service is unavailable. Please check network and retry.
- ZH: 连接失败。本地服务当前不可用。请检查网络后重试。

Avoid:
- Raw technical strings in user-visible UI (unless inside diagnostics/log modal)

## 9. Emoji Replacement Map (Legacy to Standard)

- 🧠 Memory -> Icon: Brain, Label: Memory
- ⚙️ Settings -> Icon: Settings, Label: Settings
- ⚠️ Warning -> Icon: TriangleAlert, Label: Action Required
- ❌ Error -> Icon: CircleX, Label: Failed
- ✅ Success -> Icon: CheckCircle2, Label: Completed
- 🔄 Sync -> Icon: RefreshCw, Label: Syncing
- ☁️ Cloud -> Icon: Cloud, Label: Cloud
- 💾 Local -> Icon: HardDrive, Label: Local

## 10. Accessibility and Readability Requirements

1. Contrast
- Body text must meet WCAG AA minimum contrast
- Warning and danger text in light mode must use deep tone text, not low-alpha pastel text

2. Color independence
- Every status must include text label, not color-only meaning

3. Keyboard and screen reader
- Inputs need accessible label or aria-label
- Destructive actions need explicit labels and confirmation copy

## 11. Implementation Checklist

Design checklist:
- Remove emoji from all product-owned labels
- Apply icon mapping table
- Verify contrast in light and dark themes

Frontend checklist:
- Replace emoji literals in static UI strings
- Keep i18n keys stable where possible
- Add aria-label and title for unlabeled controls

QA checklist:
- Verify no emoji in navigation, settings cards, alerts, and CTA labels
- Verify warning and danger blocks are readable in light mode
- Verify text still readable at 90%, 100%, 110%, 125% app zoom

## 12. Rollout Plan

Phase 1 (Immediate):
- New UI and changed UI must follow this guideline

Phase 2 (Incremental cleanup):
- Replace legacy emoji labels module-by-module
- Prioritize Settings, Memory, and Dashboard warning areas

Phase 3 (Enforcement):
- Add copy review checkpoint in PR template
- Reject new emoji in product-owned UI copy unless explicitly approved

## 13. PR Review Rule for Copy

A PR passes copy review only if:
- No new emoji is added to product-owned text
- Action labels are explicit
- Warning and danger text remains readable in light mode
- Error text includes actionable next step
