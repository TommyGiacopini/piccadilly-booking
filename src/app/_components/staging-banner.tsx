import {
  STAGING_BANNER_TEXT,
} from "@/server/staging/access-gate";
import { getAppEnvironment } from "@/shared/config/app-environment";

export function StagingBanner() {
  if (getAppEnvironment() !== "staging") return null;

  return (
    <aside className="staging-banner" role="status" aria-label="Ambiente demo">
      {STAGING_BANNER_TEXT}
    </aside>
  );
}
