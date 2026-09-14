// Where releases are uploaded and where installed apps look for them, both
// derived from package.json's `updates` field so the publisher and the running
// app can never disagree:
//
//   "updates": {
//     "bucket": "dbison-releases",
//     "endpoint": "https://fra1.digitaloceanspaces.com"
//   }
//
// Optional: `folder` (key prefix, default "dbison"), `region` (default
// "us-east-1", which DigitalOcean Spaces expects from S3 clients) and
// `publicUrl` (default https://<bucket>.<endpoint host>, set it for a CDN or
// custom domain). Returns null when the field is missing or incomplete, so
// callers stay dormant instead of guessing. docs/RELEASING.md has the details.
export function updateFeed(pkg) {
  const updates = pkg?.updates;
  if (!updates?.bucket || !updates?.endpoint) return null;

  let endpoint;
  try {
    endpoint = new URL(updates.endpoint);
  } catch {
    return null;
  }

  const folder = String(updates.folder ?? 'dbison').replace(/^\/+|\/+$/g, '');
  const publicUrl = String(updates.publicUrl ?? `${endpoint.protocol}//${updates.bucket}.${endpoint.host}`).replace(/\/+$/, '');

  return {
    bucket: updates.bucket,
    endpoint: endpoint.origin,
    region: updates.region ?? 'us-east-1',
    folder,
    // The publisher uploads to <folder>/<platform>/<arch>/<file>; Squirrel
    // reads RELEASES and Squirrel.Mac RELEASES.json from that same directory.
    baseUrl: (platform, arch) => `${publicUrl}/${folder}/${platform}/${arch}`,
  };
}
