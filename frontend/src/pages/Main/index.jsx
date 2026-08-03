import React, { lazy, Suspense } from "react";
import PasswordModal, { usePasswordModal } from "@/components/Modals/Password";
import { FullScreenLoader } from "@/components/Preloader";
import Home from "./Home";
import { isMobile } from "react-device-detect";
import Sidebar, { SidebarMobileHeader } from "@/components/Sidebar";
import { useLocation } from "react-router-dom";

const AssistantStory = lazy(() => import("@/pages/NativeArea/AssistantStory"));

export default function Main() {
  const { loading, requiresAuth, mode } = usePasswordModal();
  const { search } = useLocation();
  const searchParams = new URLSearchParams(search);
  const storyMode = searchParams.get("demo") === "acme";
  const transparent = searchParams.get("capture") === "transparent";

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
      {storyMode ? (
        <Suspense fallback={<FullScreenLoader />}>
          <AssistantStory />
        </Suspense>
      ) : (
        <Home />
      )}
    </div>
  );
}
