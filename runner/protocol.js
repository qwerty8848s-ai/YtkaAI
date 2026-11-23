import { modelRef } from './config.js';

export async function* events(body) {
  let buffer = '';
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    buffer += text;
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(buffer);
      if (!separator) break;
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (buffer.length > 5_000_000) throw new Error('OpenClaw SSE frame too large');
  }
}

export async function generate(gateway, token, job, model, signal, append) {
  const session = 'agent:main:telegram:' + job.chat_id + ':' + (job.thread_id ?? 0);
  const response = await fetch(gateway + '/v1/responses', {
    method: 'POST', signal, headers: {
      'content-type': 'application/json', authorization: 'Bearer ' + token,
      'x-openclaw-model': modelRef(model), 'x-openclaw-session-key': session,
    },
    body: JSON.stringify({ model: 'openclaw/main', input: job.prompt, stream: true }),
  });
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('OpenClaw HTTP ' + response.status);
  }
  for await (const event of events(response.body)) {
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') append(event.delta);
    if (event.type === 'response.completed') return;
    if (event.type === 'response.incomplete') {
      append('\n\nДостигнут лимит длины ответа.');
      return;
    }
    if (event.type === 'response.failed') throw new Error('OpenClaw сообщил об ошибке генерации.');
  }
  throw new Error('Поток OpenClaw завершился до получения результата.');
}
