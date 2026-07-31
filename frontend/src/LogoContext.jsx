import { createContext, useEffect, useState } from "react";
import DefaultLoginLogoLight from "./media/illustrations/skybao-login.svg";
import DefaultLoginLogoDark from "./media/illustrations/skybao-login-light.svg";
import System from "./models/system";

export const REFETCH_LOGO_EVENT = "refetch-logo";
const DEFAULT_SKYBAO_LOGO = "/skybao-logo.svg";

function isLightMode() {
  return document.documentElement.getAttribute("data-theme") === "light";
}
export const LogoContext = createContext();

export function LogoProvider({ children }) {
  const [logo, setLogo] = useState("");
  const [loginLogo, setLoginLogo] = useState("");
  const [isCustomLogo, setIsCustomLogo] = useState(false);

  async function fetchInstanceLogo() {
    const DefaultLoginLogo = isLightMode()
      ? DefaultLoginLogoDark
      : DefaultLoginLogoLight;
    try {
      const { isCustomLogo, logoURL } = await System.fetchLogo();
      if (logoURL && isCustomLogo) {
        setLogo(logoURL);
        setLoginLogo(logoURL);
        setIsCustomLogo(true);
      } else {
        setLogo(DEFAULT_SKYBAO_LOGO);
        setLoginLogo(DefaultLoginLogo);
        setIsCustomLogo(false);
      }
    } catch (err) {
      setLogo(DEFAULT_SKYBAO_LOGO);
      setLoginLogo(DefaultLoginLogo);
      setIsCustomLogo(false);
      console.error("Failed to fetch logo:", err);
    }
  }

  useEffect(() => {
    fetchInstanceLogo();
    window.addEventListener(REFETCH_LOGO_EVENT, fetchInstanceLogo);
    return () => {
      window.removeEventListener(REFETCH_LOGO_EVENT, fetchInstanceLogo);
    };
  }, []);

  return (
    <LogoContext.Provider value={{ logo, setLogo, loginLogo, isCustomLogo }}>
      {children}
    </LogoContext.Provider>
  );
}
