// Thin compatibility shim over the shared secrets library. Profile tokens are
// stored at `agents-cli.<provider>.token`; secrets bundles live at
// `agents-cli.secrets.<bundle>.<KEY>`. Both go through the same keychain
// primitives in ./secrets.ts.
export {
  hasKeychainToken,
  getKeychainToken,
  setKeychainToken,
  deleteKeychainToken,
} from './secrets.js';
import { profileKeychainItem } from './secrets.js';

export function keychainItemName(provider: string): string {
  return profileKeychainItem(provider);
}
