import React from "react";
import { isMobile } from "react-device-detect";
import PasswordModal, { usePasswordModal } from "@/components/Modals/Password";
import { FullScreenLoader } from "@/components/Preloader";
import Sidebar, { SidebarMobileHeader } from "@/components/Sidebar";
import NativeArea from "@/pages/NativeArea";
import WorkspaceFrame, { WorkspaceSurface } from "@/components/WorkspaceFrame";
import { useLocation } from "react-router-dom";

/** Native application chrome for SkyBao's connected-work areas. */
export default function NativeAreaShell({ area }) {
  const { loading, requiresAuth, mode } = usePasswordModal();
  const { search } = useLocation();
  const transparent =
    new URLSearchParams(search).get("capture") === "transparent";

  if (loading) return <FullScreenLoader />;
  if (requiresAuth !== false)
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;

  return (
    <div
      className={`relative z-[2] w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex ${
        transparent ? "sb-capture-stage" : ""
      }`}
    >
      {!isMobile ? <Sidebar /> : <SidebarMobileHeader />}
      <WorkspaceFrame
        className="min-w-0 flex-1 overflow-hidden"
        mobileHeaderOffset
      >
        <WorkspaceSurface
          bordered
          className={`overflow-y-auto ${
            transparent ? "sb-capture-surface" : ""
          }`}
        >
          <NativeArea area={area} />
        </WorkspaceSurface>
      </WorkspaceFrame>
    </div>
  );
}
