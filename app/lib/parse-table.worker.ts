import { parseTable } from './parse-table';

type In = { text: string };

const scope = globalThis as unknown as {
  onmessage: ((ev: MessageEvent<In>) => void) | null;
  postMessage: (data: unknown) => void;
};

scope.onmessage = (ev) => {
  scope.postMessage(parseTable(String(ev.data?.text ?? '')));
};
