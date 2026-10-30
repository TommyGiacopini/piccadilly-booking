import type {
  ExportFailureCode,
  ExportFormat,
  ExportPeriod,
  ExportSnapshotDto,
} from "@/modules/exports/domain/export-domain";

export interface ExportActorReference {
  id: string;
  restaurantId: string;
}

export interface ExportSnapshotReader {
  read(input: {
    actor: ExportActorReference;
    period: ExportPeriod;
    maximumReservations?: number;
  }): Promise<ExportSnapshotDto>;
}

export interface ExportPreviewReader {
  read(input: {
    actor: ExportActorReference;
    selection: import("@/modules/exports/domain/export-contract").ExportPreviewRequest;
    maximumReservations: number;
  }): Promise<import("@/modules/exports/domain/export-contract").ExportPreviewSnapshot>;
}
export interface ExportPreviewPorts {
  snapshotReader: ExportPreviewReader;
  clock: ExportClock;
}

export interface ExportAuditWriteInput {
  actor: ExportActorReference;
  format: ExportFormat;
  outcome: "SUCCESS" | "FAILURE";
  correlationId: string;
  metadata:
    | {
        format: ExportFormat;
        mode: string;
        fromDate: string;
        toDate: string;
        dayCount: number;
        reservationCount: number;
      }
    | {
        format: ExportFormat;
        mode: string;
        fromDate: string;
        toDate: string;
        dayCount: number;
        failureCode: ExportFailureCode;
      };
  createdAt: Date;
}

export interface ExportAuditWriter {
  write(input: ExportAuditWriteInput): Promise<void>;
}

export interface PdfExportRenderer {
  render(snapshot: ExportSnapshotDto): Promise<Buffer>;
}

export interface ExcelExportRenderer {
  render(snapshot: ExportSnapshotDto): Promise<Buffer>;
}

export interface ExportClock {
  now(): Date;
}

export interface ExportCorrelationIdGenerator {
  generate(): string;
}

export interface ExportPorts {
  snapshotReader: ExportSnapshotReader;
  auditWriter: ExportAuditWriter;
  pdfRenderer: PdfExportRenderer;
  excelRenderer: ExcelExportRenderer;
  clock: ExportClock;
  correlationIds: ExportCorrelationIdGenerator;
}
