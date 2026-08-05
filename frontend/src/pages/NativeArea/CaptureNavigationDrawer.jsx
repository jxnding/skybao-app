import React, { useEffect, useMemo, useState } from "react";
import { isCaptureNavigationState, PRIMARY_AREAS } from "./navigation";
import { useCapture } from "./capture";
import { CAPTURE_NAVIGATION_TIMING as timing } from "./captureNavigationTiming";

function easedProgress(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return 1 - Math.pow(1 - clamped, 3);
}

/** Deterministic, capture-only primary navigation before a glass-panel flip. */
export default function CaptureNavigationDrawer({ area }) {
  const capture = useCapture();
  const [selectedArea, setSelectedArea] = useState(area);

  useEffect(() => {
    setSelectedArea(area);
  }, [area, capture.state]);

  const progress = useMemo(() => {
    if (capture.frame <= timing.drawerOpenEndFrame)
      return easedProgress(capture.frame / timing.drawerOpenEndFrame);
    if (capture.frame < timing.drawerCloseStartFrame) return 1;
    if (capture.frame <= timing.finalFrame) {
      const closeFrames = timing.finalFrame - timing.drawerCloseStartFrame;
      return (
        1 -
        easedProgress(
          (capture.frame - timing.drawerCloseStartFrame) / closeFrames
        )
      );
    }
    return 0;
  }, [capture.frame]);

  if (!capture.artifact || !isCaptureNavigationState(capture.state))
    return null;

  return (
    <aside
      aria-label="SkyBao primary navigation"
      className="sb-capture-nav-drawer"
      style={{
        opacity: progress,
        transform: `translateX(${Math.round((-1 + progress) * 1000) / 10}%)`,
      }}
    >
      <div className="sb-capture-nav-brand">SkyBao</div>
      <p>Atlas workspace</p>
      <nav>
        {PRIMARY_AREAS.map((item) => {
          const Icon = item.icon;
          const selected = selectedArea === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-capture-id={`capture-nav-area-${item.id}`}
              className={selected ? "selected" : ""}
              aria-current={selected ? "page" : undefined}
              onClick={() => setSelectedArea(item.id)}
            >
              <Icon weight={selected ? "fill" : "regular"} />
              <span>{item.label}</span>
              {item.badge && <i>{item.badge}</i>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
