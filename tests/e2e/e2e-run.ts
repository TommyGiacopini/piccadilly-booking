const runId = process.env.E2E_RUN_ID?.trim().toLowerCase();

if (!runId) {
  throw new Error("E2E_RUN_ID is required for browser fixtures.");
}

export const e2eRunId = runId;
export const e2eReservationFirstName = `E2E-${runId}`;
