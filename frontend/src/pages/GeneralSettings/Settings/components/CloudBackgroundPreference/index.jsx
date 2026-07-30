import { useState, useEffect } from "react";
import Appearance from "@/models/appearance";
import { useTranslation } from "react-i18next";
import Toggle from "@/components/lib/Toggle";

// Dispatched after every change so the live CloudBackgroundLayer re-evaluates
// without requiring a navigation or reload.
export const CLOUDS_UPDATED_EVENT = "clouds-updated";

// The four toggleable surfaces, paired with their Appearance key + i18n label key.
const SURFACES = [
  { key: "cloudsOnSettings", labelKey: "settings" },
  { key: "cloudsOnHome", labelKey: "home" },
  { key: "cloudsOnLogin", labelKey: "login" },
  { key: "cloudsOnChat", labelKey: "chat" },
];

export default function CloudBackgroundPreference() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(Appearance.getSettings());

  useEffect(() => {
    setSettings(Appearance.getSettings());
  }, []);

  const handleChange = (key) => (checked) => {
    Appearance.set(key, checked);
    setSettings(Appearance.getSettings());
    window.dispatchEvent(new Event(CLOUDS_UPDATED_EVENT));
  };

  return (
    <div className="flex flex-col gap-y-0.5 my-4">
      <p className="text-sm leading-6 font-semibold text-white">
        {t("customization.items.cloud-background.title")}
      </p>
      <p className="text-xs text-white/60">
        {t("customization.items.cloud-background.description")}
      </p>
      <div className="mt-3 flex flex-col gap-y-3">
        {SURFACES.map(({ key, labelKey }) => (
          <Toggle
            key={key}
            size="md"
            variant="horizontal"
            enabled={!!settings[key]}
            onChange={handleChange(key)}
            label={t(
              `customization.items.cloud-background.surfaces.${labelKey}`
            )}
          />
        ))}
      </div>
    </div>
  );
}
