import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../src/store.js';

const store = new Store(workerData.file, () => new Date('2026-10-11T17:00:00Z'));
const gate = new Int32Array(workerData.gate);
parentPort!.postMessage({ ready: true });
Atomics.wait(gate, 0, 0);
try {
  store.claimPendingAction(workerData.expected, workerData.intent);
  parentPort!.postMessage({ claimed: true });
} catch (error) {
  parentPort!.postMessage({ claimed: false, error: error instanceof Error ? error.message : String(error) });
} finally {
  store.close();
}
