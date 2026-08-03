import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const DEFAULT_CAPTURE = {
  artifact: false,
  frame: 0,
  framing: "shell",
  state: "",
  transparent: false,
};

const CaptureContext = createContext(DEFAULT_CAPTURE);

export function getCaptureConfig(search = "") {
  const params = new URLSearchParams(search);
  const artifact =
    import.meta.env.VITE_SKYBAO_CAPTURE === "1" &&
    params.get("artifact") === "1" &&
    params.get("capture") === "transparent";
  return {
    artifact,
    framing:
      artifact && params.get("framing") === "workspace" ? "workspace" : "shell",
    state: artifact ? params.get("state") || "" : "",
    transparent: params.get("capture") === "transparent",
  };
}

function nextPaint() {
  return new Promise((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
  );
}

export function CaptureProvider({ children, config }) {
  const captureConfig = config || DEFAULT_CAPTURE;
  const [frame, setFrame] = useState(0);
  const frameRef = useRef(0);

  const setCaptureFrame = useCallback(async (nextFrame) => {
    const normalized = Math.max(0, Math.floor(Number(nextFrame) || 0));
    frameRef.current = normalized;
    setFrame(normalized);
    await nextPaint();
    return normalized;
  }, []);

  useEffect(() => {
    if (!captureConfig.artifact) return undefined;

    const root = document.documentElement;
    const api = {
      ready: false,
      setFrame: setCaptureFrame,
      getFrame: () => frameRef.current,
    };

    window.__SKYBAO_CAPTURE__ = api;
    root.classList.add("skybao-artifact-capture");
    root.classList.remove("light");
    root.dataset.theme = "dark";
    root.dataset.skybaoCaptureFrame = "0";
    root.dataset.skybaoCaptureState = captureConfig.state;

    Promise.resolve(document.fonts?.ready)
      .then(nextPaint)
      .then(() => {
        if (window.__SKYBAO_CAPTURE__ !== api) return;
        api.ready = true;
        root.dataset.skybaoCaptureReady = "true";
      });

    return () => {
      if (window.__SKYBAO_CAPTURE__ === api) delete window.__SKYBAO_CAPTURE__;
      root.classList.remove("skybao-artifact-capture");
      delete root.dataset.skybaoCaptureFrame;
      delete root.dataset.skybaoCaptureReady;
      delete root.dataset.skybaoCaptureState;
    };
  }, [captureConfig.artifact, captureConfig.state, setCaptureFrame]);

  useEffect(() => {
    if (!captureConfig.artifact) return;
    document.documentElement.dataset.skybaoCaptureFrame = String(frame);
    document.documentElement.style.setProperty(
      "--skybao-capture-frame",
      String(frame)
    );
  }, [captureConfig.artifact, frame]);

  const value = useMemo(
    () => ({ ...captureConfig, frame }),
    [captureConfig, frame]
  );

  return (
    <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>
  );
}

export function useCapture() {
  return useContext(CaptureContext);
}
