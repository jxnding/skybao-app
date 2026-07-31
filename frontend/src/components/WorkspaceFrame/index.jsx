import React from "react";
import { isMobile } from "react-device-detect";

/**
 * The inset application workspace used by Assistant and connected-work areas.
 * The app shell owns the full-screen background; this component owns the
 * consistent desktop gutter, rounded surface, and light-theme border.
 */
export default function WorkspaceFrame({
  children,
  className = "",
  mobileHeaderOffset = false,
}) {
  return (
    <div
      style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
      className={`relative z-[2] flex w-full md:ml-[2px] md:mr-[16px] md:my-[16px] ${
        mobileHeaderOffset && isMobile ? "pt-16" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function WorkspaceSurface({
  children,
  className = "",
  bordered = false,
}) {
  return (
    <div
      className={`relative min-w-0 flex-1 w-full h-full overflow-hidden transition-all duration-500 md:rounded-[16px] bg-zinc-900 light:bg-white ${
        bordered
          ? "border-none light:border-solid light:border light:border-theme-modal-border"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
