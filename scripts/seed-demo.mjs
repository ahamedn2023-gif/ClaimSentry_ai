#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
// Seeds a handful of demo claims so the department queues are not empty.
// Usage: node scripts/seed-demo.mjs [origin]
// Defaults to the deployed preview. Safe to run repeatedly; it only adds claims.

const origin = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');

/* ---------------------------------------------------------------- fixtures */

function png(width, height, rgb, nonce = 0) {
  const chunks = [];
  const rows = Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), padRow(width, rgb)]));
  // One altered pixel per run keeps the bytes unique without breaking the image.
  rows[height - 1][rows[height - 1].length - 1] = nonce & 0xff;
  const raw = Buffer.concat(rows);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', zlib.deflateSync(raw)));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}
const padRow = (width, rgb) => Buffer.concat(Array.from({ length: width }, () => Buffer.from(rgb)));

function pdf(lines, nonce = 0) {
  const text = lines.map((l, i) => `BT /F1 12 Tf 60 ${760 - i * 18} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  return Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${text.length}>>stream
${text}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
% run-${nonce}
`, 'latin1');
}

/* ------------------------------------------------------------------ claims */

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const run = randomBytes(4).readUInt32BE(0); // unique per run: re-seeding must not look like a re-submission
const shared = png(40, 40, [90, 140, 255], run); // reused across two claims on purpose

const claims = [
  {
    note: 'clean auto claim',
    fields: {
      claimantName: 'Marcus Feld', claimantEmail: 'marcus.feld@example.com', policyNumber: 'POL-884422',
      claimType: 'auto', incidentDate: daysAgo(12), amount: '1234.56',
      description: 'Rear-ended at a traffic light; rear bumper and boot lid damaged.',
    },
    files: [['damage-photo.png', 'image/png', png(56, 56, [190, 70, 60], run)],
            ['garage-estimate.pdf', 'application/pdf', pdf(['City Autobody - Repair Estimate', 'Bumper replacement 900.00', 'Respray 300.00', 'Total USD 1234.56'], run)]],
  },
  {
    note: 'health claim reported very late',
    fields: {
      claimantName: 'Dana Okoro', claimantEmail: 'dana.okoro@example.com', policyNumber: 'POL-771100',
      claimType: 'health', incidentDate: daysAgo(150), amount: '12000',
      description: 'Physiotherapy and scans after a fall.',
    },
    files: [['clinic-invoice.pdf', 'application/pdf', pdf(['Northside Clinic - Invoice', 'Consultations 4000.00', 'MRI scan 8000.00', 'Total USD 12000.00'], run)]],
  },
  {
    note: 'very high value property claim',
    fields: {
      claimantName: 'Helena Brandt', claimantEmail: 'helena.brandt@example.com', policyNumber: 'POL-334455',
      claimType: 'property', incidentDate: daysAgo(30), amount: '150000',
      description: 'Fire damage to the outbuilding and stored equipment.',
    },
    files: [['fire-damage.png', 'image/png', png(60, 40, [40, 40, 45], run)],
            ['contents-list.pdf', 'application/pdf', pdf(['Contents destroyed', 'Equipment 150000.00', 'Total USD 150000.00'], run)]],
  },
  {
    note: 'travel claim with a future incident date',
    fields: {
      claimantName: 'Tomas Neel', claimantEmail: 'tomas.neel@example.com', policyNumber: 'POL-660099',
      claimType: 'travel', incidentDate: daysAhead(8), amount: '860.00',
      description: 'Hospital visit abroad.',
    },
    files: [['receipt-scan.png', 'image/png', shared]],
  },
  {
    note: 'life claim that re-uses the previous document',
    fields: {
      claimantName: 'Grace Lindqvist', claimantEmail: 'grace.l@example.com', policyNumber: 'POL-221133',
      claimType: 'life', incidentDate: daysAgo(20), amount: '4500.00',
      description: 'Medical assessment fees.',
    },
    files: [['assessment.pdf', 'application/pdf', pdf(['Independent assessment', 'Total USD 4500.00'], run)],
            ['receipt-scan.png', 'image/png', shared]], // identical bytes to the travel claim above
  },
];

/* -------------------------------------------------------------------- run */

async function submit(claim) {
  const form = new FormData();
  for (const [key, value] of Object.entries(claim.fields)) form.append(key, value);
  for (const [name, type, bytes] of claim.files) form.append('documents', new Blob([bytes], { type }), name);

  const response = await fetch(`${origin}/api/claims`, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(`${claim.note}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const health = await fetch(`${origin}/api/health`).then((r) => r.json());
console.log(`seeding ${origin} (document examiner ${health.aiConfigured ? 'ON' : 'OFF — rules only'})\n`);

for (const claim of claims) {
  const result = await submit(claim);
  console.log(
    `${result.reference}  ${String(result.departmentName).padEnd(30)} risk=${String(result.riskBand).padEnd(8)} ` +
      `agent=${String(result.recommendation).padEnd(13)}  (${claim.note})`,
  );
}
console.log('\nDone. Sign in at /reviewer, pick a department, and the routed claims will be waiting.');
