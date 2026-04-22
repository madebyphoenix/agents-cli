/**
 * Factory/Droid cloud provider -- stub for Phase 2.
 *
 * Will dispatch tasks to a `droid daemon` running on a remote machine.
 * All methods throw until the droid daemon API is documented and stable.
 */

import type {
  CloudProvider,
  CloudTask,
  CloudTaskStatus,
  CloudEvent,
  DispatchOptions,
} from './types.js';

/**
 * Factory/Droid cloud provider — stub for Phase 2.
 *
 * Integration path: `droid daemon` running on a remote machine (mac-mini, cloud VM, k8s pod).
 * Dispatch via HTTP to the daemon, stream output, cancel via HTTP DELETE.
 *
 * Not yet implemented because:
 * 1. Droid v0.104 has no cloud dispatch command (droid exec is local only)
 * 2. droid daemon API isn't documented yet
 * 3. droid computer register/ssh is the remote execution primitive but needs exploration
 */
export class FactoryCloudProvider implements CloudProvider {
  id = 'factory' as const;
  name = 'Factory (Droid)';

  supports(_options: DispatchOptions): boolean {
    return false;
  }

  async dispatch(_options: DispatchOptions): Promise<CloudTask> {
    throw new Error('Factory cloud provider is not yet available. Coming in a future release.');
  }

  async status(_taskId: string): Promise<CloudTask> {
    throw new Error('Factory cloud provider is not yet available.');
  }

  async list(_filter?: { status?: CloudTaskStatus }): Promise<CloudTask[]> {
    return [];
  }

  async *stream(_taskId: string): AsyncIterable<CloudEvent> {
    throw new Error('Factory cloud provider is not yet available.');
  }

  async cancel(_taskId: string): Promise<void> {
    throw new Error('Factory cloud provider is not yet available.');
  }

  async message(_taskId: string, _content: string): Promise<void> {
    throw new Error('Factory cloud provider is not yet available.');
  }
}
