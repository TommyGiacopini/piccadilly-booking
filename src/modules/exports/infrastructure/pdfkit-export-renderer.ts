import "server-only";

import PDFDocument from "pdfkit";

import type {
  ExportReservationDto,
  ExportSectionDto,
  ExportSnapshotDto,
} from "@/modules/exports/domain/export-domain";
import { loadNotoSansFont } from "@/modules/exports/infrastructure/font-loader";

const PAGE_MARGIN = 28;
const FOOTER_HEIGHT = 18;
const BODY_FONT_SIZE = 7.4;
const BODY_LINE_HEIGHT = 9.5;
const TABLE_HEADER_HEIGHT = 24;

const columns = [
  { label: "Servizio", key: "service", width: 48 },
  { label: "Ora arrivo", key: "time", width: 48 },
  { label: "Nome", key: "firstName", width: 82 },
  { label: "Cognome", key: "lastName", width: 88 },
  { label: "Persone", key: "partySize", width: 46 },
  { label: "Telefono", key: "phone", width: 104 },
  { label: "Tavoli definitivi", key: "tables", width: 185 },
  { label: "Creata il", key: "createdAt", width: 126 },
] as const;

function italianDate(localDate: string): string {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${localDate}T12:00:00.000Z`));
}

function formatCreatedAt(value: Date, timezone: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone,
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get("day")}/${parts.get("month")}/${parts.get("year")} ${parts.get("hour")}:${parts.get("minute")}`;
}

function serviceLabel(value: ExportReservationDto["serviceType"]): string {
  return value === "LUNCH" ? "Pranzo" : "Cena";
}

function detailText(reservation: ExportReservationDto): string {
  const needs = [
    reservation.highChair ? "Seggiolone" : null,
    reservation.stroller ? "Passeggino" : null,
    reservation.accessibility ? "Accessibilità" : null,
    reservation.children ? "Bambini" : null,
    reservation.celiac ? "Celiachia" : null,
    reservation.allergies ? `Allergie: ${reservation.allergies}` : null,
    reservation.intolerances
      ? `Intolleranze: ${reservation.intolerances}`
      : null,
    reservation.celebration
      ? `Celebrazione/ricorrenza: ${reservation.celebration}`
      : null,
    reservation.animals ? "Animali" : null,
  ].filter((value): value is string => value !== null);
  return [
    `Preferenza sala cliente: ${reservation.preferredRoom}`,
    needs.length > 0 ? `Esigenze operative: ${needs.join(", ")}` : null,
    reservation.notes ? `Note prenotazione: ${reservation.notes}` : null,
    reservation.assignment?.internalNotes
      ? `Note interne assignment: ${reservation.assignment.internalNotes}`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");
}

function normalizedWords(value: string): string[] {
  return value.replace(/\r\n?/gu, "\n").split(/([\s])/u).filter(Boolean);
}

function wrapText(doc: PDFKit.PDFDocument, value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";

  function pushLongToken(token: string) {
    let part = "";
    for (const character of token) {
      if (part && doc.widthOfString(part + character) > width) {
        lines.push(part);
        part = character;
      } else {
        part += character;
      }
    }
    line = part;
  }

  for (const word of normalizedWords(value)) {
    if (word === "\n") {
      lines.push(line.trimEnd());
      line = "";
      continue;
    }
    const candidate = line + word;
    if (!line || doc.widthOfString(candidate) <= width) {
      line = candidate;
      continue;
    }
    lines.push(line.trimEnd());
    const trimmed = word.trimStart();
    if (doc.widthOfString(trimmed) > width) pushLongToken(trimmed);
    else line = trimmed;
  }
  if (line || lines.length === 0) lines.push(line.trimEnd());
  return lines;
}

export async function renderPdfExport(snapshot: ExportSnapshotDto): Promise<Buffer> {
  const font = await loadNotoSansFont();
  const day = snapshot.days[0];
  if (!day || snapshot.days.length !== 1) {
    throw new Error("PDF export requires exactly one day.");
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: {
        top: PAGE_MARGIN,
        right: PAGE_MARGIN,
        bottom: PAGE_MARGIN + FOOTER_HEIGHT,
        left: PAGE_MARGIN,
      },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: "Prenotazioni operative",
        Author: "Piccadilly Booking",
        Subject: "Pranzo e cena",
        Creator: "Piccadilly Booking",
      },
    });
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    try {
      doc.registerFont("NotoSans", font);
      doc.font("NotoSans");
      const contentWidth = doc.page.width - PAGE_MARGIN * 2;
      const contentBottom = () => doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT;

      const drawPageHeader = () => {
        doc
          .font("NotoSans")
          .fillColor("#111111")
          .fontSize(14)
          .text(snapshot.restaurantName, PAGE_MARGIN, PAGE_MARGIN, {
            width: contentWidth * 0.55,
            lineBreak: false,
          });
        doc
          .fontSize(9)
          .text(`${italianDate(day.localDate)} · Pranzo e cena`, PAGE_MARGIN, PAGE_MARGIN + 4, {
            width: contentWidth,
            align: "right",
            lineBreak: false,
          });
        doc
          .moveTo(PAGE_MARGIN, PAGE_MARGIN + 24)
          .lineTo(doc.page.width - PAGE_MARGIN, PAGE_MARGIN + 24)
          .lineWidth(0.8)
          .strokeColor("#333333")
          .stroke();
        doc.y = PAGE_MARGIN + 34;
      };

      const drawSectionTitle = (section: ExportSectionDto, continued = false) => {
        const y = doc.y;
        doc.rect(PAGE_MARGIN, y, contentWidth, 20).fill("#E7E7E7");
        doc
          .fillColor("#111111")
          .fontSize(10)
          .text(`SEZIONE · ${section.label}${continued ? " (continua)" : ""}`, PAGE_MARGIN + 6, y + 5, {
            width: contentWidth - 12,
            lineBreak: false,
          });
        doc.y = y + 22;
      };

      const drawTableHeader = () => {
        const y = doc.y;
        doc.rect(PAGE_MARGIN, y, contentWidth, TABLE_HEADER_HEIGHT).fill("#333333");
        let x = PAGE_MARGIN;
        doc.fillColor("#FFFFFF").fontSize(7.1);
        for (const column of columns) {
          doc.text(column.label, x + 3, y + 5, {
            width: column.width - 6,
            height: TABLE_HEADER_HEIGHT - 6,
          });
          x += column.width;
        }
        doc.y = y + TABLE_HEADER_HEIGHT;
      };

      const continuationPage = (section: ExportSectionDto) => {
        doc.addPage();
        drawPageHeader();
        drawSectionTitle(section, true);
        drawTableHeader();
      };

      const mainValues = (reservation: ExportReservationDto) => ({
        service: serviceLabel(reservation.serviceType),
        time: reservation.arrivalTime,
        firstName: reservation.customerFirstName,
        lastName: reservation.customerLastName,
        partySize: String(reservation.partySize),
        phone: reservation.customerPhone,
        tables:
          reservation.assignment?.tables.map((table) => table.name).join(", ") || "—",
        createdAt: formatCreatedAt(reservation.createdAt, snapshot.timezone),
      });

      const drawReservation = (
        reservation: ExportReservationDto,
        section: ExportSectionDto,
        index: number,
      ) => {
        doc.font("NotoSans").fontSize(BODY_FONT_SIZE);
        const values = mainValues(reservation);
        const mainHeight = Math.max(
          ...columns.map((column) =>
            doc.heightOfString(values[column.key], {
              width: column.width - 6,
              lineGap: 0,
            }),
          ),
          BODY_LINE_HEIGHT,
        ) + 6;
        const details = detailText(reservation);
        const detailLines = wrapText(doc, details, contentWidth - 12);
        const detailHeight = detailLines.length * BODY_LINE_HEIGHT + 6;
        const totalHeight = mainHeight + detailHeight;
        if (doc.y + Math.min(totalHeight, mainHeight + BODY_LINE_HEIGHT + 6) > contentBottom()) {
          continuationPage(section);
        }

        let y = doc.y;
        if (index % 2 === 1) {
          doc.rect(PAGE_MARGIN, y, contentWidth, mainHeight).fill("#F6F6F6");
        }
        let x = PAGE_MARGIN;
        doc.fillColor("#111111").fontSize(BODY_FONT_SIZE);
        for (const column of columns) {
          doc.text(values[column.key], x + 3, y + 3, {
            width: column.width - 6,
            height: mainHeight - 4,
            lineGap: 0,
          });
          x += column.width;
        }
        doc
          .moveTo(PAGE_MARGIN, y + mainHeight)
          .lineTo(doc.page.width - PAGE_MARGIN, y + mainHeight)
          .lineWidth(0.25)
          .strokeColor("#BDBDBD")
          .stroke();
        doc.y = y + mainHeight;

        for (const line of detailLines) {
          if (doc.y + BODY_LINE_HEIGHT + 4 > contentBottom()) {
            continuationPage(section);
            doc
              .fillColor("#555555")
              .fontSize(7)
              .text("Dettagli prenotazione (continua)", PAGE_MARGIN + 6, doc.y + 2, {
                width: contentWidth - 12,
              });
            doc.y += 2;
          }
          y = doc.y;
          doc.rect(PAGE_MARGIN, y, contentWidth, BODY_LINE_HEIGHT).fill("#FAFAFA");
          doc
            .fillColor("#333333")
            .fontSize(7.1)
            .text(line, PAGE_MARGIN + 6, y + 1.2, {
              width: contentWidth - 12,
              height: BODY_LINE_HEIGHT,
              lineBreak: false,
            });
          doc.y = y + BODY_LINE_HEIGHT;
        }
        doc.y += 4;
      };

      drawPageHeader();
      for (const section of day.sections) {
        if (doc.y + 20 + TABLE_HEADER_HEIGHT + 18 > contentBottom()) {
          doc.addPage();
          drawPageHeader();
        }
        drawSectionTitle(section);
        drawTableHeader();
        if (section.reservations.length === 0) {
          const y = doc.y;
          doc
            .fillColor("#555555")
            .fontSize(8)
            .text("Nessuna prenotazione confermata", PAGE_MARGIN + 6, y + 6, {
              width: contentWidth - 12,
            });
          doc.y = y + 24;
        } else {
          section.reservations.forEach((reservation, index) =>
            drawReservation(reservation, section, index),
          );
        }
        doc.y += 6;
      }

      const pageRange = doc.bufferedPageRange();
      for (let index = 0; index < pageRange.count; index += 1) {
        doc.switchToPage(pageRange.start + index);
        doc
          .font("NotoSans")
          .fillColor("#444444")
          .fontSize(7)
          .text(
            `Pagina ${index + 1} di ${pageRange.count}`,
            PAGE_MARGIN,
            doc.page.height - PAGE_MARGIN - FOOTER_HEIGHT + 4,
            {
              width: contentWidth,
              height: 10,
              align: "right",
              lineBreak: false,
            },
          );
      }
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}
