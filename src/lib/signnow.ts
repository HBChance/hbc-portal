// src/lib/signnow.ts

function mustGetEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function apiBase() {
  return process.env.SIGNNOW_API_BASE_URL || "https://api.signnow.com";
}

async function signNowRequest<T>(
  path: string,
  opts: { method: string; body?: any }
): Promise<T> {
  const apiKey = mustGetEnv("SIGNNOW_API_KEY");

  const res = await fetch(`${apiBase()}${path}`, {
    method: opts.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    throw new Error(
      `signNow ${opts.method} ${path} failed (${res.status}): ${
        json?.error || json?.message || text || "Unknown error"
      }`
    );
  }

  return json as T;
}

export async function signNowCopyTemplateToDocument(args: {
  templateId: string;
  documentName?: string;
}): Promise<{ document_id: string }> {
  const payload = args.documentName ? { name: args.documentName } : {};
  const out = await signNowRequest<any>(`/template/${args.templateId}/copy`, {
    method: "POST",
    body: payload,
  });

  const document_id =
    out?.id || out?.document_id || out?.data?.id || out?.data?.document_id || null;

  if (!document_id) {
    throw new Error(`signNow template copy did not return document id: ${JSON.stringify(out)}`);
  }

  return { document_id };
}

export async function signNowSendDocumentInvite(args: {
  documentId: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  message: string;
  roleName: string;
  expirationDays?: number;
}) {
  const payload = {
    from: args.fromEmail,
    subject: args.subject,
    message: args.message,
    expiration_days: args.expirationDays ?? 30,
    to: [
      {
        email: args.toEmail,
        role: args.roleName,
        order: 1,
      },
    ],
  };

  return await signNowRequest<any>(`/document/${args.documentId}/invite`, {
    method: "POST",
    body: payload,
  });
}

// NEW: fetch document details so we can detect completion
export async function signNowGetDocument(documentId: string) {
  return await signNowRequest<any>(`/document/${documentId}`, { method: "GET" });
}

// NEW: create a shareable signing link for an existing document (no new invite)
export async function signNowCreateSigningLink(args: { documentId: string }) {
  return await signNowRequest<any>(`/link`, {
    method: "POST",
    body: { document_id: args.documentId },
  });
}
