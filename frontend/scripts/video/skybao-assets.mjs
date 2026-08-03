export const VIDEO_SETTINGS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  theme: "dark",
  alphaMode: "straight",
  colorSpace: "sRGB",
});

const still = (id, area, label, route, state = id) => ({
  id,
  area,
  label,
  route,
  state,
  type: "still",
});

export const STILL_ASSETS = Object.freeze([
  still("assistant-idle", "assistant", "Assistant · Acme story", "/?demo=acme"),
  still(
    "knowledge-files",
    "knowledge",
    "Knowledge · Files",
    "/knowledge?view=Files"
  ),
  still(
    "knowledge-collections",
    "knowledge",
    "Knowledge · Collections",
    "/knowledge?view=Collections"
  ),
  still(
    "knowledge-data",
    "knowledge",
    "Knowledge · Data",
    "/knowledge?view=Data"
  ),
  still(
    "knowledge-connections",
    "knowledge",
    "Knowledge · Connections",
    "/knowledge?view=Connections"
  ),
  still(
    "knowledge-skills",
    "knowledge",
    "Knowledge · Skills",
    "/knowledge?view=Skills"
  ),
  still(
    "communications-inbox",
    "communications",
    "Communications · Inbox",
    "/communications?view=Inbox"
  ),
  still(
    "communications-slack",
    "communications",
    "Communications · Slack",
    "/communications?view=Slack"
  ),
  still("work-overview", "work", "Work · Overview", "/work?view=Overview"),
  still("work-board", "work", "Work · Board", "/work?view=Board"),
  still("work-tasks", "work", "Work · Tasks", "/work?view=Tasks"),
  still("work-reminders", "work", "Work · Reminders", "/work?view=Reminders"),
  still("work-approvals", "work", "Work · Approvals", "/work?view=Approvals"),
  still(
    "work-agent-runs",
    "work",
    "Work · Agent runs",
    "/work?view=Agent+runs"
  ),
  still("admin-privacy", "admin", "Admin · Privacy", "/admin?view=Privacy"),
  still("admin-users", "admin", "Admin · Users", "/admin?view=Users"),
  still(
    "admin-permissions",
    "admin",
    "Admin · Permissions",
    "/admin?view=Permissions"
  ),
  still("admin-models", "admin", "Admin · Models", "/admin?view=Models"),
  still(
    "admin-deployment",
    "admin",
    "Admin · Deployment",
    "/admin?view=Deployment"
  ),
  still("admin-system", "admin", "Admin · System", "/admin?view=System"),
]);

const clip = (
  id,
  area,
  label,
  route,
  durationSeconds,
  actions = [],
  state = id
) => ({
  id,
  area,
  label,
  route,
  state,
  type: "clip",
  durationSeconds,
  frameCount: durationSeconds * VIDEO_SETTINGS.fps,
  actions,
});

export const MOTION_ASSETS = Object.freeze([
  clip(
    "assistant-research",
    "assistant",
    "Assistant · source research",
    "/?demo=acme",
    4
  ),
  clip(
    "assistant-answer-typing",
    "assistant",
    "Assistant · grounded answer typing",
    "/?demo=acme",
    6
  ),
  clip(
    "assistant-citation",
    "assistant",
    "Assistant · citation preview",
    "/?demo=acme",
    3,
    [{ frame: 24, type: "click", target: "assistant-citation-acme-msa" }]
  ),
  clip(
    "assistant-draft",
    "assistant",
    "Assistant · editable response draft",
    "/?demo=acme",
    4,
    [
      { frame: 18, type: "click", target: "assistant-draft-toggle" },
      {
        startFrame: 42,
        endFrame: 102,
        type: "type",
        target: "assistant-draft-text",
        text: "\n\nI’ve attached the relevant clauses for convenience.",
      },
    ]
  ),
  clip(
    "assistant-create-task",
    "assistant",
    "Assistant · create review task",
    "/?demo=acme",
    3,
    [
      {
        frame: 30,
        type: "click",
        target: "assistant-create-task",
        navigation: true,
      },
    ]
  ),
  clip(
    "knowledge-file-search",
    "knowledge",
    "Knowledge · search and filter files",
    "/knowledge?view=Files",
    4,
    [
      {
        startFrame: 24,
        endFrame: 66,
        type: "type",
        target: "knowledge-file-search",
        text: "Acme",
      },
      {
        frame: 84,
        type: "select",
        target: "knowledge-type-filter",
        value: "PDF",
      },
    ]
  ),
  clip(
    "knowledge-upload",
    "knowledge",
    "Knowledge · mock upload",
    "/knowledge?view=Files",
    3,
    [{ frame: 30, type: "click", target: "knowledge-upload" }]
  ),
  clip(
    "knowledge-source-preview",
    "knowledge",
    "Knowledge · source preview",
    "/knowledge?view=Files",
    3,
    [{ frame: 28, type: "click", target: "knowledge-file-preview-0" }]
  ),
  clip(
    "knowledge-data-analysis",
    "knowledge",
    "Knowledge · switch dataset and ask",
    "/knowledge?view=Data",
    5,
    [
      { frame: 30, type: "click", target: "knowledge-dataset-1" },
      { frame: 86, type: "click", target: "knowledge-data-ask" },
    ]
  ),
  clip(
    "knowledge-skill-config",
    "knowledge",
    "Knowledge · open skill configuration",
    "/knowledge?view=Skills",
    3,
    [{ frame: 30, type: "click", target: "knowledge-skill-0" }]
  ),
  clip(
    "communications-filter-select",
    "communications",
    "Communications · filter and select",
    "/communications?view=Inbox",
    4,
    [
      {
        frame: 28,
        type: "select",
        target: "communications-source-filter",
        value: "Slack",
      },
      { frame: 72, type: "click", target: "communications-thread-3" },
    ]
  ),
  clip(
    "communications-source-preview",
    "communications",
    "Communications · cited context",
    "/communications?view=Inbox",
    3,
    [{ frame: 26, type: "click", target: "communications-cited-context" }]
  ),
  clip(
    "communications-draft-review",
    "communications",
    "Communications · draft and submit for review",
    "/communications?view=Inbox",
    5,
    [
      { frame: 20, type: "click", target: "communications-draft-open" },
      {
        startFrame: 42,
        endFrame: 102,
        type: "type",
        target: "communications-draft-text",
        text: " I’ll include the cited clauses in the review copy.",
      },
      { frame: 126, type: "click", target: "communications-draft-approve" },
    ]
  ),
  clip(
    "communications-convert-task",
    "communications",
    "Communications · convert request to task",
    "/communications?view=Inbox",
    3,
    [
      {
        frame: 30,
        type: "click",
        target: "communications-convert-task",
        navigation: true,
      },
    ]
  ),
  clip(
    "work-board-drag",
    "work",
    "Work · drag Acme review to complete",
    "/work?view=Board&created=1&focus=acme",
    4,
    [
      {
        startFrame: 34,
        endFrame: 92,
        type: "drag",
        target: "work-task-acme-review",
        destination: "work-column-complete",
      },
    ]
  ),
  clip(
    "work-task-approval",
    "work",
    "Work · approve Acme response",
    "/work?view=Board&created=1&focus=acme",
    5,
    [{ frame: 76, type: "click", target: "work-task-approve" }]
  ),
  clip(
    "work-approval-action",
    "work",
    "Work · preview and approve action",
    "/work?view=Approvals",
    4,
    [
      { frame: 26, type: "click", target: "work-approval-preview-0" },
      { frame: 78, type: "click", target: "work-approval-approve-0" },
    ]
  ),
  clip(
    "work-agent-run-detail",
    "work",
    "Work · open agent run detail",
    "/work?view=Agent+runs",
    3,
    [{ frame: 30, type: "click", target: "work-agent-run-open-0" }]
  ),
  clip(
    "global-ask-popover",
    "knowledge",
    "Global · Ask SkyBao popover",
    "/knowledge?view=Files",
    3,
    [
      { frame: 18, type: "click", target: "global-ask-toggle" },
      {
        startFrame: 38,
        endFrame: 76,
        type: "type",
        target: "global-ask-input",
        text: "Summarize the Acme request",
      },
    ]
  ),
]);

export const ALL_ASSETS = Object.freeze([...STILL_ASSETS, ...MOTION_ASSETS]);
