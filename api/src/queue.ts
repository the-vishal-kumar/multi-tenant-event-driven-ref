import {
  SendMessageBatchCommand,
  SQSClient,
  type MessageAttributeValue,
} from '@aws-sdk/client-sqs';

/** A message to publish. `id` is unique within one batch call. */
export interface OutboundMessage {
  id: string;
  body: string;
  attributes: Record<string, string>;
}

/** The only thing the relay needs from a queue. SQS is one implementation. */
export interface Queue {
  /** Publishes the batch; returns the ids that failed and should be retried. */
  sendBatch(messages: OutboundMessage[]): Promise<{ failed: string[] }>;
}

export function sqsQueue(queueUrl: string, endpoint?: string): Queue {
  const client = new SQSClient(endpoint ? { endpoint } : {});
  return {
    async sendBatch(messages) {
      const failed: string[] = [];
      // SendMessageBatch takes at most 10 entries.
      for (let i = 0; i < messages.length; i += 10) {
        const chunk = messages.slice(i, i + 10);
        try {
          const out = await client.send(
            new SendMessageBatchCommand({
              QueueUrl: queueUrl,
              Entries: chunk.map((m) => ({
                Id: m.id,
                MessageBody: m.body,
                MessageAttributes: toAttributes(m.attributes),
              })),
            }),
          );
          for (const f of out.Failed ?? []) if (f.Id) failed.push(f.Id);
        } catch {
          // Whole chunk failed (network, throttling): retried on the next pass.
          failed.push(...chunk.map((m) => m.id));
        }
      }
      return { failed };
    },
  };
}

function toAttributes(attrs: Record<string, string>): Record<string, MessageAttributeValue> {
  const out: Record<string, MessageAttributeValue> = {};
  for (const [k, v] of Object.entries(attrs)) out[k] = { DataType: 'String', StringValue: v };
  return out;
}
