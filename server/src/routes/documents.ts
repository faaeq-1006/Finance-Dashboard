import type { FastifyInstance } from 'fastify';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { audit, auditNow } from '../audit.js';
import { config } from '../config.js';
import { one, pool, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { actorOf, requirePerm } from '../security/auth.js';
import { decrypt, encrypt, randomToken, sha256 } from '../security/crypto.js';
import { afterChange } from '../services/hooks.js';

// Allow-list by extension, and the file content must match the type it claims to be.
const TYPES: Record<string, { mime: string; magic: number[][] }> = {
  '.pdf': { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  '.png': { mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  '.jpg': { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  '.jpeg': { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: [[0x50, 0x4b, 0x03, 0x04]] },
};
const uuid = z.uuid();
const meta = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  category: z.enum(['agreement', 'pledge', 'security', 'correspondence', 'valuation', 'other']).default('agreement'),
  expiry_date: z.iso.date().optional().or(z.literal('').transform(() => undefined)),
  note: z.string().trim().max(500).optional(),
});

async function readUpload(req: any) {
  const file = await req.file();
  if (!file) throw badRequest('Choose a file to upload');
  const buffer: Buffer = await file.toBuffer(); // size limit enforced by the multipart plugin
  const filename = path.basename(String(file.filename)).replace(/[^\w.\- ()]/g, '_').slice(0, 150);
  const type = TYPES[path.extname(filename).toLowerCase()];
  if (!type) throw badRequest('Allowed file types: PDF, DOCX, XLSX, PNG, JPG');
  if (!type.magic.some((m) => m.every((b, i) => buffer[i] === b))) throw badRequest('The file content does not match its file type');
  const fields = Object.fromEntries(Object.entries(file.fields).filter(([, v]: any) => v?.type === 'field').map(([k, v]: any) => [k, v.value]));
  const parsed = meta.safeParse(fields);
  if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
  return { buffer, filename, mime: type.mime, fields: parsed.data };
}

/** Files are encrypted at rest under a random name outside the web root. */
async function store(buffer: Buffer): Promise<string> {
  const key = `${randomToken(24)}.bin`;
  await mkdir(config.uploadDir, { recursive: true });
  await writeFile(path.join(config.uploadDir, key), encrypt(buffer), { mode: 0o600 });
  return key;
}

export default async function documentRoutes(app: FastifyInstance) {
  const write = { preHandler: requirePerm('write') };

  async function addVersion(req: any, documentId: string | null, loanId: string | null) {
    const up = await readUpload(req);
    const storageKey = await store(up.buffer);
    try {
      return await tx(async (client) => {
        let doc;
        if (documentId) {
          doc = await one(client, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [documentId]);
          if (!doc || doc.archived) throw notFound('Document');
          if (up.fields.expiry_date) await client.query('UPDATE documents SET expiry_date = $2 WHERE id = $1', [doc.id, up.fields.expiry_date]);
        } else {
          if (!(await one(client, 'SELECT 1 FROM loans WHERE id = $1', [loanId]))) throw notFound('Loan');
          doc = await one(client, 'INSERT INTO documents(loan_id, title, category, expiry_date, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [loanId, up.fields.title ?? up.filename, up.fields.category, up.fields.expiry_date ?? null, req.user.id]);
        }
        const versionNo = doc.current_version + 1;
        const digest = sha256(up.buffer);
        await client.query(
          'INSERT INTO document_versions(document_id, version_no, filename, mime, size_bytes, sha256, storage_key, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [doc.id, versionNo, up.filename, up.mime, up.buffer.length, digest, storageKey, up.fields.note ?? null, req.user.id]);
        await client.query('UPDATE documents SET current_version = $2 WHERE id = $1', [doc.id, versionNo]);
        await audit(client, actorOf(req), { action: documentId ? 'document.version_added' : 'document.uploaded', entityType: 'loan', entityId: doc.loan_id,
          after: { document_id: doc.id, title: doc.title, version_no: versionNo, filename: up.filename, sha256: digest, size_bytes: up.buffer.length } });
        return { id: doc.id, version_no: versionNo };
      });
    } catch (err) {
      await unlink(path.join(config.uploadDir, storageKey)).catch(() => {});
      throw err;
    }
  }

  app.post('/api/loans/:id/documents', write, async (req) => {
    const loanId = uuid.parse((req.params as any).id);
    const out = await addVersion(req, null, loanId);
    afterChange();
    return out;
  });
  app.post('/api/documents/:id/versions', write, async (req) => {
    const out = await addVersion(req, uuid.parse((req.params as any).id), null);
    afterChange();
    return out;
  });
  app.put('/api/documents/:id', write, async (req) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ title: z.string().trim().min(1).max(200), category: meta.shape.category, expiry_date: z.iso.date().nullable(), archived: z.boolean().default(false) }).parse(req.body);
    await tx(async (client) => {
      const before = await one(client, 'SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Document');
      const after = await one(client, 'UPDATE documents SET title=$2, category=$3, expiry_date=$4, archived=$5 WHERE id=$1 RETURNING *', [id, b.title, b.category, b.expiry_date, b.archived]);
      await audit(client, actorOf(req), { action: b.archived ? 'document.archived' : 'document.updated', entityType: 'loan', entityId: before.loan_id, before, after });
    });
    afterChange();
    return { ok: true };
  });

  app.get('/api/documents/:id/versions/:version/download', { preHandler: requirePerm('read') }, async (req, reply) => {
    const p = z.object({ id: uuid, version: z.coerce.number().int().positive() }).parse(req.params);
    const v = await one(pool, 'SELECT v.*, d.loan_id FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.document_id = $1 AND v.version_no = $2', [p.id, p.version]);
    if (!v) throw notFound('Document version');
    // storage_key is generated by us, never taken from the request, so it cannot traverse paths.
    const plain = decrypt(await readFile(path.join(config.uploadDir, v.storage_key)));
    if (sha256(plain) !== v.sha256) throw new Error(`Integrity check failed for document version ${v.id}`);
    await auditNow(actorOf(req), { action: 'document.downloaded', entityType: 'loan', entityId: v.loan_id, meta: { document_id: p.id, version_no: p.version } });
    return reply.header('content-type', v.mime).header('content-disposition', `attachment; filename="${v.filename.replace(/"/g, '')}"`)
      .header('x-content-type-options', 'nosniff').header('cache-control', 'no-store').send(plain);
  });
}
