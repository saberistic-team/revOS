import https from "node:https";
import { readFileSync } from "node:fs";
export const buildNamespace = () =>
  process.env.POD_NAMESPACE || "agent-engine-local";
export async function kubernetes(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  const token = readFileSync(
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
    "utf8",
  );
  const ca = readFileSync(
    "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  );
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname:
          process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc",
        port: 443,
        path,
        method,
        ca,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let text = "";
        res.on("data", (x) => (text += x));
        res.on("end", () => {
          if (res.statusCode === 404) return resolve(null);
          if ((res.statusCode ?? 500) >= 400)
            return reject(
              Error(
                `Kubernetes ${method} ${path}: ${res.statusCode} ${text.slice(0, 300)}`,
              ),
            );
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
      },
    );
    r.on("error", reject);
    r.setTimeout(30000, () => r.destroy(Error("Kubernetes request timeout")));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
