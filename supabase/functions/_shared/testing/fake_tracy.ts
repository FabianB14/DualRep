/** A scripted Tracy for `deno test`: answers per task, records every call, can be asleep. */
import type { CallFailure } from '../errors.ts';
import type { ExtractResponse } from '../pipeline.ts';
import type { CallResult, TaskResult } from '../tracy.ts';

type TaskHandler = (input: Record<string, unknown>, requestId: string) => CallResult<TaskResult<unknown>> | Promise<CallResult<TaskResult<unknown>>>;
type ExtractHandler = (body: { url: string; kind: string; first_page: number; request_id: string }) =>
  | CallResult<ExtractResponse>
  | Promise<CallResult<ExtractResponse>>;

export const answer = <T>(output: T, model = 'claude-sonnet-5-5'): CallResult<TaskResult<T>> => ({
  ok: true,
  data: { output, model, usage: { input_tokens: 10, output_tokens: 5 } },
});

export const failure = (f: CallFailure): { ok: false; failure: CallFailure } => ({ ok: false, failure: f });

export class FakeTracy {
  awake = true;
  healthChecks = 0;
  calls: { kind: 'extract' | 'task'; name: string; body: Record<string, unknown> }[] = [];
  tasks: Record<string, TaskHandler> = {};
  onExtract: ExtractHandler = () => failure({ kind: 'http', status: 500, code: null });

  health(): Promise<boolean> {
    this.healthChecks += 1;
    return Promise.resolve(this.awake);
  }

  async extract(body: { url: string; kind: 'pdf' | 'doc' | 'link'; first_page: number; request_id: string }) {
    this.calls.push({ kind: 'extract', name: 'extract', body: structuredClone(body) });
    return await this.onExtract(body);
  }

  async task<T>(task: string, input: Record<string, unknown>, requestId: string): Promise<CallResult<TaskResult<T>>> {
    this.calls.push({ kind: 'task', name: task, body: structuredClone(input) });
    const handler = this.tasks[task];
    if (!handler) return failure({ kind: 'http', status: 400, code: 'unknown_task' });
    return (await handler(input, requestId)) as CallResult<TaskResult<T>>;
  }

  callsOf(name: string) {
    return this.calls.filter((c) => c.name === name);
  }
}
