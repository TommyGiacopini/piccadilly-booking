import "server-only";

import { randomUUID } from "node:crypto";

import type { ExportPorts, ExportPreviewPorts } from "@/modules/exports/application/export-ports";
import { createExportService, createExportPreviewService } from "@/modules/exports/application/export-service";
import { renderExcelExport } from "@/modules/exports/infrastructure/exceljs-export-renderer";
import {
  readExportSnapshot,
  readExportPreview,
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

export function createInfrastructurePreviewService(overrides: Partial<ExportPreviewPorts> = {}) {
  return createExportPreviewService({ snapshotReader: { read: readExportPreview }, clock: { now: () => new Date() }, ...overrides });
}
