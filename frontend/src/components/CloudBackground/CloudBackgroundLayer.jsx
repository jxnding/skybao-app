import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import Appearance from "@/models/appearance";
import CloudBackground from ".";
import { CLOUDS_UPDATED_EVENT } from "@/pages/GeneralSettings/Settings/components/CloudBackgroundPreference";

/**
 * Resolves the current page surface from the URL path to one of the four
 * toggleable cloud-background surfaces (or null if the route isn't one of them).
 *
 * @param {string} pathname
 * @returns {"home" | "settings" | "login" | "chat" | null}
 */
function surfaceFromPath(pathname) {
  // The connected-work areas share the Assistant's application shell, so
  // they intentionally follow its cloud preference instead of introducing a
  // second, route-local background layer.
  if (
    pathname === "/" ||
    ["/knowledge", "/communications", "/work", "/admin"].includes(pathname)
  )
    return "home";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/login")) return "login";
  if (pathname.startsWith("/workspace")) return "chat";
  return null;
}

// Map each surface to its Appearance setting key.
const SETTING_KEY_BY_SURFACE = {
  home: "cloudsOnHome",
  settings: "cloudsOnSettings",
  login: "cloudsOnLogin",
  chat: "cloudsOnChat",
};

/**
 * Renders the fixed cloud layer behind page content, but only on the surfaces
 * the user has enabled in Settings → UI Preferences → Cloud Background. The
 * preference is read from the localStorage-backed Appearance model and
 * re-evaluated on every navigation and whenever a toggle changes.
 */
export default function CloudBackgroundLayer() {
  const { pathname, search } = useLocation();
  const transparentCapture =
    new URLSearchParams(search).get("capture") === "transparent";
  // A counter that bumps on `clouds-updated` so we re-read settings live
  // without a navigation. (Appearance is not reactive on its own.)
  const [, setRevision] = useState(0);

  useEffect(() => {
    const handler = () => setRevision((r) => r + 1);
    window.addEventListener(CLOUDS_UPDATED_EVENT, handler);
    return () => window.removeEventListener(CLOUDS_UPDATED_EVENT, handler);
  }, []);

  const surface = surfaceFromPath(pathname);
  const settingKey = surface ? SETTING_KEY_BY_SURFACE[surface] : null;
  const showClouds = transparentCapture
    ? false
    : settingKey
      ? Appearance.get(settingKey)
      : false;

  const toggleBodyClass = (active) => {
    document.body.classList.toggle("clouds-active", active);
    if (!active) document.body.classList.remove("clouds-active");
  };

  useEffect(() => {
    toggleBodyClass(showClouds);
    return () => toggleBodyClass(false);
  }, [showClouds]);

  useEffect(() => {
    document.documentElement.classList.toggle(
      "capture-transparent",
      transparentCapture
    );
    return () =>
      document.documentElement.classList.remove("capture-transparent");
  }, [transparentCapture]);

  if (!showClouds) return null;
  return <CloudBackground />;
}
