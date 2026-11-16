import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { pool, q } from '../db.js';
import { notFound } from '../errors.js';
import { currentCoverage } from './coverage.js';
import type { BankOut, CoverageResult } from '../engine/coverage.js';

const num = (v: string | null) => (v === null ? null : Number(v));
const fmt = (v: string | number | null) => (v === null ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const STATUS: Record<string, string> = { ok: 'Covered', watch: 'Early warning', shortfall: 'Shortfall', top_up: 'Top-up level', margin_call: 'Margin call' };
const BROWN = 'FF3D2612';

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BROWN } };
}

export async function coverageWorkbook(): Promise<Buffer> {
  const { coverage } = await currentCoverage();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Borrowings System';
  wb.created = new Date();

  // Sheet 1 mirrors the deck: assets on the left, liabilities on the right.
  const ws = wb.addWorksheet('Coverage');
  ws.addRow([`Shares pledged (assets) against bank loans (liabilities) as at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`]).font = { bold: true, size: 13 };
  ws.addRow([]);
  styleHeader(ws.addRow(['Bank', 'Portfolio', 'Share', 'No. of shares', 'Share price', 'Share value', 'Eligible', 'Collateral value', '', 'Loan no.', 'Loan limit', 'Loan used', 'Coverage ratio %', 'Coverage required', 'Surplus / shortfall', 'Actual coverage %', 'Status']));
  for (const bank of coverage.banks) {
    for (const loan of bank.loans) {
      const lines = loan.portfolios.flatMap((p) => p.holdings.map((h) => ({ p, h })));
      const liab = ['', loan.loan_no, num(loan.limit_amount), num(loan.used_amount), num(loan.coverage_ratio), num(loan.coverage_required), num(loan.surplus), num(loan.actual_coverage_pct), STATUS[loan.status]];
      if (!lines.length) ws.addRow([bank.name, '(nothing pledged)', '', null, null, null, '', null, ...liab]);
      lines.forEach(({ p, h }, i) => {
        const row = ws.addRow([bank.name, p.name, `${h.symbol} ${h.security_name}`, num(h.quantity), num(h.price), num(h.market_value), h.eligible ? 'Yes' : 'No', num(h.collateral_value), ...(i === 0 ? liab : [])]);
        if (i === 0 && Number(loan.surplus) < 0) row.getCell(15).font = { color: { argb: 'FFB42318' }, bold: true };
      });
    }
    const total = ws.addRow([`${bank.name} total`, '', '', num(bank.quantity), null, num(bank.market_value), '', num(bank.collateral_value), '', '', num(bank.limit_amount), num(bank.used_amount), null, num(bank.coverage_required), num(bank.surplus)]);
    total.font = { bold: true };
    ws.addRow([]);
  }
  const t = coverage.totals;
  styleHeader(ws.addRow(['Grand total', '', '', null, null, num(t.market_value), '', num(t.collateral_value), '', '', num(t.limit_amount), num(t.used_amount), null, num(t.coverage_required), num(t.surplus)]));
  ws.columns.forEach((c, i) => { c.width = [16, 22, 26, 14, 12, 16, 9, 16, 3, 14, 16, 16, 14, 18, 18, 14, 16][i] ?? 14; });
  [4, 5, 6, 8, 11, 12, 14, 15].forEach((i) => { ws.getColumn(i).numFmt = '#,##0.00;[Red]-#,##0.00'; });

  const reg = wb.addWorksheet('Loan register');
  const loans = await q(pool,
    `SELECT b.name AS bank, l.* FROM loans l JOIN banks b ON b.id = l.bank_id ORDER BY b.name, l.loan_no`);
  styleHeader(reg.addRow(['Bank', 'Loan no.', 'Facility', 'Status', 'Limit', 'Used', 'Headroom', 'Start', 'Maturity', 'Review', 'Renewal', 'Rate type', 'Rate %', 'Benchmark', 'Margin %', 'Coverage % (loan)', 'Top-up %', 'Margin call %']));
  for (const l of loans) {
    reg.addRow([l.bank, l.loan_no, l.facility_type, l.status, num(l.limit_amount), num(l.used_amount), Number(l.limit_amount) - Number(l.used_amount), l.start_date, l.maturity_date, l.review_date, l.renewal_date,
      l.rate_type, num(l.rate_pct), l.benchmark, num(l.margin_pct), num(l.coverage_ratio), num(l.top_up_ratio), num(l.margin_call_ratio)]);
  }
  reg.columns.forEach((c) => { c.width = 15; });
  [5, 6, 7].forEach((i) => { reg.getColumn(i).numFmt = '#,##0.00'; });

  const ch = wb.addWorksheet('Finance charges');
  styleHeader(ch.addRow(['Bank', 'Loan no.', 'Type', 'Due date', 'Amount', 'Status', 'Paid date', 'Reference']));
  for (const c of await q(pool, `SELECT b.name AS bank, l.loan_no, c.* FROM finance_charges c JOIN loans l ON l.id = c.loan_id JOIN banks b ON b.id = l.bank_id ORDER BY c.due_date`)) {
    ch.addRow([c.bank, c.loan_no, c.charge_type, c.due_date, num(c.amount), c.status, c.paid_date, c.reference]);
  }
  ch.columns.forEach((c) => { c.width = 15; });
  ch.getColumn(5).numFmt = '#,##0.00';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function priceHistoryWorkbook(securityId: string | null, from: string, to: string): Promise<Buffer> {
  const rows = await q(pool,
    `SELECT s.symbol, s.name, p.price, p.as_of, p.source FROM prices p JOIN securities s ON s.id = p.security_id
      WHERE ($1::uuid IS NULL OR p.security_id = $1) AND p.as_of >= $2::date AND p.as_of < $3::date + 1 ORDER BY s.symbol, p.as_of LIMIT 200000`,
    [securityId, from, to]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Price history');
  styleHeader(ws.addRow(['Symbol', 'Name', 'Price', 'As of (UTC)', 'Source']));
  for (const r of rows) ws.addRow([r.symbol, r.name, num(r.price), r.as_of.toISOString().replace('T', ' ').slice(0, 19), r.source]);
  ws.columns.forEach((c, i) => { c.width = [12, 28, 12, 22, 14][i]; });
  ws.getColumn(3).numFmt = '#,##0.0000';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---- PDF ----
function pdf(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor('#7a6a5c').text(`Borrowings System  |  Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC  |  Confidential  |  Page ${i + 1} of ${range.count}`, 36, doc.page.height - 30, { lineBreak: false });
    }
    doc.end();
  });
}
function title(doc: PDFKit.PDFDocument, text: string, sub: string) {
  doc.rect(0, 0, doc.page.width, 64).fill('#3d2612');
  doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold').text(text, 36, 18);
  doc.fontSize(9).font('Helvetica').fillColor('#e6d5c0').text(sub, 36, 42);
  doc.y = 84;
  doc.fillColor('#1f1711');
}
function table(doc: PDFKit.PDFDocument, cols: { label: string; width: number; align?: 'left' | 'right' }[], rows: (string | { text: string; color?: string; bold?: boolean })[][]) {
  const x0 = 36;
  const draw = (cells: any[], header: boolean) => {
    if (doc.y > doc.page.height - 70) { doc.addPage(); doc.y = 40; }
    const y = doc.y;
    if (header) doc.rect(x0, y - 3, cols.reduce((s, c) => s + c.width, 0), 16).fill('#8b4513');
    let x = x0;
    cells.forEach((cell, i) => {
      const c = typeof cell === 'string' ? { text: cell } : cell;
      doc.font(header || c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(header ? '#ffffff' : c.color ?? '#1f1711')
        .text(c.text, x + 3, y, { width: cols[i].width - 6, align: cols[i].align ?? 'left', lineBreak: false, ellipsis: true });
      x += cols[i].width;
    });
    doc.y = y + 16;
  };
  draw(cols.map((c) => c.label), true);
  rows.forEach((r) => draw(r, false));
  doc.moveDown(0.8);
}
const surplusCell = (v: string) => ({ text: fmt(v), color: Number(v) < 0 ? '#b42318' : '#1b6e3c', bold: true });

function loanTable(doc: PDFKit.PDFDocument, banks: BankOut[]) {
  table(doc, [
    { label: 'Bank', width: 100 }, { label: 'Loan', width: 80 }, { label: 'Limit', width: 80, align: 'right' }, { label: 'Used', width: 80, align: 'right' }, { label: 'Headroom', width: 80, align: 'right' },
    { label: 'Ratio', width: 50, align: 'right' }, { label: 'Required', width: 80, align: 'right' }, { label: 'Collateral', width: 80, align: 'right' }, { label: 'Surplus / shortfall', width: 90, align: 'right' }, { label: 'Status', width: 50 },
  ], banks.flatMap((b) => b.loans.map((l) => [b.name, l.loan_no, fmt(l.limit_amount), fmt(l.used_amount), fmt(l.headroom), `${Number(l.coverage_ratio)}%`, fmt(l.coverage_required), fmt(l.collateral_value), surplusCell(l.surplus), STATUS[l.status]])));
}

export async function managementPdf(): Promise<Buffer> {
  const { coverage } = await currentCoverage();
  const upcoming = await q(pool,
    `SELECT * FROM (
       SELECT 'Maturity' AS kind, b.name AS bank, l.loan_no, l.maturity_date AS date, NULL::numeric AS amount FROM loans l JOIN banks b ON b.id = l.bank_id WHERE l.status = 'active'
       UNION ALL SELECT 'Review', b.name, l.loan_no, l.review_date, NULL FROM loans l JOIN banks b ON b.id = l.bank_id WHERE l.status = 'active' AND l.review_date IS NOT NULL
       UNION ALL SELECT initcap(c.charge_type) || ' payment', b.name, l.loan_no, c.due_date, c.amount FROM finance_charges c JOIN loans l ON l.id = c.loan_id JOIN banks b ON b.id = l.bank_id WHERE c.status = 'due'
     ) x WHERE date <= current_date + 90 ORDER BY date LIMIT 30`);
  return pdf((doc) => {
    const t = coverage.totals;
    title(doc, 'Borrowings and collateral coverage', 'Management report');
    const kpis: [string, string][] = [['Total facility limits', fmt(t.limit_amount)], ['Total borrowed', fmt(t.used_amount)], ['Undrawn headroom', fmt(t.headroom)], ['Pledged collateral value', fmt(t.collateral_value)], ['Coverage required', fmt(t.coverage_required)], ['Total shortfall', fmt(t.total_shortfall)]];
    kpis.forEach(([label, value], i) => {
      const x = 36 + i * 128;
      doc.roundedRect(x, 84, 120, 46, 4).fill('#f3e9dc');
      doc.fillColor('#7a6a5c').fontSize(8).font('Helvetica').text(label, x + 8, 92, { width: 104 });
      doc.fillColor(label === 'Total shortfall' && Number(t.total_shortfall) > 0 ? '#b42318' : '#3d2612').fontSize(13).font('Helvetica-Bold').text(value, x + 8, 106, { width: 104 });
    });
    doc.y = 148;
    doc.fillColor('#3d2612').fontSize(12).font('Helvetica-Bold').text('Coverage by loan', 36);
    doc.moveDown(0.5);
    loanTable(doc, coverage.banks);
    doc.fillColor('#3d2612').fontSize(12).font('Helvetica-Bold').text('Key dates in the next 90 days', 36);
    doc.moveDown(0.5);
    table(doc, [{ label: 'Date', width: 90 }, { label: 'Event', width: 160 }, { label: 'Bank', width: 160 }, { label: 'Loan', width: 120 }, { label: 'Amount', width: 110, align: 'right' }],
      upcoming.length ? upcoming.map((u) => [u.date, u.kind, u.bank, u.loan_no, u.amount ? fmt(u.amount) : '']) : [['None', '', '', '', '']]);
  });
}

export async function bankStatementPdf(bankId: string): Promise<Buffer> {
  const { coverage } = await currentCoverage();
  const bank = coverage.banks.find((b) => b.id === bankId);
  if (!bank) throw notFound('Bank');
  return pdf((doc) => {
    title(doc, `Collateral statement: ${bank.name}`, 'Loans, pledged shares and coverage position');
    loanTable(doc, [bank]);
    for (const loan of bank.loans) {
      doc.fillColor('#3d2612').fontSize(11).font('Helvetica-Bold').text(`${loan.loan_no}: pledged shares`, 36);
      doc.moveDown(0.4);
      table(doc, [{ label: 'Portfolio', width: 170 }, { label: 'Share', width: 190 }, { label: 'No. of shares', width: 90, align: 'right' }, { label: 'Price', width: 80, align: 'right' }, { label: 'Share value', width: 100, align: 'right' }, { label: 'Eligible', width: 50 }, { label: 'Collateral value', width: 90, align: 'right' }],
        [...loan.portfolios.flatMap((p) => p.holdings.map((h) => [p.name, `${h.symbol} ${h.security_name}`, Number(h.quantity).toLocaleString('en-US'), h.price ? Number(h.price).toFixed(2) : '-', fmt(h.market_value), h.eligible ? 'Yes' : 'No', fmt(h.collateral_value)])),
          [{ text: 'Total', bold: true }, '', '', '', { text: fmt(loan.market_value), bold: true }, '', { text: fmt(loan.collateral_value), bold: true }]]);
    }
  });
}

export type { CoverageResult };
