/**
 * `R2Bucket`-shaped shim over AWS SDK v3's S3 client against R2's
 * S3-compat endpoint. Node-side counterpart to CFW's native R2 binding
 * — same interface, different transport, so `converge()` and
 * `gcSweep()` run unmodified from a Node CLI.
 *
 * Only implements the subset the cascade actually uses:
 *  - `head(key)` → `{ size, etag? } | null`
 *  - `get(key, opts?)` → `{ arrayBuffer() } | null`, with optional
 *    `range: { offset, length }`
 *  - `put(key, body, opts?)` — body is `ArrayBuffer | Uint8Array`
 *  - `delete(key)`
 *  - `createMultipartUpload(key, opts?)` — returns an object with
 *    `uploadPart(n, bytes)` / `complete(parts)` / `abort()` /
 *    `key` / `uploadId`.
 *
 * Env:
 *  - `CLOUDFLARE_ACCOUNT_ID`
 *  - `R2_ACCESS_KEY_ID`
 *  - `R2_SECRET_ACCESS_KEY`
 *  - `R2_BUCKET` (default `ctbk`)
 */
import {
	S3Client,
	HeadObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	DeleteObjectCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
	NotFound,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import * as https from 'node:https';

export interface R2LikeObject {
	size: number;
	etag?: string;
	key: string;
}

export interface R2LikeGet {
	arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2LikeMultipart {
	key: string;
	uploadId: string;
	uploadPart(partNumber: number, body: Uint8Array): Promise<{ partNumber: number; etag: string }>;
	complete(parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
	abort(): Promise<void>;
}

export interface R2Like {
	head(key: string): Promise<R2LikeObject | null>;
	get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<R2LikeGet | null>;
	put(key: string, body: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<void>;
	delete(key: string): Promise<void>;
	createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string } }): Promise<R2LikeMultipart>;
}

export function s3R2(env: NodeJS.ProcessEnv = process.env): R2Like {
	const accountId = env.CLOUDFLARE_ACCOUNT_ID;
	const accessKeyId = env.R2_ACCESS_KEY_ID;
	const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
	const bucket = env.R2_BUCKET ?? 'ctbk';
	if (!accountId || !accessKeyId || !secretAccessKey) {
		throw new Error('r2-s3: missing CLOUDFLARE_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
	}
	// Explicit keep-alive agent — the SDK's default Node HTTP handler
	// exhausts sockets after ~100 rapid HEADs in a tight loop (gc catch-up
	// pattern), throwing ECONNRESET. `keepAlive: true` with a generous
	// `maxSockets` fixes that.
	const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
	const client = new S3Client({
		region: 'auto',
		endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
		credentials: { accessKeyId, secretAccessKey },
		// R2 disallows automatic checksum computation on many operations.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
		requestHandler: new NodeHttpHandler({ httpsAgent }),
	});

	return {
		async head(key) {
			try {
				const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
				return { size: r.ContentLength ?? 0, etag: r.ETag ?? undefined, key };
			} catch (err) {
				if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return null;
				if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
				throw err;
			}
		},

		async get(key, opts) {
			const range = opts?.range
				? `bytes=${opts.range.offset}-${opts.range.offset + opts.range.length - 1}`
				: undefined;
			try {
				const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
				const body = r.Body;
				if (!body) return null;
				return {
					async arrayBuffer() {
						// v3 Body is a Node Readable stream in Node
						const chunks: Buffer[] = [];
						for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
							chunks.push(chunk);
						}
						const combined = Buffer.concat(chunks);
						// Return a fresh ArrayBuffer (not the Node Buffer's shared one)
						const ab = new ArrayBuffer(combined.byteLength);
						new Uint8Array(ab).set(combined);
						return ab;
					},
				};
			} catch (err) {
				if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
				throw err;
			}
		},

		async put(key, body, opts) {
			const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
			await client.send(new PutObjectCommand({
				Bucket: bucket, Key: key, Body: bytes,
				ContentType: opts?.httpMetadata?.contentType,
			}));
		},

		async delete(key) {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		},

		async createMultipartUpload(key, opts) {
			const created = await client.send(new CreateMultipartUploadCommand({
				Bucket: bucket, Key: key,
				ContentType: opts?.httpMetadata?.contentType,
			}));
			const uploadId = created.UploadId!;
			return {
				key,
				uploadId,
				async uploadPart(partNumber, bytes) {
					const r = await client.send(new UploadPartCommand({
						Bucket: bucket, Key: key, PartNumber: partNumber,
						UploadId: uploadId, Body: bytes,
					}));
					return { partNumber, etag: r.ETag!.replace(/^"|"$/g, '') };
				},
				async complete(parts) {
					await client.send(new CompleteMultipartUploadCommand({
						Bucket: bucket, Key: key, UploadId: uploadId,
						MultipartUpload: {
							Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
						},
					}));
				},
				async abort() {
					await client.send(new AbortMultipartUploadCommand({
						Bucket: bucket, Key: key, UploadId: uploadId,
					}));
				},
			};
		},
	};
}
