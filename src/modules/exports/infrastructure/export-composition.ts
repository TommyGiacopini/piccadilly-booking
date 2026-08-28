import "server-only";

import { randomUUID } from "node:crypto";

import type { ExportPorts } from "@/modules/exports/application/export-ports";
import { createExportService } from "@/modules/exports/application/export-service";
import { renderExcelExport } from "@/modules/exports/infrastructure/exceljs-export-renderer";
import {
  readExportSnapshot,
  writeExportAudit,
} from "@/modules/exports/infrastructure/export-repository";
import { renderPdfExport } from "@/modules/exports/infrastructure/pdfkit-export-renderer";

const infrastructurePorts: ExportPorts = {
  snapshotReader: { read: readExportSnapshot },
  auditWriter: { write: writeExportAudit },
  pdfRenderer: { render: renderPdfExport },
  excelRenderer: { render: renderExcelExport },
  clock: { now: () => new Date() },
  correlationIds: { generate: randomUUID },
};

export function createInfrastructureExportService(
  overrides: Partial<ExportPorts> = {},
) {
  return createExportService({ ...infrastructurePorts, ...overrides });
}
