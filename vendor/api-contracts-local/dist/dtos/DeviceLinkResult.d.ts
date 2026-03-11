import type { DeviceProfile } from './DeviceProfile.js';
import type { DeviceLinkState } from './DeviceLinkState.js';
export interface DeviceLinkResult {
    ok: boolean;
    linkState: DeviceLinkState;
    device: DeviceProfile;
}
