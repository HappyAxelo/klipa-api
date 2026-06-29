import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { formatMoney } from '../../common/money/money';

export interface InvoicePdfItem {
  description: string;
  quantity: number;
  unitAmount: bigint;
}

export interface InvoicePdfData {
  number: string;
  issuedDate: Date;
  dueDate: Date;
  currency: string;
  status: string;
  businessName: string;
  customerName: string;
  customerEmail?: string | null;
  items: InvoicePdfItem[];
  total: bigint;
  publicLink?: string | null;
  momoCode?: string | null;
  bankAccount?: string | null;
}

const BRAND = '#1565E0';
const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#E2E8F0';

// Column geometry for the line-item table (A4, 50pt margins => 50..545).
const COL = { left: 50, right: 545, desc: 60, qty: 330, unit: 385, amount: 460 };

@Injectable()
export class PdfService {
  /** Renders a clean, branded invoice PDF and resolves the file as a Buffer. */
  invoicePdf(data: InvoicePdfData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const fmt = (n: bigint) => formatMoney(n, data.currency);
      const day = (d: Date) => new Date(d).toISOString().slice(0, 10);

      // ---- Header ----
      doc
        .fillColor(BRAND)
        .font('Helvetica-Bold')
        .fontSize(22)
        .text(data.businessName, COL.left, 50, { width: 280 });
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(26)
        .text('INVOICE', 300, 50, { width: COL.right - 300, align: 'right' });
      doc.font('Helvetica').fontSize(10).fillColor(MUTED);
      doc.text(`No. ${data.number}`, 300, 84, { width: COL.right - 300, align: 'right' });
      doc.text(`Issued: ${day(data.issuedDate)}`, 300, 98, { width: COL.right - 300, align: 'right' });
      doc.text(`Due: ${day(data.dueDate)}`, 300, 112, { width: COL.right - 300, align: 'right' });
      doc.text(`Status: ${data.status.toUpperCase()}`, 300, 126, { width: COL.right - 300, align: 'right' });

      // ---- Bill to ----
      let y = 150;
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(10).text('BILL TO', COL.left, y);
      doc.fillColor(INK).font('Helvetica').fontSize(12).text(data.customerName, COL.left, y + 15);
      if (data.customerEmail) {
        doc.fillColor(MUTED).fontSize(10).text(data.customerEmail, COL.left, y + 32);
      }

      // ---- Table header ----
      y = 215;
      doc.fillColor(BRAND).rect(COL.left, y, COL.right - COL.left, 24).fill();
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
      doc.text('DESCRIPTION', COL.desc, y + 8);
      doc.text('QTY', COL.qty, y + 8, { width: 45, align: 'right' });
      doc.text('UNIT', COL.unit, y + 8, { width: 65, align: 'right' });
      doc.text('AMOUNT', COL.amount, y + 8, { width: COL.right - COL.amount - 5, align: 'right' });

      // ---- Rows ----
      y += 24;
      doc.font('Helvetica').fontSize(10);
      for (const it of data.items) {
        const lineTotal = it.unitAmount * BigInt(it.quantity);
        const descHeight = doc.heightOfString(it.description, { width: COL.qty - COL.desc - 10 });
        const rowH = Math.max(22, descHeight + 12);
        doc.fillColor(INK).text(it.description, COL.desc, y + 6, { width: COL.qty - COL.desc - 10 });
        doc.text(String(it.quantity), COL.qty, y + 6, { width: 45, align: 'right' });
        doc.text(fmt(it.unitAmount), COL.unit, y + 6, { width: 65, align: 'right' });
        doc.text(fmt(lineTotal), COL.amount, y + 6, { width: COL.right - COL.amount - 5, align: 'right' });
        y += rowH;
        doc.strokeColor(LINE).lineWidth(1).moveTo(COL.left, y).lineTo(COL.right, y).stroke();
      }

      // ---- Total ----
      y += 16;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
        .text('TOTAL', COL.unit - 60, y, { width: 110, align: 'right' });
      doc.fillColor(BRAND).fontSize(14)
        .text(fmt(data.total), COL.amount, y - 1, { width: COL.right - COL.amount - 5, align: 'right' });

      // ---- How to pay (direct MoMo / bank) ----
      if (data.momoCode || data.bankAccount) {
        y += 36;
        doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
          .text(`How to pay ${data.businessName}`, COL.left, y);
        y += 18;
        doc.font('Helvetica').fontSize(10).fillColor(INK);
        if (data.momoCode) {
          doc.text(`Mobile Money:  ${data.momoCode}`, COL.left, y);
          y += 15;
        }
        if (data.bankAccount) {
          doc.text(`Bank:  ${data.bankAccount}`, COL.left, y);
          y += 15;
        }
      }

      // ---- View online ----
      if (data.publicLink) {
        y += 16;
        doc.font('Helvetica').fontSize(10).fillColor(MUTED)
          .text('View invoice online:', COL.left, y);
        doc.fillColor(BRAND).text(data.publicLink, COL.left, y + 14, {
          link: data.publicLink,
          underline: true,
        });
      }

      // ---- Footer ----
      doc.fontSize(9).fillColor(MUTED).font('Helvetica')
        .text('Powered by K-Lipwa', COL.left, 800, {
          width: COL.right - COL.left,
          align: 'center',
        });

      doc.end();
    });
  }
}
