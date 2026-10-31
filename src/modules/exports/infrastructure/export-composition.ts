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
import { createPdfV2Service } from "@/modules/exports/application/pdf-v2-service";
import type { PdfV2Ports } from "@/modules/exports/application/pdf-v2-ports";
import { renderPdfV2 } from "@/modules/exports/infrastructure/pdfkit-v2-export-renderer";

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

export function createInfrastructurePdfV2Service(overrides: Partial<PdfV2Ports> = {}) {
  return createPdfV2Service({
    snapshotReader: { read: readExportPreview }, renderer: { render: renderPdfV2 },
    auditWriter: { write: writeExportAudit }, clock: { now: () => new Date() },
    correlationIds: { generate: randomUUID }, ...overrides,
  });
}

export const pdfV2Service = createInfrastructurePdfV2Service();
