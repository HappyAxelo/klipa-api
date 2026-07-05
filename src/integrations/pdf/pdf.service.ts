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
  docLabel?: string; // "INVOICE" (default) or "QUOTATION"
  discount?: bigint;
  taxAmount?: bigint;
  taxRatePercent?: number;
  logoUrl?: string | null;
  signatureUrl?: string | null;
  stampUrl?: string | null;
  issuedBy?: string | null;
}

// Downloads an image for embedding. pdfkit takes PNG/JPEG only; anything
// else (webp, failures, slow hosts) is skipped so the PDF always renders.
async function fetchImage(url?: string | null): Promise<Buffer | null> {
  if (!url || !url.startsWith('https://')) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/png|jpe?g/i.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length < 5 * 1024 * 1024 ? buf : null;
  } catch {
    return null;
  }
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
  async invoicePdf(data: InvoicePdfData): Promise<Buffer> {
    // Fetch branding up front; failures simply omit the image.
    const [logoImg, signatureImg, stampImg] = await Promise.all([
      fetchImage(data.logoUrl),
      fetchImage(data.signatureUrl),
      fetchImage(data.stampUrl),
    ]);
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
        .text(data.docLabel || 'INVOICE', 300, 50, { width: COL.right - 300, align: 'right' });
      if (logoImg) {
        try { doc.image(logoImg, COL.left, 88, { fit: [110, 44] }); } catch { /* bad image */ }
      }
      doc.font('Helvetica').fontSize(10).fillColor(MUTED);
      doc.text(`No. ${data.number}`, 300, 84, { width: COL.right - 300, align: 'right' });
      doc.text(`Issued: ${day(data.issuedDate)}`, 300, 98, { width: COL.right - 300, align: 'right' });
      doc.text(`Due: ${day(data.dueDate)}`, 300, 112, { width: COL.right - 300, align: 'right' });
      doc.text(`Status: ${data.status.toUpperCase()}`, 300, 126, { width: COL.right - 300, align: 'right' });
      if (data.issuedBy) {
        doc.text(`Issued by: ${data.issuedBy}`, 300, 140, { width: COL.right - 300, align: 'right' });
      }

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

      // ---- Subtotal / Discount / Tax breakdown (only when relevant) ----
      const discount = data.discount ?? 0n;
      const taxAmount = data.taxAmount ?? 0n;
      const labW = 110;
      const lineRow = (label: string, value: string, muted = true) => {
        y += 16;
        doc.font('Helvetica').fontSize(10).fillColor(muted ? MUTED : INK)
          .text(label, COL.unit - 60, y, { width: labW, align: 'right' });
        doc.fillColor(INK)
          .text(value, COL.amount, y, { width: COL.right - COL.amount - 5, align: 'right' });
      };
      if (discount > 0n || taxAmount > 0n) {
        const subtotal = data.items.reduce((s, it) => s + it.unitAmount * BigInt(it.quantity), 0n);
        lineRow('Subtotal', fmt(subtotal));
        if (discount > 0n) lineRow('Discount', `- ${fmt(discount)}`);
        if (taxAmount > 0n) {
          const rate = data.taxRatePercent ? ` (${data.taxRatePercent}%)` : '';
          lineRow(`Tax${rate}`, fmt(taxAmount));
        }
      }

      // ---- Total ----
      y += 18;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
        .text('TOTAL', COL.unit - 60, y, { width: labW, align: 'right' });
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

      // ---- Signature and stamp ----
      if (signatureImg || stampImg) {
        const sigY = Math.min(Math.max(y + 40, 640), 700);
        if (stampImg) {
          try { doc.image(stampImg, COL.left, sigY, { fit: [90, 90] }); } catch { /* bad image */ }
        }
        if (signatureImg) {
          const sx = COL.right - 170;
          try { doc.image(signatureImg, sx, sigY, { fit: [150, 55] }); } catch { /* bad image */ }
          doc.strokeColor(LINE).lineWidth(1).moveTo(sx, sigY + 62).lineTo(sx + 150, sigY + 62).stroke();
          doc.fontSize(9).fillColor(MUTED).font('Helvetica')
            .text(data.issuedBy ? `${data.issuedBy} - Authorised signature` : 'Authorised signature',
              sx - 30, sigY + 67, { width: 210, align: 'center' });
        }
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
