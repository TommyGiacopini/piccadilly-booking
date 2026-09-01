import { validateStagingWebEnvironment } from "./staging-config.mjs";

try {
  validateStagingWebEnvironment(process.env);
  console.info("Staging web configuration is valid.");
} catch {
  console.error("Staging web configuration validation failed.");
  process.exitCode = 1;
}
