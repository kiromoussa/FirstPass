// The single writable root for the app's on-disk workspace (staged DWGs,
// plotted plan sheets, per-run deliverables, project mirrors).
//
// process.cwd() is the deployment bundle, which is READ-ONLY on serverless
// hosts: Vercel/Lambda expose the code under /var/task and only allow writes to
// /tmp. Rooting workspace dirs at process.cwd() there fails with
// `ENOENT: ... mkdir '/var/task/projects/...'` the moment we stage an upload.
//
// Resolution order:
//   1. FIRSTPASS_DATA_DIR — explicit override (e.g. a mounted persistent disk).
//   2. os.tmpdir() on serverless — the only writable location. Ephemeral per
//      invocation, which is fine: the durable record is Redis (kvSet) + the APS
//      URN on the project; these disk dirs are a best-effort local mirror / the
//      scratch space the Python Band agents read within a single invocation.
//   3. process.cwd() locally and on long-lived hosts (Render), where the working
//      dir is writable and persists across requests.
import path from "path";
import os from "os";

function resolveDataRoot(): string {
  const override = process.env.FIRSTPASS_DATA_DIR?.trim();
  if (override) return override;
  const isServerless = !!(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY
  );
  if (isServerless) return path.join(os.tmpdir(), "firstpass");
  return process.cwd();
}

export const DATA_ROOT = resolveDataRoot();
