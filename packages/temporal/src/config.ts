export const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "agent-engine";
export const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
export function connectionOptions() {
  return {
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
    tls: process.env.TEMPORAL_TLS === "true" ? true : undefined,
    apiKey: process.env.TEMPORAL_API_KEY,
  };
}

export async function connectWithRetry<T>(
  connect: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (error) {
      if (attempt >= 60) throw error;
      console.log(`Waiting for Temporal (${attempt}/60)`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}
