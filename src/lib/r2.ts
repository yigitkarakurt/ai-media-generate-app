import { AwsClient } from "aws4fetch";
import type { AppBindings } from "../bindings";
import { UPLOAD_URL_EXPIRY_SECONDS } from "../shared/media";

/** Shared expiry for presigned read URLs (1 hour). */
const READ_URL_EXPIRY_SECONDS = 3600;

function getR2Client(env: AppBindings) {
	return {
		client: new AwsClient({
			accessKeyId: env.R2_ACCESS_KEY_ID,
			secretAccessKey: env.R2_SECRET_ACCESS_KEY,
			service: "s3",
			region: "auto",
		}),
		baseUrl: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}`,
	};
}

/**
 * Generate a presigned PUT URL for direct-to-R2 upload.
 * Uses the S3-compatible API via aws4fetch — the R2 Worker binding
 * cannot generate presigned URLs.
 */
export async function createPresignedUploadUrl(
	env: AppBindings,
	storageKey: string,
): Promise<{ uploadUrl: string; expiresInSeconds: number }> {
	const { client, baseUrl } = getR2Client(env);
	const objectUrl = `${baseUrl}/${storageKey}?X-Amz-Expires=${UPLOAD_URL_EXPIRY_SECONDS}`;

	const signed = await client.sign(
		new Request(objectUrl, { method: "PUT" }),
		{ aws: { signQuery: true } },
	);

	return {
		uploadUrl: signed.url,
		expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS,
	};
}

/**
 * Generate a presigned GET URL for reading an object from R2.
 * Used to give providers short-lived access to input assets
 * without proxying the file through the Worker.
 */
export async function createPresignedReadUrl(
	env: AppBindings,
	storageKey: string,
	expiresInSeconds = READ_URL_EXPIRY_SECONDS,
): Promise<string> {
	const { client, baseUrl } = getR2Client(env);
	const objectUrl = `${baseUrl}/${storageKey}?X-Amz-Expires=${expiresInSeconds}`;

	const signed = await client.sign(
		new Request(objectUrl, { method: "GET" }),
		{ aws: { signQuery: true } },
	);

	return signed.url;
}
