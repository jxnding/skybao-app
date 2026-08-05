import {
  BookOpen,
  ChatCircleDots,
  GearSix,
  Layout,
  PaperPlaneTilt,
} from "@phosphor-icons/react";

/** Keep the application sidebar and capture drawer on one five-area map. */
export const PRIMARY_AREAS = Object.freeze([
  {
    id: "assistant",
    label: "Assistant",
    route: "/",
    icon: ChatCircleDots,
    children: ["Chat", "History"],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    route: "/knowledge",
    icon: BookOpen,
    children: ["Files", "Collections", "Data", "Connections", "Skills"],
  },
  {
    id: "communications",
    label: "Communications",
    route: "/communications",
    icon: PaperPlaneTilt,
    badge: "1",
    children: ["Inbox", "Slack"],
  },
  {
    id: "work",
    label: "Work",
    route: "/work",
    icon: Layout,
    children: [
      "Overview",
      "Board",
      "Tasks",
      "Reminders",
      "Approvals",
      "Agent runs",
    ],
  },
  {
    id: "admin",
    label: "Admin",
    route: "/admin",
    icon: GearSix,
    admin: true,
    children: [
      "Privacy",
      "Users",
      "Permissions",
      "Models",
      "Deployment",
      "System",
    ],
  },
]);

export const CAPTURE_NAVIGATION_TARGETS = Object.freeze({
  "area-nav-assistant-knowledge": "knowledge",
  "area-nav-knowledge-communications": "communications",
  "area-nav-communications-work": "work",
  "area-nav-work-admin": "admin",
});

export function isCaptureNavigationState(state) {
  return Object.hasOwn(CAPTURE_NAVIGATION_TARGETS, state);
}

export function captureNavigationTarget(state) {
  return CAPTURE_NAVIGATION_TARGETS[state] || null;
}

export function primaryAreaById(id) {
  return PRIMARY_AREAS.find((area) => area.id === id) || PRIMARY_AREAS[0];
}
