import React from "react";
import { isMobile } from "react-device-detect";
import PasswordModal, { usePasswordModal } from "@/components/Modals/Password";
import { FullScreenLoader } from "@/components/Preloader";
import Sidebar, { SidebarMobileHeader } from "@/components/Sidebar";
import NativeArea from "@/pages/NativeArea";
import WorkspaceFrame, { WorkspaceSurface } from "@/components/WorkspaceFrame";
import { useLocation } from "react-router-dom";
import { CaptureProvider, getCaptureConfig } from "@/pages/NativeArea/capture";

/** Native application chrome for SkyBao's connected-work areas. */
export default function NativeAreaShell({ area }) {
  const { loading, requiresAuth, mode } = usePasswordModal();
  const { search } = useLocation();
  const capture = getCaptureConfig(search);
  const workspaceOnly = capture.artifact && capture.framing === "workspace";

  if (!capture.artifact && loading) return <FullScreenLoader />;
  if (!capture.artifact && requiresAuth !== false)
    return <>{requiresAuth !== null && <PasswordModal mode={mode} />}</>;

  return (
    <CaptureProvider config={capture}>
      <div
        data-capture-id="app-shell"
        className={`relative z-[2] w-screen h-screen overflow-hidden bg-zinc-950 light:bg-slate-50 flex ${
          capture.transparent ? "sb-capture-stage" : ""
        } ${workspaceOnly ? "sb-artifact-workspace-only" : ""}`}
      >
        {!workspaceOnly && (!isMobile ? <Sidebar /> : <SidebarMobileHeader />)}
        <WorkspaceFrame
          className="min-w-0 flex-1 overflow-hidden"
          mobileHeaderOffset
        >
          <WorkspaceSurface
            bordered
            className={`overflow-y-auto ${
              capture.transparent ? "sb-capture-surface" : ""
            }`}
          >
            <NativeArea area={area} />
          </WorkspaceSurface>
        </WorkspaceFrame>
      </div>
    </CaptureProvider>
  );
}
